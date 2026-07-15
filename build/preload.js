const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App related APIs
  getVersion: () => ipcRenderer.invoke('app-version'),

  // App close confirmation
  onShowCloseConfirmation: (callback) => {
    ipcRenderer.on('app:show-close-confirmation', (event, data) => callback(data));
  },
  sendCloseConfirmationResponse: (confirmed) => {
    ipcRenderer.send('app:close-confirmation-response', confirmed);
  },
  
  // Dialog APIs
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  
  // WhatsApp APIs
  whatsapp: {
    // Session Management
    createSession: (sessionData) => ipcRenderer.invoke('whatsapp:create-session', sessionData),
    disconnectSession: (sessionId) => ipcRenderer.invoke('whatsapp:disconnect-session', sessionId),
    reconnectSession: (sessionId) => ipcRenderer.invoke('whatsapp:reconnect-session', sessionId),
    deleteSession: (sessionId) => ipcRenderer.invoke('whatsapp:delete-session', sessionId),
    getSessions: () => ipcRenderer.invoke('whatsapp:get-sessions'),
    getSessionStatus: (sessionId) => ipcRenderer.invoke('whatsapp:get-session-status', sessionId),
    
    // Authentication
    requestPairingCode: (sessionId, phoneNumber) => ipcRenderer.invoke('whatsapp:request-pairing-code', sessionId, phoneNumber),
    createPairingSession: (phoneNumber) => ipcRenderer.invoke('whatsapp:create-pairing-session', phoneNumber),
    
    // Message Management
    sendMessage: (sessionId, to, message, type, options) => ipcRenderer.invoke('whatsapp:send-message', sessionId, to, message, type, options),
    sendTemplateMessage: (sessionId, to, template, variables) => ipcRenderer.invoke('whatsapp:send-template-message', sessionId, to, template, variables),
    checkNumber: (sessionId, phoneNumber) => ipcRenderer.invoke('whatsapp:check-number', sessionId, phoneNumber),
    verifyNumber: (phoneNumber) => ipcRenderer.invoke('whatsapp:verify-number', phoneNumber),
    verifyNumbersBatch: (phoneNumbers) => ipcRenderer.invoke('whatsapp:verify-numbers-batch', phoneNumbers),

    // Chat Management
    getChats: (sessionId) => ipcRenderer.invoke('whatsapp:get-chats', sessionId),
    getChatHistory: (sessionId, chatId, limit) => ipcRenderer.invoke('whatsapp:get-chat-history', sessionId, chatId, limit),
    markChatAsRead: (sessionId, chatId) => ipcRenderer.invoke('whatsapp:mark-chat-as-read', sessionId, chatId),
    resolveLID: (sessionId, jid) => ipcRenderer.invoke('whatsapp:resolve-lid', sessionId, jid),
    resolveLIDsBatch: (sessionId, jids) => ipcRenderer.invoke('whatsapp:resolve-lids-batch', sessionId, jids),

    // Call Responder
    triggerOutgoingCall: (sessionId, contactJid) => ipcRenderer.invoke('whatsapp:trigger-outgoing-call', sessionId, contactJid),

    // Media Management
    downloadMedia: (sessionId, messageKey) => ipcRenderer.invoke('whatsapp:download-media', sessionId, messageKey),
    uploadMedia: (filePath) => ipcRenderer.invoke('whatsapp:upload-media', filePath),

    // Group Management
    fetchAllGroups: (sessionId) => ipcRenderer.invoke('whatsapp:fetch-all-groups', sessionId),
    getGroupMetadata: (sessionId, groupId) => ipcRenderer.invoke('whatsapp:get-group-metadata', sessionId, groupId),
    getGroupInviteCode: (sessionId, groupId) => ipcRenderer.invoke('whatsapp:get-group-invite-code', sessionId, groupId),
    getGroupInfoByInvite: (sessionId, inviteCode) => ipcRenderer.invoke('whatsapp:get-group-info-by-invite', sessionId, inviteCode),
    
    // Group Creation and Management
    createGroup: (sessionId, subject, participants, description) => ipcRenderer.invoke('whatsapp:create-group', sessionId, subject, participants, description),
    addGroupParticipants: (sessionId, groupId, participants) => ipcRenderer.invoke('whatsapp:add-group-participants', sessionId, groupId, participants),
    removeGroupParticipants: (sessionId, groupId, participants) => ipcRenderer.invoke('whatsapp:remove-group-participants', sessionId, groupId, participants),
    promoteGroupParticipants: (sessionId, groupId, participants) => ipcRenderer.invoke('whatsapp:promote-group-participants', sessionId, groupId, participants),
    demoteGroupParticipants: (sessionId, groupId, participants) => ipcRenderer.invoke('whatsapp:demote-group-participants', sessionId, groupId, participants),
    
    // Group Settings
    updateGroupSubject: (sessionId, groupId, subject) => ipcRenderer.invoke('whatsapp:update-group-subject', sessionId, groupId, subject),
    updateGroupDescription: (sessionId, groupId, description) => ipcRenderer.invoke('whatsapp:update-group-description', sessionId, groupId, description),
    updateGroupSettings: (sessionId, groupId, setting) => ipcRenderer.invoke('whatsapp:update-group-settings', sessionId, groupId, setting),
    updateGroupPhoto: (sessionId, groupId, imageBuffer) => ipcRenderer.invoke('whatsapp:update-group-photo', sessionId, groupId, imageBuffer),
    removeGroupPhoto: (sessionId, groupId) => ipcRenderer.invoke('whatsapp:remove-group-photo', sessionId, groupId),
    
    // Group Actions
    leaveGroup: (sessionId, groupId) => ipcRenderer.invoke('whatsapp:leave-group', sessionId, groupId),
    joinGroupWithInvite: (sessionId, inviteCode) => ipcRenderer.invoke('whatsapp:join-group-with-invite', sessionId, inviteCode),
    revokeGroupInvite: (sessionId, groupId) => ipcRenderer.invoke('whatsapp:revoke-group-invite', sessionId, groupId),
    
    // Group Messaging
    sendGroupMessage: (sessionId, groupId, message, mentions, options) => ipcRenderer.invoke('whatsapp:send-group-message', sessionId, groupId, message, mentions, options),

    // Label Management
    getLabels: (sessionId) => ipcRenderer.invoke('whatsapp:get-labels', sessionId),
    getChatsByLabel: (sessionId, labelId) => ipcRenderer.invoke('whatsapp:get-chats-by-label', sessionId, labelId),

    // Contact Blocking/Unblocking
    blockContact: (sessionId, phoneNumber) => ipcRenderer.invoke('whatsapp:block-contact', sessionId, phoneNumber),
    blockContactComprehensive: (sessionId, phoneNumber, options) => ipcRenderer.invoke('whatsapp:comprehensive-block-contact', sessionId, phoneNumber, options),
    unblockContact: (sessionId, phoneNumber) => ipcRenderer.invoke('whatsapp:unblock-contact', sessionId, phoneNumber),
    getBlockedContacts: (sessionId) => ipcRenderer.invoke('whatsapp:get-blocked-contacts', sessionId),
    
    // Bulk Group Operations
    bulkUpdateGroups: (sessionId, updates) => ipcRenderer.invoke('whatsapp:bulk-update-groups', sessionId, updates),
    bulkUpdateGroupPhotos: (sessionId, updates) => ipcRenderer.invoke('whatsapp:bulk-update-group-photos', sessionId, updates),

    // Poll Debug Methods
    debugSpecificPoll: (sessionId, pollQuestion) => ipcRenderer.invoke('whatsapp:debug-specific-poll', sessionId, pollQuestion),
    scanExistingPolls: (sessionId) => ipcRenderer.invoke('whatsapp:scan-existing-polls', sessionId),
    debugDatabasePolls: () => ipcRenderer.invoke('whatsapp:debug-database-polls'),
    forceCheckPollVotes: (sessionId) => ipcRenderer.invoke('whatsapp:force-check-poll-votes', sessionId),
    fixPollVotesDirectly: () => ipcRenderer.invoke('whatsapp:fix-poll-votes-directly'),

    // Event listeners for WhatsApp events
    on: (event, callback) => {
      const eventKey = `whatsapp:${event.replace(/_/g, '-')}`;
      ipcRenderer.on(eventKey, (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners(eventKey);
    },
    
    onQRCode: (callback) => {
      ipcRenderer.on('whatsapp:qr-code', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:qr-code');
    },
    
    onSessionConnected: (callback) => {
      ipcRenderer.on('whatsapp:session-connected', (event, data) => {
        callback(data);
      });
      return () => ipcRenderer.removeAllListeners('whatsapp:session-connected');
    },

    onSessionDisconnected: (callback) => {
      ipcRenderer.on('whatsapp:session-disconnected', (event, data) => {
        callback(data);
      });
      return () => ipcRenderer.removeAllListeners('whatsapp:session-disconnected');
    },
    
    onSessionStatusUpdate: (callback) => {
      ipcRenderer.on('whatsapp:session-status-update', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:session-status-update');
    },
    
    onMessageReceived: (callback) => {
      ipcRenderer.on('whatsapp:message-received', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:message-received');
    },

    onContactsUpdate: (callback) => {
      ipcRenderer.on('whatsapp:contacts-update', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:contacts-update');
    },

    onPresenceUpdate: (callback) => {
      ipcRenderer.on('whatsapp:presence-update', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:presence-update');
    },
    
    onCallReceived: (callback) => {
      ipcRenderer.on('whatsapp:call-received', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:call-received');
    },
    
    onSessionDeleted: (callback) => {
      ipcRenderer.on('whatsapp:session-deleted', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('whatsapp:session-deleted');
    },
    
    // Remove specific listeners
    removeListener: (event, callback) => ipcRenderer.removeListener(event, callback),
    
    // Remove all listeners
    removeAllListeners: (event) => {
      if (event) {
        const eventKey = `whatsapp:${event.replace(/_/g, '-')}`;
        ipcRenderer.removeAllListeners(eventKey);
      } else {
        // Remove all WhatsApp event listeners
        ipcRenderer.removeAllListeners('whatsapp:qr-code');
        ipcRenderer.removeAllListeners('whatsapp:session-connected');
        ipcRenderer.removeAllListeners('whatsapp:session-disconnected');
        ipcRenderer.removeAllListeners('whatsapp:session-status-update');
        ipcRenderer.removeAllListeners('whatsapp:message-received');
        ipcRenderer.removeAllListeners('whatsapp:call-received');
        ipcRenderer.removeAllListeners('whatsapp:session-deleted');
      }
    }
  },
  
  // Database APIs
  database: {
    query: (query, params) => ipcRenderer.invoke('db-query', query, params),
    deleteAllData: () => ipcRenderer.invoke('database:delete-all-data')
  },

  // Opt-Out Service APIs
  optOut: {
    isOptedOut: (phoneNumber, messageType) => ipcRenderer.invoke('optOut:isOptedOut', phoneNumber, messageType),
    optOut: (phoneNumber, options) => ipcRenderer.invoke('optOut:optOut', phoneNumber, options),
    optIn: (phoneNumber, options) => ipcRenderer.invoke('optOut:optIn', phoneNumber, options),
    filterContactsForBulkMessaging: (contacts, messageType) => ipcRenderer.invoke('optOut:filterContactsForBulkMessaging', contacts, messageType),
    getOptedOutContacts: (filters) => ipcRenderer.invoke('optOut:getOptedOutContacts', filters),
    getStatistics: (filters) => ipcRenderer.invoke('optOut:getStatistics', filters),
    getComplianceReport: (filters) => ipcRenderer.invoke('optOut:getComplianceReport', filters),
    getAutoResponseMessages: () => ipcRenderer.invoke('optOut:getAutoResponseMessages'),
    updateAutoResponseMessages: (messages) => ipcRenderer.invoke('optOut:updateAutoResponseMessages', messages)
  },

  // Campaign Scheduler APIs
  campaignScheduler: {
    getStatus: () => ipcRenderer.invoke('campaign-scheduler:get-status'),
    triggerCheck: () => ipcRenderer.invoke('campaign-scheduler:trigger-check'),
    startCampaign: (campaignId) => ipcRenderer.invoke('campaign-scheduler:start-campaign', campaignId)
  },

  // Application APIs
  app: {
    getStats: () => ipcRenderer.invoke('app-stats'),
    getHealth: () => ipcRenderer.invoke('app-health'),
    getRecentActivities: (limit) => ipcRenderer.invoke('app-recent-activities', limit),
    quit: () => ipcRenderer.invoke('app-quit'),
    restart: () => ipcRenderer.invoke('app:restart')
  },

  // Recall Bot APIs
  recallBot: {
    test: () => ipcRenderer.invoke('recall-bot:test'),
    getSettings: (sessionId) => ipcRenderer.invoke('recall-bot:get-settings', sessionId),
    updateSettings: (sessionId, settings) => ipcRenderer.invoke('recall-bot:update-settings', sessionId, settings),
    getReminders: (sessionId) => ipcRenderer.invoke('recall-bot:get-reminders', sessionId),
    cancelReminder: (sessionId, reminderId) => ipcRenderer.invoke('recall-bot:cancel-reminder', sessionId, reminderId),
    getStats: (sessionId) => ipcRenderer.invoke('recall-bot:get-stats', sessionId),
    testAIConnection: (provider, apiKey, model) => ipcRenderer.invoke('recall-bot:test-ai-connection', provider, apiKey, model),
    testTranscription: (provider, apiKey) => ipcRenderer.invoke('recall-bot:test-transcription', provider, apiKey)
  },

  // License Management APIs
  license: {
    getMachineId: () => ipcRenderer.invoke('license:get-machine-id'),
    activate: (licenseKey) => ipcRenderer.invoke('license:activate', licenseKey),
    upgrade: (newLicenseKey) => ipcRenderer.invoke('license:upgrade', newLicenseKey),
    renew: (renewedLicenseKey) => ipcRenderer.invoke('license:renew', renewedLicenseKey),
    registerTrial: (userData) => ipcRenderer.invoke('license:register-trial', userData),
    validate: () => ipcRenderer.invoke('license:validate'),
    getLocalInfo: () => ipcRenderer.invoke('license:get-local-info'),
    saveLocalInfo: (licenseData) => ipcRenderer.invoke('license:save-local-info', licenseData),
    clearLocalData: () => ipcRenderer.invoke('license:clear-local-data'),
    checkMachine: () => ipcRenderer.invoke('license:check-machine'),
    checkStatus: (licenseKey) => ipcRenderer.invoke('license:check-status', licenseKey),
    forceRefresh: () => ipcRenderer.invoke('license:force-refresh'),
    backgroundStatus: () => ipcRenderer.invoke('license:background-status'),
    debugClear: () => ipcRenderer.invoke('license:debug-clear'),
    extractCompanyInfo: (licenseKey) => ipcRenderer.invoke('license:extract-company-info', licenseKey)
  },

  // Cloud License Management APIs
  cloudLicense: {
    activate: (data) => ipcRenderer.invoke('cloud-license:activate', data),
    validate: () => ipcRenderer.invoke('cloud-license:validate'),
    getInfo: () => ipcRenderer.invoke('cloud-license:get-info'),
    hasLicense: () => ipcRenderer.invoke('cloud-license:has-license'),
    delete: () => ipcRenderer.invoke('cloud-license:delete')
  },

  // NewLic License Management APIs
  newlicLicense: {
    activate: (data) => ipcRenderer.invoke('newlic-license:activate', data),
    validate: () => ipcRenderer.invoke('newlic-license:validate'),
    getInfo: () => ipcRenderer.invoke('newlic-license:get-info'),
    clear: () => ipcRenderer.invoke('newlic-license:clear')
  },

  // Reseller Configuration APIs
  reseller: {
    getConfig: () => ipcRenderer.invoke('reseller:get-config')
  },

  // Window Control APIs
  window: {
    toggleFrame: (showFrame) => ipcRenderer.invoke('window:toggle-frame', showFrame),
    getFrameStatus: () => ipcRenderer.invoke('window:get-frame-status'),
    applySavedPreference: () => ipcRenderer.invoke('window:apply-saved-preference')
  },

  // Email APIs
  email: {
    testConfiguration: (config) => ipcRenderer.invoke('email:test-configuration', config)
  },

  // Warmer APIs
  warmer: {
    createCampaign: (campaignData) => ipcRenderer.invoke('warmer:create-campaign', campaignData),
    getCampaigns: () => ipcRenderer.invoke('warmer:get-campaigns'),
    updateCampaign: (campaignId, updates) => ipcRenderer.invoke('warmer:update-campaign', campaignId, updates),
    deleteCampaign: (campaignId) => ipcRenderer.invoke('warmer:delete-campaign', campaignId),
    startCampaign: (campaignId) => ipcRenderer.invoke('warmer:start-campaign', campaignId),
    stopCampaign: (campaignId) => ipcRenderer.invoke('warmer:stop-campaign', campaignId),
    createTemplate: (templateData) => ipcRenderer.invoke('warmer:create-template', templateData),
    getTemplates: () => ipcRenderer.invoke('warmer:get-templates'),
    updateTemplate: (templateId, updates) => ipcRenderer.invoke('warmer:update-template', templateId, updates),
    deleteTemplate: (templateId) => ipcRenderer.invoke('warmer:delete-template', templateId),
    // Event listener for campaign updates
    onCampaignUpdated: (callback) => {
      ipcRenderer.on('warmer:campaign-updated', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('warmer:campaign-updated');
    }
  },

  // Proxy APIs
  proxy: {
    saveApiKey: (apiKey) => ipcRenderer.invoke('proxy:save-api-key', apiKey),
    getSettings: () => ipcRenderer.invoke('proxy:get-settings'),
    syncAccount: () => ipcRenderer.invoke('proxy:sync-account'),
    getPrice: (count, period, version) => ipcRenderer.invoke('proxy:get-price', count, period, version),
    getCountries: (version) => ipcRenderer.invoke('proxy:get-countries', version),
    getCount: (country, version) => ipcRenderer.invoke('proxy:get-count', country, version),
    buyProxy: (count, period, country, version, type, description, autoProlong) =>
      ipcRenderer.invoke('proxy:buy-proxy', count, period, country, version, type, description, autoProlong),
    syncProxies: (state) => ipcRenderer.invoke('proxy:sync-proxies', state),
    getProxies: (filters) => ipcRenderer.invoke('proxy:get-proxies', filters),
    prolongProxy: (proxyIds, period) => ipcRenderer.invoke('proxy:prolong-proxy', proxyIds, period),
    deleteProxy: (proxyIds) => ipcRenderer.invoke('proxy:delete-proxy', proxyIds),
    checkProxy: (proxyId) => ipcRenderer.invoke('proxy:check-proxy', proxyId),
    setProxyType: (proxyIds, type) => ipcRenderer.invoke('proxy:set-type', proxyIds, type),
    getStatistics: () => ipcRenderer.invoke('proxy:get-statistics'),
    assignToCampaign: (campaignId, proxyId, sessionId) =>
      ipcRenderer.invoke('proxy:assign-to-campaign', campaignId, proxyId, sessionId),
    getForCampaign: (campaignId, sessionId) =>
      ipcRenderer.invoke('proxy:get-for-campaign', campaignId, sessionId)
  },

  // File System APIs
  fs: {
    readFile: (filePath) => ipcRenderer.invoke('fs-read-file', filePath),
    writeFile: (filePath, data) => ipcRenderer.invoke('fs-write-file', filePath, data)
  },

  // Shell APIs
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell-open-external', url)
  },

  // Backup and Restore APIs
  backup: {
    create: (options) => ipcRenderer.invoke('backup:create', options),
    restore: (filePath, options) => ipcRenderer.invoke('backup:restore', filePath, options),

    schedule: (schedulePattern, options) => ipcRenderer.invoke('backup:schedule', schedulePattern, options),
    cancelSchedule: (jobId) => ipcRenderer.invoke('backup:cancel-schedule', jobId),
    getHistory: () => ipcRenderer.invoke('backup:get-history'),
    selectFile: () => ipcRenderer.invoke('backup:select-file'),
    selectSaveLocation: (defaultName) => ipcRenderer.invoke('backup:select-save-location', defaultName),
    downloadToLocal: (filePath) => ipcRenderer.invoke('backup:download-to-local', filePath),
    validateFile: (filePath) => ipcRenderer.invoke('backup:validate-file', filePath),
    getFileInfo: (filePath) => ipcRenderer.invoke('backup:get-file-info', filePath),
    cleanOld: (retentionDays) => ipcRenderer.invoke('backup:clean-old', retentionDays)
  },

  // Utility APIs
  utils: {
    isElectron: true,
    platform: process.platform,
    isDevelopment: () => ipcRenderer.invoke('app:is-development')
  },

  // Voice Transcription APIs
  voiceTranscription: {
    // Send transcription result back to main process
    sendTranscriptionResult: (result) => {
      ipcRenderer.send('transcription-result', result);
    },

    // Send transcription error back to main process
    sendTranscriptionError: (error) => {
      ipcRenderer.send('transcription-error', error);
    },

    // Listen for transcription requests from main process
    onTranscribeAudio: (callback) => {
      ipcRenderer.on('transcribe-audio', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('transcribe-audio');
    }
  },

  // Events API for generic event handling
  events: {
    on: (event, callback) => {
      ipcRenderer.on(event, (ipcEvent, data) => callback(data));
      return () => ipcRenderer.removeAllListeners(event);
    },

    removeListener: (event, callback) => {
      ipcRenderer.removeListener(event, callback);
    },

    removeAllListeners: (event) => {
      ipcRenderer.removeAllListeners(event);
    }
  },

  // Notification APIs
  notifications: {
    getNotifications: () => ipcRenderer.invoke('notifications:get-notifications'),
    getLatestNotifications: (lastCheck) => ipcRenderer.invoke('notifications:get-latest', lastCheck),
    markAsRead: (notificationId) => ipcRenderer.invoke('notifications:mark-as-read', notificationId),
    getStats: () => ipcRenderer.invoke('notifications:get-stats'),
    onNewNotification: (callback) => {
      ipcRenderer.on('notifications:new-notification', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('notifications:new-notification');
    },
    onNotificationUpdate: (callback) => {
      ipcRenderer.on('notifications:update', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('notifications:update');
    },
    onShowToast: (callback) => {
      ipcRenderer.on('notifications:show-toast', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('notifications:show-toast');
    }
  },

  // Update APIs
  update: {
    checkForUpdates: (silent = false) => ipcRenderer.invoke('update:check-for-updates', silent),
    downloadUpdate: () => ipcRenderer.invoke('update:download-update'),
    installUpdate: () => ipcRenderer.invoke('update:install-update'),
    installSimple: () => ipcRenderer.invoke('update:install-simple'),
    getUpdateInfo: () => ipcRenderer.invoke('update:get-update-info'),
    verifyDataIntegrity: () => ipcRenderer.invoke('update:verify-data-integrity'),
    createBackup: () => ipcRenderer.invoke('update:create-backup'),
    getDataSummary: () => ipcRenderer.invoke('update:get-data-summary'),
    validateBranding: () => ipcRenderer.invoke('update:validate-branding'),
    getBrandingSummary: () => ipcRenderer.invoke('update:get-branding-summary'),
    performBrandingAudit: () => ipcRenderer.invoke('update:perform-branding-audit'),
    lockBranding: () => ipcRenderer.invoke('update:lock-branding'),

    // Installation progress events
    onInstallationProgress: (callback) => {
      ipcRenderer.on('show-installation-progress', (event, data) => callback(data));
      ipcRenderer.on('update-installation-progress', (event, data) => callback(data));
      ipcRenderer.on('hide-installation-progress', (event, data) => callback(data));
      return () => {
        ipcRenderer.removeAllListeners('show-installation-progress');
        ipcRenderer.removeAllListeners('update-installation-progress');
        ipcRenderer.removeAllListeners('hide-installation-progress');
      };
    }
  },

  // Event listeners for update events
  on: (event, callback) => {
    ipcRenderer.on(event, (ipcEvent, data) => callback(ipcEvent, data));
  },

  removeListener: (event, callback) => {
    ipcRenderer.removeListener(event, callback);
  },

  // Direct access to ipcRenderer for installation progress events
  ipcRenderer: {
    on: (event, callback) => {
      ipcRenderer.on(event, callback);
    },
    removeListener: (event, callback) => {
      ipcRenderer.removeListener(event, callback);
    }
  },

  // Translation Management APIs
  translation: {
    getTranslationsForLanguage: (languageCode) => ipcRenderer.invoke('translation:get-translations-for-language', languageCode),
    updateTranslation: (keyId, languageCode, customText, isApproved, notes) => ipcRenderer.invoke('translation:update-translation', keyId, languageCode, customText, isApproved, notes),
    deleteTranslation: (keyId, languageCode) => ipcRenderer.invoke('translation:delete-translation', keyId, languageCode),
    getStats: () => ipcRenderer.invoke('translation:get-stats'),
    syncKeys: () => ipcRenderer.invoke('translation:sync-keys'),
    exportTranslations: (languageCode) => ipcRenderer.invoke('translation:export-translations', languageCode),
    importTranslations: (languageCode, translationsData, approveAll) => ipcRenderer.invoke('translation:import-translations', languageCode, translationsData, approveAll),
    searchTranslations: (languageCode, searchTerm) => ipcRenderer.invoke('translation:search-translations', languageCode, searchTerm)
  },

  // Chatbot Flow APIs
  chatbot: {
    cleanupOrphanedConversations: () => ipcRenderer.invoke('chatbot:cleanup-orphaned-conversations')
  },

  // AI Chatbot APIs
  ai: {
    forceMigration: () => ipcRenderer.invoke('ai-schema:force-migration'),

    // AI Chatbot Management
    chatbots: {
      getAll: () => ipcRenderer.invoke('ai-chatbots:get-all'),
      create: (chatbotData) => ipcRenderer.invoke('ai-chatbots:create', chatbotData),
      update: (id, chatbotData) => ipcRenderer.invoke('ai-chatbots:update', id, chatbotData),
      delete: (id) => ipcRenderer.invoke('ai-chatbots:delete', id)
    },

    // AI Provider Management
    providers: {
      getAll: () => ipcRenderer.invoke('ai-providers:get-all'),
      create: (providerData) => ipcRenderer.invoke('ai-providers:create', providerData),
      update: (id, providerData) => ipcRenderer.invoke('ai-providers:update', id, providerData),
      delete: (id) => ipcRenderer.invoke('ai-providers:delete', id)
    },

    // AI Document Management
    documents: {
      upload: (chatbotId, fileBuffer, originalFilename) => ipcRenderer.invoke('ai-documents:upload', chatbotId, fileBuffer, originalFilename),
      getAll: (chatbotId) => ipcRenderer.invoke('ai-documents:get-all', chatbotId),
      delete: (documentId) => ipcRenderer.invoke('ai-documents:delete', documentId)
    }
  },

  // Live Chat APIs
  liveChat: {
    // Diagnostic
    checkServiceStatus: () =>
      ipcRenderer.invoke('live-chat:check-service-status'),
    forceInitialize: () =>
      ipcRenderer.invoke('live-chat:force-initialize'),

    // Sync
    syncChatHistory: (sessionId, chatId, conversationId) =>
      ipcRenderer.invoke('live-chat:sync-chat-history', sessionId, chatId, conversationId),

    // Conversation Management
    getOrCreateConversation: (sessionId, contactPhone, contactName, contactAvatar, fullChatId) =>
      ipcRenderer.invoke('live-chat:get-or-create-conversation', sessionId, contactPhone, contactName, contactAvatar, fullChatId),
    getConversations: (sessionId, filters) =>
      ipcRenderer.invoke('live-chat:get-conversations', sessionId, filters),
    updateConversation: (conversationId, updates) =>
      ipcRenderer.invoke('live-chat:update-conversation', conversationId, updates),
    updateConversationStatus: (conversationId, status) =>
      ipcRenderer.invoke('live-chat:update-conversation-status', conversationId, status),
    markAsRead: (conversationId) =>
      ipcRenderer.invoke('live-chat:mark-as-read', conversationId),
    searchConversations: (sessionId, searchTerm) =>
      ipcRenderer.invoke('live-chat:search-conversations', sessionId, searchTerm),

    // Message Management
    saveMessage: (conversationId, messageData) =>
      ipcRenderer.invoke('live-chat:save-message', conversationId, messageData),
    getMessages: (conversationId, limit, offset) =>
      ipcRenderer.invoke('live-chat:get-messages', conversationId, limit, offset),

    // Contact/CRM Management
    getContact: (phone) =>
      ipcRenderer.invoke('live-chat:get-contact', phone),
    createOrUpdateContact: (phone, name, avatar, additionalData) =>
      ipcRenderer.invoke('live-chat:create-or-update-contact', phone, name, avatar, additionalData),

    // Notes Management
    addNote: (conversationId, author, content, noteType) =>
      ipcRenderer.invoke('live-chat:add-note', conversationId, author, content, noteType),
    getNotes: (conversationId) =>
      ipcRenderer.invoke('live-chat:get-notes', conversationId),
    updateNote: (noteId, content) =>
      ipcRenderer.invoke('live-chat:update-note', noteId, content),
    deleteNote: (noteId) =>
      ipcRenderer.invoke('live-chat:delete-note', noteId),

    // Quick Replies
    getQuickReplies: () =>
      ipcRenderer.invoke('live-chat:get-quick-replies'),
    createQuickReply: (shortcut, title, content, category) =>
      ipcRenderer.invoke('live-chat:create-quick-reply', shortcut, title, content, category),

    // Statistics
    getStatistics: (sessionId) =>
      ipcRenderer.invoke('live-chat:get-statistics', sessionId),

    // Event listeners
    onMessageNew: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('live-chat:message-new', listener);
      return () => ipcRenderer.removeListener('live-chat:message-new', listener);
    }
  },

  // Generic invoke method for custom IPC calls
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)
});

// Preload script loaded successfully - removed console.log for production