const { EventEmitter } = require('events');
const pino = require('pino');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const chrono = require('chrono-node');

class RecallBotService extends EventEmitter {
  constructor() {
    super();
    this.logger = pino({ name: 'RecallBotService' });
    this.databaseService = null;
    this.whatsappService = null;
    this.voiceTranscriptionService = null;
    this.naturalLanguageProcessor = null;
    this.reminderScheduler = null;
    this.isInitialized = false;
    this.activeReminders = new Map(); // Map of reminder IDs to scheduled jobs
  }

  /**
   * Fix null transcription_provider values in database
   */
  async fixNullTranscriptionProviders() {
    try {
      const result = await this.databaseService.run(`
        UPDATE recall_bot_settings
        SET transcription_provider = 'whisper'
        WHERE transcription_provider IS NULL
        AND transcription_api_key IS NOT NULL
        AND transcription_api_key != ''
      `);
    } catch (error) {
      console.error('🔍 Recall Bot: Error fixing transcription_provider:', error);
    }
  }

  /**
   * Initialize the Recall Bot service
   */
  async initialize(databaseService, whatsappService) {
    try {
      this.logger.info('🤖 Initializing Recall Bot Service...');

      this.databaseService = databaseService;
      this.whatsappService = whatsappService;

      // Fix any null transcription_provider values in database
      await this.fixNullTranscriptionProviders();

      // Initialize sub-services one by one with detailed logging
      const VoiceTranscriptionService = require('./voice-transcription.service');
      this.voiceTranscriptionService = new VoiceTranscriptionService();
      const voiceResult = await this.voiceTranscriptionService.initialize();

      // Clear module cache to ensure we get the latest version
      const nlpPath = require.resolve('./natural-language-processor.service');
      delete require.cache[nlpPath];
      const NaturalLanguageProcessor = require('./natural-language-processor.service');
      this.naturalLanguageProcessor = new NaturalLanguageProcessor();
      const nlpResult = await this.naturalLanguageProcessor.initialize();

      const ReminderScheduler = require('./reminder-scheduler.service');
      this.reminderScheduler = new ReminderScheduler(this.databaseService, this.whatsappService);
      const schedulerResult = await this.reminderScheduler.initialize();

      // Load and schedule existing active reminders
      await this.loadActiveReminders();

      this.isInitialized = true;
      this.logger.info('✅ Recall Bot Service initialized successfully');

      return { success: true };
    } catch (error) {
      console.error('❌ Recall Bot Service: Initialization failed:', error);
      console.error('❌ Recall Bot Service: Error stack:', error.stack);
      this.logger.error('❌ Failed to initialize Recall Bot Service:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if Recall Bot is enabled for a session
   */
  async isEnabledForSession(sessionId) {
    try {
      const settings = await this.getSessionSettings(sessionId);

      return settings && settings.is_enabled;
    } catch (error) {
      this.logger.error(`Error checking if Recall Bot is enabled for session ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Get Recall Bot settings for a session
   */
  async getSessionSettings(sessionId) {
    try {
      // First, get the numeric session ID from the session string
      const numericSessionId = await this.getNumericSessionId(sessionId);
      if (!numericSessionId) {
        return null;
      }

      const result = await this.databaseService.get(
        'SELECT * FROM recall_bot_settings WHERE session_id = ?',
        [numericSessionId]
      );

      return result?.data || result;
    } catch (error) {
      this.logger.error(`Error getting Recall Bot settings for session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Convert session string to numeric session ID, or return numeric ID if already numeric
   */
  async getNumericSessionId(sessionId) {
    try {


      // If sessionId is already a number, check if it exists in the database
      if (typeof sessionId === 'number' || (typeof sessionId === 'string' && /^\d+$/.test(sessionId))) {
        const numericId = parseInt(sessionId);


        const result = await this.databaseService.get(
          'SELECT id FROM whatsapp_sessions WHERE id = ?',
          [numericId]
        );

        if (result) {

          return numericId;
        } else {

          return null;
        }
      }

      // If sessionId is a string (session_xxx format), look it up
      const result = await this.databaseService.get(
        'SELECT id FROM whatsapp_sessions WHERE session_id = ?',
        [sessionId]
      );



      const numericId = result?.id || result?.data?.id;


      return numericId;
    } catch (error) {
      this.logger.error('Error getting numeric session ID:', error);
      return null;
    }
  }

  /**
   * Update Recall Bot settings for a session
   */
  async updateSessionSettings(sessionId, settings) {
    try {

      // Get the numeric session ID
      const numericSessionId = await this.getNumericSessionId(sessionId);
      if (!numericSessionId) {
        return { success: false, error: 'Session not found' };
      }

      const existingSettings = await this.getSessionSettings(sessionId);

      // Fix null transcription_provider by setting default to 'whisper'
      if (existingSettings && existingSettings.transcription_provider === null && existingSettings.transcription_api_key) {
        await this.databaseService.run(`
          UPDATE recall_bot_settings
          SET transcription_provider = 'whisper'
          WHERE session_id = ? AND transcription_provider IS NULL
        `, [numericSessionId]);
        // Refresh settings after update
        existingSettings.transcription_provider = 'whisper';
      }

      if (existingSettings && existingSettings.id) {
        // Update existing settings

        // Set default transcription provider if not specified
        const transcriptionProvider = settings.transcription_provider || 'whisper';

        const updateResult = await this.databaseService.run(`
          UPDATE recall_bot_settings
          SET is_enabled = ?, ai_provider = ?, ai_api_key = ?, ai_model = ?,
              ai_temperature = ?, default_timezone = ?, voice_transcription_enabled = ?,
              transcription_provider = ?, transcription_api_key = ?, max_reminder_duration_days = ?,
              reminder_confirmation_enabled = ?, auto_delete_completed = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?
        `, [
          settings.is_enabled ? 1 : 0, settings.ai_provider, settings.ai_api_key, settings.ai_model,
          settings.ai_temperature, settings.default_timezone, settings.voice_transcription_enabled ? 1 : 0,
          transcriptionProvider, settings.transcription_api_key, settings.max_reminder_duration_days,
          settings.reminder_confirmation_enabled ? 1 : 0, settings.auto_delete_completed ? 1 : 0, numericSessionId
        ]);
      } else {
        // Insert new settings

        // Set default transcription provider if not specified
        const transcriptionProvider = settings.transcription_provider || 'whisper';

        const insertResult = await this.databaseService.run(`
          INSERT INTO recall_bot_settings (
            session_id, is_enabled, ai_provider, ai_api_key, ai_model, ai_temperature,
            default_timezone, voice_transcription_enabled, transcription_provider, transcription_api_key,
            max_reminder_duration_days, reminder_confirmation_enabled, auto_delete_completed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          numericSessionId, settings.is_enabled ? 1 : 0, settings.ai_provider, settings.ai_api_key, settings.ai_model,
          settings.ai_temperature, settings.default_timezone, settings.voice_transcription_enabled ? 1 : 0,
          transcriptionProvider, settings.transcription_api_key, settings.max_reminder_duration_days,
          settings.reminder_confirmation_enabled ? 1 : 0, settings.auto_delete_completed ? 1 : 0
        ]);
      }

      this.logger.info(`✅ Updated Recall Bot settings for session ${sessionId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Error updating Recall Bot settings for session ${sessionId}:`, error);
      console.error('🔍 Recall Bot: Error saving settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process incoming message for recall bot functionality
   */
  async processMessage(sessionId, message) {
    try {
      // Check if Recall Bot is enabled for this session
      if (!await this.isEnabledForSession(sessionId)) {
        return { success: false, reason: 'Recall Bot not enabled for this session' };
      }

      const settings = await this.getSessionSettings(sessionId);
      let messageText = '';

      // Check if this is a voice message by looking at the message structure
      const isVoiceMessage = message.message?.audioMessage || message.message?.ptt ||
                            (message.messageType && message.messageType.includes('audio')) ||
                            (message.type && message.type.includes('audio'));


      // Extract user JID for sending messages
      let userJid = message.from;
      if (!userJid) {
        userJid = message.key?.remoteJid || message.key?.participant || message.key?.from;
      }

      // Handle voice messages
      if (isVoiceMessage && settings.voice_transcription_enabled) {
        this.logger.info(`🎤 Processing voice message for recall bot in session ${sessionId}`);

        const transcriptionResult = await this.voiceTranscriptionService.transcribeVoiceMessage(
          sessionId, message, settings
        );


        if (!transcriptionResult.success) {
          // Send helpful message asking user to send text instead
          const helpMessage = "🎤 Voice messages are not supported. Please send your reminder as a text message instead.\n\nFor example: 'Remind me to call John in 30 minutes'";

          try {
            if (userJid) {
              await this.whatsappService.sendMessage(sessionId, userJid, helpMessage, 'text');
              this.logger.info(`✅ Sent help message to user ${userJid}`);
            } else {
              this.logger.warn('Could not extract userJid to send help message');
            }
          } catch (sendError) {
            this.logger.error('Failed to send help message:', sendError);
          }

          await this.logActivity(sessionId, message.from, null, 'voice_transcription_failed',
            `Failed to transcribe voice message: ${transcriptionResult.error}`);
          return { success: false, error: 'Voice transcription not available - user notified to send text' };
        }

        // Check if transcription returned the special failure message
        if (transcriptionResult.transcription === 'TRANSCRIPTION_FAILED_PLEASE_SEND_TEXT') {
          const helpMessage = "🎤 Voice messages are not supported. Please send your reminder as a text message instead.\n\nFor example: 'Remind me to call John in 30 minutes'";

          try {
            if (userJid) {
              await this.whatsappService.sendMessage(sessionId, userJid, helpMessage, 'text');
              this.logger.info(`✅ Sent help message to user ${userJid}`);
            } else {
              this.logger.warn('Could not extract userJid to send help message');
            }
          } catch (sendError) {
            this.logger.error('Failed to send help message:', sendError);
          }

          return { success: false, error: 'Voice transcription not available - user notified to send text' };
        }

        messageText = transcriptionResult.transcription;
        await this.logActivity(sessionId, message.from, null, 'voice_transcribed',
          `Voice message transcribed: "${messageText}"`);
      } else {
        // Extract text from WhatsApp message structure
        messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';

        // If no text found and it's not a voice message, check if it's an unsupported message type
        if (!messageText.trim() && !isVoiceMessage) {
          return { success: false, reason: 'Unsupported message type for recall bot' };
        }

        // If no text found but it's a voice message without transcription enabled
        if (!messageText.trim() && isVoiceMessage && !settings.voice_transcription_enabled) {
          return { success: false, reason: 'Voice transcription is disabled' };
        }
      }

      if (!messageText.trim()) {
        return { success: false, reason: 'No text content to process' };
      }

      // Process the message with AI to extract reminder information
      this.logger.info(`🧠 Processing message with AI: "${messageText}"`);
      this.logger.info(`🔧 Settings:`, JSON.stringify({
        ai_provider: settings.ai_provider,
        ai_model: settings.ai_model,
        has_api_key: !!settings.ai_api_key,
        api_key_preview: settings.ai_api_key ? settings.ai_api_key.substring(0, 10) + '...' : 'NOT SET'
      }, null, 2));

      const aiResult = await this.naturalLanguageProcessor.processReminderMessage(
        messageText, settings, message.from
      );

      this.logger.info(`🤖 AI Result:`, JSON.stringify(aiResult, null, 2));

      if (!aiResult.success) {
        this.logger.error(`❌ AI processing failed: ${aiResult.error}`);
        await this.logActivity(sessionId, message.from, null, 'ai_processing_failed',
          `Failed to process message with AI: ${aiResult.error}`);
        return { success: false, error: 'Failed to process message with AI' };
      }

      // Handle the AI response based on the action type
      this.logger.info(`🎯 Handling AI response action: ${aiResult.response?.action}`);
      return await this.handleAIResponse(sessionId, message, messageText, aiResult.response, settings);

    } catch (error) {
      this.logger.error(`Error processing message for recall bot in session ${sessionId}:`, error);
      await this.logActivity(sessionId, message.from, null, 'processing_error', 
        `Error processing message: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle AI response and perform the appropriate action
   */
  async handleAIResponse(sessionId, originalMessage, messageText, aiResponse, settings) {
    try {
      const { action, reminder_text, scheduled_time, timezone, recurrence_type, recurrence_interval, recurrence_end_date } = aiResponse;

      switch (action) {
        case 'create':
          return await this.createReminder(sessionId, originalMessage, {
            reminder_text,
            original_message: messageText,
            scheduled_time,
            timezone: timezone || settings.default_timezone,
            recurrence_type,
            recurrence_interval,
            recurrence_end_date,
            metadata: JSON.stringify(aiResponse)
          });

        case 'update':
          return await this.updateReminder(sessionId, originalMessage, aiResponse);

        case 'cancel':
          return await this.cancelReminder(sessionId, originalMessage, aiResponse);

        case 'cancel_all':
          return await this.cancelAllReminders(sessionId, originalMessage);

        case 'list':
          return await this.listReminders(sessionId, originalMessage);

        case 'clarify':
          // Send clarification message to user
          const clarificationMessage = aiResponse.message ||
            "👋 Hi! I'm your Recall Bot - I help you set up reminders so you never miss important tasks! 🤖\n\n" +
            "You can ask me to:\n" +
            "• ⏰ Set reminders (e.g., \"remind me to call John at 5 PM\")\n" +
            "• 📋 List your reminders (\"show my reminders\")\n" +
            "• ❌ Cancel reminders (\"cancel all\" or \"delete reminder\")\n\n" +
            "Just tell me what you'd like to be reminded about and when! 😊";

          await this.whatsappService.sendMessage(
            sessionId,
            originalMessage.from || originalMessage.key?.remoteJid,
            { text: clarificationMessage },
            'text'
          );

          await this.logActivity(sessionId, originalMessage.from, null, 'clarification_sent',
            `Sent clarification message: ${clarificationMessage}`);
          return { success: true, action: 'clarification_sent' };

        default:
          await this.logActivity(sessionId, originalMessage.from, null, 'unknown_action',
            `Unknown action from AI: ${action}`);
          return { success: false, error: 'Unknown action requested' };
      }
    } catch (error) {
      this.logger.error('Error handling AI response:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a new reminder
   */
  async createReminder(sessionId, originalMessage, reminderData) {
    try {
      // Extract user JID from message structure first
      let userJid = originalMessage.from;
      if (!userJid) {
        // Try to extract from message key structure
        userJid = originalMessage.key?.remoteJid;
      }
      if (!userJid) {
        // Try to extract from message structure (for WhatsApp messages)
        userJid = originalMessage.key?.participant || originalMessage.key?.from;
      }


      if (!userJid) {
        console.error('❌ Recall Bot createReminder: Could not extract user JID from message');
        return { success: false, error: 'Could not identify message sender' };
      }

      // Validate scheduled time
      // IMPORTANT: Parse the time as if it's in the target timezone, not convert it
      // If AI returns "2025-11-08T18:00:00.000Z", we want 18:00 in Asia/Kolkata, not 18:00 UTC converted to IST
      let scheduledTime;
      const aiTime = reminderData.scheduled_time;

      // Parse and extract UTC components, then interpret them as IST time
      if (aiTime.endsWith('Z') || aiTime.includes('+') || aiTime.includes('T')) {
        // Parse as UTC to get the raw time components (18:00 from "18:00:00.000Z")
        const parsedMoment = moment.utc(aiTime);

        // Create a new moment in target timezone using those components
        scheduledTime = moment.tz({
          year: parsedMoment.year(),
          month: parsedMoment.month(),
          day: parsedMoment.date(),
          hour: parsedMoment.hour(),
          minute: parsedMoment.minute(),
          second: parsedMoment.second()
        }, reminderData.timezone);
      } else {
        scheduledTime = moment.tz(aiTime, reminderData.timezone);
      }

      if (!scheduledTime.isValid() || scheduledTime.isBefore(moment())) {
        return await this.sendErrorResponse(sessionId, userJid,
          'Invalid or past date/time. Please provide a future date and time for your reminder.');
      }

      // Insert reminder into database
      const result = await this.databaseService.run(`
        INSERT INTO reminders (
          session_id, user_jid, user_name, reminder_text, original_message,
          scheduled_time, timezone, recurrence_type, recurrence_interval,
          recurrence_end_date, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        sessionId, userJid, originalMessage.pushName || 'Unknown',
        reminderData.reminder_text, reminderData.original_message,
        scheduledTime.toISOString(), reminderData.timezone,
        reminderData.recurrence_type, reminderData.recurrence_interval,
        reminderData.recurrence_end_date, reminderData.metadata
      ]);

      const reminderId = result.lastID || result.insertId || result.lastInsertRowid;

      // Schedule the reminder
      // CRITICAL: node-schedule interprets Date objects as local time (IST)
      // So we need to pass the exact time components, not convert to UTC
      const scheduleDate = new Date(
        scheduledTime.year(),
        scheduledTime.month(),
        scheduledTime.date(),
        scheduledTime.hour(),
        scheduledTime.minute(),
        scheduledTime.second()
      );
      const scheduleResult = await this.reminderScheduler.scheduleReminder(reminderId, scheduleDate);

      // Log activity
      await this.logActivity(sessionId, userJid, reminderId, 'reminder_created',
        `Reminder created: "${reminderData.reminder_text}" scheduled for ${scheduledTime.format()}`);

      // Send casual and creative confirmation message with proper timezone display
      const localTime = scheduledTime.tz(reminderData.timezone);
      const casualResponses = [
        `🎯 Got it Boss! I'll remind you to ${reminderData.reminder_text} at ${localTime.format('h:mm A')} on ${localTime.format('MMM Do')}. Consider it done! 💪`,
        `👍 No worries! I've set a reminder for you to ${reminderData.reminder_text} at ${localTime.format('h:mm A, MMM Do')}. I won't let you forget! 🔔`,
        `✨ Perfect! Your reminder to ${reminderData.reminder_text} is locked and loaded for ${localTime.format('h:mm A')} on ${localTime.format('MMM Do')}. I got your back! 🚀`,
        `🤝 Consider it handled! I'll ping you to ${reminderData.reminder_text} at ${localTime.format('h:mm A, MMM Do')}. You can count on me! ⏰`,
        `💯 Boom! Reminder set for you to ${reminderData.reminder_text} at ${localTime.format('h:mm A')} on ${localTime.format('MMM Do')}. I'll make sure you don't miss it! 🎯`
      ];

      let confirmationMessage = casualResponses[Math.floor(Math.random() * casualResponses.length)];

      if (reminderData.recurrence_type) {
        confirmationMessage += `\n\n🔄 And hey, this will repeat ${reminderData.recurrence_type} - so you're all set for the long run! 📅`;
      }

      await this.whatsappService.sendMessage(sessionId, userJid, confirmationMessage, 'text');

      this.logger.info(`✅ Reminder created successfully for session ${sessionId}, reminder ID: ${reminderId}`);
      return { success: true, reminderId, scheduledTime: scheduledTime.toISOString() };

    } catch (error) {
      this.logger.error('Error creating reminder:', error);
      await this.sendErrorResponse(sessionId, originalMessage.from, 
        'Sorry, I encountered an error while creating your reminder. Please try again.');
      return { success: false, error: error.message };
    }
  }

  /**
   * Load and schedule all active reminders on startup
   */
  async loadActiveReminders() {
    try {
      const reminders = await this.databaseService.all(`
        SELECT * FROM reminders 
        WHERE status = 'active' AND scheduled_time > datetime('now')
      `);

      for (const reminder of reminders) {
        const scheduledTime = moment(reminder.scheduled_time).toDate();
        await this.reminderScheduler.scheduleReminder(reminder.id, scheduledTime);
      }

      this.logger.info(`📅 Loaded and scheduled ${reminders.length} active reminders`);
    } catch (error) {
      this.logger.error('Error loading active reminders:', error);
    }
  }

  /**
   * Send error response to user
   */
  async sendErrorResponse(sessionId, userJid, errorMessage) {
    try {
      await this.whatsappService.sendMessage(sessionId, userJid, `❌ ${errorMessage}`, 'text');
    } catch (error) {
      this.logger.error('Error sending error response:', error);
    }
  }

  /**
   * Update an existing reminder
   */
  async updateReminder(sessionId, originalMessage, aiResponse) {
    try {
      // Implementation for updating reminders
      // This would involve finding the reminder to update and modifying it
      await this.sendErrorResponse(sessionId, originalMessage.from,
        'Reminder updates are not yet implemented. Please cancel the old reminder and create a new one.');
      return { success: false, error: 'Update functionality not implemented' };
    } catch (error) {
      this.logger.error('Error updating reminder:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel all reminders
   */
  async cancelAllReminders(sessionId, originalMessage) {
    try {
      // Extract user JID from message structure
      let userJid = originalMessage.from;
      if (!userJid) {
        userJid = originalMessage.key?.remoteJid;
      }
      if (!userJid) {
        userJid = originalMessage.key?.participant || originalMessage.key?.from;
      }

      // Get user's active reminders
      const result = await this.databaseService.all(`
        SELECT * FROM reminders
        WHERE session_id = ? AND user_jid = ? AND status = 'active'
        ORDER BY created_at DESC
      `, [sessionId, userJid]);

      // Handle both array and {success, data} response formats
      const reminders = Array.isArray(result) ? result : (result.data || []);

      if (reminders.length === 0) {
        await this.whatsappService.sendMessage(sessionId, userJid,
          '❌ You don\'t have any active reminders to cancel.', 'text');
        return { success: true, message: 'No active reminders found' };
      }

      // Cancel all reminders
      let cancelledCount = 0;
      for (const reminder of reminders) {
        const result = await this.reminderScheduler.cancelReminder(reminder.id);
        if (result.success) {
          cancelledCount++;
          await this.logActivity(sessionId, userJid, reminder.id, 'reminder_cancelled',
            `Reminder cancelled (bulk): "${reminder.reminder_text}"`);
        }
      }

      // Send confirmation message
      const casualResponses = [
        `🗑️ All done! I've cancelled all ${cancelledCount} of your reminders. Your schedule is now clear! 🎯`,
        `✅ Perfect! Cancelled all ${cancelledCount} reminders for you. Fresh start! 💪`,
        `🧹 Boom! All ${cancelledCount} reminders wiped clean. You're all set! 🚀`,
        `👍 Got it! I've removed all ${cancelledCount} reminders from your list. Clean slate! ✨`,
        `💯 Done deal! All ${cancelledCount} reminders have been cancelled. You're free! 🎉`
      ];

      const confirmationMessage = casualResponses[Math.floor(Math.random() * casualResponses.length)];
      await this.whatsappService.sendMessage(sessionId, userJid, confirmationMessage, 'text');

      return { success: true, cancelledCount };

    } catch (error) {
      this.logger.error('Error cancelling all reminders:', error);
      await this.sendErrorResponse(sessionId, userJid,
        'Sorry, I encountered an error while cancelling your reminders. Please try again.');
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel a reminder
   */
  async cancelReminder(sessionId, originalMessage, aiResponse) {
    try {
      // Get user's active reminders
      const reminders = await this.databaseService.all(`
        SELECT * FROM reminders
        WHERE session_id = ? AND user_jid = ? AND status = 'active'
        ORDER BY created_at DESC
      `, [sessionId, originalMessage.from]);

      if (reminders.length === 0) {
        await this.whatsappService.sendMessage(sessionId, originalMessage.from,
          '❌ You don\'t have any active reminders to cancel.', 'text');
        return { success: true, message: 'No active reminders found' };
      }

      if (reminders.length === 1) {
        // Cancel the only reminder
        const reminder = reminders[0];
        await this.reminderScheduler.cancelReminder(reminder.id);

        await this.whatsappService.sendMessage(sessionId, originalMessage.from,
          `✅ Cancelled reminder: "${reminder.reminder_text}"`, 'text');

        await this.logActivity(sessionId, originalMessage.from, reminder.id, 'reminder_cancelled',
          `Reminder cancelled: "${reminder.reminder_text}"`);

        return { success: true, cancelledReminderId: reminder.id };
      } else {
        // Multiple reminders - ask user to specify
        let message = '📋 You have multiple active reminders:\n\n';
        reminders.forEach((reminder, index) => {
          const scheduledTime = moment(reminder.scheduled_time).tz(reminder.timezone);
          message += `${index + 1}. ${reminder.reminder_text}\n`;
          message += `   ⏰ ${scheduledTime.format('MMM Do, h:mm A z')}\n\n`;
        });
        message += 'Please reply with the number of the reminder you want to cancel (e.g., "1" or "2").\n\n';
        message += '💡 _Tip: You can also say "cancel all reminders" to clear everything!_';

        await this.whatsappService.sendMessage(sessionId, originalMessage.from, message, 'text');
        return { success: true, message: 'Multiple reminders found, awaiting user selection' };
      }
    } catch (error) {
      this.logger.error('Error cancelling reminder:', error);
      await this.sendErrorResponse(sessionId, originalMessage.from,
        'Sorry, I encountered an error while cancelling your reminder. Please try again.');
      return { success: false, error: error.message };
    }
  }

  /**
   * List user's reminders
   */
  async listReminders(sessionId, originalMessage) {
    try {
      const reminders = await this.databaseService.all(`
        SELECT * FROM reminders
        WHERE session_id = ? AND user_jid = ? AND status = 'active'
        ORDER BY scheduled_time ASC
      `, [sessionId, originalMessage.from]);

      if (reminders.length === 0) {
        await this.whatsappService.sendMessage(sessionId, originalMessage.from,
          '📋 You don\'t have any active reminders.', 'text');
        return { success: true, count: 0 };
      }

      let message = `📋 *Your Active Reminders* (${reminders.length})\n\n`;

      reminders.forEach((reminder, index) => {
        const scheduledTime = moment(reminder.scheduled_time).tz(reminder.timezone);
        message += `${index + 1}. *${reminder.reminder_text}*\n`;
        message += `   ⏰ ${scheduledTime.format('MMMM Do YYYY, h:mm A z')}\n`;

        if (reminder.recurrence_type) {
          message += `   🔄 Repeats: ${reminder.recurrence_type}\n`;
        }

        message += '\n';
      });

      await this.whatsappService.sendMessage(sessionId, originalMessage.from, message, 'text');

      await this.logActivity(sessionId, originalMessage.from, null, 'reminders_listed',
        `Listed ${reminders.length} active reminders`);

      return { success: true, count: reminders.length };
    } catch (error) {
      this.logger.error('Error listing reminders:', error);
      await this.sendErrorResponse(sessionId, originalMessage.from,
        'Sorry, I encountered an error while retrieving your reminders. Please try again.');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get recall bot statistics for a session
   */
  async getSessionStats(sessionId) {
    try {
      const reminderStats = await this.reminderScheduler.getReminderStats(sessionId);
      const transcriptionStats = await this.voiceTranscriptionService.getTranscriptionStats(sessionId);

      return {
        reminders: reminderStats,
        transcriptions: transcriptionStats,
        scheduledJobs: this.reminderScheduler.getScheduledJobsCount()
      };
    } catch (error) {
      this.logger.error('Error getting session stats:', error);
      return null;
    }
  }

  /**
   * Shutdown the recall bot service
   */
  async shutdown() {
    try {
      this.logger.info('🛑 Shutting down Recall Bot Service...');

      // Cancel all scheduled jobs
      if (this.reminderScheduler) {
        this.reminderScheduler.cancelAllJobs();
      }

      this.isInitialized = false;
      this.logger.info('✅ Recall Bot Service shut down successfully');
    } catch (error) {
      this.logger.error('Error shutting down Recall Bot Service:', error);
    }
  }

  /**
   * Log activity to recall bot logs
   */
  async logActivity(sessionId, userJid, reminderId, actionType, message, metadata = null) {
    try {
      await this.databaseService.run(`
        INSERT INTO recall_bot_logs (session_id, user_jid, reminder_id, action_type, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sessionId, userJid, reminderId, actionType, message, metadata ? JSON.stringify(metadata) : null]);
    } catch (error) {
      this.logger.error('Error logging activity:', error);
    }
  }
}

module.exports = RecallBotService;
