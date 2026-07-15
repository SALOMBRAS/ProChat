const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * NewLic License Service with Encryption & Tamper Detection
 * Validates licenses against the NewLic backend API
 * Stores license data encrypted with AES-256-GCM
 */
class NewLicLicenseService {
  constructor() {
    // Use encrypted file-based storage
    const userDataPath = app.getPath('userData');
    this.storePath = path.join(userDataPath, 'newlic-license.enc'); // Changed to .enc
    this.machineIdPath = path.join(userDataPath, 'machine-id.enc'); // Changed to .enc
    this.apiUrl = process.env.NEWLIC_API_URL || 'https://127.0.0.1/api';
    this.LICENSE_SECRET = 'LEADWAVE-2025-ULTRA-SECURE-LICENSE-KEY-CHANGE-THIS-IN-PRODUCTION-XYZ789';

    // Initialize encryption
    this.encryptionKey = this._deriveEncryptionKey();
    this.algorithm = 'aes-256-gcm';
    this.ivLength = 16;

    // Load encrypted store
    this.store = this._loadStore();
  }

  /**
   * Derive hardware-based encryption key (machine-specific)
   */
  _deriveEncryptionKey() {
    try {
      const hwFingerprint = this._getHardwareFingerprint();

      // Use PBKDF2 with 100k iterations for strong key derivation
      const key = crypto.pbkdf2Sync(
        hwFingerprint,
        'LEADWAVE_NEWLIC_SALT_2025',
        100000,
        32, // 256 bits
        'sha512'
      );

      return key;
    } catch (error) {
      console.error('Error deriving encryption key:', error);
      // Fallback key (less secure but functional)
      const os = require('os');
      return crypto.pbkdf2Sync(
        os.hostname() + os.platform(),
        'LEADWAVE_FALLBACK_SALT',
        100000,
        32,
        'sha512'
      );
    }
  }

  /**
   * Get hardware fingerprint for machine-specific encryption
   */
  _getHardwareFingerprint() {
    const os = require('os');
    const { execSync } = require('child_process');
    const components = [];

    try {
      if (process.platform === 'win32') {
        // Windows: CPU ID + Motherboard Serial + BIOS Serial
        const cpuId = execSync('wmic cpu get processorid', { encoding: 'utf8' }).split('\n')[1].trim();
        const mbSerial = execSync('wmic baseboard get serialnumber', { encoding: 'utf8' }).split('\n')[1].trim();
        components.push(cpuId, mbSerial);
      } else if (process.platform === 'darwin') {
        // macOS: Hardware UUID
        const hwUUID = execSync('system_profiler SPHardwareDataType | grep "Hardware UUID"', { encoding: 'utf8' }).split(':')[1].trim();
        components.push(hwUUID);
      } else {
        // Linux: machine-id
        const machineId = execSync('cat /etc/machine-id || cat /var/lib/dbus/machine-id', { encoding: 'utf8' }).trim();
        components.push(machineId);
      }
    } catch (error) {
      // Fallback to basic identifiers
      components.push(os.hostname(), os.platform(), os.arch());
    }

    return crypto.createHash('sha256').update(components.join('|')).digest('hex');
  }

  /**
   * Encrypt data with AES-256-GCM (prevents tampering)
   */
  _encrypt(data) {
    try {
      const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);

      let encrypted = cipher.update(plaintext, 'utf8', 'base64');
      encrypted += cipher.final('base64');

      const authTag = cipher.getAuthTag(); // Authentication tag prevents tampering

      const result = {
        iv: iv.toString('base64'),
        data: encrypted,
        tag: authTag.toString('base64'),
        version: '1.0'
      };

      return Buffer.from(JSON.stringify(result)).toString('base64');
    } catch (error) {
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt data - throws TAMPER_DETECTED if data was modified
   */
  _decrypt(encryptedData) {
    try {
      const decoded = JSON.parse(Buffer.from(encryptedData, 'base64').toString('utf8'));
      const iv = Buffer.from(decoded.iv, 'base64');
      const authTag = Buffer.from(decoded.tag, 'base64');
      const encrypted = decoded.data;

      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch (error) {
      // If decryption fails, data was tampered with or wrong machine
      throw new Error('TAMPER_DETECTED');
    }
  }

  /**
   * Load encrypted store from disk
   */
  _loadStore() {
    try {
      if (fs.existsSync(this.storePath)) {
        const encryptedData = fs.readFileSync(this.storePath, 'utf8');
        return this._decrypt(encryptedData);
      }
    } catch (error) {
      if (error.message === 'TAMPER_DETECTED') {
        console.error('🚨 LICENSE TAMPERING DETECTED! Deleting corrupted file.');
        // Delete tampered file
        try {
          fs.unlinkSync(this.storePath);
        } catch (e) {
          // Ignore deletion errors
        }
        throw error; // Re-throw to notify caller
      }
      console.error('Error loading license store:', error);
    }
    return {};
  }

  /**
   * Save encrypted store to disk
   */
  _saveStore() {
    try {
      const encryptedData = this._encrypt(this.store);
      fs.writeFileSync(this.storePath, encryptedData, 'utf8');
    } catch (error) {
      console.error('Error saving license store:', error);
    }
  }

  get(key) {
    return this.store[key];
  }

  set(key, value) {
    this.store[key] = value;
    this._saveStore();
  }

  delete(key) {
    delete this.store[key];
    this._saveStore();
  }

  /**
   * Validate license key cryptographically (offline validation)
   */
  validateLicenseKey(licenseKey) {
    try {

      // Parse license key
      const parts = licenseKey.split('-');

      if (parts.length !== 5 || parts[0] !== 'LW') {
        console.error('❌ NewLic: Invalid format - Expected 5 parts starting with LW, got:', parts.length, 'parts, prefix:', parts[0]);
        return { valid: false, error: 'Invalid license key format' };
      }

      const [prefix, encodedData, expiryHex, checksum, signature] = parts;

      // Verify checksum (using EXACT same logic as backend)
      const checksumData = `${encodedData}-${expiryHex}`;
      const expectedChecksum = crypto.createHash('md5').update(checksumData).digest('hex').substring(0, 4).toUpperCase();

      if (checksum !== expectedChecksum) {
        return { valid: false, error: 'License checksum verification failed' };
      }

      // Verify signature (using EXACT same logic as backend - simple hash, not HMAC)
      const signatureData = checksumData + 'LEADWAVE_SECRET';
      const expectedSignature = crypto.createHash('sha256')
        .update(signatureData)
        .digest('hex')
        .substring(0, 8)
        .toUpperCase();

      if (signature !== expectedSignature) {
        return { valid: false, error: 'License signature verification failed' };
      }

      // Decode data (HEX encoded)
      const decodedString = Buffer.from(encodedData, 'hex').toString('utf8');

      const embeddedData = JSON.parse(decodedString);

      // Check expiry (convert from seconds to milliseconds)
      const expirySeconds = parseInt(expiryHex, 16);
      const expiryTimestamp = expirySeconds * 1000;
      const now = Date.now();

      if (now > expiryTimestamp) {
        return {
          valid: false,
          error: 'License has expired',
          data: embeddedData,
          expires_at: new Date(expiryTimestamp)
        };
      }

      return {
        valid: true,
        data: embeddedData,
        expires_at: new Date(expiryTimestamp)
      };
    } catch (error) {
      return { valid: false, error: `License validation error: ${error.message}` };
    }
  }

  /**
   * Validate license with backend API (online validation with 8-hour caching)
   */
  async validateLicenseWithAPI(licenseKey, machineId) {
    try {
      // Try server validation first
      const response = await axios.post(`${this.apiUrl}/validate-license`, {
        licenseKey,
        machineId
      }, {
        timeout: 5000 // 5 second timeout
      });

      // Server validation successful - cache the result
      if (response.data.valid) {
        this._cacheValidationResult(licenseKey, response.data);
      }

      return response.data;
    } catch (error) {
      console.error('⚠️ API validation error:', error.message);

      // Check if we have a recent cached validation (within 8 hours)
      const cachedResult = this._getCachedValidationResult(licenseKey);

      if (cachedResult) {
        return cachedResult;
      }

      // No valid cache - fall back to offline validation
      return this.validateLicenseKey(licenseKey);
    }
  }

  /**
   * Cache validation result for 8 hours
   */
  _cacheValidationResult(licenseKey, validationData) {
    try {
      const cacheData = {
        validationData: validationData,
        cachedAt: Date.now(),
        expiresAt: Date.now() + (8 * 60 * 60 * 1000) // 8 hours in milliseconds
      };

      this.set('validationCache', cacheData);
    } catch (error) {
      console.error('Failed to cache validation result:', error);
    }
  }

  /**
   * Get cached validation result if still valid (within 8 hours)
   */
  _getCachedValidationResult(licenseKey) {
    try {
      const cacheData = this.get('validationCache');

      if (!cacheData) {
        return null;
      }

      const now = Date.now();

      if (now > cacheData.expiresAt) {

        // Clear expired cache
        this.set('validationCache', null);
        return null;
      }

      const hoursRemaining = ((cacheData.expiresAt - now) / (60 * 60 * 1000)).toFixed(1);

      return cacheData.validationData;
    } catch (error) {
      console.error('Failed to get cached validation:', error);
      return null;
    }
  }

  /**
   * Activate license
   */
  async activateLicense(licenseKey, machineId) {
    try {

      // First validate the license
      const validation = await this.validateLicenseWithAPI(licenseKey, machineId);

      if (!validation.valid) {
        console.error('❌ NewLic: Validation failed:', validation.error);
        return {
          success: false,
          message: validation.error || 'License validation failed'
        };
      }

      // Log the device limit from validation

      // Store license information in newlic-license.json
      this.set('license', {
        key: licenseKey,
        machineId: machineId,
        activatedAt: new Date().toISOString(),
        data: validation.data,
        expiresAt: validation.expires_at
      });

      // Format expiry date
      const expiryDate = new Date(validation.expires_at);
      const formattedExpiry = expiryDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Format plan name
      const planNames = {
        'monthly': 'Monthly Plan',
        'quarterly': 'Quarterly Plan',
        'semi_annual': 'Semi-Annual Plan',
        'annual': 'Annual Plan',
        'lifetime': 'Lifetime Plan',
        'custom': 'Custom Plan',
        'trial_2_days': '2 Days Trial',
        'trial_7_days': '7 Days Trial'
      };
      const planName = planNames[validation.data.plan] || validation.data.plan;

      // ALSO save to main license.enc file (ENCRYPTED) for app-wide license validation
      const { app } = require('electron');
      const licenseDir = app.getPath('userData');
      if (!fs.existsSync(licenseDir)) {
        fs.mkdirSync(licenseDir, { recursive: true });
      }

      const mainLicenseData = {
        license_key: licenseKey,
        customer_name: validation.data.name,
        mobile: validation.data.mobile,
        plan_name: planName,
        plan: validation.data.plan,
        expires_at: validation.expires_at,
        machine_id: machineId,
        activated_at: new Date().toISOString(),
        status: 'active',
        modules: validation.data.modules || [],
        max_devices: validation.data.max_devices || 1, // Extract device limit from license key
        isTrial: validation.data.plan?.includes('trial') || false,
        company_info: validation.data.company_info || null,
        source: 'newlic'
      };

      // Add signature for integrity protection
      const signatureData = JSON.stringify({
        license_key: mainLicenseData.license_key,
        customer_name: mainLicenseData.customer_name,
        expires_at: mainLicenseData.expires_at
      });
      mainLicenseData.signature = crypto.createHash('sha256').update(signatureData + 'LEADWAVE_SECRET').digest('hex');

      // Save encrypted license.enc file (NOT plain JSON)
      const mainLicensePath = path.join(licenseDir, 'license.enc');
      const encryptedLicense = this._encrypt(mainLicenseData);
      fs.writeFileSync(mainLicensePath, encryptedLicense, 'utf8');

      // Delete old unencrypted license.json if it exists
      const oldLicensePath = path.join(licenseDir, 'license.json');
      if (fs.existsSync(oldLicensePath)) {
        fs.unlinkSync(oldLicensePath);
      }

      return {
        success: true,
        message: 'License activated successfully',
        data: {
          customer_name: validation.data.name,
          mobile: validation.data.mobile,
          plan: validation.data.plan,
          plan_name: planName,
          modules: validation.data.modules,
          expires_at: validation.expires_at,
          expires_at_formatted: formattedExpiry,
          license_key: licenseKey,
          company_info: validation.data.company_info
        }
      };
    } catch (error) {
      console.error('License activation error:', error);
      return {
        success: false,
        message: 'Failed to activate license'
      };
    }
  }

  /**
   * Check if license is valid (with tamper detection)
   */
  async checkLicense(machineId) {
    try {
      // Try to load license - will throw TAMPER_DETECTED if file was modified
      let license;
      try {
        license = this.get('license');
      } catch (error) {
        if (error.message === 'TAMPER_DETECTED') {
          console.error('🚨 LICENSE TAMPERING DETECTED during check!');

          // Report tampering to server
          await this._reportTampering(license?.key, machineId);

          // Clear all license data
          this.clearLicense();

          return {
            valid: false,
            message: 'License tampering detected. Please contact support.',
            error_code: 'TAMPER_DETECTED'
          };
        }
        throw error;
      }

      if (!license || !license.key) {
        return {
          valid: false,
          message: 'No license found'
        };
      }

      // Validate the stored license
      const validation = await this.validateLicenseWithAPI(license.key, machineId);

      return validation;
    } catch (error) {
      console.error('License check error:', error);
      return {
        valid: false,
        message: 'License check failed'
      };
    }
  }

  /**
   * Get license information (with tamper detection)
   */
  getLicenseInfo() {
    try {
      return this.get('license');
    } catch (error) {
      if (error.message === 'TAMPER_DETECTED') {
        console.error('🚨 LICENSE TAMPERING DETECTED!');
        this.clearLicense();
        throw new Error('TAMPER_DETECTED');
      }
      return null;
    }
  }

  /**
   * Report tampering to server (blacklist license)
   */
  async _reportTampering(licenseKey, machineId) {
    try {
      await axios.post(`${this.apiUrl}/report-tampering`, {
        licenseKey,
        machineId,
        timestamp: new Date().toISOString()
      }, {
        timeout: 3000
      });
    } catch (error) {
      console.error('Failed to report tampering:', error.message);
      // Continue even if reporting fails
    }
  }

  /**
   * Clear license (delete encrypted files)
   */
  clearLicense() {
    try {
      this.delete('license');

      // Clear validation cache
      this.set('validationCache', null);

      // Also delete the encrypted file
      if (fs.existsSync(this.storePath)) {
        fs.unlinkSync(this.storePath);
      }

    } catch (error) {
      console.error('Error clearing license:', error);
    }
  }

  /**
   * Save encrypted machine ID
   */
  saveMachineId(machineId) {
    try {
      const data = {
        machineId: machineId,
        createdAt: new Date().toISOString(),
        version: '1.0'
      };

      const encryptedData = this._encrypt(data);
      fs.writeFileSync(this.machineIdPath, encryptedData, 'utf8');
      return true;
    } catch (error) {
      console.error('Error saving machine ID:', error);
      return false;
    }
  }

  /**
   * Load encrypted machine ID (with tamper detection)
   */
  loadMachineId() {
    try {
      if (fs.existsSync(this.machineIdPath)) {
        const encryptedData = fs.readFileSync(this.machineIdPath, 'utf8');
        const data = this._decrypt(encryptedData);

        // Validate format
        if (data.machineId && /^[A-F0-9]{16}$/.test(data.machineId)) {
          return data.machineId;
        }
      }
    } catch (error) {
      if (error.message === 'TAMPER_DETECTED') {
        console.error('🚨 MACHINE ID TAMPERING DETECTED! Deleting corrupted file.');
        try {
          fs.unlinkSync(this.machineIdPath);
        } catch (e) {
          // Ignore deletion errors
        }
        throw error;
      }
      console.error('Error loading machine ID:', error);
    }
    return null;
  }
}

module.exports = new NewLicLicenseService();

