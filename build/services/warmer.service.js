const EventEmitter = require('events');

/**
 * Warmer Service
 * Manages number warming campaigns by simulating natural conversations between connected devices
 */
class WarmerService extends EventEmitter {
  constructor(databaseService, whatsappService) {
    super();
    this.databaseService = databaseService;
    this.whatsappService = whatsappService;
    this.activeCampaigns = new Map(); // campaignId -> { intervalId, status }
    this.log('Warmer Service initialized');
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
  }

  /**
   * Create a new warmer campaign
   */
  async createCampaign(campaignData) {
    try {
      const {
        name,
        description,
        session_ids, // Array of session IDs
        messages, // Array of message lines
        delay_min,
        delay_max,
        duration_minutes,
        template_id // Optional: use template instead of inline messages
      } = campaignData;

      // Validate
      if (!name || !session_ids || session_ids.length < 2) {
        return { success: false, error: 'Campaign requires a name and at least 2 sessions' };
      }

      if (!template_id && (!messages || messages.length === 0)) {
        return { success: false, error: 'Campaign requires either messages or a template' };
      }

      const result = await this.databaseService.query(
        `INSERT INTO warmer_campaigns (
          name, description, session_ids, messages, delay_min, delay_max,
          duration_minutes, template_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          name,
          description || '',
          JSON.stringify(session_ids),
          JSON.stringify(messages || []),
          delay_min || 30,
          delay_max || 120,
          duration_minutes || 60,
          template_id || null
        ]
      );

      if (result.success) {
        this.log(`Campaign created: ${name} (ID: ${result.lastID})`);
        return { success: true, campaignId: result.lastID };
      }

      return { success: false, error: 'Failed to create campaign' };
    } catch (error) {
      this.log(`Error creating campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all campaigns
   */
  async getCampaigns() {
    try {
      const result = await this.databaseService.query(
        `SELECT * FROM warmer_campaigns ORDER BY created_at DESC`
      );

      if (result.success) {
        const campaigns = result.data.map(campaign => ({
          ...campaign,
          session_ids: JSON.parse(campaign.session_ids || '[]'),
          messages: JSON.parse(campaign.messages || '[]')
        }));
        return { success: true, data: campaigns };
      }

      return { success: false, error: 'Failed to fetch campaigns' };
    } catch (error) {
      this.log(`Error fetching campaigns: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get campaign by ID
   */
  async getCampaign(campaignId) {
    try {
      const result = await this.databaseService.query(
        `SELECT * FROM warmer_campaigns WHERE id = ?`,
        [campaignId]
      );

      if (result.success && result.data.length > 0) {
        const campaign = {
          ...result.data[0],
          session_ids: JSON.parse(result.data[0].session_ids || '[]'),
          messages: JSON.parse(result.data[0].messages || '[]')
        };
        return { success: true, data: campaign };
      }

      return { success: false, error: 'Campaign not found' };
    } catch (error) {
      this.log(`Error fetching campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Update campaign
   */
  async updateCampaign(campaignId, updates) {
    try {
      const {
        name,
        description,
        session_ids,
        messages,
        delay_min,
        delay_max,
        duration_minutes,
        template_id
      } = updates;

      const result = await this.databaseService.query(
        `UPDATE warmer_campaigns SET
          name = ?, description = ?, session_ids = ?, messages = ?,
          delay_min = ?, delay_max = ?, duration_minutes = ?, template_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          name,
          description || '',
          JSON.stringify(session_ids),
          JSON.stringify(messages || []),
          delay_min,
          delay_max,
          duration_minutes,
          template_id || null,
          campaignId
        ]
      );

      if (result.success) {
        this.log(`Campaign updated: ${campaignId}`);
        return { success: true };
      }

      return { success: false, error: 'Failed to update campaign' };
    } catch (error) {
      this.log(`Error updating campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete campaign
   */
  async deleteCampaign(campaignId) {
    try {
      // Stop campaign if running
      await this.stopCampaign(campaignId);

      const result = await this.databaseService.query(
        `DELETE FROM warmer_campaigns WHERE id = ?`,
        [campaignId]
      );

      if (result.success) {
        this.log(`Campaign deleted: ${campaignId}`);
        return { success: true };
      }

      return { success: false, error: 'Failed to delete campaign' };
    } catch (error) {
      this.log(`Error deleting campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Start a warmer campaign
   */
  async startCampaign(campaignId) {
    try {
      // Check if already running
      if (this.activeCampaigns.has(campaignId)) {
        return { success: false, error: 'Campaign is already running' };
      }

      // Get campaign details
      const campaignResult = await this.getCampaign(campaignId);
      if (!campaignResult.success) {
        return { success: false, error: 'Campaign not found' };
      }

      const campaign = campaignResult.data;

      // Validate sessions are connected
      const connectedSessions = [];
      for (const sessionId of campaign.session_ids) {
        const session = this.whatsappService.sessions.get(sessionId);
        if (session && this.whatsappService.sessionStates.get(sessionId)?.status === 'connected') {
          connectedSessions.push(sessionId);
        }
      }

      if (connectedSessions.length < 2) {
        return { success: false, error: 'At least 2 sessions must be connected to start warming' };
      }

      // Get messages (from template or inline)
      let messages = campaign.messages;
      if (campaign.template_id) {
        const templateResult = await this.databaseService.query(
          `SELECT * FROM warmer_templates WHERE id = ?`,
          [campaign.template_id]
        );
        if (templateResult.success && templateResult.data.length > 0) {
          messages = JSON.parse(templateResult.data[0].messages || '[]');
        }
      }

      if (messages.length === 0) {
        return { success: false, error: 'No messages configured for this campaign' };
      }

      // Update status to running
      await this.databaseService.query(
        `UPDATE warmer_campaigns SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [campaignId]
      );

      // Start the warming process
      this.runWarmerCampaign(campaignId, campaign, connectedSessions, messages);

      this.log(`Campaign started: ${campaign.name} (ID: ${campaignId})`);
      return { success: true, message: 'Campaign started successfully' };
    } catch (error) {
      this.log(`Error starting campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Run the warmer campaign - sends messages between sessions
   *
   * Sequencing Logic:
   * - For 2 devices: Simple alternating pattern (A→B, B→A, A→B, B→A)
   * - For 3+ devices: Rotates through all devices as senders, with random varied receivers
   *   Example with 3 devices (A, B, C):
   *   - A→B, B→C, C→A, A→C, B→A, C→B (all devices participate equally)
   *
   * This ensures all numbers get warmed up evenly and creates natural conversation patterns.
   */
  async runWarmerCampaign(campaignId, campaign, sessions, messages) {
    const startTime = Date.now();
    const durationMs = campaign.duration_minutes * 60 * 1000;
    let messageIndex = 0;
    let messagesSent = 0;

    // Initialize conversation sequence
    // For 2 devices: Simple alternating pattern (A→B, B→A, A→B, B→A)
    // For 3+ devices: Rotate through all devices with varied receivers
    let currentSenderIndex = Math.floor(Math.random() * sessions.length);
    let lastReceiverIndex = -1;

    const sendNextMessage = async () => {
      try {
        // Check if campaign should stop
        const elapsed = Date.now() - startTime;
        if (elapsed >= durationMs) {
          this.log(`Campaign ${campaignId} completed (duration reached)`);
          await this.stopCampaign(campaignId);
          return;
        }

        // Check if campaign was manually stopped
        const statusCheck = await this.databaseService.query(
          `SELECT status FROM warmer_campaigns WHERE id = ?`,
          [campaignId]
        );
        if (!statusCheck.success || statusCheck.data[0]?.status !== 'running') {
          this.log(`Campaign ${campaignId} stopped`);
          return;
        }

        // Get current message
        const message = messages[messageIndex % messages.length];
        messageIndex++;

        // Determine sender and receiver based on number of sessions
        let senderSessionId, receiverSessionId, currentReceiverIndex;

        if (sessions.length === 2) {
          // For 2 devices: Simple alternating pattern
          senderSessionId = sessions[currentSenderIndex];
          currentReceiverIndex = currentSenderIndex === 0 ? 1 : 0;
          receiverSessionId = sessions[currentReceiverIndex];

          // Swap for next message
          currentSenderIndex = currentReceiverIndex;
        } else {
          // For 3+ devices: More natural conversation pattern
          senderSessionId = sessions[currentSenderIndex];

          // Select a random receiver that is different from sender and preferably different from last receiver
          const availableReceivers = sessions
            .map((_, idx) => idx)
            .filter(idx => idx !== currentSenderIndex);

          // Try to avoid using the same receiver twice in a row for variety
          if (availableReceivers.length > 1 && lastReceiverIndex !== -1) {
            const filteredReceivers = availableReceivers.filter(idx => idx !== lastReceiverIndex);
            if (filteredReceivers.length > 0) {
              currentReceiverIndex = filteredReceivers[Math.floor(Math.random() * filteredReceivers.length)];
            } else {
              currentReceiverIndex = availableReceivers[Math.floor(Math.random() * availableReceivers.length)];
            }
          } else {
            currentReceiverIndex = availableReceivers[Math.floor(Math.random() * availableReceivers.length)];
          }

          receiverSessionId = sessions[currentReceiverIndex];
          lastReceiverIndex = currentReceiverIndex;

          // Rotate sender to next device for next message
          currentSenderIndex = (currentSenderIndex + 1) % sessions.length;
        }

        // Get receiver's phone number from database
        const receiverQuery = await this.databaseService.query(
          `SELECT phone_number FROM whatsapp_sessions WHERE session_id = ?`,
          [receiverSessionId]
        );

        if (!receiverQuery.success || !receiverQuery.data[0]?.phone_number) {
          this.log(`Receiver session ${receiverSessionId} phone number not available, skipping message`, 'warn');
        } else {
          // Send message
          const phoneNumber = receiverQuery.data[0].phone_number.replace(/\D/g, '');
          const jid = `${phoneNumber}@s.whatsapp.net`;

          this.log(`Sending warmer message from ${senderSessionId} to ${receiverSessionId} (${phoneNumber}): "${message}"`);

          const result = await this.whatsappService.sendMessage(senderSessionId, jid, message);

          if (result.success) {
            messagesSent++;

            // Log activity
            await this.databaseService.query(
              `INSERT INTO warmer_logs (
                campaign_id, sender_session_id, receiver_session_id, message, status, created_at
              ) VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP)`,
              [campaignId, senderSessionId, receiverSessionId, message]
            );

            // Update campaign stats
            await this.databaseService.query(
              `UPDATE warmer_campaigns SET messages_sent = messages_sent + 1 WHERE id = ?`,
              [campaignId]
            );

            this.emit('message_sent', {
              campaignId,
              senderSessionId,
              receiverSessionId,
              message,
              messagesSent
            });
          } else {
            this.log(`Failed to send message: ${result.error}`, 'error');

            await this.databaseService.query(
              `INSERT INTO warmer_logs (
                campaign_id, sender_session_id, receiver_session_id, message, status, error_message, created_at
              ) VALUES (?, ?, ?, ?, 'failed', ?, CURRENT_TIMESTAMP)`,
              [campaignId, senderSessionId, receiverSessionId, message, result.error]
            );
          }
        }

        // Schedule next message with random delay
        const delaySeconds = Math.floor(
          Math.random() * (campaign.delay_max - campaign.delay_min + 1) + campaign.delay_min
        );

        this.log(`Next message in ${delaySeconds} seconds`);

        const timeoutId = setTimeout(sendNextMessage, delaySeconds * 1000);

        // Store timeout ID for this campaign
        if (this.activeCampaigns.has(campaignId)) {
          this.activeCampaigns.get(campaignId).timeoutId = timeoutId;
        }

      } catch (error) {
        this.log(`Error in warmer campaign ${campaignId}: ${error.message}`, 'error');
        await this.stopCampaign(campaignId);
      }
    };

    // Store campaign info
    this.activeCampaigns.set(campaignId, {
      status: 'running',
      startTime,
      durationMs,
      messagesSent: 0
    });

    // Start sending messages
    sendNextMessage();
  }

  /**
   * Stop a running campaign
   */
  async stopCampaign(campaignId) {
    try {
      if (this.activeCampaigns.has(campaignId)) {
        const campaign = this.activeCampaigns.get(campaignId);

        // Clear timeout if exists
        if (campaign.timeoutId) {
          clearTimeout(campaign.timeoutId);
        }

        this.activeCampaigns.delete(campaignId);
      }

      // Update status in database
      await this.databaseService.query(
        `UPDATE warmer_campaigns SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [campaignId]
      );

      this.log(`Campaign stopped: ${campaignId}`);
      this.emit('campaign_stopped', { campaignId });

      return { success: true, message: 'Campaign stopped successfully' };
    } catch (error) {
      this.log(`Error stopping campaign: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }
  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId) {
    try {
      const result = await this.databaseService.query(
        `SELECT
          COUNT(*) as total_messages,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_messages
        FROM warmer_logs WHERE campaign_id = ?`,
        [campaignId]
      );

      if (result.success && result.data.length > 0) {
        return { success: true, data: result.data[0] };
      }

      return { success: false, error: 'Failed to fetch stats' };
    } catch (error) {
      this.log(`Error fetching campaign stats: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get campaign logs
   */
  async getCampaignLogs(campaignId, limit = 100) {
    try {
      const result = await this.databaseService.query(
        `SELECT * FROM warmer_logs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?`,
        [campaignId, limit]
      );

      if (result.success) {
        return { success: true, data: result.data };
      }

      return { success: false, error: 'Failed to fetch logs' };
    } catch (error) {
      this.log(`Error fetching campaign logs: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get active campaigns count
   */
  getActiveCampaignsCount() {
    return this.activeCampaigns.size;
  }

  /**
   * Stop all campaigns
   */
  async stopAllCampaigns() {
    const campaignIds = Array.from(this.activeCampaigns.keys());
    for (const campaignId of campaignIds) {
      await this.stopCampaign(campaignId);
    }
    return { success: true, stopped: campaignIds.length };
  }

  // ===== WARMER TEMPLATES =====

  /**
   * Create warmer template
   */
  async createTemplate(templateData) {
    try {
      const { name, description, messages } = templateData;

      if (!name || !messages || messages.length === 0) {
        return { success: false, error: 'Template requires a name and messages' };
      }

      const result = await this.databaseService.query(
        `INSERT INTO warmer_templates (name, description, messages, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [name, description || '', JSON.stringify(messages)]
      );

      if (result.success) {
        return { success: true, templateId: result.lastID };
      }

      return { success: false, error: 'Failed to create template' };
    } catch (error) {
      this.log(`Error creating template: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all templates
   */
  async getTemplates() {
    try {
      const result = await this.databaseService.query(
        `SELECT * FROM warmer_templates ORDER BY created_at DESC`
      );

      if (result.success) {
        const templates = result.data.map(template => ({
          ...template,
          messages: JSON.parse(template.messages || '[]')
        }));
        return { success: true, data: templates };
      }

      return { success: false, error: 'Failed to fetch templates' };
    } catch (error) {
      this.log(`Error fetching templates: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Update template
   */
  async updateTemplate(templateId, updates) {
    try {
      const { name, description, messages } = updates;

      const result = await this.databaseService.query(
        `UPDATE warmer_templates SET name = ?, description = ?, messages = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [name, description || '', JSON.stringify(messages), templateId]
      );

      if (result.success) {
        return { success: true };
      }

      return { success: false, error: 'Failed to update template' };
    } catch (error) {
      this.log(`Error updating template: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete template
   */
  async deleteTemplate(templateId) {
    try {
      const result = await this.databaseService.query(
        `DELETE FROM warmer_templates WHERE id = ?`,
        [templateId]
      );

      if (result.success) {
        return { success: true };
      }

      return { success: false, error: 'Failed to delete template' };
    } catch (error) {
      this.log(`Error deleting template: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }
}

module.exports = WarmerService;
