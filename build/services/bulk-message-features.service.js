const SpintaxService = require('./spintax.service');

/**
 * Bulk Message Features Service
 * Handles all advanced bulk messaging features: spintax, random numbers, family numbers, hook numbers, sleep timing
 */
class BulkMessageFeaturesService {
  constructor(databaseService = null, whatsappService = null) {
    this.databaseService = databaseService;
    this.whatsappService = whatsappService;
    this.spintaxService = new SpintaxService(databaseService);
    this.campaignSleepState = new Map(); // Track sleep state for campaigns
    // Message counts are now stored in database (campaign_message_counts table)
  }

  /**
   * Get bulk message settings
   */
  async getSettings() {
    try {
      const response = await this.databaseService.query(
        'SELECT * FROM bulk_message_settings ORDER BY id DESC LIMIT 1'
      );

      if (response.success && response.data.length > 0) {
        const settings = response.data[0];
        // Parse JSON fields
        settings.family_numbers = JSON.parse(settings.family_numbers || '[]');
        return settings;
      }

      // Return default settings if none exist
      return {
        spintax_enabled: true,
        random_enabled: true,
        random_prefix: 'REF',
        family_numbers_enabled: true,
        family_numbers: [],
        family_message_interval: 50,
        hook_number_enabled: true,
        hook_number: '',
        sleep_timing_enabled: true,
        sleep_after_messages: 50,
        sleep_duration_seconds: 30,
        delivery_delay_min: 3,
        delivery_delay_max: 9,
        allow_unverified_contacts: false
      };
    } catch (error) {
      console.error('Error getting bulk message settings:', error);
      return null;
    }
  }

  /**
   * Update bulk message settings
   */
  async updateSettings(settings) {
    try {
      // Ensure family_numbers is JSON string
      if (Array.isArray(settings.family_numbers)) {
        settings.family_numbers = JSON.stringify(settings.family_numbers);
      }

      const response = await this.databaseService.query(
        `UPDATE bulk_message_settings SET
         spintax_enabled = ?, random_enabled = ?, random_prefix = ?,
         family_numbers_enabled = ?, family_numbers = ?, family_message_interval = ?,
         hook_number_enabled = ?, hook_number = ?, sleep_timing_enabled = ?,
         sleep_after_messages = ?, sleep_duration_seconds = ?,
         delivery_delay_min = ?, delivery_delay_max = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT id FROM bulk_message_settings ORDER BY id DESC LIMIT 1)`,
        [
          settings.spintax_enabled ? 1 : 0,
          settings.random_enabled ? 1 : 0,
          settings.random_prefix || 'LW',
          settings.family_numbers_enabled ? 1 : 0,
          settings.family_numbers,
          settings.family_message_interval || 50,
          settings.hook_number_enabled ? 1 : 0,
          settings.hook_number || '',
          settings.sleep_timing_enabled ? 1 : 0,
          settings.sleep_after_messages || 50,
          settings.sleep_duration_seconds || 30,
          settings.delivery_delay_min || 3,
          settings.delivery_delay_max || 9
        ]
      );

      return response;
    } catch (error) {
      console.error('Error updating bulk message settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process message content with all features (spintax, random numbers)
   */
  async processMessageContent(campaignId, content) {
    try {
      const settings = await this.getSettings();
      if (!settings) return content;

      let processedContent = content;

      // 1. Process Spintax
      if (settings.spintax_enabled) {
        processedContent = await this.spintaxService.processMessageContent(campaignId, processedContent);
      }

      // 2. Process Random Numbers
      if (settings.random_enabled) {
        processedContent = this.processRandomNumbers(processedContent, settings.random_prefix);
      }

      return processedContent;
    } catch (error) {
      console.error('Error processing message content:', error);
      return content;
    }
  }

  /**
   * Process random number placeholders
   */
  processRandomNumbers(content, prefix = 'REF') {
    if (!content || typeof content !== 'string') {
      return content;
    }

    // Replace {{random}} and [random] with random numbers
    const randomPattern = /(\{\{random\}\}|\[random\])/gi;

    return content.replace(randomPattern, () => {
      const randomNum = Math.floor(Math.random() * 900000) + 100000; // 6-digit random number
      return `${prefix}${randomNum}`;
    });
  }

  /**
   * Check if family numbers should receive the message
   */
  async shouldSendToFamilyNumbers(campaignId, messageCount) {
    try {
      const settings = await this.getSettings();


      if (!settings || !settings.family_numbers_enabled || settings.family_numbers.length === 0) {
        return false;
      }

      if (!this.databaseService) {
        const shouldSend = messageCount > 0 && messageCount % settings.family_message_interval === 0;
        return shouldSend;
      }

      // Get the last family send count from database
      const result = await this.databaseService.query(
        'SELECT last_family_send_count FROM campaign_message_counts WHERE campaign_id = ?',
        [campaignId]
      );

      let lastFamilySendCount = 0;
      if (result.success && result.data.length > 0) {
        lastFamilySendCount = result.data[0].last_family_send_count || 0;
      }

      // Check if we should send to family numbers
      const messagesSinceLastFamily = messageCount - lastFamilySendCount;
      const shouldSend = messagesSinceLastFamily >= settings.family_message_interval;


      // Additional check: only send if we haven't already sent for this exact message count
      if (shouldSend && lastFamilySendCount === messageCount) {
        return false;
      }

      return shouldSend;
    } catch (error) {
      console.error('❌ [Family Check] Error checking family numbers:', error);
      return false;
    }
  }

  /**
   * Send message to family numbers
   */
  async sendToFamilyNumbers(sessionId, content, messageType = 'text', campaignId = null) {
    try {
      const settings = await this.getSettings();


      if (!settings || !settings.family_numbers_enabled || settings.family_numbers.length === 0) {
        return { success: true, sent: 0 };
      }


      let sentCount = 0;
      const results = [];

      for (const familyNumber of settings.family_numbers) {
        try {

          // Format the number properly - remove all non-digit characters
          // Family numbers should already include country code
          let formattedNumber = familyNumber.replace(/[^\d]/g, '');

          // If number doesn't look like it has a country code (too short), skip it
          if (formattedNumber.length < 10) {
            continue;
          }

          const jid = `${formattedNumber}@s.whatsapp.net`;

          // Prepare content based on message type
          let messageContent;
          if (messageType === 'text') {
            messageContent = { text: content };
          } else {
            messageContent = content;
          }


          const result = await this.whatsappService.sendMessage(
            sessionId,
            jid,
            messageContent,
            messageType
          );


          if (result.success) {
            sentCount++;
          } else {
            console.error(`❌ [Family Send] Failed to send to ${familyNumber}:`, result.error);
          }

          results.push({ number: familyNumber, result });

          // Small delay between family messages
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`❌ [Family Send] Error sending to family number ${familyNumber}:`, error);
          results.push({ number: familyNumber, error: error.message });
        }
      }

      // Update the last family send count in database
      if (campaignId && this.databaseService && sentCount > 0) {
        try {
          const currentCount = await this.getMessageCount(campaignId);

          // Update the last family send count using SQLite compatible syntax
          const updateResult = await this.databaseService.query(`
            UPDATE campaign_message_counts
            SET last_family_send_count = ?, updated_at = CURRENT_TIMESTAMP
            WHERE campaign_id = ?
          `, [currentCount, campaignId]);

        } catch (error) {
          console.error('Error updating last family send count:', error);
        }
      }

      return { success: true, sent: sentCount, results };
    } catch (error) {
      console.error('Error sending to family numbers:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if campaign should sleep
   */
  async shouldCampaignSleep(campaignId) {
    try {
      const settings = await this.getSettings();

      if (!settings || !settings.sleep_timing_enabled) {
        return false;
      }

      const currentCount = await this.getMessageCount(campaignId);
      const shouldSleep = currentCount > 0 && currentCount % settings.sleep_after_messages === 0;


      return shouldSleep;
    } catch (error) {
      console.error('Error checking campaign sleep:', error);
      return false;
    }
  }

  /**
   * Sleep campaign for specified duration
   */
  async sleepCampaign(campaignId) {
    try {
      const settings = await this.getSettings();
      if (!settings || !settings.sleep_timing_enabled) {
        return;
      }

      const sleepDuration = settings.sleep_duration_seconds * 1000;
      const currentTime = new Date().toLocaleTimeString();


      this.campaignSleepState.set(campaignId, true);

      // Add a countdown for better visibility
      const startTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, sleepDuration));
      const endTime = Date.now();
      const actualSleepTime = endTime - startTime;

      this.campaignSleepState.delete(campaignId);
      const wakeTime = new Date().toLocaleTimeString();
    } catch (error) {
      console.error('Error sleeping campaign:', error);
      this.campaignSleepState.delete(campaignId); // Clean up on error
    }
  }

  /**
   * Increment message count for campaign (persistent storage)
   */
  async incrementMessageCount(campaignId) {
    try {
      if (!this.databaseService) {
        return 1;
      }

      // Check if record exists first
      const existingResult = await this.databaseService.query(
        'SELECT message_count FROM campaign_message_counts WHERE campaign_id = ?',
        [campaignId]
      );

      if (existingResult.success && existingResult.data.length > 0) {
        // Update existing record
        await this.databaseService.query(`
          UPDATE campaign_message_counts
          SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP
          WHERE campaign_id = ?
        `, [campaignId]);
      } else {
        // Insert new record
        await this.databaseService.query(`
          INSERT INTO campaign_message_counts (campaign_id, message_count, updated_at)
          VALUES (?, 1, CURRENT_TIMESTAMP)
        `, [campaignId]);
      }

      // Get the updated count
      const result = await this.databaseService.query(
        'SELECT message_count FROM campaign_message_counts WHERE campaign_id = ?',
        [campaignId]
      );

      if (result.success && result.data.length > 0) {
        const newCount = result.data[0].message_count;
        return newCount;
      }

      return 1;
    } catch (error) {
      console.error('Error incrementing message count:', error);
      return 1;
    }
  }

  /**
   * Get current message count for campaign
   */
  async getMessageCount(campaignId) {
    try {
      if (!this.databaseService) {
        return 0;
      }

      const result = await this.databaseService.query(
        'SELECT message_count FROM campaign_message_counts WHERE campaign_id = ?',
        [campaignId]
      );

      if (result.success && result.data.length > 0) {
        return result.data[0].message_count;
      }

      return 0;
    } catch (error) {
      console.error('Error getting message count:', error);
      return 0;
    }
  }

  /**
   * Reset message count for campaign (called when campaign starts)
   */
  async resetMessageCount(campaignId) {
    try {
      if (!this.databaseService) {
        return;
      }


      await this.databaseService.query(`
        DELETE FROM campaign_message_counts WHERE campaign_id = ?
      `, [campaignId]);

      // Clear any sleep state
      this.campaignSleepState.delete(campaignId);

    } catch (error) {
      console.error('Error resetting message count:', error);
    }
  }

  /**
   * Reset message count for campaign
   */
  async resetMessageCount(campaignId) {
    try {
      if (!this.databaseService) {
        return;
      }

      await this.databaseService.query(
        'DELETE FROM campaign_message_counts WHERE campaign_id = ?',
        [campaignId]
      );
    } catch (error) {
      console.error('Error resetting message count:', error);
    }
  }

  /**
   * Check if a message from this sender should be forwarded to hook number
   */
  async shouldForwardToHook(senderJid, sessionId) {
    try {
      const settings = await this.getSettings();
      if (!settings || !settings.hook_number_enabled || !settings.hook_number) {
        return false;
      }

      // Extract phone number from JID (remove @s.whatsapp.net)
      const phoneNumber = senderJid.replace('@s.whatsapp.net', '');

      // Check if this phone number received a campaign message in the last 7 days
      if (this.databaseService) {
        // Try multiple phone number formats to handle different storage formats
        const phoneVariants = [
          phoneNumber,
          phoneNumber.startsWith('91') ? phoneNumber.substring(2) : '91' + phoneNumber,
          phoneNumber.startsWith('+91') ? phoneNumber.substring(3) : '+91' + phoneNumber,
          phoneNumber.startsWith('+') ? phoneNumber.substring(1) : '+' + phoneNumber
        ];

        for (const variant of phoneVariants) {
          const result = await this.databaseService.query(`
            SELECT COUNT(*) as count
            FROM message_history
            WHERE contact_phone = ?
              AND direction = 'outgoing'
              AND campaign_id IS NOT NULL
              AND timestamp > datetime('now', '-7 days')
          `, [variant]);

          if (result.success && result.data && result.data[0] && result.data[0].count > 0) {
            return true;
          }
        }

      }

      return false;
    } catch (error) {
      console.error('Error checking if should forward to hook:', error);
      return false;
    }
  }

  /**
   * Forward reply to hook number
   */
  async forwardReplyToHook(originalMessage, replyMessage, sessionId) {
    try {
      const settings = await this.getSettings();
      if (!settings || !settings.hook_number_enabled || !settings.hook_number) {
        return { success: true, forwarded: false };
      }

      // Format hook number properly for WhatsApp JID
      let hookJid = settings.hook_number;
      if (!hookJid.includes('@')) {
        // Remove any non-digit characters and ensure proper format
        const cleanNumber = hookJid.replace(/[^\d]/g, '');
        hookJid = `${cleanNumber}@s.whatsapp.net`;
      }

      // Create a comprehensive forward message
      const timestamp = new Date().toLocaleString();
      const senderPhone = originalMessage.from.replace('@s.whatsapp.net', '');

      let forwardContent = `📨 *Customer Reply Received*\n\n`;
      forwardContent += `👤 *From:* ${senderPhone}\n`;
      forwardContent += `⏰ *Time:* ${timestamp}\n`;
      forwardContent += `💬 *Message Type:* ${replyMessage.messageType || 'text'}\n\n`;
      forwardContent += `*Customer Message:*\n"${replyMessage.text}"\n\n`;
      forwardContent += `---\n`;
      forwardContent += `*Note:* This customer received a campaign message and has replied.`;


      const result = await this.whatsappService.sendMessage(
        sessionId,
        hookJid,
        { text: forwardContent },
        'text'
      );

      if (result.success) {
      } else {
        console.error(`📨 Failed to forward reply to hook number:`, result.error);
      }

      return { success: true, forwarded: result.success, result };
    } catch (error) {
      console.error('Error forwarding reply to hook:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test hook number functionality
   */
  async testHookNumber(sessionId, testPhoneNumber = null) {
    try {
      const settings = await this.getSettings();

      if (!settings || !settings.hook_number_enabled || !settings.hook_number) {
        return {
          success: false,
          error: 'Hook number not enabled or configured',
          settings: settings
        };
      }

      // Test phone number or use a default
      const phoneToTest = testPhoneNumber || '919876543210';

      // Test the shouldForwardToHook method
      const shouldForward = await this.shouldForwardToHook(`${phoneToTest}@s.whatsapp.net`, sessionId);

      // Send a test message to hook number
      const testMessage = {
        from: `${phoneToTest}@s.whatsapp.net`,
        text: 'Test campaign message',
        timestamp: new Date()
      };

      const testReply = {
        text: 'This is a test reply to verify hook number functionality.',
        messageType: 'text'
      };

      const forwardResult = await this.forwardReplyToHook(testMessage, testReply, sessionId);

      return {
        success: true,
        shouldForward: shouldForward,
        forwardResult: forwardResult,
        settings: {
          enabled: settings.hook_number_enabled,
          hookNumber: settings.hook_number
        }
      };
    } catch (error) {
      console.error('Error testing hook number:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if campaign is currently sleeping
   */
  isCampaignSleeping(campaignId) {
    return this.campaignSleepState.has(campaignId);
  }

  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId) {
    try {
      const spintaxStats = await this.spintaxService.getSpintaxStats(campaignId);
      const messageCount = await this.getMessageCount(campaignId);
      const isSleeping = this.campaignSleepState.has(campaignId);
      const settings = await this.getSettings();

      return {
        messageCount,
        isSleeping,
        sleepSettings: {
          enabled: settings?.sleep_timing_enabled || false,
          sleepAfter: settings?.sleep_after_messages || 50,
          sleepDuration: settings?.sleep_duration_seconds || 30
        },
        spintax: spintaxStats
      };
    } catch (error) {
      console.error('Error getting campaign stats:', error);
      return {
        messageCount: 0,
        isSleeping: false,
        sleepSettings: {
          enabled: false,
          sleepAfter: 50,
          sleepDuration: 30
        },
        spintax: null
      };
    }
  }
}

module.exports = BulkMessageFeaturesService;
