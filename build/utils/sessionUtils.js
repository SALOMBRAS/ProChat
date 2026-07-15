/**
 * Session utility functions for consistent session handling across modules
 */

/**
 * Determines if a session is connected and available for use
 * @param {Object} session - Session object from getSessions()
 * @returns {boolean} - True if session is connected and ready
 */
const isSessionConnected = (session) => {
  if (!session) return false;

  // If isLoggedIn is explicitly true, consider the session connected
  // This handles cases where the session is in 'connecting' state during silent reconnect
  // but is actually logged in and functional
  if (session.isLoggedIn === true) {
    return true;
  }

  // Check real-time status
  if (session.realTimeStatus === 'connected') {
    return true;
  }

  // Fallback to database status
  return session.status === 'connected';
};

/**
 * Filters sessions to only return connected and available ones
 * @param {Array} sessions - Array of session objects
 * @returns {Array} - Filtered array of connected sessions
 */
const getConnectedSessions = (sessions) => {
  if (!Array.isArray(sessions)) {
    return [];
  }
  
  return sessions.filter(isSessionConnected);
};

/**
 * Gets the display name for a session
 * @param {Object} session - Session object
 * @returns {string} - Display name for the session
 */
const getSessionDisplayName = (session) => {
  if (!session) return 'Unknown Session';
  
  // Try different name properties in order of preference
  return session.name || 
         session.deviceName || 
         session.device_name || 
         session.sessionId || 
         session.session_id || 
         session.id || 
         'Unknown Session';
};

/**
 * Gets the session ID for a session (handles different property names)
 * @param {Object} session - Session object
 * @returns {string} - Session ID
 */
const getSessionId = (session) => {
  if (!session) return null;
  
  return session.sessionId || 
         session.session_id || 
         session.id;
};

/**
 * Logs session debugging information
 * @param {Array} sessions - Array of session objects
 * @param {string} moduleName - Name of the module for logging
 */
const debugSessions = (sessions, moduleName = 'Unknown') => {
  // Debug function disabled for production
  // No-op to prevent console clutter
};

// ES6 exports for React components
export {
  isSessionConnected,
  getConnectedSessions,
  getSessionDisplayName,
  getSessionId,
  debugSessions
};

// CommonJS exports for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isSessionConnected,
    getConnectedSessions,
    getSessionDisplayName,
    getSessionId,
    debugSessions
  };
}
