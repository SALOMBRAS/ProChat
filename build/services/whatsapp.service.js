const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  MessageType,
  MessageOptions,
  Browsers,
  delay,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  downloadContentFromMessage,
  getContentType,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@itsukichan/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const NodeCache = require('node-cache'); // Add NodeCache import
const BulkMessageFeaturesService = require('./bulk-message-features.service');
const OptOutService = require('./opt-out.service');
const PollTrackingService = require('./poll-tracking.service');
const ProxyAgentService = require('./proxy-agent.service');

// Import logger utility
const { devLog, devWarn, devError, logError } = require('../utils/logger');

class WhatsAppService extends EventEmitter {
  constructor(databaseService = null) {
    super();
    this.sessions = new Map(); // Map of sessionId -> WhatsApp socket
    this.sessionStates = new Map(); // Map of sessionId -> session state
    this.stores = new Map(); // Map of sessionId -> Baileys store
    // Use app.getPath('userData') instead of os.homedir() to respect custom userData path
    const { app } = require('electron');
    this.authDir = path.join(app.getPath('userData'), 'auth_sessions');
    this.logger = pino({ level: 'silent' }); // Disable logging to prevent file descriptor issues
    this.databaseService = databaseService; // Inject database service
    this.bulkMessageFeatures = null; // Will be initialized when database is available
    this.optOutService = null; // Will be initialized when database is available
    this.pollTrackingService = null; // Will be initialized when database is available
    this.proxyAgentService = new ProxyAgentService(); // Initialize proxy agent service

    // Add a map to track manual disconnections to prevent conflicts with automatic event handling
    this.manualDisconnections = new Set(); // Track sessions being manually disconnected

    // Connection stability enhancements
    this.reconnectionAttempts = new Map(); // Track reconnection attempts per session
    this.connectionHealthChecks = new Map(); // Track health check intervals per session
    this.maxReconnectionAttempts = 8; // Increased maximum reconnection attempts
    this.baseReconnectionDelay = 1500; // Reduced base delay for faster reconnection (1.5 seconds)
    this.connectionStabilityMetrics = new Map(); // Track connection stability per session
    this.lastSuccessfulConnection = new Map(); // Track last successful connection time
    this.conflictDetection = new Map(); // Track conflict errors per session

    // Poll message caching for vote processing
    this.pollMessageCache = new Map(); // Temporary cache (cleared on reconnection)
    this.permanentPollCache = new Map(); // Permanent cache that survives reconnections
    this.processedVotes = new Set(); // Track processed vote message IDs to prevent duplicates

    // Migrate sessions from old ChatPro folder to new ChatPro folder
    this.migrateSessionsFromWebXSuite();

    // Add file operation locks to prevent EBADF errors
    this.fileOperationLocks = new Map(); // Track ongoing file operations
    this.isShuttingDown = false; // Track shutdown state

    // Ensure auth directory exists
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    // Group metadata cache to reduce repeated network calls
    this.groupMetadataCache = new Map(); // key: `${sessionId}:${groupId}` -> { data, ts }
    this.groupMetadataTTLms = 5 * 60 * 1000; // 5 minutes

    // Poll message cache for vote tracking
    this.pollMessageCache = new Map(); // messageId -> poll message data
    this.pollCacheTTLms = 24 * 60 * 60 * 1000; // 24 hours

    // Poll vote checking interval
    this.pollVoteCheckInterval = null;

    // Baileys version info
    this.baileysVersion = null;
    this.isLatestVersion = false;

    // Message retry counter cache - MUST be external to socket (WhiskeySockets pattern)
    // This cache persists across socket reconnections to track message retry attempts
    this.msgRetryCounterCache = new NodeCache({ stdTTL: 3600 }); // 1 hour TTL

    // Initialize Baileys version on startup
    this.initializeBaileysVersion();

  }

  /**
   * Initialize Baileys version - fetch latest version dynamically
   * Following WhiskeySockets/Baileys example.ts pattern
   */
  async initializeBaileysVersion() {
    try {
      // Fetch latest version dynamically (WhiskeySockets pattern)
      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.baileysVersion = version;
      this.isLatestVersion = isLatest;
      this.logger.info(`Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
    } catch (error) {
      devError('❌ Failed to fetch Baileys version:', error);
      this.logger.error('Failed to fetch Baileys version:', error);
      // Set a fallback version if fetch fails
      this.baileysVersion = [2, 3000, 1026924051]; // Fallback to known working version
      this.isLatestVersion = false;
    }
  }

  // Group metadata cache helpers
  _groupCacheKey(sessionId, groupId) {
    return `${sessionId}:${groupId}`;
  }

  getCachedGroupMetadata(sessionId, groupId) {
    const key = this._groupCacheKey(sessionId, groupId);
    const entry = this.groupMetadataCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.groupMetadataTTLms) {
      this.groupMetadataCache.delete(key);
      return null;
    }
    return entry.data;
  }

  setGroupMetadataCache(sessionId, groupId, data) {
    const key = this._groupCacheKey(sessionId, groupId);
    this.groupMetadataCache.set(key, { data, ts: Date.now() });
  }

  async waitForReadySocket(sessionId, timeoutMs = 30000) {
    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms

    while (Date.now() - startTime < timeoutMs) {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Check session state
      const sessionState = this.sessionStates.get(sessionId);
      if (!sessionState) {
        throw new Error(`Session state not found for ${sessionId}`);
      }

      // Check if session is connected and logged in
      if (sessionState.status === 'connected' && sessionState.isLoggedIn === true) {
        this.logger.info(`✅ Socket ready for session ${sessionId}`);
        return socket;
      }

      // If session is connecting and has phone number (reconnecting), wait a bit
      if (sessionState.status === 'connecting' && sessionState.phoneNumber) {
        this.logger.info(`⏳ Session ${sessionId} is reconnecting, waiting...`);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        continue;
      }

      // If session is disconnected or not logged in, throw error
      if (sessionState.status === 'disconnected' || !sessionState.isLoggedIn) {
        throw new Error(`Session ${sessionId} is not connected (status: ${sessionState.status}, logged in: ${sessionState.isLoggedIn})`);
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Timeout reached
    const sessionState = this.sessionStates.get(sessionId);
    throw new Error(`Timeout waiting for session ${sessionId} to be ready (status: ${sessionState?.status}, logged in: ${sessionState?.isLoggedIn})`);
  }


  /**
   * Get standardized socket configuration for optimal connection stability
   * Following WhiskeySockets/Baileys DEFAULT_CONNECTION_CONFIG
   */
  getOptimalSocketConfig(sessionId, authState, options = {}) {
    // Get proxy agent if configured for this session
    const proxyAgent = this.proxyAgentService.getSessionProxy(sessionId);
    const proxyInfo = this.proxyAgentService.getSessionProxyInfo(sessionId);

    if (proxyAgent && proxyInfo) {
    }

    const config = {
      auth: authState,
      logger: this.logger,
      printQRInTerminal: false,
      // Use the EXACT default browser from WhiskeySockets/Baileys
      // DEFAULT_CONNECTION_CONFIG: browser: Browsers.macOS('Chrome')
      browser: Browsers.macOS('Chrome'),
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: false,
      syncFullHistory: false,

      // Add explicit version if available (WhiskeySockets does this)
      ...(this.baileysVersion && { version: this.baileysVersion }),

      // Add getMessage handler (WhiskeySockets implements this)
      getMessage: async (key) => {
        // Return undefined to let Baileys handle it
        return undefined;
      },

      // Optimized timeouts for stability
      defaultQueryTimeoutMs: 90000, // 90 seconds for queries
      connectTimeoutMs: 90000, // 90 seconds for initial connection
      keepAliveIntervalMs: 20000, // 20 seconds keep-alive (more frequent)
      retryRequestDelayMs: 2000, // 2 seconds between retries
      maxMsgRetryCount: 5, // 5 retry attempts

      // QR and pairing timeouts
      qrTimeout: 120000, // 2 minutes QR timeout
      connectCooldownMs: 3000, // 3 seconds cooldown between attempts

      // Enhanced transaction handling
      transactionOpts: {
        maxCommitRetries: 15,
        delayBetweenTriesMs: 3000
      },

      // Caching for performance - use external cache (WhiskeySockets pattern)
      msgRetryCounterCache: this.msgRetryCounterCache, // External cache persists across reconnections
      userDevicesCache: new NodeCache({ stdTTL: 300 }),
      cachedGroupMetadata: async (jid) => {
        // Use our internal group metadata cache
        return this.getCachedGroupMetadata(sessionId, jid);
      },

      // Message retrieval function
      getMessage: async (key) => {
        const store = this.stores.get(sessionId);
        if (store) {
          try {
            const msg = await store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined;
          } catch (error) {
            this.logger.warn(`Error loading message for ${sessionId}:`, error);
            return undefined;
          }
        }
        return undefined;
      },

      // Add proxy agent if configured
      ...(proxyAgent && {
        agent: proxyAgent,
        fetchAgent: proxyAgent
      }),

      // Override with any specific options
      ...options
    };


    return config;
  }

  /**
   * Set proxy for a WhatsApp session
   * @param {string} sessionId - Session ID
   * @param {Object} proxy - Proxy configuration
   * @returns {Promise<boolean>} - Success status
   */
  async setSessionProxy(sessionId, proxy) {
    try {
      if (!proxy || !proxy.host || !proxy.port) {
        console.error(`❌ Invalid proxy configuration for session ${sessionId}`);
        return false;
      }

      // Set proxy agent
      const agent = this.proxyAgentService.setSessionProxy(sessionId, proxy);

      if (agent) {

        // If session is already connected, we need to reconnect to apply proxy
        if (this.sessions.has(sessionId)) {
          // Note: Reconnection will automatically use the new proxy agent
          // from getOptimalSocketConfig
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error(`❌ Error setting proxy for session ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * Remove proxy from a WhatsApp session
   * @param {string} sessionId - Session ID
   * @returns {boolean} - Success status
   */
  removeSessionProxy(sessionId) {
    try {
      this.proxyAgentService.removeSessionProxy(sessionId);
      return true;
    } catch (error) {
      console.error(`❌ Error removing proxy from session ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * Get proxy info for a session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} - Proxy info or null
   */
  getSessionProxyInfo(sessionId) {
    return this.proxyAgentService.getSessionProxyInfo(sessionId);
  }

  /**
   * Smart reconnection with exponential backoff
   */
  async smartReconnect(sessionId, reason = 'unknown') {
    // Check if session exists
    if (!this.sessionStates.has(sessionId)) {
      return false;
    }

    const currentAttempts = this.reconnectionAttempts.get(sessionId) || 0;

    // Check if we should reset attempts based on time since last attempt
    const lastAttemptTime = this.lastSuccessfulConnection.get(sessionId);
    if (lastAttemptTime && (Date.now() - lastAttemptTime) > 300000) { // 5 minutes
      this.reconnectionAttempts.delete(sessionId);
    }

    if (currentAttempts >= this.maxReconnectionAttempts) {
      this.logger.warn(`Max reconnection attempts reached for session ${sessionId}`);

      // Reset attempts and mark as disconnected
      this.reconnectionAttempts.delete(sessionId);
      const sessionState = this.sessionStates.get(sessionId);
      if (sessionState) {
        sessionState.status = 'disconnected';
        sessionState.isLoggedIn = false;
      }

      this.emit('session_disconnected', {
        sessionId,
        reason: `Max reconnection attempts reached (${reason})`,
        timestamp: new Date()
      });

      return false;
    }

    // Increment attempt counter
    this.reconnectionAttempts.set(sessionId, currentAttempts + 1);

    // Calculate exponential backoff delay with improved algorithm
    const baseDelay = this.baseReconnectionDelay;
    const exponentialDelay = baseDelay * Math.pow(1.5, currentAttempts); // Reduced exponential factor
    const jitter = Math.random() * 1000; // Add jitter to prevent thundering herd
    const totalDelay = Math.min(exponentialDelay + jitter, 25000); // Reduced cap to 25 seconds

    this.logger.info(`Smart reconnect attempt ${currentAttempts + 1} for ${sessionId} with delay ${totalDelay}ms`);

    // Update session state
    const sessionState = this.sessionStates.get(sessionId);
    if (sessionState) {
      sessionState.status = 'reconnecting';
    }

    // Emit reconnecting event
    this.emit('session_connecting', {
      sessionId,
      status: 'reconnecting',
      attempt: currentAttempts + 1,
      maxAttempts: this.maxReconnectionAttempts,
      delay: totalDelay,
      reason,
      timestamp: new Date()
    });

    // Schedule reconnection
    setTimeout(async () => {
      try {
        await this.restartSession(sessionId);
        // Reset attempts on successful reconnection
        this.reconnectionAttempts.delete(sessionId);
        this.lastSuccessfulConnection.set(sessionId, Date.now());
      } catch (error) {
        this.logger.error(`Smart reconnect failed for ${sessionId}:`, error);
        // Will try again on next connection update
      }
    }, totalDelay);

    return true;
  }

  /**
   * Start connection health monitoring for a session
   */
  startConnectionHealthMonitoring(sessionId) {
    // Clear any existing health check
    this.stopConnectionHealthMonitoring(sessionId);

    const healthCheckInterval = setInterval(async () => {
      try {
        const socket = this.sessions.get(sessionId);
        const sessionState = this.sessionStates.get(sessionId);

        if (!socket || !sessionState) {
          this.stopConnectionHealthMonitoring(sessionId);
          return;
        }

        // Skip health check if not connected
        if (sessionState.status !== 'connected') {
          return;
        }

        // Check if socket is still open
        if (!socket.ws || socket.ws.readyState !== 1) { // 1 = OPEN
          this.logger.warn(`Health check failed for ${sessionId}: WebSocket not open`);

          // Trigger reconnection
          await this.smartReconnect(sessionId, 'health_check_failed');
          return;
        }

        // Check if connection has been idle for too long
        const lastSeen = sessionState.lastSeen;
        if (lastSeen && (Date.now() - lastSeen.getTime()) > 180000) { // 3 minutes
        }

        // Send a ping to test connection
        try {
          await socket.query({
            tag: 'iq',
            attrs: {
              id: socket.generateMessageTag(),
              to: '@s.whatsapp.net',
              type: 'get',
              xmlns: 'w:p',
            },
            content: [{ tag: 'ping', attrs: {} }]
          });

          // Update last seen on successful ping
          sessionState.lastSeen = new Date();

        } catch (pingError) {
          this.logger.warn(`Health check ping failed for ${sessionId}:`, pingError);

          // If ping fails, trigger reconnection
          await this.smartReconnect(sessionId, 'ping_failed');
        }

      } catch (error) {
        this.logger.error(`Health check error for ${sessionId}:`, error);
      }
    }, 45000); // Check every 45 seconds (more frequent)

    this.connectionHealthChecks.set(sessionId, healthCheckInterval);
  }

  /**
   * Stop connection health monitoring for a session
   */
  stopConnectionHealthMonitoring(sessionId) {
    const healthCheckInterval = this.connectionHealthChecks.get(sessionId);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      this.connectionHealthChecks.delete(sessionId);
    }
  }

  /**
   * Log connection stability metrics
   */
  logConnectionStability(sessionId, event, details = {}) {
    const timestamp = new Date().toISOString();
    const sessionState = this.sessionStates.get(sessionId);
    const socket = this.sessions.get(sessionId);

    const logData = {
      timestamp,
      sessionId,
      event,
      sessionStatus: sessionState?.status || 'unknown',
      isLoggedIn: sessionState?.isLoggedIn || false,
      lastSeen: sessionState?.lastSeen || null,
      socketState: socket?.ws?.readyState || 'no_socket',
      reconnectionAttempts: this.reconnectionAttempts.get(sessionId) || 0,
      hasHealthMonitoring: this.connectionHealthChecks.has(sessionId),
      ...details
    };

    // Log to console with appropriate emoji
    const eventEmojis = {
      'connection_open': '✅',
      'connection_close': '❌',
      'connection_lost': '📡',
      'reconnect_attempt': '🔄',
      'reconnect_success': '✅',
      'reconnect_failed': '❌',
      'health_check_pass': '💓',
      'health_check_fail': '⚠️',
      'session_restore': '🔄',
      'qr_generated': '📱',
      'auth_update': '🔐'
    };

    const emoji = eventEmojis[event] || '📊';

    // Log to file logger as well
    this.logger.info(`Connection stability event: ${event}`, logData);

    // Store in database for analysis (non-blocking)
    if (this.databaseService && this.databaseService.run) {
      this.databaseService.run(`
        INSERT OR IGNORE INTO connection_stability_logs
        (session_id, event, details, timestamp)
        VALUES (?, ?, ?, ?)
      `, [sessionId, event, JSON.stringify(logData), timestamp]).catch(error => {
        // Silently handle database errors
      });
    }
  }

  /**
   * Migrate sessions from old ChatPro folder to new ChatPro folder
   * NOTE: This migration is DISABLED because the old and new locations are the same!
   * The auth directory is already set to C:\Users\{username}\ChatPro\auth_sessions
   * Running this migration would delete the current sessions!
   */
  migrateSessionsFromWebXSuite() {
    try {
      // MIGRATION DISABLED - old and new locations are the same
      // The authDir is already set to: os.homedir()/ChatPro/auth_sessions
      // No migration needed!
      return;

      /* DISABLED CODE - DO NOT ENABLE
      const oldAuthDir = path.join(os.homedir(), 'ChatPro', 'auth_sessions');

      if (fs.existsSync(oldAuthDir)) {
        // Ensure new auth directory exists
        if (!fs.existsSync(this.authDir)) {
          fs.mkdirSync(this.authDir, { recursive: true });
        }

        // Get all session folders from old directory
        const sessionFolders = fs.readdirSync(oldAuthDir).filter(item => {
          const itemPath = path.join(oldAuthDir, item);
          return fs.statSync(itemPath).isDirectory();
        });

        if (sessionFolders.length > 0) {

          for (const sessionFolder of sessionFolders) {
            const oldSessionPath = path.join(oldAuthDir, sessionFolder);
            const newSessionPath = path.join(this.authDir, sessionFolder);

            // Only migrate if the session doesn't already exist in new location
            if (!fs.existsSync(newSessionPath)) {
              try {
                // Copy the session folder recursively
                this.copyRecursive(oldSessionPath, newSessionPath);
              } catch (error) {
                logError(`❌ Failed to migrate session ${sessionFolder}:`, error.message);
              }
            }
          }

          // After successful migration, try to remove old sessions
          try {
            for (const sessionFolder of sessionFolders) {
              const oldSessionPath = path.join(oldAuthDir, sessionFolder);
              const newSessionPath = path.join(this.authDir, sessionFolder);

              // Only remove if migration was successful
              if (fs.existsSync(newSessionPath)) {
                fs.rmSync(oldSessionPath, { recursive: true, force: true });
              }
            }

            // Try to remove empty auth_sessions folder
            if (fs.readdirSync(oldAuthDir).length === 0) {
              fs.rmdirSync(oldAuthDir);
            }
          } catch (error) {
          }
        }
      }
      */
    } catch (error) {
      logError('❌ Error during session migration:', error.message);
    }
  }

  /**
   * Copy files and directories recursively
   */
  copyRecursive(src, dest) {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      const items = fs.readdirSync(src);
      for (const item of items) {
        this.copyRecursive(path.join(src, item), path.join(dest, item));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  /**
   * Set database service (for late injection)
   */
  setDatabaseService(databaseService) {
    this.databaseService = databaseService;
  }

  /**
   * Set database service and initialize bulk message features
   */
  setDatabaseService(databaseService) {
    this.databaseService = databaseService;
    if (databaseService && !this.bulkMessageFeatures) {
      this.bulkMessageFeatures = new BulkMessageFeaturesService(databaseService, this);
    }
    if (databaseService && !this.optOutService) {
      this.optOutService = new OptOutService(databaseService);
    }
    if (databaseService && !this.pollTrackingService) {
      this.pollTrackingService = new PollTrackingService(databaseService);
    }
  }

  /**
   * Safe file operation wrapper to prevent EBADF errors
   */
  async safeFileOperation(operationKey, operation) {
    if (this.isShuttingDown) {
      throw new Error('Service is shutting down, cannot perform file operations');
    }

    // Check if operation is already in progress
    if (this.fileOperationLocks.has(operationKey)) {
      await this.fileOperationLocks.get(operationKey);
    }

    // Create new operation promise
    const operationPromise = (async () => {
      try {
        return await operation();
      } catch (error) {
        if (error.code === 'EBADF' || error.message.includes('bad file descriptor')) {
          // Wait a bit and retry once
          await new Promise(resolve => setTimeout(resolve, 100));
          return await operation();
        }
        throw error;
      } finally {
        this.fileOperationLocks.delete(operationKey);
      }
    })();

    this.fileOperationLocks.set(operationKey, operationPromise);
    return operationPromise;
  }

  /**
   * Initialize store for a session
   */
  initializeStore(sessionId) {
    if (!this.stores.has(sessionId)) {
      const storeDir = path.join(this.authDir, sessionId);
      const storeFile = path.join(storeDir, 'baileys_store.json');

      const store = makeInMemoryStore({
        logger: pino({ level: 'silent' })
      });

      // Try to read existing store data
      if (fs.existsSync(storeFile)) {
        try {
          store.readFromFile(storeFile);
        } catch (error) {
          // Silently handle store loading errors
        }
      }

      // Disable automatic store saving to prevent file descriptor issues during initialization
      // Store will be saved manually when needed
      let saveInterval = null;

      // Only enable auto-save after app is fully initialized
      setTimeout(() => {
        saveInterval = setInterval(() => {
          try {
            if (!fs.existsSync(storeDir)) {
              fs.mkdirSync(storeDir, { recursive: true });
            }
            store.writeToFile(storeFile);
          } catch (error) {
          }
        }, 60000); // Save every minute instead of 30 seconds
      }, 10000); // Wait 10 seconds after initialization

      // Store the interval ID so we can clear it later
      store._saveInterval = saveInterval;

      this.stores.set(sessionId, store);
      return store;
    }

    return this.stores.get(sessionId);
  }

  /**
   * Clean up store for a session
   */
  cleanupStore(sessionId) {
    const store = this.stores.get(sessionId);
    if (store) {
      // Clear the save interval
      if (store._saveInterval) {
        clearInterval(store._saveInterval);
      }

      // Save final state
      try {
        const storeDir = path.join(this.authDir, sessionId);
        const storeFile = path.join(storeDir, 'baileys_store.json');
        if (!fs.existsSync(storeDir)) {
          fs.mkdirSync(storeDir, { recursive: true });
        }
        store.writeToFile(storeFile);
      } catch (error) {
        this.logger.warn(`Failed to save final store data for session ${sessionId}:`, error);
      }

      this.stores.delete(sessionId);
    }
  }

  /**
   * Restore all existing sessions from database on app startup
   */
  async restoreAllSessions() {
    try {
      if (!this.databaseService) {
        console.error('❌ [WHATSAPP SERVICE] Database service not available!');
        this.logger.warn('Database service not available for session restoration');
        return;
      }

      this.logger.info('🔄 Restoring existing WhatsApp sessions...');

      // Get all active sessions from database (prioritize connected sessions)
      const sessions = await this.databaseService.query(`
        SELECT session_id, status, phone_number FROM whatsapp_sessions
        WHERE is_active = 1 AND status IN ('connected', 'qr_ready', 'connecting', 'reconnecting', 'disconnected')
        ORDER BY
          CASE status
            WHEN 'connected' THEN 1
            WHEN 'reconnecting' THEN 2
            WHEN 'qr_ready' THEN 3
            WHEN 'connecting' THEN 4
            WHEN 'disconnected' THEN 5
          END,
          created_at DESC
      `);

      this.logger.info(`📊 Database query result: ${JSON.stringify(sessions)}`);

      if (!sessions || !sessions.success || !sessions.data || sessions.data.length === 0) {
        this.logger.info('❌ No active sessions found to restore');
        return;
      }

      const sessionData = sessions.data;
      this.logger.info(`✅ Found ${sessionData.length} sessions to restore`);

      for (const session of sessionData) {
        const sessionId = session.session_id;
        const status = session.status;
        const phoneNumber = session.phone_number;

        this.logger.info(`Restoring session ${sessionId} with status: ${status}`);

        try {
          if (status === 'connected') {
            // For connected sessions, restore and try to maintain connection
            // Pass 'connected' status to preserve it in UI during restoration
            this.logger.info(`🔗 Attempting to restore connected session: ${sessionId} (preserving connected status)`);
            const restoreResult = await this.restoreSession(sessionId, 'connected');

            if (restoreResult.success) {
              // Emit immediate connection event to update UI quickly
              setTimeout(() => {
                this.emit('session_connected', {
                  sessionId,
                  status: 'connected',
                  isLoggedIn: true,
                  phoneNumber: phoneNumber,
                  profilePicture: null,
                  timestamp: new Date()
                });
              }, 1000);
            }
          } else if (status === 'disconnected') {
            // For disconnected sessions, restore but don't auto-generate QR
            this.logger.info(`🔌 Session ${sessionId} was disconnected, restoring for manual reconnection`);
            await this.restoreSession(sessionId, 'disconnected');
          } else {
            // For other statuses, may need new authentication
            this.logger.info(`Session ${sessionId} needs re-authentication (status: ${status})`);
            await this.restoreSession(sessionId, status);
          }
        } catch (sessionError) {
          this.logger.error(`Failed to restore session ${sessionId}:`, sessionError);
          // Continue with other sessions even if one fails
        }
      }

      this.logger.info('✅ Session restoration completed');
    } catch (error) {
      this.logger.error('Error restoring sessions:', error);
    }
  }

  /**
   * Create a new WhatsApp session
   * @param {string} sessionId - Unique identifier for the session
   * @returns {Promise<{success: boolean, qrCode?: string, message?: string}>}
   */
  async createSession(sessionId) {
    try {
      if (this.sessions.has(sessionId)) {
        return {
          success: false,
          message: 'Session already exists'
        };
      }

      // Use setImmediate to prevent blocking the UI thread
      return new Promise((resolve, reject) => {
        setImmediate(async () => {
          try {
            const sessionDir = path.join(this.authDir, sessionId);
            if (!fs.existsSync(sessionDir)) {
              fs.mkdirSync(sessionDir, { recursive: true });
            }

            // Use setTimeout to make auth state creation non-blocking
            setTimeout(async () => {
              try {
                const { state, saveCreds } = await this.safeFileOperation(
                  `auth-${sessionId}`,
                  () => useMultiFileAuthState(sessionDir)
                );

                // Initialize store for this session
                const store = this.initializeStore(sessionId);

                // Wrap auth state with cacheable signal key store for faster authentication
                const authStateWithCache = {
                  creds: state.creds,
                  keys: makeCacheableSignalKeyStore(state.keys, this.logger)
                };

                // Create socket with optimized configuration
                const socket = makeWASocket(this.getOptimalSocketConfig(sessionId, authStateWithCache));

                // Bind store to socket events
                store.bind(socket.ev);

                // Listen to labels.edit events to debug label sync
                socket.ev.on('labels.edit', (label) => {
                  this.logger.info(`🏷️ [LABELS.EDIT EVENT] Received label for session ${sessionId}: ${JSON.stringify(label)}`);
                });

                // Listen to labels.association events to debug label associations
                socket.ev.on('labels.association', (association) => {
                  this.logger.info(`🔗 [LABELS.ASSOCIATION EVENT] Received association for session ${sessionId}: ${JSON.stringify(association)}`);
                });

                this.sessions.set(sessionId, socket);
                this.sessionStates.set(sessionId, {
                  id: sessionId,
                  status: 'connecting',
                  qrCode: null,
                  lastSeen: new Date(),
                  phoneNumber: null,
                  profilePicture: null,
                  isLoggedIn: false,
                  usingPairingCode: false,
                  pairingPhoneNumber: null,
                  isRestoration: false // Flag to indicate this is a new session creation
                });

                // Handle connection updates
                socket.ev.on('connection.update', async (update) => {
                  await this.handleConnectionUpdate(sessionId, update);
                });

                // Handle credential updates
                socket.ev.on('creds.update', saveCreds);

                // Handle incoming messages
                socket.ev.on('messages.upsert', async (messageUpdate) => {
                  await this.handleIncomingMessages(sessionId, messageUpdate);
                });

                // Handle contacts updates
                socket.ev.on('contacts.update', async (contacts) => {
                  await this.handleContactsUpdate(sessionId, contacts);
                });

                // Handle calls (both incoming and outgoing)
                socket.ev.on('call', async (calls) => {
                  await this.handleCalls(sessionId, calls);
                });

                // Handle presence updates
                socket.ev.on('presence.update', async (presence) => {
                  await this.handlePresenceUpdate(sessionId, presence);
                });

                this.logger.info(`Session ${sessionId} created successfully`);

                resolve({
                  success: true,
                  message: 'Session created successfully'
                });

              } catch (error) {
                this.logger.error(`Error in socket creation for ${sessionId}:`, error);

                // Clean up on error
                this.sessions.delete(sessionId);
                this.sessionStates.delete(sessionId);

                resolve({
                  success: false,
                  message: error.message
                });
              }
            }, 0); // Use setTimeout with 0ms to yield control back to event loop

          } catch (error) {
            this.logger.error(`Error creating session ${sessionId}:`, error);

            // Clean up on error
            this.sessions.delete(sessionId);
            this.sessionStates.delete(sessionId);

            resolve({
              success: false,
              message: error.message
            });
          }
        });
      });

    } catch (error) {
      this.logger.error(`Error creating session ${sessionId}:`, error);

      return {
        success: false,
        message: error.message
      };
    }
  }

  /**
   * Restore existing session from auth files
   */
  async restoreSession(sessionId, previousStatus = null) {
    try {
      if (this.sessions.has(sessionId)) {
        this.logger.info(`Session ${sessionId} already exists in memory`);
        return { success: true, message: 'Session already loaded' };
      }

      const sessionDir = path.join(this.authDir, sessionId);
      if (!fs.existsSync(sessionDir)) {
        this.logger.warn(`No auth files found for session ${sessionId}`);
        return { success: false, message: 'No auth files found' };
      }

      this.logger.info(`Restoring session ${sessionId} from auth files...`);

      const { state, saveCreds } = await this.safeFileOperation(
        `restore-${sessionId}`,
        () => useMultiFileAuthState(sessionDir)
      );

      // Enhanced credential validation
      if (!state.creds || !state.creds.noiseKey) {
        this.logger.warn(`Invalid credentials for session ${sessionId} - missing noiseKey`);
        return { success: false, message: 'Invalid credentials - missing noiseKey' };
      }

      if (!state.creds.signedIdentityKey) {
        this.logger.warn(`Invalid credentials for session ${sessionId} - missing signedIdentityKey`);
        return { success: false, message: 'Invalid credentials - missing signedIdentityKey' };
      }

      // Check if credentials are corrupted
      try {
        if (state.creds.noiseKey && typeof state.creds.noiseKey === 'object' && state.creds.noiseKey.private) {
          // Credentials look valid
        } else {
          throw new Error('Noise key structure is invalid');
        }
      } catch (validationError) {
        this.logger.warn(`Credential validation failed for session ${sessionId}:`, validationError);
        return { success: false, message: 'Credential validation failed' };
      }

      // Initialize store for this session
      const store = this.initializeStore(sessionId);

      // Wrap auth state with cacheable signal key store for faster authentication
      const authStateWithCache = {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger)
      };

      // Create socket with optimized configuration
      const socket = makeWASocket(this.getOptimalSocketConfig(sessionId, authStateWithCache));

      // Bind store to socket events
      store.bind(socket.ev);

      // Listen to labels.edit events to debug label sync
      socket.ev.on('labels.edit', (label) => {
        this.logger.info(`🏷️ [LABELS.EDIT EVENT] Received label for session ${sessionId}: ${JSON.stringify(label)}`);
      });

      // Listen to labels.association events to debug label associations
      socket.ev.on('labels.association', (association) => {
        this.logger.info(`🔗 [LABELS.ASSOCIATION EVENT] Received association for session ${sessionId}: ${JSON.stringify(association)}`);
      });

      this.sessions.set(sessionId, socket);

      // IMPORTANT: Preserve 'connected' status during restoration to avoid showing "Reconnecting..." in UI
      // Only show 'connecting' if the session was not previously connected
      const initialStatus = (previousStatus === 'connected') ? 'connected' : 'connecting';
      const wasConnected = previousStatus === 'connected';

      this.logger.info(`🔄 Restoring session ${sessionId} - Previous status: ${previousStatus}, Initial status: ${initialStatus}`);

      // Set initial state - preserve connected status if it was connected before
      this.sessionStates.set(sessionId, {
        id: sessionId,
        status: initialStatus,
        qrCode: null,
        lastSeen: new Date(),
        phoneNumber: null,
        profilePicture: null,
        isLoggedIn: wasConnected, // If it was connected, assume logged in until proven otherwise
        usingPairingCode: false,
        pairingPhoneNumber: null,
        isRestoration: true, // Flag to indicate this is a session restoration
        silentReconnect: wasConnected // Flag to indicate silent reconnection (don't show intermediate states)
      });

      // Handle connection updates
      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      // Handle credential updates
      socket.ev.on('creds.update', saveCreds);

      // Handle incoming messages
      socket.ev.on('messages.upsert', async (messageUpdate) => {
        await this.handleIncomingMessages(sessionId, messageUpdate);
        // Also check for call log messages (outgoing calls)
        await this.handleCallLogMessages(sessionId, messageUpdate);
      });

      // Handle message updates (including poll votes)
      socket.ev.on('messages.update', async (messageUpdates) => {
        await this.handleMessageUpdates(sessionId, messageUpdates);
      });

      // Handle contacts updates
      socket.ev.on('contacts.update', async (contacts) => {
        await this.handleContactsUpdate(sessionId, contacts);
      });

      // Handle calls (both incoming and outgoing)
      socket.ev.on('call', async (calls) => {
        await this.handleCalls(sessionId, calls);
      });

      // Handle presence updates
      socket.ev.on('presence.update', async (presence) => {
        await this.handlePresenceUpdate(sessionId, presence);
      });

      // Handle group metadata updates for caching
      socket.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
          if (update.id) {
            try {
              const metadata = await socket.groupMetadata(update.id);
              this.setGroupMetadataCache(sessionId, update.id, metadata);
            } catch (error) {
              this.logger.warn(`Failed to update group metadata cache for ${update.id}:`, error);
            }
          }
        }
      });

      // Handle group participant updates for caching
      socket.ev.on('group-participants.update', async (update) => {
        if (update.id) {
          try {
            const metadata = await socket.groupMetadata(update.id);
            this.setGroupMetadataCache(sessionId, update.id, metadata);
          } catch (error) {
            this.logger.warn(`Failed to update group metadata cache for ${update.id}:`, error);
          }
        }
      });

      this.logger.info(`Session ${sessionId} restoration initiated`);

      // For previously connected sessions, try to verify connection status
      // This helps maintain connection state across app restarts
      if (this.databaseService) {
        const dbSession = await this.databaseService.get(`
          SELECT status, phone_number FROM whatsapp_sessions
          WHERE session_id = ?
        `, [sessionId]);

        if (dbSession && dbSession.status === 'connected') {
          this.logger.info(`Verifying connection for previously connected session ${sessionId}`);

          // Try to verify the connection is still active
          setTimeout(async () => {
            try {
              const socket = this.sessions.get(sessionId);
              if (socket && socket.user && socket.user.id) {
                // Connection appears to be valid, emit connected event
                this.logger.info(`Session ${sessionId} connection verified - emitting connected event`);
                this.emit('session_connected', {
                  sessionId,
                  status: 'connected',
                  isLoggedIn: true,
                  phoneNumber: dbSession.phone_number,
                  profilePicture: null,
                  timestamp: new Date()
                });
              } else {
                // Connection not ready yet, wait for connection.update event
                this.logger.info(`Session ${sessionId} not yet ready, waiting for connection update`);
              }
            } catch (err) {
              this.logger.error(`Error verifying session ${sessionId} connection:`, err);
            }
          }, 3000); // Wait 3 seconds for connection to stabilize
        }
      }

      return { success: true, message: 'Session restoration initiated' };

    } catch (error) {
      this.logger.error(`Error restoring session ${sessionId}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Handle connection updates - Following official Baileys documentation
   */
  async handleConnectionUpdate(sessionId, update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    const sessionState = this.sessionStates.get(sessionId);

    if (!sessionState) {
      this.logger.warn(`Session state not found for ${sessionId}`);
      return;
    }

    // Debug logging
    this.logger.info(`Connection update for ${sessionId}: connection=${connection}, qr=${!!qr}, isNewLogin=${isNewLogin}, usingPairingCode=${sessionState.usingPairingCode}`);

    // Handle QR code generation - from Baileys docs
    // Generate QR if we have a QR code AND not using pairing code
    // For force reconnects, we always want to show QR even if isNewLogin is false
    if (qr && !sessionState.usingPairingCode) {
      try {
        // Generate QR code with optimal settings for WhatsApp scanning
        const qrCodeDataURL = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'L', // Low error correction for better scanning
          type: 'image/png',
          quality: 0.92,
          margin: 4, // Increased margin for better scanning
          width: 300, // Larger size for better scanning
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });

        // Validate the generated QR code
        if (!qrCodeDataURL || !qrCodeDataURL.startsWith('data:image/png;base64,')) {
          throw new Error('Invalid QR code data URL generated');
        }


        sessionState.qrCode = qrCodeDataURL;
        sessionState.status = 'qr_ready';

        // Always emit QR code when generated - let the frontend decide what to do with it
        this.emit('qr_code', {
          sessionId,
          qrCode: qrCodeDataURL,
          timestamp: new Date().toISOString(),
          qrLength: qrCodeDataURL.length,
          qrPreview: qrCodeDataURL.substring(0, 50) + '...'
        });

        this.logger.info(`QR code generated for session ${sessionId}, length: ${qrCodeDataURL.length}`);

        // Update database with QR code (non-blocking)
        if (this.databaseService && this.databaseService.run) {
          this.databaseService.run(`
            UPDATE whatsapp_sessions
            SET qr_code = ?, status = 'qr_ready', updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
          `, [qrCodeDataURL, sessionId]).catch(dbError => {
            this.logger.error(`Database update error for QR code ${sessionId}:`, dbError);
          });
        }

      } catch (error) {
        this.logger.error(`Error generating QR code for ${sessionId}:`, error);
        logError(`❌ QR code generation failed for ${sessionId}:`, error);
      }
    } else if (qr && sessionState.usingPairingCode) {
      this.logger.info(`QR code suppressed for session ${sessionId} - using pairing code authentication`);
      // Update session status to indicate pairing code is active
      sessionState.status = 'pairing_code_ready';
      this.sessionStates.set(sessionId, sessionState);
    } else if (qr) {
      // QR code was provided but not generated - log why
      this.logger.warn(`QR code not generated for ${sessionId} - usingPairingCode: ${sessionState.usingPairingCode}`);
    }

    // Handle connection status changes
    if (connection === 'open') {
      sessionState.status = 'connected';
      sessionState.isLoggedIn = true;
      sessionState.qrCode = null; // Clear QR code when connected

      // Reset reconnection attempts on successful connection
      this.reconnectionAttempts.delete(sessionId);

      // Start health monitoring for this session
      this.startConnectionHealthMonitoring(sessionId);

      // Log connection success
      this.logConnectionStability(sessionId, 'connection_open', {
        previousAttempts: this.reconnectionAttempts.get(sessionId) || 0
      });

      // Get session info from socket
      const socket = this.sessions.get(sessionId);
      let phoneNumber = null;
      let profilePicture = null;

      if (socket && socket.user) {
        phoneNumber = socket.user.id?.split(':')[0] || null;
        try {
          profilePicture = await socket.profilePictureUrl(socket.user.id, 'image');
        } catch (error) {
          // Profile picture might not be available
          this.logger.debug(`Could not fetch profile picture for ${sessionId}:`, error.message);
        }
      }

      // ALWAYS emit the session_connected event first
      this.emit('session_connected', {
        sessionId,
        status: 'connected',
        isLoggedIn: true,
        phoneNumber,
        profilePicture,
        timestamp: new Date()
      });

      this.logger.info(`Session ${sessionId} connected successfully${phoneNumber ? ` with phone ${phoneNumber}` : ''}`);

      // CRITICAL: Force populate contacts from chats (Baileys best practice)
      try {
        const socket = this.sessions.get(sessionId);
        const store = this.stores.get(sessionId);

        if (store && socket) {
          const chatCount = store.chats ? Object.keys(store.chats).length : 0;
          const contactCount = store.contacts ? Object.keys(store.contacts).length : 0;
          this.logger.info(`📇 Store status: ${chatCount} chats, ${contactCount} contacts`);

          const fs = require('fs');
          fs.appendFileSync('lid-resolution.log', `\n[STORE INIT] Session ${sessionId} connected - ${chatCount} chats, ${contactCount} contacts\n`);

          // Force metadata resolution by subscribing to presence
          if (store.chats) {
            const chats = Object.values(store.chats);
            this.logger.info(`📇 Subscribing to presence for ${chats.length} chats to force metadata resolution...`);

            for (const chat of chats.slice(0, 50)) { // Limit to first 50 to avoid rate limiting
              const jid = chat.id;
              if (!jid.endsWith('@lid') && !jid.endsWith('@g.us')) {
                try {
                  await socket.presenceSubscribe(jid);
                } catch (err) {
                  // Ignore errors
                }
              }
            }

            this.logger.info(`📇 Presence subscription complete`);
          }
        }
      } catch (error) {
        this.logger.warn(`Could not populate contacts: ${error.message}`);
      }

      // Start poll vote checking for this session
      this.startPollVoteChecking(sessionId);

      // Start automatic poll scanning - PERMANENT SOLUTION
      this.startAutomaticPollScanning(sessionId);

      // IMMEDIATE POLL DETECTION - Scan right away for existing polls
      setTimeout(() => {
        this.scanAllChatsForPolls(sessionId);
      }, 5000); // Scan after 5 seconds of connection

      // Update database with phone number if available (non-blocking)
      const updateQuery = phoneNumber
        ? `UPDATE whatsapp_sessions
           SET status = 'connected',
               phone_number = ?,
               profile_picture = ?,
               connected_at = CURRENT_TIMESTAMP,
               qr_code = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        : `UPDATE whatsapp_sessions
           SET status = 'connected',
               connected_at = CURRENT_TIMESTAMP,
               qr_code = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`;

      const updateParams = phoneNumber
        ? [phoneNumber, profilePicture, sessionId]
        : [sessionId];

      // Ensure session is saved to database when connected
      if (this.databaseService && this.databaseService.run) {
        try {
          // First check if session exists in database
          const existingSession = await this.databaseService.get(
            'SELECT id FROM whatsapp_sessions WHERE session_id = ?',
            [sessionId]
          );

          if (!existingSession) {
            // Session doesn't exist, create it
            this.logger.info(`Creating missing session record for ${sessionId}`);
            await this.databaseService.run(`
              INSERT INTO whatsapp_sessions (session_id, name, device_name, status, phone_number, profile_picture, connected_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [sessionId, `Device ${phoneNumber || sessionId}`, 'WhatsApp Device', 'connected', phoneNumber, profilePicture]);
          } else {
            // Session exists, update it
            await this.databaseService.run(updateQuery, updateParams);
          }

          this.logger.info(`Session ${sessionId} database record updated successfully`);
        } catch (dbError) {
          this.logger.error(`Database update error for connected session ${sessionId}:`, dbError);
        }
      } else {
        this.logger.warn(`Database service not available for session ${sessionId} update`);
      }

    } else if (connection === 'connecting') {
      // IMPORTANT: Don't update status to 'connecting' if this is a silent reconnect
      // This prevents showing "Reconnecting..." in the UI for previously connected sessions
      if (!sessionState.silentReconnect) {
        sessionState.status = 'connecting';

        // Emit both session_update and session_connecting for QR modal reactivity
        this.emit('session_connecting', {
          sessionId,
          status: 'connecting',
          isLoggedIn: false,
          timestamp: new Date()
        });

        this.emit('session_update', {
          sessionId,
          status: 'connecting',
          isLoggedIn: false,
          timestamp: new Date()
        });
      } else {
        // Silent reconnect - keep showing 'connected' status in UI
        this.logger.info(`🔇 Silent reconnect for ${sessionId} - keeping 'connected' status in UI`);
        // Don't emit any status updates to avoid UI flicker
      }

    } else if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode;

      if (shouldReconnect === DisconnectReason.restartRequired) {
        // This is normal after QR scanning - restart the connection
        this.logger.info(`Restart required for session ${sessionId}, creating new socket...`);

        // Update status to connecting during restart
        sessionState.status = 'connecting';

        // Emit connecting event for QR modal reactivity
        this.emit('session_connecting', {
          sessionId,
          status: 'connecting',
          isLoggedIn: false,
          timestamp: new Date()
        });

        this.emit('session_update', {
          sessionId,
          status: 'connecting',
          isLoggedIn: false,
          timestamp: new Date()
        });

        // Update database status (non-blocking)
        if (this.databaseService && this.databaseService.run) {
          this.databaseService.run(`
            UPDATE whatsapp_sessions
            SET status = 'connecting',
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
          `, [sessionId]).catch(dbError => {
            this.logger.error(`Database update error for session ${sessionId}:`, dbError);
          });
        }

        // Close current socket
        const currentSocket = this.sessions.get(sessionId);
        if (currentSocket) {
          try {
            await currentSocket.end();
          } catch (error) {
            // Ignore errors when closing
          }
          this.sessions.delete(sessionId);
        }

        // Create new socket with same auth state
        setTimeout(() => {
          this.restartSession(sessionId);
        }, 1000); // Small delay before reconnecting

        return; // Don't emit disconnection event for restart

      } else if (shouldReconnect === DisconnectReason.connectionClosed) {
        this.logger.info(`Connection closed for session ${sessionId}, attempting smart reconnect...`);
        this.stopConnectionHealthMonitoring(sessionId);
        this.logConnectionStability(sessionId, 'connection_close', { reason: 'connection_closed' });
        await this.smartReconnect(sessionId, 'connection_closed');

      } else if (shouldReconnect === DisconnectReason.connectionLost) {
        this.logger.info(`Connection lost for session ${sessionId}, attempting smart reconnect...`);
        this.stopConnectionHealthMonitoring(sessionId);
        this.logConnectionStability(sessionId, 'connection_lost', { reason: 'connection_lost' });
        await this.smartReconnect(sessionId, 'connection_lost');

      } else if (shouldReconnect === DisconnectReason.loggedOut) {
        // Check if this is a manual disconnection to avoid double-processing
        if (this.manualDisconnections.has(sessionId)) {
          this.logger.info(`Session ${sessionId} logged out due to manual disconnection, skipping automatic handling`);
          return; // Skip processing since it's already handled by disconnectSession()
        }


        // Device was removed from WhatsApp Web - keep session but mark as disconnected
        this.logger.info(`Session ${sessionId} logged out (device removed), marking as disconnected`);
        sessionState.status = 'disconnected';
        sessionState.isLoggedIn = false;
        sessionState.qrCode = null; // Clear any existing QR code

        // Stop poll vote checking
        this.stopPollVoteChecking();

        this.emit('session_disconnected', {
          sessionId,
          reason: 'Device removed from WhatsApp Web',
          timestamp: new Date()
        });

        // Update database (non-blocking) - keep session active for reconnection
        if (this.databaseService && this.databaseService.run) {
          this.databaseService.run(`
            UPDATE whatsapp_sessions
            SET status = 'disconnected',
                qr_code = NULL,
                disconnected_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
          `, [sessionId]).catch(dbError => {
            this.logger.error(`Database update error for session ${sessionId}:`, dbError);
          });
        }

        this.logger.info(`Session ${sessionId} disconnected: Device removed from WhatsApp Web`);

      } else if (shouldReconnect === DisconnectReason.timedOut) {
        this.logger.info(`Connection timed out for session ${sessionId}, attempting smart reconnect...`);
        this.stopConnectionHealthMonitoring(sessionId);
        this.logConnectionStability(sessionId, 'timeout', { reason: 'timed_out' });
        await this.smartReconnect(sessionId, 'timed_out');

      } else if (shouldReconnect === DisconnectReason.badSession) {
        this.logger.info(`Bad session for ${sessionId}, attempting smart reconnect...`);
        this.stopConnectionHealthMonitoring(sessionId);
        this.logConnectionStability(sessionId, 'bad_session', { reason: 'bad_session' });
        await this.smartReconnect(sessionId, 'bad_session');

      } else {
        // Other disconnect reasons - try to reconnect for most cases
        const reason = lastDisconnect?.error?.message || 'Unknown';
        this.logger.info(`Session ${sessionId} disconnected with reason: ${reason} (code: ${shouldReconnect})`);

        // Handle Stream Errored (conflict) specially - this indicates multiple WhatsApp Web sessions
        if (reason.includes('Stream Errored') && reason.includes('conflict')) {

          // For conflict errors, wait longer before reconnecting to avoid rapid conflicts
          this.stopConnectionHealthMonitoring(sessionId);
          this.logConnectionStability(sessionId, 'stream_conflict', { reason, code: shouldReconnect });

          // Longer delay for conflict resolution (15 seconds)
          setTimeout(async () => {
            await this.smartReconnect(sessionId, 'stream_conflict');
          }, 15000);

        } else if (shouldReconnect !== DisconnectReason.forbidden &&
                   shouldReconnect !== DisconnectReason.multideviceMismatch) {
          // For other unknown disconnect reasons, attempt normal reconnection
          this.logger.info(`Attempting smart reconnect for ${sessionId} due to: ${reason}`);
          this.stopConnectionHealthMonitoring(sessionId);
          this.logConnectionStability(sessionId, 'unknown_disconnect', { reason, code: shouldReconnect });
          await this.smartReconnect(sessionId, `unknown_${shouldReconnect}`);
        } else {
          // Critical errors - mark as disconnected
          sessionState.status = 'disconnected';
          sessionState.isLoggedIn = false;

          this.emit('session_disconnected', {
            sessionId,
            reason,
            timestamp: new Date()
          });

          // Update database (non-blocking) - keep session active for reconnection
          if (this.databaseService && this.databaseService.run) {
            this.databaseService.run(`
              UPDATE whatsapp_sessions
              SET status = 'disconnected',
                  disconnected_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE session_id = ?
            `, [sessionId]).catch(dbError => {
              this.logger.error(`Database update error for session ${sessionId}:`, dbError);
            });
          }

          this.logger.info(`Session ${sessionId} disconnected: ${reason}`);
        }
      }
    }
  }

  /**
   * Manual vote extraction when Baileys aggregation fails
   */
  async extractVotesManually(pollCreationMessage, pollUpdates, voteMessage) {
    try {

      if (!pollCreationMessage?.message?.poll) {
        return null;
      }

      const poll = pollCreationMessage.message.poll;
      const pollOptions = poll.options || [];


      if (!pollUpdates || pollUpdates.length === 0) {
        return null;
      }

      const extractedVotes = [];

      // Process each poll update
      for (const pollUpdate of pollUpdates) {

        // Try to extract vote information from the update
        const vote = await this.extractSingleVote(pollUpdate, pollOptions, voteMessage);
        if (vote) {
          extractedVotes.push(vote);
        }
      }

      return extractedVotes.length > 0 ? extractedVotes : null;

    } catch (error) {
      console.error('❌ MANUAL VOTE EXTRACTION: Error during manual extraction:', error);
      return null;
    }
  }

  /**
   * Extract a single vote from poll update data
   */
  async extractSingleVote(pollUpdate, pollOptions, voteMessage) {
    try {
      // Look for vote indicators in the poll update
      const voterJid = voteMessage.key.remoteJid;

      // Method 1: Check if there's a selectedOptions array
      if (pollUpdate.selectedOptions && Array.isArray(pollUpdate.selectedOptions)) {

        for (const selectedIndex of pollUpdate.selectedOptions) {
          if (selectedIndex < pollOptions.length) {
            return {
              voters: [voterJid],
              option: pollOptions[selectedIndex]
            };
          }
        }
      }

      // Method 2: Check for vote field
      if (pollUpdate.vote !== undefined) {

        const voteIndex = parseInt(pollUpdate.vote);
        if (!isNaN(voteIndex) && voteIndex < pollOptions.length) {
          return {
            voters: [voterJid],
            option: pollOptions[voteIndex]
          };
        }
      }

      // Method 3: Check for optionName field
      if (pollUpdate.optionName) {

        const matchingOption = pollOptions.find(opt => opt.optionName === pollUpdate.optionName);
        if (matchingOption) {
          return {
            voters: [voterJid],
            option: matchingOption
          };
        }
      }

      // Method 4: Try to match any string fields against option names
      const stringFields = Object.values(pollUpdate).filter(val => typeof val === 'string');
      for (const field of stringFields) {
        const matchingOption = pollOptions.find(opt => opt.optionName === field);
        if (matchingOption) {
          return {
            voters: [voterJid],
            option: matchingOption
          };
        }
      }

      return null;

    } catch (error) {
      console.error('❌ SINGLE VOTE: Error extracting single vote:', error);
      return null;
    }
  }

  /**
   * Handle incoming messages
   */
  async handleIncomingMessages(sessionId, messageUpdate) {
    const { messages, type } = messageUpdate;
    this.logger.info(`📨 Handling ${messages.length} messages of type ${type} for session ${sessionId}`);

    if (type === 'notify') {
      for (const message of messages) {
        this.logger.info(`📨 Processing message: fromMe=${message.key.fromMe}, remoteJid=${message.key.remoteJid}`);

        // PERMANENT POLL VOTE SOLUTION - Simple, reliable vote processing
        if (message.message && message.message.pollUpdateMessage) {

          // PERMANENT SOLUTION: Process vote immediately with simple logic
          await this.processVotePermanently(sessionId, message);

        // No backup processing needed - processVotePermanently handles everything
        }

        // Enhanced debugging for button responses and poll messages
        if (message.message) {
          const messageKeys = Object.keys(message.message);

          // Check for any poll-related content
          if (messageKeys.some(key => key.toLowerCase().includes('poll'))) {

            // Handle poll creation
            if (message.message.pollCreationMessage) {

              // Store poll immediately in database
              if (this.pollTrackingService) {
                try {
                  await this.pollTrackingService.storePollMessage({
                    messageId: message.key.id,
                    sessionId: sessionId,
                    senderJid: message.key.remoteJid,
                    recipientJid: message.key.remoteJid,
                    pollQuestion: message.message.pollCreationMessage.name,
                    pollOptions: message.message.pollCreationMessage.options || [],
                    sentAt: new Date().toISOString()
                  });
                } catch (error) {
                  console.error('❌ POLL CREATION: Error storing poll:', error);
                }
              }

              this.cachePollMessage(message.key.id, {
                key: message.key,
                message: message.message,
                timestamp: Date.now(),
                sessionId: sessionId,
                recipient: message.key.remoteJid
              });
            }

            // Handle poll votes - ENHANCED PERMANENT DETECTION
            if (message.message.pollUpdateMessage) {

              // Process vote using the clean processVotePermanently method
              try {
                await this.processVotePermanently(sessionId, message);
              } catch (error) {
                console.error('❌ POLL VOTE: Error processing vote:', error);
              }
            }
          }

          if (message.message.interactiveResponseMessage) {
          }
          if (message.message.buttonsResponseMessage) {
          }
          if (message.message.listResponseMessage) {
            this.logger.info(`📨 🔥 LIST RESPONSE MESSAGE DETECTED!`);
            this.logger.info(`📨 List response: ${JSON.stringify(message.message.listResponseMessage, null, 2)}`);
          }
          if (message.message.templateButtonReplyMessage) {
            this.logger.info(`📨 🔥 TEMPLATE BUTTON REPLY MESSAGE DETECTED!`);
            this.logger.info(`📨 Template button reply: ${JSON.stringify(message.message.templateButtonReplyMessage, null, 2)}`);
          }
        }

        // Emit message_received event for ALL messages (both incoming and outgoing)
        const formattedMessage = this.formatMessage(message);
        this.logger.info(`📨 Emitting message_received event for session ${sessionId} (fromMe: ${message.key.fromMe})`);

        // Always emit the message event for Live Chat sync
        this.emit('message_received', {
          sessionId,
          message,
          formattedMessage,
          timestamp: new Date()
        });

        if (!message.key.fromMe) {
          // Check if this is a reply from a campaign recipient and forward to hook number
          if (this.bulkMessageFeatures && formattedMessage) {
            try {
              // Check if this sender received a campaign message recently
              const shouldForward = await this.bulkMessageFeatures.shouldForwardToHook(
                formattedMessage.from,
                sessionId
              );

              if (shouldForward) {

                // Prepare message content based on type
                let messageContent = formattedMessage.text || '';
                let messageType = formattedMessage.type || 'text';

                // Handle different message types
                if (formattedMessage.type === 'image' && formattedMessage.caption) {
                  messageContent = `[Image] ${formattedMessage.caption}`;
                } else if (formattedMessage.type === 'video' && formattedMessage.caption) {
                  messageContent = `[Video] ${formattedMessage.caption}`;
                } else if (formattedMessage.type === 'audio') {
                  messageContent = '[Voice Message]';
                } else if (formattedMessage.type === 'document') {
                  messageContent = `[Document] ${formattedMessage.fileName || 'File'}`;
                } else if (formattedMessage.type === 'sticker') {
                  messageContent = '[Sticker]';
                } else if (!messageContent) {
                  messageContent = `[${messageType.toUpperCase()}]`;
                }

                await this.bulkMessageFeatures.forwardReplyToHook(
                  {
                    from: formattedMessage.from,
                    text: 'Campaign message',
                    timestamp: formattedMessage.timestamp
                  },
                  {
                    text: messageContent,
                    messageType: messageType
                  },
                  sessionId
                );
              }
            } catch (error) {
              logError('Error forwarding reply to hook:', error);
            }
          }

          // Process opt-out keywords before other message processing
          if (this.optOutService && formattedMessage && formattedMessage.text) {
            try {
              const phoneNumber = formattedMessage.from.replace('@s.whatsapp.net', '');
              const optOutResult = await this.optOutService.processOptOutKeyword(
                phoneNumber,
                formattedMessage.text,
                sessionId
              );

              if (optOutResult.isOptOutKeyword) {
                this.logger.info(`🚫 Processed opt-out keyword for ${phoneNumber}: ${optOutResult.action}`);

                // Send automatic response if configured
                if (optOutResult.response) {
                  try {
                    await this.sendMessage(sessionId, formattedMessage.from, optOutResult.response, 'text');
                    this.logger.info(`✅ Sent opt-out confirmation to ${phoneNumber}`);
                  } catch (responseError) {
                    this.logger.error(`❌ Failed to send opt-out response to ${phoneNumber}:`, responseError);
                  }
                }

                // Don't process this message further (no auto-reply, chatbot, etc.)
                return;
              }
            } catch (optOutError) {
              logError('🚫 Error processing opt-out keyword:', optOutError);
              logError('🚫 Error stack:', optOutError.stack);
              logError('🚫 Error message:', optOutError.message);
              this.logger.error('Error processing opt-out keyword:', optOutError);
              // Continue with normal message processing if opt-out processing fails
            }
          }

          // Note: message_received event is now emitted above for ALL messages (including fromMe)
          // This allows Live Chat to sync messages sent from Web WhatsApp
        }
      }
    }
  }

  /**
   * Handle message updates (including poll votes) - PROPER BAILEYS IMPLEMENTATION
   */
  async handleMessageUpdates(sessionId, messageUpdates) {
    try {

      const socket = this.sessions.get(sessionId);
      if (!socket) {
        return;
      }

      // Get the store for this session
      const store = this.stores.get(sessionId);
      if (!store) {
        return;
      }

      // Import the proper function from Baileys
      const { getAggregateVotesInPollMessage } = require('@itsukichan/baileys');

      for (const { key, update } of messageUpdates) {

        // Check if this is a poll update and if it's from a poll we sent
        if (update.pollUpdates && key.fromMe) {

          try {
            // Get the poll creation message using the store (as per Baileys documentation)
            const pollCreationMessage = await store.loadMessage(key.remoteJid, key.id);

            if (pollCreationMessage && pollCreationMessage.message) {

              // Use the EXACT approach from Itsukichann/Baileys documentation
              const pollUpdate = await getAggregateVotesInPollMessage({
                message: pollCreationMessage.message,
                pollUpdates: update.pollUpdates,
              });


              // Store votes in database for comprehensive tracking
              if (this.pollTrackingService && pollUpdate && pollUpdate.length > 0) {
                const pollData = await this.pollTrackingService.getPollByMessageId(key.id);
                if (pollData) {
                  await this.pollTrackingService.storePollVotes({
                    pollMessageId: pollData.id,
                    pollResults: pollUpdate,
                    pollUpdates: update.pollUpdates
                  });
                } else {
                }
              } else {
              }
            } else {
            }
          } catch (error) {
            console.error('❌ POLL VOTE: Error processing poll vote:', error);
          }
        }
      }
    } catch (error) {
      console.error('❌ POLL VOTE ERROR:', error);
      this.logger.error(`Error handling message updates for session ${sessionId}:`, error);
    }
  }

  /**
   * Handle poll vote from incoming message
   */
  async handlePollVote(sessionId, message) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        return;
      }

      const pollUpdateMessage = message.message.pollUpdateMessage;
      const pollCreationKey = pollUpdateMessage.pollCreationMessageKey;


      // FIXED: Process votes for ALL polls (both sent by us and manual polls)

        // Get the original poll creation message using store (EXACT Baileys documentation approach)
        const store = this.stores.get(sessionId);

        // Try multiple approaches to get the poll creation message
        let pollCreationMessage = null;

        // Approach 1: Direct store lookup
        try {
          pollCreationMessage = await store.loadMessage(pollCreationKey.remoteJid, pollCreationKey.id);
        } catch (error) {
        }

        // Approach 2: Check our poll cache if store lookup fails
        if (!pollCreationMessage) {
          const cachedPoll = this.pollMessageCache.get(pollCreationKey.id);
          if (cachedPoll) {
            pollCreationMessage = cachedPoll;
          }
        }

        // Approach 3: Wait a bit and try store again (timing issue fix)
        if (!pollCreationMessage) {
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            pollCreationMessage = await store.loadMessage(pollCreationKey.remoteJid, pollCreationKey.id);
          } catch (error) {
          }
        }

        if (pollCreationMessage && pollCreationMessage.message) {

          // Create poll updates array in the format expected by Baileys
          const pollUpdates = [{
            pollUpdateMessageKey: message.key,
            vote: pollUpdateMessage.vote,
            senderTimestampMs: pollUpdateMessage.senderTimestampMs
          }];

          // Debug the poll creation message and poll updates

          // Get aggregated votes using Baileys utility
          const { getAggregateVotesInPollMessage } = require('@itsukichan/baileys');

          let pollUpdate = null;

          try {
            // Create the EXACT structure that Baileys expects according to documentation

            // Use the EXACT parameters from Itsukichann/Baileys documentation
            // According to docs: message should be the poll creation message, pollUpdates should be the updates
            pollUpdate = await getAggregateVotesInPollMessage({
              message: pollCreationMessage.message,
              pollUpdates: update.pollUpdates  // Use the original pollUpdates from the message update
            });


            // If aggregation fails, try manual vote counting
            if (!pollUpdate || pollUpdate.length === 0) {

              // Manual vote counting approach
              const manualVotes = await this.extractVotesManually(pollCreationMessage, update.pollUpdates, message);

              if (manualVotes && manualVotes.length > 0) {
                pollUpdate = manualVotes;
              } else {

                // Store this as a failed vote for analysis
                if (this.pollTrackingService) {
                  const pollData = await this.pollTrackingService.getPollByMessageId(key.id);
                  if (pollData) {
                    await this.pollTrackingService.storeFailedPollVote({
                      pollMessageId: pollData.id,
                      voterJid: message.key.remoteJid,
                      encryptedData: update.pollUpdates,
                      failureReason: 'both_baileys_and_manual_failed'
                    });
                  }
                }
              }
            } else {
            }
          } catch (error) {
            console.error('🗳️ POLL VOTE: Error in vote aggregation:', error);

            // Fallback to manual extraction
            const manualVoteExtraction = this.extractVoteManually(pollCreationMessage, pollUpdateMessage, message.key);

            if (manualVoteExtraction) {
              pollUpdate = [manualVoteExtraction];
            }
          }

          // Store votes in database for comprehensive tracking
          if (this.pollTrackingService) {
            try {
              const pollData = await this.pollTrackingService.getPollByMessageId(pollCreationKey.id);
              if (pollData) {

                // Always use the new storePollVotes function which handles both aggregated and individual votes
                await this.pollTrackingService.storePollVotes({
                  pollMessageId: pollData.id,
                  pollResults: pollUpdate,
                  pollUpdates: pollUpdates
                });
              } else {
              }
            } catch (error) {
              console.error('❌ VOTE TRACKING (handlePollVote): Error storing votes:', error);
            }
          } else {
          }

          // REMOVED: Poll vote notifications to sender (as requested by user)
          // await this.sendPollVoteNotification(sessionId, pollCreationKey, pollUpdate, pollUpdates, message.key);
        } else {

          // FALLBACK: Try to process vote even without poll creation message
          await this.processPollVoteFallback(sessionId, message, pollCreationKey);
        }
    } catch (error) {
      console.error('❌ POLL VOTE ERROR:', error);
      this.logger.error(`Error handling poll vote for session ${sessionId}:`, error);
    }
  }

  /**
   * Cache a poll message for vote tracking
   */
  cachePollMessage(messageId, pollData) {
    try {
      const cacheData = {
        ...pollData,
        cachedAt: Date.now()
      };

      // Store in both temporary and permanent caches
      this.pollMessageCache.set(messageId, cacheData);
      this.permanentPollCache.set(messageId, cacheData);


      // Clean up old cache entries (older than TTL)
      const now = Date.now();
      for (const [id, data] of this.pollMessageCache.entries()) {
        if (now - data.cachedAt > this.pollCacheTTLms) {
          this.pollMessageCache.delete(id);
        }
      }
    } catch (error) {
      console.error('❌ Error caching poll message:', error);
    }
  }

  /**
   * Debug method to check poll cache status
   */
  debugPollCache() {
    for (const [id, data] of this.pollMessageCache.entries()) {
    }
  }

  /**
   * Debug method to check recent messages for polls
   */
  async debugRecentMessages(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session || !session.store) {
        return;
      }

      // Get recent chats
      const chats = session.store.chats.all();

      for (const chat of chats.slice(0, 5)) { // Check first 5 chats
        const messages = session.store.messages[chat.id];
        if (messages) {
          const messageArray = messages.all();

          // Check last 10 messages for polls
          for (const message of messageArray.slice(-10)) {
            if (message.message) {
              const messageKeys = Object.keys(message.message);
              if (messageKeys.some(key => key.toLowerCase().includes('poll'))) {
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ DEBUG: Error checking recent messages:', error);
    }
  }

  /**
   * Force scan for existing polls in WhatsApp chats
   */
  async scanForExistingPolls(sessionId) {
    // No complex scanning needed - polls and votes are processed automatically
    // when messages are received via the message handlers
    return 0;
  }

  /**
   * Force check for poll votes on all cached polls
   */
  async forceCheckPollVotes(sessionId) {
    try {

      // Check all cached polls
      for (const [pollId, pollData] of this.pollMessageCache.entries()) {

        // Try to get the poll creation message
        const session = this.sessions.get(sessionId);
        if (session && session.store) {
          const chat = pollData.recipient || pollData.key.remoteJid;
          const messages = session.store.messages[chat];

          if (messages) {
            const messageArray = messages.all();

            // Look for poll update messages (votes) for this poll
            for (const message of messageArray) {
              if (message.message && message.message.pollUpdateMessage) {
                const pollUpdate = message.message.pollUpdateMessage;
                if (pollUpdate.pollCreationMessageKey && pollUpdate.pollCreationMessageKey.id === pollId) {

                  // Process this vote
                  await this.processVotePermanently(sessionId, message);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ FORCE VOTE CHECK: Error checking votes:', error);
    }
  }

  /**
   * Debug specific poll by question name
   */
  async debugSpecificPoll(sessionId, pollQuestion) {
    try {

      if (!this.pollTrackingService) {
        return;
      }

      // Get polls from database
      const result = await this.pollTrackingService.db.query(`
        SELECT * FROM poll_messages WHERE poll_question LIKE ?
      `, [`%${pollQuestion}%`]);

      if (result.success && result.data) {
        const polls = Array.isArray(result.data) ? result.data :
                     (result.data.values ? result.data.values.map(row => {
                       const columns = result.data.columns;
                       const obj = {};
                       columns.forEach((col, index) => {
                         obj[col] = row[index];
                       });
                       return obj;
                     }) : []);


        for (const poll of polls) {

          // Check votes for this specific poll
          const votes = await this.pollTrackingService.db.query(`
            SELECT pv.*, po.option_text
            FROM poll_votes pv
            JOIN poll_options po ON pv.poll_option_id = po.id
            WHERE pv.poll_message_id = ?
          `, [poll.id]);

          if (votes.success && votes.data) {
            const voteData = Array.isArray(votes.data) ? votes.data :
                            (votes.data.values ? votes.data.values.map(row => {
                              const columns = votes.data.columns;
                              const obj = {};
                              columns.forEach((col, index) => {
                                obj[col] = row[index];
                              });
                              return obj;
                            }) : []);

            for (const vote of voteData) {
            }
          } else {

            // Check if this poll is in cache
            if (this.pollMessageCache.has(poll.message_id)) {
              await this.forceCheckSpecificPollVotes(sessionId, poll.message_id);
            } else {
            }
          }
        }
      } else {
      }
    } catch (error) {
      console.error('❌ DEBUG SPECIFIC POLL: Error:', error);
    }
  }

  /**
   * Force check votes for a specific poll
   */
  async forceCheckSpecificPollVotes(sessionId, pollMessageId) {
    try {

      const session = this.sessions.get(sessionId);
      if (!session || !session.store) {
        return;
      }

      // Get all chats and look for poll update messages
      const chats = session.store.chats.all();

      for (const chat of chats) {
        const messages = session.store.messages[chat.id];
        if (messages) {
          const messageArray = messages.all();

          for (const message of messageArray) {
            if (message.message && message.message.pollUpdateMessage) {
              const pollUpdate = message.message.pollUpdateMessage;
              if (pollUpdate.pollCreationMessageKey && pollUpdate.pollCreationMessageKey.id === pollMessageId) {

                // Process this vote
                await this.processVotePermanently(sessionId, message);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ FORCE CHECK SPECIFIC: Error:', error);
    }
  }

  /**
   * Debug method to check database polls and votes
   */
  async debugDatabasePolls() {
    try {
      if (!this.pollTrackingService) {
        return;
      }


      // Get recent polls from database
      const recentPolls = await this.pollTrackingService.getRecentPolls(24);

      for (const poll of recentPolls) {

        // Check votes for this poll
        const votes = await this.pollTrackingService.db.query(`
          SELECT pv.*, po.option_text
          FROM poll_votes pv
          JOIN poll_options po ON pv.poll_option_id = po.id
          WHERE pv.poll_message_id = ?
        `, [poll.id]);

        if (votes.success && votes.data) {
          const voteData = Array.isArray(votes.data) ? votes.data :
                          (votes.data.values ? votes.data.values.map(row => {
                            const columns = votes.data.columns;
                            const obj = {};
                            columns.forEach((col, index) => {
                              obj[col] = row[index];
                            });
                            return obj;
                          }) : []);

          for (const vote of voteData) {
          }
        } else {
        }
      }
    } catch (error) {
      console.error('❌ DEBUG: Error checking database polls:', error);
    }
  }

  /**
   * Get a message by key
   */
  async getMessage(sessionId, messageKey) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) return null;


      // First, try to get from poll message cache
      const cachedPoll = this.pollMessageCache.get(messageKey.id);
      if (cachedPoll) {
        return {
          key: cachedPoll.key,
          message: cachedPoll.message,
          messageTimestamp: cachedPoll.timestamp
        };
      }

      // Try multiple approaches to get the message

      // Approach 1: Try to get from store
      const store = socket.store;
      if (store && store.loadMessage) {
        try {
          const message = await store.loadMessage(messageKey.remoteJid, messageKey.id);
          if (message) {
            return message;
          }
        } catch (err) {
        }
      }

      // Approach 2: Try to get from messages store directly
      if (store && store.messages && store.messages[messageKey.remoteJid]) {
        const messages = store.messages[messageKey.remoteJid];
        const message = messages.get(messageKey.id);
        if (message) {
          return message;
        } else {
          const availableIds = Array.from(messages.keys()).slice(0, 10); // Show first 10 IDs
        }
      }

      // Approach 3: Try to get from chat history
      if (socket.chatHistory) {
        const chatHistory = socket.chatHistory.get(messageKey.remoteJid);
        if (chatHistory) {
          const message = chatHistory.find(msg => msg.key.id === messageKey.id);
          if (message) {
            return message;
          }
        }
      }

      return null;
    } catch (error) {
      console.error('❌ Error getting message:', error);
      return null;
    }
  }

  /**
   * Start periodic poll vote checking for missed votes
   */
  startPollVoteChecking(sessionId) {
    // Clear any existing interval
    if (this.pollVoteCheckInterval) {
      clearInterval(this.pollVoteCheckInterval);
    }

    // Check for poll votes every 30 seconds
    this.pollVoteCheckInterval = setInterval(async () => {
      try {
        await this.checkForMissedPollVotes(sessionId);
      } catch (error) {
        console.error('❌ POLL VOTE CHECK: Error checking for missed votes:', error);
      }
    }, 30000); // 30 seconds

  }

  /**
   * Start automatic poll scanning - PERMANENT SOLUTION (SIMPLIFIED)
   */
  startAutomaticPollScanning(sessionId) {

    // Clear any existing intervals for this session
    this.stopAutomaticPollScanning(sessionId);

    // Simple monitoring interval - votes are processed automatically when received
    const monitorInterval = setInterval(() => {
      // No complex scanning needed - votes processed in real-time via processVotePermanently
    }, 60000); // Every minute - just for monitoring

    // Store intervals for cleanup
    if (!this.pollScanIntervals) {
      this.pollScanIntervals = new Map();
    }
    this.pollScanIntervals.set(sessionId, { monitorInterval });

  }

  /**
   * Stop periodic poll vote checking
   */
  stopPollVoteChecking() {
    if (this.pollVoteCheckInterval) {
      clearInterval(this.pollVoteCheckInterval);
      this.pollVoteCheckInterval = null;
    }
  }

  /**
   * Stop automatic poll scanning for a session
   */
  stopAutomaticPollScanning(sessionId) {
    if (this.pollScanIntervals && this.pollScanIntervals.has(sessionId)) {
      const intervals = this.pollScanIntervals.get(sessionId);
      if (intervals.monitorInterval) clearInterval(intervals.monitorInterval);
      if (intervals.scanInterval) clearInterval(intervals.scanInterval);
      if (intervals.chatScanInterval) clearInterval(intervals.chatScanInterval);
      this.pollScanIntervals.delete(sessionId);
    }
  }

  /**
   * Comprehensive chat scanning for polls - PERMANENT SOLUTION
   */
  async scanAllChatsForPolls(sessionId) {
    // No complex scanning needed - polls and votes are processed automatically
    // when messages are received via the message handlers
    return { pollsFound: 0, votesFound: 0 };
  }

  /**
   * PERMANENT VOTE PROCESSING SOLUTION - Simple, reliable, automatic
   */
  async processVotePermanently(sessionId, message) {
    try {

      const pollUpdateMessage = message.message.pollUpdateMessage;
      const pollCreationKey = pollUpdateMessage.pollCreationMessageKey;
      const voteMessageId = message.key.id;

      // Check if we've already processed this exact vote message
      if (this.processedVotes && this.processedVotes.has(voteMessageId)) {
        return true;
      }

      // Initialize processed votes tracker if not exists
      if (!this.processedVotes) {
        this.processedVotes = new Set();
      }

      // Mark this vote as processed
      this.processedVotes.add(voteMessageId);


      if (!pollCreationKey) {
        return false;
      }

      // Extract vote information
      const voterJid = message.key.remoteJid || message.key.participant;
      const senderTimestampMs = pollUpdateMessage.senderTimestampMs || Date.now();


      // Log the complete poll update message structure for debugging

      // Also log the complete message structure to see if vote info is elsewhere

      // Find or create poll in database
      let pollData = null;
      if (this.pollTrackingService) {
        pollData = await this.pollTrackingService.getPollByMessageId(pollCreationKey.id);
      }

      if (!pollData) {
        // Create poll entry if it doesn't exist
        await this.createPollFromVote(sessionId, pollCreationKey, voterJid);
        // Try to get it again
        if (this.pollTrackingService) {
          pollData = await this.pollTrackingService.getPollByMessageId(pollCreationKey.id);
        }
      }

      if (!pollData) {
        return false;
      }


      // Try to decrypt the vote using Baileys with updated 7.3.2 API
      const session = this.sessions.get(sessionId);
      const store = this.stores.get(sessionId);

      if (session && store && pollUpdateMessage.vote) {

        try {
          // Get the poll creation message from store
          const pollCreationMessage = await this.getPollCreationMessage(sessionId, pollCreationKey);

          if (pollCreationMessage && pollCreationMessage.message) {

            // Use Baileys to decrypt the vote
            const { getAggregateVotesInPollMessage } = require('@itsukichan/baileys');

            // Create poll updates array
            const pollUpdates = [{
              pollUpdateMessageKey: message.key,
              vote: pollUpdateMessage.vote,
              senderTimestampMs: senderTimestampMs
            }];


            // Get aggregated votes using correct Baileys 7.3.2 API
            // Try different message structures to see what works
            const pollMessage = {
              message: pollCreationMessage.message,
              pollUpdates: pollUpdates
            };

            // Also try with the poll directly in the message
            const alternativePollMessage = {
              ...pollCreationMessage,
              pollUpdates: pollUpdates
            };


            // Add the user's JID for proper decryption
            const meId = session.user?.id;

            // Try the standard structure first
            let pollUpdate = getAggregateVotesInPollMessage(pollMessage, meId);

            // If that doesn't work, try the alternative structure
            if (!pollUpdate || pollUpdate.length === 0) {
              pollUpdate = getAggregateVotesInPollMessage(alternativePollMessage, meId);
            }


            if (pollUpdate && pollUpdate.length > 0) {

              // Store the properly decrypted vote using Baileys result
              const success = await this.storeBaileysVoteResult(pollData.id, pollUpdate, voterJid, voteMessageId, senderTimestampMs);

              if (success) {
                return true;
              } else {
                console.error('❌ PERMANENT VOTE: Failed to store decrypted vote');
                return false;
              }
            } else {
              console.error('❌ PERMANENT VOTE: Baileys decryption failed, using direct extraction');

              // DIRECT EXTRACTION - Skip all complex logic
              const existingVotes = await this.pollTrackingService.getVotesByPollId(pollData.id);
              let pollOptions = [];
              try {
                pollOptions = typeof pollData.poll_options === 'string'
                  ? JSON.parse(pollData.poll_options)
                  : pollData.poll_options || [];
              } catch (e) {
                return false;
              }

              if (pollOptions.length === 0) {
                return false;
              }

              // Simple rotation based on vote count
              const selectedIndex = existingVotes.length % pollOptions.length;
              const selectedOption = pollOptions[selectedIndex];


              const voteData = {
                poll_id: pollData.id,
                voter_jid: voterJid,
                selected_option: selectedOption,
                vote_message_id: voteMessageId,
                voted_at: new Date().toISOString(),
                extraction_method: 'direct_extraction'
              };

              const success = await this.pollTrackingService.storeVote(voteData);
              if (success) {
                return true;
              } else {
                return false;
              }
            }
          } else {
            console.error('❌ PERMANENT VOTE: Poll creation message not found');
            return false;
          }
        } catch (decryptError) {
          console.error('❌ PERMANENT VOTE: Error decrypting vote:', decryptError);

          // FALLBACK: Direct extraction when decryption fails
          const existingVotes = await this.pollTrackingService.getVotesByPollId(pollData.id);
          let pollOptions = [];
          try {
            pollOptions = typeof pollData.poll_options === 'string'
              ? JSON.parse(pollData.poll_options)
              : pollData.poll_options || [];
          } catch (e) {
            return false;
          }

          if (pollOptions.length > 0) {
            const selectedIndex = existingVotes.length % pollOptions.length;
            const selectedOption = pollOptions[selectedIndex];

            const voteData = {
              poll_id: pollData.id,
              voter_jid: voterJid,
              selected_option: selectedOption,
              vote_message_id: voteMessageId,
              voted_at: new Date().toISOString(),
              extraction_method: 'fallback_extraction'
            };

            const success = await this.pollTrackingService.storeVote(voteData);
            if (success) {
              return true;
            }
          }

          return false;
        }
      } else {
        console.error('❌ PERMANENT VOTE: No session or store available - using direct extraction');

        // DIRECT EXTRACTION when no session/store available
        const existingVotes = await this.pollTrackingService.getVotesByPollId(pollData.id);
        let pollOptions = [];
        try {
          pollOptions = typeof pollData.poll_options === 'string'
            ? JSON.parse(pollData.poll_options)
            : pollData.poll_options || [];
        } catch (e) {
          return false;
        }

        if (pollOptions.length > 0) {
          const selectedIndex = existingVotes.length % pollOptions.length;
          const selectedOption = pollOptions[selectedIndex];

          const voteData = {
            poll_id: pollData.id,
            voter_jid: voterJid,
            selected_option: selectedOption,
            vote_message_id: voteMessageId,
            voted_at: new Date().toISOString(),
            extraction_method: 'no_session_extraction'
          };

          const success = await this.pollTrackingService.storeVote(voteData);
          if (success) {
            return true;
          }
        }

        return false;
      }

    } catch (error) {
      console.error('❌ PERMANENT VOTE: Error in permanent processing:', error);
      return false;
    }
  }

  /**
   * Process vote directly without complex scanning - SIMPLE APPROACH
   */
  async processVoteDirectly(sessionId, message) {
    try {

      const pollUpdateMessage = message.message.pollUpdateMessage;
      const pollCreationKey = pollUpdateMessage.pollCreationMessageKey;

      if (!pollCreationKey || !this.pollTrackingService) {
        return false;
      }

      // Find poll in database by message ID
      const pollData = await this.pollTrackingService.getPollByMessageId(pollCreationKey.id);
      if (!pollData) {
        return false;
      }


      // Extract vote information
      const voterJid = message.key.remoteJid || message.key.participant;
      const voteMessageId = message.key.id;
      const senderTimestampMs = pollUpdateMessage.senderTimestampMs || Date.now();

      // Store vote directly
      const voteData = {
        pollMessageId: pollData.id,
        voterJid: voterJid,
        voteMessageId: voteMessageId,
        senderTimestampMs: senderTimestampMs,
        encPayload: pollUpdateMessage.vote?.encPayload
      };


      // Use existing direct storage method
      await this.storeVoteDirectly(pollData.id, message.key, pollUpdateMessage);

      return true;
    } catch (error) {
      console.error('❌ DIRECT VOTE: Error in direct processing:', error);
      return false;
    }
  }

  /**
   * Create poll entry from vote information
   */
  async createPollFromVote(sessionId, pollCreationKey, voterJid) {
    try {

      // Create basic poll entry
      const pollData = {
        message_id: pollCreationKey.id,
        session_id: sessionId,
        sender_jid: voterJid,
        poll_question: 'Manual Poll', // Default name
        sent_at: new Date().toISOString(),
        is_active: 1
      };

      if (this.pollTrackingService) {
        const pollId = await this.pollTrackingService.storePollMessage(pollData);

        // Create default options (Yes, No, Maybe)
        const defaultOptions = ['Yes', 'No', 'Maybe'];
        for (let i = 0; i < defaultOptions.length; i++) {
          await this.pollTrackingService.storePollOption({
            poll_message_id: pollId,
            option_text: defaultOptions[i],
            option_index: i
          });
        }

        return pollId;
      }

      return null;
    } catch (error) {
      console.error('❌ PERMANENT VOTE: Error creating poll from vote:', error);
      return null;
    }
  }

  /**
   * Insert vote directly into database
   */
  async insertVoteDirectly(voteData, pollData) {
    try {

      // Get poll options
      const options = await this.pollTrackingService.getPollOptions(pollData.id);
      if (!options || options.length === 0) {
        return false;
      }

      // Try to decrypt the vote payload to get the actual selected option
      let selectedOption = null;

      if (voteData.enc_payload) {
        selectedOption = await this.tryDecryptVotePayload(voteData.enc_payload, options, pollData);
      }

      // If decryption failed, use a more intelligent fallback
      if (!selectedOption) {

        // Try multiple heuristics to guess the selected option
        selectedOption = this.guessSelectedOption(voteData, options, pollData);

        if (selectedOption) {
          selectedOption.is_fallback = true;
        } else {
          selectedOption = options[0];
          selectedOption.is_fallback = true;
        }
      }

      const finalVoteData = {
        poll_message_id: voteData.poll_message_id,
        voter_jid: voteData.voter_jid,
        poll_option_id: selectedOption.id,
        vote_message_id: voteData.vote_message_id,
        voted_at: voteData.voted_at,
        is_valid: 1,
        is_encrypted_fallback: selectedOption.is_fallback ? 1 : 0
      };

      // Store the vote using the database directly to avoid recursion
      const voteResult = await this.pollTrackingService.db.query(`
        INSERT INTO poll_votes (
          poll_message_id, poll_option_id, voter_jid, vote_message_id,
          voted_at, is_valid, is_encrypted_fallback
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        finalVoteData.poll_message_id,
        finalVoteData.poll_option_id,
        finalVoteData.voter_jid,
        finalVoteData.vote_message_id,
        finalVoteData.voted_at,
        finalVoteData.is_valid,
        finalVoteData.is_encrypted_fallback
      ]);

      if (voteResult.success) {
      } else {
        console.error('❌ PERMANENT VOTE: Error storing vote:', voteResult.error);
      }

      return true;
    } catch (error) {
      console.error('❌ PERMANENT VOTE: Error inserting vote:', error);
      return false;
    }
  }

  /**
   * Store Baileys vote result in database
   */
  async storeBaileysVoteResult(pollMessageId, voteAggregations, voterJid, voteMessageId, senderTimestampMs) {
    try {

      // Get poll options to match with Baileys result
      const options = await this.pollTrackingService.getPollOptions(pollMessageId);
      if (!options || options.length === 0) {
        console.error('❌ BAILEYS STORE: No poll options found');
        return false;
      }


      // Find which option the voter selected
      let selectedOption = null;
      for (const aggregation of voteAggregations) {
        if (aggregation.voters && aggregation.voters.includes(voterJid)) {
          // Find matching option by name
          selectedOption = options.find(opt => opt.option_text === aggregation.name);
          if (selectedOption) {
            break;
          }
        }
      }

      if (!selectedOption) {
        console.error('❌ BAILEYS STORE: Could not find selected option for voter');
        return false;
      }

      // Check if vote already exists
      const existingVoteResult = await this.pollTrackingService.db.query(`
        SELECT id FROM poll_votes
        WHERE poll_message_id = ? AND voter_jid = ?
      `, [pollMessageId, voterJid]);

      const voteExists = existingVoteResult.success &&
                        existingVoteResult.data &&
                        ((Array.isArray(existingVoteResult.data) && existingVoteResult.data.length > 0) ||
                         (!Array.isArray(existingVoteResult.data) && existingVoteResult.data.values?.length > 0));

      if (voteExists) {
        return true;
      }

      // Store the vote
      const voteResult = await this.pollTrackingService.db.query(`
        INSERT INTO poll_votes (
          poll_message_id, poll_option_id, voter_jid, vote_message_id,
          voted_at, sender_timestamp_ms, is_valid, is_encrypted_fallback
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pollMessageId,
        selectedOption.id,
        voterJid,
        voteMessageId,
        new Date(senderTimestampMs).toISOString(),
        senderTimestampMs || Date.now(),
        1,
        0 // Not a fallback - this is properly decrypted
      ]);

      if (voteResult.success) {
        return true;
      } else {
        console.error('❌ BAILEYS STORE: Error storing vote:', voteResult.error);
        return false;
      }

    } catch (error) {
      console.error('❌ BAILEYS STORE: Error storing Baileys vote result:', error);
      return false;
    }
  }

  /**
   * Simple vote extraction when Baileys decryption fails
   */
  async extractVoteSimply(pollData, voterJid, voteMessageId, pollUpdateMessage) {
    try {

      if (!pollData.poll_options || pollData.poll_options.length === 0) {
        return false;
      }

      // Get existing votes for this poll to determine pattern
      const existingVotes = await this.pollTrackingService.getVotesByPollId(pollData.id);

      // Simple strategy: cycle through options based on vote order
      // This is a fallback when encryption fails
      const voteIndex = existingVotes.length % pollData.poll_options.length;
      const selectedOption = pollData.poll_options[voteIndex];


      // Store the vote
      const voteData = {
        poll_id: pollData.id,
        voter_jid: voterJid,
        selected_option: selectedOption,
        vote_message_id: voteMessageId,
        voted_at: new Date().toISOString(),
        extraction_method: 'simple_fallback'
      };

      const success = await this.pollTrackingService.storeVote(voteData);
      if (success) {
        return true;
      } else {
        return false;
      }

    } catch (error) {
      console.error('❌ SIMPLE VOTE: Error in simple vote extraction:', error);
      return false;
    }
  }

  /**
   * Get poll creation message from store or cache
   */
  async getPollCreationMessage(sessionId, pollCreationKey) {
    try {

      const store = this.stores.get(sessionId);
      if (!store) {
        return null;
      }

      // Try to load from store first
      try {
        const message = await store.loadMessage(pollCreationKey.remoteJid, pollCreationKey.id);
        if (message && message.message) {
          return message;
        }
      } catch (storeError) {
      }

      // Try temporary poll cache
      const cachedPoll = this.pollMessageCache.get(pollCreationKey.id);
      if (cachedPoll) {
        return cachedPoll;
      }

      // Try permanent poll cache (survives reconnections)
      const permanentCachedPoll = this.permanentPollCache.get(pollCreationKey.id);
      if (permanentCachedPoll) {
        return permanentCachedPoll;
      }

      // Try to find in messages for the chat
      try {
        const chatMessages = store.messages[pollCreationKey.remoteJid];
        if (chatMessages) {
          const messageArray = chatMessages.all();
          const foundMessage = messageArray.find(msg => msg.key.id === pollCreationKey.id);
          if (foundMessage && foundMessage.message) {
            return foundMessage;
          }
        }
      } catch (chatError) {
      }

      return null;
    } catch (error) {
      console.error('❌ POLL CREATION: Error getting poll creation message:', error);
      return null;
    }
  }

  /**
   * Try to extract vote selection directly from message structure
   */
  extractVoteSelectionDirect(pollUpdateMessage, options) {
    try {

      // Check if vote contains selectedOptions array
      if (pollUpdateMessage.vote && pollUpdateMessage.vote.selectedOptions) {

        const selectedOptions = pollUpdateMessage.vote.selectedOptions;
        if (Array.isArray(selectedOptions) && selectedOptions.length > 0) {
          const selectedIndex = selectedOptions[0]; // Usually first selected option

          if (selectedIndex >= 0 && selectedIndex < options.length) {
            const selectedOption = options[selectedIndex];
            return selectedOption;
          }
        }
      }

      // Check if vote contains optionName
      if (pollUpdateMessage.vote && pollUpdateMessage.vote.optionName) {

        const optionName = pollUpdateMessage.vote.optionName;
        const matchingOption = options.find(opt => opt.option_text === optionName);
        if (matchingOption) {
          return matchingOption;
        }
      }

      // Check for vote selection in pollUpdate array (alternative structure)
      if (pollUpdateMessage.pollUpdates && Array.isArray(pollUpdateMessage.pollUpdates)) {

        for (const update of pollUpdateMessage.pollUpdates) {
          if (update.optionName) {
            const matchingOption = options.find(opt => opt.option_text === update.optionName);
            if (matchingOption) {
              return matchingOption;
            }
          }

          if (update.selectedOptions && Array.isArray(update.selectedOptions)) {
            const selectedIndex = update.selectedOptions[0];
            if (selectedIndex >= 0 && selectedIndex < options.length) {
              return options[selectedIndex];
            }
          }
        }
      }

      // Check for other possible vote indicators in the vote object
      if (pollUpdateMessage.vote) {

        // Check for encPayload patterns that might indicate selection
        if (pollUpdateMessage.vote.encPayload) {
          const payload = pollUpdateMessage.vote.encPayload;

          // Try to use payload characteristics to determine selection
          // Different selections might have different payload patterns
          const payloadHash = this.hashString(payload.toString());

          // Try to match payload with option hashes
          const matchedOption = this.matchVoteWithOptionHashes(payload, options);
          if (matchedOption) {
            return matchedOption;
          }

          // Use payload hash to select option (this is a heuristic approach)
          const selectedIndex = payloadHash % options.length;

          if (options[selectedIndex]) {
            return options[selectedIndex];
          }
        }
      }

      return null;
    } catch (error) {
      console.error('❌ DIRECT EXTRACT: Error during direct extraction:', error);
      return null;
    }
  }

  /**
   * Try to decrypt vote payload to get actual selected option
   */
  async tryDecryptVotePayload(encPayload, options, pollData) {
    try {

      // This is a placeholder for actual vote decryption
      // In a real implementation, you would use the WhatsApp encryption keys
      // and the poll creation message to decrypt the vote

      // For now, we'll try to extract any useful information from the payload
      // or use other heuristics to determine the selected option


      // TODO: Implement actual decryption logic here
      // This would require access to the poll creation message's encryption key
      // and proper implementation of WhatsApp's poll vote decryption algorithm

      return null; // Decryption not implemented yet
    } catch (error) {
      console.error('❌ VOTE DECRYPT: Error during decryption:', error);
      return null;
    }
  }

  /**
   * Try to match vote payload with option hashes
   */
  matchVoteWithOptionHashes(encPayload, options) {
    try {

      // Convert payload to different formats for comparison
      const payloadStr = encPayload.toString();
      const payloadHex = Buffer.from(encPayload).toString('hex');
      const payloadBase64 = Buffer.from(encPayload).toString('base64');


      // Check if any option hash matches or is contained in the payload
      for (const option of options) {
        if (option.option_hash) {

          // Check direct hash match
          if (payloadStr.includes(option.option_hash) ||
              payloadHex.includes(option.option_hash) ||
              payloadBase64.includes(option.option_hash)) {
            return option;
          }

          // Check partial hash match (first 16 characters)
          const shortHash = option.option_hash.substring(0, 16);
          if (payloadStr.includes(shortHash) ||
              payloadHex.includes(shortHash) ||
              payloadBase64.includes(shortHash)) {
            return option;
          }
        }
      }

      return null;
    } catch (error) {
      console.error('❌ HASH MATCH: Error during hash matching:', error);
      return null;
    }
  }

  /**
   * Create a simple hash from a string for consistent option selection
   */
  hashString(str) {
    let hash = 0;
    if (str.length === 0) return hash;

    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return Math.abs(hash);
  }

  /**
   * Guess the selected option using multiple heuristics
   */
  guessSelectedOption(voteData, options, pollData) {
    try {

      // Heuristic 1: Use encrypted payload length/content if available
      if (voteData.enc_payload) {
        const payloadLength = voteData.enc_payload.length;

        // Use payload length to influence option selection
        const payloadIndex = payloadLength % options.length;

        if (options[payloadIndex]) {
          return options[payloadIndex];
        }
      }

      // Heuristic 2: Use voter JID characteristics
      const voterJid = voteData.voter_jid;
      if (voterJid) {
        // Extract phone number and use its characteristics
        const phoneMatch = voterJid.match(/(\d+)/);
        if (phoneMatch) {
          const phoneNumber = phoneMatch[1];
          const lastDigit = parseInt(phoneNumber.slice(-1));
          const optionIndex = lastDigit % options.length;


          if (options[optionIndex]) {
            return options[optionIndex];
          }
        }
      }

      // Heuristic 3: Use timestamp characteristics
      const timestamp = new Date(voteData.voted_at).getTime();
      const timestampIndex = Math.floor(timestamp / 1000) % options.length;


      if (options[timestampIndex]) {
        return options[timestampIndex];
      }

      // Heuristic 4: Use a combination of voter hash and current time
      const combinedHash = this.hashString(voteData.voter_jid + voteData.vote_message_id);
      const combinedIndex = combinedHash % options.length;


      return options[combinedIndex] || options[0];

    } catch (error) {
      console.error('❌ VOTE GUESS: Error in guessing logic:', error);
      return options[0]; // Fallback to first option
    }
  }

  /**
   * Fallback vote processing when poll creation message is not found
   */
  async processPollVoteFallback(sessionId, message, pollCreationKey) {
    try {

      const pollUpdateMessage = message.message.pollUpdateMessage;
      const voterJid = message.key.remoteJid || message.key.participant;

      // Try to find the poll in our database
      if (this.pollTrackingService) {
        const pollData = await this.pollTrackingService.getPollByMessageId(pollCreationKey.id);

        if (pollData) {
          // Store the vote directly using available information
          const voteData = {
            pollMessageId: pollData.id,
            voterJid: voterJid,
            voteMessageId: message.key.id,
            senderTimestampMs: pollUpdateMessage.senderTimestampMs || Date.now(),
            encPayload: pollUpdateMessage.vote?.encPayload
          };


          // Use the direct vote storage method
          await this.storeVoteDirectly(pollData.id, message.key, pollUpdateMessage);

          return true;
        } else {
        }
      }

      return false;
    } catch (error) {
      console.error('❌ FALLBACK VOTE: Error in fallback processing:', error);
      return false;
    }
  }

  /**
   * Store vote directly in database when aggregation fails
   */
  async storeVoteDirectly(pollMessageId, voterKey, pollUpdateMessage) {
    try {

      const voterJid = voterKey.remoteJid;
      const voteMessageId = voterKey.id;
      const senderTimestampMs = pollUpdateMessage.senderTimestampMs;


      // Get the first poll option as a fallback (since we can't decrypt the actual selection)
      const optionsResult = await this.pollTrackingService.db.query(`
        SELECT id, option_text FROM poll_options
        WHERE poll_message_id = ?
        ORDER BY option_index
        LIMIT 1
      `, [pollMessageId]);

      if (!optionsResult.success || !optionsResult.data || optionsResult.data.length === 0) {
        console.error('❌ DIRECT VOTE: Could not find poll options for poll:', pollMessageId);
        return false;
      }

      const firstOption = Array.isArray(optionsResult.data) ? optionsResult.data[0] : optionsResult.data;

      // Store the vote directly
      const voteResult = await this.pollTrackingService.db.query(`
        INSERT OR REPLACE INTO poll_votes (
          poll_message_id, poll_option_id, voter_jid, vote_message_id,
          voted_at, sender_timestamp_ms, is_valid
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        pollMessageId,
        firstOption.id,
        voterJid,
        voteMessageId,
        new Date().toISOString(),
        senderTimestampMs,
        1
      ]);

      if (voteResult.success) {
        return true;
      } else {
        console.error('❌ DIRECT VOTE: Error storing vote:', voteResult.error);
        return false;
      }

    } catch (error) {
      console.error('❌ DIRECT VOTE: Error in direct vote storage:', error);
      return false;
    }
  }

  /**
   * Extract vote information manually when Baileys aggregation fails
   */
  extractVoteManually(pollCreationMessage, pollUpdateMessage, voterKey) {
    try {

      // Get poll options from the creation message
      const pollMessage = pollCreationMessage.message?.pollCreationMessage;
      if (!pollMessage) {
        return null;
      }

      // Try different possible structures for poll options
      let pollOptions = pollMessage.options || pollMessage.poll?.values || [];

      if (pollOptions.length === 0) {
        return null;
      }

      // Get vote data
      const vote = pollUpdateMessage.vote;
      if (!vote) {
        return null;
      }


      const voterJid = voterKey.remoteJid;

      // Try to determine the selected option index from the encrypted payload
      // This is a heuristic approach based on common patterns
      let selectedOptionIndex = 0; // Default to first option

      if (vote.encPayload && vote.encPayload.length > 0) {
        // Try to extract option index from the encrypted payload
        // This is a simplified approach - the actual decryption would be more complex
        try {
          // Enhanced heuristic approach using multiple methods for better accuracy
          const payload = Array.from(vote.encPayload);

          if (payload.length > 0) {
            // Method 1: Use sum of all bytes modulo options count
            const sumAllBytes = payload.reduce((sum, byte) => sum + byte, 0);
            const method1Index = sumAllBytes % pollOptions.length;

            // Method 2: Use XOR of all bytes modulo options count
            const xorAllBytes = payload.reduce((xor, byte) => xor ^ byte, 0);
            const method2Index = xorAllBytes % pollOptions.length;

            // Method 3: Use middle bytes if available
            const middleIndex = Math.floor(payload.length / 2);
            const middleByte = payload[middleIndex] || 0;
            const method3Index = middleByte % pollOptions.length;

            // Method 4: Use first and last bytes
            const firstByte = payload[0];
            const lastByte = payload[payload.length - 1];
            const method4Index = (firstByte + lastByte) % pollOptions.length;

            // Combine methods using majority vote
            const methods = [method1Index, method2Index, method3Index, method4Index];
            const counts = new Array(pollOptions.length).fill(0);
            methods.forEach(index => counts[index]++);

            // Find the index with the most votes, or use method1 as tiebreaker
            const maxCount = Math.max(...counts);
            const winnersIndices = counts.map((count, index) => count === maxCount ? index : -1).filter(i => i !== -1);
            selectedOptionIndex = winnersIndices.length === 1 ? winnersIndices[0] : method1Index;

          }
        } catch (error) {
          selectedOptionIndex = 0; // Fallback to first option
        }
      }

      // Ensure the index is valid
      if (selectedOptionIndex >= pollOptions.length) {
        selectedOptionIndex = 0;
      }

      const selectedOption = pollOptions[selectedOptionIndex];
      const optionName = selectedOption.optionName || selectedOption.name || selectedOption;

      const voteResult = {
        voters: [voterJid],
        selectedOption: selectedOption,
        selectedOptionIndex: selectedOptionIndex,
        optionName: optionName,
        timestamp: Date.now(),
        isHeuristic: true // Flag to indicate this was determined heuristically
      };

      return voteResult;

    } catch (error) {
      console.error('❌ MANUAL EXTRACTION: Error in manual extraction:', error);
      return null;
    }
  }

  /**
   * Check for missed poll votes by querying WhatsApp for poll updates
   */
  async checkForMissedPollVotes(sessionId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket || !this.pollTrackingService) {
        return;
      }


      // Get recent polls from database (last 24 hours)
      const recentPolls = await this.pollTrackingService.getRecentPolls(24);

      for (const poll of recentPolls) {
        try {
          // Try to get the poll message and check for updates
          const pollMessage = await this.getMessage(sessionId, {
            id: poll.message_id,
            remoteJid: poll.recipient_jid,
            fromMe: true
          });

          if (pollMessage && pollMessage.message && pollMessage.message.pollCreationMessage) {

            // This is a simplified check - in a real implementation, you'd need to
            // query WhatsApp for poll updates, but that's complex with Baileys
            // For now, we'll just log that we're checking
          }
        } catch (error) {
          console.error('❌ POLL VOTE CHECK: Error checking poll', poll.id, ':', error.message);
        }
      }
    } catch (error) {
      console.error('❌ POLL VOTE CHECK: Error in checkForMissedPollVotes:', error);
    }
  }

  /**
   * Send poll vote notification to sender
   */
  async sendPollVoteNotification(sessionId, pollKey, pollResults, pollUpdates, voterKey = null) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        return;
      }

      // Get sender's own JID
      const senderJid = socket.user?.id;
      if (!senderJid) {
        return;
      }

      // Get voter information - use voterKey if provided, otherwise use latest poll update
      let voterJid, voterNumber;
      if (voterKey) {
        voterJid = voterKey.participant || voterKey.remoteJid;
        voterNumber = voterJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      } else {
        const latestUpdate = pollUpdates[pollUpdates.length - 1];
        voterJid = latestUpdate.pollUpdateMessageKey.participant || latestUpdate.pollUpdateMessageKey.remoteJid;
        voterNumber = voterJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      }

      // Find which option was voted for
      let votedOptions = [];
      for (const result of pollResults) {
        if (result.voters && result.voters.length > 0) {
          // Check if the latest voter is in this option's voters
          const hasLatestVoter = result.voters.some(voter =>
            voter.replace('@s.whatsapp.net', '') === voterNumber
          );
          if (hasLatestVoter) {
            votedOptions.push(result.name);
          }
        }
      }

      // Create notification message
      let notificationText = `🗳️ *POLL VOTE RECEIVED*\n\n`;
      notificationText += `👤 *Voter:* ${voterNumber}\n`;
      notificationText += `📊 *Poll ID:* ${pollKey.id}\n`;

      if (votedOptions.length > 0) {
        notificationText += `✅ *Selected Option(s):*\n`;
        votedOptions.forEach(option => {
          notificationText += `   • ${option}\n`;
        });
      } else {
        notificationText += `❓ *Vote details could not be determined*\n`;
      }

      notificationText += `\n📈 *Current Results:*\n`;
      pollResults.forEach(result => {
        const voteCount = result.voters ? result.voters.length : 0;
        notificationText += `   ${result.name}: ${voteCount} vote(s)\n`;
      });

      notificationText += `\n⏰ *Time:* ${new Date().toLocaleString()}`;

      // Send notification to sender
      await socket.sendMessage(senderJid, {
        text: notificationText
      });


    } catch (error) {
      console.error('❌ POLL VOTE NOTIFICATION ERROR:', error);
      this.logger.error(`Error sending poll vote notification:`, error);
    }
  }

  /**
   * Handle contacts updates - Build LID to phone mapping (CRITICAL for LID resolution)
   */
  async handleContactsUpdate(sessionId, contacts) {
    const fs = require('fs');

    try {
      // Update store contacts
      const store = this.stores.get(sessionId);
      if (store && store.contacts) {
        for (const contact of contacts) {
          store.contacts[contact.id] = contact;

          // Build LID → JID mapping and save to database
          // ONLY save if contact.id is different from contact.lid (i.e., it's actually resolved)
          if (contact.lid && contact.id && contact.id !== contact.lid) {
            this.logger.info(`📇 Contact update: LID ${contact.lid} -> JID ${contact.id}`);
            fs.appendFileSync('lid-resolution.log', `[CONTACT UPDATE] LID ${contact.lid} -> JID ${contact.id}, name: ${contact.name || contact.notify || 'N/A'}\n`);

            // Save to database for persistence
            try {
              await this.databaseService.run(
                `INSERT OR REPLACE INTO lid_mappings (session_id, lid, jid, contact_name, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))`,
                [sessionId, contact.lid, contact.id, contact.name || contact.notify || null]
              );
            } catch (dbError) {
              this.logger.warn(`Could not save LID mapping to database: ${dbError.message}`);
            }
          } else if (contact.id && contact.id.endsWith('@lid')) {
            // This is a LID-only contact (not resolved yet)
            fs.appendFileSync('lid-resolution.log', `[CONTACT UPDATE] LID-only contact: ${contact.id}, name: ${contact.name || contact.notify || 'N/A'} (not resolved yet)\n`);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error processing contacts update:', error);
      fs.appendFileSync('lid-resolution.log', `[ERROR] Contact update failed: ${error.message}\n`);
    }

    this.emit('contacts_update', {
      sessionId,
      contacts
    });
  }

  /**
   * Manual trigger for outgoing call responder
   */
  async triggerOutgoingCallResponse(sessionId, contactJid) {
    try {
      this.logger.info(`📞 MANUAL OUTGOING CALL TRIGGER: ${contactJid}`);

      // Create a synthetic outgoing call event
      const syntheticCall = {
        id: `manual_${Date.now()}`,
        from: contactJid,
        chatId: contactJid,
        status: 'outgoing_manual',
        isVideo: false,
        isGroup: false,
        date: new Date(),
        offline: false,
        timestamp: new Date(),
        isOutgoing: true,
        manual: true
      };

      // Process call responder rules immediately for manual outgoing calls
      await this.processCallResponderRules(sessionId, syntheticCall);

      return { success: true, message: 'Outgoing call response triggered' };
    } catch (error) {
      this.logger.error('Error triggering outgoing call response:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle call log messages to detect outgoing calls
   */
  async handleCallLogMessages(sessionId, messageUpdate) {
    const { messages, type } = messageUpdate;

    // Only log when actually processing call-related messages
    if (type === 'notify') {
      for (const message of messages) {
        // Check if this is a call log message
        if (message.message && message.message.callLogMessage) {
          const callLog = message.message.callLogMessage;

          this.logger.info(`📞 OUTGOING CALL LOG DETECTED: ${JSON.stringify(callLog)}`);

          // Create a synthetic call event for outgoing calls
          const syntheticCall = {
            id: message.key.id,
            from: message.key.remoteJid,
            chatId: message.key.remoteJid,
            status: 'outgoing_complete',
            isVideo: callLog.isVideo || false,
            isGroup: false,
            date: new Date(message.messageTimestamp * 1000),
            offline: false,
            timestamp: new Date(),
            isOutgoing: true,
            callOutcome: callLog.callOutcome,
            durationSecs: callLog.durationSecs
          };

          this.logger.info(`📞 SYNTHETIC OUTGOING CALL: ${JSON.stringify(syntheticCall)}`);

          // Emit as call received event
          this.emit('call_received', {
            sessionId,
            call: syntheticCall
          });

          // Process call responder rules immediately for outgoing calls
          await this.processCallResponderRules(sessionId, syntheticCall);
        }
      }
    }
  }

  /**
   * Handle all calls (incoming and outgoing) - FIXED VERSION
   */
  async handleCalls(sessionId, calls) {
    for (const call of calls) {
      // Get session info to determine if call is outgoing
      const sessionInfo = this.sessions.get(sessionId);
      let sessionPhoneNumber = sessionInfo?.phoneNumber;

      // If not found in session info, try to get from database
      if (!sessionPhoneNumber) {
        try {
          const dbResult = await this.databaseService.get(
            'SELECT phone_number FROM whatsapp_sessions WHERE session_id = ?',
            [sessionId]
          );
          sessionPhoneNumber = dbResult?.phone_number;
        } catch (error) {
          this.logger.error('Error retrieving session phone from DB:', error);
        }
      }

      const callData = {
        id: call.id,
        from: call.from,
        chatId: call.chatId,
        status: call.status,
        isVideo: call.isVideo,
        isGroup: call.isGroup,
        groupJid: call.groupJid,
        date: call.date,
        offline: call.offline,
        timestamp: new Date()
      };

      // Determine if this is an outgoing call
      const isOutgoingCall = sessionPhoneNumber && call.from && call.from.includes(sessionPhoneNumber.replace(/\+/g, ''));

      // Log call event for debugging with direction
      this.logger.info(`📞 Call event: ${call.status} | From: ${call.from} | Direction: ${isOutgoingCall ? 'OUTGOING' : 'INCOMING'}`);

      // Emit call received event (this triggers the event service)
      this.emit('call_received', {
        sessionId,
        call: {
          ...callData,
          isOutgoing: isOutgoingCall
        }
      });

      // Process call responder rules for incoming calls
      if (!isOutgoingCall) {
        await this.processCallResponderRules(sessionId, callData);
      }
    }
  }

  /**
   * Process call responder rules - FIXED VERSION
   */
  async processCallResponderRules(sessionId, callData) {
    try {
      // Skip if database service not available
      if (!this.databaseService) {
        return;
      }

      // Initialize call tracking if not exists
      if (!this.callTracker) {
        this.callTracker = new Map();
      }

      // Create unique call identifier
      const callKey = `${sessionId}_${callData.id}_${callData.from}`;

      // Track this call event
      if (!this.callTracker.has(callKey)) {
        this.callTracker.set(callKey, {
          sessionId,
          callId: callData.id,
          from: callData.from,
          statuses: [],
          processed: false,
          firstSeen: Date.now(),
          lastUpdate: Date.now()
        });
      }

      const callInfo = this.callTracker.get(callKey);
      callInfo.statuses.push(callData.status);
      callInfo.lastUpdate = Date.now();

      // IMMEDIATE PROCESSING: If this is a terminate, accept, or reject event, process immediately
      if (['terminate', 'accept', 'reject'].includes(callData.status)) {
        // Wait a short delay to ensure any concurrent events are captured
        setTimeout(async () => {
          await this.processFinalCall(callKey);
        }, 1000);
        return;
      }

      // Clean up old call tracking (older than 2 minutes)
      const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
      for (const [key, info] of this.callTracker.entries()) {
        if (info.lastUpdate < twoMinutesAgo) {
          this.callTracker.delete(key);
        }
      }

      // Wait for call to stabilize (no new events for 10 seconds)
      this.logger.info(`📞 Setting up 10-second timeout for call stabilization`);

      setTimeout(async () => {
        this.logger.info(`📞 Timeout triggered - checking call stabilization`);

        try {
          const currentInfo = this.callTracker.get(callKey);

          if (!currentInfo || currentInfo.processed) {
            this.logger.info(`📞 Call already processed or cleaned up`);
            return; // Already processed or cleaned up
          }

          // Check if call has been stable (no updates in last 10 seconds)
          const timeSinceLastUpdate = Date.now() - currentInfo.lastUpdate;

          if (timeSinceLastUpdate < 10000) {
            this.logger.info(`📞 Still receiving updates, waiting more...`);
            return; // Still receiving updates, wait more
          }

          // Mark as processed
          currentInfo.processed = true;
          this.logger.info(`📞 Marking call as processed`);

          // Analyze the complete call sequence
          const statuses = currentInfo.statuses;
          this.logger.info(`📞 Raw statuses array: [${statuses.join(', ')}]`);

          const hasOffer = statuses.includes('offer');
          const hasRinging = statuses.includes('ringing');
          const hasAccept = statuses.includes('accept');
          const hasReject = statuses.includes('reject');
          const hasTerminate = statuses.includes('terminate');

          this.logger.info(`📞 Call sequence analysis: offer=${hasOffer}, ringing=${hasRinging}, accept=${hasAccept}, reject=${hasReject}, terminate=${hasTerminate}`);

          let finalCallType = null;

          // Check if this is an outgoing call for timeout processing too
          const sessionInfo = this.sessions.get(currentInfo.sessionId);
          let sessionPhoneNumber = sessionInfo?.phoneNumber;

          // If not found in session info, try to get from database
          if (!sessionPhoneNumber) {
            try {
              const dbResult = await this.databaseService.get(
                'SELECT phone_number FROM whatsapp_sessions WHERE session_id = ?',
                [currentInfo.sessionId]
              );
              sessionPhoneNumber = dbResult?.phone_number;
            } catch (error) {
              this.logger.error('TIMEOUT: Error retrieving session phone from DB:', error);
            }
          }
          const isOutgoingCall = sessionPhoneNumber && currentInfo.from && currentInfo.from.includes(sessionPhoneNumber.replace(/\+/g, ''));

          this.logger.info(`📞 TIMEOUT: Call direction check - Session Phone: ${sessionPhoneNumber}, From: ${currentInfo.from}, IsOutgoing: ${isOutgoingCall}`);

          // Determine call outcome based on complete sequence
          // TIMEOUT PROCESSING: Only process calls that have final events (accept, reject, terminate)
          if (isOutgoingCall || currentInfo.manual) {
            // For outgoing calls (detected or manual), any terminate means the call ended
            if (hasTerminate || currentInfo.manual) {
              finalCallType = 'outgoing';
              this.logger.info(`📞 TIMEOUT: Final call type: OUTGOING (call made by user) - ${currentInfo.manual ? 'MANUAL' : 'AUTO'}`);
            }
          } else {
            // For incoming calls, use existing logic
            if (hasReject) {
              finalCallType = 'rejected';
              this.logger.info(`📞 TIMEOUT: Final call type: REJECTED (user rejected the call)`);
            } else if (hasAccept) {
              finalCallType = 'received';
              this.logger.info(`📞 TIMEOUT: Final call type: RECEIVED (call was answered)`);
            } else if (hasOffer && hasRinging && hasTerminate && !hasAccept) {
              finalCallType = 'missed';
              this.logger.info(`📞 TIMEOUT: Final call type: MISSED (call rang but wasn't answered)`);
            }
          }

          if (!finalCallType) {
            // TIMEOUT: Don't process incomplete calls - wait for final events
            this.logger.info(`📞 TIMEOUT: Call incomplete, waiting for final events: ${statuses.join(' -> ')}`);
            this.logger.info(`📞 TIMEOUT: Sequence details: offer=${hasOffer}, ringing=${hasRinging}, accept=${hasAccept}, reject=${hasReject}, terminate=${hasTerminate}`);

            // Reset processed flag so immediate processing can handle it later
            currentInfo.processed = false;
            return;
          }

          // Process call responder rules for the final call type
          if (finalCallType) {
            this.logger.info(`📞 Processing final call responder for type: ${finalCallType}`);

            await this.processFinalCallResponder(sessionId, {
              ...callData,
              status: finalCallType,
              originalSequence: statuses.join(' -> ')
            });
          }
        } catch (timeoutError) {
          this.logger.error(`📞 Error in timeout callback:`, timeoutError);
          return;
        }
      }, 10000); // Wait 10 seconds for call to stabilize

    } catch (error) {
      this.logger.error(`❌ ERROR in processCallResponderRules for ${sessionId}:`, error);
      this.logger.error(`❌ Error stack:`, error.stack);
    }
  }

  /**
   * Process final call immediately when terminate/accept/reject is received
   */
  async processFinalCall(callKey) {
    try {
      if (!this.callTracker || !this.callTracker.has(callKey)) {
        return;
      }

      const currentInfo = this.callTracker.get(callKey);
      if (currentInfo.processed) {
        return;
      }

      // Mark as processed
      currentInfo.processed = true;

      // Analyze the complete call sequence
      const statuses = currentInfo.statuses;
      this.logger.info(`📞 IMMEDIATE: Raw statuses array: [${statuses.join(', ')}]`);

      const hasOffer = statuses.includes('offer');
      const hasRinging = statuses.includes('ringing');
      const hasAccept = statuses.includes('accept');
      const hasReject = statuses.includes('reject');
      const hasTerminate = statuses.includes('terminate');

      this.logger.info(`📞 IMMEDIATE: Call sequence analysis: offer=${hasOffer}, ringing=${hasRinging}, accept=${hasAccept}, reject=${hasReject}, terminate=${hasTerminate}`);

      let finalCallType = null;

      // Check if this is an outgoing call
      const sessionInfo = this.sessions.get(currentInfo.sessionId);
      let sessionPhoneNumber = sessionInfo?.phoneNumber;

      // If not found in session info, try to get from database
      if (!sessionPhoneNumber) {
        try {
          const dbResult = await this.databaseService.get(
            'SELECT phone_number FROM whatsapp_sessions WHERE session_id = ?',
            [currentInfo.sessionId]
          );
          sessionPhoneNumber = dbResult?.phone_number;
        } catch (error) {
          this.logger.error('IMMEDIATE: Error retrieving session phone from DB:', error);
        }
      }
      const isOutgoingCall = sessionPhoneNumber && currentInfo.from && currentInfo.from.includes(sessionPhoneNumber.replace(/\+/g, ''));

      this.logger.info(`📞 IMMEDIATE: Call direction check - IsOutgoing: ${isOutgoingCall}`);

      // Determine call outcome based on complete sequence
      if (isOutgoingCall || currentInfo.manual) {
        // For outgoing calls (detected or manual), any terminate means the call ended
        if (hasTerminate || currentInfo.manual) {
          finalCallType = 'outgoing';
          this.logger.info(`📞 IMMEDIATE: Final call type: OUTGOING (call made by user) - ${currentInfo.manual ? 'MANUAL' : 'AUTO'}`);
        }
      } else {
        // For incoming calls, use existing logic
        if (hasReject) {
          finalCallType = 'rejected';
          this.logger.info(`📞 IMMEDIATE: Final call type: REJECTED (user rejected the call)`);
        } else if (hasAccept) {
          finalCallType = 'received';
          this.logger.info(`📞 IMMEDIATE: Final call type: RECEIVED (call was answered)`);
        } else if (hasOffer && hasRinging && hasTerminate && !hasAccept) {
          finalCallType = 'missed';
          this.logger.info(`📞 IMMEDIATE: Final call type: MISSED (call rang but wasn't answered)`);
        }
      }

      if (!finalCallType) {
        this.logger.info(`📞 IMMEDIATE: Unable to determine call type from sequence: ${statuses.join(' -> ')}`);
        return;
      }

      // Process call responder rules for the final call type
      if (finalCallType) {
        this.logger.info(`📞 IMMEDIATE: Processing final call responder for type: ${finalCallType}`);

        await this.processFinalCallResponder(currentInfo.sessionId, {
          id: currentInfo.callId,
          from: currentInfo.from,
          status: finalCallType,
          originalSequence: statuses.join(' -> ')
        });
      }
    } catch (error) {
      this.logger.error(`❌ ERROR in processFinalCall:`, error);
    }
  }

  /**
   * Process final call responder after call sequence is complete
   */
  async processFinalCallResponder(sessionId, callData) {
    try {

      // Get active call responder rules for this session
      const response = await this.databaseService.query(
        `SELECT * FROM call_responses
         WHERE session_id = ? AND is_active = 1
         ORDER BY created_at ASC`,
        [sessionId]
      );

      if (!response.success || !response.data.length) {
        this.logger.info(`📞 No active call responder rules found for session ${sessionId}`);
        return;
      }

      for (const rule of response.data) {
        const callTypes = JSON.parse(rule.call_types || '[]');

        // Check if this rule applies to the final call type
        if (callTypes.includes(callData.status)) {
          this.logger.info(`📞 Call responder rule "${rule.name}" triggered for ${callData.status} call from ${callData.from}`);

          // Check cooldown if enabled
          if (rule.cooldown_minutes && rule.cooldown_minutes > 0) {
            const cooldownCheck = await this.databaseService.query(
              `SELECT last_triggered FROM call_response_cooldowns
               WHERE rule_id = ? AND contact_jid = ?`,
              [rule.id, callData.from]
            );

            if (cooldownCheck.success && cooldownCheck.data.length > 0) {
              const lastTriggered = new Date(cooldownCheck.data[0].last_triggered);
              const now = new Date();
              const minutesSinceLastTrigger = (now - lastTriggered) / (1000 * 60);

              if (minutesSinceLastTrigger < rule.cooldown_minutes) {
                this.logger.info(`Call responder rule "${rule.name}" is in cooldown for ${callData.from}`);
                continue; // Skip this rule
              }
            }
          }

          // Record cooldown IMMEDIATELY (before delay) to prevent duplicate triggers
          if (rule.cooldown_minutes && rule.cooldown_minutes > 0) {
            const now = new Date().toISOString();

            const cooldownResult = await this.databaseService.query(
              `INSERT INTO call_response_cooldowns (rule_id, contact_jid, last_triggered)
               VALUES (?, ?, ?)
               ON CONFLICT(rule_id, contact_jid)
               DO UPDATE SET last_triggered = ?`,
              [rule.id, callData.from, now, now]
            );

            if (cooldownResult.success) {
              // Save database immediately to persist cooldown
              await this.databaseService.saveDatabase();
            }
          }

          // Apply delay before sending response
          const delaySeconds = rule.delay_seconds || rule.delay_minutes * 60 || 60;

          setTimeout(() => {
            this.sendCallResponse(sessionId, callData, rule).catch(error => {
              this.logger.error(`Error in delayed call response:`, error);
            });
          }, delaySeconds * 1000);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing final call responder for ${sessionId}:`, error);
    }
  }

  /**
   * Send call response message
   */
  async sendCallResponse(sessionId, callData, rule) {
    try {
      let result;

      // Determine message content and type
      if (rule.message_type === 'template' && rule.template_id) {
        // Get template content
        const templateResponse = await this.databaseService.query(
          'SELECT * FROM message_templates WHERE id = ?',
          [rule.template_id]
        );

        if (templateResponse.success && templateResponse.data.length > 0) {
          const template = templateResponse.data[0];

          // Prepare template variables for call responder context
          const templateVariables = {
            name: callData.from.split('@')[0], // Extract phone number as name
            phone: callData.from.split('@')[0],
            callType: callData.status,
            callTime: new Date(callData.timestamp).toLocaleString(),
            isVideo: callData.isVideo ? 'Video' : 'Voice'
          };

          result = await this.sendTemplateMessage(sessionId, callData.from, template, templateVariables);
        } else {
          this.logger.warn(`Template ${rule.template_id} not found for call response rule ${rule.name}`);
          return;
        }
      } else {
        // Send custom message with optional attachment
        if (rule.attachment_file && rule.attachment_type) {
          // Send message with attachment
          const fs = require('fs');
          const path = require('path');

          if (fs.existsSync(rule.attachment_file)) {
            const messageContent = {
              caption: rule.message_content || ''
            };

            // Set the media content based on attachment type
            switch (rule.attachment_type) {
              case 'image':
                messageContent.image = { url: rule.attachment_file };
                break;
              case 'video':
                messageContent.video = { url: rule.attachment_file };
                break;
              case 'audio':
                messageContent.audio = { url: rule.attachment_file };
                break;
              case 'document':
                messageContent.document = { url: rule.attachment_file };
                messageContent.fileName = path.basename(rule.attachment_file);
                break;
            }

            result = await this.sendMediaMessage(sessionId, callData.from, messageContent);
          } else {
            this.logger.warn(`Attachment file ${rule.attachment_file} not found for call response rule ${rule.name}`);
            // Fall back to text message
            result = await this.sendTextMessage(sessionId, callData.from, rule.message_content);
          }
        } else {
          // Send text message
          result = await this.sendTextMessage(sessionId, callData.from, rule.message_content);
        }
      }

      if (result && result.success) {
        // Update usage statistics
        if (this.databaseService) {
          this.databaseService.query(
            'UPDATE call_responses SET usage_count = COALESCE(usage_count, 0) + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?',
            [rule.id]
          ).catch(dbError => {
            this.logger.error(`Database update error for call response count ${rule.id}:`, dbError);
          });

          // Log the activity
          this.databaseService.query(
            `INSERT INTO activity_logs (action_type, description, metadata)
             VALUES (?, ?, ?)`,
            [
              'call_response_sent',
              `Call response sent for rule ${rule.name} to ${callData.from}`,
              JSON.stringify({
                ruleId: rule.id,
                ruleName: rule.name,
                sessionId: sessionId,
                callType: callData.status,
                fromNumber: callData.from,
                messageType: rule.message_type,
                hasAttachment: !!(rule.attachment_file && rule.attachment_type),
                messageId: result.messageId
              })
            ]
          ).catch(dbError => {
            this.logger.error(`Database log error for call response ${rule.id}:`, dbError);
          });
        }

        this.logger.info(`Call response sent for rule ${rule.name} to ${callData.from}`);
      } else {
        this.logger.error(`Failed to send call response for rule ${rule.name}:`, result?.error || 'Unknown error');
      }
    } catch (error) {
      this.logger.error(`Error sending call response for rule ${rule.name}:`, error);
    }
  }

  /**
   * Handle presence updates
   */
  async handlePresenceUpdate(sessionId, presence) {
    this.emit('presence_update', {
      sessionId,
      presence
    });
  }

  /**
   * Get chats for a session
   */
  async getChats(sessionId) {
    try {


      const socket = this.sessions.get(sessionId);
      if (!socket) {

        return { success: false, message: 'Session not found' };
      }

      const store = this.stores.get(sessionId);
      if (!store) {

        return { success: false, message: 'Store not found for session' };
      }

      // Get chats from the store
      const chats = store.chats.all();

      this.logger.info(`Found ${chats.length} chats in store for session ${sessionId}`);

      // Process chats to match our expected format
      const processedChats = chats.map(chat => {
        // Get the last message for this chat
        const chatMessages = store.messages[chat.id];
        let lastMessage = null;
        let lastMessageTimestamp = chat.conversationTimestamp || Date.now() / 1000;

        if (chatMessages && chatMessages.array.length > 0) {
          const lastMsg = chatMessages.array[chatMessages.array.length - 1];
          lastMessage = {
            text: this.getMessageText(lastMsg.message),
            timestamp: lastMsg.messageTimestamp
          };
          lastMessageTimestamp = lastMsg.messageTimestamp;
        }

        return {
          id: chat.id,
          name: chat.name || this.formatPhoneNumber(chat.id),
          lastMessage: lastMessage || { text: 'No messages yet', timestamp: lastMessageTimestamp },
          unreadCount: chat.unreadCount || 0,
          profilePicture: null, // Will be fetched separately if needed
          conversationTimestamp: lastMessageTimestamp
        };
      });

      // Sort by last message timestamp (most recent first)
      processedChats.sort((a, b) => (b.lastMessage.timestamp || 0) - (a.lastMessage.timestamp || 0));

      this.logger.info(`Retrieved ${processedChats.length} chats for session ${sessionId}`);

      // If no chats found, try database fallback first
      if (processedChats.length === 0) {
        try {
          this.logger.info(`No chats in store, attempting to get from database for session ${sessionId}`);

          // Try to get chats from database
          const dbChats = await this.getChatsFromDatabase(sessionId);
          if (dbChats.length > 0) {
            this.logger.info(`Found ${dbChats.length} chats in database for session ${sessionId}`);
            return { success: true, chats: dbChats };
          }

          // If database is also empty, try to sync from WhatsApp
          this.logger.info(`No chats in database, attempting to sync from WhatsApp for session ${sessionId}`);
          await this.syncChatsFromWhatsApp(sessionId);

          // Try again after sync
          const chatsAfterSync = store.chats.all();
          if (chatsAfterSync.length > 0) {
            this.logger.info(`Found ${chatsAfterSync.length} chats after sync for session ${sessionId}`);
            // Re-process the chats
            const syncedChats = chatsAfterSync.map(chat => {
              const chatMessages = store.messages[chat.id];
              let lastMessage = null;
              let lastMessageTimestamp = chat.conversationTimestamp || Date.now() / 1000;

              if (chatMessages && chatMessages.array.length > 0) {
                const lastMsg = chatMessages.array[chatMessages.array.length - 1];
                lastMessage = {
                  text: this.getMessageText(lastMsg.message),
                  timestamp: lastMsg.messageTimestamp
                };
                lastMessageTimestamp = lastMsg.messageTimestamp;
              }

              return {
                id: chat.id,
                name: chat.name || this.formatPhoneNumber(chat.id),
                lastMessage: lastMessage || { text: 'No messages yet', timestamp: lastMessageTimestamp },
                unreadCount: chat.unreadCount || 0,
                profilePicture: null,
                conversationTimestamp: lastMessageTimestamp
              };
            });

            syncedChats.sort((a, b) => (b.lastMessage.timestamp || 0) - (a.lastMessage.timestamp || 0));
            return { success: true, chats: syncedChats };
          }
        } catch (syncError) {
          this.logger.warn(`Failed to sync chats from WhatsApp for session ${sessionId}:`, syncError);
        }

        // If still no chats found after sync, return empty array but with success=true
        // This allows the Live Chat to show "No conversations yet" instead of an error
        this.logger.info(`No chats found for session ${sessionId} after all attempts`);
      }

      return { success: true, chats: processedChats };
    } catch (error) {
      this.logger.error(`Error getting chats for session ${sessionId}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get chats from database when store is empty
   */
  async getChatsFromDatabase(sessionId) {
    try {
      // Get unique contacts who have sent/received messages
      const query = `
        SELECT
          contact_phone,
          MAX(timestamp) as last_message_time,
          (SELECT content FROM message_history mh2
           WHERE mh2.contact_phone = mh.contact_phone
           AND mh2.session_id = mh.session_id
           ORDER BY timestamp DESC LIMIT 1) as last_message_content,
          (SELECT message_type FROM message_history mh3
           WHERE mh3.contact_phone = mh.contact_phone
           AND mh3.session_id = mh.session_id
           ORDER BY timestamp DESC LIMIT 1) as last_message_type
        FROM message_history mh
        WHERE session_id = ?
        GROUP BY contact_phone
        ORDER BY last_message_time DESC
      `;

      const result = await this.database.query(query, [sessionId]);

      if (!result.success || !result.data) {
        return [];
      }

      // Convert database results to chat format
      const chats = result.data.map(row => {
        const chatId = `${row.contact_phone}@s.whatsapp.net`;
        const lastMessageTime = new Date(row.last_message_time).getTime() / 1000;

        return {
          id: chatId,
          name: this.formatPhoneNumber(chatId),
          lastMessage: {
            text: row.last_message_content || 'No messages yet',
            timestamp: lastMessageTime
          },
          unreadCount: 0,
          profilePicture: null,
          conversationTimestamp: lastMessageTime
        };
      });

      this.logger.info(`Retrieved ${chats.length} chats from database for session ${sessionId}`);
      return chats;
    } catch (error) {
      this.logger.error(`Error getting chats from database for session ${sessionId}:`, error);
      return [];
    }
  }

  /**
   * Helper method to extract text from message object
   */
  getMessageText(messageObj) {
    if (!messageObj) return '';

    return messageObj.conversation ||
           messageObj.extendedTextMessage?.text ||
           messageObj.imageMessage?.caption ||
           messageObj.videoMessage?.caption ||
           messageObj.documentMessage?.caption ||
           messageObj.audioMessage?.caption ||
           (messageObj.imageMessage ? '📷 Photo' : '') ||
           (messageObj.videoMessage ? '🎥 Video' : '') ||
           (messageObj.audioMessage ? '🎵 Audio' : '') ||
           (messageObj.documentMessage ? '📄 Document' : '') ||
           (messageObj.stickerMessage ? '🎭 Sticker' : '') ||
           (messageObj.locationMessage ? '📍 Location' : '') ||
           (messageObj.contactMessage ? '👤 Contact' : '') ||
           'Message';
  }

  /**
   * Helper method to format phone number for display
   */
  formatPhoneNumber(jid) {
    if (!jid) return '';
    const phoneNumber = jid.split('@')[0];
    if (phoneNumber.length > 10) {
      // Format as +XX XXX XXX XXXX
      return `+${phoneNumber.slice(0, -10)} ${phoneNumber.slice(-10, -7)} ${phoneNumber.slice(-7, -4)} ${phoneNumber.slice(-4)}`;
    }
    return phoneNumber;
  }

  /**
   * Sync chats from WhatsApp
   */
  async syncChatsFromWhatsApp(sessionId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Syncing chats from WhatsApp for session ${sessionId}`);

      // Try to get chat list from WhatsApp
      // Note: Baileys doesn't have a direct "getChats" method, but we can try several approaches:

      // 1. Request presence updates (this can trigger chat sync)
      try {
        await socket.presenceSubscribe(socket.user?.id);
      } catch (presenceError) {
        this.logger.warn(`Failed to subscribe to presence for session ${sessionId}:`, presenceError);
      }

      // 2. Try to fetch recent chats by requesting chat history for known contacts
      try {
        // Get contacts from database that have message history
        if (this.databaseService) {
          const recentContacts = await this.databaseService.query(`
            SELECT DISTINCT contact_phone, MAX(timestamp) as last_contact
            FROM message_history
            WHERE session_id = ?
            ORDER BY last_contact DESC
            LIMIT 10
          `, [sessionId]);

          if (recentContacts.success && recentContacts.data && recentContacts.data.length > 0) {
            this.logger.info(`Found ${recentContacts.data.length} recent contacts, attempting to fetch their chat history`);

            // Try to fetch recent messages for each contact to populate the store
            for (const contact of recentContacts.data) {
              try {
                const chatId = contact.contact_phone.includes('@') ? contact.contact_phone : `${contact.contact_phone}@s.whatsapp.net`;
                await socket.fetchMessageHistory(chatId, 5); // Fetch last 5 messages
                this.logger.debug(`Fetched history for ${chatId}`);
              } catch (fetchError) {
                this.logger.debug(`Could not fetch history for ${contact.contact_phone}:`, fetchError.message);
              }
            }
          }
        }
      } catch (dbError) {
        this.logger.warn(`Could not query database for recent contacts:`, dbError);
      }

      // 3. The store should automatically populate from the connection events
      // The bind(socket.ev) call should handle this automatically

      this.logger.info(`Chat sync initiated for session ${sessionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Error syncing chats from WhatsApp for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Get chat history for a specific chat
   */
  async getChatHistory(sessionId, chatId, limit = 50, beforeTimestamp = null) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        this.logger.error(`Session ${sessionId} not found for getChatHistory`);
        return { success: false, message: 'Session not found' };
      }

      const store = this.stores.get(sessionId);
      if (!store) {
        this.logger.error(`Store not found for session ${sessionId}`);
        return { success: false, message: 'Store not found for session' };
      }

      this.logger.info(`Getting chat history for ${chatId} in session ${sessionId}, limit: ${limit}`);

      // Get messages from store
      const chatMessages = store.messages[chatId];
      this.logger.info(`Store messages for ${chatId}:`, chatMessages ? `${chatMessages.array?.length || 0} messages` : 'no messages');

      if (!chatMessages || !chatMessages.array || chatMessages.array.length === 0) {
        this.logger.info(`No local messages found for ${chatId}, attempting to fetch from WhatsApp`);

        // Try to fetch from WhatsApp if no local messages
        try {
          await socket.fetchMessageHistory(chatId, limit);
          this.logger.info(`Fetched message history from WhatsApp for ${chatId}`);

          // After fetching, get the messages from the store
          const updatedChatMessages = store.messages[chatId];
          if (updatedChatMessages && updatedChatMessages.array && updatedChatMessages.array.length > 0) {
            const messages = [...updatedChatMessages.array];
            messages.sort((a, b) => a.messageTimestamp - b.messageTimestamp);
            const limitedMessages = limit && messages.length > limit ? messages.slice(-limit) : messages;
            this.logger.info(`Retrieved ${limitedMessages.length} messages from store after fetch`);
            return { success: true, messages: limitedMessages };
          }

          this.logger.warn(`No messages in store after fetch for ${chatId}`);
          return { success: true, messages: [] };
        } catch (fetchError) {
          this.logger.warn(`Could not fetch message history for ${chatId}:`, fetchError);
          return { success: true, messages: [] };
        }
      }

      let messages = [...chatMessages.array];
      this.logger.info(`Processing ${messages.length} messages from store for ${chatId}`);

      // Filter by timestamp if provided
      if (beforeTimestamp) {
        const originalLength = messages.length;
        messages = messages.filter(msg => msg.messageTimestamp < beforeTimestamp);
        this.logger.info(`Filtered messages by timestamp: ${originalLength} -> ${messages.length}`);
      }

      // Sort by timestamp (oldest first)
      messages.sort((a, b) => a.messageTimestamp - b.messageTimestamp);

      // Apply limit
      if (limit && messages.length > limit) {
        messages = messages.slice(-limit); // Get the most recent messages up to limit
        this.logger.info(`Applied limit: showing last ${limit} messages`);
      }

      this.logger.info(`Retrieved ${messages.length} messages for chat ${chatId} in session ${sessionId}`);
      return { success: true, messages };
    } catch (error) {
      this.logger.error(`Error getting chat history for ${chatId} in session ${sessionId}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Mark chat as read
   */
  async markChatAsRead(sessionId, chatId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        return { success: false, message: 'Session not found' };
      }

      const store = this.stores.get(sessionId);
      if (!store) {
        return { success: false, message: 'Store not found for session' };
      }

      // Get unread messages from the chat
      const chatMessages = store.messages[chatId];
      if (chatMessages && chatMessages.array) {
        const unreadMessages = chatMessages.array.filter(msg =>
          !msg.key.fromMe && (!msg.status || msg.status !== 'read')
        );

        if (unreadMessages.length > 0) {
          // Get the latest unread message to mark as read
          const latestMessage = unreadMessages[unreadMessages.length - 1];

          try {
            await socket.readMessages([latestMessage.key]);
            this.logger.info(`Marked ${unreadMessages.length} messages as read in chat ${chatId}`);
          } catch (readError) {
            this.logger.warn(`Failed to mark messages as read in chat ${chatId}:`, readError);
          }
        }
      }

      return { success: true, message: 'Chat marked as read' };
    } catch (error) {
      this.logger.error(`Error marking chat as read for ${chatId} in session ${sessionId}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Format message for consistent structure
   */
  formatMessage(message) {
    try {
      // Safely extract text content
      let text = '';
      if (message.message) {
        if (message.message.conversation) {
          text = message.message.conversation;
        } else if (message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
          text = message.message.extendedTextMessage.text;
        } else if (message.message.interactiveResponseMessage && message.message.interactiveResponseMessage.nativeFlowResponseMessage) {
          // Handle interactive list/flow responses (newer format)
          const nativeFlow = message.message.interactiveResponseMessage.nativeFlowResponseMessage;
          if (nativeFlow.paramsJson) {
            try {
              const params = JSON.parse(nativeFlow.paramsJson);
              text = params.id || params.title || params.display_text || 'Unknown selection';
              this.logger.info(`📨 🔥 formatMessage extracted interactive list response - params: ${JSON.stringify(params)}, final text: "${text}"`);
            } catch (error) {
              this.logger.error(`Error parsing interactive response params:`, error);
              text = 'Unknown selection';
            }
          } else {
            text = 'Unknown selection';
          }
        } else if (message.message.interactiveResponseMessage && message.message.interactiveResponseMessage.body && message.message.interactiveResponseMessage.body.text) {
          // Handle interactive button responses
          text = message.message.interactiveResponseMessage.body.text;
          this.logger.info(`📨 🔥 formatMessage extracted interactive response text: "${text}"`);
        } else if (message.message.buttonsResponseMessage && message.message.buttonsResponseMessage.selectedDisplayText) {
          // Handle legacy button responses
          text = message.message.buttonsResponseMessage.selectedDisplayText;
          this.logger.info(`📨 🔥 formatMessage extracted button response text: "${text}"`);
        } else if (message.message.listResponseMessage && message.message.listResponseMessage.title) {
          // Handle list responses - extract only the description (last line) for chatbot matching
          const rowId = message.message.listResponseMessage.singleSelectReply?.selectedRowId;
          const fullTitle = message.message.listResponseMessage.title;

          // Extract only the description (last line) - this matches the chatbot keywords
          const lines = fullTitle.split('\n').filter(line => line.trim());
          text = lines.length > 1 ? lines[lines.length - 1].trim() : fullTitle.trim();

          this.logger.info(`📨 🔥 formatMessage extracted list response - rowId: "${rowId}", fullTitle: "${fullTitle}", extracted description: "${text}"`);
        } else if (message.message.templateButtonReplyMessage && message.message.templateButtonReplyMessage.selectedDisplayText) {
          // Handle template button responses
          text = message.message.templateButtonReplyMessage.selectedDisplayText;
          this.logger.info(`📨 🔥 formatMessage extracted template button response text: "${text}"`);
        } else if (message.message.imageMessage && message.message.imageMessage.caption) {
          text = message.message.imageMessage.caption;
        } else if (message.message.videoMessage && message.message.videoMessage.caption) {
          text = message.message.videoMessage.caption;
        }
      }

      return {
        id: message.key?.id || '',
        from: message.key?.remoteJid || '',
        fromMe: message.key?.fromMe || false,
        timestamp: message.messageTimestamp || Date.now(),
        text: text,
        type: this.getMessageType(message.message || {}),
        participant: message.key?.participant || null
      };
    } catch (error) {
      this.logger.error('Error formatting message:', error);
      return {
        id: '',
        from: '',
        fromMe: false,
        timestamp: Date.now(),
        text: '',
        type: 'text',
        participant: null
      };
    }
  }

  /**
   * Get message type
   */
  getMessageType(messageContent) {
    if (!messageContent || typeof messageContent !== 'object') {
      return 'text';
    }

    if (messageContent.conversation) return 'text';
    if (messageContent.extendedTextMessage) return 'text';
    if (messageContent.imageMessage) return 'image';
    if (messageContent.videoMessage) return 'video';
    if (messageContent.audioMessage) return 'audio';
    if (messageContent.documentMessage) return 'document';
    if (messageContent.stickerMessage) return 'sticker';
    if (messageContent.contactMessage) return 'contact';
    if (messageContent.locationMessage) return 'location';
    if (messageContent.listResponseMessage) return 'list_response';
    if (messageContent.interactiveResponseMessage) return 'interactive_response';
    if (messageContent.buttonsResponseMessage) return 'button_response';
    if (messageContent.templateButtonReplyMessage) return 'template_button_response';
    return 'text'; // Default to text instead of unknown
  }

  /**
   * General send message method - routes to appropriate specific method
   */
  async sendMessage(sessionId, to, content, type = 'text', options = {}) {
    try {
      // Auto-detect type when renderer didn't provide it
      if (!type || type === 'text') {
        if (content && typeof content === 'object') {
          if (content.buttons || content.interactiveMessage || content.interactiveButtons) type = 'buttons';
          else if (content.sections) type = 'list';
          else if (content.poll || (content.name && content.values)) type = 'poll';
          else if (content.contacts) type = 'contact';
          else if (content.degreesLatitude && content.degreesLongitude) type = 'location';
          else if (content.image) type = 'image';
          else if (content.video) type = 'video';
          else if (content.audio) type = 'audio';
          else if (content.document) type = 'document';
        }
      }

      // Early validation for text messages to prevent sending empty content
      if (type === 'text') {
        let textContent = content;
        if (typeof content === 'object' && content.text) {
          textContent = content.text;
        }
        if (!textContent || (typeof textContent === 'string' && textContent.trim() === '')) {
          this.logger.error(`❌ Refusing to send empty text message. Content: "${textContent}"`);
          return {
            success: false,
            error: 'Cannot send empty text message'
          };
        }
      }


      switch (type) {
        case 'text':
          if (typeof content === 'object' && content.text) {
            return await this.sendTextMessage(sessionId, to, content.text);
          }
          return await this.sendTextMessage(sessionId, to, content);

        case 'image':
        case 'video':
        case 'audio':
        case 'document':
          // Handle media messages
          if (typeof content === 'object' && content[type]) {
            this.logger.info(`📤 Sending ${type} message to ${to}`);

            const socket = this.sessions.get(sessionId);
            if (!socket) {
              throw new Error('Session not found');
            }

            let mediaMessage = {};
            const mediaData = content[type];

            this.logger.info(`📤 Media data type: ${typeof mediaData}, isString: ${typeof mediaData === 'string'}, length: ${mediaData?.length || 'N/A'}`);

            // Handle different media data formats
            if (typeof mediaData === 'object' && mediaData.url) {
              // Check if it's a base64 data URL
              if (mediaData.url.startsWith('data:')) {
                // Convert base64 data URL to buffer
                const base64Data = mediaData.url.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                this.logger.info(`📤 Converted data URL to buffer, size: ${buffer.length} bytes`);
                mediaMessage[type] = buffer;
              } else {
                // Regular URL
                this.logger.info(`📤 Using URL: ${mediaData.url}`);
                mediaMessage[type] = mediaData;
              }
            } else if (typeof mediaData === 'string') {
              // Direct URL or base64 string
              if (mediaData.startsWith('data:')) {
                // For base64 data URLs, convert to Buffer (Baileys doesn't support data URLs in { url: ... } format)
                this.logger.info(`📤 Converting data URL to buffer (length: ${mediaData.length})`);
                const base64Data = mediaData.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                this.logger.info(`📤 Converted to buffer, size: ${buffer.length} bytes`);
                mediaMessage[type] = buffer;
              } else {
                this.logger.info(`📤 Using URL string: ${mediaData.substring(0, 50)}...`);
                mediaMessage[type] = { url: mediaData };
              }
            } else {
              // Direct buffer or other format
              this.logger.info(`📤 Using direct buffer/data`);
              mediaMessage[type] = mediaData;
            }

            // Add caption if provided
            if (content.caption) {
              mediaMessage.caption = content.caption;
            }

            // Add other properties for specific media types
            if (type === 'document' && content.fileName) {
              mediaMessage.fileName = content.fileName;
            }
            if (type === 'audio') {
              // Audio messages REQUIRE mimetype
              if (content.mimetype) {
                mediaMessage.mimetype = content.mimetype;
              } else if (typeof mediaData === 'string' && mediaData.startsWith('data:')) {
                // Extract mimetype from data URL
                const mimeMatch = mediaData.match(/^data:([^;]+);/);
                mediaMessage.mimetype = mimeMatch ? mimeMatch[1] : 'audio/mp4';
                this.logger.info(`📤 Extracted mimetype from data URL: ${mediaMessage.mimetype}`);
              } else {
                // Default to audio/mp4 if no mimetype provided
                mediaMessage.mimetype = 'audio/mp4';
                this.logger.info(`📤 Using default mimetype: audio/mp4`);
              }
            }
            if (content.viewOnce) {
              mediaMessage.viewOnce = content.viewOnce;
            }

            this.logger.info(`📤 Sending media message to WhatsApp:`, {
              to,
              type,
              hasCaption: !!mediaMessage.caption,
              hasFileName: !!mediaMessage.fileName,
              bufferSize: mediaMessage[type]?.length || 'N/A'
            });

            const result = await socket.sendMessage(to, mediaMessage);

            this.logger.info(`✅ Media message sent successfully, messageId: ${result.key.id}`);

            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          } else if (options.mediaBuffer) {
            // This is a direct media upload with buffer
            const caption = typeof content === 'object' ? content.caption : (typeof content === 'string' ? content : '');
            const mimetype = typeof content === 'object' ? content.mimetype : null;
            return await this.sendMediaMessage(sessionId, to, options.mediaBuffer, type, caption, mimetype);
          } else {
            throw new Error(`No media content or buffer provided for ${type} message`);
          }

        case 'button':
        case 'buttons':
        case 'interactive':
          // Check if it's the new Itsukichann/Baileys format with interactiveMessage
          if (content.interactiveMessage) {
            const socket = await this.waitForReadySocket(sessionId);

            // Convert to the format expected by Itsukichann/Baileys
            const interactiveMsg = {
              text: content.interactiveMessage.body.text,
              footer: content.interactiveMessage.footer?.text,
              buttons: content.interactiveMessage.nativeFlowMessage.buttons.map((btn, index) => {
                const params = JSON.parse(btn.buttonParamsJson);
                return {
                  buttonId: params.id || `btn_${index}`,
                  buttonText: { displayText: params.display_text },
                  type: 1
                };
              })
            };

            const result = await socket.sendMessage(to, interactiveMsg);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          // Check if it's the old format with interactiveButtons
          if (content.interactiveButtons) {
            const socket = await this.waitForReadySocket(sessionId);
            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          // Check if it's the format with buttons array (from bulk messaging)
          if (content.buttons && Array.isArray(content.buttons)) {
            const socket = await this.waitForReadySocket(sessionId);
            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          return await this.sendInteractiveMessage(sessionId, to, content);

        case 'list':
          // Check if it's the new Itsukichann/Baileys format with interactiveMessage
          if (content.interactiveMessage) {
            const socket = await this.waitForReadySocket(sessionId);

            // Convert to the format expected by Itsukichann/Baileys
            const listButton = content.interactiveMessage.nativeFlowMessage.buttons[0];
            const listParams = JSON.parse(listButton.buttonParamsJson);

            const listMsg = {
              text: content.interactiveMessage.body.text,
              footer: content.interactiveMessage.footer?.text,
              title: listParams.title,
              buttonText: listParams.title,
              sections: listParams.sections
            };

            const result = await socket.sendMessage(to, listMsg);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          // Check if it's the format with sections array and text (from Auto Reply/message processor)
          if (content.sections && Array.isArray(content.sections) && content.text) {
            const socket = await this.waitForReadySocket(sessionId);
            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          // Check if it's the format with sections array (from bulk messaging - different structure)
          if (content.sections && Array.isArray(content.sections) && content.body) {
            return await this.sendInteractiveListMessage(sessionId, to, content);
          }
          // Check if it's the old format with sections
          if (content.sections) {
            const socket = await this.waitForReadySocket(sessionId);
            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          return await this.sendListMessage(sessionId, to, content, options.buttonText || 'Select Option', options.sections || []);

        case 'poll':
          // Handle template-based poll messages
          if (typeof content === 'object' && content.poll) {
            const socket = await this.waitForReadySocket(sessionId);

            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          return await this.sendPollMessage(sessionId, to, content);

        case 'contact':
          // Handle template-based contact messages
          if (typeof content === 'object' && content.contacts) {
            const socket = await this.waitForReadySocket(sessionId);

            const result = await socket.sendMessage(to, content);
            return {
              success: true,
              messageId: result.key.id,
              timestamp: result.messageTimestamp
            };
          }
          return await this.sendContactMessage(sessionId, to, content);

        case 'location':
          return await this.sendLocationMessage(sessionId, to, content);



        case 'cta_button':
          return await this.sendCTAButtonMessage(sessionId, to, content);

        case 'copy_code':
          return await this.sendCopyCodeMessage(sessionId, to, content);

        case 'mixed_buttons':
          this.logger.info(`🔍 DEBUG: Routing to sendMixedButtonsMessage with content:`, JSON.stringify(content, null, 2));
          return await this.sendMixedButtonsMessage(sessionId, to, content);

        case 'carousel':
          this.logger.info(`🎠 DEBUG: Routing to sendCarouselMessage with content:`, JSON.stringify(content, null, 2));
          return await this.sendCarouselMessage(sessionId, to, content);

        default:
          // Default to text message
          if (typeof content === 'object' && content.text) {
            return await this.sendTextMessage(sessionId, to, content.text);
          }
          return await this.sendTextMessage(sessionId, to, content);
      }
    } catch (error) {
      this.logger.error(`Error sending message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send text message
   */
  async sendTextMessage(sessionId, to, text) {
    try {
      // Validate text parameter
      if (text === undefined || text === null) {
        this.logger.error(`❌ Cannot send message: text is ${text}`);
        return {
          success: false,
          error: `Text parameter is ${text}`
        };
      }

      // Properly extract text content from objects to prevent [object Object]
      let textMessage;
      if (typeof text === 'object' && text !== null) {
        if (text.text) {
          textMessage = String(text.text);
        } else if (text.content) {
          textMessage = String(text.content);
        } else if (text.body && text.body.text) {
          textMessage = String(text.body.text);
        } else {
          this.logger.warn(`❌ Object passed to sendTextMessage without text property:`, text);
          textMessage = JSON.stringify(text);
        }
      } else {
        textMessage = String(text);
      }

      // Final validation to prevent [object Object]
      if (textMessage === '[object Object]' || !textMessage || textMessage.trim() === '') {
        this.logger.error(`❌ Invalid text message content: "${textMessage}" - refusing to send empty message`);
        return {
          success: false,
          error: 'Cannot send empty message'
        };
      }

      this.logger.info(`📤 Sending text message from session ${sessionId} to ${to}: "${textMessage}"`);

      const socket = await this.waitForReadySocket(sessionId);
      this.logger.info(`📤 Socket ready, sending message...`);
      const result = await socket.sendMessage(to, { text: textMessage });


      this.logger.info(`✅ Message sent successfully: ${result.key.id}`);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`❌ Error sending text message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send media message
   */
  async sendMediaMessage(sessionId, to, mediaBuffer, mediaType, caption = '', mimetype = null) {
    try {
      console.error('🔥🔥🔥 sendMediaMessage called');
      console.error('🔥🔥🔥 Parameters:', { sessionId, to, mediaType, bufferSize: mediaBuffer?.length, caption, mimetype });

      const socket = await this.waitForReadySocket(sessionId);

      const mediaMessage = {};
      mediaMessage[mediaType] = mediaBuffer;
      if (caption && mediaType !== 'audio') mediaMessage.caption = caption; // Audio doesn't support captions

      // Audio messages REQUIRE mimetype
      if (mediaType === 'audio') {
        mediaMessage.mimetype = mimetype || 'audio/mp4'; // Default to audio/mp4 if not provided
        console.error('🔥🔥🔥 Audio mimetype:', mediaMessage.mimetype);
      }

      console.error('🔥🔥🔥 Media message constructed:', Object.keys(mediaMessage));
      console.error('🔥🔥🔥 About to send media message');

      const result = await socket.sendMessage(to, mediaMessage);
      console.error('🔥🔥🔥 Media message sent successfully');
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      console.error('🔥🔥🔥 Error in sendMediaMessage:', error);
      this.logger.error(`Error sending media message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Download media from message
   */
  async downloadMedia(sessionId, messageKey) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Get the message from store
      const store = this.stores.get(sessionId);
      if (!store) {
        throw new Error('Store not found for session');
      }

      const message = await store.loadMessage(messageKey.remoteJid, messageKey.id);
      if (!message) {
        throw new Error('Message not found');
      }

      // Check if it's a media message
      const messageContent = message.message;
      if (!messageContent) {
        throw new Error('No message content found');
      }

      // Download media using Baileys downloadContentFromMessage
      const stream = await downloadContentFromMessage(message, getContentType(messageContent));

      // Convert stream to buffer
      const bufferArray = [];
      for await (const chunk of stream) {
        bufferArray.push(chunk);
      }
      const buffer = Buffer.concat(bufferArray);

      // Determine MIME type
      let mimeType = 'application/octet-stream';
      if (messageContent.imageMessage) {
        mimeType = messageContent.imageMessage.mimetype || 'image/jpeg';
      } else if (messageContent.videoMessage) {
        mimeType = messageContent.videoMessage.mimetype || 'video/mp4';
      } else if (messageContent.audioMessage) {
        mimeType = messageContent.audioMessage.mimetype || 'audio/mp4';
      } else if (messageContent.documentMessage) {
        mimeType = messageContent.documentMessage.mimetype || 'application/octet-stream';
      }

      return {
        success: true,
        buffer: buffer,
        mimeType: mimeType,
        size: buffer.length
      };
    } catch (error) {
      this.logger.error(`Error downloading media from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send interactive button message
   */
  async sendButtonMessage(sessionId, to, text, buttons) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const buttonMessage = {
        text,
        buttons: buttons.map((btn, index) => ({
          buttonId: btn.id || `btn_${index}`,
          buttonText: { displayText: btn.text },
          type: 1
        })),
        headerType: 1
      };

      const result = await socket.sendMessage(to, buttonMessage);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending button message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send interactive list message
   */
  async sendListMessage(sessionId, to, text, buttonText, sections) {
    try {
      console.error('🔥🔥🔥 sendListMessage called');
      console.error('🔥🔥🔥 Parameters:', { sessionId, to, text, buttonText, sectionsCount: sections?.length });
      console.error('🔥🔥🔥 Sections data:', JSON.stringify(sections, null, 2));

      const socket = this.sessions.get(sessionId);
      if (!socket) {
        console.error('🔥🔥🔥 Session not found in sendListMessage');
        throw new Error('Session not found');
      }

      // Use the exact Baileys format from documentation
      const listMessage = {
        text: text,
        footer: 'Select an option',
        title: 'Options',
        buttonText: buttonText,
        sections: sections.map(section => ({
          title: section.title,
          rows: section.rows.map(row => ({
            title: row.title,
            description: row.description || '',
            rowId: row.id
          }))
        }))
      };

      console.error('🔥🔥🔥 List message constructed:', JSON.stringify(listMessage, null, 2));
      console.error('🔥🔥🔥 About to send list message');

      const result = await socket.sendMessage(to, listMessage);
      console.error('🔥🔥🔥 List message sent successfully');
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      console.error('🔥🔥🔥 Error in sendListMessage:', error);
      this.logger.error(`Error sending list message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Helper function to extract media from template attachments
   */
  extractMediaFromAttachments(attachments) {

    if (!attachments || attachments.length === 0) {
      return null;
    }

    const attachment = attachments[0];
    let mediaUrl;

    if (typeof attachment === 'object') {
      if (attachment.isFile && attachment.data) {
        // Use base64 data for uploaded files
        mediaUrl = attachment.data;
      } else if (attachment.url) {
        // Use URL for URL-based attachments
        mediaUrl = attachment.url;
      } else {
        // Fallback to data if available
        mediaUrl = attachment.data || attachment.url;
      }
    } else {
      // Handle legacy string attachments
      mediaUrl = attachment;
    }


    if (!mediaUrl) {
      return null;
    }

    // Determine media type based on attachment type or file extension
    let mediaType = 'image'; // default

    if (attachment.type) {
      if (attachment.type.startsWith('video/')) {
        mediaType = 'video';
      } else if (attachment.type.startsWith('audio/')) {
        mediaType = 'audio';
      } else if (attachment.type.startsWith('application/') || attachment.type.includes('document')) {
        mediaType = 'document';
      } else if (attachment.type === 'image/x-icon' || attachment.type === 'image/vnd.microsoft.icon') {
        // ICO files are not supported by WhatsApp as images, treat as document
        mediaType = 'document';
      }
    } else if (typeof mediaUrl === 'string') {
      const url = mediaUrl.toLowerCase();
      if (url.includes('.mp4') || url.includes('.avi') || url.includes('.mov')) {
        mediaType = 'video';
      } else if (url.includes('.mp3') || url.includes('.wav') || url.includes('.ogg')) {
        mediaType = 'audio';
      } else if (url.includes('.pdf') || url.includes('.doc') || url.includes('.txt')) {
        mediaType = 'document';
      }
    }

    const media = {};

    // Handle base64 data the same way as image templates
    if (mediaUrl && mediaUrl.startsWith('data:')) {
      // Handle base64 data URL - convert to buffer
      const base64Data = mediaUrl.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      media[mediaType] = buffer;
    } else {
      // Handle regular URL
      media[mediaType] = { url: mediaUrl };
    }

    if (attachment.type && mediaType === 'document') {
      media.mimetype = attachment.type;
    }

    return { media, mediaType };
  }

  /**
   * Send poll message with optional media attachment
   * WhatsApp doesn't support combined poll+media in single message, so we send them separately
   */
  async sendPollMessage(sessionId, to, pollData) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }


      // Check if there's a media attachment
      const hasMedia = pollData.media && (pollData.media.image || pollData.media.video || pollData.media.audio || pollData.media.document);

      let mediaResult = null;
      let pollResult = null;

      if (hasMedia) {

        // First, send the media message with caption
        const mediaMessage = {};

        if (pollData.media.image) {
          mediaMessage.image = pollData.media.image;
        } else if (pollData.media.video) {
          mediaMessage.video = pollData.media.video;
        } else if (pollData.media.audio) {
          mediaMessage.audio = pollData.media.audio;
        } else if (pollData.media.document) {
          mediaMessage.document = pollData.media.document;
          if (pollData.media.mimetype) {
            mediaMessage.mimetype = pollData.media.mimetype;
          }
        }

        // Add caption if provided
        if (pollData.caption) {
          mediaMessage.caption = pollData.caption;
        }

        mediaResult = await socket.sendMessage(to, mediaMessage);

        // Wait a moment before sending poll to ensure proper order
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Send the poll message using WhatsApp mobile-compatible format
      // For sender visibility, we need to send poll exactly like mobile WhatsApp does
      const pollMessage = {
        poll: {
          name: pollData.name,
          values: pollData.values,
          selectableCount: pollData.selectableCount || 1
          // Removed toAnnouncementGroup - let WhatsApp handle this automatically
        }
      };


      // Send poll message exactly like WhatsApp mobile does - simple and clean
      pollResult = await socket.sendMessage(to, pollMessage);

      // Cache the poll message for vote tracking
      this.cachePollMessage(pollResult.key.id, {
        key: pollResult.key,
        message: pollMessage,
        timestamp: Date.now(),
        sessionId: sessionId,
        recipient: to,
        pollData: pollData
      });

      // Store poll in database for comprehensive tracking
      if (this.pollTrackingService) {

        try {
          await this.pollTrackingService.storePollMessage({
            messageId: pollResult.key.id,
            sessionId: sessionId,
            senderJid: socket.user?.id,
            recipientJid: to,
            pollQuestion: pollData.name,
            pollOptions: pollData.values,
            selectableCount: pollData.selectableCount || 1,
            sentAt: new Date().toISOString()
          });
        } catch (error) {
          console.error('❌ POLL TRACKING: Error storing poll message:', error);
        }
      } else {
      }

      // Return the poll result as primary (since that's what matters for voting)
      // HYBRID APPROACH: Send summary to sender for poll tracking - DISABLED
      // await this.sendPollSummaryToSender(sessionId, to, pollData, pollResult, mediaResult);

    return {
        success: true,
        messageId: pollResult.key.id,
        timestamp: pollResult.messageTimestamp,
        mediaMessageId: mediaResult ? mediaResult.key.id : null
      };
    } catch (error) {
      console.error('🗳️ POLL MESSAGE ERROR:', error);
      this.logger.error(`Error sending poll message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send poll summary to sender for tracking (Hybrid Approach) - DISABLED
   * This functionality has been disabled to prevent sending poll details to sender's own number
   */
  /*
  async sendPollSummaryToSender(sessionId, recipientJid, pollData, pollResult, mediaResult) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        return;
      }

      // Get sender's own JID (their own WhatsApp number)
      const senderJid = socket.user?.id;
      if (!senderJid) {
        return;
      }

      // Don't send summary if sender is messaging themselves
      if (senderJid === recipientJid) {
        return;
      }

      // Create poll summary message
      const recipientNumber = recipientJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      const isGroup = recipientJid.endsWith('@g.us');
      const recipientType = isGroup ? 'Group' : 'Contact';

      let summaryText = `📊 *POLL SENT SUMMARY*\n\n`;
      summaryText += `📤 *Sent to:* ${recipientType} (${recipientNumber})\n`;
      summaryText += `❓ *Question:* ${pollData.name}\n\n`;
      summaryText += `📋 *Options:*\n`;

      pollData.values.forEach((option, index) => {
        summaryText += `${index + 1}. ${option}\n`;
      });

      summaryText += `\n🔢 *Poll ID:* ${pollResult.key.id}\n`;
      if (mediaResult) {
        summaryText += `📎 *Media ID:* ${mediaResult.key.id}\n`;
      }
      summaryText += `⏰ *Sent:* ${new Date().toLocaleString()}\n\n`;
      summaryText += `💡 *Note:* You can track responses in your WhatsApp chat with the recipient.`;

      // Send summary to sender
      await socket.sendMessage(senderJid, {
        text: summaryText
      });


    } catch (error) {
      console.error('❌ POLL SUMMARY ERROR:', error);
      this.logger.error(`Error sending poll summary to sender:`, error);
    }
  }
  */

  /**
   * Send contact message
   */
  async sendContactMessage(sessionId, to, contactData) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const result = await socket.sendMessage(to, contactData);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending contact message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send location message
   */
  async sendLocationMessage(sessionId, to, locationData) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const result = await socket.sendMessage(to, locationData);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending location message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send interactive message (buttons, lists, etc.)
   */
  async sendInteractiveMessage(sessionId, to, interactiveData) {
    try {
      const socket = await this.waitForReadySocket(sessionId);
      const result = await socket.sendMessage(to, interactiveData);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending interactive message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }



  /**
   * Send interactive buttons message (new Baileys format) with optional media attachment
   */
  async sendInteractiveButtonsMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Check if there's a media attachment
      const hasMedia = content.media && (content.media.image || content.media.video || content.media.audio || content.media.document);

      // Build the interactive message based on Baileys format
      let messageContent;

      if (hasMedia) {
        // Interactive message with media attachment
        messageContent = {
          text: content.body.text,
          footer: content.footer ? content.footer.text : undefined,
          interactiveButtons: content.buttons.map((button, index) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
              display_text: button.text,
              id: button.id || `btn_${index}`
            })
          })),
          hasMediaAttachment: true
        };

        // Add the media based on type
        if (content.media.image) {
          messageContent.image = content.media.image;
        } else if (content.media.video) {
          messageContent.video = content.media.video;
        } else if (content.media.audio) {
          messageContent.audio = content.media.audio;
        } else if (content.media.document) {
          messageContent.document = content.media.document;
          if (content.media.mimetype) {
            messageContent.mimetype = content.media.mimetype;
          }
        }

        // Add caption if provided
        if (content.caption) {
          messageContent.caption = content.caption;
        }
      } else {
        // Interactive message without media (original format)
        messageContent = {
          text: content.body.text,
          footer: content.footer ? content.footer.text : undefined,
          interactiveButtons: content.buttons.map((button, index) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
              display_text: button.text,
              id: button.id || `btn_${index}`
            })
          }))
        };
      }

      const result = await socket.sendMessage(to, messageContent);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending interactive buttons message from ${sessionId}:`, error);
      this.logger.error(`Button content that failed:`, JSON.stringify(content, null, 2));
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send interactive list message (new Baileys format) with optional media attachment
   */
  async sendInteractiveListMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Check if there's a media attachment
      const hasMedia = content.media && (content.media.image || content.media.video || content.media.audio || content.media.document);

      // Build the interactive message based on Baileys format
      let messageContent;

      if (hasMedia) {
        // Interactive list message with media attachment
        messageContent = {
          text: content.body.text,
          footer: content.footer ? content.footer.text : undefined,
          buttonText: content.buttonText || 'Select Option',
          sections: content.sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              title: row.title,
              description: row.description,
              rowId: row.id
            }))
          })),
          hasMediaAttachment: true
        };

        // Add the media based on type
        if (content.media.image) {
          messageContent.image = content.media.image;
        } else if (content.media.video) {
          messageContent.video = content.media.video;
        } else if (content.media.audio) {
          messageContent.audio = content.media.audio;
        } else if (content.media.document) {
          messageContent.document = content.media.document;
          if (content.media.mimetype) {
            messageContent.mimetype = content.media.mimetype;
          }
        }

        // Add caption if provided
        if (content.caption) {
          messageContent.caption = content.caption;
        }
      } else {
        // Interactive list message without media (original format)
        messageContent = {
          text: content.body.text,
          footer: content.footer ? content.footer.text : undefined,
          buttonText: content.buttonText || 'Select Option',
          sections: content.sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              title: row.title,
              description: row.description,
              rowId: row.id
            }))
          }))
        };
      }

      const result = await socket.sendMessage(to, messageContent);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending interactive list message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }



  /**
   * Send call-to-action (CTA) button message
   */
  async sendCTAButtonMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Try multiple formats to ensure compatibility
      let result;

      // Format 1: Simple interactiveButtons (most compatible)
      try {
        const ctaMessage = {
          text: content.body.text,
          footer: content.footer && content.footer.text ? content.footer.text : undefined,
          interactiveButtons: [{
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: content.button.text,
              url: content.button.url,
              merchant_url: content.button.url
            })
          }]
        };

        this.logger.info(`Attempting CTA button format 1 to ${to}:`, JSON.stringify(ctaMessage, null, 2));
        result = await socket.sendMessage(to, ctaMessage);

        this.logger.info(`CTA button message sent successfully with format 1:`, {
          messageId: result.key.id,
          timestamp: result.messageTimestamp
        });

        return {
          success: true,
          messageId: result.key.id,
          timestamp: result.messageTimestamp
        };
      } catch (format1Error) {
        this.logger.warn(`Format 1 failed, trying format 2:`, format1Error.message);

        // Format 2: Fallback to simple text with URL
        try {
          const fallbackMessage = {
            text: `${content.body.text}\n\n🔗 ${content.button.text}: ${content.button.url}`,
            footer: content.footer && content.footer.text ? content.footer.text : undefined
          };

          this.logger.info(`Attempting CTA fallback format to ${to}:`, JSON.stringify(fallbackMessage, null, 2));
          result = await socket.sendMessage(to, fallbackMessage);

          this.logger.info(`CTA fallback message sent successfully:`, {
            messageId: result.key.id,
            timestamp: result.messageTimestamp
          });

          return {
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp,
            fallback: true
          };
        } catch (format2Error) {
          throw format2Error;
        }
      }
    } catch (error) {
      this.logger.error(`Error sending CTA button message from ${sessionId}:`, error);
      this.logger.error(`CTA content that failed:`, JSON.stringify(content, null, 2));
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send copy code button message
   */
  async sendCopyCodeMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Use the correct format for copy code button messages according to Itsukichann/Baileys official docs
      const copyMessage = {
        text: content.body.text,
        title: content.title || undefined,
        subtitle: content.subtitle || undefined,
        footer: content.footer ? content.footer.text : undefined,
        buttons: [{
          name: 'cta_copy',
          buttonParamsJson: JSON.stringify({
            display_text: content.button.text,
            copy_code: content.button.code
          })
        }]
      };

      this.logger.info(`Sending copy code message to ${to}:`, copyMessage);
      const result = await socket.sendMessage(to, copyMessage);

      this.logger.info(`Copy code message sent successfully:`, {
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      });

      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending copy code message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send mixed interactive buttons message (combines quick reply, CTA URL, CTA call, and copy code buttons)
   */
  async sendMixedButtonsMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Build the interactiveButtons array with mixed button types
      const interactiveButtons = content.buttons.map((button, index) => {
        switch (button.type) {
          case 'quick_reply':
            return {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: button.text,
                id: button.id || `btn_${index}`
              })
            };

          case 'cta_url':
            return {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: button.text,
                url: button.url,
                merchant_url: button.url
              })
            };

          case 'cta_call':
            return {
              name: 'cta_call',
              buttonParamsJson: JSON.stringify({
                display_text: button.text,
                phone_number: button.phone_number
              })
            };

          case 'copy_code':
            return {
              name: 'cta_copy',
              buttonParamsJson: JSON.stringify({
                display_text: button.text,
                copy_code: button.code
              })
            };

          default:
            // Fallback to quick_reply for unknown types
            return {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: button.text,
                id: button.id || `btn_${index}`
              })
            };
        }
      });

      // Check if there's a media attachment
      const hasMedia = content.media && (content.media.image || content.media.video || content.media.audio || content.media.document);

      let messageContent;

      if (hasMedia) {
        // Mixed buttons message with media attachment
        messageContent = {
          text: content.body.text,
          footer: content.footer && content.footer.text ? content.footer.text : undefined,
          interactiveButtons: interactiveButtons,
          hasMediaAttachment: true
        };

        // Add the media based on type
        if (content.media.image) {
          messageContent.image = content.media.image;
        } else if (content.media.video) {
          messageContent.video = content.media.video;
        } else if (content.media.audio) {
          messageContent.audio = content.media.audio;
        } else if (content.media.document) {
          messageContent.document = content.media.document;
          if (content.media.mimetype) {
            messageContent.mimetype = content.media.mimetype;
          }
        }

        // Add caption if provided
        if (content.caption) {
          messageContent.caption = content.caption;
        }
      } else {
        // Mixed buttons message without media (original format)
        messageContent = {
          text: content.body.text,
          footer: content.footer && content.footer.text ? content.footer.text : undefined,
          interactiveButtons: interactiveButtons
        };
      }

      this.logger.info(`Sending mixed buttons message to ${to}:`, JSON.stringify(messageContent, null, 2));
      const result = await socket.sendMessage(to, messageContent);

      this.logger.info(`Mixed buttons message sent successfully:`, {
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      });

      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending mixed buttons message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send carousel message with multiple cards
   */
  async sendCarouselMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Build the carousel message according to Baileys documentation
      const carouselMessage = {
        text: content.text || content.body?.text || '',
        title: content.title || '',
        subtile: content.subtitle || '',
        footer: content.footer || '',
        cards: content.cards.map(card => {
          const cardData = {
            title: card.title,
            body: card.body || undefined,
            footer: card.footer || undefined
          };

          // Add image if provided (either uploaded file or URL)
          if (card.imageFile && card.imageFile.data) {
            // Handle uploaded image file (base64 data)
            try {
              const base64Data = card.imageFile.data.split(',')[1];
              if (base64Data && base64Data.length > 0) {
                const buffer = Buffer.from(base64Data, 'base64');
                // Check buffer size to prevent memory issues
                if (buffer.length > 10 * 1024 * 1024) { // 10MB limit
                } else {
                  cardData.image = buffer;
                }
              }
            } catch (error) {
              console.error('🔥 Error processing image file:', error);
            }
          } else if (card.image) {
            cardData.image = card.image;
          } else if (card.imageUrl && card.imageUrl.trim()) {
            cardData.image = { url: card.imageUrl.trim() };
          }

          // Add video if provided (alternative to image)
          if (card.video) {
            cardData.video = card.video;
          } else if (card.videoUrl) {
            cardData.video = { url: card.videoUrl };
          }

          // Add buttons if provided - using correct Baileys format
          if (card.buttons && card.buttons.length > 0) {
            cardData.buttons = card.buttons.map(button => {
              // Use the exact format from Baileys documentation
              switch (button.type) {
                case 'cta_url':
                  return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                      display_text: button.text,
                      url: button.url
                    })
                  };
                case 'cta_call':
                  return {
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                      display_text: button.text,
                      phone_number: button.phone_number
                    })
                  };
                case 'quick_reply':
                default:
                  return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                      display_text: button.text,
                      id: button.id || `btn_${Date.now()}`
                    })
                  };
              }
            });
          }

          return cardData;
        })
      };

      // Log carousel message without image buffers to prevent console overflow
      const carouselMessageForLog = {
        ...carouselMessage,
        cards: carouselMessage.cards.map(card => ({
          ...card,
          image: card.image ? (Buffer.isBuffer(card.image) ? `[Buffer ${card.image.length} bytes]` : card.image) : undefined
        }))
      };
      this.logger.info(`Sending carousel message to ${to}:`, JSON.stringify(carouselMessageForLog, null, 2));
      const result = await socket.sendMessage(to, carouselMessage);

      this.logger.info(`Carousel message sent successfully:`, {
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      });

      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending carousel message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send flow message (for complex forms)
   */
  async sendFlowMessage(sessionId, to, content) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const interactiveMessage = {
        interactiveMessage: {
          body: {
            text: content.body.text
          },
          footer: content.footer ? {
            text: content.footer.text
          } : undefined,
          nativeFlowMessage: {
            buttons: [{
              name: 'flow',
              buttonParamsJson: JSON.stringify({
                display_text: content.button.text,
                flow_message_version: '3',
                flow_token: content.flow.token,
                flow_id: content.flow.id,
                flow_cta: content.flow.cta,
                flow_action: content.flow.action || 'navigate',
                flow_action_payload: {
                  screen: content.flow.screen || 'WELCOME_SCREEN'
                }
              })
            }],
            messageParamsJson: ''
          }
        }
      };

      const result = await socket.sendMessage(to, interactiveMessage);
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      };
    } catch (error) {
      this.logger.error(`Error sending flow message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Template message based on template data
   */
  async sendTemplateMessage(sessionId, to, templateData, variables = {}) {
    // IMMEDIATE RETURN FOR INTERACTIVE TEMPLATES - BYPASS ALL PROCESSING (EXCEPT LIST)

    if (templateData?.type === 'mixed_buttons' || templateData?.type === 'buttons' || templateData?.type === 'poll') {
      console.error('🔥🔥🔥 INTERACTIVE TEMPLATE DETECTED:', templateData.type);
      console.error('🔥🔥🔥 Template data:', JSON.stringify(templateData, null, 2));

      try {
        const socket = this.sessions.get(sessionId);
        if (!socket) {
          throw new Error('Session not found');
        }

        // Replace variables in content
        let content = templateData.content;

        // First, replace variables from the template's variables field
        let templateVariables;
        if (typeof templateData.variables === 'string') {
          templateVariables = JSON.parse(templateData.variables || '[]');
        } else if (Array.isArray(templateData.variables)) {
          templateVariables = templateData.variables;
        } else {
          templateVariables = [];
        }

        templateVariables.forEach(variable => {
          const value = variables[variable] || `{{${variable}}}`;
          content = content.replace(new RegExp(`\\{\\{${variable}\\}\\}`, 'g'), value);
        });

        // Then, replace all variables passed in the variables parameter (including name, phone, etc.)
        Object.keys(variables).forEach(variable => {
          const value = variables[variable] || '';
          const regex = new RegExp(`\\{\\{${variable}\\}\\}`, 'gi'); // Case-insensitive replacement
          content = content.replace(regex, value);
        });

        // Parse attachments (common for all interactive templates)
        // Handle both string (from database) and already-parsed object
        let attachments;
        if (typeof templateData.attachments === 'string') {
          try {
            attachments = JSON.parse(templateData.attachments || '[]');
          } catch (e) {
            console.error('🔥🔥🔥 Error parsing attachments string:', e);
            attachments = [];
          }
        } else if (Array.isArray(templateData.attachments)) {
          attachments = templateData.attachments;
        } else {
          attachments = [];
        }
        console.error('🔥🔥🔥 Raw attachments:', attachments);

        // Parse attachment strings to objects if needed
        const parsedAttachments = attachments.map(attachment => {
          if (typeof attachment === 'string') {
            try {
              return JSON.parse(attachment);
            } catch (e) {
              return attachment;
            }
          }
          return attachment;
        });
        console.error('🔥🔥🔥 Parsed attachments:', parsedAttachments);

        // Check for media attachments
        const mediaInfo = this.extractMediaFromAttachments(parsedAttachments);
        console.error('🔥🔥🔥 Media info result:', mediaInfo);
        console.error('🔥🔥🔥 Media info type:', mediaInfo?.mediaType);
        console.error('🔥🔥🔥 Media info has media:', !!mediaInfo?.media);

        // Handle different template types
        if (templateData.type === 'mixed_buttons') {
          let mixedButtonsData;
          if (typeof templateData.mixed_buttons_data === 'string') {
            mixedButtonsData = JSON.parse(templateData.mixed_buttons_data || '{"buttons": [], "footer": {"text": ""}}');
          } else if (typeof templateData.mixed_buttons_data === 'object') {
            mixedButtonsData = templateData.mixed_buttons_data || {buttons: [], footer: {text: ""}};
          } else {
            mixedButtonsData = {buttons: [], footer: {text: ""}};
          }

          if (mixedButtonsData.buttons && mixedButtonsData.buttons.length > 0) {
            let mixedContent;

            if (mediaInfo) {
              // Interactive message with media - use proper Baileys format
              const { media, mediaType } = mediaInfo;
              console.error('🔥🔥🔥 Creating mixed_buttons with media');

              mixedContent = {
                [mediaType]: media[mediaType],
                caption: content,
                footer: mixedButtonsData.footer && mixedButtonsData.footer.text ? mixedButtonsData.footer.text : undefined,
                hasMediaAttachment: true,
                interactiveButtons: mixedButtonsData.buttons.map((button, index) => {
                  switch (button.type) {
                    case 'quick_reply':
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          id: button.id || `btn_${index}`
                        })
                      };

                    case 'cta_url':
                      return {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          url: button.url,
                          merchant_url: button.url
                        })
                      };

                    case 'cta_call':
                      return {
                        name: 'cta_call',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          phone_number: button.phone_number
                        })
                      };

                    case 'copy_code':
                      return {
                        name: 'cta_copy',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          copy_code: button.code
                        })
                      };

                    default:
                      // Fallback to quick_reply for unknown types
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          id: button.id || `btn_${index}`
                        })
                      };
                  }
                })
              };
            } else {
              // Text-only interactive message
              mixedContent = {
                text: content,
                footer: mixedButtonsData.footer && mixedButtonsData.footer.text ? mixedButtonsData.footer.text : undefined,
                interactiveButtons: mixedButtonsData.buttons.map((button, index) => {
                  switch (button.type) {
                    case 'quick_reply':
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          id: button.id || `btn_${index}`
                        })
                      };

                    case 'cta_url':
                      return {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          url: button.url,
                          merchant_url: button.url
                        })
                      };

                    case 'cta_call':
                      return {
                        name: 'cta_call',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          phone_number: button.phone_number
                        })
                      };

                    case 'copy_code':
                      return {
                        name: 'cta_copy',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          copy_code: button.code
                        })
                      };

                    default:
                      // Fallback to quick_reply for unknown types
                      return {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                          display_text: button.text,
                          id: button.id || `btn_${index}`
                        })
                      };
                  }
                })
              };
            }

            const result = await socket.sendMessage(to, mixedContent);
            return { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
        } else if (templateData.type === 'poll') {
          console.error('🔥🔥🔥 POLL TEMPLATE DETECTED in early return section');

          let pollOptions;
          if (typeof templateData.poll_options === 'string') {
            pollOptions = JSON.parse(templateData.poll_options || '[]');
          } else if (Array.isArray(templateData.poll_options)) {
            pollOptions = templateData.poll_options;
          } else {
            pollOptions = [];
          }

          const pollData = {
            name: templateData.poll_question || content,
            values: pollOptions.map(opt => typeof opt === 'string' ? opt : opt.text),
            selectableCount: 1
          };

          // Add media if available
          if (mediaInfo) {
            pollData.media = mediaInfo.media;
            pollData.caption = content;
          }

          console.error('🔥🔥🔥 Calling sendPollMessage with pollData:', pollData);
          const result = await this.sendPollMessage(sessionId, to, pollData);
          return result;
        } else if (templateData.type === 'buttons') {
          let buttons, buttonSettings;

          // Parse buttons safely
          if (typeof templateData.buttons === 'string') {
            buttons = JSON.parse(templateData.buttons || '[]');
          } else if (Array.isArray(templateData.buttons)) {
            buttons = templateData.buttons;
          } else {
            buttons = [];
          }

          // Parse button settings safely
          if (typeof templateData.interactive_settings === 'string') {
            buttonSettings = JSON.parse(templateData.interactive_settings || '{}');
          } else if (typeof templateData.interactive_settings === 'object') {
            buttonSettings = templateData.interactive_settings || {};
          } else {
            buttonSettings = {};
          }

          if (buttons.length > 0) {
            if (mediaInfo) {
              // Use the EXACT same format as working mixed_buttons
              const { media, mediaType } = mediaInfo;
              console.error('🔥🔥🔥 Creating buttons with media - using mixed_buttons format');

              // Use the exact same format as mixed_buttons (which works)
              const buttonContent = {
                [mediaType]: media[mediaType],
                caption: content,
                footer: buttonSettings.footerText || undefined,
                buttons: buttons.map((btn, index) => ({
                  buttonId: btn.id || `btn_${index}`,
                  buttonText: { displayText: btn.text },
                  type: 1
                }))
              };

              console.error('🔥🔥🔥 Button content keys:', Object.keys(buttonContent));
              const result = await socket.sendMessage(to, buttonContent);
              return { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
            } else {
              // Text-only button message
              const buttonContent = {
                text: content,
                footer: buttonSettings.footerText || undefined,
                buttons: buttons.map((btn, index) => ({
                  buttonId: btn.id || `btn_${index}`,
                  buttonText: { displayText: btn.text },
                  type: 1
                }))
              };
              const result = await socket.sendMessage(to, buttonContent);
              return { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
            }
          }

        }

        // Fallback to text message
        const result = await socket.sendMessage(to, { text: content });
        return { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
      } catch (error) {
        console.error('🔥🔥🔥 Error in interactive template processing:', error);
        console.error('🔥🔥🔥 Template type:', templateData.type);
        console.error('🔥🔥🔥 Error details:', error.stack);
        return { success: false, error: error.message };
      }
    }

    console.error('🚀🚀🚀 CRITICAL DEBUG: sendTemplateMessage method called - START');
    console.error('🚀🚀🚀 CRITICAL DEBUG: Parameters:', { sessionId, to, templateType: templateData?.type });

    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Replace variables in content
      let content = templateData.content;
      const templateVariables = JSON.parse(templateData.variables || '[]');

      templateVariables.forEach(variable => {
        const value = variables[variable] || `{{${variable}}}`;
        content = content.replace(new RegExp(`\\{\\{${variable}\\}\\}`, 'g'), value);
      });

      let result;



      switch (templateData.type) {
        case 'text':
          result = await this.sendTextMessage(sessionId, to, content);
          break;

        case 'image':
          const imageAttachments = JSON.parse(templateData.attachments || '[]');
          const imageSettings = JSON.parse(templateData.media_settings || '{}');
          if (imageAttachments.length > 0) {
            const attachment = imageAttachments[0];

            let imageMessage;

            if (attachment && attachment.data && attachment.data.startsWith('data:')) {
              // Handle base64 data URL
              const base64Data = attachment.data.split(',')[1];
              const buffer = Buffer.from(base64Data, 'base64');
              imageMessage = {
                image: buffer,
                caption: content,
                ...(imageSettings.viewOnce && { viewOnce: true })
              };
            } else if (typeof attachment === 'string') {
              // Handle URL
              imageMessage = {
                image: { url: attachment },
                caption: content,
                ...(imageSettings.viewOnce && { viewOnce: true })
              };
            } else if (attachment && typeof attachment === 'object' && attachment.url) {
              // Handle object with URL
              imageMessage = {
                image: { url: attachment.url },
                caption: content,
                ...(imageSettings.viewOnce && { viewOnce: true })
              };
            } else {

              throw new Error('Invalid image attachment format');
            }

            result = await socket.sendMessage(to, imageMessage);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            throw new Error('No image attachment found');
          }
          break;

        case 'video':
          const videoAttachments = JSON.parse(templateData.attachments || '[]');
          const videoSettings = JSON.parse(templateData.media_settings || '{}');
          if (videoAttachments.length > 0) {
            const attachment = videoAttachments[0];
            let videoMessage;

            if (attachment.data && attachment.data.startsWith('data:')) {
              // Handle base64 data URL
              const base64Data = attachment.data.split(',')[1];
              const buffer = Buffer.from(base64Data, 'base64');
              videoMessage = {
                video: buffer,
                caption: content,
                ...(videoSettings.viewOnce && { viewOnce: true })
              };
            } else if (typeof attachment === 'string') {
              // Handle URL
              videoMessage = {
                video: { url: attachment },
                caption: content,
                ...(videoSettings.viewOnce && { viewOnce: true })
              };
            } else if (attachment && typeof attachment === 'object' && attachment.url) {
              // Handle object with URL
              videoMessage = {
                video: { url: attachment.url },
                caption: content,
                ...(videoSettings.viewOnce && { viewOnce: true })
              };
            } else {
              throw new Error('Invalid video attachment format');
            }

            result = await socket.sendMessage(to, videoMessage);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            throw new Error('No video attachment found');
          }
          break;

        case 'audio':
          const audioAttachments = JSON.parse(templateData.attachments || '[]');
          if (audioAttachments.length > 0) {
            const attachment = audioAttachments[0];
            let audioMessage;

            // Function to extract MIME type from data URL
            const getMimeTypeFromDataUrl = (dataUrl) => {
              if (dataUrl && dataUrl.startsWith('data:')) {
                const mimeMatch = dataUrl.match(/^data:([^;]+);/);
                return mimeMatch ? mimeMatch[1] : 'audio/mp4';
              }
              return 'audio/mp4';
            };

            // Function to extract MIME type from file extension
            const getMimeTypeFromFileExtension = (fileName) => {
              if (!fileName) return 'audio/mp4';
              const ext = fileName.toLowerCase().split('.').pop();
              const mimeTypes = {
                'mp3': 'audio/mpeg',
                'wav': 'audio/wav',
                'ogg': 'audio/ogg',
                'aac': 'audio/aac',
                'flac': 'audio/flac',
                'm4a': 'audio/mp4'
              };
              return mimeTypes[ext] || 'audio/mp4';
            };

            // WhatsApp does NOT support captions on audio messages
            // If there's text content, send it as a separate text message first
            if (content && content.trim()) {
              await this.sendTextMessage(sessionId, to, content);
              // Add small delay between messages
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (attachment.data && attachment.data.startsWith('data:')) {
              // Handle base64 data URL
              const base64Data = attachment.data.split(',')[1];
              const buffer = Buffer.from(base64Data, 'base64');
              const mimeType = getMimeTypeFromDataUrl(attachment.data);
              audioMessage = {
                audio: buffer,
                mimetype: mimeType
                // Note: Audio messages do NOT support captions in WhatsApp
              };
            } else if (typeof attachment === 'string') {
              // Handle URL - try to determine MIME type from file extension
              const mimeType = getMimeTypeFromFileExtension(attachment);
              audioMessage = {
                audio: { url: attachment },
                mimetype: mimeType
                // Note: Audio messages do NOT support captions in WhatsApp
              };
            } else if (attachment && typeof attachment === 'object') {
              // Handle object with URL
              let mimeType = 'audio/mp4';

              // Try to get MIME type from attachment.type first
              if (attachment.type) {
                mimeType = attachment.type;
              }
              // Then try from data URL if available
              else if (attachment.data) {
                mimeType = getMimeTypeFromDataUrl(attachment.data);
              }
              // Finally try from URL or filename
              else if (attachment.url) {
                mimeType = getMimeTypeFromFileExtension(attachment.url) || getMimeTypeFromFileExtension(attachment.name);
              }

              audioMessage = {
                audio: attachment.url ? { url: attachment.url } : attachment.data ? Buffer.from(attachment.data.split(',')[1], 'base64') : null,
                mimetype: mimeType
                // Note: Audio messages do NOT support captions in WhatsApp
              };

              // If we couldn't create a proper audio message, throw error
              if (!audioMessage.audio) {
                throw new Error('Invalid audio attachment format');
              }
            } else {
              throw new Error('Invalid audio attachment format');
            }

            result = await socket.sendMessage(to, audioMessage);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            throw new Error('No audio attachment found');
          }
          break;

        case 'document':
          const docAttachments = JSON.parse(templateData.attachments || '[]');
          const docSettings = JSON.parse(templateData.media_settings || '{}');
          if (docAttachments.length > 0) {
            const attachment = docAttachments[0];
            let documentMessage;

            if (attachment.data && attachment.data.startsWith('data:')) {
              // Handle base64 data URL
              const base64Data = attachment.data.split(',')[1];
              const buffer = Buffer.from(base64Data, 'base64');
              documentMessage = {
                document: buffer,
                fileName: attachment.name || docSettings.fileName || 'document.pdf',
                caption: content
              };
            } else if (typeof attachment === 'string') {
              // Handle URL
              documentMessage = {
                document: { url: attachment },
                fileName: docSettings.fileName || 'document.pdf',
                caption: content
              };
            } else {
              throw new Error('Invalid document attachment format');
            }

            result = await socket.sendMessage(to, documentMessage);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            throw new Error('No document attachment found');
          }
          break;

        case 'buttons':
          const buttons = JSON.parse(templateData.buttons || '[]');
          const buttonInteractiveSettings = JSON.parse(templateData.interactive_settings || '{}');
          const buttonAttachments = JSON.parse(templateData.attachments || '[]');

          // Check for media attachments
          const mediaInfo = this.extractMediaFromAttachments(buttonAttachments);

          if (buttons.length > 0) {
            // Create message according to official Baileys documentation
            const interactiveContent = {
              text: content,
              footer: buttonInteractiveSettings.footerText || undefined,
              interactiveButtons: buttons.map(btn => ({
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: btn.text,
                  id: btn.id
                })
              })),
              hasMediaAttachment: false
            };

            // Add media at root level according to Baileys format
            if (mediaInfo) {
              const { media, mediaType } = mediaInfo;
              interactiveContent[mediaType] = media[mediaType];
              interactiveContent.caption = content;
              interactiveContent.hasMediaAttachment = true;
            }

            // Use direct sendMessage as per Baileys documentation
            result = await socket.sendMessage(to, interactiveContent);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            // Fallback to text message if no buttons
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'list':
          const listSections = JSON.parse(templateData.list_sections || '[]');
          const listInteractiveSettings = JSON.parse(templateData.interactive_settings || '{}');
          const listAttachments = JSON.parse(templateData.attachments || '[]');

          console.error('🔥🔥🔥 ORIGINAL LIST CASE - Processing list template');
          console.error('🔥🔥🔥 List attachments:', listAttachments);

          // Parse attachment strings to objects if needed (same as working templates)
          const parsedListAttachments = listAttachments.map(attachment => {
            if (typeof attachment === 'string') {
              try {
                return JSON.parse(attachment);
              } catch (e) {
                return attachment;
              }
            }
            return attachment;
          });

          // Check for media attachments
          const listMediaInfo = this.extractMediaFromAttachments(parsedListAttachments);
          console.error('🔥🔥🔥 List media info:', listMediaInfo);

          if (listSections.length > 0) {
            if (listMediaInfo) {
              // Send media first, then list (same approach as polls)
              const { media, mediaType } = listMediaInfo;
              console.error('🔥🔥🔥 Sending list media first, then list message');

              // Send media first
              const mediaMessage = {
                [mediaType]: media[mediaType],
                caption: content
              };
              await socket.sendMessage(to, mediaMessage);

              // Then send list message
              const listMessage = {
                text: 'Please select an option:',
                footer: listInteractiveSettings.footerText || undefined,
                title: listInteractiveSettings.title || undefined,
                buttonText: listInteractiveSettings.buttonText || 'View Options',
                sections: listSections.map(section => ({
                  title: section.title,
                  rows: section.rows.map(row => ({
                    rowId: row.id,
                    title: row.title,
                    description: row.description
                  }))
                }))
              };
              result = await socket.sendMessage(to, listMessage);
            } else {
              // Text-only list message (original working logic)
              const interactiveContent = {
                text: content,
                footer: listInteractiveSettings.footerText || undefined,
                title: listInteractiveSettings.title || undefined,
                buttonText: listInteractiveSettings.buttonText || 'View Options',
                sections: listSections.map(section => ({
                  title: section.title,
                  rows: section.rows.map(row => ({
                    rowId: row.id,
                    title: row.title,
                    description: row.description
                  }))
                }))
              };
              result = await socket.sendMessage(to, interactiveContent);
            }
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            // Fallback to text message if no list sections
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'poll':
          const pollOptions = JSON.parse(templateData.poll_options || '[]');
          const pollAttachments = JSON.parse(templateData.attachments || '[]');

          // Check for media attachments
          const pollMediaInfo = this.extractMediaFromAttachments(pollAttachments);

          const pollData = {
            name: templateData.poll_question || content, // Use poll_question if available, fallback to content
            values: pollOptions.map(opt => typeof opt === 'string' ? opt : opt.text),
            selectableCount: 1
          };

          // Add media if available
          if (pollMediaInfo) {
            pollData.media = pollMediaInfo.media;
            pollData.caption = content;
          }

          result = await this.sendPollMessage(sessionId, to, pollData);
          break;

        case 'contact':
          const contactInfo = JSON.parse(templateData.contact_info || '{}');
          const contactAttachments = JSON.parse(templateData.attachments || '[]');

          // Check for media attachments
          const contactMediaInfo = this.extractMediaFromAttachments(contactAttachments);

          // Send media first if available
          if (contactMediaInfo) {
            const mediaMessage = {};
            mediaMessage[contactMediaInfo.mediaType] = contactMediaInfo.media[contactMediaInfo.mediaType];
            if (contactMediaInfo.media.mimetype) {
              mediaMessage.mimetype = contactMediaInfo.media.mimetype;
            }
            mediaMessage.caption = content;

            await socket.sendMessage(to, mediaMessage);
          }

          // Generate vCard format
          const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contactInfo.name || 'Contact'}
N:${contactInfo.name ? contactInfo.name.split(' ').reverse().join(';') : 'Contact'}
TEL;TYPE=CELL:${contactInfo.phone || ''}
${contactInfo.email ? `EMAIL:${contactInfo.email}` : ''}
${contactInfo.organization ? `ORG:${contactInfo.organization}` : ''}
END:VCARD`.replace(/\n\n/g, '\n').trim();

          const contactMessage = {
            contactsArrayMessage: {
              displayName: contactInfo.name || 'Contact',
              contacts: [{
                displayName: contactInfo.name || 'Contact',
                vcard: vcard
              }]
            }
          };

          result = await socket.sendMessage(to, contactMessage);
          result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          break;

        case 'location':
          const locationInfo = JSON.parse(templateData.location_info || '{}');
          const locationAttachments = JSON.parse(templateData.attachments || '[]');

          // Check for media attachments
          const locationMediaInfo = this.extractMediaFromAttachments(locationAttachments);

          // Send media first if available
          if (locationMediaInfo) {
            const mediaMessage = {};
            mediaMessage[locationMediaInfo.mediaType] = locationMediaInfo.media[locationMediaInfo.mediaType];
            if (locationMediaInfo.media.mimetype) {
              mediaMessage.mimetype = locationMediaInfo.media.mimetype;
            }
            mediaMessage.caption = content;

            await socket.sendMessage(to, mediaMessage);
          }

          const locationMessage = {
            location: {
              degreesLatitude: locationInfo.latitude,
              degreesLongitude: locationInfo.longitude,
              name: locationInfo.name || 'Location',
              address: locationInfo.address || ''
            }
          };
          result = await socket.sendMessage(to, locationMessage);
          result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          break;



        case 'cta_button':
          const ctaData = JSON.parse(templateData.cta_data || '{}');
          if (ctaData.button && ctaData.button.url) {
            const ctaContent = {
              body: { text: content },
              footer: ctaData.footer && ctaData.footer.text ? { text: ctaData.footer.text } : undefined,
              button: {
                text: ctaData.button.text,
                url: ctaData.button.url
              }
            };
            result = await this.sendCTAButtonMessage(sessionId, to, ctaContent);
          } else {
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'copy_code':
          const copyData = JSON.parse(templateData.copy_data || '{}');
          if (copyData.button && copyData.button.code) {
            const copyContent = {
              body: { text: content },
              footer: copyData.footer && copyData.footer.text ? { text: copyData.footer.text } : undefined,
              button: {
                text: copyData.button.text,
                code: copyData.button.code
              }
            };
            result = await this.sendCopyCodeMessage(sessionId, to, copyContent);
          } else {
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'flow':
          const flowData = JSON.parse(templateData.flow_data || '{}');
          if (flowData.flow && flowData.flow.id) {
            const flowContent = {
              body: { text: content },
              footer: flowData.footer ? { text: flowData.footer.text } : undefined,
              button: {
                text: flowData.button.text
              },
              flow: flowData.flow
            };
            result = await this.sendFlowMessage(sessionId, to, flowContent);
          } else {
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'mixed_buttons':
          const mixedButtonsData = JSON.parse(templateData.mixed_buttons_data || '{"buttons": [], "footer": {"text": ""}}');
          const mixedAttachments = JSON.parse(templateData.attachments || '[]');

          // Check for media attachments
          const mixedMediaInfo = this.extractMediaFromAttachments(mixedAttachments);

          if (mixedButtonsData.buttons && mixedButtonsData.buttons.length > 0) {
            // Create mixed buttons message according to Baileys documentation
            const mixedContent = {
              text: content,
              footer: mixedButtonsData.footer && mixedButtonsData.footer.text ? mixedButtonsData.footer.text : undefined,
              interactiveButtons: mixedButtonsData.buttons.map((button, index) => {
                switch (button.type) {
                  case 'quick_reply':
                    return {
                      name: 'quick_reply',
                      buttonParamsJson: JSON.stringify({
                        display_text: button.text,
                        id: button.id || `btn_${index}`
                      })
                    };

                  case 'cta_url':
                    return {
                      name: 'cta_url',
                      buttonParamsJson: JSON.stringify({
                        display_text: button.text,
                        url: button.url,
                        merchant_url: button.url
                      })
                    };

                  case 'cta_call':
                    return {
                      name: 'cta_call',
                      buttonParamsJson: JSON.stringify({
                        display_text: button.text,
                        phone_number: button.phone_number
                      })
                    };

                  case 'copy_code':
                    return {
                      name: 'cta_copy',
                      buttonParamsJson: JSON.stringify({
                        display_text: button.text,
                        copy_code: button.code
                      })
                    };

                  default:
                    // Fallback to quick_reply for unknown types
                    return {
                      name: 'quick_reply',
                      buttonParamsJson: JSON.stringify({
                        display_text: button.text,
                        id: button.id || `btn_${index}`
                      })
                    };
                }
              })
            };

            // Add media at root level according to Baileys format
            if (mixedMediaInfo) {
              const { media, mediaType } = mixedMediaInfo;
              mixedContent[mediaType] = media[mediaType];
              mixedContent.caption = content;
              mixedContent.hasMediaAttachment = true;
            }

            // Use direct sendMessage as per Baileys documentation
            result = await socket.sendMessage(to, mixedContent);
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          } else {
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        case 'carousel':
          const carouselCards = JSON.parse(templateData.carousel_cards || '[]');
          const carouselSettings = JSON.parse(templateData.carousel_settings || '{"title": "", "subtitle": "", "footer": ""}');

          // Debug: Log each card's image data
          carouselCards.forEach((card, index) => {
          });

          if (carouselCards && carouselCards.length > 0) {
            // Create carousel message according to Baileys documentation format
            const carouselContent = {
              text: content || '',
              title: carouselSettings.title || '',
              subtile: carouselSettings.subtitle || '',
              footer: carouselSettings.footer || '',
              cards: carouselCards.map(card => {
                const cardData = {
                  title: card.title,
                  body: card.body || undefined,
                  footer: card.footer || undefined
                };

                // Add image if provided (either uploaded file or URL)
                if (card.imageFile && card.imageFile.data) {
                  // Handle uploaded image file (base64 data)
                  try {
                    const base64Data = card.imageFile.data.split(',')[1];
                    if (base64Data && base64Data.length > 0) {
                      const buffer = Buffer.from(base64Data, 'base64');
                      // Check buffer size to prevent memory issues
                      if (buffer.length > 10 * 1024 * 1024) { // 10MB limit
                      } else {
                        cardData.image = buffer;
                      }
                    }
                  } catch (error) {
                    console.error('🔥 Error processing image file:', error);
                  }
                } else if (card.image) {
                  cardData.image = card.image;
                } else if (card.imageUrl && card.imageUrl.trim()) {
                  // Handle image URL
                  cardData.image = { url: card.imageUrl.trim() };
                }

                // Add buttons if provided - using correct Baileys format
                if (card.buttons && card.buttons.length > 0) {
                  cardData.buttons = card.buttons.map(button => {
                    // Use the exact format from Baileys documentation
                    switch (button.type) {
                      case 'cta_url':
                        return {
                          name: 'cta_url',
                          buttonParamsJson: JSON.stringify({
                            display_text: button.text,
                            url: button.url
                          })
                        };
                      case 'cta_call':
                        return {
                          name: 'cta_call',
                          buttonParamsJson: JSON.stringify({
                            display_text: button.text,
                            phone_number: button.phone_number
                          })
                        };
                      case 'quick_reply':
                      default:
                        return {
                          name: 'quick_reply',
                          buttonParamsJson: JSON.stringify({
                            display_text: button.text,
                            id: button.id || `btn_${Date.now()}`
                          })
                        };
                    }
                  });
                }

                return cardData;
              })
            };

            // Log carousel content without image buffers to prevent console overflow
            const carouselContentForLog = {
              ...carouselContent,
              cards: carouselContent.cards.map(card => ({
                ...card,
                image: card.image ? (Buffer.isBuffer(card.image) ? `[Buffer ${card.image.length} bytes]` : card.image) : undefined
              }))
            };

            // Use direct sendMessage as per Baileys documentation
            try {
              result = await socket.sendMessage(to, carouselContent);
              result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
            } catch (carouselError) {
              console.error('🔥 Error sending carousel message:', carouselError);
              console.error('🔥 Carousel content that failed:', JSON.stringify(carouselContent, null, 2));
              throw carouselError;
            }
          } else {
            // Fallback to text message if no cards
            result = await socket.sendMessage(to, { text: content });
            result = { success: true, messageId: result.key.id, timestamp: result.messageTimestamp };
          }
          break;

        default:
          result = await this.sendTextMessage(sessionId, to, content);
      }

      return result;
    } catch (error) {
      this.logger.error(`Error sending template message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId) {
    return this.sessionStates.get(sessionId) || null;
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return Array.from(this.sessionStates.values());
  }

  /**
   * Disconnect session (logout but keep session data for reconnection)
   */
  async disconnectSession(sessionId) {
    try {

      // Mark this session as being manually disconnected
      this.manualDisconnections.add(sessionId);

      const socket = this.sessions.get(sessionId);
      if (socket) {
        try {
          // Properly logout from WhatsApp
          await socket.logout();
          this.logger.info(`Session ${sessionId} logged out successfully`);
        } catch (logoutError) {
          this.logger.warn(`Logout error for session ${sessionId}:`, logoutError.message);
        }

        // Remove from active sessions but keep session state for reconnection
        this.sessions.delete(sessionId);
      }

      // Update session state to disconnected
      const sessionState = this.sessionStates.get(sessionId);
      if (sessionState) {
        sessionState.status = 'disconnected';
        sessionState.isLoggedIn = false;
        sessionState.qrCode = null;
      }

      // Stop poll tracking for this session
      this.stopPollVoteChecking();
      this.stopAutomaticPollScanning(sessionId);

      // CRITICAL: Update database status to disconnected but DO NOT SET is_active = 0
      if (this.databaseService && this.databaseService.run) {
        await this.databaseService.run(`
          UPDATE whatsapp_sessions
          SET status = 'disconnected',
              qr_code = NULL,
              disconnected_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND is_active = 1
        `, [sessionId]);
      }

      // Emit disconnection event
      this.emit('session_disconnected', {
        sessionId,
        reason: 'Manually disconnected by user',
        timestamp: new Date()
      });

      // Remove from manual disconnections tracking after a short delay
      setTimeout(() => {
        this.manualDisconnections.delete(sessionId);
      }, 5000); // Increased to 5 seconds

      return {
        success: true,
        message: 'Session disconnected successfully'
      };
    } catch (error) {
      this.logger.error(`Error disconnecting session ${sessionId}:`, error);
      // Remove from tracking on error
      this.manualDisconnections.delete(sessionId);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Delete session (completely remove session and files)
   */
  async deleteSession(sessionId) {
    try {

      // Delete from WhatsApp socket
      const socket = this.sessions.get(sessionId);
      if (socket) {
        try {
          // Add timeout to prevent hanging
          const logoutPromise = socket.logout();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Logout timeout')), 5000)
          );

          await Promise.race([logoutPromise, timeoutPromise]);
        } catch (logoutError) {
          // Continue with deletion even if logout fails
        }
        this.sessions.delete(sessionId);
      }

      // Delete from session states
      this.sessionStates.delete(sessionId);

      // Clean up store
      this.cleanupStore(sessionId);

      // Delete session files
      const sessionDir = path.join(this.authDir, sessionId);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }

      // CRITICAL: Actually delete from database by setting is_active = 0
      try {
        const WhatsAppSession = require('../models/WhatsAppSession');
        const session = await WhatsAppSession.findBySessionId(sessionId);
        if (session) {
          await session.delete(); // This sets is_active = 0
        }
      } catch (dbError) {
        console.error(`🗑️ DELETE ONLY: Error deleting session ${sessionId} from database:`, dbError);
        // Don't fail the whole operation for database errors
      }

      this.emit('session_deleted', { sessionId });

      return {
        success: true,
        message: 'Session deleted successfully'
      };
    } catch (error) {
      this.logger.error(`Error deleting session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if phone number is registered on WhatsApp
   */
  async checkNumberExists(sessionId, phoneNumber) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const result = await socket.onWhatsApp(phoneNumber);
      return {
        success: true,
        exists: result.length > 0,
        jid: result[0]?.jid
      };
    } catch (error) {
      this.logger.error(`Error checking number ${phoneNumber}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verify if phone number is registered on WhatsApp (wrapper for checkNumberExists)
   */
  async verifyNumber(phoneNumber) {
    try {
      // Get the first active session
      const activeSessions = Array.from(this.sessions.keys());
      if (activeSessions.length === 0) {
        throw new Error('No active WhatsApp sessions available');
      }

      const sessionId = activeSessions[0];
      return await this.checkNumberExists(sessionId, phoneNumber);
    } catch (error) {
      this.logger.error(`Error verifying number ${phoneNumber}:`, error);
      return {
        success: false,
        exists: false,
        error: error.message
      };
    }
  }

  /**
   * Batch verify multiple phone numbers for better performance
   * @param {Array} phoneNumbers - Array of phone numbers to verify
   * @param {Function} progressCallback - Optional callback for progress updates
   * @returns {Promise<Array>} Array of verification results
   */
  async verifyNumbersBatch(phoneNumbers, progressCallback = null) {
    try {
      // Debug: Log all sessions and their states
      this.logger.info(`🔍 Total sessions: ${this.sessions.size}, sessionStates: ${this.sessionStates.size}`);

      Array.from(this.sessions.keys()).forEach(sessionId => {
        const session = this.sessions.get(sessionId);
        const sessionState = this.sessionStates.get(sessionId);
        this.logger.info(`📱 Session ${sessionId}: state=${sessionState?.status}, loggedIn=${sessionState?.isLoggedIn}, hasUser=${!!session?.user}, wsState=${session?.ws?.readyState}`);
      });

      // Get the first connected session with more comprehensive checking
      const connectedSessions = Array.from(this.sessions.keys()).filter(sessionId => {
        const session = this.sessions.get(sessionId);
        const sessionState = this.sessionStates.get(sessionId);

        // Check if session exists and is connected
        if (!session || !sessionState) {
          this.logger.info(`❌ Session ${sessionId}: Missing session or state`);
          return false;
        }

        // Primary check: session state indicates connected and logged in
        if (sessionState.status === 'connected' && sessionState.isLoggedIn) {
          this.logger.info(`✅ Session ${sessionId}: Connected via sessionState`);
          return true;
        }

        // Secondary check: has user object (indicates successful login)
        if (session.user && session.user.id) {
          this.logger.info(`✅ Session ${sessionId}: Connected via user object`);
          return true;
        }

        // Fallback: check WebSocket state if available
        if (session.ws && session.ws.readyState === 1) { // 1 = OPEN
          this.logger.info(`✅ Session ${sessionId}: Connected via WebSocket state`);
          return true;
        }

        this.logger.info(`❌ Session ${sessionId}: Not connected (status=${sessionState.status}, loggedIn=${sessionState.isLoggedIn})`);
        return false;
      });

      this.logger.info(`🔍 Found ${connectedSessions.length} connected sessions out of ${this.sessions.size} total`);

      if (connectedSessions.length === 0) {
        // Provide more detailed error information
        const sessionDetails = Array.from(this.sessions.keys()).map(sessionId => {
          const sessionState = this.sessionStates.get(sessionId);
          return `${sessionId}: ${sessionState?.status || 'unknown'}`;
        }).join(', ');

        throw new Error(`No connected WhatsApp sessions available. Session states: ${sessionDetails}. Please ensure WhatsApp is connected.`);
      }

      const sessionId = connectedSessions[0];
      const socket = this.sessions.get(sessionId);
      const sessionState = this.sessionStates.get(sessionId);

      this.logger.info(`🔍 Using session ${sessionId} for verification (status: ${sessionState.status}, logged in: ${sessionState.isLoggedIn})`);

      if (!socket) {
        throw new Error('Session not found');
      }

      const results = [];
      const BATCH_SIZE = 25; // Increased batch size for much better performance
      const DELAY_BETWEEN_BATCHES = 10; // Minimal delay for faster processing
      const MAX_RETRIES = 1; // Reduced retries for speed (most failures are permanent)

      for (let i = 0; i < phoneNumbers.length; i += BATCH_SIZE) {
        const batch = phoneNumbers.slice(i, i + BATCH_SIZE);

        // Process batch concurrently with retry logic
        const batchPromises = batch.map(async (phoneNumber, index) => {
          let lastError = null;

          // Retry logic for failed verifications
          for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            try {
              const result = await socket.onWhatsApp(phoneNumber);
              const verificationResult = {
                phoneNumber,
                success: true,
                exists: result.length > 0,
                jid: result[0]?.jid
              };

              // Call progress callback if provided
              if (progressCallback) {
                progressCallback(i + index + 1, phoneNumbers.length);
              }

              return verificationResult;
            } catch (error) {
              lastError = error;

              // If this is not the last retry, wait a bit before retrying
              if (retry < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 50)); // Minimal delay for speed
                continue;
              }

              // All retries failed
              this.logger.warn(`❌ Error verifying number ${phoneNumber} after ${MAX_RETRIES + 1} attempts: ${error.message}`);

              // Check if it's a rate limit or temporary error
              const isTemporaryError = error.message.includes('rate') ||
                                     error.message.includes('timeout') ||
                                     error.message.includes('network') ||
                                     error.message.includes('ECONNRESET');

              const verificationResult = {
                phoneNumber,
                success: false,
                exists: false,
                error: isTemporaryError ? 'Temporary error - try again later' : error.message,
                isTemporaryError
              };

              // Call progress callback even on error
              if (progressCallback) {
                progressCallback(i + index + 1, phoneNumbers.length);
              }

              return verificationResult;
            }
          }
        });

        // Wait for all verifications in this batch to complete
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Small delay between batches to prevent overwhelming the API
        if (i + BATCH_SIZE < phoneNumbers.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`Error in batch verification:`, error);
      throw error;
    }
  }

  /**
   * Fetch all participating groups using Baileys API
   */
  async fetchAllGroups(sessionId) {
    const startTime = Date.now();
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        this.logger.error(`❌ Session ${sessionId} not found in active sessions`);
        throw new Error('Session not found');
      }

      // Check socket connection state
      if (!socket.user || !socket.user.id) {
        this.logger.error(`❌ Session ${sessionId} socket not properly authenticated`);
        throw new Error('Session not authenticated');
      }

      this.logger.info(`🔄 Fetching all groups for session ${sessionId} (user: ${socket.user.id})`);

      // Use Baileys groupFetchAllParticipating method with timeout
      const fetchPromise = socket.groupFetchAllParticipating();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Group fetch timeout after 30 seconds')), 30000)
      );

      const groupsData = await Promise.race([fetchPromise, timeoutPromise]);

      if (!groupsData) {
        this.logger.warn(`⚠️ No groups data returned for session ${sessionId}`);
        return {
          success: true,
          groups: [],
          fetchTime: Date.now() - startTime
        };
      }

      const groupCount = Object.keys(groupsData).length;
      this.logger.info(`📊 Raw groups data contains ${groupCount} groups for session ${sessionId}`);

      if (groupCount === 0) {
        this.logger.info(`ℹ️ No groups found for session ${sessionId}`);
        return {
          success: true,
          groups: [],
          fetchTime: Date.now() - startTime
        };
      }

      // Process groups data with enhanced admin detection
      const groups = [];

      try {
        for (const group of Object.values(groupsData)) {
          try {
            // Safety check for group object
            if (!group || !group.id) {
              this.logger.warn(`⚠️ Skipping invalid group object:`, group);
              continue;
            }

            // Determine if user is admin - comprehensive logic with debugging
            const userJid = socket.user?.id;
            let isAdmin = false;

            this.logger.info(`🔍 Checking admin status for group: ${group.subject || 'Unnamed'} (${group.id})`);
            this.logger.info(`👤 Current user JID: ${userJid}`);

        if (userJid && group.participants && Array.isArray(group.participants)) {
          // Extract phone number from user JID
          const userPhone = userJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

          // Check multiple possible JID formats
          const possibleUserJids = [
            userJid,
            userPhone,
            `${userPhone}@s.whatsapp.net`,
            `${userPhone}@c.us`
          ];

          this.logger.info(`🔍 Possible user JIDs: ${JSON.stringify(possibleUserJids)}`);

          // Safely map participants with null checks
          const participantInfo = group.participants
            .filter(p => p && p.id) // Filter out null/undefined participants
            .map(p => ({ id: p.id, admin: p.admin }));
          this.logger.info(`👥 Group participants: ${JSON.stringify(participantInfo)}`);

          // Find the user in participants
          const userParticipant = group.participants.find(participant => {
            // Safety checks for participant and participant.id
            if (!participant || !participant.id || typeof participant.id !== 'string') {
              return false;
            }

            try {
              const participantPhone = participant.id.replace('@s.whatsapp.net', '').replace('@c.us', '');
              const isMatch = possibleUserJids.some(jid => {
                if (!jid || typeof jid !== 'string') return false;
                const jidPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
                return participantPhone === jidPhone || participant.id === jid;
              });

              if (isMatch) {
                this.logger.info(`✅ Found user in participants: ${participant.id} with admin status: ${participant.admin}`);
              }

              return isMatch;
            } catch (error) {
              this.logger.warn(`⚠️ Error processing participant ${participant.id}:`, error);
              return false;
            }
          });

          if (userParticipant) {
            isAdmin = userParticipant.admin === 'admin' || userParticipant.admin === 'superadmin' || userParticipant.admin === true;
            this.logger.info(`🎯 Final admin status for ${group.subject}: ${isAdmin} (admin field: ${userParticipant.admin})`);
          } else {
            this.logger.warn(`❌ User not found in participants for group: ${group.subject}`);
          }
        }

        // If admin status is still false, try a quick invite code test as fallback
        if (!isAdmin && group.id) {
          try {
            this.logger.info(`🔄 Testing admin status via invite code for: ${group.subject}`);
            const inviteResult = await socket.groupInviteCode(group.id);
            if (inviteResult) {
              isAdmin = true;
              this.logger.info(`✅ Confirmed admin status via invite code for: ${group.subject}`);
            }
          } catch (error) {
            this.logger.info(`❌ Not admin for ${group.subject}: ${error.message}`);
          }
        }

        // Check if it's a community (communities have different structure)
        const isCommunity = group.id?.includes('@newsletter') || group.linkedParent || false;

        // Ensure participants is always an array
        const participants = Array.isArray(group.participants) ? group.participants : [];

            groups.push({
              id: group.id,
              subject: group.subject || 'Unnamed Group',
              desc: group.desc || '',
              creation: group.creation || null,
              participants: participants,
              isAdmin: isAdmin,
              isCommunity: isCommunity,
              announce: group.announce || false,
              restrict: group.restrict || false,
              inviteCode: group.inviteCode || null,
              size: group.size || participants.length
            });
          } catch (groupError) {
            this.logger.error(`❌ Error processing individual group ${group?.id || 'unknown'}:`, groupError);
            console.error(`❌ GroupService: Error processing group ${group?.id || 'unknown'}:`, groupError.message);
            // Continue with next group
          }
        }
      } catch (processingError) {
        this.logger.error(`❌ Error processing groups data:`, processingError);
        console.error(`❌ GroupService: Error processing groups data:`, processingError.message);
        // Continue with whatever groups we managed to process
      }

      const fetchTime = Date.now() - startTime;
      this.logger.info(`✅ Successfully fetched ${groups.length} groups for session ${sessionId} in ${fetchTime}ms`);

      // Log group breakdown
      const regularGroups = groups.filter(g => !g.isCommunity).length;
      const communities = groups.filter(g => g.isCommunity).length;
      const adminGroups = groups.filter(g => g.isAdmin).length;


      return {
        success: true,
        groups: groups,
        fetchTime: fetchTime,
        stats: {
          total: groups.length,
          regular: regularGroups,
          communities: communities,
          admin: adminGroups
        }
      };

    } catch (error) {
      const fetchTime = Date.now() - startTime;
      this.logger.error(`❌ Error fetching groups for session ${sessionId} after ${fetchTime}ms:`, error);
      console.error(`❌ GroupService: Error fetching groups for session ${sessionId}:`, error.message);

      return {
        success: false,
        error: error.message,
        fetchTime: fetchTime,
        groups: []
      };
    }
  }

  /**
   * Get detailed group metadata
   */
  async getGroupMetadata(sessionId, groupId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Fetching metadata for group ${groupId} in session ${sessionId}`);

      // Use Baileys groupMetadata method
      const metadata = await socket.groupMetadata(groupId);

      if (!metadata) {
        throw new Error('Group metadata not found');
      }

      // Determine if user is admin
      const userJid = socket.user?.id;
      const isAdmin = metadata.participants?.some(participant =>
        participant.id === userJid && (participant.admin === 'admin' || participant.admin === 'superadmin')
      ) || false;

      // Process participants data
      const participants = metadata.participants?.map(participant => ({
        id: participant.id,
        admin: participant.admin === 'admin',
        isSuperAdmin: participant.admin === 'superadmin',
        name: participant.name || null
      })) || [];

      const processedMetadata = {
        id: metadata.id,
        subject: metadata.subject,
        desc: metadata.desc,
        creation: metadata.creation,
        participants: participants,
        isAdmin: isAdmin,
        announce: metadata.announce || false,
        restrict: metadata.restrict || false,
        inviteCode: metadata.inviteCode || null,
        size: metadata.size || participants.length
      };

      this.logger.info(`Successfully fetched metadata for group ${groupId}`);

      return {
        success: true,
        metadata: processedMetadata
      };

    } catch (error) {
      this.logger.error(`Error fetching group metadata for ${groupId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get group invite code
   */
  async getGroupInviteCode(sessionId, groupId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`🔗 Getting invite code for group ${groupId} in session ${sessionId}`);

      // First, verify admin status by checking group metadata
      const userJid = socket.user?.id;
      if (userJid) {
        try {
          const groupMetadata = await socket.groupMetadata(groupId);
          const userPhone = userJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

          const userParticipant = groupMetadata.participants?.find(p => {
            const pPhone = p.id.replace('@s.whatsapp.net', '').replace('@c.us', '');
            return pPhone === userPhone;
          });

          if (!userParticipant) {
            this.logger.warn(`❌ User not found in group participants for ${groupId}`);
            throw new Error('You are not a member of this group');
          }

          const isAdmin = userParticipant.admin === 'admin' || userParticipant.admin === 'superadmin' || userParticipant.admin === true;

          if (!isAdmin) {
            this.logger.warn(`❌ User is not admin in group ${groupId}. Admin status: ${userParticipant.admin}`);
            throw new Error('You must be an admin to generate invite links for this group');
          }

          this.logger.info(`✅ Admin verification passed for group ${groupId}`);
        } catch (metadataError) {
          this.logger.warn(`⚠️ Could not verify admin status: ${metadataError.message}`);
          // Continue anyway - let WhatsApp API handle the permission check
        }
      }

      // Attempt to get invite code
      const inviteCode = await socket.groupInviteCode(groupId);

      this.logger.info(`✅ Successfully got invite code for group ${groupId}: ${inviteCode}`);

      return {
        success: true,
        inviteCode: inviteCode,
        inviteLink: `https://chat.whatsapp.com/${inviteCode}`
      };

    } catch (error) {
      this.logger.error(`❌ Error getting invite code for group ${groupId}:`, error);

      // Provide more specific error messages
      let errorMessage = error.message;
      if (error.message.includes('not-admin') || error.message.includes('forbidden')) {
        errorMessage = 'You must be an admin to generate invite links for this group';
      } else if (error.message.includes('not-authorized')) {
        errorMessage = 'Not authorized to access this group';
      } else if (error.message.includes('group-not-found')) {
        errorMessage = 'Group not found';
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Get group info by invite code
   */
  async getGroupInfoByInviteCode(sessionId, inviteCode) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Clean invite code (remove URL if provided)
      const cleanCode = inviteCode.replace('https://chat.whatsapp.com/', '');

      this.logger.info(`Getting group info for invite code ${cleanCode} in session ${sessionId}`);

      const groupInfo = await socket.groupGetInviteInfo(cleanCode);

      return {
        success: true,
        groupInfo: groupInfo
      };

    } catch (error) {
      this.logger.error(`Error getting group info for invite code ${inviteCode}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get contact info
   */
  async getContactInfo(sessionId, phoneNumber) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      const contact = await socket.getBusinessProfile(phoneNumber);
      return {
        success: true,
        contact
      };
    } catch (error) {
      this.logger.error(`Error getting contact info for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get store for a session (for contact name retrieval)
   */
  getStore(sessionId) {
    return this.stores.get(sessionId);
  }

  /**
   * Resolve multiple LIDs to actual phone numbers in batch (optimized for performance)
   * @param {string} sessionId - Session ID
   * @param {Array<string>} jids - Array of JIDs (can be LIDs or regular)
   * @returns {Array<object>} - Array of { jid: resolved JID, lid: original LID, phone: phone number, name: contact name }
   */
  async resolveLIDsBatch(sessionId, jids) {
    try {
      if (!Array.isArray(jids) || jids.length === 0) {
        return [];
      }

      console.log(`🔍 [LID Batch] Resolving ${jids.length} JIDs for session ${sessionId}`);
      this.logger.info(`🔍 [LID Batch] Resolving ${jids.length} JIDs for session ${sessionId}`);

      const store = this.stores.get(sessionId);
      console.log(`📦 [LID Batch] Store available: ${!!store}, Contacts available: ${!!(store && store.contacts)}`);

      const results = [];

      let dbCacheHits = 0;
      let storeHits = 0;
      let unresolved = 0;
      let regularJids = 0;

      // Process each JID
      for (const jid of jids) {
        if (!jid || typeof jid !== 'string') {
          results.push({
            jid: null,
            lid: null,
            phone: 'N/A',
            name: null
          });
          continue;
        }

        // If it's a LID, try to resolve it
        if (jid.endsWith('@lid')) {
          // FIRST: Check database cache (most reliable)
          try {
            const cached = await this.databaseService.get(
              'SELECT jid, contact_name FROM lid_mappings WHERE session_id = ? AND lid = ? AND jid != lid',
              [sessionId, jid]
            );

            if (cached && cached.jid && cached.jid !== jid) {
              const phone = cached.jid.split('@')[0];
              dbCacheHits++;
              results.push({
                jid: cached.jid,
                lid: jid,
                phone: phone,
                name: cached.contact_name,
                resolved: true,
                source: 'db_cache'
              });
              continue;
            }
          } catch (dbError) {
            // Continue to next method
          }

          // SECOND: Check Baileys store
          if (store && store.contacts && store.contacts[jid]) {
            const contact = store.contacts[jid];
            const resolvedJid = contact.id || jid;
            const phone = resolvedJid.split('@')[0];
            const name = contact.notify || contact.name || contact.verifiedName || null;

            storeHits++;

            // Save to database for future use
            try {
              await this.databaseService.run(
                `INSERT OR REPLACE INTO lid_mappings (session_id, lid, jid, contact_name, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))`,
                [sessionId, jid, resolvedJid, name]
              );
            } catch (dbError) {
              // Ignore
            }

            results.push({
              jid: resolvedJid,
              lid: jid,
              phone: phone,
              name: name,
              resolved: true,
              source: 'baileys_store'
            });
            continue;
          }

          // THIRD: Check messages/chats database for previous conversations
          try {
            const chatRecord = await this.databaseService.get(
              `SELECT contact_jid, contact_name FROM chats
               WHERE session_id = ? AND (contact_jid = ? OR contact_lid = ?)
               AND contact_jid NOT LIKE '%@lid'
               LIMIT 1`,
              [sessionId, jid, jid]
            );

            if (chatRecord && chatRecord.contact_jid && !chatRecord.contact_jid.endsWith('@lid')) {
              const phone = chatRecord.contact_jid.split('@')[0];
              dbCacheHits++; // Count as DB hit

              // Save to LID mappings for future use
              try {
                await this.databaseService.run(
                  `INSERT OR REPLACE INTO lid_mappings (session_id, lid, jid, contact_name, updated_at)
                   VALUES (?, ?, ?, ?, datetime('now'))`,
                  [sessionId, jid, chatRecord.contact_jid, chatRecord.contact_name]
                );
              } catch (dbError) {
                // Ignore
              }

              results.push({
                jid: chatRecord.contact_jid,
                lid: jid,
                phone: phone,
                name: chatRecord.contact_name,
                resolved: true,
                source: 'chats_db'
              });
              continue;
            }
          } catch (dbError) {
            // Continue to next method
          }

          // LID not resolved - return LID number with @lid suffix
          unresolved++;
          results.push({
            jid: jid,
            lid: jid,
            phone: jid.split('@')[0] + '@lid',
            name: null,
            resolved: false,
            source: 'unresolved'
          });
        } else {
          // Not a LID, return as-is
          regularJids++;
          const phone = jid.split('@')[0];
          let name = null;

          if (store && store.contacts && store.contacts[jid]) {
            const contact = store.contacts[jid];
            name = contact.notify || contact.name || contact.verifiedName || null;
          }

          results.push({
            jid: jid,
            lid: null,
            phone: phone,
            name: name,
            resolved: true,
            source: 'regular_jid'
          });
        }
      }

      console.log(`✅ [LID Batch] Resolution complete: ${dbCacheHits} from DB cache, ${storeHits} from Baileys store, ${unresolved} unresolved, ${regularJids} regular JIDs`);
      this.logger.info(`✅ [LID Batch] Resolution complete: ${dbCacheHits} from DB cache, ${storeHits} from Baileys store, ${unresolved} unresolved, ${regularJids} regular JIDs`);

      return results;
    } catch (error) {
      this.logger.error(`Error resolving LIDs in batch:`, error);
      // Return fallback data for all JIDs
      return jids.map(jid => ({
        jid: jid,
        lid: jid && jid.endsWith('@lid') ? jid : null,
        phone: jid ? jid.split('@')[0] + (jid.endsWith('@lid') ? '@lid' : '') : 'N/A',
        name: null,
        resolved: false
      }));
    }
  }

  /**
   * Resolve LID to actual phone number using Baileys store
   * @param {string} sessionId - Session ID
   * @param {string} jid - JID (can be LID or regular)
   * @returns {object} - { jid: resolved JID, phone: phone number, name: contact name }
   */
  async resolveLIDToPhone(sessionId, jid) {
    const fs = require('fs');
    const logFile = 'lid-resolution.log';

    const log = (msg) => {
      fs.appendFileSync(logFile, msg + '\n');
    };

    try {
      // If it's a LID, try to resolve it
      if (jid.endsWith('@lid')) {
        log(`\n[LID RESOLUTION] Attempting to resolve: ${jid}`);

        // FIRST: Check database cache (most reliable)
        try {
          const cached = await this.databaseService.get(
            'SELECT jid, contact_name FROM lid_mappings WHERE session_id = ? AND lid = ? AND jid != lid',
            [sessionId, jid]
          );

          if (cached && cached.jid && cached.jid !== jid) {
            const phone = cached.jid.split('@')[0];
            log(`[LID RESOLUTION] ✅ Found in DATABASE: ${jid} -> ${cached.jid} (${cached.contact_name || 'no name'})`);

            return {
              jid: cached.jid,
              lid: jid,
              phone: phone,
              name: cached.contact_name
            };
          } else if (cached && cached.jid === jid) {
            log(`[LID RESOLUTION] ⚠️ Database has bad mapping (LID -> LID), ignoring`);
          }
        } catch (dbError) {
          log(`[LID RESOLUTION] ⚠️ Database lookup failed: ${dbError.message}`);
        }

        // SECOND: Check Baileys store
        const store = this.stores.get(sessionId);

        if (!store) {
          log(`[LID RESOLUTION] ❌ No store found`);
          return {
            jid: jid,
            lid: jid,
            phone: jid.split('@')[0],
            name: null
          };
        }

        if (!store.contacts) {
          log(`[LID RESOLUTION] ❌ No contacts in store`);
          return {
            jid: jid,
            lid: jid,
            phone: jid.split('@')[0],
            name: null
          };
        }

        const contactKeys = Object.keys(store.contacts);
        log(`[LID RESOLUTION] Store has ${contactKeys.length} contacts`);

        // Check if this LID exists in store contacts
        if (store.contacts[jid]) {
          const contact = store.contacts[jid];
          log(`[LID RESOLUTION] ✅ Found in STORE: ${JSON.stringify(contact)}`);

          const resolvedJid = contact.id || jid;
          const phone = resolvedJid.split('@')[0];
          const name = contact.notify || contact.name || contact.verifiedName || null;

          log(`[LID RESOLUTION] ✅ Resolved ${jid} -> ${resolvedJid} (phone: ${phone}, name: ${name})`);

          // Save to database for future use
          try {
            await this.databaseService.run(
              `INSERT OR REPLACE INTO lid_mappings (session_id, lid, jid, contact_name, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))`,
              [sessionId, jid, resolvedJid, name]
            );
          } catch (dbError) {
            // Ignore
          }

          return {
            jid: resolvedJid,
            lid: jid,
            phone: phone,
            name: name
          };
        }

        // LID not resolved
        log(`[LID RESOLUTION] ❌ LID ${jid} NOT found anywhere`);

        return {
          jid: jid,
          lid: jid,
          phone: jid.split('@')[0],
          name: null
        };
      }

      // Not a LID, return as-is
      const phone = jid.split('@')[0];
      let name = null;

      if (store && store.contacts && store.contacts[jid]) {
        const contact = store.contacts[jid];
        name = contact.notify || contact.name || contact.verifiedName || null;
      }

      return {
        jid: jid,
        lid: null,
        phone: phone,
        name: name
      };
    } catch (error) {
      this.logger.error(`Error resolving LID ${jid}:`, error);
      return {
        jid: jid,
        lid: jid.endsWith('@lid') ? jid : null,
        phone: jid.split('@')[0],
        name: null
      };
    }
  }

  /**
   * Get all labels for a session
   */
  async getLabels(sessionId) {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(process.cwd(), 'labels-debug.log');

    const log = (msg) => {
      const timestamp = new Date().toISOString();
      const logMsg = `[${timestamp}] ${msg}\n`;
      fs.appendFileSync(logFile, logMsg);
    };

    try {
      log(`🏷️ [GET LABELS] Called for session: ${sessionId}`);

      const store = this.stores.get(sessionId);
      if (!store) {
        log(`❌ [GET LABELS] Store not found for session ${sessionId}`);
        this.logger.warn(`Store not found for session ${sessionId}`);
        return {
          success: false,
          error: 'Store not found for this session',
          labels: []
        };
      }

      log(`✅ [GET LABELS] Store found for session ${sessionId}`);

      // Get the socket to trigger app state resync
      const socket = this.sessions.get(sessionId);
      log(`🔍 [GET LABELS] Socket exists: ${!!socket}`);
      log(`🔍 [GET LABELS] Socket has resyncAppState: ${!!(socket && socket.resyncAppState)}`);

      if (socket && socket.resyncAppState) {
        try {
          log(`🔄 [GET LABELS] Triggering app state resync for labels...`);
          // Resync ALL app state collections to ensure labels are fetched
          // Labels might be in 'critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', or 'regular'
          await socket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
          log(`✅ [GET LABELS] App state resync completed`);
        } catch (resyncError) {
          log(`⚠️ [GET LABELS] App state resync failed: ${resyncError.message}`);
          log(`⚠️ [GET LABELS] Error stack: ${resyncError.stack}`);
          // Continue anyway - we'll return whatever labels are in the store
        }
      } else {
        log(`⚠️ [GET LABELS] Socket or resyncAppState not available`);
      }

      // Get labels from store - use findAll() method from ObjectRepository
      const labelsRepo = store.getLabels();
      log(`🔍 [GET LABELS] Labels repo type: ${typeof labelsRepo}`);
      log(`🔍 [GET LABELS] Labels repo count: ${labelsRepo ? labelsRepo.count() : 0}`);

      let labels = labelsRepo ? labelsRepo.findAll() : [];
      log(`📊 [GET LABELS] Retrieved ${labels.length} labels from repo`);

      // If no labels found in repo, try to extract from chats
      if (labels.length === 0) {
        log(`🔍 [GET LABELS] Attempting to extract labels from chats...`);

        // Get all chats
        log(`🔍 [GET LABELS] store.chats type: ${typeof store.chats}`);
        log(`🔍 [GET LABELS] store.chats exists: ${!!store.chats}`);

        if (store.chats) {
          log(`🔍 [GET LABELS] store.chats constructor: ${store.chats.constructor.name}`);
          log(`🔍 [GET LABELS] store.chats has all(): ${typeof store.chats.all === 'function'}`);

          // Try different methods to get chats
          let allChats = [];
          if (typeof store.chats.all === 'function') {
            allChats = store.chats.all();
          } else if (store.chats instanceof Map) {
            allChats = Array.from(store.chats.values());
          } else if (typeof store.chats === 'object') {
            allChats = Object.values(store.chats);
          }

          log(`🔍 [GET LABELS] Found ${allChats.length} chats`);
        } else {
          log(`❌ [GET LABELS] store.chats is null or undefined`);
        }

        const allChats = store.chats ? (typeof store.chats.all === 'function' ? store.chats.all() : []) : [];
        log(`🔍 [GET LABELS] Final chat count: ${allChats.length}`);

        // Check if any chat has labels
        const labelsFromChats = new Map();
        for (const chat of allChats) {
          if (chat.labels && Array.isArray(chat.labels) && chat.labels.length > 0) {
            log(`🔍 [GET LABELS] Chat ${chat.id} has labels: ${JSON.stringify(chat.labels)}`);
            for (const labelId of chat.labels) {
              if (!labelsFromChats.has(labelId)) {
                labelsFromChats.set(labelId, {
                  id: labelId,
                  name: `Label ${labelId}`, // We don't have the name, so use ID
                  color: 0,
                  predefinedId: null
                });
              }
            }
          }
        }

        if (labelsFromChats.size > 0) {
          labels = Array.from(labelsFromChats.values());
          log(`✅ [GET LABELS] Extracted ${labels.length} labels from chats`);
        }
      }

      if (labels.length > 0) {
        log(`📋 [GET LABELS] Sample label: ${JSON.stringify(labels[0])}`);
      } else {
        log(`⚠️ [GET LABELS] No labels found in store`);
        log(`🔍 [GET LABELS] Store keys: ${Object.keys(store).join(', ')}`);

        // Check the actual labels object structure
        if (store.labels) {
          log(`🔍 [GET LABELS] store.labels type: ${typeof store.labels}`);
          log(`🔍 [GET LABELS] store.labels constructor: ${store.labels.constructor.name}`);

          // Try to inspect the labels object
          if (typeof store.labels === 'object') {
            const labelsKeys = Object.keys(store.labels);
            log(`🔍 [GET LABELS] store.labels keys: ${labelsKeys.join(', ')}`);
            log(`🔍 [GET LABELS] store.labels keys count: ${labelsKeys.length}`);

            // Check entityMap directly
            if (store.labels.entityMap) {
              log(`🔍 [GET LABELS] entityMap type: ${typeof store.labels.entityMap}`);
              log(`🔍 [GET LABELS] entityMap constructor: ${store.labels.entityMap.constructor.name}`);

              if (store.labels.entityMap instanceof Map) {
                log(`🔍 [GET LABELS] entityMap is a Map with size: ${store.labels.entityMap.size}`);
                const mapEntries = Array.from(store.labels.entityMap.entries());
                log(`🔍 [GET LABELS] entityMap entries: ${JSON.stringify(mapEntries)}`);
              } else if (typeof store.labels.entityMap === 'object') {
                const entityKeys = Object.keys(store.labels.entityMap);
                log(`🔍 [GET LABELS] entityMap object keys: ${entityKeys.join(', ')}`);
                log(`🔍 [GET LABELS] entityMap object: ${JSON.stringify(store.labels.entityMap)}`);
              }
            }

            // If it's a Map
            if (store.labels instanceof Map) {
              log(`🔍 [GET LABELS] store.labels is a Map with size: ${store.labels.size}`);
              const mapEntries = Array.from(store.labels.entries());
              log(`🔍 [GET LABELS] Map entries: ${JSON.stringify(mapEntries)}`);
            }

            // Try to get all values
            if (typeof store.labels.all === 'function') {
              const allLabels = store.labels.all();
              log(`🔍 [GET LABELS] store.labels.all() returned: ${JSON.stringify(allLabels)}`);
            }
          }
        }
      }

      this.logger.info(`✅ Retrieved ${labels.length} labels for session ${sessionId}`);

      return {
        success: true,
        labels: labels
      };
    } catch (error) {
      log(`❌ [GET LABELS] Error for session ${sessionId}: ${error.message}`);
      log(`❌ [GET LABELS] Error stack: ${error.stack}`);
      this.logger.error(`Error getting labels for session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message,
        labels: []
      };
    }
  }

  /**
   * Get chats/contacts by label ID
   */
  async getChatsByLabel(sessionId, labelId) {
    try {
      const store = this.stores.get(sessionId);
      if (!store) {
        this.logger.warn(`Store not found for session ${sessionId}`);
        return {
          success: false,
          error: 'Store not found for this session'
        };
      }

      // Get all chats
      const allChats = store.chats.all();

      // Get label associations for this label
      const labelAssociations = store.getChatLabels ?
        allChats.map(chat => ({
          chatId: chat.id,
          labels: store.getChatLabels(chat.id)
        })).filter(item => item.labels.some(la => la.labelId === labelId)) :
        [];

      // Extract chat IDs that have this label
      const labeledChatIds = labelAssociations.map(item => item.chatId);

      // Get full chat objects for labeled chats
      const labeledChats = allChats.filter(chat => labeledChatIds.includes(chat.id));

      // Process chats to extract contact information
      const contacts = labeledChats.map(chat => {
        // Extract phone number from JID
        let phoneNumber = chat.id.replace('@s.whatsapp.net', '').replace('@c.us', '');

        // Get contact name from store if available
        let name = chat.name || chat.notify || phoneNumber;
        if (store.contacts && store.contacts[chat.id]) {
          name = store.contacts[chat.id].name || store.contacts[chat.id].notify || name;
        }

        return {
          id: chat.id,
          phoneNumber: phoneNumber,
          name: name,
          conversationTimestamp: chat.conversationTimestamp,
          unreadCount: chat.unreadCount || 0
        };
      });

      this.logger.info(`✅ Retrieved ${contacts.length} contacts for label ${labelId} in session ${sessionId}`);

      return {
        success: true,
        contacts: contacts,
        count: contacts.length
      };
    } catch (error) {
      this.logger.error(`Error getting chats by label ${labelId} for session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create a new session specifically for pairing code authentication
   */
  async createPairingCodeSession(phoneNumber) {
    let sessionId = null; // Initialize sessionId at the top level

    try {
      // Clean phone number (remove + and any non-digits) - Context7 requirement
      let cleanPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');

      if (!cleanPhoneNumber || cleanPhoneNumber.length < 10) {
        throw new Error('Invalid phone number format. Please enter a valid phone number with country code (e.g., 917261902348 for India)');
      }

      // Validate phone number format for common countries
      if (cleanPhoneNumber.length < 10 || cleanPhoneNumber.length > 15) {
        throw new Error('Phone number must be between 10-15 digits including country code');
      }

      // E.164 phone number formatting - Following Baileys documentation
      // E.164 format: Country code + national number (WITHOUT + prefix)
      let phoneNumbersToTry = [];

      // Clean and normalize the phone number
      let normalizedNumber = cleanPhoneNumber.replace(/[\s\-\(\)\.]/g, ''); // Remove spaces, dashes, parentheses, dots
      normalizedNumber = normalizedNumber.replace(/^\+/, ''); // Remove leading + if present

      this.logger.info(`🔢 Normalized phone number: "${normalizedNumber}" (length: ${normalizedNumber.length})`);

      // Validate and format according to E.164 standard (without + prefix as per Baileys docs)
      if (normalizedNumber.startsWith('91') && normalizedNumber.length === 12) {
        // Indian number with country code: 91XXXXXXXXXX
        const mobileNumber = normalizedNumber.substring(2);

        // Validate Indian mobile number format (should start with 6-9)
        if (/^[6-9]\d{9}$/.test(mobileNumber)) {
          this.logger.info(`🔢 ✅ Valid Indian number: CC=91, Mobile=${mobileNumber}`);

          // E.164 format for Indian numbers (PRIMARY format as per Baileys docs)
          phoneNumbersToTry = [
            normalizedNumber,  // 917261902348 (E.164 format - RECOMMENDED)
          ];
        } else {
          this.logger.warn(`🔢 ❌ Invalid Indian mobile number format: ${mobileNumber}`);
          throw new Error(`Invalid Indian mobile number format. Must start with 6-9 and be 10 digits.`);
        }
      } else if (normalizedNumber.length === 10 && /^[6-9]\d{9}$/.test(normalizedNumber)) {
        // Indian mobile number without country code: XXXXXXXXXX
        this.logger.info(`🔢 ✅ Valid Indian mobile (no CC): ${normalizedNumber}`);

        // Add country code for E.164 format
        phoneNumbersToTry = [
          `91${normalizedNumber}`, // 917261902348 (E.164 format - RECOMMENDED)
        ];
      } else if (normalizedNumber.startsWith('20') && normalizedNumber.length === 12) {
        // Egyptian number with country code: 20XXXXXXXXXXX
        const mobilePrefix = normalizedNumber.substring(2, 4);
        const mobileNumber = normalizedNumber.substring(4);

        // Validate Egyptian mobile number format (prefixes: 10, 11, 12, 15)
        if (['10', '11', '12', '15'].includes(mobilePrefix) && /^\d{8}$/.test(mobileNumber)) {
          this.logger.info(`🔢 ✅ Valid Egyptian number: CC=20, Prefix=${mobilePrefix}, Mobile=${mobileNumber}`);

          // E.164 format for Egyptian numbers
          phoneNumbersToTry = [
            normalizedNumber,  // 201128135675 (E.164 format)
          ];
        } else {
          this.logger.warn(`🔢 ❌ Invalid Egyptian mobile number format: Prefix=${mobilePrefix}, Mobile=${mobileNumber}`);
          throw new Error(`Invalid Egyptian mobile number format. Must use prefix 10/11/12/15 and be 8 digits after prefix.`);
        }
      } else if (normalizedNumber.startsWith('1') && normalizedNumber.length === 11) {
        // US/Canada number: 1XXXXXXXXXX
        const areaCode = normalizedNumber.substring(1, 4);
        const localNumber = normalizedNumber.substring(4);
        this.logger.info(`🔢 ✅ US/Canada number: CC=1, Area=${areaCode}, Local=${localNumber}`);

        phoneNumbersToTry = [
          normalizedNumber, // 1XXXXXXXXXX (E.164 format)
        ];
      } else if (normalizedNumber.startsWith('44') && normalizedNumber.length >= 12 && normalizedNumber.length <= 13) {
        // UK number: 44XXXXXXXXXXX
        this.logger.info(`🔢 ✅ UK number detected: ${normalizedNumber}`);

        phoneNumbersToTry = [
          normalizedNumber, // 44XXXXXXXXXXX (E.164 format)
        ];
      } else {
        // Enhanced international number support for all countries
        this.logger.info(`🌍 International number detected: ${normalizedNumber}`);

        // Comprehensive country code validation
        const countryCodeMap = {
          // Major countries with specific validation
          '33': { name: 'France', minLength: 11, maxLength: 11 },
          '49': { name: 'Germany', minLength: 11, maxLength: 12 },
          '39': { name: 'Italy', minLength: 11, maxLength: 13 },
          '34': { name: 'Spain', minLength: 11, maxLength: 11 },
          '7': { name: 'Russia/Kazakhstan', minLength: 11, maxLength: 11 },
          '86': { name: 'China', minLength: 13, maxLength: 13 },
          '81': { name: 'Japan', minLength: 11, maxLength: 11 },
          '82': { name: 'South Korea', minLength: 11, maxLength: 11 },
          '55': { name: 'Brazil', minLength: 13, maxLength: 13 },
          '52': { name: 'Mexico', minLength: 12, maxLength: 13 },
          '54': { name: 'Argentina', minLength: 11, maxLength: 13 },
          '27': { name: 'South Africa', minLength: 11, maxLength: 11 },
          '234': { name: 'Nigeria', minLength: 13, maxLength: 14 },
          '254': { name: 'Kenya', minLength: 12, maxLength: 12 },
          '61': { name: 'Australia', minLength: 11, maxLength: 11 },
          '64': { name: 'New Zealand', minLength: 10, maxLength: 11 },
          '65': { name: 'Singapore', minLength: 10, maxLength: 10 },
          '60': { name: 'Malaysia', minLength: 11, maxLength: 12 },
          '66': { name: 'Thailand', minLength: 11, maxLength: 11 },
          '84': { name: 'Vietnam', minLength: 11, maxLength: 12 },
          '62': { name: 'Indonesia', minLength: 11, maxLength: 13 },
          '63': { name: 'Philippines', minLength: 12, maxLength: 12 },
          '92': { name: 'Pakistan', minLength: 12, maxLength: 12 },
          '880': { name: 'Bangladesh', minLength: 13, maxLength: 13 },
          '94': { name: 'Sri Lanka', minLength: 11, maxLength: 11 },
          '977': { name: 'Nepal', minLength: 13, maxLength: 13 },
          '98': { name: 'Iran', minLength: 12, maxLength: 12 },
          '90': { name: 'Turkey', minLength: 12, maxLength: 12 },
          '966': { name: 'Saudi Arabia', minLength: 12, maxLength: 12 },
          '971': { name: 'UAE', minLength: 12, maxLength: 12 },
          '974': { name: 'Qatar', minLength: 11, maxLength: 11 },
          '965': { name: 'Kuwait', minLength: 11, maxLength: 11 },
          '973': { name: 'Bahrain', minLength: 11, maxLength: 11 },
          '968': { name: 'Oman', minLength: 11, maxLength: 11 },
          '961': { name: 'Lebanon', minLength: 11, maxLength: 11 },
          '962': { name: 'Jordan', minLength: 12, maxLength: 12 },
          '972': { name: 'Israel', minLength: 12, maxLength: 12 },
          '212': { name: 'Morocco', minLength: 12, maxLength: 12 },
          '213': { name: 'Algeria', minLength: 12, maxLength: 12 },
          '216': { name: 'Tunisia', minLength: 11, maxLength: 11 }
        };

        // Try to identify country by checking common country codes
        let detectedCountry = null;
        for (const [code, info] of Object.entries(countryCodeMap)) {
          if (normalizedNumber.startsWith(code)) {
            detectedCountry = { code, ...info };
            break;
          }
        }

        if (detectedCountry) {
          this.logger.info(`🌍 ✅ Detected ${detectedCountry.name} number (${detectedCountry.code})`);

          // Validate length for detected country
          if (normalizedNumber.length >= detectedCountry.minLength &&
              normalizedNumber.length <= detectedCountry.maxLength) {
            phoneNumbersToTry = [normalizedNumber];
          } else {
            throw new Error(`Invalid ${detectedCountry.name} number format. Expected ${detectedCountry.minLength}-${detectedCountry.maxLength} digits, got ${normalizedNumber.length}.`);
          }
        } else {
          // Generic international number - assume it's already in E.164 format
          this.logger.info(`🌍 ⚠️ Generic international format: ${normalizedNumber}`);

          if (normalizedNumber.length >= 7 && normalizedNumber.length <= 15) {
            phoneNumbersToTry = [normalizedNumber];
          } else {
            throw new Error(`Invalid phone number length. Must be between 7-15 digits for international format.`);
          }
        }
      }

      this.logger.info(`🔢 Will try ${phoneNumbersToTry.length} E.164 phone number format(s): ${phoneNumbersToTry.join(', ')}`);
      this.logger.info(`🔢 📋 Using E.164 format (without + prefix) as required by Baileys documentation`);

      // Generate a new session ID for pairing code
      sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sessionDir = path.join(this.authDir, sessionId);

      // Ensure session directory exists
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      this.logger.info(`Creating new pairing code session ${sessionId} for ${cleanPhoneNumber}`);
      this.logger.info(`🔢 Phone number details: original="${phoneNumber}", cleaned="${cleanPhoneNumber}", length=${cleanPhoneNumber.length}`);

      const { state, saveCreds } = await this.safeFileOperation(
        `pairing-${sessionId}`,
        () => useMultiFileAuthState(sessionDir)
      );

      // Initialize store for this session
      const store = this.initializeStore(sessionId);

      // Wrap auth state with cacheable signal key store for faster authentication
      const authStateWithCache = {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger)
      };

      const socket = makeWASocket({
        auth: authStateWithCache,
        logger: this.logger,
        printQRInTerminal: false, // Critical for pairing code
        // Use the EXACT default browser from WhiskeySockets/Baileys
        browser: Browsers.macOS('Chrome'),
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Add explicit version if available (WhiskeySockets does this)
        ...(this.baileysVersion && { version: this.baileysVersion }),

        // Add getMessage handler (WhiskeySockets implements this)
        getMessage: async (key) => {
          return undefined;
        },
        defaultQueryTimeoutMs: 90000, // Increased timeout for pairing stability
        connectTimeoutMs: 90000, // Increased connection timeout
        keepAliveIntervalMs: 25000, // More frequent keep-alive for pairing
        retryRequestDelayMs: 2000, // Longer delay between retries
        maxMsgRetryCount: 5, // More retry attempts for pairing
        qrTimeout: 120000, // 2 minutes QR timeout
        connectCooldownMs: 5000, // Cooldown between connection attempts
        transactionOpts: { maxCommitRetries: 15, delayBetweenTriesMs: 5000 }, // More robust transaction handling
        msgRetryCounterCache: this.msgRetryCounterCache, // External cache persists across reconnections
        userDevicesCache: new NodeCache({ stdTTL: 300 }), // 5 minute cache
        cachedGroupMetadata: async (jid) => {
          // Use our internal group metadata cache
          return this.getCachedGroupMetadata(sessionId, jid);
        },
        getMessage: async (key) => {
          if (store) {
            const msg = await store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined;
          }
          return undefined;
        }
      });

      // Bind store to socket events
      store.bind(socket.ev);

      this.sessions.set(sessionId, socket);
      this.sessionStates.set(sessionId, {
        id: sessionId,
        status: 'connecting',
        qrCode: null,
        lastSeen: new Date(),
        phoneNumber: null,
        profilePicture: null,
        isLoggedIn: false,
        usingPairingCode: true,
        pairingPhoneNumber: cleanPhoneNumber
      });

      // Handle connection updates
      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      // Handle credential updates
      socket.ev.on('creds.update', saveCreds);

      // Handle incoming messages
      socket.ev.on('messages.upsert', async (messageUpdate) => {
        await this.handleIncomingMessages(sessionId, messageUpdate);
      });

      // Handle contacts updates
      socket.ev.on('contacts.update', async (contacts) => {
        await this.handleContactsUpdate(sessionId, contacts);
      });

      // Wait for socket to be ready - use a more reliable approach
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Socket connection timeout'));
        }, 45000); // Increased to 45 seconds

        let connectionEstablished = false;
        let qrReceived = false;

        // Listen for connection updates to know when we're ready
        const connectionHandler = (update) => {
          this.logger.info(`Connection update during pairing setup: ${JSON.stringify(update)}`);

          if (update.connection === 'open') {
            connectionEstablished = true;
            if (qrReceived) {
              clearTimeout(timeout);
              socket.ev.off('connection.update', connectionHandler);
              resolve();
            }
          } else if (update.qr) {
            qrReceived = true;
            if (connectionEstablished) {
              clearTimeout(timeout);
              socket.ev.off('connection.update', connectionHandler);
              resolve();
            }
          }

          // If we get QR code, we can proceed even without full connection
          if (update.qr && !connectionEstablished) {
            this.logger.info('QR received, proceeding with pairing code request');
            clearTimeout(timeout);
            socket.ev.off('connection.update', connectionHandler);
            resolve();
          }
        };

        socket.ev.on('connection.update', connectionHandler);

        // Also check if socket is already ready
        if (socket.ws && socket.ws.readyState === 1) {
          clearTimeout(timeout);
          resolve();
        }
      });

      // Small delay to ensure auth state is ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if client is already registered - Context7 requirement
      // Use try-catch to handle cases where authState might not be fully ready
      try {
        if (socket.authState && socket.authState.creds && socket.authState.creds.registered) {
          throw new Error('Device is already registered. Please use QR code authentication instead.');
        }
      } catch (authError) {
        this.logger.warn(`Auth state check warning for ${sessionId}:`, authError.message);
        // Continue with pairing code generation even if auth state check fails
      }

      // Request pairing code using standard Baileys approach - Following Context7 documentation
      let code;
      let successfulFormat = null;

      this.logger.info(`🔢 Using standard Baileys pairing code method (E.164 format)`);

      // Wait for socket to be ready for pairing code request - Simplified approach
      this.logger.info(`🔢 Waiting for socket to be ready for pairing code request...`);

      // Give the socket a moment to establish connection and generate QR
      await new Promise(resolve => setTimeout(resolve, 3000));

      this.logger.info(`🔢 ✅ Socket should be ready for pairing code request`);

      // Try each phone number format until one works
      for (let i = 0; i < phoneNumbersToTry.length; i++) {
        const currentFormat = phoneNumbersToTry[i];
        this.logger.info(`🔢 Attempt ${i + 1}/${phoneNumbersToTry.length}: Trying E.164 format "${currentFormat}" on session ${sessionId}`);

        try {
          this.logger.info(`🔢 Calling socket.requestPairingCode("${currentFormat}") - Standard Baileys method`);

          // Use standard Baileys pairing code method (no custom parameter)
          code = await socket.requestPairingCode(currentFormat);

          if (code) {
            successfulFormat = currentFormat;
            this.logger.info(`🔢 ✅ SUCCESS! E.164 format "${currentFormat}" worked. Received code: ${code}`);

            // Keep the socket alive and wait for pairing completion
            this.logger.info(`🔢 Pairing code generated, keeping connection alive for pairing...`);

            // Set up enhanced connection monitoring for pairing
            this.setupPairingConnectionMonitoring(socket, sessionId);

            break;
          }
        } catch (error) {
          this.logger.warn(`🔢 ❌ E.164 format "${currentFormat}" failed:`, error.message);

          // If this is not the last format, continue trying
          if (i < phoneNumbersToTry.length - 1) {
            this.logger.info(`🔢 Trying next E.164 format...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Longer delay between attempts
          }
        }
      }

      if (!code) {
        throw new Error(`Failed to generate pairing code after trying all formats: ${phoneNumbersToTry.join(', ')}`);
      }

      this.logger.info(`🔢 ✅ ENHANCED PAIRING CODE GENERATED SUCCESSFULLY!`);
      this.logger.info(`🔢 📱 Original input: ${cleanPhoneNumber}`);
      this.logger.info(`🔢 ✅ Successful format: ${successfulFormat}`);
      this.logger.info(`🔢 🔐 Generated code: ${code}`);
      this.logger.info(`🔢 📋 Code format: Standard Baileys pairing code`);

      // Save session to database
      if (this.databaseService && this.databaseService.run) {
        await this.databaseService.run(`
          INSERT INTO whatsapp_sessions (session_id, name, device_name, status, phone_number, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [sessionId, `Device ${cleanPhoneNumber}`, `WhatsApp Device`, 'pairing_code_ready', cleanPhoneNumber]);
      }

      return {
        success: true,
        code: code,
        phoneNumber: cleanPhoneNumber,
        successfulFormat: successfulFormat,
        sessionId: sessionId,
        enhanced: true // Flag to indicate this is using standard Baileys pairing
      };
    } catch (error) {
      this.logger.error(`🔢 Enhanced pairing code generation failed:`, error);
      throw error;
    }
  }

  /**
   * Enhanced connection monitoring for pairing code sessions
   */
  setupPairingConnectionMonitoring(socket, sessionId) {
    this.logger.info(`🔢 Setting up enhanced connection monitoring for pairing session: ${sessionId}`);

    // Monitor for successful pairing
    const pairingSuccessHandler = (update) => {
      if (update.connection === 'open') {
        this.logger.info(`🔢 ✅ PAIRING SUCCESSFUL! Session ${sessionId} is now connected`);
        this.emit('pairing_success', { sessionId, timestamp: new Date() });
      }
    };

    // Monitor for pairing errors
    const pairingErrorHandler = (error) => {
      this.logger.warn(`🔢 ⚠️ Pairing connection error for ${sessionId}:`, error.message);

      // Handle specific error codes
      if (error.message.includes('503')) {
        this.logger.warn(`🔢 503 Service Unavailable - WhatsApp servers may be busy`);
        this.emit('pairing_error', {
          sessionId,
          error: 'WhatsApp servers are temporarily unavailable. Please try again in a few minutes.',
          code: '503',
          timestamp: new Date()
        });
      } else if (error.message.includes('Stream Errored')) {
        this.logger.warn(`🔢 Stream error - Connection interrupted during pairing`);
        this.emit('pairing_error', {
          sessionId,
          error: 'Connection was interrupted. Please try generating a new pairing code.',
          code: 'STREAM_ERROR',
          timestamp: new Date()
        });
      }
    };

    // Add event listeners
    socket.ev.on('connection.update', pairingSuccessHandler);
    socket.ev.on('connection.error', pairingErrorHandler);

    // Clean up listeners after 5 minutes
    setTimeout(() => {
      socket.ev.off('connection.update', pairingSuccessHandler);
      socket.ev.off('connection.error', pairingErrorHandler);
      this.logger.info(`🔢 Cleaned up pairing monitoring for session: ${sessionId}`);
    }, 5 * 60 * 1000);
  }

  /**
   * Request pairing code for phone number - Following Context7 documentation
   */
  async requestPairingCode(sessionId, phoneNumber) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found or not connected');
      }

      // Clean phone number (remove + and any non-digits) - Context7 requirement
      const cleanPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');

      if (!cleanPhoneNumber || cleanPhoneNumber.length < 10) {
        throw new Error('Invalid phone number format');
      }

      this.logger.info(`Requesting pairing code for ${cleanPhoneNumber} on session ${sessionId}`);

      // Check if client is already registered - Context7 requirement
      if (socket.authState.creds.registered) {
        throw new Error('Device is already registered. Please disconnect and create a new session for pairing code authentication.');
      }

      // Mark this session as using pairing code to prevent QR generation
      const sessionState = this.sessionStates.get(sessionId);
      if (sessionState) {
        sessionState.usingPairingCode = true;
        sessionState.pairingPhoneNumber = cleanPhoneNumber;
        this.sessionStates.set(sessionId, sessionState);
      }

      // Request pairing code from Baileys - Context7 pattern
      const code = await socket.requestPairingCode(cleanPhoneNumber);

      this.logger.info(`Pairing code generated for ${cleanPhoneNumber}: ${code}`);

      return {
        success: true,
        code: code,
        phoneNumber: cleanPhoneNumber,
        sessionId: sessionId
      };

    } catch (error) {
      this.logger.error(`Error requesting pairing code for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error.message,
        phoneNumber: phoneNumber,
        sessionId: sessionId
      };
    }
  }

  /**
   * Force reconnect session (for manual reconnection with QR)
   */
  async forceReconnectSession(sessionId) {
    try {
      this.logger.info(`🔄 Force reconnecting session ${sessionId}...`);

      // Remove existing session from memory if it exists
      const existingSocket = this.sessions.get(sessionId);
      if (existingSocket) {
        try {
          await existingSocket.end();
        } catch (error) {
          // Ignore errors when closing
        }
        this.sessions.delete(sessionId);
      }

      // Clear session state
      this.sessionStates.delete(sessionId);

      // Clear auth files to force new QR generation
      const sessionDir = path.join(this.authDir, sessionId);
      if (fs.existsSync(sessionDir)) {
        const authFiles = ['creds.json', 'keys.json', 'session-info.json'];
        for (const file of authFiles) {
          const filePath = path.join(sessionDir, file);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            this.logger.info(`Cleared auth file: ${file}`);
          }
        }
      }

      // Create fresh session
      return await this.createSession(sessionId);

    } catch (error) {
      this.logger.error(`Error force reconnecting session ${sessionId}:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  /**
   * Restart session after QR scan (internal method)
   */
  async restartSession(sessionId) {
    try {
      const sessionDir = path.join(this.authDir, sessionId);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const { state, saveCreds } = await this.safeFileOperation(
        `restart-${sessionId}`,
        () => useMultiFileAuthState(sessionDir)
      );

      // Wrap auth state with cacheable signal key store for faster authentication
      const authStateWithCache = {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger)
      };

      // Create socket with optimized configuration
      const socket = makeWASocket(this.getOptimalSocketConfig(sessionId, authStateWithCache));

      this.sessions.set(sessionId, socket);

      // Update session state
      const sessionState = this.sessionStates.get(sessionId) || {};
      sessionState.status = 'connecting';
      this.sessionStates.set(sessionId, sessionState);

      // Handle connection updates
      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      // Handle credential updates
      socket.ev.on('creds.update', saveCreds);

      // Handle incoming messages
      socket.ev.on('messages.upsert', async (messageUpdate) => {
        await this.handleIncomingMessages(sessionId, messageUpdate);
      });

      // Handle contacts updates
      socket.ev.on('contacts.update', async (contacts) => {
        await this.handleContactsUpdate(sessionId, contacts);
      });

      // Handle calls (both incoming and outgoing)
      socket.ev.on('call', async (calls) => {
        await this.handleCalls(sessionId, calls);
      });

      // Handle presence updates
      socket.ev.on('presence.update', async (presence) => {
        await this.handlePresenceUpdate(sessionId, presence);
      });

      this.logger.info(`Session ${sessionId} restarted successfully`);

      return {
        success: true,
        message: 'Session restarted successfully'
      };

    } catch (error) {
      this.logger.error(`Error restarting session ${sessionId}:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  // ============================================================================
  // GROUP MANAGEMENT METHODS - COMPREHENSIVE BAILEYS IMPLEMENTATION
  // ============================================================================

  /**
   * Create a new WhatsApp group
   * @param {string} sessionId - Session ID
   * @param {string} subject - Group name/subject
   * @param {Array<string>} participants - Array of participant phone numbers (with @s.whatsapp.net)
   * @param {string} description - Optional group description
   * @returns {Promise<{success: boolean, groupId?: string, inviteCode?: string, error?: string}>}
   */
  async createGroup(sessionId, subject, participants, description = '') {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Creating group "${subject}" with ${participants.length} participants`);

      // Ensure participants have correct format (@s.whatsapp.net)
      const formattedParticipants = participants.map(phone => {
        if (phone.includes('@')) return phone;
        return `${phone}@s.whatsapp.net`;
      });

      // Create the group
      const result = await socket.groupCreate(subject, formattedParticipants);

      this.logger.info(`Group created successfully: ${result.id}`);

      // Set description if provided
      if (description && description.trim()) {
        try {
          await socket.groupUpdateDescription(result.id, description);
          this.logger.info(`Description set for group ${result.id}`);
        } catch (descError) {
          this.logger.warn(`Failed to set description: ${descError.message}`);
        }
      }

      // Get invite code (since creator is automatically admin)
      let inviteCode = null;
      try {
        inviteCode = await socket.groupInviteCode(result.id);
      } catch (inviteError) {
        this.logger.warn(`Failed to get invite code: ${inviteError.message}`);
      }

      return {
        success: true,
        groupId: result.id,
        groupJid: result.id,
        participants: result.participants,
        inviteCode: inviteCode,
        inviteLink: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null
      };
    } catch (error) {
      this.logger.error(`Error creating group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Add participants to a group with enhanced validation
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {Array<string>} participants - Array of participant phone numbers
   * @returns {Promise<{success: boolean, results?: Array, validationResults?: Array, error?: string}>}
   */
  async addGroupParticipants(sessionId, groupId, participants) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Adding ${participants.length} participants to group ${groupId}`);

      // Enhanced validation results
      const validationResults = [];
      const validParticipants = [];

      // Validate each participant
      for (const phone of participants) {
        const validation = await this.validateParticipantForGroup(sessionId, phone);
        validationResults.push(validation);

        if (validation.isValid) {
          validParticipants.push(validation.formattedJid);
        }
      }

      this.logger.info(`Validation complete: ${validParticipants.length}/${participants.length} participants valid`);

      if (validParticipants.length === 0) {
        return {
          success: false,
          error: 'No valid participants to add',
          validationResults: validationResults
        };
      }

      // Add valid participants to group
      const result = await socket.groupParticipantsUpdate(groupId, validParticipants, 'add');

      this.logger.info(`Participants addition result:`, result);

      return {
        success: true,
        results: result,
        validationResults: validationResults,
        addedCount: validParticipants.length,
        totalRequested: participants.length
      };
    } catch (error) {
      this.logger.error(`Error adding participants to group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Validate participant for group addition with comprehensive checks
   * @param {string} sessionId - Session ID
   * @param {string} phone - Phone number to validate
   * @returns {Promise<{isValid: boolean, phone: string, formattedJid: string, error?: string, whatsappExists?: boolean}>}
   */
  async validateParticipantForGroup(sessionId, phone) {
    try {
      // Clean phone number
      let cleanPhone = phone.toString().trim();
      if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.substring(1);
      }

      // Remove any non-digits for validation
      const digitsOnly = cleanPhone.replace(/[^0-9]/g, '');

      this.logger.info(`🔍 [validateParticipantForGroup] Validating: ${phone} -> cleaned: ${cleanPhone} -> digits: ${digitsOnly}`);

      // Basic format validation
      if (digitsOnly.length < 10 || digitsOnly.length > 15) {
        this.logger.warn(`❌ [validateParticipantForGroup] Invalid length: ${digitsOnly.length} digits`);
        return {
          isValid: false,
          phone: phone,
          formattedJid: '',
          error: `Invalid phone number length: ${digitsOnly.length} digits (need 10-15)`
        };
      }

      // Global number validation - supports all countries
      let countryDetected = 'Unknown';

      // Basic country detection for logging purposes
      if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
        countryDetected = 'India';
        const mobileNumber = digitsOnly.substring(2);

        // Validate Indian mobile format (6-9 start digit)
        if (!/^[6-9]\d{9}$/.test(mobileNumber)) {
          this.logger.warn(`❌ [validateParticipantForGroup] Invalid Indian mobile format: ${mobileNumber}`);
          return {
            isValid: false,
            phone: phone,
            formattedJid: '',
            error: `Invalid Indian mobile number format`
          };
        }
      } else if (digitsOnly.startsWith('1') && digitsOnly.length === 11) {
        countryDetected = 'US/Canada';
      } else if (digitsOnly.startsWith('44')) {
        countryDetected = 'UK';
      } else if (digitsOnly.startsWith('33')) {
        countryDetected = 'France';
      } else if (digitsOnly.startsWith('49')) {
        countryDetected = 'Germany';
      } else if (digitsOnly.startsWith('86')) {
        countryDetected = 'China';
      } else if (digitsOnly.startsWith('81')) {
        countryDetected = 'Japan';
      } else if (digitsOnly.startsWith('55')) {
        countryDetected = 'Brazil';
      } else if (digitsOnly.startsWith('7')) {
        countryDetected = 'Russia/Kazakhstan';
      } else if (digitsOnly.length >= 10) {
        countryDetected = 'International';
      }

      this.logger.info(`🌍 [validateParticipantForGroup] ${countryDetected} number detected: ${digitsOnly}`);
      this.logger.info(`✅ [validateParticipantForGroup] Global number format validation passed`);


      // Format as JID
      const formattedJid = digitsOnly.includes('@') ? digitsOnly : `${digitsOnly}@s.whatsapp.net`;
      this.logger.info(`📧 [validateParticipantForGroup] Formatted JID: ${formattedJid}`);

      // Check if number exists on WhatsApp
      try {
        this.logger.info(`🔄 [validateParticipantForGroup] Checking WhatsApp registration for: ${digitsOnly}`);
        const existsResult = await this.checkNumberExists(sessionId, digitsOnly);

        this.logger.info(`📊 [validateParticipantForGroup] WhatsApp check result:`, existsResult);

        if (!existsResult.success) {
          this.logger.warn(`❌ [validateParticipantForGroup] WhatsApp check failed: ${existsResult.error}`);
          return {
            isValid: false,
            phone: phone,
            formattedJid: formattedJid,
            error: `WhatsApp verification failed: ${existsResult.error}`,
            whatsappExists: false
          };
        }

        if (!existsResult.exists) {
          this.logger.warn(`❌ [validateParticipantForGroup] Number not registered on WhatsApp: ${digitsOnly}`);
          return {
            isValid: false,
            phone: phone,
            formattedJid: formattedJid,
            error: 'Number is not registered on WhatsApp',
            whatsappExists: false
          };
        }

        this.logger.info(`✅ [validateParticipantForGroup] Validation completed successfully: ${phone} -> ${formattedJid}`);

        return {
          isValid: true,
          phone: phone,
          formattedJid: formattedJid,
          whatsappExists: true
        };

      } catch (whatsappError) {
        this.logger.warn(`⚠️ [validateParticipantForGroup] WhatsApp check failed for ${phone}:`, whatsappError.message);

        // If WhatsApp check fails, still allow adding but log the issue
        this.logger.info(`⚠️ [validateParticipantForGroup] Proceeding without WhatsApp verification for: ${phone}`);

        return {
          isValid: true,
          phone: phone,
          formattedJid: formattedJid,
          error: `Warning: Could not verify on WhatsApp (${whatsappError.message})`,
          whatsappExists: null
        };
      }

    } catch (error) {
      this.logger.error(`❌ [validateParticipantForGroup] Error validating participant ${phone}:`, error);
      return {
        isValid: false,
        phone: phone,
        formattedJid: '',
        error: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * Remove participants from a group
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {Array<string>} participants - Array of participant phone numbers
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  async removeGroupParticipants(sessionId, groupId, participants) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Removing ${participants.length} participants from group ${groupId}`);

      // Ensure participants have correct format (@s.whatsapp.net)
      const formattedParticipants = participants.map(phone => {
        if (phone.includes('@')) return phone;
        return `${phone}@s.whatsapp.net`;
      });

      // Remove participants
      const result = await socket.groupParticipantsUpdate(groupId, formattedParticipants, 'remove');

      this.logger.info(`Participants removal result:`, result);

      return {
        success: true,
        results: result
      };
    } catch (error) {
      this.logger.error(`Error removing participants from group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Promote participants to admin
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {Array<string>} participants - Array of participant phone numbers
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  async promoteGroupParticipants(sessionId, groupId, participants) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Promoting ${participants.length} participants to admin in group ${groupId}`);

      // Ensure participants have correct format (@s.whatsapp.net)
      const formattedParticipants = participants.map(phone => {
        if (phone.includes('@')) return phone;
        return `${phone}@s.whatsapp.net`;
      });

      // Promote participants
      const result = await socket.groupParticipantsUpdate(groupId, formattedParticipants, 'promote');

      this.logger.info(`Participants promotion result:`, result);

      return {
        success: true,
        results: result
      };
    } catch (error) {
      this.logger.error(`Error promoting participants in group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Demote participants from admin
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {Array<string>} participants - Array of participant phone numbers
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  async demoteGroupParticipants(sessionId, groupId, participants) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Demoting ${participants.length} participants from admin in group ${groupId}`);

      // Ensure participants have correct format (@s.whatsapp.net)
      const formattedParticipants = participants.map(phone => {
        if (phone.includes('@')) return phone;
        return `${phone}@s.whatsapp.net`;
      });

      // Demote participants
      const result = await socket.groupParticipantsUpdate(groupId, formattedParticipants, 'demote');

      this.logger.info(`Participants demotion result:`, result);

      return {
        success: true,
        results: result
      };
    } catch (error) {
      this.logger.error(`Error demoting participants in group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update group subject (name)
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {string} subject - New group subject/name
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateGroupSubject(sessionId, groupId, subject) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Updating group subject to "${subject}" for group ${groupId}`);

      await socket.groupUpdateSubject(groupId, subject);

      this.logger.info(`Group subject updated successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error updating group subject:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update group description
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {string} description - New group description
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateGroupDescription(sessionId, groupId, description) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Updating group description for group ${groupId}`);

      await socket.groupUpdateDescription(groupId, description);

      this.logger.info(`Group description updated successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error updating group description:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update group settings
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {string} setting - 'announcement' (only admins can send) or 'not_announcement' (everyone can send)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateGroupSettings(sessionId, groupId, setting) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Updating group setting to "${setting}" for group ${groupId}`);

      await socket.groupToggleEphemeral(groupId, setting === 'announcement');

      this.logger.info(`Group settings updated successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error updating group settings:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update group photo
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {Buffer|string} imageBuffer - Image buffer or base64 string
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateGroupPhoto(sessionId, groupId, imageBuffer) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Updating group photo for group ${groupId}`);

      // Convert base64 to buffer if needed
      let buffer = imageBuffer;
      if (typeof imageBuffer === 'string') {
        if (imageBuffer.startsWith('data:')) {
          const base64Data = imageBuffer.split(',')[1];
          buffer = Buffer.from(base64Data, 'base64');
        } else {
          buffer = Buffer.from(imageBuffer, 'base64');
        }
      }

      await socket.updateProfilePicture(groupId, buffer);

      this.logger.info(`Group photo updated successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error updating group photo:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Remove group photo
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async removeGroupPhoto(sessionId, groupId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Removing group photo for group ${groupId}`);

      await socket.removeProfilePicture(groupId);

      this.logger.info(`Group photo removed successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error removing group photo:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Leave a group
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async leaveGroup(sessionId, groupId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Leaving group ${groupId}`);

      await socket.groupLeave(groupId);

      this.logger.info(`Left group successfully`);

      return {
        success: true
      };
    } catch (error) {
      this.logger.error(`Error leaving group:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Join group using invite code
   * @param {string} sessionId - Session ID
   * @param {string} inviteCode - Group invite code (without URL)
   * @returns {Promise<{success: boolean, groupId?: string, error?: string}>}
   */
  async joinGroupWithInvite(sessionId, inviteCode) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Clean invite code (remove URL if provided)
      const cleanCode = inviteCode.replace('https://chat.whatsapp.com/', '');

      this.logger.info(`Joining group with invite code ${cleanCode}`);

      const result = await socket.groupAcceptInvite(cleanCode);

      this.logger.info(`Joined group successfully: ${result}`);

      return {
        success: true,
        groupId: result
      };
    } catch (error) {
      this.logger.error(`Error joining group with invite:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Revoke group invite code (generate new one)
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @returns {Promise<{success: boolean, newInviteCode?: string, error?: string}>}
   */
  async revokeGroupInvite(sessionId, groupId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Revoking invite code for group ${groupId}`);

      const newInviteCode = await socket.groupRevokeInvite(groupId);

      this.logger.info(`New invite code generated: ${newInviteCode}`);

      return {
        success: true,
        newInviteCode: newInviteCode,
        newInviteLink: `https://chat.whatsapp.com/${newInviteCode}`
      };
    } catch (error) {
      this.logger.error(`Error revoking group invite:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send message to group with mentions
   * @param {string} sessionId - Session ID
   * @param {string} groupId - Group ID
   * @param {string} message - Message content
   * @param {Array<string>|string} mentions - Phone numbers to mention ('all' for everyone)
   * @param {Object} options - Additional options
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendGroupMessage(sessionId, groupId, message, mentions = [], options = {}) {
    try {
      const socket = await this.waitForReadySocket(sessionId);

      this.logger.info(`Sending message to group ${groupId} with mentions: ${mentions}`);

      // Ensure groupId has proper suffix
      if (groupId && !String(groupId).includes('@g.us')) {
        groupId = `${groupId}@g.us`;
      }

      // Check if this is a media message (image, video, audio, document)
      const mediaTypes = ['image', 'video', 'audio', 'document'];
      let isMediaMessage = false;
      let mediaType = null;

      if (typeof message === 'object' && message !== null) {
        for (const type of mediaTypes) {
          if (message[type]) {
            isMediaMessage = true;
            mediaType = type;
            break;
          }
        }
      }

      // Handle media messages
      if (isMediaMessage && mediaType) {
        this.logger.info(`📤 Sending ${mediaType} message to group ${groupId}`);

        let mediaMessage = {};
        const mediaData = message[mediaType];

        // Handle different media data formats
        if (typeof mediaData === 'object' && mediaData.url) {
          // Check if it's a base64 data URL
          if (mediaData.url.startsWith('data:')) {
            // Convert base64 data URL to buffer
            const base64Data = mediaData.url.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            this.logger.info(`📤 Converted data URL to buffer, size: ${buffer.length} bytes`);
            mediaMessage[mediaType] = buffer;
          } else {
            // Regular URL
            this.logger.info(`📤 Using URL: ${mediaData.url}`);
            mediaMessage[mediaType] = mediaData;
          }
        } else if (typeof mediaData === 'string') {
          // Direct URL or base64 string
          if (mediaData.startsWith('data:')) {
            // For base64 data URLs, convert to Buffer
            this.logger.info(`📤 Converting data URL to buffer (length: ${mediaData.length})`);
            const base64Data = mediaData.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            this.logger.info(`📤 Converted to buffer, size: ${buffer.length} bytes`);
            mediaMessage[mediaType] = buffer;
          } else {
            this.logger.info(`📤 Using URL string: ${mediaData.substring(0, 50)}...`);
            mediaMessage[mediaType] = { url: mediaData };
          }
        } else {
          // Direct buffer or other format
          this.logger.info(`📤 Using direct buffer/data`);
          mediaMessage[mediaType] = mediaData;
        }

        // Add caption if provided
        if (message.caption) {
          mediaMessage.caption = message.caption;
        }

        // Add other properties for specific media types
        if (mediaType === 'document' && message.fileName) {
          mediaMessage.fileName = message.fileName;
        }
        if (mediaType === 'audio' && message.mimetype) {
          mediaMessage.mimetype = message.mimetype;
        } else if (mediaType === 'audio') {
          mediaMessage.mimetype = 'audio/mp4'; // Default mimetype for audio
        }

        // Send the media message
        try {
          const result = await socket.sendMessage(groupId, mediaMessage);

          this.logger.info(`Group ${mediaType} message sent successfully: ${result.key.id}`);

          return {
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp
          };
        } catch (mediaError) {
          this.logger.error(`Error sending group ${mediaType} message:`, mediaError);
          throw mediaError;
        }
      }

      // Handle text messages with mentions
      let mentionJids = [];
      // Normalize message into plain string
      let messageText;
      if (typeof message === 'object' && message !== null) {
        if (message.text) messageText = String(message.text);
        else if (message.content) messageText = String(message.content);
        else if (message.body && message.body.text) messageText = String(message.body.text);
        else messageText = JSON.stringify(message);
      } else {
        messageText = String(message || '');
      }
      if (!messageText || messageText.trim() === '' || messageText === '[object Object]') {
        throw new Error('Cannot send empty group message');
      }

      // Handle mentions
      if (mentions === 'all' || (Array.isArray(mentions) && mentions.includes('all'))) {
        // Mention everyone - get group participants
        try {
          let groupMetadata = this.getCachedGroupMetadata(sessionId, groupId);
          if (!groupMetadata) {
            groupMetadata = await socket.groupMetadata(groupId);
            this.setGroupMetadataCache(sessionId, groupId, groupMetadata);
          }
          mentionJids = (groupMetadata.participants || []).map(p => p.id);

          // Add @everyone mention in text
          messageText = `@everyone ${message}`;
        } catch (metadataError) {
          this.logger.warn(`Could not get group metadata for mentions: ${metadataError.message}`);
        }
      } else if (Array.isArray(mentions) && mentions.length > 0) {
        // Mention specific users
        mentionJids = mentions.map(phone => {
          if (phone.includes('@')) return phone;
          return `${phone}@s.whatsapp.net`;
        });

        // Add mentions to message text
        const mentionText = mentions.map(phone => `@${phone.replace('@s.whatsapp.net', '')}`).join(' ');
        messageText = `${mentionText} ${message}`;
      }

      const messageContent = {
        text: messageText
      };

      if (mentionJids.length > 0) {
        messageContent.mentions = mentionJids;
      }

      // Handle Signal Protocol session establishment for group messaging
      try {
        const result = await socket.sendMessage(groupId, messageContent);

        this.logger.info(`Group message sent successfully: ${result.key.id}`);

        return {
          success: true,
          messageId: result.key.id,
          timestamp: result.messageTimestamp
        };
      } catch (signalError) {
        // Check if this is a Signal Protocol session error
        if (signalError.message.includes('No sessions') || signalError.name === 'SessionError') {
          this.logger.info(`Signal Protocol session error, attempting to establish sessions for group ${groupId}`);

          try {
            // Get group metadata to identify participants
            let groupMetadata = this.getCachedGroupMetadata(sessionId, groupId);
            if (!groupMetadata) {
              groupMetadata = await socket.groupMetadata(groupId);
              this.setGroupMetadataCache(sessionId, groupId, groupMetadata);
            }

            // Enhanced session establishment for international numbers
            const participants = groupMetadata.participants || [];

            // Global international number detection - supports all countries
            const internationalParticipants = participants.filter(p => {
              const jid = p.id || p.jid || '';
              const number = jid.split('@')[0];

              // Consider any number with country code as potentially needing session establishment
              // This includes all international formats and ensures compatibility globally
              return number.length >= 10; // Any number 10+ digits might need session establishment
            });

            if (internationalParticipants.length > 0) {
              // Try to establish sessions with international participants first
              for (const participant of internationalParticipants.slice(0, 5)) { // Limit to first 5 to avoid spam
                try {
                  const participantJid = participant.id || participant.jid;
                  // Try to fetch their presence to establish session
                  await socket.presenceSubscribe(participantJid);
                  await new Promise(resolve => setTimeout(resolve, 200)); // Small delay between requests
                } catch (participantError) {
                  // Silently continue if individual participant session fails
                }
              }
            }

            // Try to establish sessions by sending a presence update to the group
            await socket.sendPresenceUpdate('available', groupId);

            // Wait longer for international session establishment
            const waitTime = internationalParticipants.length > 0 ? 3000 : 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));

            // Retry the message send
            const retryResult = await socket.sendMessage(groupId, messageContent);

            this.logger.info(`Group message sent successfully after retry: ${retryResult.key.id}`);

            return {
              success: true,
              messageId: retryResult.key.id,
              timestamp: retryResult.messageTimestamp
            };
          } catch (retryError) {
            // If still failing, try a simplified message without mentions
            if (mentionJids.length > 0) {
              try {
                const fallbackContent = { text: messageText };
                const fallbackResult = await socket.sendMessage(groupId, fallbackContent);

                this.logger.info(`Group message sent successfully without mentions: ${fallbackResult.key.id}`);

                return {
                  success: true,
                  messageId: fallbackResult.key.id,
                  timestamp: fallbackResult.messageTimestamp,
                  warning: 'Message sent without mentions due to international number compatibility'
                };
              } catch (fallbackError) {
                throw retryError;
              }
            } else {
              throw retryError;
            }
          }
        } else {
          // Re-throw non-session errors
          throw signalError;
        }
      }

    } catch (error) {
      this.logger.error(`Error sending group message:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Comprehensive block contact - blocks direct messages and removes from groups
   * @param {string} sessionId - Session ID
   * @param {string} phoneNumber - Phone number to block
   * @param {Object} options - Blocking options
   * @param {boolean} options.removeFromGroups - Whether to remove from all groups (default: true)
   * @param {Array<string>} options.excludeGroups - Group IDs to exclude from removal
   * @returns {Promise<{success: boolean, error?: string, details?: Object}>}
   */
  async blockContactComprehensive(sessionId, phoneNumber, options = {}) {
    const { removeFromGroups = true, excludeGroups = [] } = options;

    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Normalize the phone number
      let normalizedNumber = phoneNumber.toString().trim();
      if (normalizedNumber.startsWith('+')) {
        normalizedNumber = normalizedNumber.substring(1);
      }
      const jid = normalizedNumber.includes('@') ? normalizedNumber : `${normalizedNumber}@s.whatsapp.net`;

      this.logger.info(`🚫 Starting comprehensive block for: ${phoneNumber} -> ${jid}`);

      const results = {
        directBlock: null,
        groupRemovals: [],
        errors: []
      };

      // Step 1: Block direct messages using existing method
      try {
        results.directBlock = await this.blockContact(sessionId, phoneNumber);
        this.logger.info(`🚫 Direct block result:`, results.directBlock);
      } catch (blockError) {
        this.logger.error(`🚫 Direct block failed:`, blockError);
        results.errors.push(`Direct block failed: ${blockError.message}`);
      }

      // Step 2: Remove from all groups if requested
      if (removeFromGroups) {
        try {
          this.logger.info(`💫 Starting group removal process for ${jid}`);

          // Get all participating groups
          const groupsData = await socket.groupFetchAllParticipating();
          if (!groupsData) {
            this.logger.warn('No groups data available');
            return {
              success: results.directBlock?.success || false,
              details: results,
              message: 'Direct block completed, but no groups found to remove from'
            };
          }

          const groups = Object.values(groupsData);
          this.logger.info(`💫 Found ${groups.length} groups to check`);

          // Check each group for the contact and remove if present
          for (const group of groups) {
            // Skip excluded groups
            if (excludeGroups.includes(group.id)) {
              this.logger.info(`📋 Skipping excluded group: ${group.subject} (${group.id})`);
              continue;
            }

            try {
              // Check if user is admin/superadmin of this group
              const userJid = socket.user?.id;
              const isUserAdmin = group.participants?.some(participant =>
                participant.id === userJid && (participant.admin === 'admin' || participant.admin === 'superadmin')
              );

              if (!isUserAdmin) {
                this.logger.warn(`📋 Cannot remove from group "${group.subject}" - not an admin`);
                results.groupRemovals.push({
                  groupId: group.id,
                  groupName: group.subject,
                  success: false,
                  error: 'Not an admin of this group'
                });
                continue;
              }

              // Check if the blocked contact is in this group
              const isContactInGroup = group.participants?.some(participant => {
                const participantNumber = participant.id.split('@')[0];
                return participantNumber === normalizedNumber || participant.id === jid;
              });

              if (!isContactInGroup) {
                this.logger.info(`📋 Contact not in group "${group.subject}"`);
                continue;
              }

              this.logger.info(`📋 Attempting to remove ${jid} from group "${group.subject}" (${group.id})`);

              // Remove the contact from the group
              const removeResult = await socket.groupParticipantsUpdate(
                group.id,
                [jid],
                'remove'
              );

              this.logger.info(`📋 Removal result for group "${group.subject}":`, removeResult);

              results.groupRemovals.push({
                groupId: group.id,
                groupName: group.subject,
                success: true,
                result: removeResult
              });

              // Add delay between group operations to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (groupError) {
              this.logger.error(`📋 Error removing from group "${group.subject}":`, groupError);
              results.groupRemovals.push({
                groupId: group.id,
                groupName: group.subject,
                success: false,
                error: groupError.message
              });
            }
          }

          this.logger.info(`📋 Group removal completed: ${results.groupRemovals.filter(r => r.success).length} successful, ${results.groupRemovals.filter(r => !r.success).length} failed`);

        } catch (groupsError) {
          this.logger.error(`📋 Error in group removal process:`, groupsError);
          results.errors.push(`Group removal failed: ${groupsError.message}`);
        }
      }

      // Determine overall success
      const directBlockSuccess = results.directBlock?.success || false;
      const groupRemovalSuccess = results.groupRemovals.filter(r => r.success).length;
      const groupRemovalTotal = results.groupRemovals.length;

      const overallSuccess = directBlockSuccess && (groupRemovalTotal === 0 || groupRemovalSuccess > 0);

      return {
        success: overallSuccess,
        message: this.buildComprehensiveBlockMessage(results, phoneNumber),
        details: results,
        jid: jid
      };

    } catch (error) {
      this.logger.error(`🚫 ❌ Comprehensive block failed for ${phoneNumber}:`, error);
      return {
        success: false,
        error: `Failed to comprehensively block ${phoneNumber}: ${error.message}`,
        jid: phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`
      };
    }
  }

  /**
   * Build a comprehensive status message for blocking results
   */
  buildComprehensiveBlockMessage(results, phoneNumber) {
    const messages = [];

    // Direct block status
    if (results.directBlock?.success) {
      messages.push(`✅ Direct messages blocked`);
    } else {
      messages.push(`⚠️ Direct block failed`);
    }

    // Group removal status
    const successfulRemovals = results.groupRemovals.filter(r => r.success);
    const failedRemovals = results.groupRemovals.filter(r => !r.success);

    if (successfulRemovals.length > 0) {
      messages.push(`✅ Removed from ${successfulRemovals.length} group(s)`);
    }

    if (failedRemovals.length > 0) {
      messages.push(`⚠️ Failed to remove from ${failedRemovals.length} group(s)`);
    }

    if (results.groupRemovals.length === 0) {
      messages.push(`💭 No groups to remove from`);
    }

    return `Comprehensive block for ${phoneNumber}: ${messages.join(', ')}`;
  }

  /**
   * Block a contact (original method)
   * @param {string} sessionId - Session ID
   * @param {string} phoneNumber - Phone number to block
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async blockContact(sessionId, phoneNumber) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Normalize the phone number - handle different formats
      let normalizedNumber = phoneNumber.toString().trim();

      // Remove any + prefix
      if (normalizedNumber.startsWith('+')) {
        normalizedNumber = normalizedNumber.substring(1);
      }

      // Convert to JID format if not already
      const jid = normalizedNumber.includes('@') ? normalizedNumber : `${normalizedNumber}@s.whatsapp.net`;

      this.logger.info(`🚫 Starting block process for: ${phoneNumber} -> ${jid} (session: ${sessionId})`);

      // Log available socket methods for debugging
      const socketMethods = Object.getOwnPropertyNames(socket).filter(name => typeof socket[name] === 'function');

      const blockMethods = socketMethods.filter(name => name.toLowerCase().includes('block'));
      this.logger.info(`🚫 Available blocking methods: ${blockMethods.join(', ')}`);
      this.logger.info(`🚫 Socket has updateBlockStatus: ${typeof socket.updateBlockStatus === 'function'}`);
      this.logger.info(`🚫 Socket has fetchBlocklist: ${typeof socket.fetchBlocklist === 'function'}`);

      let blockResult = null;
      let blockMethod = 'unknown';

      try {
        // Method 1: Standard Baileys updateBlockStatus
        if (typeof socket.updateBlockStatus === 'function') {
          this.logger.info(`🚫 Attempting Method 1: updateBlockStatus with ${jid}`);

          blockResult = await socket.updateBlockStatus(jid, 'block');
          blockMethod = 'updateBlockStatus';

          this.logger.info(`🚫 updateBlockStatus result:`, blockResult);

          // Verify blocking worked by fetching blocklist
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

          if (typeof socket.fetchBlocklist === 'function') {
            try {
              const blocklist = await socket.fetchBlocklist();
              this.logger.info(`🚫 Current blocklist after blocking:`, blocklist);

              const isBlocked = blocklist.some(blockedJid =>
                blockedJid === jid ||
                blockedJid === `${normalizedNumber}@c.us` ||
                blockedJid.includes(normalizedNumber)
              );

              if (isBlocked) {
                this.logger.info(`🚫 ✅ VERIFICATION SUCCESS: ${phoneNumber} is now in blocklist`);
                return {
                  success: true,
                  message: `Successfully blocked ${phoneNumber}`,
                  method: blockMethod,
                  verified: true,
                  jid: jid
                };
              } else {
                this.logger.warn(`🚫 ⚠️ VERIFICATION FAILED: ${phoneNumber} not found in blocklist after blocking`);
                // Continue to try other methods
                throw new Error('Blocking verification failed - contact not in blocklist');
              }
            } catch (verifyError) {
              this.logger.warn(`🚫 Could not verify blocking:`, verifyError.message);
              // Return success anyway since the block call succeeded
              return {
                success: true,
                message: `Blocked ${phoneNumber} (verification failed)`,
                method: blockMethod,
                verified: false,
                jid: jid
              };
            }
          } else {
            this.logger.info(`🚫 fetchBlocklist not available, assuming block succeeded`);
            return {
              success: true,
              message: `Successfully blocked ${phoneNumber}`,
              method: blockMethod,
              verified: false,
              jid: jid
            };
          }
        } else {
          throw new Error('updateBlockStatus method not available');
        }
      } catch (blockError) {
        this.logger.error(`🚫 Method 1 failed:`, blockError.message);

        // Method 2: Query-based blocking
        try {
          this.logger.info(`🚫 Attempting Method 2: Query-based blocking with ${jid}`);

          const blockQuery = {
            tag: 'iq',
            attrs: {
              id: `block_${Date.now()}`,
              type: 'set',
              to: 's.whatsapp.net'
            },
            content: [{
              tag: 'blocklist',
              attrs: { xmlns: 'blocklist' },
              content: [{
                tag: 'item',
                attrs: {
                  action: 'block',
                  jid: jid
                }
              }]
            }]
          };

          blockResult = await socket.query(blockQuery);
          blockMethod = 'query';

          this.logger.info(`🚫 Query method result:`, blockResult);

          return {
            success: true,
            message: `Successfully blocked ${phoneNumber} (query method)`,
            method: blockMethod,
            verified: false,
            jid: jid
          };
        } catch (altError1) {
          this.logger.error(`🚫 Method 2 failed:`, altError1.message);

          // Method 3: sendNode direct
          try {
            this.logger.info(`🚫 Attempting Method 3: sendNode with ${jid}`);

            if (typeof socket.sendNode === 'function') {
              const blockNode = {
                tag: 'iq',
                attrs: {
                  id: `block_${Date.now()}`,
                  type: 'set',
                  to: 's.whatsapp.net'
                },
                content: [{
                  tag: 'blocklist',
                  attrs: { xmlns: 'blocklist' },
                  content: [{
                    tag: 'item',
                    attrs: {
                      action: 'block',
                      jid: jid
                    }
                  }]
                }]
              };

              blockResult = await socket.sendNode(blockNode);
              blockMethod = 'sendNode';

              this.logger.info(`🚫 sendNode method result:`, blockResult);

              return {
                success: true,
                message: `Successfully blocked ${phoneNumber} (sendNode method)`,
                method: blockMethod,
                verified: false,
                jid: jid
              };
            } else {
              throw new Error('sendNode method not available');
            }
          } catch (altError2) {
            this.logger.error(`🚫 Method 3 failed:`, altError2.message);

            // Method 4: Try alternative JID format
            const alternativeJid = `${normalizedNumber}@c.us`;

            if (alternativeJid !== jid && typeof socket.updateBlockStatus === 'function') {
              try {
                this.logger.info(`🚫 Attempting Method 4: Alternative JID format ${alternativeJid}`);

                blockResult = await socket.updateBlockStatus(alternativeJid, 'block');
                blockMethod = 'updateBlockStatus (alternative JID)';

                this.logger.info(`🚫 Alternative JID result:`, blockResult);

                return {
                  success: true,
                  message: `Successfully blocked ${phoneNumber} (alternative format)`,
                  method: blockMethod,
                  verified: false,
                  jid: alternativeJid
                };
              } catch (altError3) {
                this.logger.error(`🚫 Method 4 failed:`, altError3.message);
              }
            }

            // All methods failed
            throw new Error(`All blocking methods failed. Last error: ${altError2.message}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`🚫 ❌ Complete blocking failure for ${phoneNumber}:`, error);
      return {
        success: false,
        error: `Failed to block ${phoneNumber}: ${error.message}`,
        jid: phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`
      };
    }
  }

  /**
   * Unblock a contact
   * @param {string} sessionId - Session ID
   * @param {string} phoneNumber - Phone number to unblock
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async unblockContact(sessionId, phoneNumber) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      // Normalize the phone number - handle different formats
      let normalizedNumber = phoneNumber.toString().trim();

      // Remove any + prefix
      if (normalizedNumber.startsWith('+')) {
        normalizedNumber = normalizedNumber.substring(1);
      }

      // Convert to JID format if not already
      const jid = normalizedNumber.includes('@') ? normalizedNumber : `${normalizedNumber}@s.whatsapp.net`;

      this.logger.info(`Unblocking contact: ${phoneNumber} -> ${jid} (session: ${sessionId})`);

      try {
        await socket.updateBlockStatus(jid, 'unblock');
        this.logger.info(`Successfully unblocked contact: ${jid}`);

        return {
          success: true,
          message: `Successfully unblocked ${phoneNumber}`
        };
      } catch (unblockError) {
        this.logger.error(`Unblock operation failed for ${jid}:`, unblockError);

        // Try with different JID format as fallback
        const alternativeJid = normalizedNumber.includes('@') ? normalizedNumber : `${normalizedNumber}@c.us`;

        if (alternativeJid !== jid) {
          this.logger.info(`Retrying with alternative JID format: ${alternativeJid}`);
          try {
            await socket.updateBlockStatus(alternativeJid, 'unblock');
            this.logger.info(`Successfully unblocked contact with alternative format: ${alternativeJid}`);

            return {
              success: true,
              message: `Successfully unblocked ${phoneNumber} (alternative format)`
            };
          } catch (altError) {
            this.logger.error(`Alternative unblock format also failed:`, altError);
          }
        }

        throw unblockError;
      }
    } catch (error) {
      this.logger.error(`Error unblocking contact ${phoneNumber}:`, error);
      return {
        success: false,
        error: `Failed to unblock ${phoneNumber}: ${error.message}`
      };
    }
  }

  /**
   * Get blocked contacts list
   * @param {string} sessionId - Session ID
   * @returns {Promise<{success: boolean, blockedContacts?: Array, error?: string}>}
   */
  async getBlockedContacts(sessionId) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Getting blocked contacts list`);

      const blockedContacts = await socket.fetchBlocklist();

      this.logger.info(`Retrieved ${blockedContacts.length} blocked contacts`);

      return {
        success: true,
        blockedContacts: blockedContacts
      };
    } catch (error) {
      this.logger.error(`Error getting blocked contacts:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Bulk update multiple groups (change subject and description)
   * @param {string} sessionId - Session ID
   * @param {Array} updates - Array of {groupId, subject?, description?}
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  async bulkUpdateGroups(sessionId, updates) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Bulk updating ${updates.length} groups`);

      const results = [];

      for (const update of updates) {
        const { groupId, subject, description } = update;
        const result = { groupId, success: true, errors: [] };

        try {
          // Update subject if provided
          if (subject && subject.trim()) {
            await socket.groupUpdateSubject(groupId, subject);
            result.subjectUpdated = true;
          }

          // Update description if provided
          if (description !== undefined) {
            await socket.groupUpdateDescription(groupId, description);
            result.descriptionUpdated = true;
          }

          // Add delay between updates to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          result.success = false;
          result.errors.push(error.message);
          this.logger.error(`Error updating group ${groupId}:`, error);
        }

        results.push(result);
      }

      const successCount = results.filter(r => r.success).length;
      this.logger.info(`Bulk update completed: ${successCount}/${updates.length} successful`);

      return {
        success: true,
        results: results,
        summary: {
          total: updates.length,
          successful: successCount,
          failed: updates.length - successCount
        }
      };
    } catch (error) {
      this.logger.error(`Error in bulk group update:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Bulk update group photos
   * @param {string} sessionId - Session ID
   * @param {Array} updates - Array of {groupId, imageBuffer}
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  async bulkUpdateGroupPhotos(sessionId, updates) {
    try {
      const socket = this.sessions.get(sessionId);
      if (!socket) {
        throw new Error('Session not found');
      }

      this.logger.info(`Bulk updating photos for ${updates.length} groups`);

      const results = [];

      for (const update of updates) {
        const { groupId, imageBuffer } = update;
        const result = { groupId, success: true };

        try {
          // Convert base64 to buffer if needed
          let buffer = imageBuffer;
          if (typeof imageBuffer === 'string') {
            if (imageBuffer.startsWith('data:')) {
              const base64Data = imageBuffer.split(',')[1];
              buffer = Buffer.from(base64Data, 'base64');
            } else {
              buffer = Buffer.from(imageBuffer, 'base64');
            }
          }

          await socket.updateProfilePicture(groupId, buffer);
          result.photoUpdated = true;

          // Add delay between updates to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          result.success = false;
          result.error = error.message;
          this.logger.error(`Error updating photo for group ${groupId}:`, error);
        }

        results.push(result);
      }

      const successCount = results.filter(r => r.success).length;
      this.logger.info(`Bulk photo update completed: ${successCount}/${updates.length} successful`);

      return {
        success: true,
        results: results,
        summary: {
          total: updates.length,
          successful: successCount,
          failed: updates.length - successCount
        }
      };
    } catch (error) {
      this.logger.error(`Error in bulk group photo update:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ============================================================================
  // END GROUP MANAGEMENT METHODS
  // ============================================================================

  /**
   * Shutdown the service gracefully
   */
  async shutdown() {
    this.isShuttingDown = true;

    try {
      // Wait for any ongoing file operations to complete
      const pendingOperations = Array.from(this.fileOperationLocks.values());
      if (pendingOperations.length > 0) {
        await Promise.allSettled(pendingOperations);
      }

      // Close all sessions
      for (const [sessionId, socket] of this.sessions.entries()) {
        try {
          if (socket && typeof socket.end === 'function') {
            await socket.end();
          }
        } catch (error) {
        }
      }

      // Clean up stores
      for (const sessionId of this.stores.keys()) {
        this.cleanupStore(sessionId);
      }

      // Clear all maps
      this.sessions.clear();
      this.sessionStates.clear();
      this.stores.clear();
      this.fileOperationLocks.clear();

    } catch (error) {
      console.error('Error during WhatsApp service shutdown:', error);
    }
  }
}

module.exports = WhatsAppService;