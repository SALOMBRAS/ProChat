/**
 * Backup and Restore Service
 * Handles database backup, file compression, and encryption
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const schedule = require('node-schedule');
const { app } = require('electron');

class BackupService {
  constructor(databaseService) {
    this.db = databaseService;
    this.scheduledJobs = new Map();
  }











  /**
   * Create a comprehensive backup of the application
   */
  async createBackup(options = {}) {
    try {
      const {
        includeDatabase = true,
        includeSettings = true,
        includeTemplates = true,
        includeContacts = true,
        includeAttachments = true,
        description = 'Manual backup',
        saveLocation = null
      } = options;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupId = `app-backup-${timestamp}`;
      const tempDir = path.join(os.tmpdir(), 'app-backups', backupId);

      // Create temporary directory
      await fs.mkdir(tempDir, { recursive: true });

      const backupData = {
        metadata: {
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          description,
          includes: {
            database: includeDatabase,
            settings: includeSettings,
            templates: includeTemplates,
            contacts: includeContacts,
            attachments: includeAttachments
          }
        },
        data: {}
      };

      // Export database
      if (includeDatabase) {
        // Get the actual database path from the database service
        const dbPath = this.db.dbPath;
        const backupDbPath = path.join(tempDir, 'database.db');

        // Check if database file exists
        try {
          await fs.access(dbPath);
          await fs.copyFile(dbPath, backupDbPath);
          backupData.data.database = 'database.db';
        } catch (error) {
        }
      }

      // Export settings
      if (includeSettings) {
        const settings = await this.exportSettings();
        await fs.writeFile(
          path.join(tempDir, 'settings.json'),
          JSON.stringify(settings, null, 2)
        );
        backupData.data.settings = 'settings.json';
      }

      // Export templates
      if (includeTemplates) {
        const templates = await this.exportTemplates();
        await fs.writeFile(
          path.join(tempDir, 'templates.json'),
          JSON.stringify(templates, null, 2)
        );
        backupData.data.templates = 'templates.json';
      }

      // Export contacts
      if (includeContacts) {
        const contacts = await this.exportContacts();
        await fs.writeFile(
          path.join(tempDir, 'contacts.json'),
          JSON.stringify(contacts, null, 2)
        );
        backupData.data.contacts = 'contacts.json';
      }

      // Copy attachments directory
      if (includeAttachments) {
        const attachmentsDir = path.join(process.cwd(), 'attachments');
        const backupAttachmentsDir = path.join(tempDir, 'attachments');
        
        try {
          await this.copyDirectory(attachmentsDir, backupAttachmentsDir);
          backupData.data.attachments = 'attachments';
        } catch (error) {
        }
      }

      // Write metadata
      await fs.writeFile(
        path.join(tempDir, 'backup-metadata.json'),
        JSON.stringify(backupData, null, 2)
      );

      // Create compressed archive
      const archivePath = path.join(os.tmpdir(), 'app-backups', `${backupId}.zip`);

      // Ensure the archive directory exists
      await fs.mkdir(path.dirname(archivePath), { recursive: true });

      await this.createArchive(tempDir, archivePath);

      // Final backup path is the archive path (no encryption)
      let finalBackupPath = archivePath;

      // Clean up temporary directory
      await this.removeDirectory(tempDir);

      // Copy to user-specified location if provided
      let userBackupPath = finalBackupPath;
      if (saveLocation) {
        try {
          await fs.copyFile(finalBackupPath, saveLocation);
          userBackupPath = saveLocation;

          // Remove the temp file after successful copy
          await fs.unlink(finalBackupPath);
        } catch (copyError) {
          console.error('Error copying backup to user location:', copyError);
          // Continue with temp location if copy fails
        }
      }

      // Save backup record to database
      await this.saveBackupRecord({
        id: backupId,
        timestamp: new Date().toISOString(),
        description,
        filePath: userBackupPath,
        encrypted: false,
        size: (await fs.stat(userBackupPath)).size,
        includes: backupData.metadata.includes
      });

      return {
        success: true,
        backupId,
        filePath: finalBackupPath,
        finalPath: userBackupPath,
        size: (await fs.stat(userBackupPath)).size
      };

    } catch (error) {
      console.error('Error creating backup:', error);
      return { success: false, error: error.message };
    }
  }





  /**
   * Restore from backup file
   */
  async restoreFromBackup(backupFilePath, options = {}) {
    try {
      const {
        restoreDatabase = true,
        restoreSettings = true,
        restoreTemplates = true,
        restoreContacts = true,
        restoreAttachments = true,
        createBackupBeforeRestore = true
      } = options;

      // Create backup before restore if requested
      if (createBackupBeforeRestore) {
        await this.createBackup({
          description: 'Pre-restore backup'
        });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const restoreDir = path.join(process.cwd(), 'temp', `restore-${timestamp}`);
      await fs.mkdir(restoreDir, { recursive: true });

      // Extract archive directly (no encryption)
      await this.extractArchive(backupFilePath, restoreDir);

      // Read metadata
      const metadataPath = path.join(restoreDir, 'backup-metadata.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

      const results = {
        database: false,
        settings: false,
        templates: false,
        contacts: false,
        attachments: false
      };

      // Restore database
      if (restoreDatabase && metadata.data.database) {
        const dbPath = path.join(restoreDir, metadata.data.database);
        const targetDbPath = this.db.dbPath;

        // Ensure data directory exists
        await fs.mkdir(path.dirname(targetDbPath), { recursive: true });

        // Close the current database connection before overwriting
        if (this.db.db) {
          this.db.db.close();
        }

        await fs.copyFile(dbPath, targetDbPath);

        // Reinitialize the database after restore
        await this.db.initialize();

        results.database = true;
      }

      // Restore settings
      if (restoreSettings && metadata.data.settings) {
        const settingsPath = path.join(restoreDir, metadata.data.settings);
        const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
        await this.importSettings(settings);
        results.settings = true;
      }

      // Restore templates
      if (restoreTemplates && metadata.data.templates) {
        const templatesPath = path.join(restoreDir, metadata.data.templates);
        const templates = JSON.parse(await fs.readFile(templatesPath, 'utf8'));
        await this.importTemplates(templates, true); // Pass isRestore = true for backup restore
        results.templates = true;
      }

      // Restore contacts
      if (restoreContacts && metadata.data.contacts) {
        const contactsPath = path.join(restoreDir, metadata.data.contacts);
        const contacts = JSON.parse(await fs.readFile(contactsPath, 'utf8'));
        await this.importContacts(contacts);
        results.contacts = true;
      }

      // Restore attachments
      if (restoreAttachments && metadata.data.attachments) {
        const attachmentsDir = path.join(restoreDir, metadata.data.attachments);
        const targetAttachmentsDir = path.join(process.cwd(), 'attachments');
        await this.copyDirectory(attachmentsDir, targetAttachmentsDir);
        results.attachments = true;
      }

      // Clean up
      await this.removeDirectory(restoreDir);

      return {
        success: true,
        restored: results,
        metadata: metadata.metadata,
        requiresRestart: results.database // If database was restored, app should be restarted
      };

    } catch (error) {
      console.error('Error restoring from backup:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Schedule automatic backups
   */
  async scheduleBackup(schedule_pattern, options = {}) {
    try {
      const jobId = `auto-backup-${Date.now()}`;
      
      const job = schedule.scheduleJob(schedule_pattern, async () => {
        const result = await this.createBackup({
          ...options,
          description: 'Automatic scheduled backup'
        });
        

      });

      this.scheduledJobs.set(jobId, job);
      
      return { success: true, jobId };
    } catch (error) {
      console.error('Error scheduling backup:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel scheduled backup
   */
  cancelScheduledBackup(jobId) {
    const job = this.scheduledJobs.get(jobId);
    if (job) {
      job.cancel();
      this.scheduledJobs.delete(jobId);
      return { success: true };
    }
    return { success: false, error: 'Job not found' };
  }

  /**
   * Export application settings
   */
  async exportSettings() {
    try {
      const result = await this.db.query('SELECT * FROM app_settings');
      return result.success ? result.data : [];
    } catch (error) {
      console.error('Error exporting settings:', error);
      return [];
    }
  }

  /**
   * Export message templates
   */
  async exportTemplates() {
    try {
      const result = await this.db.query('SELECT * FROM message_templates');
      return result.success ? result.data : [];
    } catch (error) {
      console.error('Error exporting templates:', error);
      return [];
    }
  }

  /**
   * Export contacts
   */
  async exportContacts() {
    try {
      const result = await this.db.query('SELECT * FROM contacts');
      return result.success ? result.data : [];
    } catch (error) {
      console.error('Error exporting contacts:', error);
      return [];
    }
  }

  /**
   * Import settings
   */
  async importSettings(settings) {
    try {
      for (const setting of settings) {
        await this.db.query(
          'INSERT OR REPLACE INTO app_settings (key, value, type, description) VALUES (?, ?, ?, ?)',
          [setting.key, setting.value, setting.type, setting.description]
        );
      }
      return { success: true };
    } catch (error) {
      console.error('Error importing settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Import templates (for backup restore - skips existing templates)
   */
  async importTemplates(templates, isRestore = true) {
    try {
      let skippedCount = 0;
      let importedCount = 0;

      for (const template of templates) {
        const { id, ...templateData } = template;

        // Check if template with this name already exists
        const existingTemplate = await this.db.query(
          'SELECT id FROM message_templates WHERE name = ?',
          [templateData.name]
        );

        if (existingTemplate.success && existingTemplate.data && existingTemplate.data.length > 0) {
          if (isRestore) {
            // For restore operations, skip existing templates
            skippedCount++;
            continue;
          } else {
            // For import operations, generate unique name
            const timestamp = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
            const oldName = templateData.name;
            templateData.name = `${templateData.name} (Imported ${timestamp})`;
          }
        }

        const columns = Object.keys(templateData).join(', ');
        const placeholders = Object.keys(templateData).map(() => '?').join(', ');
        const values = Object.values(templateData);

        await this.db.query(
          `INSERT INTO message_templates (${columns}) VALUES (${placeholders})`,
          values
        );

        importedCount++;
      }

      return { success: true, imported: importedCount, skipped: skippedCount };
    } catch (error) {
      console.error('Error importing templates:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Import contacts
   */
  async importContacts(contacts) {
    try {
      for (const contact of contacts) {
        const { id, ...contactData } = contact;

        // Check if contact with this phone number already exists
        const existingContact = await this.db.query(
          'SELECT id FROM contacts WHERE phone_number = ?',
          [contactData.phone_number]
        );

        if (existingContact.success && existingContact.data && existingContact.data.length > 0) {
          // Contact exists, update it instead of creating duplicate
          const existingId = existingContact.data[0].id;
          const updateColumns = Object.keys(contactData).map(col => `${col} = ?`).join(', ');
          const values = Object.values(contactData);
          values.push(existingId);

          await this.db.query(
            `UPDATE contacts SET ${updateColumns} WHERE id = ?`,
            values
          );
        } else {
          // Contact doesn't exist, create new one
          const columns = Object.keys(contactData).join(', ');
          const placeholders = Object.keys(contactData).map(() => '?').join(', ');
          const values = Object.values(contactData);

          await this.db.query(
            `INSERT INTO contacts (${columns}) VALUES (${placeholders})`,
            values
          );
        }
      }
      return { success: true };
    } catch (error) {
      console.error('Error importing contacts:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create ZIP archive
   */
  async createArchive(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const output = require('fs').createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }

  /**
   * Extract ZIP archive
   */
  async extractArchive(archivePath, extractDir) {
    const yauzl = require('yauzl');

    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        let pendingFiles = 0;
        let hasError = false;

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (hasError) return;

          if (/\/$/.test(entry.fileName)) {
            // Directory entry
            const dirPath = path.join(extractDir, entry.fileName);
            try {
              require('fs').mkdirSync(dirPath, { recursive: true });
            } catch (error) {
              hasError = true;
              return reject(error);
            }
            zipfile.readEntry();
          } else {
            // File entry
            pendingFiles++;
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err || hasError) {
                hasError = true;
                return reject(err);
              }

              const filePath = path.join(extractDir, entry.fileName);
              const dirPath = path.dirname(filePath);

              try {
                require('fs').mkdirSync(dirPath, { recursive: true });
                const writeStream = require('fs').createWriteStream(filePath);

                readStream.pipe(writeStream);
                writeStream.on('close', () => {
                  pendingFiles--;
                  if (pendingFiles === 0 && zipfile.entryCount === zipfile.entriesRead) {
                    resolve();
                  } else {
                    zipfile.readEntry();
                  }
                });
                writeStream.on('error', (error) => {
                  hasError = true;
                  reject(error);
                });
              } catch (error) {
                hasError = true;
                reject(error);
              }
            });
          }
        });

        zipfile.on('end', () => {
          if (pendingFiles === 0 && !hasError) {
            resolve();
          }
        });
        zipfile.on('error', (error) => {
          hasError = true;
          reject(error);
        });
      });
    });
  }



  /**
   * Copy directory recursively
   */
  async copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Remove directory recursively
   */
  async removeDirectory(dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
    }
  }

  /**
   * Save backup record to database
   */
  async saveBackupRecord(record) {
    try {
      await this.db.query(
        `INSERT INTO backup_history (
          backup_id, timestamp, description, file_path, encrypted, size, includes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.timestamp,
          record.description,
          record.filePath,
          record.encrypted ? 1 : 0,
          record.size,
          JSON.stringify(record.includes)
        ]
      );
    } catch (error) {
      console.error('Error saving backup record:', error);
    }
  }

  /**
   * Get backup history
   */
  async getBackupHistory() {
    try {
      const result = await this.db.query(
        'SELECT * FROM backup_history ORDER BY timestamp DESC LIMIT 50'
      );
      return result.success ? result.data : [];
    } catch (error) {
      console.error('Error getting backup history:', error);
      return [];
    }
  }



  /**
   * Validate backup file
   */
  async validateBackupFile(filePath) {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return { valid: false, error: 'Not a valid file' };
      }

      // Check file extension
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.zip') {
        return { valid: false, error: 'Invalid file format. Expected .zip file' };
      }

      // For ZIP files, try to read the metadata
      const tempDir = path.join(process.cwd(), 'temp', `validate-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });

      try {
        await this.extractArchive(filePath, tempDir);

        const metadataPath = path.join(tempDir, 'backup-metadata.json');
        if (!(await fs.stat(metadataPath).catch(() => false))) {
          return { valid: false, error: 'Missing backup metadata' };
        }

        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

        // Validate metadata structure
        if (!metadata.metadata || !metadata.data) {
          return { valid: false, error: 'Invalid backup metadata structure' };
        }

        return {
          valid: true,
          encrypted: false,
          metadata: metadata.metadata
        };
      } finally {
        await this.removeDirectory(tempDir);
      }
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get backup file info
   */
  async getBackupInfo(filePath) {
    try {
      const validation = await this.validateBackupFile(filePath);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const stats = await fs.stat(filePath);

      return {
        success: true,
        info: {
          fileName: path.basename(filePath),
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          encrypted: validation.encrypted,
          metadata: validation.metadata
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Clean old backups based on retention policy
   */
  async cleanOldBackups(retentionDays = 30) {
    try {
      const backupHistory = await this.getBackupHistory();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      let cleanedCount = 0;

      for (const backup of backupHistory) {
        const backupDate = new Date(backup.timestamp);
        if (backupDate < cutoffDate) {
          try {
            // Remove local file if exists
            if (backup.file_path && await fs.stat(backup.file_path).catch(() => false)) {
              await fs.unlink(backup.file_path);
            }

            // Remove from database
            await this.db.query(
              'DELETE FROM backup_history WHERE id = ?',
              [backup.id]
            );

            cleanedCount++;
          } catch (error) {
          }
        }
      }

      return { success: true, cleanedCount };
    } catch (error) {
      console.error('Error cleaning old backups:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Download backup file to user's local computer
   */
  async downloadBackupToLocal(backupFilePath) {
    try {
      const { dialog } = require('electron');
      const path = require('path');
      const fs = require('fs').promises;

      // Check if backup file exists
      try {
        await fs.access(backupFilePath);
      } catch (error) {
        throw new Error('Backup file not found');
      }

      // Get the filename from the backup path
      const fileName = path.basename(backupFilePath);

      // Show save dialog
      const result = await dialog.showSaveDialog({
        title: 'Save Backup File',
        defaultPath: fileName,
        filters: [
          { name: 'Backup Files', extensions: ['zip'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      // Copy the backup file to the selected location
      await fs.copyFile(backupFilePath, result.filePath);

      return {
        success: true,
        filePath: result.filePath,
        message: 'Backup downloaded successfully'
      };

    } catch (error) {
      console.error('Error downloading backup to local:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = BackupService;
