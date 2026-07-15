const fs = require('fs');
const path = require('path');
const os = require('os');

class DataProtectionService {
  constructor() {
    this.userDataPaths = this.getUserDataPaths();
    this.protectedFiles = this.getProtectedFiles();
    this.protectedDirectories = this.getProtectedDirectories();
  }

  getUserDataPaths() {
    // Use app.getPath('userData') instead of os.homedir() to respect custom userData path
    const { app } = require('electron');
    const appDataPath = app.getPath('userData');
    const appDataPathOld = path.join(os.homedir(), 'ChatPro'); // Legacy path for migration

    return {
      current: appDataPath,
      legacy: appDataPathOld,
      database: path.join(appDataPath, 'leadwave.db'),
      authSessions: path.join(appDataPath, 'auth_sessions'),
      settings: path.join(appDataPath, 'settings.json'),
      logs: path.join(appDataPath, 'logs'),
      backups: path.join(appDataPath, 'backups'),
      temp: path.join(appDataPath, 'temp'),
      voiceTranscriptions: path.join(appDataPath, 'voice-transcriptions')
    };
  }

  getProtectedFiles() {
    // Files that should never be touched during updates
    return [
      'leadwave.db',
      'leadwave.db-wal',
      'leadwave.db-shm',
      'settings.json',
      'license.json',
      'app-settings.json',
      'window-state.json',
      'user-preferences.json'
    ];
  }

  getProtectedDirectories() {
    // Directories that should be preserved during updates
    return [
      'auth_sessions',
      'logs',
      'backups',
      'temp',
      'voice-transcriptions',
      'exports',
      'imports',
      'media',
      'attachments'
    ];
  }

  async verifyDataIntegrity() {
    try {
      const results = {
        userDataExists: false,
        databaseExists: false,
        authSessionsExist: false,
        settingsExist: false,
        protectedPaths: [],
        issues: []
      };

      // Check if main user data directory exists
      if (fs.existsSync(this.userDataPaths.current)) {
        results.userDataExists = true;
        results.protectedPaths.push(this.userDataPaths.current);
      }

      // Check legacy directory
      if (fs.existsSync(this.userDataPaths.legacy)) {
        results.protectedPaths.push(this.userDataPaths.legacy);
        results.issues.push('Legacy ChatPro directory found - consider migration');
      }

      // Check database
      if (fs.existsSync(this.userDataPaths.database)) {
        results.databaseExists = true;
        
        // Check database file size and accessibility
        const stats = fs.statSync(this.userDataPaths.database);
        if (stats.size === 0) {
          results.issues.push('Database file is empty');
        }
      }

      // Check auth sessions
      if (fs.existsSync(this.userDataPaths.authSessions)) {
        results.authSessionsExist = true;
        
        // Count session files
        const sessionFiles = fs.readdirSync(this.userDataPaths.authSessions);
        if (sessionFiles.length === 0) {
          results.issues.push('No authentication sessions found');
        }
      }

      // Check settings
      if (fs.existsSync(this.userDataPaths.settings)) {
        results.settingsExist = true;
        
        try {
          const settings = JSON.parse(fs.readFileSync(this.userDataPaths.settings, 'utf8'));
          if (Object.keys(settings).length === 0) {
            results.issues.push('Settings file is empty');
          }
        } catch (error) {
          results.issues.push('Settings file is corrupted');
        }
      }

      // Check all protected files and directories
      for (const fileName of this.protectedFiles) {
        const filePath = path.join(this.userDataPaths.current, fileName);
        if (fs.existsSync(filePath)) {
          results.protectedPaths.push(filePath);
        }
      }

      for (const dirName of this.protectedDirectories) {
        const dirPath = path.join(this.userDataPaths.current, dirName);
        if (fs.existsSync(dirPath)) {
          results.protectedPaths.push(dirPath);
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to verify data integrity: ${error.message}`);
    }
  }

  async createDataBackup(backupPath = null) {
    try {
      if (!backupPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(this.userDataPaths.current, 'backups', `pre-update-${timestamp}`);
      }

      // Ensure backup directory exists
      if (!fs.existsSync(path.dirname(backupPath))) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      }

      const backupInfo = {
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || 'unknown',
        backupPath,
        files: [],
        directories: []
      };

      // Backup protected files
      for (const fileName of this.protectedFiles) {
        const sourcePath = path.join(this.userDataPaths.current, fileName);
        if (fs.existsSync(sourcePath)) {
          const destPath = path.join(backupPath, fileName);
          
          // Ensure destination directory exists
          if (!fs.existsSync(path.dirname(destPath))) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
          }
          
          fs.copyFileSync(sourcePath, destPath);
          backupInfo.files.push(fileName);
        }
      }

      // Backup protected directories
      for (const dirName of this.protectedDirectories) {
        const sourcePath = path.join(this.userDataPaths.current, dirName);
        if (fs.existsSync(sourcePath)) {
          const destPath = path.join(backupPath, dirName);
          await this.copyDirectory(sourcePath, destPath);
          backupInfo.directories.push(dirName);
        }
      }

      // Save backup info
      const backupInfoPath = path.join(backupPath, 'backup-info.json');
      fs.writeFileSync(backupInfoPath, JSON.stringify(backupInfo, null, 2));

      return backupInfo;
    } catch (error) {
      throw new Error(`Failed to create data backup: ${error.message}`);
    }
  }

  async copyDirectory(source, destination) {
    try {
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
      }

      const items = fs.readdirSync(source);
      
      for (const item of items) {
        const sourcePath = path.join(source, item);
        const destPath = path.join(destination, item);
        
        const stats = fs.statSync(sourcePath);
        
        if (stats.isDirectory()) {
          await this.copyDirectory(sourcePath, destPath);
        } else {
          fs.copyFileSync(sourcePath, destPath);
        }
      }
    } catch (error) {
      throw new Error(`Failed to copy directory ${source}: ${error.message}`);
    }
  }

  async validateDataAfterUpdate() {
    try {
      const validation = {
        success: true,
        issues: [],
        restoredFiles: [],
        missingFiles: []
      };

      // Check if all critical files exist
      const criticalFiles = ['leadwave.db', 'license.json'];
      
      for (const fileName of criticalFiles) {
        const filePath = path.join(this.userDataPaths.current, fileName);
        if (!fs.existsSync(filePath)) {
          validation.success = false;
          validation.missingFiles.push(fileName);
          validation.issues.push(`Critical file missing: ${fileName}`);
        }
      }

      // Check database integrity
      if (fs.existsSync(this.userDataPaths.database)) {
        const stats = fs.statSync(this.userDataPaths.database);
        if (stats.size === 0) {
          validation.success = false;
          validation.issues.push('Database file is empty after update');
        }
      }

      // Check if auth sessions directory exists
      if (!fs.existsSync(this.userDataPaths.authSessions)) {
        fs.mkdirSync(this.userDataPaths.authSessions, { recursive: true });
        validation.restoredFiles.push('auth_sessions directory');
      }

      return validation;
    } catch (error) {
      throw new Error(`Failed to validate data after update: ${error.message}`);
    }
  }

  async restoreFromBackup(backupPath) {
    try {
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup path does not exist: ${backupPath}`);
      }

      const backupInfoPath = path.join(backupPath, 'backup-info.json');
      if (!fs.existsSync(backupInfoPath)) {
        throw new Error('Backup info file not found');
      }

      const backupInfo = JSON.parse(fs.readFileSync(backupInfoPath, 'utf8'));
      const restoration = {
        timestamp: new Date().toISOString(),
        backupTimestamp: backupInfo.timestamp,
        restoredFiles: [],
        restoredDirectories: [],
        errors: []
      };

      // Restore files
      for (const fileName of backupInfo.files) {
        try {
          const sourcePath = path.join(backupPath, fileName);
          const destPath = path.join(this.userDataPaths.current, fileName);
          
          if (fs.existsSync(sourcePath)) {
            // Ensure destination directory exists
            if (!fs.existsSync(path.dirname(destPath))) {
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
            }
            
            fs.copyFileSync(sourcePath, destPath);
            restoration.restoredFiles.push(fileName);
          }
        } catch (error) {
          restoration.errors.push(`Failed to restore file ${fileName}: ${error.message}`);
        }
      }

      // Restore directories
      for (const dirName of backupInfo.directories) {
        try {
          const sourcePath = path.join(backupPath, dirName);
          const destPath = path.join(this.userDataPaths.current, dirName);
          
          if (fs.existsSync(sourcePath)) {
            await this.copyDirectory(sourcePath, destPath);
            restoration.restoredDirectories.push(dirName);
          }
        } catch (error) {
          restoration.errors.push(`Failed to restore directory ${dirName}: ${error.message}`);
        }
      }

      return restoration;
    } catch (error) {
      throw new Error(`Failed to restore from backup: ${error.message}`);
    }
  }

  async cleanupOldBackups(maxAge = 30) {
    try {
      const backupsDir = path.join(this.userDataPaths.current, 'backups');
      if (!fs.existsSync(backupsDir)) {
        return { cleaned: 0, errors: [] };
      }

      const cleanup = {
        cleaned: 0,
        errors: [],
        totalSize: 0
      };

      const items = fs.readdirSync(backupsDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAge);

      for (const item of items) {
        try {
          const itemPath = path.join(backupsDir, item);
          const stats = fs.statSync(itemPath);
          
          if (stats.isDirectory() && stats.mtime < cutoffDate) {
            // Calculate directory size before deletion
            const size = await this.getDirectorySize(itemPath);
            cleanup.totalSize += size;
            
            // Remove old backup
            fs.rmSync(itemPath, { recursive: true, force: true });
            cleanup.cleaned++;
          }
        } catch (error) {
          cleanup.errors.push(`Failed to clean ${item}: ${error.message}`);
        }
      }

      return cleanup;
    } catch (error) {
      throw new Error(`Failed to cleanup old backups: ${error.message}`);
    }
  }

  async getDirectorySize(dirPath) {
    try {
      let totalSize = 0;
      const items = fs.readdirSync(dirPath);
      
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = fs.statSync(itemPath);
        
        if (stats.isDirectory()) {
          totalSize += await this.getDirectorySize(itemPath);
        } else {
          totalSize += stats.size;
        }
      }
      
      return totalSize;
    } catch (error) {
      return 0;
    }
  }

  getDataSummary() {
    return {
      userDataPaths: this.userDataPaths,
      protectedFiles: this.protectedFiles,
      protectedDirectories: this.protectedDirectories,
      description: 'User data protection ensures that databases, settings, auth sessions, and other user files are preserved during app updates.'
    };
  }
}

module.exports = DataProtectionService;
