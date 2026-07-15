/**
 * Security Configuration
 * 
 * IMPORTANT: In production, these values should come from environment variables
 * or encrypted configuration files, NOT hardcoded in the source code.
 * 
 * For distribution:
 * 1. Use electron-builder's environment variable injection
 * 2. Or use encrypted config files that are decrypted at runtime
 * 3. Never commit actual secrets to version control
 */

// Load environment variables if available
require('dotenv').config();

/**
 * Get configuration value with fallback
 */
function getConfig(key, fallback) {
  // Try environment variable first
  if (process.env[key]) {
    return process.env[key];
  }
  
  // Try encrypted config file (if implemented)
  // const encryptedConfig = loadEncryptedConfig();
  // if (encryptedConfig && encryptedConfig[key]) {
  //   return encryptedConfig[key];
  // }
  
  // Fallback (development only)
  return fallback;
}

/**
 * Security Configuration Object
 * 
 * PRODUCTION DEPLOYMENT:
 * - Set NEWLIC_API_URL environment variable
 * - Set LICENSE_SECRET environment variable (must match backend)
 * - Enable code obfuscation in build process
 */
const securityConfig = {
  // NewLic API URL
  newlicApiUrl: getConfig('NEWLIC_API_URL', 'https://127.0.0.1/api'),
  
  // License validation interval (6 hours in milliseconds)
  validationInterval: parseInt(getConfig('LICENSE_VALIDATION_INTERVAL', '21600000')),
  
  // Offline grace period (7 days in milliseconds)
  offlineGracePeriod: parseInt(getConfig('OFFLINE_GRACE_PERIOD', '604800000')),
  
  // Enable tamper detection
  enableTamperDetection: getConfig('ENABLE_TAMPER_DETECTION', 'true') === 'true',
  
  // Enable code obfuscation (production only)
  enableObfuscation: getConfig('ENABLE_CODE_OBFUSCATION', 'false') === 'true',
  
  // Environment
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',
};

/**
 * Get license secret from secure source
 * 
 * IMPORTANT: This is a placeholder implementation.
 * In production, you should:
 * 1. Store this in an environment variable
 * 2. Or use a secure key management service
 * 3. Or encrypt it and decrypt at runtime
 * 
 * The secret should NEVER be hardcoded in the source code!
 */
function getLicenseSecret() {
  // Try environment variable first
  if (process.env.LICENSE_SECRET) {
    return process.env.LICENSE_SECRET;
  }
  
  // DEVELOPMENT ONLY - This should be removed in production
  if (securityConfig.isDevelopment) {
    return 'LEADWAVE-2025-DEV-SECRET-CHANGE-IN-PRODUCTION';
  }
  
  // Production without secret - this should never happen
  throw new Error('LICENSE_SECRET not configured! Set environment variable.');
}

/**
 * Validate configuration
 */
function validateConfig() {
  const errors = [];
  
  if (securityConfig.isProduction) {
    // Check required production settings
    if (!process.env.NEWLIC_API_URL) {
      errors.push('NEWLIC_API_URL environment variable not set');
    }
    
    if (!process.env.LICENSE_SECRET) {
      errors.push('LICENSE_SECRET environment variable not set');
    }
    
    if (errors.length > 0) {
      console.error('❌ Security configuration errors:');
      errors.forEach(err => console.error('  -', err));
      throw new Error('Invalid security configuration for production');
    }
  }
  
  return true;
}

// Validate on load (only in production)
if (securityConfig.isProduction) {
  try {
    validateConfig();
  } catch (error) {
    console.error('❌ Security configuration validation failed:', error.message);
  }
}

module.exports = {
  ...securityConfig,
  getLicenseSecret,
  validateConfig
};

