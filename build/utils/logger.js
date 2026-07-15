/**
 * Development-aware logging utility
 * Only logs in development mode to keep production console clean
 */

let isDevelopmentMode = null;

// Check if we're in development mode
const checkDevelopmentMode = () => {
  // Check multiple indicators for development mode
  if (typeof process !== 'undefined') {
    // Node.js environment
    return process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
  }

  // Browser environment - check for common development indicators
  if (typeof window !== 'undefined') {
    return window.location.hostname === 'localhost' ||
           window.location.hostname === '127.0.0.1' ||
           window.location.protocol === 'file:' ||
           (window.electronAPI && window.electronAPI.isDevelopment);
  }

  // Default to false for production safety
  return false;
};

// Initialize development mode detection
const initLogger = async () => {
  if (isDevelopmentMode === null) {
    try {
      if (window.electronAPI?.utils?.isDevelopment) {
        isDevelopmentMode = await window.electronAPI.utils.isDevelopment();
      } else {
        isDevelopmentMode = checkDevelopmentMode();
      }
    } catch (error) {
      // Fallback: use local detection, default to false for production safety
      isDevelopmentMode = checkDevelopmentMode();
    }
  }
};

// Initialize on module load
initLogger();

/**
 * Development-only console.log
 * @param {...any} args - Arguments to log
 */
const devLog = (...args) => {
  if (isDevelopmentMode === null) {
    isDevelopmentMode = checkDevelopmentMode();
  }
  if (isDevelopmentMode) {
  }
};

/**
 * Development-only console.warn
 * @param {...any} args - Arguments to warn
 */
const devWarn = (...args) => {
  if (isDevelopmentMode === null) {
    isDevelopmentMode = checkDevelopmentMode();
  }
  if (isDevelopmentMode) {
  }
};

/**
 * Development-only console.error
 * @param {...any} args - Arguments to error
 */
const devError = (...args) => {
  if (isDevelopmentMode === null) {
    isDevelopmentMode = checkDevelopmentMode();
  }
  if (isDevelopmentMode) {
    console.error(...args);
  }
};

/**
 * Production-safe error logging - only logs critical errors
 * @param {...any} args - Arguments to error
 */
const logError = (...args) => {
  // Only log critical errors in production
  if (isDevelopmentMode === null) {
    isDevelopmentMode = checkDevelopmentMode();
  }
  if (isDevelopmentMode) {
    console.error(...args);
  }
  // In production, you might want to send to error tracking service instead
};

/**
 * Production-safe warning logging - only logs important warnings
 * @param {...any} args - Arguments to warn
 */
const logWarn = (...args) => {
  // Only log important warnings in production
  if (isDevelopmentMode === null) {
    isDevelopmentMode = checkDevelopmentMode();
  }
  if (isDevelopmentMode) {
  }
  // In production, you might want to send to error tracking service instead
};

/**
 * Silent no-op function for removing logs
 */
const noLog = () => {
  // Do nothing - used to replace console.log calls
};

/**
 * Force re-initialization of development mode detection
 */
const reinitLogger = () => {
  isDevelopmentMode = null;
  initLogger();
};

module.exports = {
  devLog,
  devWarn,
  devError,
  logError,
  logWarn,
  noLog,
  reinitLogger
};
