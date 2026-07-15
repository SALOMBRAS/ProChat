/**
 * Encrypted Reseller Configuration Loader
 * 
 * This file loads and decrypts the reseller configuration at runtime.
 * The actual configuration data is stored in encrypted format.
 */

const path = require('path');
const configEncryption = require('../security/config-encryption');

let cachedConfig = null;
let configLoadTime = 0;
const CONFIG_CACHE_DURATION = 300000; // 5 minutes

/**
 * Load and decrypt configuration
 */
function loadEncryptedConfig() {
  try {
    const now = Date.now();
    
    // Return cached config if still valid
    if (cachedConfig && (now - configLoadTime) < CONFIG_CACHE_DURATION) {
      return cachedConfig;
    }
    
    // Load encrypted configuration
    const encryptedConfigPath = path.join(__dirname, 'reseller-config.enc');
    const decryptedConfig = configEncryption.loadEncryptedConfig(encryptedConfigPath);
    
    // Validate configuration structure
    configEncryption.validateConfigStructure(decryptedConfig);
    
    // Cache the configuration
    cachedConfig = decryptedConfig;
    configLoadTime = now;
    
    return decryptedConfig;
  } catch (error) {
    console.error('Failed to load encrypted configuration:', error);
    
    // Fallback to default configuration
    return {
      RESELLER_CODE: null,
      LICENSE_SERVER: {
        base_url: 'https://127.0.0.1',
        api_version: 'api'
      },
      APP_BRANDING: {
        show_reseller_info: false,
        custom_title: 'ChatPro',
        splash_message: null
      }
    };
  }
}

// Export configuration access functions
const RESELLER_CONFIG = loadEncryptedConfig();

function getResellerCode() {
  const config = loadEncryptedConfig();
  return config.RESELLER_CODE;
}

function isResellerBuild() {
  const config = loadEncryptedConfig();
  return config.RESELLER_CODE !== null && config.RESELLER_CODE.trim() !== '';
}

function getResellerInfo() {
  const config = loadEncryptedConfig();
  return config.RESELLER_INFO || {};
}

function getLicenseServerConfig() {
  const config = loadEncryptedConfig();
  return config.LICENSE_SERVER || {
    base_url: 'https://127.0.0.1',
    api_version: 'api'
  };
}

function getAppBranding() {
  const config = loadEncryptedConfig();
  return config.APP_BRANDING || {
    show_reseller_info: false,
    custom_title: null,
    splash_message: null
  };
}

function getTrialRegistrationEndpoint() {
  const serverConfig = getLicenseServerConfig();
  const baseUrl = serverConfig.base_url;
  const version = serverConfig.api_version;

  if (isResellerBuild()) {
    return `${baseUrl}/api/${version}/reseller/trial-license`;
  } else {
    return `${baseUrl}/api/${version}/trial/register`;
  }
}

function prepareTrialRegistrationData(email, phone) {
  return {
    email: email,
    phone: phone,
    machine_id: require('crypto').createHash('sha256').update(require('os').hostname()).digest('hex').substring(0, 32),
    app_version: require('electron').app ? require('electron').app.getVersion() : '1.0.0',
    platform: require('os').platform(),
    reseller_code: getResellerCode()
  };
}

module.exports = {
  RESELLER_CONFIG,
  getResellerCode,
  isResellerBuild,
  getResellerInfo,
  getLicenseServerConfig,
  getAppBranding,
  getTrialRegistrationEndpoint,
  prepareTrialRegistrationData
};
