const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class BrandingProtectionService {
  constructor() {
    this.protectedAssets = this.getProtectedAssets();
    this.brandingConfig = this.getBrandingConfig();
    this.checksums = new Map();
  }

  getProtectedAssets() {
    // Define assets that should never be changed during updates
    return [
      'build-resources/assets/app-icon.ico',
      'build-resources/assets/app-icon.png',
      'build-resources/assets/logo.png',
      'build-resources/assets/logo.svg',
      'public/logo.png',
      'public/logo.svg',
      'src/assets/logo.png',
      'src/assets/logo.svg',
      'src/assets/images/logo.png',
      'src/assets/images/logo.svg'
    ];
  }

  getBrandingConfig() {
    // Define branding elements that should remain constant
    return {
      appName: 'ChatPro',
      productName: 'ChatPro',
      appId: 'com.chatpro.desktop',
      publisher: 'Salomão',
      copyright: '© 2025',
      description: 'ChatPro - WhatsApp Automation',
      
      // Protected configuration keys in package.json
      protectedPackageKeys: [
        'name',
        'productName',
        'description',
        'author',
        'build.appId',
        'build.productName',
        'build.copyright',
        'build.win.publisherName'
      ],
      
      // Protected files that contain branding
      protectedFiles: [
        'package.json',
        'build/package.json',
        'public/index.html',
        'src/index.html'
      ]
    };
  }

  async calculateChecksum(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      
      const fileBuffer = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch (error) {
      return null;
    }
  }

  async createBrandingSnapshot() {
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        assets: {},
        configurations: {},
        checksums: {}
      };

      // Snapshot protected assets
      for (const assetPath of this.protectedAssets) {
        const fullPath = path.resolve(assetPath);
        if (fs.existsSync(fullPath)) {
          const checksum = await this.calculateChecksum(fullPath);
          snapshot.assets[assetPath] = {
            exists: true,
            checksum,
            size: fs.statSync(fullPath).size,
            modified: fs.statSync(fullPath).mtime.toISOString()
          };
          this.checksums.set(assetPath, checksum);
        } else {
          snapshot.assets[assetPath] = {
            exists: false
          };
        }
      }

      // Snapshot package.json configurations
      for (const configFile of this.brandingConfig.protectedFiles) {
        if (fs.existsSync(configFile)) {
          try {
            const content = fs.readFileSync(configFile, 'utf8');
            const checksum = crypto.createHash('sha256').update(content).digest('hex');
            
            snapshot.configurations[configFile] = {
              checksum,
              size: content.length,
              modified: fs.statSync(configFile).mtime.toISOString()
            };

            // Extract specific branding values from package.json
            if (configFile.endsWith('package.json')) {
              try {
                const packageData = JSON.parse(content);
                snapshot.configurations[configFile].brandingValues = {
                  name: packageData.name,
                  productName: packageData.productName || packageData.name,
                  description: packageData.description,
                  author: packageData.author,
                  appId: packageData.build?.appId,
                  buildProductName: packageData.build?.productName,
                  copyright: packageData.build?.copyright,
                  publisherName: packageData.build?.win?.publisherName
                };
              } catch (parseError) {
                // JSON parsing failed, just store checksum
              }
            }
          } catch (error) {
            snapshot.configurations[configFile] = {
              error: error.message
            };
          }
        }
      }

      return snapshot;
    } catch (error) {
      throw new Error(`Failed to create branding snapshot: ${error.message}`);
    }
  }

  async validateBrandingIntegrity(snapshot = null) {
    try {
      if (!snapshot) {
        // Create a new snapshot for validation
        snapshot = await this.createBrandingSnapshot();
      }

      const validation = {
        success: true,
        issues: [],
        modifiedAssets: [],
        modifiedConfigurations: [],
        missingAssets: []
      };

      // Validate protected assets
      for (const assetPath of this.protectedAssets) {
        const currentChecksum = await this.calculateChecksum(assetPath);
        const snapshotData = snapshot.assets[assetPath];
        
        if (snapshotData && snapshotData.exists) {
          if (currentChecksum !== snapshotData.checksum) {
            validation.success = false;
            validation.modifiedAssets.push({
              path: assetPath,
              expected: snapshotData.checksum,
              actual: currentChecksum
            });
            validation.issues.push(`Asset modified: ${assetPath}`);
          }
        } else if (fs.existsSync(assetPath)) {
          // Asset exists now but didn't before
          validation.issues.push(`New asset detected: ${assetPath}`);
        }
        
        if (snapshotData && snapshotData.exists && !fs.existsSync(assetPath)) {
          validation.success = false;
          validation.missingAssets.push(assetPath);
          validation.issues.push(`Asset missing: ${assetPath}`);
        }
      }

      // Validate configuration files
      for (const configFile of this.brandingConfig.protectedFiles) {
        if (fs.existsSync(configFile)) {
          const content = fs.readFileSync(configFile, 'utf8');
          const currentChecksum = crypto.createHash('sha256').update(content).digest('hex');
          const snapshotData = snapshot.configurations[configFile];
          
          if (snapshotData && currentChecksum !== snapshotData.checksum) {
            validation.modifiedConfigurations.push({
              path: configFile,
              expected: snapshotData.checksum,
              actual: currentChecksum
            });
            
            // Check specific branding values for package.json
            if (configFile.endsWith('package.json') && snapshotData.brandingValues) {
              try {
                const currentPackageData = JSON.parse(content);
                const expectedValues = snapshotData.brandingValues;
                
                const brandingChecks = [
                  { key: 'name', current: currentPackageData.name, expected: expectedValues.name },
                  { key: 'productName', current: currentPackageData.productName, expected: expectedValues.productName },
                  { key: 'description', current: currentPackageData.description, expected: expectedValues.description },
                  { key: 'author', current: currentPackageData.author, expected: expectedValues.author },
                  { key: 'appId', current: currentPackageData.build?.appId, expected: expectedValues.appId },
                  { key: 'publisherName', current: currentPackageData.build?.win?.publisherName, expected: expectedValues.publisherName }
                ];
                
                for (const check of brandingChecks) {
                  if (check.current !== check.expected) {
                    validation.success = false;
                    validation.issues.push(`Branding changed in ${configFile}: ${check.key} changed from "${check.expected}" to "${check.current}"`);
                  }
                }
              } catch (parseError) {
                validation.issues.push(`Failed to parse ${configFile}: ${parseError.message}`);
              }
            }
          }
        }
      }

      return validation;
    } catch (error) {
      throw new Error(`Failed to validate branding integrity: ${error.message}`);
    }
  }

  async restoreBrandingFromSnapshot(snapshot) {
    try {
      const restoration = {
        timestamp: new Date().toISOString(),
        restoredAssets: [],
        restoredConfigurations: [],
        errors: []
      };

      // Note: This method would typically restore from a backup
      // For now, we'll just validate and report what needs to be restored
      const validation = await this.validateBrandingIntegrity(snapshot);
      
      if (!validation.success) {
        restoration.errors.push('Branding integrity validation failed');
        restoration.errors.push(...validation.issues);
      }

      // In a real implementation, you would:
      // 1. Restore asset files from backup
      // 2. Restore configuration files from backup
      // 3. Verify restoration was successful

      return restoration;
    } catch (error) {
      throw new Error(`Failed to restore branding: ${error.message}`);
    }
  }

  async lockBrandingElements() {
    try {
      // Create a branding lock file with current state
      const snapshot = await this.createBrandingSnapshot();
      const lockFile = path.resolve('branding.lock');
      
      fs.writeFileSync(lockFile, JSON.stringify(snapshot, null, 2));
      
      return {
        success: true,
        lockFile,
        timestamp: snapshot.timestamp,
        protectedAssets: this.protectedAssets.length,
        protectedConfigurations: this.brandingConfig.protectedFiles.length
      };
    } catch (error) {
      throw new Error(`Failed to lock branding elements: ${error.message}`);
    }
  }

  async unlockBrandingElements() {
    try {
      const lockFile = path.resolve('branding.lock');
      
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        return { success: true, message: 'Branding lock removed' };
      } else {
        return { success: true, message: 'No branding lock found' };
      }
    } catch (error) {
      throw new Error(`Failed to unlock branding elements: ${error.message}`);
    }
  }

  getBrandingSummary() {
    return {
      protectedAssets: this.protectedAssets,
      brandingConfig: this.brandingConfig,
      description: 'Branding protection ensures that app name, logo, icons, and other brand elements remain unchanged during updates.',
      protectionLevel: 'High',
      monitoredFiles: this.protectedAssets.length + this.brandingConfig.protectedFiles.length
    };
  }

  async performBrandingAudit() {
    try {
      const audit = {
        timestamp: new Date().toISOString(),
        summary: this.getBrandingSummary(),
        currentState: await this.createBrandingSnapshot(),
        recommendations: []
      };

      // Check if branding lock exists
      const lockFile = path.resolve('branding.lock');
      if (fs.existsSync(lockFile)) {
        try {
          const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          const validation = await this.validateBrandingIntegrity(lockData);
          audit.lockValidation = validation;
          
          if (!validation.success) {
            audit.recommendations.push('Branding integrity compromised - consider restoring from backup');
          }
        } catch (error) {
          audit.recommendations.push('Branding lock file is corrupted - recreate lock');
        }
      } else {
        audit.recommendations.push('Create branding lock file to monitor changes');
      }

      // Check for missing assets
      const missingAssets = this.protectedAssets.filter(asset => !fs.existsSync(asset));
      if (missingAssets.length > 0) {
        audit.missingAssets = missingAssets;
        audit.recommendations.push(`${missingAssets.length} protected assets are missing`);
      }

      return audit;
    } catch (error) {
      throw new Error(`Failed to perform branding audit: ${error.message}`);
    }
  }
}

module.exports = BrandingProtectionService;
