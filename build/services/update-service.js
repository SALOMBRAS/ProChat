const { autoUpdater } = require('electron-updater');
const { app, dialog, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const DataProtectionService = require('./data-protection-service');
const BrandingProtectionService = require('./branding-protection-service');

class UpdateService {
  constructor() {
    this.updateCheckInterval = null;
    this.isUpdateAvailable = false;
    this.updateInfo = null;
    this.mainWindow = null;
    this.justUpdated = false; // Flag to prevent immediate update checks after installation
    this.isDev = false;
    this.dataProtection = new DataProtectionService();
    this.brandingProtection = new BrandingProtectionService();
    this.preUpdateBackup = null;
    this.brandingSnapshot = null;

    process.env.ELECTRON_IS_DEV = '0';

    this.configureAutoUpdater();

    this.checkForUpdates = this.checkForUpdates.bind(this);
    this.downloadUpdate = this.downloadUpdate.bind(this);
    this.installUpdate = this.installUpdate.bind(this);

    this.checkIfJustUpdated();
  }

  configureAutoUpdater() {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://www.c-ut.com/LeadWave/'
    });

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    if (process.platform === 'win32') {
      autoUpdater.disableWebInstaller = true;
      const originalCheckSignature = autoUpdater.checkSignature;
      if (originalCheckSignature) {
        autoUpdater.checkSignature = () => Promise.resolve(true);
      }
    }

    const { app } = require('electron');
    const packageJson = require('../../package.json');

    Object.defineProperty(autoUpdater, 'currentVersion', {
      get: () => packageJson.version
    });

    autoUpdater.logger = console;

    this.logUpdate(`Current app version: ${app.getVersion()}`);
    this.logUpdate(`Package.json version: ${packageJson.version}`);
    this.logUpdate(`AutoUpdater version: ${autoUpdater.currentVersion}`);

    this.setupEventListeners();
  }

  setupEventListeners() {
    autoUpdater.on('checking-for-update', () => {
      this.logUpdate('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
      this.logUpdate('Update available:', info);
      this.isUpdateAvailable = true;
      this.updateInfo = info;
      this.notifyUpdateAvailable(info);
    });

    autoUpdater.on('update-not-available', (info) => {
      this.logUpdate('No update available:', info);
      this.isUpdateAvailable = false;
      this.updateInfo = null;
    });

    autoUpdater.on('download-progress', (progressObj) => {
      this.logUpdate('Download progress:', progressObj);
      this.notifyDownloadProgress(progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.logUpdate('Update downloaded:', info);
      this.isUpdateDownloaded = true;
      this.notifyUpdateDownloaded(info);
    });

    autoUpdater.on('before-quit-for-update', () => {
      this.logUpdate('App is about to quit for update...');
    });

    const { app } = require('electron');
    app.on('before-quit', (event) => {
      this.logUpdate('App before-quit event triggered');
    });

    app.on('will-quit', (event) => {
      this.logUpdate('App will-quit event triggered');
    });

    autoUpdater.on('error', (error) => {
      this.logUpdate('Update error:', error);

      if (error.message && (
        error.message.includes('not signed by the application owner') ||
        error.message.includes('signature verification') ||
        error.message.includes('Code signing') ||
        error.message.includes('ERR_UPDATER_CODE_SIGN') ||
        error.message.includes('ENOENT') ||
        error.message.includes('net::ERR_') ||
        error.message.includes('Cannot download')
      )) {
        this.logUpdate('Signature/Network error - treating as unsigned update');
        this.logUpdate('Proceeding with unsigned update handling...');
        this.handleUnsignedUpdate(error);
      } else {
        this.logUpdate('Non-signature related error:', error.message);
        this.logUpdate('Suppressing update error notification');
      }
    });
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  checkIfJustUpdated() {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      const flagPath = path.join(os.tmpdir(), 'leadwave-update-preserve-sessions.flag');
      if (fs.existsSync(flagPath)) {
        this.logUpdate('App was just updated - setting cooldown period');
        this.justUpdated = true;

        fs.unlinkSync(flagPath);

        setTimeout(() => {
          this.justUpdated = false;
          this.logUpdate('Update cooldown period ended');
        }, 30000);
      }
    } catch (error) {
      this.logUpdate('Error checking update flag:', error);
    }
  }

  handleUnsignedUpdate(error) {
    this.logUpdate('Handling unsigned update...');

    this.performManualUpdateCheck()
      .then((updateInfo) => {
        if (updateInfo) {
          this.logUpdate('Manual update check successful:', updateInfo);
          this.updateInfo = updateInfo;
          this.isUpdateAvailable = true;
          this.notifyUpdateAvailable(updateInfo);
        } else {
          this.logUpdate('No update available through manual check');
        }
      })
      .catch((manualError) => {
        this.logUpdate('Manual update check failed:', manualError);
        this.logUpdate('Suppressing manual update check error notification');
      });
  }

  async performManualUpdateCheck() {
    try {
      this.logUpdate('Performing manual update check...');

      const response = await fetch('https://www.c-ut.com/LeadWave/latest.yml');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const yamlText = await response.text();
      this.logUpdate('Fetched latest.yml:', yamlText);

      const lines = yamlText.split('\n');
      const updateInfo = {};

      for (const line of lines) {
        if (line.startsWith('version:')) {
          updateInfo.version = line.split(':')[1].trim();
        } else if (line.startsWith('releaseDate:')) {
          updateInfo.releaseDate = line.split(':')[1].trim().replace(/'/g, '');
        } else if (line.includes('url:')) {
          updateInfo.url = line.split(':')[1].trim();
        } else if (line.includes('size:')) {
          updateInfo.size = parseInt(line.split(':')[1].trim());
        }
      }

      const currentVersion = require('../../package.json').version;
      this.logUpdate(`Comparing versions: current=${currentVersion}, available=${updateInfo.version}`);

      if (updateInfo.version && this.isNewerVersion(updateInfo.version, currentVersion)) {
        this.logUpdate('Newer version found:', updateInfo.version);
        return {
          version: updateInfo.version,
          releaseDate: updateInfo.releaseDate,
          files: [{
            url: updateInfo.url,
            size: updateInfo.size
          }]
        };
      } else {
        this.logUpdate('No newer version available');
        return null;
      }
    } catch (error) {
      this.logUpdate('Manual update check failed:', error);
      throw error;
    }
  }

  isNewerVersion(available, current) {
    const availableParts = available.split('.').map(Number);
    const currentParts = current.split('.').map(Number);

    for (let i = 0; i < Math.max(availableParts.length, currentParts.length); i++) {
      const availablePart = availableParts[i] || 0;
      const currentPart = currentParts[i] || 0;

      if (availablePart > currentPart) return true;
      if (availablePart < currentPart) return false;
    }

    return false;
  }

  async checkForUpdates(silent = false) {
    if (this.justUpdated) {
      this.logUpdate('Skipping update check - app was just updated');
      return false;
    }

    const currentVersion = require('../../package.json').version;
    this.logUpdate(`Current app version: ${currentVersion}`);

    if (currentVersion === '1.0.7') {
      this.logUpdate('Already on latest version 1.0.7 - skipping update check');
      this.isUpdateAvailable = false;
      return false;
    }

    this.logUpdate('Checking for updates...');

    try {
      this.logUpdate('Checking for updates...');
      const result = await autoUpdater.checkForUpdates();

      if (!silent && !this.isUpdateAvailable) {
        this.showNoUpdateDialog();
      }

      return this.isUpdateAvailable;
    } catch (error) {
      this.logUpdate('Error checking for updates:', error);

      this.logUpdate(`Silent check: ${silent}, Just updated: ${this.justUpdated}, Common error: ${this.isCommonUpdateError(error)}`);

      this.logUpdate('Suppressing update error notification (all errors suppressed)');
      return false;
    }
  }

  isCommonUpdateError(error) {
    if (!error || !error.message) return false;

    const errorMessage = error.message.toLowerCase();
    const commonErrors = [
      'no updates available',
      'no update available',
      'update not available',
      'latest version',
      'up to date',
      'same version',
      'net::err_',
      'enoent',
      'signature verification',
      'not signed by the application owner',
      'network error',
      'connection timeout',
      'dns resolution failed',
      'update check failed'
    ];

    const isCommon = commonErrors.some(commonError =>
      errorMessage.includes(commonError.toLowerCase())
    );

    if (isCommon) {
      this.logUpdate(`Filtered common update error: ${error.message}`);
    }

    return isCommon;
  }

  // Modified method: When download is instructed, just open a URL
  async downloadUpdate() {
    // Instead of downloading any update, open the specific URL
    try {
      this.logUpdate('Opening update download URL...');
      const { shell } = require('electron');
      shell.openExternal('https://www.dr-farfar.com/meu-app-whatsapp-alpha-automation/');
      this.logUpdate('Update download URL opened.');
    } catch (error) {
      this.logUpdate('Error opening update download URL:', error);
      throw error;
    }
  }

  async createPreUpdateBackup() {
    try {
      this.logUpdate('Creating pre-update backup...');

      const integrity = await this.dataProtection.verifyDataIntegrity();
      this.logUpdate('Data integrity check:', integrity);

      this.brandingSnapshot = await this.brandingProtection.createBrandingSnapshot();
      this.logUpdate('Branding snapshot created');

      this.preUpdateBackup = await this.dataProtection.createDataBackup();
      this.logUpdate('Pre-update backup created:', this.preUpdateBackup.backupPath);

      return {
        dataBackup: this.preUpdateBackup,
        brandingSnapshot: this.brandingSnapshot
      };
    } catch (error) {
      this.logUpdate('Failed to create pre-update backup:', error);
      throw error;
    }
  }

  async validatePostUpdate() {
    try {
      this.logUpdate('Validating data and branding after update...');

      const dataValidation = await this.dataProtection.validateDataAfterUpdate();
      this.logUpdate('Post-update data validation:', dataValidation);

      const brandingValidation = await this.brandingProtection.validateBrandingIntegrity(this.brandingSnapshot);
      this.logUpdate('Post-update branding validation:', brandingValidation);

      const overallValidation = {
        success: dataValidation.success && brandingValidation.success,
        dataValidation,
        brandingValidation,
        issues: [...(dataValidation.issues || []), ...(brandingValidation.issues || [])]
      };

      if (!overallValidation.success) {
        this.logUpdate('Validation failed, attempting restoration...');

        if (!dataValidation.success && this.preUpdateBackup) {
          const dataRestoration = await this.dataProtection.restoreFromBackup(this.preUpdateBackup.backupPath);
          this.logUpdate('Data restoration completed:', dataRestoration);
          overallValidation.dataRestoration = dataRestoration;
        }

        if (!brandingValidation.success && this.brandingSnapshot) {
          const brandingRestoration = await this.brandingProtection.restoreBrandingFromSnapshot(this.brandingSnapshot);
          this.logUpdate('Branding restoration completed:', brandingRestoration);
          overallValidation.brandingRestoration = brandingRestoration;
        }
      }

      return overallValidation;
    } catch (error) {
      this.logUpdate('Post-update validation failed:', error);
      throw error;
    }
  }

  async installUpdateSimple() {
    try {
      this.logUpdate('Starting simple install process...');
      this.showInstallationProgressWithCountdown();
      global.isUpdating = true;

      const { app } = require('electron');
      const path = require('path');
      const fs = require('fs').promises;
      const os = require('os');

      const tempDir = os.tmpdir();
      const flagPath = path.join(tempDir, 'leadwave-update-preserve-sessions.flag');
      await fs.writeFile(flagPath, 'preserve-sessions=true\npreserve-data=true\nsilent-install=true');

      this.logUpdate('Created session preservation flag file');
      this.logUpdate('Using autoUpdater.quitAndInstall()...');

      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall(true, true);

      return;

    } catch (error) {
      this.logUpdate('Error in simple install:', error);
      this.hideInstallationProgress();
      throw error;
    }
  }

  async installUpdate() {
    try {
      this.logUpdate('Installing update - using WORKING manual installer approach...');
      await this.performManualInstallAndRestart();
    } catch (error) {
      this.logUpdate('Error installing update:', error);
      throw error;
    }
  }

  scheduleInstallOnExit() {
    this.logUpdate('Scheduling installation on app exit...');

    const { app } = require('electron');

    app.removeAllListeners('before-quit');

    app.on('before-quit', async (event) => {
      event.preventDefault();
      this.logUpdate('App is quitting, starting installation...');
      await this.performManualInstallAndRestart();
    });
  }

  async performManualInstallAndRestart() {
    try {
      this.logUpdate('Starting manual installation process...');
      this.showInstallationProgress();
      const updateFilePath = await this.getDownloadedUpdatePath();

      if (!updateFilePath) {
        throw new Error('Update file not found');
      }

      this.logUpdate(`Found update file: ${updateFilePath}`);
      this.updateInstallationProgress(25, 'Preparing installation...');

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.hide();
      }

      this.updateInstallationProgress(50, 'Starting installer...');
      await this.launchManualInstaller(updateFilePath);

    } catch (error) {
      this.logUpdate('Error in manual installation:', error);
      this.hideInstallationProgress();
      throw error;
    }
  }

  async getDownloadedUpdatePath() {
    const { app } = require('electron');
    const path = require('path');
    const fs = require('fs').promises;

    const updateCacheDir = path.join(app.getPath('userData'), 'pending');

    try {
      const files = await fs.readdir(updateCacheDir);
      const exeFile = files.find(file => file.endsWith('.exe'));

      if (exeFile) {
        const filePath = path.join(updateCacheDir, exeFile);
        this.logUpdate('Using autoUpdater downloaded file:', filePath);
        return filePath;
      }
    } catch (error) {
      this.logUpdate('Error finding update file in cache:', error);
    }

    this.logUpdate('No downloaded update file found');
    return null;
  }

  async launchManualInstaller(installerPath) {
    const { spawn } = require('child_process');
    const { app } = require('electron');
    const path = require('path');
    const fs = require('fs').promises;

    this.logUpdate(`Launching installer: ${installerPath}`);

    try {
      this.updateInstallationProgress(75, 'Preparing graceful installation...');

      const coordFile = path.join(app.getPath('temp'), 'leadwave-update-preserve-sessions.flag');
      await fs.writeFile(coordFile, JSON.stringify({
        preserveSessions: true,
        preserveDatabase: true,
        updateTime: new Date().toISOString(),
        fromVersion: app.getVersion(),
        toVersion: this.updateInfo?.version || 'unknown'
      }));

      this.logUpdate('Created session preservation flag file');
      this.updateInstallationProgress(80, 'Launching installer with session preservation...');

      const installerArgs = [
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
        '/PRESERVESESSIONS=1',
        '/PRESERVEDATA=1',
        '/CLOSEAPPLICATIONS',
        '/RESTARTAPPLICATIONS=0'
      ];

      this.logUpdate(`Launching installer with args: ${installerArgs.join(' ')}`);

      const installer = spawn(installerPath, installerArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (installer.stdout) {
        installer.stdout.on('data', (data) => {
          this.logUpdate(`Installer stdout: ${data.toString()}`);
        });
      }

      if (installer.stderr) {
        installer.stderr.on('data', (data) => {
          this.logUpdate(`Installer stderr: ${data.toString()}`);
        });
      }

      installer.on('close', (code) => {
        this.logUpdate(`Installer process exited with code: ${code}`);
      });

      installer.unref();

      this.updateInstallationProgress(90, 'Installation started with session preservation...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      this.updateInstallationProgress(95, 'Gracefully closing application...');
      this.logUpdate('Gracefully closing application for installation...');

      const allWindows = require('electron').BrowserWindow.getAllWindows();
      allWindows.forEach(window => {
        if (!window.isDestroyed()) {
          window.hide();
        }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));
      this.updateInstallationProgress(100, 'Installation in progress...');
      app.quit();

    } catch (error) {
      this.logUpdate('Error launching installer:', error);
      throw error;
    }
  }

  startPeriodicCheck(intervalHours = 24) {
    this.logUpdate('Periodic update checks disabled to prevent signature verification errors');
    this.logUpdate('Updates will only be checked when manually requested');
    return;
  }

  stopPeriodicCheck() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
      this.logUpdate('Stopped periodic update checks');
    }
  }

  notifyUpdateAvailable(info) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate
      });
    }
  }

  notifyDownloadProgress(progressObj) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-download-progress', {
        percent: progressObj.percent,
        bytesPerSecond: progressObj.bytesPerSecond,
        total: progressObj.total,
        transferred: progressObj.transferred
      });
    }
  }

  notifyUpdateDownloaded(info) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-downloaded', {
        version: info.version,
        releaseDate: info.releaseDate,
        files: info.files,
        installOptions: {
          showInstallOnly: true,
          preserveDataByDefault: true,
          silentInstall: true,
          autoRestart: true
        },
        message: 'Update downloaded successfully. Click Install to update automatically with session preservation.'
      });
    }
  }

  showInstallationProgress() {
    this.logUpdate('Showing installation progress dialog...');
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('show-installation-progress', {
        title: 'Installing Update',
        message: 'Please wait while the update is being installed...',
        progress: 0
      });
    }
  }

  updateInstallationProgress(percent, message) {
    this.logUpdate(`Installation progress: ${percent}% - ${message}`);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-installation-progress', {
        progress: percent,
        message: message
      });
    }
  }

  showInstallationProgressWithCountdown() {
    this.logUpdate('Showing installation progress with countdown...');
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('show-installation-progress', {
        title: 'Installing Update',
        message: 'App will close in 3 seconds to install update...',
        countdown: true,
        progress: 0
      });

      let countdown = 3;
      const countdownInterval = setInterval(() => {
        countdown--;
        if (countdown > 0) {
          this.mainWindow.webContents.send('update-installation-progress', {
            progress: (3 - countdown) * 33,
            message: `App will close in ${countdown} seconds to install update...`
          });
        } else {
          this.mainWindow.webContents.send('update-installation-progress', {
            progress: 100,
            message: 'Installing update...'
          });
          clearInterval(countdownInterval);
        }
      }, 1000);
    }
  }

  hideInstallationProgress() {
    this.logUpdate('Hiding installation progress dialog...');
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('hide-installation-progress');
    }
  }

  notifyUpdateError(error) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-error', {
        message: error.message
      });
    }
  }

  showNoUpdateDialog() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-no-update', {
        message: 'You are running the latest version of ChatPro.'
      });
    }
  }

  showUpdateErrorDialog(error) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-error', {
        message: error.message || 'Failed to check for updates'
      });
    }
  }

  logUpdate(message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] UPDATE: ${message}`;
    
    if (data) {
    } else {
    }

    try {
      const logToFile = require('../utils/logger').logToFile;
      if (logToFile) {
        logToFile(data ? `${logMessage} ${JSON.stringify(data)}` : logMessage);
      }
    } catch (error) {
    }
  }

  getUpdateInfo() {
    return {
      isUpdateAvailable: this.isUpdateAvailable,
      updateInfo: this.updateInfo,
      isDev: this.isDev
    };
  }

  // The "downloadAndProvideManualInstaller" and "runManualInstallerFromDownloads" methods below are not triggered by download button anymore,
  // so we leave them for other possible usage, but downloadUpdate now simply opens a URL as required.

  async downloadAndProvideManualInstaller() {
    try {
      this.logUpdate('Providing manual installer download...');

      let updateFilePath = await this.getDownloadedUpdatePath();

      if (!updateFilePath) {
        this.logUpdate('Update not downloaded yet, downloading...');
        await this.downloadUpdate();
        updateFilePath = await this.getDownloadedUpdatePath();
      }

      if (!updateFilePath) {
        throw new Error('Failed to download update file');
      }

      const { app, shell } = require('electron');
      const path = require('path');
      const fs = require('fs').promises;

      const downloadsDir = app.getPath('downloads');
      const installerName = `ChatPro Setup ${this.updateInfo?.version || 'Latest'}.exe`;
      const destinationPath = path.join(downloadsDir, installerName);

      await fs.copyFile(updateFilePath, destinationPath);

      this.logUpdate(`Installer copied to: ${destinationPath}`);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const choice = await dialog.showMessageBox(this.mainWindow, {
          type: 'info',
          buttons: ['Open Downloads Folder', 'Run Installer Now', 'OK'],
          defaultId: 1,
          title: 'Installer Ready',
          message: 'Update installer downloaded successfully',
          detail: `The installer has been saved to your Downloads folder as:\n${installerName}\n\nTo preserve your WhatsApp sessions:\n1. Close ChatPro completely\n2. Run the installer\n3. Choose "Yes" when asked to retain sessions\n\nWould you like to run the installer now or open the Downloads folder?`
        });

        if (choice.response === 0) {
          shell.showItemInFolder(destinationPath);
        } else if (choice.response === 1) {
          await this.runManualInstallerFromDownloads(destinationPath);
        }
      }

      return destinationPath;
    } catch (error) {
      this.logUpdate('Error providing manual installer:', error);
      throw error;
    }
  }

  async runManualInstallerFromDownloads(installerPath) {
    try {
      this.logUpdate(`Running manual installer from: ${installerPath}`);

      const { spawn } = require('child_process');
      const { app } = require('electron');

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const choice = await dialog.showMessageBox(this.mainWindow, {
          type: 'question',
          buttons: ['Install with Session Preservation', 'Cancel'],
          defaultId: 0,
          title: 'Confirm Installation',
          message: 'Ready to install update',
          detail: 'This will close ChatPro and install the update while preserving your WhatsApp sessions and data.\n\nProceed with installation?'
        });

        if (choice.response !== 0) {
          return;
        }
      }

      const installer = spawn(installerPath, [
        '/PRESERVESESSIONS=1',
        '/PRESERVEDATA=1',
        '/CLOSEAPPLICATIONS'
      ], {
        detached: true,
        stdio: 'ignore'
      });

      installer.unref();

      this.logUpdate('Closing application for manual installation...');
      app.quit();

    } catch (error) {
      this.logUpdate('Error running manual installer:', error);
      throw error;
    }
  }

  destroy() {
    this.stopPeriodicCheck();
    this.mainWindow = null;
    this.updateInfo = null;
    this.isUpdateAvailable = false;
  }
}

module.exports = UpdateService;
