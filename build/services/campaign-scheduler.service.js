const { EventEmitter } = require('events');
const BulkMessageFeaturesService = require('./bulk-message-features.service');
const OptOutService = require('./opt-out.service');

class CampaignSchedulerService extends EventEmitter {
  constructor() {
    super();
    this.schedulerInterval = null;
    this.isRunning = false;
    this.checkInterval = 30000; // Check every 30 seconds
    this.activeProcesses = new Map(); // Track active campaign processes
    this.databaseService = null;
    this.whatsappService = null;
    this.messageProcessor = null;
    this.bulkMessageFeatures = null;
    this.optOutService = null;
    // Debug mode - set to false to reduce console logs
    this.debugMode = false;
  }

  // Helper method for debug logging
  debugLog(...args) {
    if (this.debugMode) {
    }
  }

  /**
   * Initialize the scheduler service
   */
  async initialize(databaseService, whatsappService, messageProcessor) {
    try {
      this.databaseService = databaseService;
      this.whatsappService = whatsappService;
      this.messageProcessor = messageProcessor;
      this.bulkMessageFeatures = new BulkMessageFeaturesService(databaseService, whatsappService);
      this.optOutService = new OptOutService();

      return { success: true };
    } catch (error) {
      console.error('❌ Failed to initialize Campaign Scheduler Service:', error);
      throw error;
    }
  }

  /**
   * Start the campaign scheduler
   */
  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Start the scheduler interval
    this.schedulerInterval = setInterval(() => {
      this.checkScheduledCampaigns();
    }, this.checkInterval);

    // Run initial check
    this.checkScheduledCampaigns();

    this.emit('scheduler-started');
  }

  /**
   * Stop the campaign scheduler
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    this.emit('scheduler-stopped');
  }

  /**
   * Manually trigger a scheduler check (for testing)
   */
  async triggerCheck() {
    await this.checkScheduledCampaigns();
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      activeProcesses: this.activeProcesses.size,
      activeProcessIds: Array.from(this.activeProcesses.keys())
    };
  }

  /**
   * Stop all running campaigns and clean up
   */
  async stopAllCampaigns() {
    try {

      // Get all running campaigns
      const runningCampaigns = await this.databaseService.query(
        'SELECT id, name FROM bulk_campaigns WHERE status = ?',
        ['running']
      );

      if (runningCampaigns.success && runningCampaigns.data.length > 0) {

        for (const campaign of runningCampaigns.data) {

          // Update campaign status to stopped
          await this.databaseService.query(
            'UPDATE bulk_campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['stopped', campaign.id]
          );
        }
      }

      // Clear all active processes
      this.activeProcesses.clear();

      return { success: true, stoppedCount: runningCampaigns.data?.length || 0 };
    } catch (error) {
      console.error('❌ Error stopping campaigns:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check for scheduled campaigns that should be started
   */
  async checkScheduledCampaigns() {
    if (!this.databaseService || !this.isRunning) {
      this.debugLog('⚠️ Scheduler check skipped - database not available or scheduler not running');
      return;
    }

    try {
      const now = new Date().toISOString();
      this.debugLog(`🔍 Checking for scheduled campaigns at ${now}`);

      // First, let's see all scheduled campaigns for debugging
      const allScheduledResponse = await this.databaseService.query(`
        SELECT id, name, status, scheduled_at FROM bulk_campaigns
        WHERE status = 'scheduled'
        AND scheduled_at IS NOT NULL
        ORDER BY scheduled_at ASC
      `);

      this.debugLog(`📊 All scheduled campaigns:`, allScheduledResponse);

      // Get campaigns that are scheduled and should be started now
      const response = await this.databaseService.query(`
        SELECT * FROM bulk_campaigns
        WHERE status = 'scheduled'
        AND scheduled_at <= ?
        AND scheduled_at IS NOT NULL
        ORDER BY scheduled_at ASC
      `, [now]);

      this.debugLog(`📊 Scheduler query result:`, response);

      if (response.success) {
        if (response.data.length > 0) {
          this.debugLog(`📅 Found ${response.data.length} campaigns ready to start`);

          for (const campaign of response.data) {
            this.debugLog(`🚀 Processing campaign: ${campaign.name} (ID: ${campaign.id}) scheduled for ${campaign.scheduled_at}`);
            await this.startScheduledCampaign(campaign);
          }
        } else {
          this.debugLog('📅 No campaigns ready to start at this time');
        }
      } else {
        console.error('❌ Database query failed:', response.error);
      }
    } catch (error) {
      console.error('❌ Error checking scheduled campaigns:', error);
    }
  }

  /**
   * Start a scheduled campaign
   */
  async startScheduledCampaign(campaign) {
    try {

      // Update campaign status to running
      const updateResponse = await this.databaseService.query(
        'UPDATE bulk_campaigns SET status = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['running', campaign.id]
      );

      if (!updateResponse.success) {
        console.error(`❌ Failed to update campaign status for ID ${campaign.id}:`, updateResponse.error);
        return;
      }

      // Start processing the campaign
      this.processCampaign(campaign.id);

      this.emit('campaign-started', { campaignId: campaign.id, campaignName: campaign.name });
      
    } catch (error) {
      console.error(`❌ Error starting scheduled campaign ${campaign.id}:`, error);
      
      // Mark campaign as failed
      await this.databaseService.query(
        'UPDATE bulk_campaigns SET status = ? WHERE id = ?',
        ['failed', campaign.id]
      );
    }
  }

  /**
   * Process a campaign (send messages)
   */
  async processCampaign(campaignId) {
    this.debugLog(`🚀 *** VARIABLE FIX VERSION *** Processing campaign ${campaignId}`);

    // Add file logging as well
    if (typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const logPath = path.join(os.homedir(), 'ChatPro', 'logs', 'leadwave-debug.log');
        const logMessage = `[${new Date().toISOString()}] 🚀 *** CAMPAIGN SCHEDULER *** Processing campaign ${campaignId}\n`;
        fs.appendFileSync(logPath, logMessage);
      } catch (e) {
        // Ignore logging errors
      }
    }

    // Check if campaign is already being processed
    if (this.activeProcesses.has(campaignId)) {
      return;
    }

    // Check campaign status before processing
    const statusCheck = await this.databaseService.query(
      'SELECT status FROM bulk_campaigns WHERE id = ?',
      [campaignId]
    );

    if (!statusCheck.success || statusCheck.data.length === 0) {
      return;
    }

    const currentStatus = statusCheck.data[0].status;
    if (currentStatus !== 'running' && currentStatus !== 'pending' && currentStatus !== 'paused') {
      return;
    }

    // If campaign is paused, update to running when resuming
    if (currentStatus === 'paused') {
      await this.databaseService.query(
        'UPDATE bulk_campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['running', campaignId]
      );
    }

    this.activeProcesses.set(campaignId, true);
    this.debugLog(`📊 Active campaigns: ${this.activeProcesses.size}`);
    this.debugLog(`📊 Active campaign IDs: ${Array.from(this.activeProcesses.keys()).join(', ')}`);

    try {
      this.debugLog(`📤 Processing campaign messages for ID: ${campaignId}`);

      // Reset message count for sleep timing
      if (this.bulkMessageFeatures) {
        await this.bulkMessageFeatures.resetMessageCount(campaignId);
      }

      // Get campaign details
      const campaignResponse = await this.databaseService.query(
        'SELECT * FROM bulk_campaigns WHERE id = ?',
        [campaignId]
      );

      if (!campaignResponse.success || campaignResponse.data.length === 0) {
        console.error(`❌ Campaign not found: ${campaignId}`);
        return;
      }

      const campaign = campaignResponse.data[0];
      const sessionIds = JSON.parse(campaign.session_ids || '[]');
      const proxyIds = JSON.parse(campaign.proxy_ids || '[]');

      // Add detailed campaign debugging
      this.debugLog(`🔍 CAMPAIGN DEBUG: Campaign ${campaignId} details:`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Name: ${campaign.name}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Status: ${campaign.status}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Device rotation: ${campaign.device_rotation}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Session IDs: ${JSON.stringify(sessionIds)}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Session count: ${sessionIds.length}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Proxy IDs: ${JSON.stringify(proxyIds)}`);
      this.debugLog(`🔍 CAMPAIGN DEBUG: - Proxy count: ${proxyIds.length}`);

      // Log to file as well
      if (typeof require !== 'undefined') {
        try {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const logPath = path.join(os.homedir(), 'ChatPro', 'logs', 'leadwave-debug.log');
          const logMessage = `[${new Date().toISOString()}] 🔍 CAMPAIGN DEBUG: Campaign ${campaignId} - rotation: ${campaign.device_rotation}, sessions: ${JSON.stringify(sessionIds)}\n`;
          fs.appendFileSync(logPath, logMessage);
        } catch (e) {
          // Ignore logging errors
        }
      }

      if (sessionIds.length === 0) {
        console.error(`❌ No sessions configured for campaign ${campaignId}`);
        await this.databaseService.query(
          'UPDATE bulk_campaigns SET status = ? WHERE id = ?',
          ['failed', campaignId]
        );
        return;
      }

      // Get pending recipients with contact information including all variables
      // Use LEFT JOIN to support pasted numbers (which may not exist in contacts table)
      const recipientsResponse = await this.databaseService.query(`
        SELECT bcr.*,
               COALESCE(c.phone_number, bcr.contact_id) as phone_number,
               COALESCE(c.name, bcr.contact_id) as name,
               c.email, c.company, c.position,
               c.var1, c.var2, c.var3, c.var4, c.var5,
               c.var6, c.var7, c.var8, c.var9, c.var10
        FROM bulk_campaign_recipients bcr
        LEFT JOIN contacts c ON bcr.contact_id = c.id
        WHERE bcr.campaign_id = ? AND bcr.status = ?
        ORDER BY bcr.id ASC
      `, [campaignId, 'pending']);

      if (!recipientsResponse.success || recipientsResponse.data.length === 0) {

        // Get final counts from recipients table
        const countsResponse = await this.databaseService.query(`
          SELECT
            COUNT(CASE WHEN status IN ('sent', 'delivered') THEN 1 END) as sent_count,
            COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
          FROM bulk_campaign_recipients
          WHERE campaign_id = ?
        `, [campaignId]);

        let sentCount = 0;
        let failedCount = 0;
        if (countsResponse.success && countsResponse.data.length > 0) {
          sentCount = countsResponse.data[0].sent_count || 0;
          failedCount = countsResponse.data[0].failed_count || 0;
        }

        await this.databaseService.query(
          'UPDATE bulk_campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP, sent_count = ?, failed_count = ? WHERE id = ?',
          ['completed', campaignId, sentCount, failedCount]
        );

        return;
      }

      const recipients = recipientsResponse.data;
      this.debugLog(`📧 Found ${recipients.length} pending recipients for campaign ${campaignId}`);

      // Debug: Log first recipient data to verify variables are loaded
      if (recipients.length > 0) {
        this.debugLog('🔍 SCHEDULER - First recipient data:', {
          id: recipients[0].id,
          name: recipients[0].name,
          phone: recipients[0].phone_number,
          var1: recipients[0].var1,
          var2: recipients[0].var2,
          var3: recipients[0].var3
        });
      }

      let currentSessionIndex = 0;
      const blockedSessions = new Set(); // Track blocked/failed sessions
      const sessionFailureCount = new Map(); // Track consecutive failures per session
      const MAX_CONSECUTIVE_FAILURES = 8; // Max failures before marking session as blocked (increased for stability)

      // Proxy rotation setup
      let currentProxyIndex = 0;
      let availableProxies = [];

      // Load proxy details if proxy IDs are configured
      if (proxyIds.length > 0) {
        const proxyResponse = await this.databaseService.query(
          `SELECT * FROM proxies WHERE id IN (${proxyIds.map(() => '?').join(',')}) AND is_active = 1`,
          proxyIds
        );

        if (proxyResponse.success && proxyResponse.data.length > 0) {
          availableProxies = proxyResponse.data;
        } else {
        }
      }

      this.debugLog(`🔧 SESSION ROTATION DEBUG: Starting campaign with ${sessionIds.length} sessions, rotation enabled: ${campaign.device_rotation}`);
      this.debugLog(`🔧 SESSION ROTATION DEBUG: Session IDs: ${sessionIds.join(', ')}`);
      this.debugLog(`🌐 PROXY ROTATION DEBUG: Starting campaign with ${availableProxies.length} proxies`);

      // Log to file as well
      if (typeof require !== 'undefined') {
        try {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const logPath = path.join(os.homedir(), 'ChatPro', 'logs', 'leadwave-debug.log');
          const logMessage = `[${new Date().toISOString()}] 🔧 SESSION ROTATION DEBUG: Starting campaign with ${sessionIds.length} sessions, rotation enabled: ${campaign.device_rotation}\n`;
          fs.appendFileSync(logPath, logMessage);
        } catch (e) {
          // Ignore logging errors
        }
      }

      this.debugLog(`🚀 STARTING RECIPIENT PROCESSING LOOP: ${recipients.length} recipients to process`);

      // Process each recipient
      for (let i = 0; i < recipients.length; i++) {
        // Check if campaign is still running
        const statusCheck = await this.databaseService.query(
          'SELECT status FROM bulk_campaigns WHERE id = ?',
          [campaignId]
        );

        if (!statusCheck.success || statusCheck.data[0]?.status !== 'running') {
          break;
        }

        // Periodic health check every 10 messages
        if (i > 0 && i % 10 === 0) {
          for (const sid of sessionIds) {
            const healthCheck = await this.isSessionUsableForSending(sid);
            if (!healthCheck.usable && healthCheck.permanent) {
              if (!blockedSessions.has(sid)) {
                blockedSessions.add(sid);
              }
            }
          }
        }

        const recipient = recipients[i];

        // Get available (non-blocked) sessions
        const availableSessions = sessionIds.filter(sessionId => !blockedSessions.has(sessionId));

        this.debugLog(`🔧 SESSION ROTATION DEBUG: Recipient ${i + 1}/${recipients.length} - Available sessions: ${availableSessions.length}/${sessionIds.length}`);
        this.debugLog(`🔧 SESSION ROTATION DEBUG: Blocked sessions: ${Array.from(blockedSessions).join(', ') || 'None'}`);

        if (availableSessions.length === 0) {

          // Before giving up, check if any "blocked" sessions are actually recoverable
          let recoverableSessions = 0;
          for (const sessionId of sessionIds) {
            if (blockedSessions.has(sessionId)) {
              const usabilityCheck = await this.isSessionUsableForSending(sessionId);
              if (usabilityCheck.usable) {
                blockedSessions.delete(sessionId);
                recoverableSessions++;
              }
            }
          }

          // If we recovered some sessions, continue with the campaign
          if (recoverableSessions > 0) {
            i--; // Retry this recipient
            continue;
          }


          // Mark all remaining pending recipients as failed
          await this.databaseService.query(
            'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE campaign_id = ? AND status = ?',
            ['failed', 'All sessions permanently blocked or disconnected', campaignId, 'pending']
          );

          // Get final counts from recipients table
          const countsResponse = await this.databaseService.query(`
            SELECT
              COUNT(CASE WHEN status IN ('sent', 'delivered') THEN 1 END) as sent_count,
              COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
            FROM bulk_campaign_recipients
            WHERE campaign_id = ?
          `, [campaignId]);

          let sentCount = 0;
          let failedCount = 0;
          if (countsResponse.success && countsResponse.data.length > 0) {
            sentCount = countsResponse.data[0].sent_count || 0;
            failedCount = countsResponse.data[0].failed_count || 0;
          }

          // Mark campaign as completed (not failed) since some messages were sent
          const finalStatus = sentCount > 0 ? 'completed' : 'failed';
          await this.databaseService.query(
            'UPDATE bulk_campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP, sent_count = ?, failed_count = ? WHERE id = ?',
            [finalStatus, sentCount, failedCount, campaignId]
          );

          this.emit('campaign-completed', { campaignId });
          break;
        }

        // Select session from available sessions (rotate if enabled)
        let sessionId;
        if (campaign.device_rotation && availableSessions.length > 1) {
          // Use modulo with available sessions length to ensure we stay within bounds
          sessionId = availableSessions[currentSessionIndex % availableSessions.length];
          currentSessionIndex++;
          this.debugLog(`🔄 SESSION ROTATION DEBUG: Using rotation - selected session ${sessionId} (index ${currentSessionIndex - 1})`);
        } else {
          sessionId = availableSessions[0];
          this.debugLog(`🔧 SESSION ROTATION DEBUG: Using first available session ${sessionId} (rotation disabled or single session)`);
        }

        this.debugLog(`📱 Using session ${sessionId} for recipient ${i + 1}/${recipients.length} (Available: ${availableSessions.length}/${sessionIds.length})`);

        // Select proxy from available proxies (rotate if multiple proxies)
        let selectedProxy = null;
        if (availableProxies.length > 0) {
          selectedProxy = availableProxies[currentProxyIndex % availableProxies.length];
          currentProxyIndex++;
          this.debugLog(`🌐 PROXY ROTATION DEBUG: Selected proxy ${selectedProxy.id} - ${selectedProxy.host}:${selectedProxy.port}`);

          // Set proxy for this session
          try {
            await this.whatsappService.setSessionProxy(sessionId, selectedProxy);
          } catch (error) {
            console.error(`❌ Failed to set proxy for session ${sessionId}:`, error.message);
            // Continue without proxy if setting fails
          }

          // Store proxy assignment in database for tracking
          try {
            await this.databaseService.query(
              'UPDATE bulk_campaign_recipients SET proxy_id = ? WHERE id = ?',
              [selectedProxy.id, recipient.id]
            );
          } catch (error) {
            console.error(`❌ Failed to store proxy assignment:`, error.message);
          }
        } else {
          // No proxy selected, remove any existing proxy from session
          try {
            this.whatsappService.removeSessionProxy(sessionId);
          } catch (error) {
            // Ignore errors when removing proxy
          }
        }

        // Check session status before sending (more robust check)
        const isSessionUsable = await this.isSessionUsableForSending(sessionId);
        if (!isSessionUsable.usable) {

          // Only mark as blocked if it's a permanent issue, not temporary
          if (isSessionUsable.permanent) {
            blockedSessions.add(sessionId);
          }

          // Mark recipient as failed due to session issue only if all sessions are blocked
          const remainingAvailableSessions = sessionIds.filter(id => !blockedSessions.has(id) && id !== sessionId);
          if (remainingAvailableSessions.length === 0) {
            await this.databaseService.query(
              'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
              ['failed', `No usable sessions: ${isSessionUsable.reason}`, recipient.id]
            );
          }

          // Retry with next available session if any
          i--; // Retry this recipient with a different session
          continue;
        }

        // Check if this is a video template and add extra stability measures
        let isVideoTemplate = false;
        if (campaign.template_id) {
          const templateResponse = await this.databaseService.query(
            'SELECT type FROM message_templates WHERE id = ?',
            [campaign.template_id]
          );

          if (templateResponse.success && templateResponse.data.length > 0) {
            isVideoTemplate = templateResponse.data[0].type === 'video';
          }
        }

        // For video messages, check connection stability before sending
        if (isVideoTemplate) {

          // Check if session is still connected
          const sessionStatus = await this.whatsappService.getSessionStatus(sessionId);
          if (!sessionStatus || sessionStatus.status !== 'connected') {

            // Mark recipient as failed
            await this.databaseService.query(
              'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
              ['failed', 'Session disconnected before video send', recipient.id]
            );
            continue;
          }
        }

        const messageResult = await this.sendMessageToRecipient(campaign, recipient, sessionId, i, recipients.length);

        // Handle message result and track session failures
        if (!messageResult.success) {
          // Check if this is a session-related error that indicates permanent blocking
          const errorMessage = messageResult.error || '';

          // Check if this is a socket disconnection error
          const isSocketDisconnection = this.isSocketDisconnectionError(errorMessage);
          const isPermanentlyBlocked = this.isPermanentlyBlockedError(errorMessage);

          // If it's a disconnection or permanent block, mark session as blocked
          if (isSocketDisconnection || isPermanentlyBlocked) {
            blockedSessions.add(sessionId);

            // Check if there are other available sessions
            const remainingAvailableSessions = sessionIds.filter(id => !blockedSessions.has(id));

            if (remainingAvailableSessions.length === 0) {
              // No more sessions available - pause campaign for manual intervention

              await this.databaseService.query(
                'UPDATE bulk_campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['paused', campaignId]
              );

              this.emit('campaign-paused', {
                campaignId,
                reason: `All sessions blocked or disconnected. Last error: ${errorMessage}`,
                sessionId
              });

              break; // Exit the recipient processing loop
            } else {
              // Other sessions available - continue with them

              // Mark recipient as failed for this session
              await this.databaseService.query(
                'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
                ['failed', `Session ${sessionId} blocked: ${errorMessage}`, recipient.id]
              );

              // Retry with next available session
              i--; // Retry this recipient with a different session
              continue;
            }
          }

          // For non-blocking errors (temporary failures), track consecutive failures
          const currentFailures = sessionFailureCount.get(sessionId) || 0;
          sessionFailureCount.set(sessionId, currentFailures + 1);


          // Only block after multiple consecutive failures for temporary errors
          if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
            blockedSessions.add(sessionId);

            // Check if there are other available sessions
            const remainingAvailableSessions = sessionIds.filter(id => !blockedSessions.has(id));

            if (remainingAvailableSessions.length === 0) {
              // No more sessions available - pause campaign

              await this.databaseService.query(
                'UPDATE bulk_campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['paused', campaignId]
              );

              this.emit('campaign-paused', {
                campaignId,
                reason: `All sessions failed multiple times. Last error: ${errorMessage}`,
                sessionId
              });

              break; // Exit the recipient processing loop
            } else {
              // Retry with next available session
              i--; // Retry this recipient with a different session
              continue;
            }
          }
        } else {
          // Reset failure count on successful send
          sessionFailureCount.set(sessionId, 0);
        }

        // Increment message count for bulk features
        let messageCount = 0;
        this.debugLog(`🔧 BULK FEATURES DEBUG: bulkMessageFeatures available: ${!!this.bulkMessageFeatures}`);

        if (this.bulkMessageFeatures) {
          try {
            messageCount = await this.bulkMessageFeatures.incrementMessageCount(campaign.id);
            this.debugLog(`🔢 BULK FEATURES DEBUG: Message count for campaign ${campaign.id}: ${messageCount}`);

            // Check if we should send to family numbers
            const shouldSendToFamily = await this.bulkMessageFeatures.shouldSendToFamilyNumbers(campaign.id, messageCount);
            this.debugLog(`👨‍👩‍👧‍👦 BULK FEATURES DEBUG: Should send to family numbers: ${shouldSendToFamily}`);

            if (shouldSendToFamily) {

              // Process content specifically for family numbers with their own variables
              let familyMessageContent = campaign.message_content || 'Campaign message';

              // For family numbers, use generic contact variables
              const familyVariables = {
                name: 'Family Member',
                phone: '',
                email: '',
                company: '',
                position: '',
                var1: '', var2: '', var3: '', var4: '', var5: '',
                var6: '', var7: '', var8: '', var9: '', var10: ''
              };

              // Replace contact variables in message content
              for (let i = 1; i <= 10; i++) {
                const varName = `var${i}`;
                const varValue = familyVariables[varName] || '';
                familyMessageContent = familyMessageContent.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
              }

              // Replace common contact fields
              familyMessageContent = familyMessageContent.replace(/\{\{name\}\}/g, familyVariables.name);
              familyMessageContent = familyMessageContent.replace(/\{\{phone\}\}/g, familyVariables.phone);
              familyMessageContent = familyMessageContent.replace(/\{\{email\}\}/g, familyVariables.email);
              familyMessageContent = familyMessageContent.replace(/\{\{company\}\}/g, familyVariables.company);
              familyMessageContent = familyMessageContent.replace(/\{\{position\}\}/g, familyVariables.position);

              // Process content with bulk message features (spintax, random numbers) - use different ID for family to get unique spintax
              const familyCampaignId = campaign.id + 1000000; // Use different numeric ID for family messages to get unique spintax sequence
              familyMessageContent = await this.bulkMessageFeatures.processMessageContent(familyCampaignId, familyMessageContent);


              const familyResult = await this.bulkMessageFeatures.sendToFamilyNumbers(sessionId,
                familyMessageContent,
                campaign.message_type || 'text',
                campaign.id
              );
            }

            // Check if campaign should sleep
            if (await this.bulkMessageFeatures.shouldCampaignSleep(campaign.id)) {
              await this.bulkMessageFeatures.sleepCampaign(campaign.id);
            }
          } catch (error) {
            console.error(`❌ BULK FEATURES ERROR:`, error);
          }
        } else {
        }

        // Delay between messages (longer delay for video messages to prevent disconnection)
        if (i < recipients.length - 1) {
          // Generate random delay between min and max seconds
          const minDelay = campaign.delivery_delay_min || campaign.delivery_delay || 3;
          const maxDelay = campaign.delivery_delay_max || campaign.delivery_delay || 9;

          this.debugLog(`🔍 DELAY DEBUG: Campaign ${campaignId} delay settings from database - min: ${campaign.delivery_delay_min}, max: ${campaign.delivery_delay_max}, legacy: ${campaign.delivery_delay}`);
          this.debugLog(`🔍 DELAY DEBUG: Campaign ${campaignId} calculated delays - minDelay: ${minDelay}, maxDelay: ${maxDelay}`);

          const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
          let delayTime = randomDelay * 1000;

          // For video templates, use minimum 15 seconds delay to prevent device disconnection
          if (isVideoTemplate) {
            delayTime = Math.max(delayTime, 15000); // Minimum 15 seconds for video
            this.debugLog(`📹 Using extended delay of ${delayTime/1000}s for video template`);
          } else {
            this.debugLog(`⏱️ Using random delay of ${delayTime/1000}s (range: ${minDelay}-${maxDelay}s)`);
          }

          const delayStartTime = new Date();
          this.debugLog(`⏰ DELAY DEBUG: Starting delay at ${delayStartTime.toISOString()} - Waiting ${delayTime}ms before next message...`);

          await new Promise(resolve => setTimeout(resolve, delayTime));

          const delayEndTime = new Date();
          const actualDelayMs = delayEndTime.getTime() - delayStartTime.getTime();
          this.debugLog(`✅ DELAY DEBUG: Delay completed at ${delayEndTime.toISOString()} - Actual delay was ${actualDelayMs}ms (expected ${delayTime}ms)`);
        }
      }

      // Check if all messages are processed
      const remainingResponse = await this.databaseService.query(
        'SELECT COUNT(*) as count FROM bulk_campaign_recipients WHERE campaign_id = ? AND status = ?',
        [campaignId, 'pending']
      );

      if (remainingResponse.success && remainingResponse.data[0].count === 0) {
        // Get final counts from recipients table
        const countsResponse = await this.databaseService.query(`
          SELECT
            COUNT(CASE WHEN status IN ('sent', 'delivered') THEN 1 END) as sent_count,
            COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
          FROM bulk_campaign_recipients
          WHERE campaign_id = ?
        `, [campaignId]);

        let sentCount = 0;
        let failedCount = 0;
        if (countsResponse.success && countsResponse.data.length > 0) {
          sentCount = countsResponse.data[0].sent_count || 0;
          failedCount = countsResponse.data[0].failed_count || 0;
        }

        // Mark campaign as completed and update final counts
        await this.databaseService.query(
          'UPDATE bulk_campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP, sent_count = ?, failed_count = ? WHERE id = ?',
          ['completed', campaignId, sentCount, failedCount]
        );

        this.emit('campaign-completed', { campaignId });
      }

    } catch (error) {
      console.error(`❌ Error processing campaign ${campaignId}:`, error);
      console.error(`❌ Error stack:`, error.stack);
      console.error(`❌ Error details:`, {
        message: error.message,
        name: error.name,
        campaignId: campaignId
      });

      // Mark campaign as failed
      await this.databaseService.query(
        'UPDATE bulk_campaigns SET status = ? WHERE id = ?',
        ['failed', campaignId]
      );

      this.emit('campaign-failed', { campaignId, error: error.message });
    } finally {
      this.activeProcesses.delete(campaignId);
    }
  }

  /**
   * Send message to a specific recipient
   */
  async sendMessageToRecipient(campaign, recipient, sessionId, messageIndex = 0, totalMessages = 1) {
    try {
      let phoneNumber = recipient.phone_number;

      // Format phone number
      if (phoneNumber) {
        // Convert to string if it's a number (for pasted numbers)
        phoneNumber = String(phoneNumber).replace(/\D/g, '');
        if (!phoneNumber.startsWith('91') && phoneNumber.length === 10) {
          phoneNumber = '91' + phoneNumber;
        }
        phoneNumber = phoneNumber + '@s.whatsapp.net';
      }

      // Check opt-out status before sending
      if (this.optOutService) {
        const rawPhoneNumber = phoneNumber.replace('@s.whatsapp.net', '');
        const messageType = this.determineMessageType(campaign);

        const complianceCheck = await this.optOutService.checkComplianceBeforeSending(
          rawPhoneNumber,
          messageType,
          campaign.id
        );

        if (!complianceCheck.canSend) {

          // Update recipient status to skipped (use recipient.id not contact_id for pasted numbers)
          await this.databaseService.run(`
            UPDATE bulk_campaign_recipients
            SET status = 'skipped', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [complianceCheck.reason, recipient.id]);

          return {
            success: false,
            error: complianceCheck.reason,
            skipped: true,
            complianceStatus: complianceCheck.complianceStatus
          };
        }
      }

      const messageStartTime = new Date();

      let result;
      let processedContent = null; // Track processed content for family numbers

      // Retry logic for message sending
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 5000; // 5 seconds - give time for reconnection
      let retryCount = 0;
      let lastError = null;

      while (retryCount <= MAX_RETRIES) {
        try {
          // Check session status before each attempt
          const sessionStatus = await this.whatsappService.getSessionStatus(sessionId);
          if (!sessionStatus || sessionStatus.status !== 'connected' || !sessionStatus.isLoggedIn) {
            throw new Error(`Session ${sessionId} not connected (status: ${sessionStatus?.status}, logged in: ${sessionStatus?.isLoggedIn})`);
          }

      // Send message based on type
      if (campaign.template_id) {

        // Use message processor service with contact variables
        const templateVariables = {
          user_phone: phoneNumber.replace('@s.whatsapp.net', ''),
          campaign_name: campaign.name,
          name: recipient.name || '',
          phone: recipient.phone_number || '',
          email: recipient.email || '',
          company: recipient.company || '',
          position: recipient.position || '',
          var1: recipient.var1 || '',
          var2: recipient.var2 || '',
          var3: recipient.var3 || '',
          var4: recipient.var4 || '',
          var5: recipient.var5 || '',
          var6: recipient.var6 || '',
          var7: recipient.var7 || '',
          var8: recipient.var8 || '',
          var9: recipient.var9 || '',
          var10: recipient.var10 || ''
        };


        // Get the template data
        const template = await this.databaseService.get(
          'SELECT * FROM message_templates WHERE id = ?',
          [campaign.template_id]
        );

        if (template) {

          // Process content with bulk message features (spintax, random numbers) if needed
          let processedVariables = templateVariables;
          if (this.bulkMessageFeatures && template.content) {
            // Apply bulk features to template content first
            const processedContent = await this.bulkMessageFeatures.processMessageContent(campaign.id, template.content);
            // Update the template content temporarily for this send
            template.content = processedContent;
          }


          // Use sendTemplateMessage for proper attachment handling
          result = await this.whatsappService.sendTemplateMessage(
            sessionId,
            phoneNumber,
            template,
            processedVariables
          );
        } else {
          result = { success: false, error: `Template not found: ${campaign.template_id}` };
        }
      } else {
        // Handle text message with optional attachment and variable replacement
        let messageContent = campaign.message_content || '';

        this.debugLog('🔍 SCHEDULER - Message content before replacement:', messageContent);
        this.debugLog('🔍 SCHEDULER - Recipient data for replacement:', {
          name: recipient.name,
          var1: recipient.var1,
          var2: recipient.var2,
          var3: recipient.var3
        });

        // Replace contact variables in message content
        for (let i = 1; i <= 10; i++) {
          const varName = `var${i}`;
          const varValue = recipient[varName] || '';
          messageContent = messageContent.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
        }

        // Replace common contact fields
        messageContent = messageContent.replace(/\{\{name\}\}/g, recipient.name || '');
        messageContent = messageContent.replace(/\{\{phone\}\}/g, recipient.phone_number || '');
        messageContent = messageContent.replace(/\{\{email\}\}/g, recipient.email || '');
        messageContent = messageContent.replace(/\{\{company\}\}/g, recipient.company || '');
        messageContent = messageContent.replace(/\{\{position\}\}/g, recipient.position || '');

        this.debugLog('🔍 SCHEDULER - Message content after replacement:', messageContent);

        // Process content with bulk message features (spintax, random numbers)
        if (this.bulkMessageFeatures) {
          messageContent = await this.bulkMessageFeatures.processMessageContent(campaign.id, messageContent);
        }

        // Store processed content for family numbers
        processedContent = messageContent;

        this.debugLog('🔍 SCHEDULER - Message content after bulk features processing:', messageContent);

        let attachmentData = null;
        try {
          if (campaign.attachment_data) {
            attachmentData = JSON.parse(campaign.attachment_data);
          }
        } catch (e) {
        }

        if (attachmentData && attachmentData.file && attachmentData.type) {
          result = await this.whatsappService.sendMessage(
            sessionId,
            phoneNumber,
            {
              [attachmentData.type]: { url: attachmentData.file },
              caption: messageContent
            },
            attachmentData.type
          );
        } else {
          result = await this.whatsappService.sendMessage(
            sessionId,
            phoneNumber,
            messageContent,
            'text'
          );
        }
      }

          // If message sent successfully, break out of retry loop
          if (result && result.success) {
            break;
          } else {
            lastError = result?.error || 'Unknown error';
            throw new Error(lastError);
          }

        } catch (error) {
          lastError = error.message;
          console.error(`❌ Attempt ${retryCount + 1}/${MAX_RETRIES + 1} failed for ${phoneNumber}: ${error.message}`);

          // Check if this is a retryable error
          const isRetryable = this.isRetryableError(error.message);

          if (!isRetryable || retryCount >= MAX_RETRIES) {
            result = { success: false, error: lastError };
            break;
          }

          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          }
        }
      }

      // Update recipient status
      if (result && result.success) {
        await this.databaseService.query(
          'UPDATE bulk_campaign_recipients SET status = ?, sent_at = CURRENT_TIMESTAMP, message_id = ? WHERE id = ?',
          ['sent', result.messageId || null, recipient.id]
        );

        // Log to message history
        await this.databaseService.query(`
          INSERT INTO message_history (
            session_id, contact_phone, message_id, direction, message_type,
            content, timestamp, status, campaign_id, template_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
          sessionId,
          recipient.phone_number,
          result.messageId || null,
          'outgoing',
          campaign.message_type || 'text',
          campaign.message_content,
          new Date().toISOString(),
          'sent',
          campaign.id,
          campaign.template_id || null
        ]);

        const messageEndTime = new Date();
        const messageDuration = messageEndTime.getTime() - messageStartTime.getTime();
        return { ...result, processedContent }; // Return both result and processed content
      } else {
        await this.databaseService.query(
          'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
          ['failed', lastError || 'Unknown error', recipient.id]
        );
        return { success: false, error: lastError, processedContent }; // Return error with processed content
      }

    } catch (error) {
      console.error(`❌ Error sending message to recipient ${recipient.id}:`, error);
      await this.databaseService.query(
        'UPDATE bulk_campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
        ['failed', error.message, recipient.id]
      );
      return { success: false, error: error.message, processedContent: null }; // Return error with processed content
    }
  }



  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeProcesses: this.activeProcesses.size,
      checkInterval: this.checkInterval
    };
  }

  /**
   * Manually trigger a campaign check
   */
  async triggerCheck() {
    this.debugLog('🔄 Manually triggering campaign check...');
    await this.checkScheduledCampaigns();
  }

  /**
   * Determine message type based on campaign properties
   * @private
   */
  determineMessageType(campaign) {
    // Check campaign name or properties to determine message type
    const campaignName = (campaign.name || '').toLowerCase();

    if (campaignName.includes('promotional') || campaignName.includes('offer') || campaignName.includes('sale')) {
      return 'promotional';
    } else if (campaignName.includes('reminder') || campaignName.includes('follow-up')) {
      return 'reminder';
    } else if (campaignName.includes('transactional') || campaignName.includes('receipt') || campaignName.includes('confirmation')) {
      return 'transactional';
    } else {
      // Default to marketing for bulk campaigns
      return 'marketing';
    }
  }

  /**
   * Check if a session is usable for sending messages (more robust than simple status check)
   */
  async isSessionUsableForSending(sessionId) {
    try {
      const sessionStatus = await this.whatsappService.getSessionStatus(sessionId);

      // If no session status, it's not usable
      if (!sessionStatus) {
        return { usable: false, reason: 'Session status unavailable', permanent: true };
      }

      // Check if session is connected and logged in (ideal state)
      if (sessionStatus.status === 'connected' && sessionStatus.isLoggedIn === true) {
        return { usable: true, reason: 'Session fully connected' };
      }

      // Check if session is connecting but has been logged in before (temporary state)
      if (sessionStatus.status === 'connecting' && sessionStatus.phoneNumber) {
        return { usable: true, reason: 'Session reconnecting but previously authenticated' };
      }

      // Check if session has user object (indicates successful authentication)
      const session = this.whatsappService.sessions?.get(sessionId);
      if (session && session.user && session.user.id) {
        return { usable: true, reason: 'Session has authenticated user' };
      }

      // Check WebSocket state as fallback
      if (session && session.ws && session.ws.readyState === 1) { // 1 = OPEN
        return { usable: true, reason: 'Session has open WebSocket connection' };
      }

      // If status is disconnected or logged out, it's permanently unusable
      if (sessionStatus.status === 'disconnected' || sessionStatus.isLoggedIn === false) {
        return { usable: false, reason: `Session ${sessionStatus.status}, logged in: ${sessionStatus.isLoggedIn}`, permanent: true };
      }

      // For other states (like qr_ready), consider it temporarily unusable
      return { usable: false, reason: `Session in ${sessionStatus.status} state`, permanent: false };

    } catch (error) {
      console.error(`Error checking session ${sessionId} usability:`, error);
      return { usable: false, reason: `Error checking session: ${error.message}`, permanent: false };
    }
  }

  /**
   * Check if an error indicates socket disconnection (should pause campaign)
   * @private
   */
  isSocketDisconnectionError(errorMessage) {
    if (!errorMessage) return false;

    const errorLower = errorMessage.toLowerCase();

    // Don't treat "reconnecting" as disconnection - it's a temporary state
    if (errorLower.includes('reconnecting') || errorLower.includes('status: reconnecting')) {
      return false;
    }

    // Patterns that indicate socket disconnection requiring manual intervention
    const disconnectionPatterns = [
      'session.*not found',
      'socket.*not found',
      'logged out',
      'connection closed',
      'connection lost',
      'device removed',
      'session ended',
      'status: disconnected'
    ];

    return disconnectionPatterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(errorLower);
    });
  }

  /**
   * Check if an error is retryable (temporary network/connection issue)
   * @private
   */
  isRetryableError(errorMessage) {
    if (!errorMessage) return false;

    const errorLower = errorMessage.toLowerCase();

    // Patterns that indicate retryable errors (but not socket disconnection)
    const retryablePatterns = [
      'timeout',
      'timed out',
      'network',
      'econnreset',
      'enotfound',
      'etimedout',
      'temporarily unavailable',
      'service unavailable',
      '503',
      'reconnecting',
      'status: reconnecting',
      'connecting',
      'status: connecting'
    ];

    // Don't retry if it's a socket disconnection
    if (this.isSocketDisconnectionError(errorMessage)) {
      return false;
    }

    return retryablePatterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(errorLower);
    });
  }

  /**
   * Check if an error message indicates a session is permanently blocked (not just temporarily disconnected)
   * @private
   */
  isPermanentlyBlockedError(errorMessage) {
    if (!errorMessage) return false;

    const errorLower = errorMessage.toLowerCase();

    // Only patterns that indicate permanent blocking/banning
    const permanentBlockingPatterns = [
      // Permanent blocking/banning patterns
      'banned',
      'restricted',
      'suspended',
      'account limited',
      'permanently banned',
      'account suspended',
      'account blocked',
      'number blocked',
      'phone blocked',
      'spam',
      'violation',
      'policy',
      'forbidden',
      'unauthorized',
      'access denied',
      'not allowed',
      'permission denied',

      // WhatsApp specific permanent blocking messages
      'this account has been banned',
      'account has been restricted',
      'your account is temporarily banned',
      'account violation',
      'business account restricted',
      'recipient unavailable',
      'number not on whatsapp',
      'invalid number',

      // Authentication failures (permanent until re-auth)
      'authentication failed',
      'invalid session',
      'session expired',
      'bad session',
      'device removed',
      'logged out',
      'multidevice mismatch'
    ];

    return permanentBlockingPatterns.some(pattern => errorLower.includes(pattern));
  }

  /**
   * Check if an error message indicates a session is blocked or disconnected (legacy method - now more conservative)
   * @private
   */
  isSessionBlockedError(errorMessage) {
    if (!errorMessage) return false;

    const errorLower = errorMessage.toLowerCase();

    // Comprehensive patterns that indicate a session should be skipped
    const blockingPatterns = [
      // Blocking/Banning patterns
      'blocked',
      'banned',
      'restricted',
      'suspended',
      'account limited',
      'temporarily banned',
      'permanently banned',
      'account suspended',
      'account blocked',
      'number blocked',
      'phone blocked',
      'spam',
      'violation',
      'policy',
      'forbidden',
      'unauthorized',
      'access denied',
      'not allowed',
      'permission denied',

      // WhatsApp specific blocking messages
      'this account has been banned',
      'account has been restricted',
      'your account is temporarily banned',
      'account violation',
      'business account restricted',
      'message could not be sent',
      'recipient unavailable',
      'number not on whatsapp',
      'invalid number',

      // Rate limiting patterns
      'rate limit',
      'too many requests',
      'rate exceeded',
      'quota exceeded',
      'throttled',

      // Connection/Session issues
      'service unavailable',
      'connection refused',
      'disconnected',
      'session closed',
      'session ended',
      'session terminated',
      'authentication failed',
      'invalid session',
      'session expired',
      'session not found',
      'session invalid',
      'not connected',
      'connection lost',
      'connection closed',
      'connection failed',
      'connection timeout',
      'timed out',
      'timeout',
      'network error',
      'socket closed',
      'socket error',
      'websocket closed',
      'websocket error',

      // WhatsApp specific disconnection reasons
      'bad session',
      'restart required',
      'device removed',
      'logged out',
      'multidevice mismatch',
      'stream errored',
      'conflict',
      'connection update',
      'qr timeout',
      'pairing timeout',

      // General failure patterns
      'unavailable',
      'unreachable',
      'failed to send',
      'send failed',
      'delivery failed',
      'message failed',
      'cannot send',
      'unable to send',
      'not available',
      'offline',
      'inactive'
    ];

    return blockingPatterns.some(pattern => errorLower.includes(pattern));
  }
}

module.exports = CampaignSchedulerService;
