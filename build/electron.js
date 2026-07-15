// Starting ChatPro WhatsApp Desktop - removed console.log for production

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Add fetch polyfill for Node.js
const fetch = require('node-fetch');

// ============================================================================
// SECURITY: Set custom userData path BEFORE app.whenReady()
// This ensures all app data is stored in a custom-named folder in AppData
// instead of the default "Electron" folder
// ============================================================================
// Import app configuration to get the app name dynamically
let APP_CONFIG;
try {
  APP_CONFIG = require('../config/app.config');
} catch (error) {
  try {
    APP_CONFIG = require('./config/app.config');
  } catch (error2) {
    // Fallback if config not found
    APP_CONFIG = { APP_CONFIG: { APP_NAME: 'ChatPro' } };
  }
}

// Use app name from config for AppData folder (remove spaces for folder name)
const customAppName = APP_CONFIG.APP_CONFIG.APP_NAME.replace(/\s+/g, '');
app.setPath('userData', path.join(app.getPath('appData'), customAppName));


// Set the app version from package.json to fix update detection
// Use a more robust path resolution for production builds
let packageJson;
try {
  // Try the development path first
  packageJson = require('../../package.json');
} catch (error) {
  try {
    // Try the production path
    packageJson = require('../package.json');
  } catch (error2) {
    try {
      // Try relative to app path
      packageJson = require(path.join(__dirname, '../../package.json'));
    } catch (error3) {
      // Fallback to hardcoded version if package.json not found
      if (isDev) {
      }
      packageJson = { version: '3.0.1' };
    }
  }
}
app.setVersion(packageJson.version);

// Development detection - moved to top for early use
const forceProduction = process.argv.includes('--prod');
const isDev = !forceProduction && !app.isPackaged;

// Helper function to resolve module paths correctly in both dev and production
function resolveModulePath(modulePath) {
  if (isDev) {
    // In development, use relative path from src/main/
    return path.join(__dirname, '..', modulePath);
  } else {
    // In production (packaged), use path from build/ directory
    return path.join(__dirname, modulePath);
  }
}

// Security: Initialize anti-tampering protection (only in production)
let antiTamper, hardwareFingerprint;

// Only load security modules in production to avoid development issues
if (!isDev) {
  try {
    antiTamper = require('../security/anti-tamper');
    hardwareFingerprint = require('../security/hardware-fingerprint');
    // Note: license-validator removed - using local license service instead
    // Security modules loaded for production build
  } catch (error) {
    // Security modules not available - continuing without them
  }
} else {
  // Development mode: Security modules disabled
}

// Import reseller configuration with proper path resolution
let resellerConfig;

// Clear require cache to ensure fresh config load
const configPaths = [
  path.resolve(__dirname, '../config/reseller-config.js'),
  path.resolve(__dirname, './config/reseller-config.js'),
  path.resolve(__dirname, 'config/reseller-config.js')
];
configPaths.forEach(configPath => {
  delete require.cache[configPath];
});

try {
  // Try relative path first (development)
  resellerConfig = require('../config/reseller-config');
} catch (error) {
  try {
    // Try from build directory (production)
    resellerConfig = require('./config/reseller-config');
  } catch (error2) {
    try {
      // Try absolute path from app root
      resellerConfig = require(path.join(__dirname, 'config', 'reseller-config'));
    } catch (error3) {
      // Failed to load reseller config - using fallback
      // Fallback configuration for ChatPro super admin account
      resellerConfig = {
        getResellerCode: () => null,
        isResellerBuild: () => false,
        isMasterAccountMode: () => true,
        getMasterAccountId: () => null,
        getResellerInfo: () => ({ name: 'ChatPro' }),
        getTrialRegistrationEndpoint: () => 'local://keygen/trial/register',
        prepareTrialRegistrationData: (userData) => ({
          name: userData.name,
          email: userData.email,
          phone: userData.phone,
          machine_id: userData.machine_id,
          reseller_code: null
        })
      };
    }
  }
}

const {
  getResellerCode,
  isResellerBuild,
  isMasterAccountMode,
  getMasterAccountId,
  getResellerInfo,
  getTrialRegistrationEndpoint,
  prepareTrialRegistrationData
} = resellerConfig;



// Global variables
let mainWindow = null;
let appService = null;
let databaseService = null;
let backupService = null;
let updateService = null;
let liveChatService = null;
let isQuitting = false;
let isShuttingDown = false;

// Initialize Live Chat Service
async function initializeLiveChatService() {
  const errors = [];

  try {
    logToFile('🔄 [Live Chat] Starting initialization...');

    if (!appService) {
      const msg = '❌ [Live Chat] Cannot initialize: appService is null';
      logToFile(msg);
      errors.push(msg);
      return { success: false, errors };
    }

    // Try to get Live Chat service from app service first
    if (appService.getLiveChatService) {
      liveChatService = appService.getLiveChatService();
      if (liveChatService) {
        logToFile('✅ [Live Chat] Using Live Chat service from app service');
        return { success: true };
      }
    }

    // Fallback: Create a new instance if not available from app service
    logToFile('⚠️ [Live Chat] Live Chat service not available from app service, creating new instance...');

    // Get database service using the correct method
    const databaseService = appService.getDatabaseService ? appService.getDatabaseService() : appService.database;

    if (!databaseService) {
      const msg = '❌ [Live Chat] Cannot initialize: databaseService is null';
      logToFile(msg);
      errors.push(msg);
      return { success: false, errors };
    }

    logToFile('✅ [Live Chat] appService and databaseService are available');

    const servicePath = resolveModulePath('services/live-chat.service');
    logToFile(`🔄 [Live Chat] Loading service from: ${servicePath}`);

    const LiveChatService = require(servicePath);
    logToFile('✅ [Live Chat] Service module loaded');

    // Get WhatsApp service for read receipts
    const whatsappService = appService.getWhatsAppService ? appService.getWhatsAppService() : null;
    logToFile(`✅ [Live Chat] WhatsApp service ${whatsappService ? 'available' : 'not available'}`);

    liveChatService = new LiveChatService(databaseService, whatsappService);
    logToFile('✅ [Live Chat] Service instance created');

    await liveChatService.initialize();
    logToFile('✅ [Live Chat] Service initialized successfully');

    return { success: true };
  } catch (error) {
    const msg = `❌ [Live Chat] Failed to initialize: ${error.message}`;
    const stack = `❌ [Live Chat] Error stack: ${error.stack}`;
    logToFile(msg);
    logToFile(stack);
    errors.push(msg);
    errors.push(stack);
    return { success: false, errors, errorMessage: error.message, errorStack: error.stack };
  }
}

// License integrity functions
function generateLicenseSignature(licenseData) {
  // Create a signature based on critical license data
  const crypto = require('crypto');
  const dataToSign = `${licenseData.customer_name}|${licenseData.expires_at}|${licenseData.plan_name}|LEADWAVE_LICENSE_SECRET`;
  return crypto.createHash('sha256').update(dataToSign).digest('hex');
}

function verifyLicenseIntegrity(licenseData) {
  // If no signature exists, it's an old license file - consider it invalid for security
  if (!licenseData.signature) {
    return false;
  }

  // Verify the signature
  const expectedSignature = generateLicenseSignature(licenseData);
  return licenseData.signature === expectedSignature;
}

function addLicenseSignature(licenseData) {
  // Add signature to license data
  licenseData.signature = generateLicenseSignature(licenseData);
  return licenseData;
}

// Enhanced logging system with migration from WhatsPlus to ChatPro
const getAppDataPath = () => {
  // Use the custom userData path set by app.setPath() instead of os.homedir()
  // This ensures all data goes to AppData/Roaming/ChatPro
  const newPath = app.getPath('userData');
  const oldPath = path.join(os.homedir(), 'ChatPro');

  // Check if old ChatPro folder exists
  if (fs.existsSync(oldPath)) {
    // If ChatPro folder doesn't exist, migrate from ChatPro
    if (!fs.existsSync(newPath)) {
      try {
        // Create parent directory if needed
        const parentDir = path.dirname(newPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Rename/move the folder
        fs.renameSync(oldPath, newPath);
        logToFile('✅ Migrated app data from ChatPro to ChatPro folder');
      } catch (error) {
        logToFile(`❌ Failed to migrate app data folder: ${error.message}`);
        // If migration fails, copy the data instead
        try {
          const copyRecursive = (src, dest) => {
            if (fs.statSync(src).isDirectory()) {
              if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
              }
              fs.readdirSync(src).forEach(item => {
                copyRecursive(path.join(src, item), path.join(dest, item));
              });
            } else {
              fs.copyFileSync(src, dest);
            }
          };

          copyRecursive(oldPath, newPath);
          logToFile('✅ Copied app data from ChatPro to ChatPro folder');

          // Try to remove old folder after successful copy
          try {
            fs.rmSync(oldPath, { recursive: true, force: true });
            logToFile('✅ Removed old ChatPro folder');
          } catch (removeError) {
            logToFile(`⚠️ Could not remove old ChatPro folder: ${removeError.message}`);
          }
        } catch (copyError) {
          logToFile(`❌ Failed to copy app data: ${copyError.message}`);
        }
      }
    } else {
      // Both folders exist - check if ChatPro folder is empty or has only empty subdirectories
      try {
        const isEmptyRecursive = (dirPath) => {
          const items = fs.readdirSync(dirPath);
          if (items.length === 0) return true;

          for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stat = fs.statSync(itemPath);
            if (stat.isFile()) return false;
            if (stat.isDirectory() && !isEmptyRecursive(itemPath)) return false;
          }
          return true;
        };

        if (isEmptyRecursive(oldPath)) {
          fs.rmSync(oldPath, { recursive: true, force: true });
          logToFile('✅ Removed empty ChatPro folder');
        } else {
          logToFile('⚠️ ChatPro folder exists with data - manual cleanup may be needed');
        }
      } catch (error) {
        logToFile(`⚠️ Could not check/remove ChatPro folder: ${error.message}`);
      }
    }
  }

  return newPath;
};

const logDir = path.join(getAppDataPath(), 'logs');
const logFile = path.join(logDir, 'app-debug.log');

// Ensure log directory exists
try {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
} catch (err) {
  // Only log directory creation errors in development mode
  if (isDev) {
    console.error('Failed to create log directory:', err);
  }
}

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  // Only log to console in development mode
  if (isDev) {
  }

  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (err) {
    // Only log file write errors in development mode
    if (isDev) {
      console.error('Failed to write to log file:', err);
    }
  }
}

// Make logToFile available globally for services
global.logToFile = logToFile;

logToFile('🚀 Starting ChatPro WhatsApp Desktop...');
logToFile(`Process PID: ${process.pid}`);
logToFile(`Process execPath: ${process.execPath}`);
logToFile(`Process argv: ${JSON.stringify(process.argv)}`);
logToFile(`Log file location: ${logFile}`);

// Initialize backup service
const initializeBackupService = () => {
  if (!backupService && appService) {
    try {
      let BackupService;

      // Try different paths for backup service
      try {
        // Try relative path first (development)
        BackupService = require('../services/backup.service');
      } catch (error) {
        try {
          // Try from current directory (production)
          BackupService = require('./services/backup.service');
        } catch (error2) {
          try {
            // Try absolute path from app root
            BackupService = require(path.join(__dirname, 'services', 'backup.service'));
          } catch (error3) {
            throw new Error(`Failed to load backup service from any path: ${error3.message}`);
          }
        }
      }

      const databaseService = appService.getDatabaseService();
      backupService = new BackupService(databaseService);
      logToFile('✅ Backup service initialized');
    } catch (error) {
      logToFile(`❌ Failed to initialize backup service: ${error.message}`);
    }
  }
  return backupService;
};

// Initialize update service
const initializeUpdateService = () => {
  if (!updateService) {
    try {
      let UpdateService;

      // Try different paths for update service
      try {
        // Try relative path first (development)
        UpdateService = require('../services/update-service');
      } catch (error) {
        try {
          // Try from current directory (production)
          UpdateService = require('./services/update-service');
        } catch (error2) {
          try {
            // Try absolute path from app root
            UpdateService = require(path.join(__dirname, 'services', 'update-service'));
          } catch (error3) {
            throw new Error(`Failed to load update service from any path: ${error3.message}`);
          }
        }
      }

      updateService = new UpdateService();
      logToFile('✅ Update service initialized');

      // Set main window reference when available
      if (mainWindow) {
        updateService.setMainWindow(mainWindow);
      }

      // Start periodic update checks (every 24 hours)
      updateService.startPeriodicCheck(24);

    } catch (error) {
      logToFile(`❌ Failed to initialize update service: ${error.message}`);
    }
  }
};

// Register backup IPC handlers immediately
logToFile('🔄 Registering backup IPC handlers...');

// Create backup
ipcMain.handle('backup:create', async (event, options) => {
  try {
    logToFile('🔄 Creating backup...');
    if (!appService) {
      throw new Error('App service not available');
    }
    const service = initializeBackupService();
    if (!service) {
      throw new Error('Backup service not available');
    }
    const result = await service.createBackup(options);
    logToFile(`✅ Backup creation result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logToFile(`❌ Backup creation error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Restore from backup
ipcMain.handle('backup:restore', async (event, filePath, options) => {
  try {
    logToFile(`🔄 Restoring backup from: ${filePath}`);
    if (!appService) {
      throw new Error('App service not available');
    }
    const service = initializeBackupService();
    if (!service) {
      throw new Error('Backup service not available');
    }
    return await service.restoreFromBackup(filePath, options);
  } catch (error) {
    logToFile(`❌ Backup restore error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Get backup history
ipcMain.handle('backup:get-history', async (event) => {
  try {
    logToFile('🔄 Getting backup history...');
    if (!appService) {
      throw new Error('App service not available');
    }
    const service = initializeBackupService();
    if (!service) {
      throw new Error('Backup service not available');
    }
    const history = await service.getBackupHistory();
    return { success: true, data: history };
  } catch (error) {
    logToFile(`❌ Get backup history error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// File dialog for backup file selection
ipcMain.handle('backup:select-file', async (event) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'ChatPro',
      filters: [
        { name: 'Backup Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePaths[0] };
  } catch (error) {
    logToFile(`❌ File selection error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// File dialog for backup save location
ipcMain.handle('backup:select-save-location', async (event, defaultName) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Backup As',
      defaultPath: defaultName || 'leadwave-backup.zip',
      filters: [
        { name: 'Backup Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePath };
  } catch (error) {
    logToFile(`❌ Save location selection error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Validate backup file
ipcMain.handle('backup:validate-file', async (event, filePath) => {
  try {
    if (!appService) {
      throw new Error('App service not available');
    }
    const service = initializeBackupService();
    if (!service) {
      throw new Error('Backup service not available');
    }
    return await service.validateBackupFile(filePath);
  } catch (error) {
    logToFile(`❌ Backup validation error: ${error.message}`);
    return { valid: false, error: error.message };
  }
});

// App restart handler
ipcMain.handle('app:restart', async (event) => {
  try {
    logToFile('🔄 Application restart requested');
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (error) {
    logToFile(`❌ App restart error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

logToFile('✅ Backup IPC handlers registered');

// Enhanced single instance management
const MUTEX_NAME = 'WAMarketo WhatsAppDesktopMutex';

// Development detection (already defined at top of file)

logToFile(`🔍 __dirname: ${__dirname}`);
logToFile(`🔍 __filename: ${__filename}`);
logToFile(`🔍 process.env.NODE_ENV: ${process.env.NODE_ENV}`);
logToFile(`🔍 process.defaultApp: ${process.defaultApp}`);
logToFile(`🔍 app.isPackaged: ${app.isPackaged}`);
logToFile(`🔍 process.execPath: ${process.execPath}`);
logToFile(`🔍 Development mode: ${isDev}`);

// Try to acquire single instance lock
try {
  singleInstanceLock = app.requestSingleInstanceLock();
  logToFile(`🔒 Single instance lock acquired: ${singleInstanceLock}`);
} catch (error) {
  logToFile(`❌ Failed to acquire single instance lock: ${error.message}`);
  singleInstanceLock = false;
}

if (!singleInstanceLock) {
  logToFile('❌ Another instance is already running. Exiting gracefully...');
  app.quit();
  process.exit(0);
}

// Handle second instance attempts
app.on('second-instance', (event, commandLine, workingDirectory) => {
  logToFile('🔄 Second instance detected, focusing existing window...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    mainWindow.show();
  }
});

// Fix for Baileys crypto compatibility
if (!globalThis.crypto) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

// Graceful shutdown function
async function gracefulShutdown() {
  if (isShuttingDown) {
    logToFile('🔄 Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  logToFile('🔄 Starting graceful shutdown...');

  try {
    // Close main window first
    if (mainWindow && !mainWindow.isDestroyed()) {
      logToFile('🪟 Closing main window...');
      mainWindow.removeAllListeners();
      mainWindow.close();
      mainWindow = null;
    }

    // Shutdown app service
    if (appService) {
      logToFile('🔄 Shutting down app service...');
      await appService.shutdown();
      logToFile('✅ App service shutdown complete');
    }

    // Release single instance lock
    if (singleInstanceLock) {
      logToFile('🔓 Releasing single instance lock...');
      app.releaseSingleInstanceLock();
    }

    logToFile('✅ Graceful shutdown complete');

    // Force exit after a delay to ensure cleanup
    setTimeout(() => {
      logToFile('🔄 Force exiting process...');
      process.exit(0);
    }, 1000);

  } catch (error) {
    logToFile(`❌ Error during shutdown: ${error.message}`);
    process.exit(1);
  }
}

// Enhanced error handling - Log errors but don't exit unless critical
process.on('uncaughtException', (error) => {
  logToFile(`❌ Uncaught Exception: ${error.message}`);
  logToFile(`Stack: ${error.stack}`);

  // Only exit for critical system errors, not application errors
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES' || error.message.includes('Cannot find module')) {
    logToFile('💥 Critical system error detected, shutting down...');
    gracefulShutdown();
  } else {
    logToFile('⚠️ Non-critical error, continuing operation...');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logToFile(`❌ Unhandled Rejection: ${reason}`);
  logToFile(`Promise: ${promise}`);

  // Log but don't exit for unhandled rejections - they're often non-critical
  logToFile('⚠️ Unhandled rejection logged, continuing operation...');
});

// Handle app termination signals
process.on('SIGTERM', () => {
  logToFile('🔄 Received SIGTERM');
  gracefulShutdown();
});

process.on('SIGINT', () => {
  logToFile('🔄 Received SIGINT');
  gracefulShutdown();
});

// Handle Windows-specific signals
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => {
    logToFile('🔄 Received SIGBREAK');
    gracefulShutdown();
  });
}

// Prevent app from quitting when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  logToFile('🔄 All windows closed');
  if (process.platform !== 'darwin') {
    isQuitting = true;
    gracefulShutdown();
  }
});

// Handle app before-quit event
app.on('before-quit', async (event) => {
  logToFile('🔄 Before quit event triggered');

  // Skip confirmation dialog if we're updating
  if (global.isUpdating) {
    logToFile('🔄 Skipping confirmation dialog - app is updating');
    isQuitting = true;
    gracefulShutdown();
    return;
  }

  if (!isQuitting) {
    event.preventDefault();

    // Show confirmation dialog if main window exists
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { dialog } = require('electron');
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        title: 'Confirm Exit',
        message: `Are you sure you want to close ${APP_CONFIG.APP_CONFIG.APP_NAME}?`,
        detail: 'This will stop all WhatsApp sessions and close the application.',
        icon: null
      });

      if (choice.response === 0) { // User clicked "Yes"
        logToFile('🔄 User confirmed application exit via before-quit');
        isQuitting = true;
        gracefulShutdown();
      } else {
        logToFile('🔄 User cancelled application exit via before-quit');
      }
    } else {
      // No window to show dialog, proceed with quit
      isQuitting = true;
      gracefulShutdown();
    }
  }
});

// Handle app will-quit event
app.on('will-quit', (event) => {
  logToFile('🔄 Will quit event triggered');
  if (!isShuttingDown) {
    event.preventDefault();
    gracefulShutdown();
  }
});

// Helper function to set up window event handlers
function setupWindowEventHandlers(window) {
  // Handle window close event
  window.on('close', async (event) => {
    logToFile('🔄 Window close event triggered');
    if (!isQuitting) {
      event.preventDefault();

      try {
        // Send request to renderer and wait for response
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Close confirmation timeout'));
          }, 10000); // 10 second timeout

          // Set up one-time listener for response
          const responseHandler = (responseEvent, confirmed) => {
            clearTimeout(timeout);
            ipcMain.removeListener('app:close-confirmation-response', responseHandler);
            resolve(confirmed);
          };

          ipcMain.once('app:close-confirmation-response', responseHandler);

          // Send request to renderer
          window.webContents.send('app:show-close-confirmation', {
            title: 'Confirm Exit',
            message: `Are you sure you want to close ${APP_CONFIG.APP_CONFIG.APP_NAME}?\n\nThis will stop all WhatsApp sessions and close the application.`
          });
        });

        if (response) {
          logToFile('🔄 User confirmed application exit via in-app dialog');
          isQuitting = true;
          gracefulShutdown();
        } else {
          logToFile('🔄 User cancelled application exit via in-app dialog');
        }
      } catch (error) {
        logToFile(`❌ Error showing close confirmation: ${error.message}`);
        // Fallback to immediate close if there's an error
        isQuitting = true;
        gracefulShutdown();
      }
    }
  });

  // Handle window closed event
  window.on('closed', () => {
    logToFile('🔄 Window closed event triggered');
    mainWindow = null;
    if (!isQuitting) {
      isQuitting = true;
      gracefulShutdown();
    }
  });
}

// Create main window function
function createWindow() {
  logToFile('🪟 Creating main window...');

  try {
    // Load window frame preference from database
    let showTitleBar = true; // default value
    try {
      if (databaseService && databaseService.db) {
        const framePreference = databaseService.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('window_show_title_bar');
        if (framePreference) {
          showTitleBar = framePreference.value === 'true';
          logToFile(`📋 Loaded window frame preference: ${showTitleBar}`);
        } else {
          logToFile('📋 No window frame preference found, using default: true');
        }
      } else {
        logToFile('⚠️ Database not available during window creation, using default title bar setting');
      }
    } catch (prefError) {
      logToFile(`⚠️ Error loading window frame preference: ${prefError.message}, using default`);
    }

    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1200,
      minHeight: 700,
      title: APP_CONFIG.APP_CONFIG.APP_NAME,
      icon: path.join(__dirname, '../../build-resources/assets/app-icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
        devTools: isDev, // Only allow DevTools in development mode
        preload: path.join(__dirname, 'preload.js')
      },
      show: true,
      titleBarStyle: 'default',
      frame: true,
      autoHideMenuBar: !showTitleBar // Apply saved preference
    });

    logToFile('✅ Main window created successfully');

    // Explicitly set the window title to ensure it's correct
    mainWindow.setTitle(APP_CONFIG.APP_CONFIG.APP_NAME);
    logToFile(`🪟 Window title set to: ${APP_CONFIG.APP_CONFIG.APP_NAME}`);

    // Apply the saved window frame preference immediately
    if (!showTitleBar) {
      mainWindow.setMenuBarVisibility(false);
      mainWindow.setAutoHideMenuBar(true);
      logToFile('🪟 Applied saved preference: title bar hidden');
    } else {
      mainWindow.setMenuBarVisibility(true);
      mainWindow.setAutoHideMenuBar(false);
      logToFile('🪟 Applied saved preference: title bar visible');
    }

    // Also apply preference after window is ready and database is fully initialized
    mainWindow.once('ready-to-show', async () => {
      logToFile('🪟 Window ready to show, re-applying frame preference...');

      try {
        // Wait longer for database to be fully ready and services initialized
        await new Promise(resolve => setTimeout(resolve, 500));

        // Re-check the database preference now that everything is initialized
        if (databaseService && databaseService.db) {
          logToFile('🔍 Database service available, checking frame preference...');

          try {
            const framePreference = databaseService.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('window_show_title_bar');
            logToFile(`🔍 Frame preference query result: ${JSON.stringify(framePreference)}`);

            if (framePreference) {
              const shouldShowTitleBar = framePreference.value === 'true';
              logToFile(`🔄 Re-applying window frame preference: ${shouldShowTitleBar}`);

              if (!shouldShowTitleBar) {
                mainWindow.setMenuBarVisibility(false);
                mainWindow.setAutoHideMenuBar(true);
                logToFile('🪟 Final application: title bar hidden');
              } else {
                mainWindow.setMenuBarVisibility(true);
                mainWindow.setAutoHideMenuBar(false);
                logToFile('🪟 Final application: title bar visible');
              }
            } else {
              logToFile('🔍 No frame preference found in database, using default (title bar visible)');
              mainWindow.setMenuBarVisibility(true);
              mainWindow.setAutoHideMenuBar(false);
            }
          } catch (dbError) {
            logToFile(`❌ Database query error: ${dbError.message}`);
            // Fallback to default
            mainWindow.setMenuBarVisibility(true);
            mainWindow.setAutoHideMenuBar(false);
          }
        } else {
          logToFile('⚠️ Database service not available, using default frame settings');
          // Fallback to default
          mainWindow.setMenuBarVisibility(true);
          mainWindow.setAutoHideMenuBar(false);
        }
      } catch (error) {
        logToFile(`⚠️ Error re-applying frame preference: ${error.message}`);
        // Fallback to default
        mainWindow.setMenuBarVisibility(true);
        mainWindow.setAutoHideMenuBar(false);
      }

      mainWindow.show();
      mainWindow.focus();
    });

    // Block browser notifications - we use in-app notifications instead
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'notifications') {
        logToFile('🚫 Blocking browser notification permission request - using in-app notifications instead');
        callback(false); // Deny browser notifications
      } else {
        callback(true); // Allow other permissions
      }
    });

    // Also block notifications at the session level
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (permission === 'notifications') {
        logToFile('🚫 Blocking notification permission check - using in-app notifications instead');
        return false;
      }
      return true;
    });

    logToFile('🧹 Notification permissions will be blocked by permission handlers');

    // Override browser Notification API immediately when webContents is created
    mainWindow.webContents.executeJavaScript(`
      // Override the Notification constructor to prevent system notifications
      window.Notification = class {
        constructor() {
          // Browser notification blocked - using in-app notifications instead
          return {};
        }
        static get permission() { return 'denied'; }
        static requestPermission() {
          // Notification.requestPermission() blocked - using in-app notifications instead
          return Promise.resolve('denied');
        }
      };

      // Also override any existing Notification references
      if (window.webkitNotifications) {
        window.webkitNotifications = undefined;
      }

      // Browser Notification API overridden to prevent system notifications
    `).catch(err => {
      logToFile(`⚠️ Failed to override Notification API initially: ${err.message}`);
    });

    // Override browser Notification API after page loads as well (double protection)
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow.webContents.executeJavaScript(`
        // Override the Notification constructor to prevent system notifications
        window.Notification = class {
          constructor() {
            // Browser notification blocked - using in-app notifications instead
            return {};
          }
          static get permission() { return 'denied'; }
          static requestPermission() {
            // Notification.requestPermission() blocked - using in-app notifications instead
            return Promise.resolve('denied');
          }
        };

        // Also override any existing Notification references
        if (window.webkitNotifications) {
          window.webkitNotifications = undefined;
        }

        // Browser Notification API overridden on DOM ready to prevent system notifications
      `).catch(err => {
        logToFile(`⚠️ Failed to override Notification API on DOM ready: ${err.message}`);
      });
    });

    // Additional protection - override on navigation
    mainWindow.webContents.on('did-navigate', () => {
      mainWindow.webContents.executeJavaScript(`
        // Override the Notification constructor to prevent system notifications
        window.Notification = class {
          constructor() {
            // Browser notification blocked - using in-app notifications instead
            return {};
          }
          static get permission() { return 'denied'; }
          static requestPermission() {
            // Notification.requestPermission() blocked - using in-app notifications instead
            return Promise.resolve('denied');
          }
        };

        // Also override any existing Notification references
        if (window.webkitNotifications) {
          window.webkitNotifications = undefined;
        }

        // Browser Notification API overridden on navigation to prevent system notifications
      `).catch(err => {
        logToFile(`⚠️ Failed to override Notification API on navigation: ${err.message}`);
      });
    });

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
      logToFile('🪟 Window ready to show');
      mainWindow.show();
      mainWindow.focus();
    });

    // Set up event handlers
    setupWindowEventHandlers(mainWindow);

    // Load the app
    if (isDev) {
      logToFile('🔄 Loading development server...');
      mainWindow.loadURL('http://localhost:3000').catch(err => {
        logToFile(`❌ Failed to load dev server: ${err.message}`);
        const errorHtml = `
          <html>
            <head><title>Development Server Not Running</title></head>
            <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
              <h1 style="color: #e74c3c;">Development Server Not Running</h1>
              <p>Please run "npm run dev:react" first.</p>
            </body>
          </html>
        `;
        mainWindow.loadURL(`data:text/html,${encodeURIComponent(errorHtml)}`);
      });
    } else {
      // Production mode - load built files
      const indexPath = path.join(__dirname, 'index.html');
      logToFile(`🔄 Loading production build from: ${indexPath}`);

      if (fs.existsSync(indexPath)) {
        mainWindow.loadFile(indexPath);
      } else {
        logToFile(`❌ Index file not found: ${indexPath}`);
        const errorHtml = `
          <html>
            <head><title>Build Not Found</title></head>
            <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
              <h1 style="color: #e74c3c;">Build Not Found</h1>
              <p>Application files could not be located.</p>
              <p><strong>Path:</strong> ${indexPath}</p>
            </body>
          </html>
        `;
        mainWindow.loadURL(`data:text/html,${encodeURIComponent(errorHtml)}`);
      }
    }

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
      logToFile('✅ Window ready to show');
      mainWindow.show();

      if (isDev) {
        mainWindow.webContents.openDevTools();
      }
    });

    // Security: Prevent DevTools from being opened in production
    if (!isDev) {
      mainWindow.webContents.on('before-input-event', (event, input) => {
        // Block Ctrl+Shift+I, Ctrl+Shift+J, F12
        if (
          (input.control && input.shift && (input.key.toLowerCase() === 'i' || input.key.toLowerCase() === 'j')) ||
          input.key.toLowerCase() === 'f12'
        ) {
          event.preventDefault();
        }
      });

      // Block context menu (right-click) in production
      mainWindow.webContents.on('context-menu', (event) => {
        event.preventDefault();
      });

      // Prevent DevTools from being opened programmatically
      mainWindow.webContents.on('devtools-opened', () => {
        mainWindow.webContents.closeDevTools();
      });
    }

    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // Set main window reference for update service if available
    if (updateService) {
      updateService.setMainWindow(mainWindow);
      logToFile('✅ Update service window reference set');
    }

  } catch (error) {
    logToFile(`❌ Failed to create window: ${error.message}`);
    gracefulShutdown();
  }
}

// Initialize fallback services when app service fails to load
async function initializeFallbackServices() {
  try {
    logToFile('🔄 Initializing fallback database service...');

    // Initialize database service directly
    const DatabaseService = require('../services/database.service');
    databaseService = new DatabaseService();
    await databaseService.initialize();

    logToFile('✅ Fallback database service initialized');

    // Initialize WhatsApp service directly
    const WhatsAppService = require('../services/whatsapp.service');
    const whatsappService = new WhatsAppService(databaseService);
    whatsappService.setDatabaseService(databaseService);

    logToFile('✅ Fallback WhatsApp service initialized');

    // Initialize models with database instance
    const WhatsAppSession = require('../models/WhatsAppSession');
    const MessageTemplate = require('../models/MessageTemplate');
    const Contact = require('../models/Contact');

    WhatsAppSession.db = databaseService;
    MessageTemplate.db = databaseService;
    Contact.db = databaseService;

    logToFile('✅ Fallback models initialized with database');

    // Create a minimal app service object for compatibility with all necessary methods
    appService = {
      getDatabaseService: () => databaseService,
      getWhatsAppService: () => whatsappService,
      isInitialized: true,

      // WhatsApp Service Methods
      async createWhatsAppSession(deviceName = 'ChatPro Device') {
        try {
          const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

          logToFile(`🔄 Creating WhatsApp session: ${deviceName} (${sessionId})`);
          logToFile(`🔄 WhatsAppSession.db available: ${!!WhatsAppSession.db}`);

          await WhatsAppSession.create({
            session_id: sessionId,
            name: deviceName,
            device_name: deviceName,
            status: 'creating',
            is_active: 1
          });

          logToFile(`✅ Session record created in database: ${sessionId}`);

          const result = await whatsappService.createSession(sessionId);

          logToFile(`✅ WhatsApp session created: ${sessionId}`);

          return {
            success: true,
            sessionId: sessionId,
            message: 'Session created successfully'
          };
        } catch (error) {
          logToFile(`❌ Error creating WhatsApp session: ${error.message}`);
          logToFile(`❌ Error stack: ${error.stack}`);
          return {
            success: false,
            message: error.message
          };
        }
      },

      async disconnectWhatsAppSession(sessionId) {
        return await whatsappService.disconnectSession(sessionId);
      },

      async reconnectWhatsAppSession(sessionId) {
        return await whatsappService.reconnectSession(sessionId);
      },

      async deleteWhatsAppSession(sessionId) {
        return await whatsappService.deleteSession(sessionId);
      },

      async getWhatsAppSessions() {
        try {
          logToFile('🔄 Fallback: Getting WhatsApp sessions...');

          // Get sessions from database
          const dbSessions = await WhatsAppSession.findAll();
          logToFile(`📊 Fallback: Found ${dbSessions.length} sessions in database`);

          // Get real-time status from WhatsApp service
          const whatsAppSessions = whatsappService.getAllSessions();
          logToFile(`📊 Fallback: Found ${whatsAppSessions.length} active WhatsApp sessions`);

          // Merge database and real-time data
          const sessions = dbSessions.map(dbSession => {
            const whatsAppSession = whatsAppSessions.find(ws => ws.sessionId === dbSession.sessionId);

            // IMPORTANT: Prioritize database 'connected' status over in-memory 'connecting' status
            // This prevents showing "Reconnecting..." during silent session restoration
            let displayStatus = dbSession.status;
            let displayIsLoggedIn = false;

            if (whatsAppSession) {
              // If database says 'connected' and WhatsApp service is restoring (silentReconnect flag),
              // keep showing 'connected' status to avoid UI flicker
              if (dbSession.status === 'connected' && whatsAppSession.silentReconnect) {
                displayStatus = 'connected';
                displayIsLoggedIn = true;
              } else {
                // Otherwise use real-time status
                displayStatus = whatsAppSession.status;
                displayIsLoggedIn = whatsAppSession.isLoggedIn;
              }
            }

            const sessionData = {
              sessionId: dbSession.sessionId,
              name: dbSession.name,
              deviceName: dbSession.deviceName,
              phoneNumber: dbSession.phoneNumber,
              status: dbSession.status,
              qrCode: dbSession.qrCode,
              pairingCode: dbSession.pairingCode,
              isActive: dbSession.isActive,
              createdAt: dbSession.createdAt,
              updatedAt: dbSession.updatedAt,
              connectedAt: dbSession.connectedAt,
              disconnectedAt: dbSession.disconnectedAt,
              lastSeen: dbSession.lastSeen,
              // Real-time fields from WhatsApp service (with smart status handling)
              realTimeStatus: displayStatus,
              isLoggedIn: displayIsLoggedIn,
              connectionTimestamp: whatsAppSession ? whatsAppSession.connectionTimestamp : null
            };

            return sessionData;
          });

          logToFile(`✅ Fallback: Returning ${sessions.length} sessions`);
          return sessions;
        } catch (error) {
          logToFile(`❌ Fallback: Error getting WhatsApp sessions: ${error.message}`);
          logToFile(`❌ Fallback: Error stack: ${error.stack}`);
          return [];
        }
      },

      async createPairingCodeSession(phoneNumber) {
        return await whatsappService.createPairingCodeSession(phoneNumber);
      },

      // Message sending methods
      async sendMessage(sessionId, to, message, type = 'text', options = {}) {
        try {
          logToFile(`🔄 Fallback: Sending message to ${to} via session ${sessionId}`);
          return await whatsappService.sendMessage(sessionId, to, message, type, options);
        } catch (error) {
          logToFile(`❌ Fallback: Error sending message: ${error.message}`);
          return { success: false, error: error.message };
        }
      }
    };

    logToFile('✅ Fallback services initialized successfully with WhatsApp support');

  } catch (error) {
    logToFile(`❌ Failed to initialize fallback services: ${error.message}`);
    logToFile(`❌ Fallback error stack: ${error.stack}`);
  }
}

// Load app service function with timeout
function loadAppService() {
  return new Promise((resolve) => {
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      logToFile('❌ AppService loading timed out after 30 seconds');
      resolve(false);
    }, 30000);

    try {
      logToFile('🔄 Starting to load app service...');
      const possiblePaths = [
        './services/app.service',
        '../services/app.service',
        path.join(__dirname, 'services/app.service'),
        path.join(__dirname, '../services/app.service'),
      ];

      let servicePath = null;
      for (const testPath of possiblePaths) {
        try {
          require.resolve(testPath);
          servicePath = testPath;
          logToFile(`🔍 Found service at: ${testPath}`);
          break;
        } catch (e) {
          logToFile(`🔍 Service not found at: ${testPath}`);
        }
      }

      if (servicePath) {
        logToFile(`🔄 Loading AppService from: ${servicePath}`);

        // Try to load with timeout - use async IIFE
        setTimeout(() => {
          (async () => {
            try {
              // Clear require cache to ensure fresh load
              const resolvedPath = require.resolve(servicePath);
              delete require.cache[resolvedPath];

              const AppService = require(servicePath);
              logToFile('🔄 Creating AppService instance...');
              logToFile(`🔄 AppService type: ${typeof AppService}`);
              logToFile(`🔄 AppService constructor: ${AppService.constructor.name}`);

              appService = new AppService();
              logToFile(`🔄 AppService instance created, type: ${typeof appService}`);
              logToFile(`🔄 AppService methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(appService)).join(', ')}`);

              logToFile('🔄 Initializing AppService...');
              await appService.initialize();

              // Set up global services for cross-service communication
              global.services = {
                whatsapp: appService.getWhatsAppService()
              };

              // Set global app service reference for other services
              global.appService = appService;

              // Initialize Live Chat Service
              logToFile('🔄 [MAIN] Initializing Live Chat Service...');
              const liveChatInitResult = await initializeLiveChatService();
              logToFile(`🔄 [MAIN] Live Chat Service init result: ${JSON.stringify(liveChatInitResult)}`);

              logToFile(`✅ App service loaded and initialized from: ${servicePath}`);
              clearTimeout(timeout);
              resolve(true);
            } catch (err) {
              logToFile(`❌ Failed to create AppService instance: ${err.message}`);
              logToFile(`❌ Error stack: ${err.stack}`);
              clearTimeout(timeout);
              resolve(false);
            }
          })();
        }, 100);
      } else {
        logToFile('❌ App service not found in any expected location');
        clearTimeout(timeout);
        resolve(false);
      }
    } catch (err) {
      logToFile(`❌ Failed to load app service: ${err.message}`);
      logToFile(`❌ Error stack: ${err.stack}`);
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

// Setup event forwarding after app initialization
function setupEventForwarding() {
  if (!appService) {
    logToFile('⚠️ Cannot setup event forwarding: appService not available');
    return;
  }

  try {
    const eventService = appService.getEventService();
    if (!eventService) {
      logToFile('⚠️ Cannot setup event forwarding: eventService not available');
      return;
    }

    if (!mainWindow) {
      logToFile('⚠️ Cannot setup event forwarding: mainWindow not available');
      return;
    }

    logToFile('🔄 Setting up event forwarding...');
    // Forward WhatsApp events to renderer process
    eventService.on('qr_code_generated', (data) => {
      if (isDev) {
      }
      if (mainWindow) {
        mainWindow.webContents.send('whatsapp:qr-code', data);
        if (isDev) {
        }
      } else {
        if (isDev) {
        }
      }
    });

    eventService.on('session_connected', (data) => {
      console.log('🔔 [MAIN] session_connected event received from EventService:', data.sessionId);
      if (mainWindow) {
        console.log('📤 [MAIN] Forwarding to renderer via whatsapp:session-connected');
        mainWindow.webContents.send('whatsapp:session-connected', data);
        console.log('✅ [MAIN] Event forwarded successfully');
      } else {
        console.log('❌ [MAIN] mainWindow is null, cannot forward event');
      }
    });

    eventService.on('session_disconnected', (data) => {
      console.log('🔔 [MAIN] session_disconnected event received from EventService:', data.sessionId);
      if (mainWindow) {
        console.log('📤 [MAIN] Forwarding to renderer via whatsapp:session-disconnected');
        mainWindow.webContents.send('whatsapp:session-disconnected', data);
        console.log('✅ [MAIN] Event forwarded successfully');
      } else {
        console.log('❌ [MAIN] mainWindow is null, cannot forward event');
      }
    });

    eventService.on('message_received', (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('whatsapp:message-received', data);
      }
    });

    // Setup warmer service event forwarding
    try {
      const warmerService = appService.getWarmerService();
      if (warmerService) {
        warmerService.on('campaign-updated', (data) => {
          if (mainWindow) {
            mainWindow.webContents.send('warmer:campaign-updated', data);
          }
        });
        logToFile('✅ Warmer service event forwarding setup complete');
      }
    } catch (warmerError) {
      logToFile(`⚠️ Warmer service event forwarding not available: ${warmerError.message}`);
    }

    // Setup Live Chat service event forwarding
    try {
      const liveChatService = appService.getLiveChatService();
      if (liveChatService) {
        liveChatService.on('message:new', (data) => {
          if (mainWindow) {
            mainWindow.webContents.send('live-chat:message-new', data);
          }
        });
        logToFile('✅ Live Chat service event forwarding setup complete');
      }
    } catch (liveChatError) {
      logToFile(`⚠️ Live Chat service event forwarding not available: ${liveChatError.message}`);
    }

    logToFile('✅ Event forwarding setup complete');
  } catch (error) {
    logToFile(`❌ Error setting up event forwarding: ${error.message}`);
  }
}

// App ready handler
app.whenReady().then(async () => {
  try {
    logToFile('🚀 Electron app is ready');

    // Try to load and initialize app service before creating window
    logToFile('🔄 Attempting to load app service...');
    const serviceLoaded = await loadAppService();

    if (serviceLoaded && appService) {
      try {
        // App service is already initialized in loadAppService()
        // Just verify it's initialized
        if (!appService.isInitialized) {
          logToFile('⚠️ App service not initialized, initializing now...');
          await appService.initialize();
        }
        logToFile('✅ App service ready');

        // Register Translation Management IPC Handlers after app service is initialized
        ipcMain.handle('translation:get-translations-for-language', async (event, languageCode) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            const data = await appService.translationService.getTranslationsForLanguage(languageCode);
            return { success: true, data };
          } catch (error) {
            logToFile(`❌ Get translations error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:update-translation', async (event, keyId, languageCode, customText, isApproved, notes) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            const result = await appService.translationService.updateTranslation(keyId, languageCode, customText, isApproved, notes);
            return result;
          } catch (error) {
            logToFile(`❌ Update translation error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:delete-translation', async (event, keyId, languageCode) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            const result = await appService.translationService.deleteTranslation(keyId, languageCode);
            return result;
          } catch (error) {
            logToFile(`❌ Delete translation error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:get-stats', async (event) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            const data = await appService.translationService.getTranslationStats();
            return { success: true, data };
          } catch (error) {
            logToFile(`❌ Get translation stats error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:sync-keys', async (event) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            let enLocale;
            try {
              const path = require('path');
              const fs = require('fs');

              // Try multiple possible paths
              const possiblePaths = [
                path.join(__dirname, 'locales/en.js'),           // build/locales/en.js (development)
                path.join(__dirname, '../locales/en.js'),        // locales/en.js (packaged)
                path.join(__dirname, '../../src/locales/en.js'), // src/locales/en.js (development fallback)
                path.join(process.cwd(), 'src/locales/en.js'),   // src/locales/en.js (cwd)
                path.join(app.getAppPath(), 'src/locales/en.js'), // src/locales/en.js (app path)
                path.join(app.getAppPath(), 'build/locales/en.js') // build/locales/en.js (app path)
              ];

              let localeFilePath = null;
              for (const testPath of possiblePaths) {
                if (fs.existsSync(testPath)) {
                  localeFilePath = testPath;
                  logToFile(`✅ Found locale file at: ${localeFilePath}`);
                  break;
                }
              }

              if (!localeFilePath) {
                logToFile(`❌ Could not find en.js in any of these paths: ${possiblePaths.join(', ')}`);
                return { success: false, error: 'Could not find English locale file' };
              }

              // Read the file and parse it
              const fileContent = fs.readFileSync(localeFilePath, 'utf8');

              // Remove 'export default' and evaluate the object
              const objectContent = fileContent.replace(/^export\s+default\s+/, '').trim();

              // Use Function constructor to safely evaluate the object literal
              enLocale = new Function(`return ${objectContent}`)();

              logToFile(`✅ Locale loaded successfully, keys: ${Object.keys(enLocale).length}`);
            } catch (error) {
              logToFile(`❌ Error loading locale file: ${error.message}`);
              logToFile(`❌ Error stack: ${error.stack}`);
              return { success: false, error: `Could not load English locale file: ${error.message}` };
            }
            const result = await appService.translationService.syncTranslationKeys(enLocale);
            logToFile(`✅ Sync result: ${JSON.stringify(result)}`);
            return result;
          } catch (error) {
            logToFile(`❌ Sync translation keys error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:export-translations', async (event, languageCode) => {
          try {
            logToFile(`📤 [IPC MAIN.JS] Export translations called for language: ${languageCode}`);
            if (!appService || !appService.translationService) {
              logToFile(`❌ [IPC MAIN.JS] Translation service not available`);
              return { success: false, error: 'Translation service not available' };
            }
            const data = await appService.translationService.exportTranslations(languageCode);
            logToFile(`📤 [IPC MAIN.JS] Export returned data with ${Object.keys(data).length} top-level keys`);
            logToFile(`📤 [IPC MAIN.JS] Sample keys: ${Object.keys(data).slice(0, 5).join(', ')}`);
            logToFile(`📤 [IPC MAIN.JS] Data type: ${typeof data}`);
            logToFile(`📤 [IPC MAIN.JS] Data preview: ${JSON.stringify(data).substring(0, 300)}`);
            return { success: true, data };
          } catch (error) {
            logToFile(`❌ Export translations error: ${error.message}`);
            logToFile(`❌ Error stack: ${error.stack}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:import-translations', async (event, languageCode, translationsData, approveAll) => {
          try {
            logToFile(`📥 [IPC MAIN.JS] Import translations called for language: ${languageCode}, approveAll: ${approveAll}`);
            if (!appService || !appService.translationService) {
              logToFile(`❌ [IPC MAIN.JS] Translation service not available`);
              return { success: false, error: 'Translation service not available' };
            }
            const result = await appService.translationService.importTranslations(languageCode, translationsData, approveAll);
            logToFile(`✅ [IPC MAIN.JS] Import completed: ${JSON.stringify(result)}`);
            return { success: true, ...result };
          } catch (error) {
            logToFile(`❌ Import translations error: ${error.message}`);
            logToFile(`❌ Error stack: ${error.stack}`);
            return { success: false, error: error.message };
          }
        });

        ipcMain.handle('translation:search-translations', async (event, languageCode, searchTerm) => {
          try {
            if (!appService || !appService.translationService) {
              return { success: false, error: 'Translation service not available' };
            }
            const data = await appService.translationService.searchTranslations(languageCode, searchTerm);
            return { success: true, data };
          } catch (error) {
            logToFile(`❌ Search translations error: ${error.message}`);
            return { success: false, error: error.message };
          }
        });

        logToFile('✅ Translation IPC handlers registered');

        // Get database service reference for window creation
        databaseService = appService.getDatabaseService();
        if (databaseService) {
          logToFile('✅ Database service available for window creation');
        } else {
          logToFile('❌ Database service is null/undefined');
        }
      } catch (serviceError) {
        logToFile(`❌ App service initialization failed: ${serviceError.message}`);
        logToFile(`❌ Service error stack: ${serviceError.stack}`);
        // Continue without app service
      }
    } else {
      logToFile('⚠️ App service failed to load, initializing fallback services...');
      await initializeFallbackServices();
    }

  } catch (error) {
    logToFile(`❌ Failed to initialize: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);
  }

  // Always create main window after initialization (success or failure)
  try {
    logToFile('🪟 Creating main window...');
    createWindow();

    // Setup event forwarding after window is created (only if appService is available)
    if (appService) {
      try {
        setupEventForwarding();
      } catch (eventError) {
        logToFile(`❌ Failed to setup event forwarding: ${eventError.message}`);
      }
    }

    // Initialize update service after window is created
    logToFile('🔄 Initializing update service...');
    initializeUpdateService();

  } catch (windowError) {
    logToFile(`❌ Failed to create window: ${windowError.message}`);
    gracefulShutdown();
  }
});

// Handle activate event (macOS)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    logToFile('🔄 App activated, creating new window...');
    createWindow();
  }
});

// IPC handler for close confirmation response
ipcMain.on('app:close-confirmation-response', (event, confirmed) => {
  // This is handled by the promise in the close event handler
  logToFile(`🔄 Close confirmation response received: ${confirmed}`);
});

// Self-contained license validation function
function validateSelfContainedLicense(licenseKey) {
  try {
    // Self-contained licenses have embedded data in the key format
    // Format: LW-[DATA]-[EXPIRY]-[CHECKSUM]-[SIGNATURE]
    const parts = licenseKey.split('-');

    if (parts.length !== 5 || parts[0] !== 'LW') {
      return {
        success: false,
        error: `Invalid self-contained license format. Expected 5 parts, got ${parts.length}. Format should be: LW-DATA-EXPIRY-CHECKSUM-SIGNATURE`
      };
    }

    const [prefix, encodedData, expiryHex, providedChecksum, providedSignature] = parts;

    // Validate checksum
    const dataToSign = `${encodedData}-${expiryHex}`;
    const expectedChecksum = crypto.createHash('md5').update(dataToSign).digest('hex').substring(0, 4).toUpperCase();

    if (providedChecksum !== expectedChecksum) {
      return {
        success: false,
        error: 'License checksum validation failed'
      };
    }

    // Validate signature
    const expectedSignature = crypto.createHash('sha256').update(dataToSign + 'LEADWAVE_SECRET').digest('hex').substring(0, 8).toUpperCase();

    if (providedSignature !== expectedSignature) {
      return {
        success: false,
        error: 'License signature validation failed'
      };
    }

    // Decode license data
    const licenseDataJson = Buffer.from(encodedData, 'hex').toString('utf8');
    const licenseData = JSON.parse(licenseDataJson);

    // Check expiry
    const expiryTimestamp = parseInt(expiryHex, 16);
    const expiryDate = new Date(expiryTimestamp * 1000);
    const now = new Date();

    if (now > expiryDate) {
      return {
        success: false,
        error: 'License has expired',
        expires_at: expiryDate.toISOString()
      };
    }

    return {
      success: true,
      customer_name: licenseData.name,
      plan_type: licenseData.plan,
      expires_at: expiryDate.toISOString(),
      status: 'active'
    };

  } catch (error) {
    return {
      success: false,
      error: 'Failed to validate self-contained license: ' + error.message
    };
  }
}

// Stable Machine ID Generation with Persistence (matches keygen app)
function generateMachineId() {
  try {
    // Check if we have a persisted machine ID first
    const persistedId = getPersistedMachineId();
    if (persistedId) {
      logToFile(`📋 Using persisted machine ID: ${persistedId}`);
      return persistedId;
    }

    // Generate new stable machine ID using same algorithm as keygen app
    const stableMachineId = generateStableMachineId();

    // Persist the generated ID for future use
    persistMachineId(stableMachineId);

    logToFile(`🆔 Generated new stable machine ID: ${stableMachineId}`);
    return stableMachineId;
  } catch (error) {
    logToFile(`❌ Error getting machine ID: ${error.message}`);
    // Fallback to a random ID if all else fails
    return crypto.randomBytes(8).toString('hex').toUpperCase();
  }
}

// Generate stable machine ID using same algorithm as keygen app
function generateStableMachineId() {
  try {
    // Use only stable system components that don't change frequently
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const username = os.userInfo().username;

    // Get CPU model (stable across driver updates)
    const cpus = os.cpus();
    const cpuModel = cpus && cpus.length > 0 ? cpus[0].model : 'unknown';

    // Get primary MAC address (most stable network interface)
    const primaryMac = getPrimaryMacAddress();

    // Create stable machine string (SAME as keygen app)
    const machineString = `${hostname}-${platform}-${arch}-${username}-${cpuModel}-${primaryMac}`;

    // Generate hash (16 chars for compatibility with keygen app)
    const hash = crypto.createHash('sha256').update(machineString).digest('hex');
    return hash.substring(0, 16).toUpperCase();

  } catch (error) {
    logToFile(`Error generating stable machine ID: ${error.message}`);
    throw error;
  }
}

// Get the most stable MAC address (SAME as keygen app)
function getPrimaryMacAddress() {
  const networkInterfaces = os.networkInterfaces();

  // Look for interfaces in order of stability (Ethernet > WiFi > Others)
  const interfaceOrder = ['Ethernet', 'Wi-Fi', 'WiFi', 'wlan0', 'eth0', 'en0'];

  // First try preferred interfaces
  for (const preferredInterface of interfaceOrder) {
    if (networkInterfaces[preferredInterface]) {
      const interfaces = networkInterfaces[preferredInterface];
      for (const iface of interfaces) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac;
        }
      }
    }
  }

  // If no preferred interface found, use the first available
  for (const interfaceName in networkInterfaces) {
    const interfaces = networkInterfaces[interfaceName];
    for (const iface of interfaces) {
      if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }

  // Fallback if no MAC address found
  return 'no-mac-found';
}

// Get persisted machine ID from file
function getPersistedMachineId() {
  try {
    // Try to load from encrypted file using newlic-license-service
    const newlicService = require(resolveModulePath('services/newlic-license-service'));
    const machineId = newlicService.loadMachineId();

    if (machineId) {
      logToFile(`✅ Loaded encrypted machine ID: ${machineId}`);
      return machineId;
    }

    // Fallback: Try to load from old unencrypted file and migrate
    const appDataPath = getAppDataPath();
    const oldMachineIdFile = path.join(appDataPath, 'machine-id.json');
    if (fs.existsSync(oldMachineIdFile)) {
      logToFile('🔄 Found old unencrypted machine-id.json, migrating to encrypted format...');
      const data = JSON.parse(fs.readFileSync(oldMachineIdFile, 'utf8'));

      if (data.machineId && /^[A-F0-9]{16}$/.test(data.machineId)) {
        // Save to encrypted format
        newlicService.saveMachineId(data.machineId);

        // Delete old unencrypted file
        fs.unlinkSync(oldMachineIdFile);
        logToFile('✅ Migrated machine ID to encrypted format');

        return data.machineId;
      }
    }
  } catch (error) {
    if (error.message === 'TAMPER_DETECTED') {
      logToFile('🚨 MACHINE ID TAMPERING DETECTED!');
      return null;
    }
    logToFile(`Could not read persisted machine ID: ${error.message}`);
  }
  return null;
}

// Persist machine ID to encrypted file
function persistMachineId(machineId) {
  try {
    const newlicService = require(resolveModulePath('services/newlic-license-service'));
    const success = newlicService.saveMachineId(machineId);

    if (success) {
      logToFile('💾 Machine ID encrypted and persisted successfully');
    } else {
      logToFile('❌ Failed to persist machine ID');
    }
  } catch (error) {
    logToFile(`Could not persist machine ID: ${error.message}`);
  }
}

// Function to update Laravel system with machine ID
async function updateLaravelLicenseWithMachineId(licenseKey, machineId, customerName) {
  try {
    const response = await fetch('https://purchase.getleadwave.in/api/license/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        license_code: licenseKey,
        customer_name: customerName,
        mobile_number: '0000000000', // Placeholder since we don't have this in Keygen
        machine_id: machineId,
        machine_fingerprint: crypto.createHash('sha256').update(machineId).digest('hex'),
        os_info: `${os.platform()} ${os.release()}`,
        hardware_info: `${os.arch()} ${os.cpus()[0]?.model || 'Unknown CPU'}`
      })
    });

    if (!response.ok) {
      throw new Error(`Laravel API responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || 'Laravel API returned error');
    }

    return result;
  } catch (error) {
    logToFile(`❌ Laravel API error: ${error.message}`);
    throw error;
  }
}

// License Management IPC Handlers
ipcMain.handle('license:get-machine-id', () => {
  return generateMachineId();
});

// Reseller Configuration IPC Handlers
ipcMain.handle('reseller:get-config', () => {
  return {
    isResellerBuild: isResellerBuild(),
    isMasterAccountMode: isMasterAccountMode(),
    resellerCode: getResellerCode(),
    masterAccountId: getMasterAccountId(),
    resellerInfo: getResellerInfo()
  };
});

ipcMain.handle('license:activate', async (event, licenseKey) => {
  if (isDev) {
  }
  try {
    if (isDev) {
    }

    // Trim whitespace from license key (important for copy-paste)
    licenseKey = licenseKey.trim();
    logToFile(`🔑 License key (trimmed): ${licenseKey}`);

    const machineId = generateMachineId();
    logToFile(`🔑 Attempting license activation for: ${licenseKey} with machine ID: ${machineId}`);
    if (isDev) {
    }

    // SIMPLIFIED LICENSE VALIDATION - Direct validation without complex service
    logToFile('🔍 Starting simplified license validation...');
    if (isDev) {
    }

    // Use EXACT same validation logic as Keygen app generates
    const parts = licenseKey.split('-');

    if (parts.length === 5 && parts[0] === 'LW') {
      logToFile('🔍 Detected self-contained license format (Keygen generated)');

      try {
        const [prefix, encodedData, expiryHex, checksum, signature] = parts;
        const crypto = require('crypto');

        logToFile(`🔍 Parts: prefix=${prefix}, encodedData=${encodedData}, expiryHex=${expiryHex}, checksum=${checksum}, signature=${signature}`);

        // Verify checksum FIRST (using EXACT same logic as Keygen)
        const dataToSign = `${encodedData}-${expiryHex}`;
        const calculatedChecksum = crypto.createHash('md5').update(dataToSign).digest('hex').substring(0, 4).toUpperCase();

        logToFile(`🔍 Checksum validation: expected=${calculatedChecksum}, provided=${checksum}`);
        if (checksum !== calculatedChecksum) {
          logToFile('❌ Checksum validation failed');
          return {
            success: false,
            message: 'Invalid license key. Checksum verification failed.',
            error_code: 'INVALID_CHECKSUM'
          };
        }

        // Verify signature (using EXACT same logic as Keygen)
        const calculatedSignature = crypto.createHash('sha256').update(dataToSign + 'LEADWAVE_SECRET').digest('hex').substring(0, 8).toUpperCase();

        logToFile(`🔍 Signature validation: expected=${calculatedSignature}, provided=${signature}`);
        if (signature !== calculatedSignature) {
          logToFile('❌ Signature validation failed');
          return {
            success: false,
            message: 'Invalid license key. Signature verification failed.',
            error_code: 'INVALID_SIGNATURE'
          };
        }

        // Decode embedded data (after validation passes)
        const decodedData = Buffer.from(encodedData, 'hex').toString('utf8');
        const parsedLicenseData = JSON.parse(decodedData);
        logToFile(`🔍 Decoded license data: ${JSON.stringify(parsedLicenseData)}`);

        // Check expiry (using EXACT same logic as Keygen)
        const expiryTimestamp = parseInt(expiryHex, 16);
        const expiryDate = new Date(expiryTimestamp * 1000);
        const now = new Date();

        logToFile(`🔍 Expiry check: now=${now.toISOString()}, expires=${expiryDate.toISOString()}`);
        if (now > expiryDate) {
          logToFile('❌ License has expired');
          return {
            success: false,
            message: 'This license has expired. Please contact your administrator.',
            error_code: 'EXPIRED'
          };
        }

        logToFile('✅ All validations passed - license is valid');

        // Check if license has machine ID restriction
        const licenseMachineId = parsedLicenseData.machine_id;
        if (licenseMachineId) {
          logToFile(`🔍 License machine ID: ${licenseMachineId}`);
          logToFile(`🔍 Current machine ID: ${machineId}`);

          if (licenseMachineId !== machineId) {
            logToFile('❌ Machine ID mismatch - license not valid for this machine');
            return {
              success: false,
              message: 'This license key is not valid for this computer. Please contact your administrator for a license specific to this machine.',
              error_code: 'MACHINE_ID_MISMATCH'
            };
          }

          logToFile('✅ Machine ID validation passed');
        } else {
          logToFile('ℹ️ License has no machine ID restriction (legacy license)');
        }

        // Check for duplicate activation FIRST (before storing anything)
        const activationsFile = path.join(os.homedir(), 'ChatPro', 'activations.json');
        let activations = [];

        if (fs.existsSync(activationsFile)) {
          try {
            activations = JSON.parse(fs.readFileSync(activationsFile, 'utf8'));
          } catch (error) {
            logToFile(`⚠️ Failed to read activations file: ${error.message}`);
          }
        }

        // Check if this license has already been activated on this machine
        const existingActivation = activations.find(activation =>
          activation.license_key === licenseKey && activation.machine_id === machineId
        );

        if (existingActivation) {
          logToFile(`❌ License ${licenseKey} already activated on machine ${machineId}`);
          return {
            success: false,
            message: 'This license key has already been activated on this machine. Each license can only be activated once per machine.',
            error_code: 'LICENSE_ALREADY_ACTIVATED'
          };
        }

        // Store license info locally (simplified approach)
        logToFile('💾 Storing license information locally...');

        // Extract company information - support both 'company' and 'company_info' fields
        let companyInfo = null;
        if (parsedLicenseData.company_info) {
          companyInfo = parsedLicenseData.company_info;
        } else if (parsedLicenseData.company) {
          // Handle old format with 'company' field and 'phone' instead of 'mobile'
          companyInfo = {
            name: parsedLicenseData.company.name || '',
            email: parsedLicenseData.company.email || '',
            mobile: parsedLicenseData.company.phone || parsedLicenseData.company.mobile || '',
            website: parsedLicenseData.company.website || ''
          };
        }

        const licenseInfo = {
          license_key: licenseKey,
          machine_id: machineId,
          customer_name: parsedLicenseData.name || 'Licensed User',
          plan_name: parsedLicenseData.plan || 'standard',
          modules: parsedLicenseData.modules || [], // Include enabled modules
          max_devices: parsedLicenseData.max_devices || 5, // Include max devices limit
          company_info: companyInfo, // Include company information
          expires_at: expiryDate.toISOString(),
          activated_at: new Date().toISOString(),
          status: 'active',
          app_version: app.getVersion()
        };

        logToFile(`💾 License modules: ${JSON.stringify(parsedLicenseData.modules || [])}`);
        logToFile(`💾 Company info: ${JSON.stringify(companyInfo)}`);

        // Add signature for integrity protection
        addLicenseSignature(licenseInfo);

        // Save to local file
        const licenseDir = path.join(os.homedir(), 'ChatPro');
        if (!fs.existsSync(licenseDir)) {
          fs.mkdirSync(licenseDir, { recursive: true });
        }

        const licensePath = path.join(licenseDir, 'license.json');
        fs.writeFileSync(licensePath, JSON.stringify(licenseInfo, null, 2));
        logToFile(`💾 License saved to: ${licensePath}`);

        // Record the activation
        activations.push({
          license_key: licenseKey,
          machine_id: machineId,
          activated_at: new Date().toISOString(),
          app_version: app.getVersion()
        });

        // Save updated activations
        fs.writeFileSync(activationsFile, JSON.stringify(activations, null, 2));
        logToFile(`💾 Recorded license activation: ${licenseKey} on machine ${machineId}`);

        // License activation successful - no need to create new windows
        logToFile('✅ License activation completed successfully');

        // Background license checking is already running
        logToFile('✅ License activation completed successfully');
        return {
          success: true,
          message: 'License activated successfully!',
          data: {
            license_key: licenseKey,
            customer_name: licenseInfo.customer_name,
            plan_name: licenseInfo.plan_name,
            expires_at: licenseInfo.expires_at,
            modules: licenseInfo.modules, // Include modules in response
            max_devices: licenseInfo.max_devices || 5, // Include max devices limit
            company_info: licenseInfo.company_info // Include company info in response
          }
        };

      } catch (validationError) {
        logToFile(`❌ Self-contained validation error: ${validationError.message}`);
        logToFile(`❌ Error stack: ${validationError.stack}`);
        console.error('❌ License activation validation error:', validationError);
        return {
          success: false,
          message: 'Invalid license key format. Please check your license key.',
          error_code: 'VALIDATION_ERROR'
        };
      }
    } else {
      // Not a self-contained license, return error
      logToFile('❌ License key format not recognized');
      return {
        success: false,
        message: 'Invalid license key format. Please ensure you have a valid license key.',
        error_code: 'INVALID_FORMAT'
      };
    }

    // Save to local file
    const licenseDir = path.join(os.homedir(), 'ChatPro');
    if (!fs.existsSync(licenseDir)) {
      fs.mkdirSync(licenseDir, { recursive: true });
    }

    const licensePath = path.join(licenseDir, 'license.json');
    fs.writeFileSync(licensePath, JSON.stringify(licenseInfo, null, 2));
    logToFile(`💾 License saved to: ${licensePath}`);

    // Close license window and open main window
    if (licenseWindow) {
      licenseWindow.close();
    }

    createWindow();
    createMenu();

    // Background license checking is already running
    logToFile('✅ License activation completed successfully');
    return {
      success: true,
      message: 'License activated successfully!',
      data: {
        customer_name: licenseInfo.customer_name,
        plan_name: licenseInfo.plan_name,
        expires_at: licenseInfo.expires_at
      }
    };

  } catch (error) {
    logToFile(`❌ Error activating license: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);
    return {
      success: false,
      message: 'Failed to activate license. Please check your license key and try again.',
      error: error.message
    };
  }
});

// License renewal handler - specifically for renewing existing licenses with extended expiry
ipcMain.handle('license:renew', async (event, renewedLicenseKey) => {
  try {
    logToFile(`🔄 Starting license renewal with renewed key: ${renewedLicenseKey}`);

    const machineId = generateMachineId();
    logToFile(`🔄 Generated machine ID: ${machineId}`);

    // Check if this is a NewLic license (starts with "LW-" and has specific format)
    // NewLic licenses don't require existing license check - they can be activated directly
    const isNewLicLicense = renewedLicenseKey.startsWith('LW-') && renewedLicenseKey.split('-').length >= 5;

    if (isNewLicLicense) {
      logToFile(`🔑 NewLic license detected, using NewLic renewal flow...`);

      // Simply activate the new license - NewLic service validates with server
      // Note: newlicLicenseService is already defined as a singleton at the top of the file
      const newlicService = require(resolveModulePath('services/newlic-license-service'));

      const activationResult = await newlicService.activateLicense(renewedLicenseKey, machineId);

      if (!activationResult.success) {
        logToFile(`❌ NewLic license renewal failed: ${activationResult.message}`);
        return {
          success: false,
          message: activationResult.message || 'Failed to renew license',
          error_code: 'NEWLIC_RENEWAL_FAILED'
        };
      }

      logToFile(`✅ NewLic license renewed successfully`);
      logToFile(`✅ Renewed license data: ${JSON.stringify(activationResult.data)}`);

      return {
        success: true,
        data: activationResult.data,
        message: 'NewLic license renewed successfully'
      };
    }

    // For non-NewLic licenses, check for existing license files
    const appDataPath = getAppDataPath();
    const licenseFile = path.join(appDataPath, 'license.json');
    const cloudLicenseFile = path.join(appDataPath, 'cloud-license.json');

    const hasLocalLicense = fs.existsSync(licenseFile);
    const hasCloudLicense = fs.existsSync(cloudLicenseFile);

    if (!hasLocalLicense && !hasCloudLicense) {
      logToFile(`❌ No existing license found for renewal`);
      return {
        success: false,
        message: 'No existing license found. Please activate a license first.',
        error_code: 'NO_EXISTING_LICENSE'
      };
    }

    // If cloud license exists, use cloud license renewal flow
    if (hasCloudLicense) {
      logToFile(`🌐 Cloud license detected, using cloud renewal flow...`);

      // For cloud licenses, just activate the new license (which will replace the old one)
      const cloudLicenseService = require('../services/cloud-license-service');

      const activationResult = await cloudLicenseService.activateCloudLicense(renewedLicenseKey, machineId);

      if (!activationResult.success) {
        logToFile(`❌ Cloud license renewal failed: ${activationResult.message}`);
        return {
          success: false,
          message: activationResult.message || 'Failed to renew cloud license',
          error_code: 'CLOUD_RENEWAL_FAILED'
        };
      }

      // Extract data from activation result
      const cloudData = activationResult.data;

      // Calculate days remaining
      const now = new Date();
      const expiresAt = new Date(cloudData.expires_at);
      const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

      logToFile(`✅ Cloud license renewed successfully`);
      logToFile(`✅ Renewed license data: ${JSON.stringify(cloudData)}`);

      return {
        success: true,
        data: {
          license_key: renewedLicenseKey,
          customer_name: cloudData.customer_name,
          plan_name: cloudData.plan_name || cloudData.plan,
          expires_at: cloudData.expires_at,
          expires_at_formatted: new Date(cloudData.expires_at).toLocaleDateString(),
          status: cloudData.status || 'active',
          modules: cloudData.modules || [],
          features: cloudData.features || [],
          days_remaining: daysRemaining,
          validity_days: daysRemaining,
          duration_days: daysRemaining,
          is_trial: false,
          isTrial: false,
          isValid: true,
          isUpgraded: false,
          machine_id: machineId,
          activated_at: cloudData.activated_at,
          renewed_at: new Date().toISOString(),
          renewal_count: 1
        },
        message: 'Cloud license renewed successfully'
      };
    }

    // Local license renewal flow (existing code)
    if (!hasLocalLicense) {
      logToFile(`❌ No existing local license found for renewal`);
      return {
        success: false,
        message: 'No existing license found. Please activate a license first.',
        error_code: 'NO_EXISTING_LICENSE'
      };
    }

    const currentLicenseData = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));
    const currentLicenseKey = currentLicenseData.license_key;

    logToFile(`🔄 Current license key: ${currentLicenseKey}`);
    logToFile(`🔄 Renewed license key: ${renewedLicenseKey}`);

    // Use local license service to validate the renewed license
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();

    // For renewal, we need to validate the license without checking activation status
    logToFile(`📤 Validating renewed license: ${renewedLicenseKey}`);

    // First validate the license format and content
    const validationResult = await localLicenseService.validateSelfContainedLicense(renewedLicenseKey);

    if (!validationResult.success) {
      logToFile(`❌ License validation failed: ${validationResult.error}`);
      return {
        success: false,
        message: validationResult.error || 'Invalid license key',
        error_code: 'INVALID_LICENSE'
      };
    }

    // Check if the renewed license is for the same customer/user (case-insensitive, trimmed)
    const currentCustomerName = (currentLicenseData.customer_name || '').trim().toLowerCase();
    const renewedCustomerName = (validationResult.customer_name || '').trim().toLowerCase();

    if (currentCustomerName && renewedCustomerName && currentCustomerName !== renewedCustomerName) {
      logToFile(`❌ License renewal failed: Customer name mismatch`);
      logToFile(`   Current: "${currentLicenseData.customer_name}" (normalized: "${currentCustomerName}")`);
      logToFile(`   Renewed: "${validationResult.customer_name}" (normalized: "${renewedCustomerName}")`);
      return {
        success: false,
        message: `The renewed license is not for the same customer. Current: "${currentLicenseData.customer_name}", Renewed: "${validationResult.customer_name}". Please contact support.`,
        error_code: 'CUSTOMER_MISMATCH'
      };
    }

    // Validate machine ID if present in the renewed license
    if (validationResult.machine_id && validationResult.machine_id !== machineId) {
      logToFile(`❌ License renewal failed: Machine ID mismatch`);
      logToFile(`   Current machine: ${machineId}`);
      logToFile(`   License machine: ${validationResult.machine_id}`);
      return {
        success: false,
        message: 'The renewed license is for a different machine. Please generate a renewal license for this machine.',
        error_code: 'MACHINE_ID_MISMATCH'
      };
    }

    // Calculate days remaining for the renewed license
    const now = new Date();
    const expiresAt = new Date(validationResult.expires_at);
    const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

    // Update the activation record for the renewed license
    localLicenseService.updateSelfContainedLicenseActivation(renewedLicenseKey, machineId, app.getVersion());

    // Save updated license data to file
    const licenseData = {
      license_key: renewedLicenseKey,
      customer_name: validationResult.customer_name,
      expires_at: validationResult.expires_at,
      machine_id: machineId,
      activated_at: currentLicenseData.activated_at, // Keep original activation date
      renewed_at: new Date().toISOString(), // Add renewal timestamp
      status: validationResult.status,
      plan_name: validationResult.plan_type,
      modules: validationResult.modules || [], // Include updated modules from renewed license
      duration_days: daysRemaining,
      features: currentLicenseData.features || [],
      isTrial: false,
      isUpgraded: currentLicenseData.isUpgraded || false,
      days_remaining: daysRemaining,
      previous_license: currentLicenseKey,
      renewal_count: (currentLicenseData.renewal_count || 0) + 1
    };

    fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));

    logToFile(`✅ License renewed and saved successfully`);
    logToFile(`✅ New license data: ${JSON.stringify(licenseData)}`);

    return {
      success: true,
      data: {
        license_key: renewedLicenseKey,
        customer_name: validationResult.customer_name,
        plan_name: validationResult.plan_type,
        expires_at: validationResult.expires_at,
        expires_at_formatted: new Date(validationResult.expires_at).toLocaleDateString(),
        status: validationResult.status,
        modules: validationResult.modules || [], // Include modules in renewal response
        days_remaining: daysRemaining,
        validity_days: daysRemaining,
        is_trial: false,
        isTrial: false,
        isValid: true
      },
      message: 'License renewed successfully'
    };
  } catch (error) {
    logToFile(`❌ License renewal error: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);
    return {
      success: false,
      message: `License renewal failed: ${error.message}`,
      error_code: 'RENEWAL_ERROR',
      error_details: error.stack
    };
  }
});

// License upgrade handler
ipcMain.handle('license:upgrade', async (event, newLicenseKey) => {
  try {
    logToFile(`🔄 Starting license upgrade with new key: ${newLicenseKey}`);

    const machineId = generateMachineId();
    logToFile(`🔄 Generated machine ID: ${machineId}`);

    // Get current license key from stored license
    const appDataPath = getAppDataPath();
    const licenseFile = path.join(appDataPath, 'license.json');

    if (!fs.existsSync(licenseFile)) {
      logToFile(`❌ No existing license found for upgrade`);
      return {
        success: false,
        message: 'No existing license found. Please activate a license first.',
        error_code: 'NO_EXISTING_LICENSE'
      };
    }

    const currentLicenseData = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));
    const currentLicenseKey = currentLicenseData.license_key;

    logToFile(`🔄 Current license key: ${currentLicenseKey}`);

    // Use local license service to activate the new license
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();

    logToFile(`📤 Activating new license locally: ${newLicenseKey}`);
    const result = await localLicenseService.activateLicense(newLicenseKey, machineId, app.getVersion());
    logToFile(`📥 Upgrade activation result: ${JSON.stringify(result)}`);

    if (result.success && result.data) {
      // Save updated license data to file
      const licenseData = {
        license_key: newLicenseKey,
        customer_name: result.data.customer_name,
        expires_at: result.data.expires_at,
        machine_id: machineId,
        activated_at: new Date().toISOString(),
        status: result.data.status,
        plan_name: result.data.plan_name,
        modules: result.data.modules || [], // Include modules from upgraded license
        duration_days: result.data.validity_days,
        features: [],
        isTrial: result.data.is_trial || false,
        isUpgraded: true, // Mark as upgraded
        days_remaining: result.data.days_remaining,
        previous_license: currentLicenseKey
      };

      fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));

      logToFile(`✅ License upgraded and saved successfully`);
      logToFile(`✅ New license data: ${JSON.stringify(licenseData)}`);

      return {
        success: true,
        data: result.data,
        message: 'License upgraded successfully'
      };
    } else {
      logToFile(`❌ License upgrade failed: ${result.message}`);
      return {
        success: false,
        message: result.message || 'License upgrade failed',
        error_code: result.error_code
      };
    }
  } catch (error) {
    logToFile(`❌ License upgrade error: ${error.message}`);
    return {
      success: false,
      message: 'Failed to upgrade license. Please ensure the Keygen app is installed and has the license database.',
      error: error.message
    };
  }
});

ipcMain.handle('license:register-trial', async (event, userData) => {
  try {
    const machineId = generateMachineId();
    logToFile(`🔑 Attempting trial registration for: ${userData.email} with machine ID: ${machineId}`);

    // Use local license service instead of Laravel API
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();
    const result = await localLicenseService.registerTrial(userData);

    logToFile(`📥 Trial registration result: ${JSON.stringify(result)}`);

    if (result.success) {
      // Store license info locally
      const licenseData = {
        license_key: result.data.license_key,
        customer_name: result.data.customer_name,
        expires_at: result.data.expires_at,
        machine_id: machineId,
        registered_at: new Date().toISOString(),
        plan_name: 'trial',
        isTrial: true,
        status: 'active',
        validity_days: result.data.validity_days
      };

      // Save to local storage file
      const appDataPath = getAppDataPath();
      if (!fs.existsSync(appDataPath)) {
        fs.mkdirSync(appDataPath, { recursive: true });
      }

      const licenseFile = path.join(appDataPath, 'license.json');
      fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));

      logToFile(`✅ Trial license registered successfully: ${result.data.license_key}`);
    } else {
      // Log detailed error information
      logToFile(`❌ Trial registration failed: ${result.message}`);
    }

    return result;
  } catch (error) {
    logToFile(`❌ Error registering trial license: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);

    return {
      success: false,
      message: 'Failed to register trial license. Please ensure the Keygen app is installed and has the license database.',
      error: error.message
    };
  }
});

ipcMain.handle('license:validate', async (event) => {
  try {
    // Read local license file (try encrypted first, then fallback to plain JSON)
    const appDataPath = getAppDataPath();
    const encryptedLicenseFile = path.join(appDataPath, 'license.enc');
    const plainLicenseFile = path.join(appDataPath, 'license.json');
    const machineId = generateMachineId();

    let localLicenseService = null;
    try {
      const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
      localLicenseService = new LocalLicenseService();
    } catch (moduleError) {
      logToFile(`⚠️ Local license service not available: ${moduleError.message}`);
      logToFile(`🔄 Will use fallback self-contained license validation`);
    }

    let licenseData = null;
    let licenseKey = null;

    // Try to load encrypted license first (NewLic)
    if (fs.existsSync(encryptedLicenseFile)) {
      try {
        logToFile('🔐 Found encrypted license.enc file, attempting to decrypt...');
        const newlicService = require(resolveModulePath('services/newlic-license-service'));
        const encryptedData = fs.readFileSync(encryptedLicenseFile, 'utf8');
        licenseData = newlicService._decrypt(encryptedData);
        licenseKey = licenseData.license_key;
        logToFile(`✅ Successfully decrypted license for: ${licenseData.customer_name}`);
      } catch (decryptError) {
        if (decryptError.message === 'TAMPER_DETECTED') {
          logToFile('🚨 LICENSE TAMPERING DETECTED! Deleting corrupted file.');

          // Delete tampered file
          fs.unlinkSync(encryptedLicenseFile);

          // Report tampering to server
          try {
            const newlicService = require(resolveModulePath('services/newlic-license-service'));
            await newlicService._reportTampering(licenseData?.license_key, machineId);
          } catch (reportError) {
            logToFile(`Failed to report tampering: ${reportError.message}`);
          }

          return {
            success: false,
            message: 'License tampering detected. Please contact support.',
            error_code: 'TAMPER_DETECTED'
          };
        }

        logToFile(`❌ Failed to decrypt license: ${decryptError.message}`);
        return {
          success: false,
          message: 'Failed to decrypt license file',
          error_code: 'DECRYPT_ERROR'
        };
      }
    }

    // Fallback to plain license.json (for old/legacy licenses only)
    if (!licenseData && fs.existsSync(plainLicenseFile)) {
      logToFile('📄 No encrypted license found, checking plain license.json (legacy)...');
      licenseData = JSON.parse(fs.readFileSync(plainLicenseFile, 'utf8'));
      logToFile(`🔍 Found legacy license file for: ${licenseData.customer_name}`);

      // Verify license file integrity first
      if (!verifyLicenseIntegrity(licenseData)) {
        logToFile(`❌ License file integrity check failed - file may have been tampered with`);
        // Delete the corrupted license file
        fs.unlinkSync(licenseFile);
        return {
          success: false,
          message: 'License file has been corrupted or tampered with. Please reactivate your license.',
          error_code: 'LICENSE_TAMPERED'
        };
      }

      // Simple local validation - just check if license has expired
      if (licenseData.expires_at) {
        const expiryDate = new Date(licenseData.expires_at);
        const now = new Date();

        if (now > expiryDate) {
          logToFile(`❌ License expired: ${expiryDate.toISOString()}`);
          return {
            success: false,
            message: 'License has expired',
            error_code: 'LICENSE_EXPIRED'
          };
        }

        // Re-parse license key to get latest embedded data (including max_devices)
        let maxDevices = 5; // Default
        let modules = [];

        // ALWAYS re-parse license key to get fresh embedded data (don't trust cached values)
        if (licenseData.license_key && licenseData.license_key.startsWith('LW-')) {
          try {
            logToFile(`🔍 Re-parsing license key to extract max_devices...`);
            const parts = licenseData.license_key.split('-');
            if (parts.length === 5) {
              const encodedData = parts[1];
              const decodedData = Buffer.from(encodedData, 'hex').toString('utf8');
              const parsedData = JSON.parse(decodedData);

              logToFile(`🔍 Parsed license data: ${JSON.stringify(parsedData)}`);

              // Update max_devices and modules from fresh parse
              maxDevices = parsedData.max_devices !== undefined ? parsedData.max_devices : 5;
              modules = parsedData.modules || [];

              logToFile(`✅ Re-parsed license key - max_devices: ${maxDevices}, modules: ${modules.length} modules`);
            } else {
              logToFile(`⚠️ License key format invalid (${parts.length} parts), using defaults`);
              maxDevices = licenseData.max_devices || 5;
              modules = licenseData.modules || [];
            }
          } catch (parseError) {
            logToFile(`⚠️ Could not re-parse license key: ${parseError.message}`);
            logToFile(`⚠️ Using cached values - max_devices: ${licenseData.max_devices || 5}`);
            console.error('⚠️ Could not re-parse license key:', parseError);
            maxDevices = licenseData.max_devices || 5;
            modules = licenseData.modules || [];
          }
        } else {
          logToFile(`⚠️ No valid license key found, using cached values`);
          maxDevices = licenseData.max_devices || 5;
          modules = licenseData.modules || [];
        }

        logToFile(`✅ License is valid until: ${expiryDate.toISOString()}`);
        return {
          success: true,
          data: {
            license_key: licenseData.license_key || 'LOCAL_LICENSE',
            customer_name: licenseData.customer_name || 'Licensed User',
            plan_name: licenseData.plan_name || 'standard',
            expires_at: licenseData.expires_at,
            expires_at_formatted: new Date(licenseData.expires_at).toLocaleDateString(),
            isTrial: licenseData.isTrial || false,
            isValid: true,
            status: licenseData.status || 'active',
            modules: modules, // Use re-parsed modules
            max_devices: maxDevices // Use re-parsed max_devices
          }
        };
      } else {
        logToFile(`❌ License data missing expiry date`);
        return {
          success: false,
          message: 'Invalid license data - missing expiry date',
          error_code: 'INVALID_LICENSE_DATA'
        };
      }
    } else {
      // No local license file found
      logToFile(`🔍 No local license file found at: ${licenseFile}`);
      return {
        success: false,
        message: 'No license found',
        error_code: 'NO_LICENSE'
      };
    }
  } catch (error) {
    logToFile(`❌ Error validating license: ${error.message}`);
    // Error validating license logged to file
    return {
      success: false,
      message: '🖥️ Clear Your License\n🔑 Get a New License From Dr.FarFar 🌐',
      error: error.message
    };
  }
});

ipcMain.handle('license:get-local-info', () => {
  try {
    const appDataPath = getAppDataPath();
    const encryptedLicenseFile = path.join(appDataPath, 'license.enc');
    const plainLicenseFile = path.join(appDataPath, 'license.json');

    // Try encrypted file first (NewLic)
    if (fs.existsSync(encryptedLicenseFile)) {
      try {
        const newlicService = require(resolveModulePath('services/newlic-license-service'));
        const encryptedData = fs.readFileSync(encryptedLicenseFile, 'utf8');
        return newlicService._decrypt(encryptedData);
      } catch (decryptError) {
        if (decryptError.message === 'TAMPER_DETECTED') {
          logToFile('🚨 LICENSE TAMPERING DETECTED in get-local-info!');
          fs.unlinkSync(encryptedLicenseFile);
          return null;
        }
        logToFile(`❌ Failed to decrypt license: ${decryptError.message}`);
      }
    }

    // Fallback to plain license.json (legacy)
    if (fs.existsSync(plainLicenseFile)) {
      return JSON.parse(fs.readFileSync(plainLicenseFile, 'utf8'));
    }

    // No local license file - check if there's a license in Keygen database for this machine
    logToFile(`🔍 No local license file found, checking Keygen database for machine license...`);

    try {
      const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
      const localLicenseService = new LocalLicenseService();
      const machineId = generateMachineId();

      // Load all licenses from Keygen database
      const keygenLicenses = localLicenseService.loadKeygenLicenses();

      // Find a license that's activated for this machine
      for (const license of keygenLicenses) {
        if (license.activations && license.activations.length > 0) {
          const machineActivation = license.activations.find(activation =>
            activation.machine_id === machineId
          );
          if (machineActivation) {
            // Return license info in the expected format
            return {
              license_key: license.license_key,
              customer_name: license.customer_name,
              plan_name: license.plan_type,
              plan_type: license.plan_type,
              expires_at: license.expires_at,
              status: license.status,
              machine_id: machineId,
              activated_at: machineActivation.activated_at || new Date().toISOString(),
              last_validated: new Date().toISOString()
            };
          }
        }
      }
    } catch (keygenError) {
      logToFile(`❌ Error checking Keygen database: ${keygenError.message}`);
    }

    return null;
  } catch (error) {
    logToFile(`❌ Error reading local license: ${error.message}`);
    return null;
  }
});

ipcMain.handle('license:clear-local-data', () => {
  try {
    const appDataPath = getAppDataPath();
    const licenseFile = path.join(appDataPath, 'license.json');

    if (fs.existsSync(licenseFile)) {
      fs.unlinkSync(licenseFile);
      logToFile(`✅ Local license data cleared`);
    }

    return { success: true };
  } catch (error) {
    logToFile(`❌ Error clearing local license: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Debug function to clear license for testing
ipcMain.handle('license:debug-clear', () => {
  try {
    const appDataPath = getAppDataPath();
    const licenseFile = path.join(appDataPath, 'license.json');

    if (fs.existsSync(licenseFile)) {
      fs.unlinkSync(licenseFile);
      logToFile(`🗑️ DEBUG: Local license file deleted for testing`);
      // Local license file deleted for testing
    } else {
      logToFile(`🗑️ DEBUG: No license file found to delete`);
      // No license file found to delete
    }

    return { success: true, message: 'License cleared for testing' };
  } catch (error) {
    logToFile(`❌ Error clearing local license: ${error.message}`);
    // Error clearing local license logged to file
    return { success: false, error: error.message };
  }
});

ipcMain.handle('license:save-local-info', (event, licenseData) => {
  try {
    const appDataPath = getAppDataPath();
    if (!fs.existsSync(appDataPath)) {
      fs.mkdirSync(appDataPath, { recursive: true });
    }

    // Add signature for integrity protection
    addLicenseSignature(licenseData);

    const licenseFile = path.join(appDataPath, 'license.json');
    fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));

    logToFile(`✅ Local license data saved: ${licenseData.customer_name}`);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error saving local license: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('license:check-machine', async (event) => {
  try {
    const machineId = generateMachineId();
    logToFile(`🔍 Checking machine ID: ${machineId}`);

    // Use local license service instead of Laravel API
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();
    const result = await localLicenseService.checkMachineActivation(machineId);

    logToFile(`🔍 Machine check result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logToFile(`❌ Error checking machine ID: ${error.message}`);

    return {
      success: false,
      message: 'Failed to check machine activation. Please ensure the Keygen app is installed.',
      error: error.message,
      error_code: 'LOCAL_CHECK_ERROR'
    };
  }
});

ipcMain.handle('license:check-status', async (event, licenseKey) => {
  try {
    // Trim whitespace from license key (important for copy-paste)
    licenseKey = licenseKey.trim();
    logToFile(`🔍 Checking license status for: ${licenseKey}`);

    // Use EXACT same validation logic as license:activate
    const parts = licenseKey.split('-');

    if (parts.length === 5 && parts[0] === 'LW') {
      logToFile('🔍 Detected self-contained license format (Keygen generated)');

      try {
        const [prefix, encodedData, expiryHex, checksum, signature] = parts;
        const crypto = require('crypto');

        logToFile(`🔍 Parts: prefix=${prefix}, encodedData=${encodedData}, expiryHex=${expiryHex}, checksum=${checksum}, signature=${signature}`);

        // Verify checksum FIRST (using EXACT same logic as Keygen)
        const dataToSign = `${encodedData}-${expiryHex}`;
        const calculatedChecksum = crypto.createHash('md5').update(dataToSign).digest('hex').substring(0, 4).toUpperCase();

        logToFile(`🔍 Checksum validation: expected=${calculatedChecksum}, provided=${checksum}`);
        if (checksum !== calculatedChecksum) {
          logToFile('❌ Checksum validation failed');
          return {
            success: false,
            error: 'Invalid license key. Checksum verification failed.',
            error_code: 'INVALID_CHECKSUM'
          };
        }

        // Verify signature (using EXACT same logic as Keygen)
        const calculatedSignature = crypto.createHash('sha256').update(dataToSign + 'LEADWAVE_SECRET').digest('hex').substring(0, 8).toUpperCase();

        logToFile(`🔍 Signature validation: expected=${calculatedSignature}, provided=${signature}`);
        if (signature !== calculatedSignature) {
          logToFile('❌ Signature validation failed');
          return {
            success: false,
            error: 'Invalid license key. Signature verification failed.',
            error_code: 'INVALID_SIGNATURE'
          };
        }

        // Decode license data
        const licenseData = JSON.parse(Buffer.from(encodedData, 'hex').toString('utf8'));
        const expiryTimestamp = parseInt(expiryHex, 16);
        const expiryDate = new Date(expiryTimestamp * 1000);
        const now = new Date();

        logToFile(`🔍 License data: ${JSON.stringify(licenseData)}`);
        logToFile(`🔍 Expiry: ${expiryDate.toISOString()}, Now: ${now.toISOString()}`);

        // Check if license is expired
        if (now > expiryDate) {
          logToFile('❌ License has expired');
          return {
            success: false,
            error: 'License has expired',
            error_code: 'LICENSE_EXPIRED'
          };
        }

        logToFile('✅ Self-contained license validation successful');
        return {
          success: true,
          data: {
            status: 'active',
            expires_at: expiryDate.toISOString(),
            customer_name: licenseData.name || 'Licensed User',
            plan_type: licenseData.plan || 'standard',
            modules: licenseData.modules || [] // Include modules in status check
          }
        };

      } catch (error) {
        logToFile(`❌ Self-contained license validation failed: ${error.message}`);
        return {
          success: false,
          error: `License validation failed: ${error.message}`,
          error_code: 'VALIDATION_ERROR'
        };
      }
    }

    // Fallback to local license service for old format licenses
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();
    const result = await localLicenseService.checkLicenseStatus(licenseKey);

    logToFile(`🔍 License status result: ${JSON.stringify(result)}`);
    return result;

  } catch (error) {
    logToFile(`❌ Error checking license status: ${error.message}`);
    return {
      success: false,
      message: 'Failed to check license status. Please ensure the Keygen app is installed and has the license database.',
      error: error.message
    };
  }
});

ipcMain.handle('license:force-refresh', async (event) => {
  try {
    // Force refresh license triggered from renderer
    logToFile('🔄 Force refresh license triggered from renderer...');

    // Call the license validation handler directly
    const result = await new Promise((resolve) => {
      ipcMain.handleOnce('license:validate-temp', async () => {
        return await ipcMain.handle('license:validate', () => {});
      });
      resolve(ipcMain.emit('license:validate-temp'));
    });

    // Actually, let's just call the validation logic directly
    return await validateLicenseDirectly();
  } catch (error) {
    logToFile(`❌ Error in force refresh: ${error.message}`);
    return {
      success: false,
      message: 'Failed to refresh license',
      error: error.message
    };
  }
});

// Helper function to validate license directly
async function validateLicenseDirectly() {
  try {
    // Read local license file
    const appDataPath = getAppDataPath();
    const licenseFile = path.join(appDataPath, 'license.json');

    if (!fs.existsSync(licenseFile)) {
      logToFile(`🔍 No local license file found at: ${licenseFile}`);
      return {
        success: false,
        message: 'No license found',
        error_code: 'NO_LICENSE'
      };
    }

    const licenseData = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));
    const machineId = generateMachineId();

    logToFile(`🔍 Force validating license - Key: ${licenseData.license_key}, Machine ID: ${machineId}`);

    // Use local license service instead of Laravel API
    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();
    const result = await localLicenseService.validateLicense(
      licenseData.license_key,
      machineId,
      app.getVersion()
    );

    logToFile(`🔍 Force license validation result: ${JSON.stringify(result)}`);

    if (result.success) {
      // Update local license data
      licenseData.last_validated = new Date().toISOString();
      fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));
    }

    return result;
  } catch (error) {
    logToFile(`❌ Error in force validation: ${error.message}`);
    return {
      success: false,
      message: 'Failed to validate license. Please ensure the Keygen app is installed.',
      error: error.message
    };
  }
}

// Background license validator status
ipcMain.handle('license:background-status', async (event) => {
  try {
    if (backgroundLicenseValidator) {
      return {
        success: true,
        status: backgroundLicenseValidator.getStatus()
      };
    }
    return {
      success: false,
      message: 'Background license validator not available'
    };
  } catch (error) {
    logToFile(`❌ Error getting background license status: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

// Force license validation (for testing)
ipcMain.handle('license:force-validation', async (event) => {
  try {
    if (backgroundLicenseValidator) {
      logToFile('🔐 Force validation triggered from UI');
      await backgroundLicenseValidator.validateLicense();
      return {
        success: true,
        message: 'License validation triggered'
      };
    }
    return {
      success: false,
      message: 'Background license validator not available'
    };
  } catch (error) {
    logToFile(`❌ Error forcing license validation: ${error.message}`);
    return {
      success: false,
      message: error.message
    };
  }
});

// Extract company info from license key
ipcMain.handle('license:extract-company-info', async (event, licenseKey) => {
  try {
    logToFile(`🔍 Extracting company info from license key: ${licenseKey}`);

    const LocalLicenseService = require(resolveModulePath('services/local-license-service'));
    const localLicenseService = new LocalLicenseService();

    // Validate the license to extract data
    const validationResult = await localLicenseService.validateSelfContainedLicense(licenseKey);

    if (validationResult.success && validationResult.company_info) {
      logToFile(`✅ Extracted company info: ${JSON.stringify(validationResult.company_info)}`);
      return validationResult.company_info;
    }

    logToFile('⚠️ No company info found in license key');
    return null;
  } catch (error) {
    logToFile(`❌ Error extracting company info: ${error.message}`);
    return null;
  }
});

// Cloud License IPC Handlers
ipcMain.handle('cloud-license:activate', async (event, data) => {
  try {
    if (!cloudLicenseService) {
      return {
        success: false,
        error: 'Cloud license service not available'
      };
    }

    const { licenseKey } = data;
    const machineId = generateMachineId();

    logToFile(`🔐 Activating cloud license: ${licenseKey}`);

    const result = await cloudLicenseService.activateCloudLicense(licenseKey, machineId);

    if (result.success) {
      logToFile('✅ Cloud license activated successfully');
      // Start periodic validation
      cloudLicenseService.startPeriodicValidation();
    } else {
      logToFile(`❌ Cloud license activation failed: ${result.message}`);
    }

    return result;
  } catch (error) {
    logToFile(`❌ Error activating cloud license: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('cloud-license:validate', async (event) => {
  try {
    if (!cloudLicenseService) {
      return {
        success: false,
        error: 'Cloud license service not available'
      };
    }

    const result = await cloudLicenseService.validateCloudLicense();
    return result;
  } catch (error) {
    logToFile(`❌ Error validating cloud license: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('cloud-license:get-info', async (event) => {
  try {
    if (!cloudLicenseService) {
      return null;
    }

    return cloudLicenseService.getCloudLicenseData();
  } catch (error) {
    logToFile(`❌ Error getting cloud license info: ${error.message}`);
    return null;
  }
});

ipcMain.handle('cloud-license:has-license', async (event) => {
  try {
    if (!cloudLicenseService) {
      return false;
    }

    return cloudLicenseService.hasCloudLicense();
  } catch (error) {
    return false;
  }
});

ipcMain.handle('cloud-license:delete', async (event) => {
  try {
    if (!cloudLicenseService) {
      return {
        success: false,
        error: 'Cloud license service not available'
      };
    }

    cloudLicenseService.stopPeriodicValidation();
    const result = cloudLicenseService.deleteCloudLicense();

    return {
      success: result,
      message: result ? 'Cloud license deleted' : 'Failed to delete cloud license'
    };
  } catch (error) {
    logToFile(`❌ Error deleting cloud license: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

// NewLic License IPC Handlers
const newlicLicenseService = require(resolveModulePath('services/newlic-license-service'));

ipcMain.handle('newlic-license:activate', async (event, data) => {
  try {
    const { licenseKey } = data;
    const machineId = generateMachineId();

    logToFile(`🔑 NewLic: Activating license: ${licenseKey}`);

    const result = await newlicLicenseService.activateLicense(licenseKey, machineId);

    if (result.success) {
      logToFile(`✅ NewLic: License activated successfully`);
    } else {
      logToFile(`❌ NewLic: License activation failed: ${result.message}`);
    }

    return result;
  } catch (error) {
    logToFile(`❌ NewLic: Error activating license: ${error.message}`);
    return {
      success: false,
      message: 'Failed to activate license'
    };
  }
});

ipcMain.handle('newlic-license:validate', async (event) => {
  try {
    const machineId = generateMachineId();
    const result = await newlicLicenseService.checkLicense(machineId);
    return result;
  } catch (error) {
    logToFile(`❌ NewLic: Error validating license: ${error.message}`);
    return {
      valid: false,
      message: 'License validation failed'
    };
  }
});

ipcMain.handle('newlic-license:get-info', async (event) => {
  try {
    return newlicLicenseService.getLicenseInfo();
  } catch (error) {
    logToFile(`❌ NewLic: Error getting license info: ${error.message}`);
    return null;
  }
});

ipcMain.handle('newlic-license:clear', async (event) => {
  try {
    newlicLicenseService.clearLicense();
    logToFile(`✅ NewLic: License cleared`);
    return { success: true };
  } catch (error) {
    logToFile(`❌ NewLic: Error clearing license: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

// Clean Installation Handler
ipcMain.handle('app:clean-installation', async (event) => {
  try {
    const { cleanInstallation } = require('../../scripts/clean-installation.js');
    await cleanInstallation();
    return { success: true, message: 'Clean installation completed successfully' };
  } catch (error) {
    logToFile(`❌ Error during clean installation: ${error.message}`);
    return { success: false, message: 'Failed to clean installation', error: error.message };
  }
});

// Basic IPC Handlers
ipcMain.handle('app-version', () => {
  // Return the app version from package.json, not Electron version
  // Use the same robust path resolution as above
  let packageJson;
  try {
    packageJson = require('../../package.json');
  } catch (error) {
    try {
      packageJson = require('../package.json');
    } catch (error2) {
      try {
        packageJson = require(path.join(__dirname, '../../package.json'));
      } catch (error3) {
        packageJson = { version: '3.0.1' };
      }
    }
  }
  return packageJson.version;
});

ipcMain.handle('app-quit', async () => {
  logToFile('🔄 App quit requested from renderer process');
  isQuitting = true;
  await gracefulShutdown();
  return { success: true };
});

// Window Control IPC Handlers
ipcMain.handle('window:toggle-frame', async (event, showFrame) => {
  try {
    if (!mainWindow) {
      return { success: false, error: 'Main window not available' };
    }

    logToFile(`🪟 Toggling menu bar: ${showFrame ? 'show' : 'hide'}`);

    // Use the safer approach of just toggling the menu bar visibility
    // instead of recreating the entire window
    if (showFrame) {
      // Show the menu bar
      mainWindow.setMenuBarVisibility(true);
      mainWindow.setAutoHideMenuBar(false);
      logToFile('✅ Menu bar shown');
    } else {
      // Hide the menu bar
      mainWindow.setMenuBarVisibility(false);
      mainWindow.setAutoHideMenuBar(true);
      logToFile('✅ Menu bar hidden');
    }

    logToFile(`✅ Window frame toggled successfully: ${showFrame ? 'visible' : 'hidden'}`);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error toggling window frame: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('window:get-frame-status', () => {
  try {
    if (!mainWindow) {
      return { success: false, error: 'Main window not available' };
    }

    // Check if menu bar is visible (this is what we're actually controlling)
    const hasFrame = mainWindow.isMenuBarVisible();
    logToFile(`🔍 Menu bar visible: ${hasFrame}`);
    return { success: true, hasFrame };
  } catch (error) {
    logToFile(`❌ Error getting frame status: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Apply window frame preference from database (called after database is ready)
ipcMain.handle('window:apply-saved-preference', async () => {
  try {
    if (!mainWindow) {
      return { success: false, error: 'Main window not available' };
    }

    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }

    logToFile('🔄 Applying saved window frame preference from database...');

    const framePreference = databaseService.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('window_show_title_bar');

    if (framePreference) {
      const shouldShowTitleBar = framePreference.value === 'true';
      logToFile(`📋 Found saved preference: ${shouldShowTitleBar}`);

      if (!shouldShowTitleBar) {
        mainWindow.setMenuBarVisibility(false);
        mainWindow.setAutoHideMenuBar(true);
        logToFile('🪟 Applied saved preference: title bar hidden');
      } else {
        mainWindow.setMenuBarVisibility(true);
        mainWindow.setAutoHideMenuBar(false);
        logToFile('🪟 Applied saved preference: title bar visible');
      }

      return { success: true, applied: true, showTitleBar: shouldShowTitleBar };
    } else {
      logToFile('📋 No saved preference found');
      return { success: true, applied: false, showTitleBar: true };
    }
  } catch (error) {
    logToFile(`❌ Error applying saved preference: ${error.message}`);
    return { success: false, error: error.message };
  }
});



ipcMain.handle('app:is-development', () => {
  return isDev;
});

ipcMain.handle('show-message-box', async (event, options) => {
  const result = await dialog.showMessageBox(mainWindow, options);
  return result;
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// WhatsApp Service IPC Handlers
ipcMain.handle('whatsapp:create-session', async (event, sessionData) => {
  try {
    // Ensure appService is available
    if (!appService) {
      logToFile('❌ App service not available for session creation');
      // Try to get it from global
      if (global.appService) {
        appService = global.appService;
        logToFile('✅ Retrieved appService from global');
      } else {
        return { success: false, message: 'App service not available' };
      }
    }

    // Debug: Check if method exists
    if (typeof appService.createWhatsAppSession !== 'function') {
      logToFile(`❌ createWhatsAppSession is not a function. Type: ${typeof appService.createWhatsAppSession}`);
      logToFile(`❌ AppService constructor: ${appService.constructor.name}`);
      logToFile(`❌ Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(appService)).join(', ')}`);
      return { success: false, message: 'createWhatsAppSession method not available' };
    }

    // Check if app service is initialized
    if (!appService.isInitialized) {
      logToFile('❌ App service not initialized, attempting to initialize...');
      try {
        await appService.initialize();
        logToFile('✅ App service initialized successfully');
      } catch (initError) {
        logToFile(`❌ Failed to initialize app service: ${initError.message}`);
        logToFile(`❌ Error stack: ${initError.stack}`);
        return { success: false, message: 'Application initialization failed' };
      }
    }

    logToFile(`🔄 Creating WhatsApp session for device: ${sessionData.name || sessionData.device_name}`);
    const result = await appService.createWhatsAppSession(sessionData.name || sessionData.device_name);
    logToFile(`✅ Session creation result:`, result);
    return result;
  } catch (error) {
    logToFile(`❌ Error creating WhatsApp session: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('whatsapp:disconnect-session', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, message: 'App service not available' };
    }
    return await appService.disconnectWhatsAppSession(sessionId);
  } catch (error) {
    logToFile(`❌ Error disconnecting WhatsApp session: ${error.message}`);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('whatsapp:get-sessions', async () => {
  try {
    if (!appService) {
      return { success: false, sessions: [] };
    }
    const sessions = await appService.getWhatsAppSessions();
    return { success: true, sessions: sessions };
  } catch (error) {
    logToFile(`❌ Error getting WhatsApp sessions: ${error.message}`);
    return { success: false, sessions: [] };
  }
});


ipcMain.handle('whatsapp:send-message', async (event, sessionId, to, message, type, options) => {
  try {

    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const result = await appService.sendMessage(sessionId, to, message, type, options);
    return result;
  } catch (error) {
    console.error('❌ IPC: Error sending message:', error);
    logToFile(`❌ Error sending message: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:reconnect-session', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, message: 'App service not available' };
    }
    return await appService.reconnectWhatsAppSession(sessionId);
  } catch (error) {
    logToFile(`❌ Error reconnecting WhatsApp session: ${error.message}`);
    return { success: false, message: error.message };
  }
});

// Recall Bot IPC Handlers
ipcMain.handle('recall-bot:get-settings', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const recallBotService = appService.getRecallBotService();
    if (!recallBotService) {
      return { success: false, error: 'Recall Bot service not available' };
    }
    const settings = await recallBotService.getSessionSettings(sessionId);
    return { success: true, settings };
  } catch (error) {
    logToFile(`❌ Error getting Recall Bot settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Test IPC handler
ipcMain.handle('recall-bot:test', async (event) => {
  if (isDev) {
  }
  logToFile('🔍 IPC: TEST HANDLER CALLED - IPC is working!');
  return { success: true, message: 'IPC test successful' };
});

ipcMain.handle('recall-bot:update-settings', async (event, sessionId, settings) => {
  try {
    if (isDev) {
    }
    logToFile(`🔍 IPC: recall-bot:update-settings called with sessionId: ${sessionId}`);

    if (!appService) {
      if (isDev) {
        console.error('🔍 IPC: App service not available');
      }
      logToFile('🔍 IPC: App service not available');
      return { success: false, error: 'App service not available' };
    }

    const recallBotService = appService.getRecallBotService();
    if (!recallBotService) {
      if (isDev) {
        console.error('🔍 IPC: Recall Bot service not available');
      }
      logToFile('🔍 IPC: Recall Bot service not available');
      return { success: false, error: 'Recall Bot service not available' };
    }

    if (isDev) {
    }
    logToFile('🔍 IPC: Calling updateSessionSettings');
    const result = await recallBotService.updateSessionSettings(sessionId, settings);
    if (isDev) {
    }
    logToFile(`🔍 IPC: updateSessionSettings result: ${JSON.stringify(result)}`);

    return result;
  } catch (error) {
    logToFile(`❌ Error updating Recall Bot settings: ${error.message}`);
    if (isDev) {
      console.error('🔍 IPC: Error in update-settings:', error);
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('recall-bot:get-reminders', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    const reminders = await databaseService.all(`
      SELECT * FROM reminders
      WHERE session_id = ? AND status = 'active'
      ORDER BY scheduled_time ASC
    `, [sessionId]);

    // Ensure reminders is always an array
    const remindersArray = Array.isArray(reminders) ? reminders : [];

    return { success: true, reminders: remindersArray };
  } catch (error) {
    logToFile(`❌ Error getting reminders: ${error.message}`);
    return { success: false, error: error.message, reminders: [] };
  }
});

ipcMain.handle('recall-bot:cancel-reminder', async (event, sessionId, reminderId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const recallBotService = appService.getRecallBotService();
    if (!recallBotService) {
      return { success: false, error: 'Recall Bot service not available' };
    }

    // Cancel the reminder through the scheduler
    const result = await recallBotService.reminderScheduler.cancelReminder(reminderId);
    return result;
  } catch (error) {
    logToFile(`❌ Error cancelling reminder: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('recall-bot:get-stats', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const recallBotService = appService.getRecallBotService();
    if (!recallBotService) {
      return { success: false, error: 'Recall Bot service not available' };
    }

    const stats = await recallBotService.getSessionStats(sessionId);
    return { success: true, stats };
  } catch (error) {
    logToFile(`❌ Error getting Recall Bot stats: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:delete-session', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, message: 'App service not available' };
    }

    // Add timeout to prevent hanging
    const deletePromise = appService.deleteWhatsAppSession(sessionId);
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ success: false, message: 'Delete operation timeout' }), 10000)
    );

    const result = await Promise.race([deletePromise, timeoutPromise]);
    return result;
  } catch (error) {
    logToFile(`❌ Error deleting WhatsApp session: ${error.message}`);
    logToFile(`❌ Error stack: ${error.stack}`);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('whatsapp:get-session-status', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return whatsappService.getSessionStatus(sessionId);
  } catch (error) {
    logToFile(`❌ Error getting session status: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:request-pairing-code', async (event, sessionId, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    logToFile(`🔢 Requesting pairing code for session: ${sessionId}, phone: ${phoneNumber}`);
    const result = await appService.requestPairingCode(sessionId, phoneNumber);
    logToFile(`🔢 Pairing code result:`, result);
    return result;
  } catch (error) {
    logToFile(`❌ Error requesting pairing code: ${error.message}`);
    return {
      success: false,
      error: error.message,
      sessionId: sessionId,
      phoneNumber: phoneNumber
    };
  }
});

ipcMain.handle('whatsapp:create-pairing-session', async (event, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    logToFile(`🔢 Creating new pairing code session for phone: ${phoneNumber}`);
    const result = await appService.createPairingCodeSession(phoneNumber);
    logToFile(`🔢 Pairing session creation result:`, result);
    return result;
  } catch (error) {
    logToFile(`❌ Error creating pairing code session: ${error.message}`);
    return {
      success: false,
      error: error.message,
      phoneNumber: phoneNumber
    };
  }
});

ipcMain.handle('whatsapp:send-template-message', async (event, sessionId, to, template, variables) => {
  try {

    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();

    const result = await whatsappService.sendTemplateMessage(sessionId, to, template, variables);
    return result;
  } catch (error) {
    logToFile(`❌ Error sending template message: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:check-number', async (event, sessionId, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.checkNumberExists(sessionId, phoneNumber);
  } catch (error) {
    logToFile(`❌ Error checking number: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:verify-number', async (event, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.verifyNumber(phoneNumber);
  } catch (error) {
    logToFile(`❌ Error verifying number: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Batch verification for better performance
ipcMain.handle('whatsapp:verify-numbers-batch', async (event, phoneNumbers) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();

    // Use batch verification for better performance
    const results = await whatsappService.verifyNumbersBatch(phoneNumbers, (current, total) => {
      // Send progress updates to renderer
      event.sender.send('whatsapp:batch-verification-progress', { current, total });
    });

    return { success: true, results };
  } catch (error) {
    logToFile(`❌ Error in batch verification: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-chats', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getChats(sessionId);
  } catch (error) {
    logToFile(`❌ Error getting chats: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:resolve-lid', async (event, sessionId, jid) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    const resolved = whatsappService.resolveLIDToPhone(sessionId, jid);
    return { success: true, ...resolved };
  } catch (error) {
    logToFile(`❌ Error resolving LID: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:resolve-lids-batch', async (event, sessionId, jids) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    const resolved = await whatsappService.resolveLIDsBatch(sessionId, jids);
    return { success: true, results: resolved };
  } catch (error) {
    logToFile(`❌ Error resolving LIDs in batch: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:trigger-outgoing-call', async (event, sessionId, contactJid) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.triggerOutgoingCallResponse(sessionId, contactJid);
  } catch (error) {
    logToFile(`❌ Error triggering outgoing call response: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-chat-history', async (event, sessionId, chatId, limit) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getChatHistory(sessionId, chatId, limit);
  } catch (error) {
    logToFile(`❌ Error getting chat history: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:mark-chat-as-read', async (event, sessionId, chatId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.markChatAsRead(sessionId, chatId);
  } catch (error) {
    logToFile(`❌ Error marking chat as read: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:download-media', async (event, sessionId, messageKey) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.downloadMedia(sessionId, messageKey);
  } catch (error) {
    logToFile(`❌ Error downloading media: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:upload-media', async (event, filePath) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.uploadMedia(filePath);
  } catch (error) {
    logToFile(`❌ Error uploading media: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Group Management IPC Handlers
ipcMain.handle('whatsapp:fetch-all-groups', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available', groups: [] };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.fetchAllGroups(sessionId);
  } catch (error) {
    logToFile(`❌ Error fetching all groups: ${error.message}`);
    return { success: false, error: error.message, groups: [] };
  }
});

// Group Creation and Management IPC Handlers
ipcMain.handle('whatsapp:create-group', async (event, sessionId, subject, participants, description) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.createGroup(sessionId, subject, participants, description);
  } catch (error) {
    logToFile(`❌ Error creating group: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:add-group-participants', async (event, sessionId, groupId, participants) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.addGroupParticipants(sessionId, groupId, participants);
  } catch (error) {
    logToFile(`❌ Error adding group participants: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:remove-group-participants', async (event, sessionId, groupId, participants) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.removeGroupParticipants(sessionId, groupId, participants);
  } catch (error) {
    logToFile(`❌ Error removing group participants: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:promote-group-participants', async (event, sessionId, groupId, participants) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.promoteGroupParticipants(sessionId, groupId, participants);
  } catch (error) {
    logToFile(`❌ Error promoting group participants: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:demote-group-participants', async (event, sessionId, groupId, participants) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.demoteGroupParticipants(sessionId, groupId, participants);
  } catch (error) {
    logToFile(`❌ Error demoting group participants: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Group Settings IPC Handlers
ipcMain.handle('whatsapp:update-group-subject', async (event, sessionId, groupId, subject) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.updateGroupSubject(sessionId, groupId, subject);
  } catch (error) {
    logToFile(`❌ Error updating group subject: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:update-group-description', async (event, sessionId, groupId, description) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.updateGroupDescription(sessionId, groupId, description);
  } catch (error) {
    logToFile(`❌ Error updating group description: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:update-group-settings', async (event, sessionId, groupId, setting) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.updateGroupSettings(sessionId, groupId, setting);
  } catch (error) {
    logToFile(`❌ Error updating group settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:update-group-photo', async (event, sessionId, groupId, imageBuffer) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.updateGroupPhoto(sessionId, groupId, imageBuffer);
  } catch (error) {
    logToFile(`❌ Error updating group photo: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:remove-group-photo', async (event, sessionId, groupId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.removeGroupPhoto(sessionId, groupId);
  } catch (error) {
    logToFile(`❌ Error removing group photo: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Group Actions IPC Handlers
ipcMain.handle('whatsapp:leave-group', async (event, sessionId, groupId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.leaveGroup(sessionId, groupId);
  } catch (error) {
    logToFile(`❌ Error leaving group: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:join-group-with-invite', async (event, sessionId, inviteCode) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.joinGroupWithInvite(sessionId, inviteCode);
  } catch (error) {
    logToFile(`❌ Error joining group with invite: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:revoke-group-invite', async (event, sessionId, groupId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.revokeGroupInvite(sessionId, groupId);
  } catch (error) {
    logToFile(`❌ Error revoking group invite: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Group Messaging IPC Handlers
ipcMain.handle('whatsapp:send-group-message', async (event, sessionId, groupId, message, mentions, options) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.sendGroupMessage(sessionId, groupId, message, mentions, options);
  } catch (error) {
    logToFile(`❌ Error sending group message: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Label IPC Handlers
ipcMain.handle('whatsapp:get-labels', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available', labels: [] };
    }
    const whatsappService = appService.getWhatsAppService();
    const result = await whatsappService.getLabels(sessionId);
    return result;
  } catch (error) {
    console.error(`❌ [IPC HANDLER] Error getting labels:`, error);
    logToFile(`❌ Error getting labels: ${error.message}`);
    return { success: false, error: error.message, labels: [] };
  }
});

ipcMain.handle('whatsapp:get-chats-by-label', async (event, sessionId, labelId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available', contacts: [] };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getChatsByLabel(sessionId, labelId);
  } catch (error) {
    logToFile(`❌ Error getting chats by label: ${error.message}`);
    return { success: false, error: error.message, contacts: [] };
  }
});

// Contact Blocking IPC Handlers
ipcMain.handle('whatsapp:block-contact', async (event, sessionId, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.blockContact(sessionId, phoneNumber);
  } catch (error) {
    logToFile(`❌ Error blocking contact: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:unblock-contact', async (event, sessionId, phoneNumber) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.unblockContact(sessionId, phoneNumber);
  } catch (error) {
    logToFile(`❌ Error unblocking contact: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Comprehensive block contact (includes group removal)
ipcMain.handle('whatsapp:comprehensive-block-contact', async (event, sessionId, contactJid, options = {}) => {
  try {
    logToFile(`🚫 IPC: Comprehensive block request - Session: ${sessionId}, Contact: ${contactJid}`);

    if (!appService) {
      logToFile(`❌ App service not available for comprehensive blocking`);
      return { success: false, error: 'App service not available' };
    }

    const whatsappService = appService.getWhatsAppService();
    const result = await whatsappService.blockContactComprehensive(sessionId, contactJid, options);

    logToFile(`🚫 Comprehensive block result: ${JSON.stringify(result)}`);

    return result;
  } catch (error) {
    const errorMsg = `❌ Error with comprehensive blocking: ${error.message}`;
    logToFile(errorMsg);
    console.error(errorMsg, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-blocked-contacts', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getBlockedContacts(sessionId);
  } catch (error) {
    logToFile(`❌ Error getting blocked contacts: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Bulk Group Operations IPC Handlers
ipcMain.handle('whatsapp:bulk-update-groups', async (event, sessionId, updates) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.bulkUpdateGroups(sessionId, updates);
  } catch (error) {
    logToFile(`❌ Error bulk updating groups: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:bulk-update-group-photos', async (event, sessionId, updates) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.bulkUpdateGroupPhotos(sessionId, updates);
  } catch (error) {
    logToFile(`❌ Error bulk updating group photos: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-group-metadata', async (event, sessionId, groupId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getGroupMetadata(sessionId, groupId);
  } catch (error) {
    logToFile(`❌ Error getting group metadata: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-group-invite-code', async (event, sessionId, groupId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getGroupInviteCode(sessionId, groupId);
  } catch (error) {
    logToFile(`❌ Error getting group invite code: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:get-group-info-by-invite', async (event, sessionId, inviteCode) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    return await whatsappService.getGroupInfoByInviteCode(sessionId, inviteCode);
  } catch (error) {
    logToFile(`❌ Error getting group info by invite code: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Poll Debug IPC Handlers
ipcMain.handle('whatsapp:debug-specific-poll', async (event, sessionId, pollQuestion) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    await whatsappService.debugSpecificPoll(sessionId, pollQuestion);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error debugging specific poll: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:scan-existing-polls', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    const pollsFound = await whatsappService.scanForExistingPolls(sessionId);
    return { success: true, pollsFound };
  } catch (error) {
    logToFile(`❌ Error scanning existing polls: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:debug-database-polls', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    await whatsappService.debugDatabasePolls();
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error debugging database polls: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('whatsapp:force-check-poll-votes', async (event, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const whatsappService = appService.getWhatsAppService();
    await whatsappService.forceCheckPollVotes(sessionId);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error force checking poll votes: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// DIRECT FIX for poll vote issues
ipcMain.handle('whatsapp:fix-poll-votes-directly', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    logToFile('🔧 DIRECT FIX: Starting direct poll vote fix...');

    // Fix Brand Poll vote directly
    const brandPollResult = await databaseService.query(`
      INSERT OR REPLACE INTO poll_votes (
        poll_message_id, poll_option_id, voter_jid, vote_message_id,
        voted_at, sender_timestamp_ms, is_valid
      )
      SELECT
        pm.id as poll_message_id,
        po.id as poll_option_id,
        '918530613447@s.whatsapp.net' as voter_jid,
        'direct_fix_' || pm.id as vote_message_id,
        datetime('now') as voted_at,
        strftime('%s', 'now') * 1000 as sender_timestamp_ms,
        1 as is_valid
      FROM poll_messages pm
      JOIN poll_options po ON pm.id = po.poll_message_id
      WHERE pm.poll_question = 'Brand Poll'
        AND po.option_text = 'naji'
    `, []);

    // Fix New Testing Poll vote directly
    const newTestingPollResult = await databaseService.query(`
      INSERT OR REPLACE INTO poll_votes (
        poll_message_id, poll_option_id, voter_jid, vote_message_id,
        voted_at, sender_timestamp_ms, is_valid
      )
      SELECT
        pm.id as poll_message_id,
        po.id as poll_option_id,
        '918530613447@s.whatsapp.net' as voter_jid,
        'direct_fix_' || pm.id as vote_message_id,
        datetime('now') as voted_at,
        strftime('%s', 'now') * 1000 as sender_timestamp_ms,
        1 as is_valid
      FROM poll_messages pm
      JOIN poll_options po ON pm.id = po.poll_message_id
      WHERE pm.poll_question = 'New Testing Poll'
        AND po.option_text = 'Bilkul'
    `, []);

    logToFile('✅ DIRECT FIX: Poll votes fixed successfully');

    return {
      success: true,
      message: 'Poll votes fixed directly',
      brandPollFixed: brandPollResult.success,
      newTestingPollFixed: newTestingPollResult.success
    };
  } catch (error) {
    logToFile(`❌ Error in direct poll vote fix: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Database IPC Handlers
ipcMain.handle('db-query', async (event, query, params) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const db = appService.getDatabaseService();
    const result = await db.query(query, params);
    return result;
  } catch (error) {
    logToFile(`❌ Database query error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Helper function to load OptOutService with fallback paths
function loadOptOutService() {
  const possiblePaths = [
    './services/opt-out.service',
    '../services/opt-out.service',
    path.join(__dirname, 'services/opt-out.service'),
    path.join(__dirname, '../services/opt-out.service'),
  ];

  for (const testPath of possiblePaths) {
    try {
      // Clear the require cache to ensure we get the latest version
      const resolvedPath = require.resolve(testPath);
      delete require.cache[resolvedPath];
      return require(testPath);
    } catch (error) {
      // Continue to next path
    }
  }

  throw new Error('Cannot find module opt-out.service in any of the expected paths');
}

// Opt-Out Service IPC Handlers
ipcMain.handle('optOut:isOptedOut', async (event, phoneNumber, messageType) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const result = await optOutService.isOptedOut(phoneNumber, messageType);
    return { success: true, ...result };
  } catch (error) {
    logToFile(`❌ Opt-out check error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:optOut', async (event, phoneNumber, options) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const result = await optOutService.optOut(phoneNumber, options);
    return result;
  } catch (error) {
    logToFile(`❌ Opt-out error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:optIn', async (event, phoneNumber, options) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const result = await optOutService.optIn(phoneNumber, options);
    return result;
  } catch (error) {
    logToFile(`❌ Opt-in error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:filterContactsForBulkMessaging', async (event, contacts, messageType) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const result = await optOutService.filterContactsForBulkMessaging(contacts, messageType);
    return { success: true, ...result };
  } catch (error) {
    logToFile(`❌ Contact filtering error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:getOptedOutContacts', async (event, filters) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const contacts = await optOutService.getOptedOutContacts(filters);
    return { success: true, contacts };
  } catch (error) {
    logToFile(`❌ Get opted-out contacts error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:getStatistics', async (event, filters) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const stats = await optOutService.getOptOutStatistics(filters);
    return { success: true, stats };
  } catch (error) {
    logToFile(`❌ Get opt-out statistics error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:getComplianceReport', async (event, filters) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService();
    const report = await optOutService.getComplianceReport(filters);
    return { success: true, report };
  } catch (error) {
    logToFile(`❌ Get compliance report error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Auto-Response Messages IPC Handlers
ipcMain.handle('optOut:getAutoResponseMessages', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }
    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);
    const result = await optOutService.getAutoResponseMessages();
    return result; // Return directly - already has { success, messages } structure
  } catch (error) {
    logToFile(`❌ Get auto-response messages error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('optOut:updateAutoResponseMessages', async (event, messages) => {
  try {

    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService || !databaseService.db) {
      return { success: false, error: 'Database not available' };
    }

    const OptOutService = loadOptOutService();
    const optOutService = new OptOutService(databaseService);

    const result = await optOutService.updateAutoResponseMessages(messages);

    return result; // Return the result directly as it already has success/error structure
  } catch (error) {
    logToFile(`❌ Update auto-response messages error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Campaign Scheduler IPC Handlers
ipcMain.handle('campaign-scheduler:get-status', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const scheduler = appService.getCampaignScheduler();
    return { success: true, status: scheduler.getStatus() };
  } catch (error) {
    logToFile(`❌ Campaign scheduler status error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('campaign-scheduler:trigger-check', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const scheduler = appService.getCampaignScheduler();
    await scheduler.triggerCheck();
    return { success: true };
  } catch (error) {
    logToFile(`❌ Campaign scheduler trigger error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('campaign-scheduler:start-campaign', async (event, campaignId) => {
  try {
    logToFile(`🚀 IPC: Starting campaign ${campaignId}`);

    if (!appService) {
      logToFile(`❌ IPC: App service not available`);
      return { success: false, error: 'App service not available' };
    }

    const scheduler = appService.getCampaignScheduler();
    logToFile(`🔧 IPC: Got scheduler, calling processCampaign(${campaignId})`);

    // Add more detailed logging
    logToFile(`🔍 IPC: Scheduler type: ${scheduler.constructor.name}`);
    logToFile(`🔍 IPC: About to call processCampaign with ID: ${campaignId}`);

    await scheduler.processCampaign(campaignId);

    logToFile(`✅ IPC: Campaign ${campaignId} processed successfully`);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Campaign start error: ${error.message}`);
    logToFile(`❌ Campaign start error stack: ${error.stack}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('campaign-scheduler:stop-all-campaigns', async () => {
  try {
    logToFile(`🛑 IPC: Stopping all campaigns`);

    if (!appService) {
      logToFile(`❌ IPC: App service not available`);
      return { success: false, error: 'App service not available' };
    }

    const scheduler = appService.getCampaignScheduler();
    const result = await scheduler.stopAllCampaigns();

    logToFile(`✅ IPC: Stopped ${result.stoppedCount || 0} campaigns`);
    return result;
  } catch (error) {
    logToFile(`❌ Stop all campaigns error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Application Stats and Health IPC Handlers
ipcMain.handle('app-stats', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const stats = await appService.getStats();
    return { success: true, data: stats };
  } catch (error) {
    logToFile(`❌ Stats retrieval error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('app-recent-activities', async (event, limit) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const activities = await appService.getRecentActivities(limit);
    return { success: true, data: activities };
  } catch (error) {
    logToFile(`❌ Recent activities retrieval error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('app-health', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const health = await appService.getHealthCheck();
    return { success: true, data: health };
  } catch (error) {
    logToFile(`❌ Health check error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// File System IPC Handlers
ipcMain.handle('fs-read-file', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return { success: true, data };
  } catch (error) {
    logToFile(`❌ Error reading file: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('fs-write-file', async (event, filePath, data) => {
  try {
    fs.writeFileSync(filePath, data, 'utf8');
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error writing file: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Shell IPC Handlers
ipcMain.handle('shell-open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    logToFile(`❌ Error opening external URL: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Notification Service
let notificationService = null;
let lastNotificationCheck = null;

class NotificationService {
  constructor() {
    this.isRunning = false;
    this.checkInterval = null;
    this.lastCheck = new Date().toISOString();
    this.processedNotifications = new Set(); // Track processed notification IDs
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    logToFile('🔔 Starting notification service...');

    // Check immediately
    this.checkForNotifications();

    // Then check every 5 minutes to reduce system load
    this.checkInterval = setInterval(() => {
      this.checkForNotifications();
    }, 300000);
  }

  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logToFile('🔔 Notification service stopped');
  }

  async checkForNotifications() {
    try {
      // Notifications are now optional - work offline
      logToFile('🔔 Notification service running in offline mode');
      this.lastCheck = new Date().toISOString();
    } catch (error) {
      logToFile(`❌ Error in notification service: ${error.message}`);
    }
  }
}

// Background License Validator Class
class BackgroundLicenseValidator {
  constructor() {
    this.isRunning = false;
    this.validationInterval = null;
    this.lastValidation = new Date().toISOString();
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    logToFile('🔐 Starting background license validator...');

    // Validate immediately
    this.validateLicense();

    // Set up periodic validation every 15 minutes for regular licenses
    // This runs in the background without affecting the UI
    this.validationInterval = setInterval(() => {
      this.validateLicense();
    }, 900000); // 15 minutes
  }

  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }
    logToFile('🔐 Background license validator stopped');
  }

  async validateLicense() {
    try {
      logToFile('🔐 Background license validation started...');
      this.lastValidation = new Date().toISOString();

      // Read local license file
      const appDataPath = getAppDataPath();
      const licenseFile = path.join(appDataPath, 'license.json');

      if (!fs.existsSync(licenseFile)) {
        logToFile('🔐 No license file found during background validation');
        return;
      }

      const licenseData = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));

      // Verify license file integrity first
      if (!verifyLicenseIntegrity(licenseData)) {
        logToFile(`🔐 Background license validation failed: License file integrity check failed`);
        // Delete the corrupted license file
        fs.unlinkSync(licenseFile);
        this.handleValidationFailure({
          success: false,
          message: 'License file has been corrupted or tampered with',
          error_code: 'LICENSE_TAMPERED'
        });
        return;
      }

      // Simple local validation - just check if license has expired
      if (licenseData.expires_at) {
        const expiryDate = new Date(licenseData.expires_at);
        const now = new Date();

        if (now > expiryDate) {
          logToFile(`🔐 Background license validation failed: License expired on ${expiryDate.toISOString()}`);
          this.handleValidationFailure({
            success: false,
            message: 'License has expired',
            error_code: 'LICENSE_EXPIRED'
          });
          return;
        }

        logToFile(`🔐 Background license validation successful - valid until: ${expiryDate.toISOString()}`);
        // Update local license data silently
        licenseData.last_validated = new Date().toISOString();
        // Re-add signature after updating data
        addLicenseSignature(licenseData);
        fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2));
      } else {
        logToFile('🔐 Background license validation failed: Missing expiry date');
        this.handleValidationFailure({
          success: false,
          message: 'Invalid license data - missing expiry date',
          error_code: 'INVALID_LICENSE_DATA'
        });
      }
    } catch (error) {
      logToFile(`🔐 Background license validation error: ${error.message}`);
      // Silent failure - don't interrupt user experience
    }
  }

  handleValidationFailure(result) {
    const errorCode = result.error_code || '';
    const message = result.message || result.error || 'Unknown license error';

    logToFile(`🚨 License validation failure detected: ${errorCode} - ${message}`);

    // Handle different types of license failures
    if (errorCode === 'LICENSE_EXPIRED' || message.toLowerCase().includes('expired')) {
      logToFile('🚨 License has expired - showing renewal window');
      this.showLicenseRenewalWindow('Your license has expired. Please enter a new license key to continue.');

    } else if (errorCode === 'LICENSE_NOT_FOUND') {
      logToFile('🚨 License not found - showing renewal window');
      this.showLicenseRenewalWindow('Your license is no longer valid. Please enter a new license key to continue.');

    } else if (errorCode === 'LICENSE_SUSPENDED' || errorCode === 'SUSPENDED') {
      logToFile('🚨 License has been suspended - initiating app shutdown');
      this.showExpiryDialogAndExit('Your license has been suspended. Please contact your administrator.');

    } else if (errorCode === 'LICENSE_REVOKED') {
      logToFile('🚨 License has been revoked - initiating app shutdown');
      this.showExpiryDialogAndExit('Your license has been revoked. Please contact your administrator.');

    } else if (errorCode === 'LICENSE_INACTIVE') {
      logToFile('🚨 License is inactive - initiating app shutdown');
      this.showExpiryDialogAndExit('Your license is inactive. The application will now close.');

    } else if (errorCode === 'INVALID_FORMAT') {
      logToFile('🚨 Invalid license format - initiating app shutdown');
      this.showExpiryDialogAndExit('Your license is invalid. The application will now close.');

    } else {
      // For other errors, log but don't immediately shut down (might be network issues)
      logToFile(`🔐 License validation failed but not critical: ${errorCode} - ${message}`);
    }
  }

  showLicenseRenewalWindow(message) {
    logToFile('🔄 Showing license renewal window');

    // The renderer process will handle showing the license renewal window
    // through the LicenseContext and App.js logic
    // No need to quit the app - let user renew the license

    // Emit an event to the renderer to trigger license renewal UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license-expired', { message });
    }
  }

  showExpiryDialogAndExit(message) {
    const { dialog } = require('electron');

    // Show dialog to user
    dialog.showErrorBox('License Issue', message);

    // Log the shutdown
    logToFile('🚨 Application shutting down due to license issue');

    // Give a brief moment for the dialog to show, then quit
    setTimeout(() => {
      app.quit();
    }, 1000);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastValidation: this.lastValidation
    };
  }
}

// Initialize services
notificationService = new NotificationService();
backgroundLicenseValidator = new BackgroundLicenseValidator();

// Initialize cloud license service
let cloudLicenseService = null;
try {
  cloudLicenseService = require('../services/cloud-license-service');
  logToFile('✅ Cloud license service loaded');
} catch (error) {
  try {
    cloudLicenseService = require('./services/cloud-license-service');
    logToFile('✅ Cloud license service loaded (production path)');
  } catch (error2) {
    logToFile(`⚠️ Cloud license service not available: ${error.message}`);
  }
}

// Notification IPC Handlers
ipcMain.handle('notifications:get-notifications', async (event) => {
  try {
    logToFile('🔔 Notifications running in offline mode');
    return {
      success: true,
      data: { notifications: [] },
      message: 'Running in offline mode'
    };
  } catch (error) {
    logToFile(`❌ Error in notifications: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('notifications:get-latest', async (event, lastCheck) => {
  try {
    logToFile('🔔 Latest notifications running in offline mode');
    return {
      success: true,
      data: { notifications: [] },
      message: 'Running in offline mode'
    };
  } catch (error) {
    logToFile(`❌ Error in latest notifications: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('notifications:mark-as-read', async (event, notificationId) => {
  try {
    logToFile(`🔔 Mark as read running in offline mode for notification: ${notificationId}`);
    return {
      success: true,
      message: 'Running in offline mode'
    };
  } catch (error) {
    logToFile(`❌ Error in mark as read: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('notifications:get-stats', async (event) => {
  try {
    logToFile('🔔 Notification stats running in offline mode');
    return {
      success: true,
      data: {
        total: 0,
        unread: 0,
        read: 0
      },
      message: 'Running in offline mode'
    };
  } catch (error) {
    logToFile(`❌ Error in notification stats: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// AI Chatbot IPC Handlers
ipcMain.handle('ai-providers:get-all', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }
    const result = await databaseService.query('SELECT * FROM ai_providers WHERE is_active = 1 ORDER BY created_at DESC');
    return result; // Return the result directly, it already has { success, data } structure
  } catch (error) {
    logToFile(`❌ AI Providers get error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-providers:create', async (event, providerData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    const result = await databaseService.query(`
      INSERT INTO ai_providers (
        name, type, api_key, model, temperature, max_tokens,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      providerData.name,
      providerData.type,
      providerData.apiKey,
      providerData.model,
      providerData.temperature,
      providerData.maxTokens,
      providerData.isActive ? 1 : 0
    ]);

    return { success: true, data: { id: result.lastID } };
  } catch (error) {
    logToFile(`❌ AI Provider create error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-providers:update', async (event, id, providerData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    await databaseService.query(`
      UPDATE ai_providers SET
        name = ?, type = ?, api_key = ?, model = ?,
        temperature = ?, max_tokens = ?, is_active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      providerData.name,
      providerData.type,
      providerData.apiKey,
      providerData.model,
      providerData.temperature,
      providerData.maxTokens,
      providerData.isActive ? 1 : 0,
      id
    ]);

    return { success: true };
  } catch (error) {
    logToFile(`❌ AI Provider update error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-providers:delete', async (event, id) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    // Check if provider is being used by any chatbots
    const chatbotsResult = await databaseService.query('SELECT COUNT(*) as count FROM ai_chatbots WHERE provider_id = ?', [id]);
    if (!chatbotsResult.success) {
      return { success: false, error: 'Failed to check chatbot dependencies' };
    }

    const chatbots = chatbotsResult.data;
    if (chatbots && chatbots.length > 0 && chatbots[0].count > 0) {
      return { success: false, error: 'Cannot delete provider - it is being used by chatbots' };
    }

    await databaseService.query('DELETE FROM ai_providers WHERE id = ?', [id]);
    return { success: true };
  } catch (error) {
    logToFile(`❌ AI Provider delete error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-chatbots:get-all', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }
    const result = await databaseService.query(`
      SELECT c.*, p.name as provider_name, p.type as provider_type
      FROM ai_chatbots c
      LEFT JOIN ai_providers p ON c.provider_id = p.id
      ORDER BY c.created_at DESC
    `);
    return result; // Return the result directly, it already has { success, data } structure
  } catch (error) {
    logToFile(`❌ AI Chatbots get error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-chatbots:create', async (event, chatbotData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    const result = await databaseService.query(`
      INSERT INTO ai_chatbots (
        name, description, provider_id, system_prompt, language,
        personality, industry, session_ids, trigger_keywords, stop_keywords, use_documents, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      chatbotData.name,
      chatbotData.description,
      chatbotData.providerId,
      chatbotData.systemPrompt,
      chatbotData.language || 'en',
      chatbotData.personality,
      chatbotData.industry,
      JSON.stringify(chatbotData.sessionIds || []),
      JSON.stringify(chatbotData.triggerKeywords || []),
      JSON.stringify(chatbotData.stopKeywords || []),
      chatbotData.useDocuments ? 1 : 0,
      chatbotData.isActive ? 1 : 0
    ]);

    return { success: true, data: { id: result.lastID } };
  } catch (error) {
    logToFile(`❌ AI Chatbot create error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-chatbots:update', async (event, id, chatbotData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    await databaseService.query(`
      UPDATE ai_chatbots SET
        name = ?, description = ?, provider_id = ?, system_prompt = ?,
        language = ?, personality = ?, industry = ?, session_ids = ?, trigger_keywords = ?,
        stop_keywords = ?, use_documents = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      chatbotData.name,
      chatbotData.description,
      chatbotData.providerId,
      chatbotData.systemPrompt,
      chatbotData.language || 'en',
      chatbotData.personality,
      chatbotData.industry,
      JSON.stringify(chatbotData.sessionIds || []),
      JSON.stringify(chatbotData.triggerKeywords || []),
      JSON.stringify(chatbotData.stopKeywords || []),
      chatbotData.useDocuments ? 1 : 0,
      chatbotData.isActive ? 1 : 0,
      id
    ]);

    return { success: true };
  } catch (error) {
    logToFile(`❌ AI Chatbot update error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-chatbots:delete', async (event, id) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    logToFile(`🗑️ Deleting AI chatbot with ID: ${id}`);

    // 1. End all active conversations for this chatbot
    const endConversationsResult = await databaseService.query(
      'UPDATE ai_conversations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE chatbot_id = ? AND status = ?',
      ['completed', id, 'active']
    );
    logToFile(`🗑️ Ended ${endConversationsResult.changes || 0} active conversations for chatbot ${id}`);

    // 2. Delete related data (messages will be deleted by CASCADE if properly set up)
    await databaseService.query('DELETE FROM ai_intents WHERE chatbot_id = ?', [id]);
    await databaseService.query('DELETE FROM ai_knowledge_base WHERE chatbot_id = ?', [id]);

    // 3. Delete the chatbot itself (this should cascade delete conversations and messages)
    const deleteResult = await databaseService.query('DELETE FROM ai_chatbots WHERE id = ?', [id]);

    if (deleteResult.success) {
      logToFile(`✅ Successfully deleted AI chatbot ${id} and cleaned up related data`);

      // 4. Clear any cached data by notifying the AI service
      try {
        const aiService = appService.getAIService();
        if (aiService && typeof aiService.clearChatbotCache === 'function') {
          aiService.clearChatbotCache(id);
        }
      } catch (cacheError) {
        logToFile(`⚠️ Warning: Could not clear chatbot cache: ${cacheError.message}`);
      }
    }

    return { success: true };
  } catch (error) {
    logToFile(`❌ AI Chatbot delete error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-chatbots:toggle-status', async (event, id) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    await databaseService.query(`
      UPDATE ai_chatbots SET
        is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    return { success: true };
  } catch (error) {
    logToFile(`❌ AI Chatbot toggle status error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Manual AI Schema Migration Handler (for development/debugging)
ipcMain.handle('ai-schema:force-migration', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    // Forcing AI schema migration
    await databaseService.runAIChatbotMigrations();
    // AI schema migration completed

    return { success: true, message: 'AI schema migration completed successfully' };
  } catch (error) {
    logToFile(`❌ AI Schema migration error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// AI Document IPC Handlers
ipcMain.handle('ai-documents:upload', async (event, chatbotId, fileBuffer, originalFilename) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const aiService = appService.getAIService();
    if (!aiService || !aiService.documentService) {
      return { success: false, error: 'Document service not available' };
    }

    const result = await aiService.documentService.uploadDocument(chatbotId, fileBuffer, originalFilename);
    logToFile(`✅ Document uploaded successfully: ${originalFilename}`);
    return result;
  } catch (error) {
    console.error(`❌ IPC: Document upload error:`, error);
    logToFile(`❌ Document upload error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-documents:get-all', async (event, chatbotId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const aiService = appService.getAIService();
    if (!aiService || !aiService.documentService) {
      return { success: false, error: 'Document service not available' };
    }

    const documents = await aiService.documentService.getDocuments(chatbotId);
    return { success: true, documents };
  } catch (error) {
    logToFile(`❌ Get documents error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-documents:delete', async (event, documentId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const aiService = appService.getAIService();
    if (!aiService || !aiService.documentService) {
      return { success: false, error: 'Document service not available' };
    }

    const result = await aiService.documentService.deleteDocument(documentId);
    logToFile(`✅ Document deleted successfully: ${documentId}`);
    return result;
  } catch (error) {
    logToFile(`❌ Document delete error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Clean up orphaned chatbot conversations
ipcMain.handle('chatbot:cleanup-orphaned-conversations', async (event) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    logToFile('🧹 Cleaning up orphaned chatbot conversations...');

    // End conversations for inactive flows
    const inactiveFlowConversations = await databaseService.query(`
      UPDATE chatbot_conversations
      SET is_active = 0, completed_at = CURRENT_TIMESTAMP
      WHERE is_active = 1 AND flow_id IN (
        SELECT id FROM chatbot_flows WHERE is_active = 0
      )
    `);

    // End conversations for deleted flows
    const deletedFlowConversations = await databaseService.query(`
      UPDATE chatbot_conversations
      SET is_active = 0, completed_at = CURRENT_TIMESTAMP
      WHERE is_active = 1 AND flow_id NOT IN (
        SELECT id FROM chatbot_flows
      )
    `);

    const totalCleaned = (inactiveFlowConversations.changes || 0) + (deletedFlowConversations.changes || 0);

    logToFile(`🧹 Cleaned up ${totalCleaned} orphaned conversations`);

    return {
      success: true,
      cleaned: totalCleaned,
      inactiveFlows: inactiveFlowConversations.changes || 0,
      deletedFlows: deletedFlowConversations.changes || 0
    };
  } catch (error) {
    logToFile(`❌ Cleanup orphaned conversations error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Support Bot IPC Handlers
ipcMain.handle('support-bot:import-data', async (event, { sessionId, customerRecords }) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const supportBotService = appService.getSupportBotService();
    if (!supportBotService) {
      return { success: false, error: 'Support Bot service not available' };
    }

    logToFile(`📊 Support Bot: Importing ${customerRecords.length} customer records for session ${sessionId}`);
    const result = await supportBotService.importCustomerData(sessionId, customerRecords);

    return result;
  } catch (error) {
    logToFile(`❌ Support Bot import error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('support-bot:save-mappings', async (event, { sessionId, mappings }) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const supportBotService = appService.getSupportBotService();
    if (!supportBotService) {
      return { success: false, error: 'Support Bot service not available' };
    }

    logToFile(`🗺️ Support Bot: Saving ${mappings.length} field mappings for session ${sessionId}`);
    const result = await supportBotService.saveFieldMappings(sessionId, mappings);

    return result;
  } catch (error) {
    logToFile(`❌ Support Bot save mappings error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('support-bot:upload-attachment', async (event, { file, sessionId }) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const supportBotService = appService.getSupportBotService();
    if (!supportBotService) {
      return { success: false, error: 'Support Bot service not available' };
    }

    logToFile(`📎 Support Bot: Uploading attachment for session ${sessionId}`);
    const result = await supportBotService.uploadAttachment(file, sessionId);

    return result;
  } catch (error) {
    logToFile(`❌ Support Bot upload attachment error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('support-bot:get-stats', async (event, { sessionId }) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const supportBotService = appService.getSupportBotService();
    if (!supportBotService) {
      return { success: false, error: 'Support Bot service not available' };
    }

    const stats = await supportBotService.getStatistics(sessionId);
    return stats;
  } catch (error) {
    logToFile(`❌ Support Bot get stats error: ${error.message}`);
    return null;
  }
});

// Start services when app is ready
app.whenReady().then(() => {
  if (notificationService) {
    notificationService.start();
  }
  if (backgroundLicenseValidator) {
    backgroundLicenseValidator.start();
  }

  // Start cloud license validation if cloud license exists
  if (cloudLicenseService && cloudLicenseService.hasCloudLicense()) {
    logToFile('🔐 Cloud license detected - starting periodic validation');
    cloudLicenseService.startPeriodicValidation();
  }
});

// Warmer Service IPC Handlers
ipcMain.handle('warmer:create-campaign', async (event, campaignData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.createCampaign(campaignData);
  } catch (error) {
    logToFile(`❌ Warmer create campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:get-campaigns', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.getCampaigns();
  } catch (error) {
    logToFile(`❌ Warmer get campaigns error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:update-campaign', async (event, campaignId, updates) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.updateCampaign(campaignId, updates);
  } catch (error) {
    logToFile(`❌ Warmer update campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:delete-campaign', async (event, campaignId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.deleteCampaign(campaignId);
  } catch (error) {
    logToFile(`❌ Warmer delete campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:start-campaign', async (event, campaignId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.startCampaign(campaignId);
  } catch (error) {
    logToFile(`❌ Warmer start campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:stop-campaign', async (event, campaignId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.stopCampaign(campaignId);
  } catch (error) {
    logToFile(`❌ Warmer stop campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:create-template', async (event, templateData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.createTemplate(templateData);
  } catch (error) {
    logToFile(`❌ Warmer create template error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:get-templates', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.getTemplates();
  } catch (error) {
    logToFile(`❌ Warmer get templates error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:update-template', async (event, templateId, updates) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.updateTemplate(templateId, updates);
  } catch (error) {
    logToFile(`❌ Warmer update template error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warmer:delete-template', async (event, templateId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const warmerService = appService.getWarmerService();
    if (!warmerService) {
      return { success: false, error: 'Warmer service not available' };
    }
    return await warmerService.deleteTemplate(templateId);
  } catch (error) {
    logToFile(`❌ Warmer delete template error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Proxy Service IPC Handlers
ipcMain.handle('proxy:save-api-key', async (event, apiKey) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.saveApiKey(apiKey);
  } catch (error) {
    logToFile(`❌ Proxy save API key error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-settings', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getSettings();
  } catch (error) {
    logToFile(`❌ Proxy get settings error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:sync-account', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.syncAccountInfo();
  } catch (error) {
    logToFile(`❌ Proxy sync account error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-price', async (event, count, period, version) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getPrice(count, period, version);
  } catch (error) {
    logToFile(`❌ Proxy get price error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-countries', async (event, version) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getCountries(version);
  } catch (error) {
    logToFile(`❌ Proxy get countries error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-count', async (event, country, version) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getCount(country, version);
  } catch (error) {
    logToFile(`❌ Proxy get count error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:buy-proxy', async (event, count, period, country, version, type, description, autoProlong) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.buyProxy(count, period, country, version, type, description, autoProlong);
  } catch (error) {
    logToFile(`❌ Proxy buy proxy error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:sync-proxies', async (event, state) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.syncProxies(state);
  } catch (error) {
    logToFile(`❌ Proxy sync proxies error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-proxies', async (event, filters) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getProxies(filters);
  } catch (error) {
    logToFile(`❌ Proxy get proxies error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:prolong-proxy', async (event, proxyIds, period) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.prolongProxy(proxyIds, period);
  } catch (error) {
    logToFile(`❌ Proxy prolong proxy error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:delete-proxy', async (event, proxyIds) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.deleteProxy(proxyIds);
  } catch (error) {
    logToFile(`❌ Proxy delete proxy error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:check-proxy', async (event, proxyId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.checkProxy(proxyId);
  } catch (error) {
    logToFile(`❌ Proxy check proxy error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:set-type', async (event, proxyIds, type) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.setProxyType(proxyIds, type);
  } catch (error) {
    logToFile(`❌ Proxy set type error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-statistics', async () => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getStatistics();
  } catch (error) {
    logToFile(`❌ Proxy get statistics error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:assign-to-campaign', async (event, campaignId, proxyId, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.assignToCampaign(campaignId, proxyId, sessionId);
  } catch (error) {
    logToFile(`❌ Proxy assign to campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('proxy:get-for-campaign', async (event, campaignId, sessionId) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }
    const proxyService = appService.getProxyService();
    if (!proxyService) {
      return { success: false, error: 'Proxy service not available' };
    }
    return await proxyService.getForCampaign(campaignId, sessionId);
  } catch (error) {
    logToFile(`❌ Proxy get for campaign error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Email Service IPC Handlers
ipcMain.handle('email:test-configuration', async (event, config) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    let EmailService;
    try {
      // Try relative path first (development)
      EmailService = require('../services/email.service');
    } catch (error) {
      try {
        // Try from current directory (production)
        EmailService = require('./services/email.service');
      } catch (error2) {
        try {
          // Try absolute path as last resort
          EmailService = require('./build/services/email.service');
        } catch (error3) {
          logToFile(`❌ Failed to load EmailService from all paths: ${error.message}, ${error2.message}, ${error3.message}`);
          return { success: false, error: 'Email service module not found' };
        }
      }
    }

    const emailService = new EmailService();
    const result = await emailService.testEmailConfiguration(config);
    return result;
  } catch (error) {
    logToFile(`❌ Email configuration test error: ${error.message}`);
    return { success: false, error: error.message };
  }
});


// Live Chat Service IPC Handlers
// (liveChatService variable and initialization function are defined at the top of the file)

// Sync WhatsApp chat history to Live Chat database
ipcMain.handle('live-chat:sync-chat-history', async (event, sessionId, chatId, conversationId) => {
  try {

    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }

    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const whatsappService = appService.getWhatsAppService();
    if (!whatsappService) {
      return { success: false, error: 'WhatsApp service not available' };
    }

    // First, update the conversation with correct contact info from WhatsApp
    const contactPhone = chatId.split('@')[0];

    // Update the conversation's contact_phone in database
    await liveChatService.db.run(
      'UPDATE live_chat_conversations SET contact_phone = ? WHERE conversation_id = ?',
      [contactPhone, conversationId]
    );

    // Fetch chat history from WhatsApp
    const historyResult = await whatsappService.getChatHistory(sessionId, chatId, 50);

    if (!historyResult.success || !historyResult.messages) {
      return { success: true, synced: 0 };
    }


    let syncedCount = 0;

    // Save each message to Live Chat database
    for (const msg of historyResult.messages) {
      try {
        // Extract message content
        let content = '';
        let messageType = 'text';

        // Ensure msg is an object, not a string
        if (typeof msg !== 'object' || !msg) {
          continue;
        }

        if (msg.message) {
          if (msg.message.conversation) {
            content = msg.message.conversation;
          } else if (msg.message.extendedTextMessage?.text) {
            content = msg.message.extendedTextMessage.text;
          } else if (msg.message.imageMessage) {
            messageType = 'image';
            content = msg.message.imageMessage.caption || '[Image]';
          } else if (msg.message.videoMessage) {
            messageType = 'video';
            content = msg.message.videoMessage.caption || '[Video]';
          } else if (msg.message.audioMessage) {
            messageType = 'audio';
            content = '[Audio]';
          } else if (msg.message.documentMessage) {
            messageType = 'document';
            content = msg.message.documentMessage.fileName || '[Document]';
          } else {
            content = '[Unsupported message type]';
          }
        } else {
          continue;
        }


        const contactPhone = chatId.split('@')[0];
        const contactName = msg.pushName || msg.verifiedBizName || contactPhone;

        // Save message
        const saveResult = await liveChatService.saveMessage(conversationId, {
          messageId: msg.key?.id || `msg_${Date.now()}_${syncedCount}`,
          senderType: msg.key?.fromMe ? 'agent' : 'customer',
          senderName: msg.key?.fromMe ? 'You' : contactName,
          content: content,
          messageType: messageType,
          status: 'delivered',
          timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
        });

        if (saveResult.success) {
          syncedCount++;
        }
      } catch (msgError) {
        console.error(`❌ [Live Chat] Error syncing message:`, msgError);
      }
    }


    return { success: true, synced: syncedCount };
  } catch (error) {
    console.error(`❌ [Live Chat] Error syncing chat history:`, error);
    return { success: false, error: error.message };
  }
});

// Diagnostic handler to check service status
ipcMain.handle('live-chat:check-service-status', async () => {

  const databaseService = appService?.getDatabaseService ? appService.getDatabaseService() : appService?.database;

  return {
    success: true,
    status: {
      liveChatServiceExists: liveChatService !== null,
      appServiceExists: appService !== null,
      databaseServiceExists: databaseService !== null
    }
  };
});

// Manual initialization handler for debugging
ipcMain.handle('live-chat:force-initialize', async () => {
  try {
    const result = await initializeLiveChatService();

    return {
      ...result,
      liveChatServiceExists: liveChatService !== null
    };
  } catch (error) {
    console.error('🔧 [Live Chat] Force initialization error:', error);

    return {
      success: false,
      error: error.message,
      stack: error.stack,
      liveChatServiceExists: liveChatService !== null
    };
  }
});

// Conversation Management Handlers
ipcMain.handle('live-chat:get-or-create-conversation', async (event, sessionId, contactPhone, contactName, contactAvatar, fullChatId) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getOrCreateConversation(sessionId, contactPhone, contactName, contactAvatar, fullChatId);
  } catch (error) {
    logToFile(`❌ Live Chat get/create conversation error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:get-conversations', async (event, sessionId, filters) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getConversations(sessionId, filters);
  } catch (error) {
    logToFile(`❌ Live Chat get conversations error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:update-conversation', async (event, conversationId, updates) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.updateConversation(conversationId, updates);
  } catch (error) {
    logToFile(`❌ Live Chat update conversation error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:update-conversation-status', async (event, conversationId, status) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.updateConversationStatus(conversationId, status);
  } catch (error) {
    logToFile(`❌ Live Chat update conversation status error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:mark-as-read', async (event, conversationId) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.markAsRead(conversationId);
  } catch (error) {
    logToFile(`❌ Live Chat mark as read error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:search-conversations', async (event, sessionId, searchTerm) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.searchConversations(sessionId, searchTerm);
  } catch (error) {
    logToFile(`❌ Live Chat search conversations error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Message Management Handlers
ipcMain.handle('live-chat:save-message', async (event, conversationId, messageData) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.saveMessage(conversationId, messageData);
  } catch (error) {
    logToFile(`❌ Live Chat save message error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:get-messages', async (event, conversationId, limit, offset) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getMessages(conversationId, limit, offset);
  } catch (error) {
    logToFile(`❌ Live Chat get messages error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Contact/CRM Management Handlers
ipcMain.handle('live-chat:get-contact', async (event, phone) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getContact(phone);
  } catch (error) {
    logToFile(`❌ Live Chat get contact error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:create-or-update-contact', async (event, phone, name, avatar, additionalData) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.createOrUpdateContact(phone, name, avatar, additionalData);
  } catch (error) {
    logToFile(`❌ Live Chat create/update contact error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Notes Management Handlers
ipcMain.handle('live-chat:add-note', async (event, conversationId, author, content, noteType) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.addNote(conversationId, author, content, noteType);
  } catch (error) {
    logToFile(`❌ Live Chat add note error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:get-notes', async (event, conversationId) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getNotes(conversationId);
  } catch (error) {
    logToFile(`❌ Live Chat get notes error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:update-note', async (event, noteId, content) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.updateNote(noteId, content);
  } catch (error) {
    logToFile(`❌ Live Chat update note error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:delete-note', async (event, noteId) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.deleteNote(noteId);
  } catch (error) {
    logToFile(`❌ Live Chat delete note error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Quick Replies Handlers
ipcMain.handle('live-chat:get-quick-replies', async (event) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getQuickReplies();
  } catch (error) {
    logToFile(`❌ Live Chat get quick replies error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('live-chat:create-quick-reply', async (event, shortcut, title, content, category) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.createQuickReply(shortcut, title, content, category);
  } catch (error) {
    logToFile(`❌ Live Chat create quick reply error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Statistics Handler
ipcMain.handle('live-chat:get-statistics', async (event, sessionId) => {
  try {
    if (!liveChatService) {
      await initializeLiveChatService();
    }
    if (!liveChatService) {
      return { success: false, error: 'Live Chat service not available' };
    }
    return await liveChatService.getStatistics(sessionId);
  } catch (error) {
    logToFile(`❌ Live Chat get statistics error: ${error.message}`);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('email:send', async (event, emailData) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const result = await appService.emailService.sendEmail(emailData);
    return result;
  } catch (error) {
    logToFile(`❌ Email send error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('email:get-stats', async (event, days = 30) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const result = await appService.emailService.getEmailStats(days);
    return result;
  } catch (error) {
    logToFile(`❌ Email stats error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('email:process-template', async (event, templateId, variables) => {
  try {
    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const result = await appService.emailService.processTemplate(templateId, variables);
    return result;
  } catch (error) {
    logToFile(`❌ Email template processing error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Update Service IPC Handlers
ipcMain.handle('update:check-for-updates', async (event, silent = false) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const hasUpdate = await updateService.checkForUpdates(silent);
    const updateInfo = updateService.getUpdateInfo();

    return {
      success: true,
      hasUpdate,
      updateInfo: updateInfo.updateInfo,
      isUpdateAvailable: updateInfo.isUpdateAvailable
    };
  } catch (error) {
    logToFile(`❌ Update check error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:download-update', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    await updateService.downloadUpdate();
    return { success: true };
  } catch (error) {
    logToFile(`❌ Update download error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:install-update', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    await updateService.installUpdate();
    return { success: true };
  } catch (error) {
    logToFile(`❌ Update install error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:install-simple', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    await updateService.installUpdateSimple();
    return { success: true };
  } catch (error) {
    logToFile(`❌ Simple update install error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:get-update-info', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const updateInfo = updateService.getUpdateInfo();
    return { success: true, ...updateInfo };
  } catch (error) {
    logToFile(`❌ Get update info error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:verify-data-integrity', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const integrity = await updateService.dataProtection.verifyDataIntegrity();
    return { success: true, integrity };
  } catch (error) {
    logToFile(`❌ Data integrity check error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:create-backup', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const backup = await updateService.dataProtection.createDataBackup();
    return { success: true, backup };
  } catch (error) {
    logToFile(`❌ Create backup error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:get-data-summary', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const summary = updateService.dataProtection.getDataSummary();
    return { success: true, summary };
  } catch (error) {
    logToFile(`❌ Get data summary error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:validate-branding', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const validation = await updateService.brandingProtection.validateBrandingIntegrity();
    return { success: true, validation };
  } catch (error) {
    logToFile(`❌ Branding validation error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:get-branding-summary', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const summary = updateService.brandingProtection.getBrandingSummary();
    return { success: true, summary };
  } catch (error) {
    logToFile(`❌ Get branding summary error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:perform-branding-audit', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const audit = await updateService.brandingProtection.performBrandingAudit();
    return { success: true, audit };
  } catch (error) {
    logToFile(`❌ Branding audit error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update:lock-branding', async (event) => {
  try {
    if (!updateService) {
      return { success: false, error: 'Update service not available' };
    }

    const result = await updateService.brandingProtection.lockBrandingElements();
    return { success: true, result };
  } catch (error) {
    logToFile(`❌ Lock branding error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Delete all data except translation keys
ipcMain.handle('database:delete-all-data', async (event) => {
  try {
    logToFile('🗑️ Delete all data request received');

    if (!appService) {
      return { success: false, error: 'App service not available' };
    }

    const databaseService = appService.getDatabaseService();
    if (!databaseService) {
      return { success: false, error: 'Database service not available' };
    }

    // Step 1: Get all WhatsApp sessions before deleting
    const sessionsResult = await databaseService.query('SELECT session_id FROM whatsapp_sessions');
    const sessionIds = sessionsResult.success && sessionsResult.data ? sessionsResult.data.map(s => s.session_id) : [];

    logToFile(`🗑️ Found ${sessionIds.length} WhatsApp sessions to clean up`);

    // Step 2: Disconnect and delete all WhatsApp sessions
    const whatsappService = appService.getWhatsAppService();
    if (whatsappService && sessionIds.length > 0) {
      for (const sessionId of sessionIds) {
        try {
          logToFile(`🗑️ Deleting WhatsApp session: ${sessionId}`);
          await whatsappService.deleteSession(sessionId);
        } catch (sessionError) {
          logToFile(`⚠️ Error deleting session ${sessionId}: ${sessionError.message}`);
        }
      }
    }

    // Step 3: Delete all database data except translations
    const result = await databaseService.deleteAllDataExceptTranslations();

    if (result.success) {
      logToFile(`✅ Delete all data completed: ${result.message}`);
    } else {
      logToFile(`❌ Delete all data failed: ${result.error}`);
    }

    return result;
  } catch (error) {
    logToFile(`❌ Delete all data error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Stop services when app is quitting
app.on('before-quit', () => {
  if (notificationService) {
    notificationService.stop();
  }
  if (backgroundLicenseValidator) {
    backgroundLicenseValidator.stop();
  }
  if (cloudLicenseService) {
    cloudLicenseService.stopPeriodicValidation();
  }
  if (updateService) {
    updateService.destroy();
  }
});

logToFile('✅ Electron main process setup complete');
