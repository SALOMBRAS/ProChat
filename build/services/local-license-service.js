const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Local License Service
 * Replaces Laravel API endpoints with local validation
 */
class LocalLicenseService {
  constructor() {
    this.keygenDbPath = this.getKeygenDbPath();
  }

  /**
   * Get path to Keygen database
   */
  getKeygenDbPath() {
    const keygenPath = path.join(os.homedir(), 'LeadWave-Keygen');
    return path.join(keygenPath, 'licenses.json');
  }

  /**
   * Load licenses from Keygen database
   */
  loadKeygenLicenses() {
    if (fs.existsSync(this.keygenDbPath)) {
      try {
        const data = fs.readFileSync(this.keygenDbPath, 'utf8');
        return JSON.parse(data);
      } catch (error) {
        console.error('Error loading Keygen licenses:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Save licenses to Keygen database
   */
  saveKeygenLicenses(licenses) {
    try {
      const keygenDir = path.dirname(this.keygenDbPath);
      if (!fs.existsSync(keygenDir)) {
        fs.mkdirSync(keygenDir, { recursive: true });
      }
      fs.writeFileSync(this.keygenDbPath, JSON.stringify(licenses, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving Keygen licenses:', error);
      return false;
    }
  }

  /**
   * Validate license key format
   */
  validateLicenseKeyFormat(licenseKey) {
    const pattern = /^LW-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;
    
    if (!pattern.test(licenseKey)) {
      return false;
    }
    
    const parts = licenseKey.split('-');
    const segments = parts.slice(1, 4); // Get the 3 middle segments
    const providedChecksum = parts[4];
    
    // Recalculate checksum
    const combined = segments.join('');
    const calculatedChecksum = crypto.createHash('md5').update(combined).digest('hex').substring(0, 4).toUpperCase();
    
    return providedChecksum === calculatedChecksum;
  }

  /**
   * Generate machine-specific activation code
   */
  generateActivationCode(licenseKey, machineId) {
    const combined = `${licenseKey}-${machineId}`;
    return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16).toUpperCase();
  }

  /**
   * Check license status (replaces /api/v1/license/status)
   */
  async checkLicenseStatus(licenseKey) {
    try {
      // First try self-contained license validation (new format)
      const selfContainedResult = this.validateSelfContainedLicense(licenseKey);
      if (selfContainedResult.success) {
        return {
          success: true,
          data: {
            status: selfContainedResult.status,
            expires_at: selfContainedResult.expires_at,
            customer_name: selfContainedResult.customer_name,
            plan_type: selfContainedResult.plan_type
          }
        };
      }

      // Fallback to old format validation
      if (!this.validateLicenseKeyFormat(licenseKey)) {
        return {
          success: false,
          error: 'Invalid license key format',
          error_code: 'INVALID_FORMAT'
        };
      }

      // Try to load from Keygen database (admin machine)
      const licenses = this.loadKeygenLicenses();
      let license = licenses.find(l => l.license_key === licenseKey);

      if (!license) {
        return {
          success: false,
          error: 'License not found',
          error_code: 'LICENSE_NOT_FOUND'
        };
      }

      const now = new Date();
      const expiresAt = new Date(license.expires_at);
      const isExpired = now > expiresAt;

      return {
        success: true,
        data: {
          status: isExpired ? 'expired' : license.status,
          is_activated: license.activations.length > 0,
          can_be_activated: !isExpired && license.status === 'active',
          expires_at: license.expires_at,
          customer_name: license.customer_name,
          plan_type: license.plan_type
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        error_code: 'STATUS_CHECK_ERROR'
      };
    }
  }

  /**
   * Activate license (replaces /api/v1/license/activate)
   */
  async activateLicense(licenseKey, machineId, appVersion) {
    try {
      // First try self-contained license validation
      const selfContainedResult = this.validateSelfContainedLicense(licenseKey);
      if (selfContainedResult.success) {
        // Check if this self-contained license has already been activated on this machine
        const activationCheck = this.checkSelfContainedLicenseActivation(licenseKey, machineId);
        if (activationCheck.alreadyActivated) {
          return {
            success: false,
            message: 'This license key has already been activated on this machine. Each license can only be activated once per machine.',
            error_code: 'LICENSE_ALREADY_ACTIVATED'
          };
        }

        // Calculate days remaining and validity days for self-contained licenses
        const now = new Date();
        const expiresAt = new Date(selfContainedResult.expires_at);
        const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        const validityDays = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

        // Record the activation for self-contained licenses
        this.recordSelfContainedLicenseActivation(licenseKey, machineId, appVersion);

        // Self-contained licenses don't need database storage for activation
        return {
          success: true,
          data: {
            license_key: licenseKey,
            customer_name: selfContainedResult.customer_name,
            plan_name: selfContainedResult.plan_type,
            plan_type: selfContainedResult.plan_type,
            expires_at: selfContainedResult.expires_at,
            expires_at_formatted: new Date(selfContainedResult.expires_at).toLocaleDateString(),
            status: selfContainedResult.status,
            days_remaining: daysRemaining,
            validity_days: validityDays,
            is_trial: false,
            isTrial: false,
            isValid: true,
            modules: selfContainedResult.modules || [],
            company_info: selfContainedResult.company_info || null
          }
        };
      }

      // Fallback to Keygen database validation (for admin machines or old format licenses)
      if (!this.validateLicenseKeyFormat(licenseKey)) {
        return {
          success: false,
          message: 'Invalid license key format',
          error_code: 'INVALID_FORMAT'
        };
      }

      const licenses = this.loadKeygenLicenses();
      const licenseIndex = licenses.findIndex(l => l.license_key === licenseKey);

      if (licenseIndex === -1) {
        return {
          success: false,
          message: 'Failed to activate license. Please ensure the Keygen app is installed and has the license database. If you are using a license generated on another computer, make sure you are using the correct license key format.',
          error_code: 'LICENSE_NOT_FOUND'
        };
      }

      const license = licenses[licenseIndex];
      const now = new Date();
      const expiresAt = new Date(license.expires_at);

      if (now > expiresAt) {
        return {
          success: false,
          message: 'License has expired',
          error_code: 'LICENSE_EXPIRED'
        };
      }

      if (license.status !== 'active') {
        return {
          success: false,
          message: `License is ${license.status}`,
          error_code: 'LICENSE_INACTIVE'
        };
      }

      // Check if machine is already activated
      const existingActivation = license.activations.find(a => a.machine_id === machineId);
      
      if (!existingActivation) {
        // Add new activation
        license.activations.push({
          machine_id: machineId,
          activation_code: this.generateActivationCode(licenseKey, machineId),
          activated_at: now.toISOString(),
          app_version: appVersion
        });

        licenses[licenseIndex] = license;
        this.saveKeygenLicenses(licenses);
      }

      const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

      return {
        success: true,
        data: {
          license_key: license.license_key,
          customer_name: license.customer_name,
          plan_name: license.plan_type,
          plan_type: license.plan_type,
          expires_at: license.expires_at,
          expires_at_formatted: license.expires_at_formatted,
          status: license.status,
          days_remaining: daysRemaining,
          is_trial: license.plan_type === 'trial',
          validity_days: license.validity_days,
          modules: license.modules || [], // Include modules from license
          company_info: license.company_info || null // Include company information from license
        }
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        error_code: 'ACTIVATION_ERROR'
      };
    }
  }

  /**
   * Validate license (replaces /api/v1/license/validate and /api/v1/license/validate-legacy)
   */
  async validateLicense(licenseKey, machineId, appVersion) {
    try {
      // First check Laravel system for license status (critical for suspension/revocation)
      try {
        const laravelResult = await this.checkLaravelLicenseStatus(licenseKey, machineId);
        if (laravelResult && laravelResult.data) {
          const status = laravelResult.data.status;
          if (status === 'suspended') {
            return {
              success: false,
              message: 'License has been suspended. Please contact your administrator.',
              error_code: 'LICENSE_SUSPENDED',
              status: 'suspended'
            };
          }
          if (status === 'revoked') {
            return {
              success: false,
              message: 'License has been revoked. Please contact your administrator.',
              error_code: 'LICENSE_REVOKED',
              status: 'revoked'
            };
          }
          if (!laravelResult.data.is_valid) {
            return {
              success: false,
              message: 'License is not valid in the system.',
              error_code: 'LICENSE_INVALID',
              status: status
            };
          }
        }
      } catch (laravelError) {
      }

      // Then try self-contained license validation
      const selfContainedResult = this.validateSelfContainedLicense(licenseKey);
      if (selfContainedResult.success) {
        return {
          success: true,
          data: {
            license_key: licenseKey,
            customer_name: selfContainedResult.customer_name,
            plan_name: selfContainedResult.plan_type,
            expires_at: selfContainedResult.expires_at,
            expires_at_formatted: new Date(selfContainedResult.expires_at).toLocaleDateString(),
            isTrial: false,
            isValid: true,
            status: selfContainedResult.status
          }
        };
      }

      // Fallback to Keygen database validation
      if (!this.validateLicenseKeyFormat(licenseKey)) {
        return {
          success: false,
          message: 'Invalid license key format',
          error_code: 'INVALID_FORMAT'
        };
      }

      const licenses = this.loadKeygenLicenses();
      const license = licenses.find(l => l.license_key === licenseKey);

      if (!license) {
        return {
          success: false,
          message: 'License not found in database',
          error_code: 'LICENSE_NOT_FOUND'
        };
      }

      const now = new Date();
      const expiresAt = new Date(license.expires_at);

      if (now > expiresAt) {
        return {
          success: false,
          message: 'License has expired',
          error_code: 'LICENSE_EXPIRED'
        };
      }

      // Check Laravel system for license status updates
      try {
        await this.checkLaravelLicenseStatus(licenseKey, machineId);
      } catch (error) {
        // If Laravel check fails, continue with local validation
      }

      if (license.status !== 'active') {
        const statusMessages = {
          'suspended': 'License has been suspended. Please contact your administrator.',
          'revoked': 'License has been revoked. Please contact your administrator.',
          'expired': 'License has expired. Please contact your administrator.'
        };

        return {
          success: false,
          message: statusMessages[license.status] || `License is ${license.status}`,
          error_code: license.status === 'suspended' ? 'LICENSE_SUSPENDED' :
                     license.status === 'revoked' ? 'LICENSE_REVOKED' : 'LICENSE_INACTIVE',
          status: license.status
        };
      }

      // Check if machine is activated
      const activation = license.activations.find(a => a.machine_id === machineId);
      
      if (!activation) {
        return {
          success: false,
          message: 'License not activated on this machine',
          error_code: 'NOT_ACTIVATED'
        };
      }

      const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

      return {
        success: true,
        data: {
          license_key: license.license_key,
          customer_name: license.customer_name,
          plan_name: license.plan_type,
          plan_type: license.plan_type,
          expires_at: license.expires_at,
          expires_at_formatted: license.expires_at_formatted,
          status: license.status,
          days_remaining: daysRemaining,
          is_trial: license.plan_type === 'trial',
          isUpgraded: false, // For compatibility
          validity_days: license.validity_days,
          modules: license.modules || [], // Include modules from license
          company_info: license.company_info || null // Include company information from license
        }
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        error_code: 'VALIDATION_ERROR'
      };
    }
  }

  /**
   * Register trial license (replaces /api/v1/trial/register)
   */
  async registerTrial(userData) {
    try {
      // For local system, we'll generate a trial license automatically
      const crypto = require('crypto');
      const uuidv4 = () => crypto.randomUUID();
      const licenseKey = this.generateTrialLicenseKey();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (2 * 24 * 60 * 60 * 1000)); // 2 days

      const license = {
        id: uuidv4(),
        license_key: licenseKey,
        customer_name: userData.name,
        plan_type: 'trial',
        user_license_code: `TRIAL-${Date.now()}`,
        validity_days: 2,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        expires_at_formatted: expiresAt.toLocaleDateString(),
        status: 'active',
        activations: [],
        created_by: 'trial-registration',
        notes: `Trial license for ${userData.name}`
      };

      const licenses = this.loadKeygenLicenses();
      licenses.push(license);
      this.saveKeygenLicenses(licenses);

      return {
        success: true,
        data: {
          license_key: license.license_key,
          customer_name: license.customer_name,
          plan_name: 'trial',
          expires_at: license.expires_at,
          expires_at_formatted: license.expires_at_formatted,
          validity_days: 2
        }
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        error_code: 'TRIAL_REGISTRATION_ERROR'
      };
    }
  }

  /**
   * Check machine activation (replaces /api/v1/license/check-machine)
   */
  async checkMachineActivation(machineId) {
    try {
      const licenses = this.loadKeygenLicenses();

      // Find any license activated on this machine
      const activatedLicense = licenses.find(license =>
        license.activations &&
        license.activations.some(activation => activation.machine_id === machineId)
      );

      if (activatedLicense) {
        return {
          success: true,
          has_license: true,
          license_data: {
            license_key: activatedLicense.license_key,
            customer_name: activatedLicense.customer_name,
            plan_type: activatedLicense.plan_type,
            expires_at: activatedLicense.expires_at,
            status: activatedLicense.status
          }
        };
      }

      return {
        success: true,
        has_license: false,
        message: 'No license found for this machine'
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to check machine activation',
        error_code: 'MACHINE_CHECK_ERROR'
      };
    }
  }

  /**
   * Validate self-contained license (embedded license data)
   * This allows licenses to work without Keygen database present
   */
  validateSelfContainedLicense(licenseKey) {
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

      // Validate hex format for each part
      const encodedData = parts[1];
      const expiryHex = parts[2];
      const checksum = parts[3];
      const signature = parts[4];

      // Check if encoded data is valid hex
      if (!/^[A-F0-9]+$/i.test(encodedData)) {
        return {
          success: false,
          error: `Invalid encoded data format. Contains non-hex characters: ${encodedData}`
        };
      }

      // Check if expiry is valid hex
      if (!/^[A-F0-9]{8}$/i.test(expiryHex)) {
        return {
          success: false,
          error: `Invalid expiry format. Expected 8 hex characters, got: ${expiryHex}`
        };
      }

      // Decode embedded data (hex encoded JSON)
      try {
        const decodedData = Buffer.from(encodedData, 'hex').toString('utf8');
        const licenseData = JSON.parse(decodedData);

        // Verify expiry
        const expiryTimestamp = parseInt(expiryHex, 16);
        const expiryDate = new Date(expiryTimestamp * 1000);
        const now = new Date();

        if (now > expiryDate) {
          return { success: false, error: 'License expired', status: 'expired' };
        }

        // Verify checksum
        const dataToVerify = `${encodedData}-${expiryHex}`;
        const expectedChecksum = crypto.createHash('md5').update(dataToVerify).digest('hex').substring(0, 4).toUpperCase();

        if (checksum !== expectedChecksum) {
          return {
            success: false,
            error: `License checksum invalid. Expected: ${expectedChecksum}, Got: ${checksum}`
          };
        }

        // Verify signature
        const expectedSignature = crypto.createHash('sha256').update(dataToVerify + 'LEADWAVE_SECRET').digest('hex').substring(0, 8).toUpperCase();

        if (signature !== expectedSignature) {
          return {
            success: false,
            error: `License signature invalid. Expected: ${expectedSignature}, Got: ${signature}`
          };
        }

        // Extract company information - support both 'company' and 'company_info' fields
        let companyInfo = null;
        if (licenseData.company_info) {
          companyInfo = licenseData.company_info;
        } else if (licenseData.company) {
          // Handle old format with 'company' field and 'phone' instead of 'mobile'
          companyInfo = {
            name: licenseData.company.name || '',
            email: licenseData.company.email || '',
            mobile: licenseData.company.phone || licenseData.company.mobile || '',
            website: licenseData.company.website || ''
          };
        }

        return {
          success: true,
          status: 'active',
          expires_at: expiryDate.toISOString(),
          customer_name: licenseData.name || 'Licensed User',
          plan_type: licenseData.plan || 'standard',
          modules: licenseData.modules || [], // Extract enabled modules from license
          machine_id: licenseData.machine_id || null, // Extract machine ID if present
          company_info: companyInfo // Extract company information if present
        };

      } catch (decodeError) {
        return {
          success: false,
          error: `Failed to decode license data: ${decodeError.message}. Data: ${encodedData}`
        };
      }

    } catch (error) {
      return { success: false, error: `License validation failed: ${error.message}` };
    }
  }

  /**
   * Generate self-contained license key (for Keygen app)
   */
  generateSelfContainedLicense(customerData, validityDays) {
    try {
      const now = new Date();
      const expiryDate = new Date(now.getTime() + (validityDays * 24 * 60 * 60 * 1000));
      const expiryTimestamp = Math.floor(expiryDate.getTime() / 1000);

      // Create embedded data
      const embeddedData = {
        name: customerData.customerName,
        plan: customerData.planType,
        issued: Math.floor(now.getTime() / 1000)
      };

      // Encode data as hex
      const encodedData = Buffer.from(JSON.stringify(embeddedData)).toString('hex').toUpperCase();
      const expiryHex = expiryTimestamp.toString(16).toUpperCase().padStart(8, '0');

      // Generate checksum
      const dataToSign = `${encodedData}-${expiryHex}`;
      const checksum = crypto.createHash('md5').update(dataToSign).digest('hex').substring(0, 4).toUpperCase();

      // Generate signature (simple hash for now)
      const signature = crypto.createHash('sha256').update(dataToSign + 'LEADWAVE_SECRET').digest('hex').substring(0, 8).toUpperCase();

      return `LW-${encodedData}-${expiryHex}-${checksum}-${signature}`;

    } catch (error) {
      throw new Error('Failed to generate self-contained license');
    }
  }

  /**
   * Generate trial license key
   */
  generateTrialLicenseKey() {
    const prefix = 'LW';
    const segments = [];

    // Generate 3 random segments
    for (let i = 0; i < 3; i++) {
      const segment = crypto.randomBytes(2).toString('hex').toUpperCase();
      segments.push(segment);
    }

    // Calculate checksum for validation
    const combined = segments.join('');
    const checksum = crypto.createHash('md5').update(combined).digest('hex').substring(0, 4).toUpperCase();

    return `${prefix}-${segments.join('-')}-${checksum}`;
  }

  /**
   * Check Laravel system for license status updates
   */
  async checkLaravelLicenseStatus(licenseKey, machineId) {
    try {
      const fetch = require('node-fetch');
      // Production URL
      const apiUrl = 'https://127.0.0.1/api/license/status';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          license_code: licenseKey,
          machine_id: machineId
        }),
        timeout: 5000 // 5 second timeout
      });

      if (!response.ok) {
        if (response.status === 404) {
          // License not found in Laravel system - treat as revoked
          return {
            success: false,
            message: 'License not found in system',
            data: {
              status: 'revoked',
              is_valid: false
            }
          };
        }
        throw new Error(`Laravel API responded with status: ${response.status}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || 'Laravel API returned error');
      }

      // Update local license status if it differs from Laravel
      const laravelStatus = result.data.status;
      if (laravelStatus && ['suspended', 'revoked', 'expired'].includes(laravelStatus)) {
        const licenses = this.loadKeygenLicenses();
        const licenseIndex = licenses.findIndex(l => l.license_key === licenseKey);

        if (licenseIndex !== -1) {
          licenses[licenseIndex].status = laravelStatus;
          this.saveKeygenLicenses(licenses);
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Check if a self-contained license has already been activated on this machine
   */
  checkSelfContainedLicenseActivation(licenseKey, machineId) {
    try {
      const activationsFile = path.join(os.homedir(), 'ChatPro', 'activations.json');

      if (!fs.existsSync(activationsFile)) {
        return { alreadyActivated: false };
      }

      const activations = JSON.parse(fs.readFileSync(activationsFile, 'utf8'));

      // Check if this license key has been activated on this machine
      const existingActivation = activations.find(activation =>
        activation.license_key === licenseKey && activation.machine_id === machineId
      );

      return {
        alreadyActivated: !!existingActivation,
        activation: existingActivation
      };
    } catch (error) {
      return { alreadyActivated: false };
    }
  }

  /**
   * Record activation of a self-contained license
   */
  recordSelfContainedLicenseActivation(licenseKey, machineId, appVersion) {
    try {
      const activationsDir = path.join(os.homedir(), 'ChatPro');
      const activationsFile = path.join(activationsDir, 'activations.json');

      // Ensure directory exists
      if (!fs.existsSync(activationsDir)) {
        fs.mkdirSync(activationsDir, { recursive: true });
      }

      let activations = [];
      if (fs.existsSync(activationsFile)) {
        activations = JSON.parse(fs.readFileSync(activationsFile, 'utf8'));
      }

      // Add new activation record
      const newActivation = {
        license_key: licenseKey,
        machine_id: machineId,
        activated_at: new Date().toISOString(),
        app_version: appVersion
      };

      activations.push(newActivation);

      // Save updated activations
      fs.writeFileSync(activationsFile, JSON.stringify(activations, null, 2));

    } catch (error) {
      // Don't fail the activation if recording fails
    }
  }

  /**
   * Update activation record for a renewed self-contained license
   */
  updateSelfContainedLicenseActivation(licenseKey, machineId, appVersion) {
    try {
      const activationsDir = path.join(os.homedir(), 'ChatPro');
      const activationsFile = path.join(activationsDir, 'activations.json');

      // Ensure directory exists
      if (!fs.existsSync(activationsDir)) {
        fs.mkdirSync(activationsDir, { recursive: true });
      }

      let activations = [];
      if (fs.existsSync(activationsFile)) {
        activations = JSON.parse(fs.readFileSync(activationsFile, 'utf8'));
      }

      // Find existing activation for this machine
      const existingIndex = activations.findIndex(activation =>
        activation.machine_id === machineId
      );

      if (existingIndex !== -1) {
        // Update existing activation with new license key
        activations[existingIndex] = {
          ...activations[existingIndex],
          license_key: licenseKey,
          renewed_at: new Date().toISOString(),
          app_version: appVersion,
          renewal_count: (activations[existingIndex].renewal_count || 0) + 1
        };
      } else {
        // Create new activation record
        const newActivation = {
          license_key: licenseKey,
          machine_id: machineId,
          activated_at: new Date().toISOString(),
          app_version: appVersion,
          renewal_count: 1
        };
        activations.push(newActivation);
      }

      fs.writeFileSync(activationsFile, JSON.stringify(activations, null, 2));
    } catch (error) {
    }
  }
}

module.exports = LocalLicenseService;
