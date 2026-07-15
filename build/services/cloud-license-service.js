const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * Cloud License Service
 * Handles validation of cloud-based licenses from Laravel licensing server
 * Separate from keygen licenses which are offline and self-contained
 */
class CloudLicenseService {
  constructor() {
    // Cloud license server URL - production URL
    this.apiBaseUrl = 'https://127.0.0.1/api';

    // Validation interval: 5 minutes (reduced from 1 hour for faster suspension detection)
    this.heartbeatInterval = 5 * 60 * 1000; // 5 minutes in milliseconds

    // Grace period: 24 hours offline
    this.gracePeriod = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    this.heartbeatTimer = null;
  }

  /**
   * Get cloud license file path
   * Uses the custom userData path set by app.setPath()
   */
  getCloudLicenseFilePath() {
    // Use app.getPath('userData') instead of os.homedir() to respect custom userData path
    const appDataPath = app.getPath('userData');
    // Ensure directory exists
    if (!fs.existsSync(appDataPath)) {
      fs.mkdirSync(appDataPath, { recursive: true });
    }
    return path.join(appDataPath, 'cloud-license.json');
  }

  /**
   * Check if cloud license exists
   */
  hasCloudLicense() {
    const cloudLicenseFile = this.getCloudLicenseFilePath();
    return fs.existsSync(cloudLicenseFile);
  }

  /**
   * Get cloud license data
   */
  getCloudLicenseData() {
    try {
      const cloudLicenseFile = this.getCloudLicenseFilePath();
      if (fs.existsSync(cloudLicenseFile)) {
        const data = fs.readFileSync(cloudLicenseFile, 'utf8');
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      console.error('Error reading cloud license:', error);
      return null;
    }
  }

  /**
   * Save cloud license data
   */
  saveCloudLicenseData(data) {
    try {
      const cloudLicenseFile = this.getCloudLicenseFilePath();
      fs.writeFileSync(cloudLicenseFile, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving cloud license:', error);
      return false;
    }
  }

  /**
   * Delete cloud license
   */
  deleteCloudLicense() {
    try {
      const cloudLicenseFile = this.getCloudLicenseFilePath();
      if (fs.existsSync(cloudLicenseFile)) {
        fs.unlinkSync(cloudLicenseFile);
      }
      return true;
    } catch (error) {
      console.error('Error deleting cloud license:', error);
      return false;
    }
  }

  /**
   * Activate cloud license
   */
  async activateCloudLicense(licenseKey, machineId) {
    try {
      const fetch = require('node-fetch');
      
      const response = await fetch(`${this.apiBaseUrl}/license/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          license_key: licenseKey,
          machine_id: machineId,
          app_version: app.getVersion(),
        }),
        timeout: 10000, // 10 second timeout
      });

      const result = await response.json();

      if (result.success && result.is_valid) {
        // Save cloud license data
        const cloudLicenseData = {
          license_key: licenseKey,
          machine_id: machineId,
          customer_name: result.data.customer_name,
          plan: result.data.plan,
          plan_name: result.data.plan_name || result.data.plan,
          source: result.data.source,
          expires_at: result.data.expires_at,
          modules: result.data.modules || [],
          features: result.data.features || [],
          status: result.data.status || 'active',
          company_info: result.data.company_info || null, // Include company information
          activated_at: new Date().toISOString(),
          last_validated_at: new Date().toISOString(),
          last_validation_success: new Date().toISOString(),
        };

        this.saveCloudLicenseData(cloudLicenseData);

        return {
          success: true,
          message: 'Cloud license activated successfully',
          data: cloudLicenseData,
        };
      } else {
        return {
          success: false,
          message: result.message || 'License validation failed',
          code: result.code,
          status: result.status,
        };
      }
    } catch (error) {
      console.error('Cloud license activation error:', error);
      return {
        success: false,
        message: 'Failed to connect to license server',
        error: error.message,
      };
    }
  }

  /**
   * Validate cloud license with server (heartbeat)
   */
  async validateCloudLicense() {
    try {
      const cloudLicense = this.getCloudLicenseData();
      
      if (!cloudLicense) {
        return {
          success: false,
          message: 'No cloud license found',
          code: 'NO_CLOUD_LICENSE',
        };
      }

      const fetch = require('node-fetch');
      
      const response = await fetch(`${this.apiBaseUrl}/license/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          license_key: cloudLicense.license_key,
          machine_id: cloudLicense.machine_id,
          app_version: app.getVersion(),
        }),
        timeout: 10000, // 10 second timeout
      });

      const result = await response.json();

      // Update last validation timestamp
      cloudLicense.last_validated_at = new Date().toISOString();

      if (result.success && result.is_valid) {
        // License is valid - update last success timestamp
        cloudLicense.last_validation_success = new Date().toISOString();
        this.saveCloudLicenseData(cloudLicense);

        return {
          success: true,
          is_valid: true,
          status: 'active',
          message: 'License is active and valid',
          data: result.data,
        };
      } else {
        // License is invalid (suspended, expired, revoked)
        this.saveCloudLicenseData(cloudLicense);

        return {
          success: false,
          is_valid: false,
          status: result.status,
          message: result.message,
          code: result.code,
          suspension_reason: result.suspension_reason,
        };
      }
    } catch (error) {
      console.error('Cloud license validation error:', error);
      
      // Network error - check grace period
      return this.handleNetworkError();
    }
  }

  /**
   * Handle network errors with grace period
   */
  handleNetworkError() {
    const cloudLicense = this.getCloudLicenseData();
    
    if (!cloudLicense || !cloudLicense.last_validation_success) {
      // Never validated successfully - require online validation
      return {
        success: false,
        is_valid: false,
        status: 'offline',
        message: 'Internet connection required to validate license',
        code: 'CONNECTION_REQUIRED',
      };
    }

    const lastSuccess = new Date(cloudLicense.last_validation_success);
    const now = new Date();
    const timeSinceLastSuccess = now - lastSuccess;

    if (timeSinceLastSuccess > this.gracePeriod) {
      // Grace period expired - require online validation
      return {
        success: false,
        is_valid: false,
        status: 'offline',
        message: 'License validation required. Please connect to the internet.',
        code: 'GRACE_PERIOD_EXPIRED',
      };
    }

    // Within grace period - allow continued use
    const hoursRemaining = Math.round((this.gracePeriod - timeSinceLastSuccess) / (60 * 60 * 1000));

    return {
      success: true,
      is_valid: true,
      status: 'offline_grace',
      message: `Working offline (${hoursRemaining} hours remaining)`,
      code: 'OFFLINE_GRACE_PERIOD',
    };
  }

  /**
   * Start periodic validation (heartbeat every 1 hour)
   */
  startPeriodicValidation() {
    // Clear existing timer
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Validate immediately
    this.validateCloudLicense().then(result => {
      if (!result.is_valid && result.status === 'suspended') {
        this.handleSuspendedLicense(result.suspension_reason);
      }
    });

    // Set up periodic validation
    this.heartbeatTimer = setInterval(async () => {
      const result = await this.validateCloudLicense();

      if (!result.is_valid) {
        if (result.status === 'suspended') {
          this.handleSuspendedLicense(result.suspension_reason);
        } else if (result.status === 'expired') {
          this.handleExpiredLicense();
        } else if (result.status === 'revoked') {
          this.handleRevokedLicense();
        }
      }
    }, this.heartbeatInterval);

  }

  /**
   * Stop periodic validation
   */
  stopPeriodicValidation() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle suspended license
   */
  handleSuspendedLicense(reason) {

    this.stopPeriodicValidation();

    // Delete the cloud license file
    this.deleteCloudLicense();

    // Don't quit the app - let the UI handle showing the error
    // The LicenseContext will detect the missing/invalid license and show the registration form
  }

  /**
   * Handle expired license
   */
  handleExpiredLicense() {

    this.stopPeriodicValidation();

    // Delete the cloud license file
    this.deleteCloudLicense();

    // Don't quit the app - let the UI handle showing the error
  }

  /**
   * Handle revoked license
   */
  handleRevokedLicense() {

    this.stopPeriodicValidation();

    // Delete the cloud license file
    this.deleteCloudLicense();

    // Don't quit the app - let the UI handle showing the error
  }
}

module.exports = new CloudLicenseService();

