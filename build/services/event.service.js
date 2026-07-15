const { EventEmitter } = require('events');
const pino = require('pino');
const MessageProcessorService = require('./message-processor.service');

class EventService extends EventEmitter {
  constructor(databaseService, whatsappService) {
    super();
    this.databaseService = databaseService;
    this.whatsappService = whatsappService;
    this.messageProcessor = new MessageProcessorService(databaseService);
    this.logger = pino({ level: 'info' });
    this.emailService = null; // Will be injected by AppService
    this.supportBotService = null; // Will be injected by AppService

    this.setupWhatsAppEventListeners();
  }

  /**
   * Setup WhatsApp service event listeners
   */
  setupWhatsAppEventListeners() {
    // QR Code events
    this.whatsappService.on('qr_code', async (data) => {
      await this.handleQRCode(data);
    });

    // Session connection events
    this.whatsappService.on('session_connected', async (data) => {
      await this.handleSessionConnected(data);
    });

    // Session connecting events
    this.whatsappService.on('session_connecting', async (data) => {
      await this.handleSessionConnecting(data);
    });

    // Session disconnection events
    this.whatsappService.on('session_disconnected', async (data) => {
      await this.handleSessionDisconnected(data);
    });

    // Session status updates
    this.whatsappService.on('session_status_update', async (data) => {
      await this.handleSessionStatusUpdate(data);
    });

    // Message received events
    this.whatsappService.on('message_received', async (data) => {
      await this.handleMessageReceived(data);
    });

    // Contacts update events
    this.whatsappService.on('contacts_update', async (data) => {
      await this.handleContactsUpdate(data);
    });

    // Call received events
    this.whatsappService.on('call_received', async (data) => {
      await this.handleCallReceived(data);
    });

    // Presence update events
    this.whatsappService.on('presence_update', async (data) => {
      await this.handlePresenceUpdate(data);
    });

    // Session deleted events
    this.whatsappService.on('session_deleted', async (data) => {
      await this.handleSessionDeleted(data);
    });
  }

  /**
   * Handle QR code generation
   */
  async handleQRCode(data) {
    const { sessionId, qrCode, timestamp } = data;

    try {

      // Validate QR code data
      if (!qrCode || !qrCode.startsWith('data:image/')) {
        this.logger.warn(`Invalid QR code data for session ${sessionId}`);
        return;
      }

      // Update session status in database
      const updateResult = await this.databaseService.run(
        'UPDATE whatsapp_sessions SET status = ?, qr_code = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
        ['qr_ready', qrCode, sessionId]
      );


      // Always emit to frontend - let the frontend handle display logic
      this.emit('qr_code_generated', {
        sessionId,
        qrCode,
        timestamp: timestamp || new Date().toISOString(),
        status: 'qr_ready'
      });

      this.logger.info(`QR code generated and forwarded for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error handling QR code for ${sessionId}:`, error);
      console.error(`❌ QR code handling error for ${sessionId}:`, error);
    }
  }

  /**
   * Handle session connected
   */
  async handleSessionConnected(data) {
    const { sessionId, phoneNumber, profilePicture, status, isLoggedIn } = data;
    
    try {
      // Update session in database
      await this.databaseService.run(`
        UPDATE whatsapp_sessions 
        SET status = 'connected', 
            phone_number = ?, 
            profile_picture = ?,
            is_active = 1,
            last_seen = CURRENT_TIMESTAMP,
            connected_at = CURRENT_TIMESTAMP,
            qr_code = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `, [phoneNumber || null, profilePicture || null, sessionId]);

      // Log activity
      await this.databaseService.run(`
        INSERT INTO activity_logs (action_type, description, metadata)
        VALUES (?, ?, ?)
      `, ['session_connected', `Session ${sessionId} connected${phoneNumber ? ` with phone ${phoneNumber}` : ''}`, JSON.stringify({ sessionId, phoneNumber: phoneNumber || 'unknown' })]);

      // Emit to frontend with all the data from WhatsApp service
      this.emit('session_connected', {
        sessionId,
        phoneNumber,
        profilePicture,
        status: status || 'connected',
        isLoggedIn: isLoggedIn !== undefined ? isLoggedIn : true,
        timestamp: new Date()
      });

      this.logger.info(`Session ${sessionId} connected${phoneNumber ? ` with phone ${phoneNumber}` : ''}`);
    } catch (error) {
      this.logger.error(`Error handling session connected for ${sessionId}:`, error);
      // Session connected error logged
    }
  }

  /**
   * Handle session connecting (when QR is scanned but not yet connected)
   */
  async handleSessionConnecting(data) {
    const { sessionId, status, isLoggedIn } = data;

    try {
      // Use the actual status from the event (could be 'connecting' or 'reconnecting')
      const actualStatus = status || 'connecting';

      // Update session status in database
      await this.databaseService.run(`
        UPDATE whatsapp_sessions
        SET status = ?,
            last_seen = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `, [actualStatus, sessionId]);

      // Emit to frontend for QR modal reactivity
      this.emit('session_connecting', {
        sessionId,
        status: actualStatus,
        isLoggedIn: isLoggedIn !== undefined ? isLoggedIn : false,
        timestamp: new Date()
      });

      this.logger.info(`Session ${sessionId} is ${actualStatus}...`);
    } catch (error) {
      this.logger.error(`Error handling session connecting for ${sessionId}:`, error);
      // Session connecting error logged
    }
  }

  /**
   * Handle session disconnected
   */
  async handleSessionDisconnected(data) {
    const { sessionId, reason } = data;
    
    try {
      // Update session status but keep it active - disconnection doesn't mean deletion
      await this.databaseService.run(`
        UPDATE whatsapp_sessions 
        SET status = 'disconnected', 
            disconnected_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `, [sessionId]);

      // Log activity
      await this.databaseService.run(`
        INSERT INTO activity_logs (action_type, description, metadata)
        VALUES (?, ?, ?)
      `, ['session_disconnected', `Session ${sessionId} disconnected: ${reason}`, JSON.stringify({ sessionId, reason })]);

      // Emit to frontend
      this.emit('session_disconnected', {
        sessionId,
        reason,
        timestamp: new Date()
      });

      this.logger.info(`Session ${sessionId} disconnected: ${reason}`);
    } catch (error) {
      this.logger.error(`Error handling session disconnected for ${sessionId}:`, error);
    }
  }

  /**
   * Handle session status update
   */
  async handleSessionStatusUpdate(data) {
    const { sessionId, status, isLoggedIn } = data;
    
    try {
      // Update session status but keep session active unless explicitly deleted
      // Only update is_active for connected status, not for qr_ready or connecting states
      const updateFields = ['status = ?', 'last_seen = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP'];
      const params = [status];
      
      // Only update is_active if the session is actually connected (not just during QR generation)
      if (status === 'connected' && isLoggedIn) {
        updateFields.push('is_active = 1');
        updateFields.push('connected_at = CURRENT_TIMESTAMP');
      }

      await this.databaseService.run(`
        UPDATE whatsapp_sessions 
        SET ${updateFields.join(', ')}
        WHERE session_id = ?
      `, [...params, sessionId]);

      // Emit to frontend
      this.emit('session_status_update', {
        sessionId,
        status,
        isLoggedIn,
        timestamp: new Date()
      });

    } catch (error) {
      this.logger.error(`Error handling session status update for ${sessionId}:`, error);
    }
  }

  /**
   * Handle message received
   */
  async handleMessageReceived(data) {
    const { sessionId, message, formattedMessage } = data;


    try {
      // Parse the message to ensure we have proper format
      const parsedMessage = this.messageProcessor.parseIncomingMessage(message);

      // Extract message context for contact name resolution
      const messageContext = {
        pushName: message.pushName || null,
        verifiedBizName: message.verifiedBizName || null,
        originalMessage: message
      };

      // Store message context for later use in chatbot processing
      this.messageContextCache = this.messageContextCache || new Map();
      this.messageContextCache.set(parsedMessage.from, messageContext);

      // Use formatted message for database storage, fallback to parsed message
      const msgForDb = formattedMessage || parsedMessage;

      // Only store in database if we have required fields
      if (msgForDb.from && msgForDb.text) {
        await this.databaseService.run(`
          INSERT INTO message_history (
            session_id, message_id, contact_phone,
            content, message_type, direction, status, timestamp
          ) VALUES (?, ?, ?, ?, ?, 'incoming', 'received', ?)
        `, [
          sessionId,
          msgForDb.id,
          this.messageProcessor.extractPhoneNumber(msgForDb.from),
          msgForDb.text,
          msgForDb.type,
          new Date().toISOString()
        ]);
      }

      // Check for Support Bot lookup (HIGHEST PRIORITY - before auto-reply and chatbot)
      const supportBotProcessed = await this.checkSupportBotLookup(sessionId, message);

      // If Support Bot processed the message, skip other automated responses
      if (supportBotProcessed) {
        this.logger.info(`🤖 Support Bot processed message - skipping other automated responses`);

        // Still update contact and emit event
        await this.updateContactFromMessage(msgForDb);
        this.emit('message_received', {
          sessionId,
          message,
          timestamp: new Date()
        });

        return; // Exit early - don't process auto-reply or chatbot
      }

      // Check for auto-reply rules (use original message format)
      await this.checkAutoReplyRules(sessionId, message);

      // Check for chatbot triggers (use original message format)
      await this.checkChatbotTriggers(sessionId, message);

      // Check for recall bot messages (allow even if chatbot processed, for reminder keywords)
      await this.checkRecallBotMessages(sessionId, message);

      // Update contact info if not exists
      await this.updateContactFromMessage(msgForDb);

      // Emit to frontend
      this.emit('message_received', {
        sessionId,
        message,
        timestamp: new Date()
      });

      this.logger.info(`Message received in session ${sessionId} from ${message.from}${messageContext.pushName ? ` (${messageContext.pushName})` : ''}`);
    } catch (error) {
      this.logger.error(`Error handling message received for ${sessionId}:`, error);
    }
  }

  /**
   * Check for recall bot messages
   */
  async checkRecallBotMessages(sessionId, message) {
    try {
      // Get recall bot service from the global app service instance
      if (!global.appService || !global.appService.getRecallBotService) {
        return;
      }

      const recallBotService = global.appService.getRecallBotService();
      if (!recallBotService || !recallBotService.isInitialized) {
        return;
      }


      // Check if this message should be processed by recall bot
      const shouldProcess = await this.shouldProcessForRecallBot(sessionId, message);

      if (shouldProcess) {
        this.logger.info(`🤖 Processing message for Recall Bot in session ${sessionId}`);

        // Process the message with recall bot
        const result = await recallBotService.processMessage(sessionId, message);

        if (result.success) {
          this.logger.info(`✅ Recall Bot processed message successfully in session ${sessionId}`);
          // Mark message as processed to prevent other modules from handling it
          message._recallBotProcessed = true;
        } else {
          this.logger.warn(`⚠️ Recall Bot failed to process message in session ${sessionId}: ${result.error || result.reason}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error checking recall bot messages for session ${sessionId}:`, error);
    }
  }

  /**
   * Determine if a message should be processed by recall bot
   */
  async shouldProcessForRecallBot(sessionId, message) {
    try {
      // Get recall bot service from the global app service instance
      if (!global.appService || !global.appService.getRecallBotService) {
        return false;
      }

      const recallBotService = global.appService.getRecallBotService();
      if (!recallBotService) {
        return false;
      }

      // Check if recall bot is enabled for this session
      const isEnabled = await recallBotService.isEnabledForSession(sessionId);
      if (!isEnabled) {
        return false;
      }

      // Check message type - support text and voice messages
      const messageType = message.messageType || message.type;

      // Extract message text from the WhatsApp message structure
      const messageText = (message.message?.conversation || message.message?.extendedTextMessage?.text || message.text || '').toLowerCase();

      // If we have message text, process it regardless of messageType (since messageType might be undefined)
      if (messageText) {

        // Keywords that suggest this is a reminder message
        const reminderKeywords = [
          'remind', 'reminder', 'remember', 'alert', 'notify', 'notification',
          'schedule', 'appointment', 'meeting', 'call', 'task', 'todo',
          'tomorrow', 'today', 'next week', 'next month', 'later',
          'at', 'on', 'in', 'every', 'daily', 'weekly', 'monthly',
          'cancel reminder', 'delete reminder', 'remove reminder',
          'cancel all', 'delete all', 'clear all', 'remove all',
          'list reminders', 'show reminders', 'my reminders', 'list all'
        ];

        const hasReminderKeyword = reminderKeywords.some(keyword => messageText.includes(keyword));

        // Also check for time-related patterns
        const timePatterns = [
          /\d{1,2}:\d{2}/, // Time format like 14:30
          /\d{1,2}\s*(am|pm)/i, // Time with am/pm
          /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
          /\b\d{1,2}(st|nd|rd|th)\b/i // Dates like 1st, 2nd, 3rd
        ];

        const hasTimePattern = timePatterns.some(pattern => pattern.test(messageText));

        const shouldProcess = hasReminderKeyword || hasTimePattern;
        return shouldProcess;
      }

      // For voice messages, check multiple possible indicators
      const isVoiceMessage = message.message?.audioMessage || message.message?.ptt ||
                            (messageType && messageType.includes('audio')) ||
                            (message.type && message.type.includes('audio'));

      if (isVoiceMessage) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Error determining if message should be processed by recall bot:', error);
      return false;
    }
  }

  /**
   * Handle contacts update
   */
  async handleContactsUpdate(data) {
    const { sessionId, contacts } = data;

    try {
      for (const contact of contacts) {
        const phoneNumber = contact.id.split('@')[0];
        const contactName = contact.name || contact.pushName || '';


        // Check if contact exists first
        const existingContact = await this.databaseService.get(
          'SELECT id, name FROM contacts WHERE phone_number = ? AND is_active = 1',
          [phoneNumber]
        );

        if (existingContact) {
          // Update existing contact - preserve all data, only update name if it's better
          const shouldUpdateName = contactName &&
            contactName !== phoneNumber &&
            (!existingContact.name || existingContact.name === phoneNumber || existingContact.name.length < contactName.length);

          if (shouldUpdateName) {
            await this.databaseService.run(`
              UPDATE contacts
              SET name = ?, updated_at = CURRENT_TIMESTAMP
              WHERE phone_number = ? AND is_active = 1
            `, [contactName, phoneNumber]);
          } else {
          }
        } else {
          // Insert new contact only if it doesn't exist
          await this.databaseService.run(`
            INSERT INTO contacts (
              phone_number, name, is_active, created_at, updated_at
            ) VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `, [phoneNumber, contactName]);
        }
      }

      this.logger.info(`Updated ${contacts.length} contacts for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error handling contacts update for ${sessionId}:`, error);
    }
  }

  /**
   * Handle call received
   */
  async handleCallReceived(data) {
    const { sessionId, call } = data;

    this.logger.info(`🔔 EVENT SERVICE: handleCallReceived called for ${sessionId} from ${call.from}, status: ${call.status}`);

    try {
      // Store call in database (you might want to create a calls table)
      await this.databaseService.run(`
        INSERT INTO activity_logs (action_type, description, metadata)
        VALUES (?, ?, ?)
      `, ['call_received', `Call received in session ${sessionId} from ${call.from}`, JSON.stringify({ sessionId, call })]);

      this.logger.info(`🔔 EVENT SERVICE: About to call processCallResponderRules...`);

      // Check for call responder rules using WhatsApp service
      await this.whatsappService.processCallResponderRules(sessionId, call);

      this.logger.info(`🔔 EVENT SERVICE: processCallResponderRules completed`);

      // Emit to frontend
      this.emit('call_received', {
        sessionId,
        call,
        timestamp: new Date()
      });

      this.logger.info(`Call received in session ${sessionId} from ${call.from}`);
    } catch (error) {
      this.logger.error(`Error handling call received for ${sessionId}:`, error);
    }
  }

  /**
   * Handle presence update
   */
  async handlePresenceUpdate(data) {
    const { sessionId, presence } = data;
    
    try {
      // Update contact last seen
      if (presence.id && presence.lastSeen) {
        await this.databaseService.run(`
          UPDATE contacts 
          SET last_seen = ?, updated_at = CURRENT_TIMESTAMP
          WHERE phone_number = ?
        `, [presence.lastSeen, presence.id.split('@')[0]]);
      }

      // Emit to frontend for real-time updates
      this.emit('presence_update', data);

    } catch (error) {
      this.logger.error(`Error handling presence update for ${sessionId}:`, error);
    }
  }

  /**
   * Handle session deleted
   */
  async handleSessionDeleted(data) {
    const { sessionId } = data;
    
    try {
      // Update session status
      await this.databaseService.run(
        'UPDATE whatsapp_sessions SET is_active = 0, status = "deleted", updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
        [sessionId]
      );

      // Log activity
      await this.databaseService.run(`
        INSERT INTO activity_logs (action_type, description, metadata)
        VALUES (?, ?, ?)
      `, ['session_deleted', `Session ${sessionId} deleted`, JSON.stringify({ sessionId })]);

      // Emit to frontend
      this.emit('session_deleted', {
        sessionId,
        timestamp: new Date()
      });

      this.logger.info(`Session ${sessionId} deleted`);
    } catch (error) {
      this.logger.error(`Error handling session deleted for ${sessionId}:`, error);
    }
  }

  /**
   * Check Support Bot for customer lookup
   * Returns true if message was processed by Support Bot
   */
  async checkSupportBotLookup(sessionId, message) {
    try {

      // Skip if Support Bot service not available
      if (!this.supportBotService) {
        return false;
      }


      // Parse the incoming message
      const parsedMessage = this.messageProcessor.parseIncomingMessage(message);


      // Skip if message is from the bot itself or empty
      if (!parsedMessage.from || parsedMessage.fromMe || !parsedMessage.text?.trim()) {
        return false;
      }


      // Process message through Support Bot service
      const processed = await this.supportBotService.processMessage(sessionId, message);


      return processed;
    } catch (error) {
      this.logger.error(`❌ EVENT SERVICE: Error checking Support Bot lookup:`, error);
      return false;
    }
  }

  /**
   * Check auto-reply rules with cooldown support
   */
  async checkAutoReplyRules(sessionId, message) {
    try {
      // Parse the incoming message
      const parsedMessage = this.messageProcessor.parseIncomingMessage(message);

      // Skip if message is from the bot itself or empty
      if (!parsedMessage.from || parsedMessage.fromMe || !parsedMessage.text?.trim()) return;

      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);

      // Always fetch fresh rules to avoid processing deleted rules
      const rulesResult = await this.databaseService.query(`
        SELECT * FROM auto_reply_rules
        WHERE session_id = ? AND is_active = 1
        ORDER BY priority ASC
      `, [sessionId]);

      if (!rulesResult.success || !rulesResult.data?.length) {
        this.logger.debug(`📧 No active auto-reply rules found for session ${sessionId}`);
        return;
      }

      this.logger.info(`📧 Found ${rulesResult.data.length} active auto-reply rules for session ${sessionId}`);

      const messageText = parsedMessage.text.toLowerCase().trim();
      const chatId = parsedMessage.from; // e.g., "1234567890@s.whatsapp.net" or "1234567890@g.us"
      const isGroupMessage = chatId?.endsWith('@g.us');

      for (const rule of rulesResult.data) {
        // Check target type filter
        const targetType = rule.target_type || 'all';
        let shouldReply = true;

        // Apply target type filtering
        if (targetType === 'individual' && isGroupMessage) {
          this.logger.info(`📧 Skipping auto-reply rule "${rule.name}" - configured for individual chats only, but message is from group`);
          shouldReply = false;
        } else if (targetType === 'group') {
          if (!isGroupMessage) {
            this.logger.info(`📧 Skipping auto-reply rule "${rule.name}" - configured for groups only, but message is from individual`);
            shouldReply = false;
          } else {
            // Check if this specific group is in the allowed list
            const targetGroups = rule.target_groups ? JSON.parse(rule.target_groups) : [];
            if (targetGroups.length > 0 && !targetGroups.includes(chatId)) {
              this.logger.info(`📧 Skipping auto-reply rule "${rule.name}" - group ${chatId} not in allowed groups list`);
              shouldReply = false;
            }
          }
        }

        if (shouldReply) {
          // Check cooldown period
          if (rule.cooldown_minutes > 0) {
            const cooldownCheck = await this.databaseService.get(`
              SELECT last_reply_at FROM auto_reply_cooldowns
              WHERE rule_id = ? AND user_phone = ?
            `, [rule.id, userPhone]);

            if (cooldownCheck) {
              const lastReply = new Date(cooldownCheck.last_reply_at);
              const now = new Date();
              const minutesSinceLastReply = (now - lastReply) / (1000 * 60);

              if (minutesSinceLastReply < rule.cooldown_minutes) {
                this.logger.info(`📧 ⏰ Auto-reply cooldown active for rule "${rule.name}" and user ${userPhone} (${minutesSinceLastReply.toFixed(1)} minutes ago, cooldown: ${rule.cooldown_minutes} minutes)`);
                continue; // Skip this rule due to cooldown
              } else {
                this.logger.info(`📧 ✅ Auto-reply cooldown expired for rule "${rule.name}" and user ${userPhone} (${minutesSinceLastReply.toFixed(1)} minutes ago, cooldown: ${rule.cooldown_minutes} minutes)`);
              }
            } else {
              this.logger.info(`📧 ✅ Auto-reply no previous cooldown record for rule "${rule.name}" and user ${userPhone}`);
            }
          }

          // Prepare response content
          let responseContent = rule.response;
          let messageType = 'text';
          let messageOptions = {};
          let replyResult;

          // If template is used, send it using sendTemplateMessage for proper attachment handling
          if (rule.template_id) {
            // Get the template data
            const template = await this.databaseService.get(
              'SELECT * FROM message_templates WHERE id = ?',
              [rule.template_id]
            );

            if (template) {

              // Prepare template variables for auto-reply context
              const templateVariables = {
                user_phone: userPhone,
                user_message: parsedMessage.text,
                name: userPhone.split('@')[0], // Extract phone number as name
                phone: userPhone.split('@')[0]
              };

              // Use sendTemplateMessage for proper attachment handling
              replyResult = await this.whatsappService.sendTemplateMessage(
                sessionId,
                parsedMessage.from,
                template,
                templateVariables
              );
            } else {
              this.logger.warn(`Template ${rule.template_id} not found for auto-reply rule ${rule.name}`);
              continue; // Skip this rule if template not found
            }
          } else {
            // Send regular text message
            replyResult = await this.whatsappService.sendMessage(
              sessionId,
              parsedMessage.from,
              responseContent,
              'text'
            );
          }

          if (replyResult.success) {
            // Update cooldown tracking
            if (rule.cooldown_minutes > 0) {
              const currentTimestamp = new Date().toISOString();
              await this.databaseService.run(`
                INSERT OR REPLACE INTO auto_reply_cooldowns (rule_id, user_phone, last_reply_at)
                VALUES (?, ?, ?)
              `, [rule.id, userPhone, currentTimestamp]);
              this.logger.info(`📧 ⏰ Updated cooldown record for auto-reply rule "${rule.name}" and user ${userPhone}`);
            }

            // Update rule usage count
            await this.databaseService.run(`
              UPDATE auto_reply_rules
              SET response_count = COALESCE(response_count, 0) + 1,
                  last_used = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `, [rule.id]);

            // Log auto-reply in message history
            await this.databaseService.run(`
              INSERT INTO message_history (
                session_id, contact_phone, content, message_type,
                direction, status, timestamp, created_at
              ) VALUES (?, ?, ?, ?, 'outgoing', 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [sessionId, userPhone, responseContent, messageType]);

            // Log activity
            await this.databaseService.run(`
              INSERT INTO activity_logs (action_type, description, metadata)
              VALUES (?, ?, ?)
            `, ['auto_reply_sent', `Auto-reply sent for rule "${rule.name}" to ${userPhone}`, JSON.stringify({
              sessionId,
              ruleId: rule.id,
              ruleName: rule.name,
              fromNumber: parsedMessage.from,
              userPhone: userPhone,
              userMessage: messageText,
              response: responseContent,
              messageType: messageType
            })]);

            this.logger.info(`Auto-reply sent for rule "${rule.name}" to ${userPhone}`);
          } else {
            this.logger.error(`Failed to send auto-reply for rule "${rule.name}" to ${userPhone}:`, replyResult.error);
          }

          break; // Only apply first matching rule (highest priority)
        }
      }
    } catch (error) {
      this.logger.error(`Error checking auto-reply rules for ${sessionId}:`, error);
      console.error('❌ Auto-reply error details:', error.message);
      console.error('❌ Auto-reply error stack:', error.stack);
    }
  }

  /**
   * Check chatbot triggers and manage conversations
   */
  async checkChatbotTriggers(sessionId, message) {
    try {
      this.logger.info(`🤖 Checking chatbot triggers for session ${sessionId}`);

      // Skip if message was already processed by AI chatbot system
      if (message._aiProcessed) {
        this.logger.info(`🤖 ⏭️ Skipping old chatbot flow - message already processed by AI chatbot system`);
        // Message already processed by AI
        return;
      }

      // Parse the incoming message
      const parsedMessage = this.messageProcessor.parseIncomingMessage(message);
      this.logger.info(`🤖 Parsed message: ${JSON.stringify(parsedMessage)}`);

      // Enhanced logging for button responses
      if (parsedMessage.type === 'interactive_response' || parsedMessage.type === 'button_response' || parsedMessage.type === 'list_response' || parsedMessage.type === 'interactive_list_response' || parsedMessage.type === 'template_button_response') {
        this.logger.info(`🤖 ✅ BUTTON/INTERACTIVE RESPONSE DETECTED! Type: ${parsedMessage.type}, Text: "${parsedMessage.text}"`);
      }

      // Skip if message is from the bot itself or empty
      if (!parsedMessage.from || parsedMessage.fromMe || !parsedMessage.text?.trim()) {
        this.logger.info(`🤖 Skipping chatbot check - fromMe: ${parsedMessage.fromMe}, text: "${parsedMessage.text}"`);
        return;
      }

      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);
      this.logger.info(`🤖 User phone: ${userPhone}, message text: "${parsedMessage.text}", message type: ${parsedMessage.type}`);
      // Checking for active conversation

      // Check if user has an active conversation
      const activeConversation = await this.databaseService.get(`
        SELECT cc.*, cf.name as flow_name, cf.is_active as flow_is_active FROM chatbot_conversations cc
        JOIN chatbot_flows cf ON cc.flow_id = cf.id
        WHERE cc.session_id = ? AND cc.user_phone = ? AND cc.is_active = 1
        ORDER BY cc.last_activity DESC
        LIMIT 1
      `, [sessionId, userPhone]);

      this.logger.info(`🤖 Active conversation check: ${activeConversation ? `Found conversation ID ${activeConversation.id}` : 'No active conversation'}`);
      // Active conversation checked

      if (activeConversation && activeConversation.id) {
        // Check if the flow is still active
        if (!activeConversation.flow_is_active) {
          this.logger.info(`🤖 Flow ${activeConversation.flow_id} is inactive, ending conversation ${activeConversation.id}`);
          await this.endChatbotConversation(activeConversation.id);
          // Check for new flow triggers instead
          await this.checkNewChatbotTriggers(sessionId, parsedMessage);
          return;
        }
        this.logger.info(`🤖 Found active conversation ${activeConversation.id}, checking if it should continue or restart`);

        // Check if the message matches a trigger keyword (restart flow)
        const originalMessageText = parsedMessage.text.trim();
        const flowsResult = await this.databaseService.all(`
          SELECT * FROM chatbot_flows
          WHERE session_id = ? AND is_active = 1
          ORDER BY id ASC
        `, [sessionId]);

        let shouldRestart = false;
        if (flowsResult.success && flowsResult.data) {
          for (const flow of flowsResult.data) {
            const matchType = flow.keyword_match_type || 'contains';
            const caseSensitive = flow.keyword_case_sensitive || false;

            const keywords = caseSensitive
              ? flow.trigger_keywords.split(',').map(k => k.trim())
              : flow.trigger_keywords.toLowerCase().split(',').map(k => k.trim());

            const testMessage = caseSensitive ? originalMessageText : originalMessageText.toLowerCase();

            const hasMatch = keywords.some(keyword =>
              this.messageProcessor.matchesKeyword(testMessage, keyword, matchType)
            );
            if (hasMatch) {
              this.logger.info(`🤖 Message "${originalMessageText}" matches trigger keyword, restarting flow`);
              shouldRestart = true;
              // End current conversation and start new one
              await this.endChatbotConversation(activeConversation.id);
              await this.startChatbotFlow(sessionId, parsedMessage, flow);
              break;
            }
          }
        }

        if (!shouldRestart) {
          // Continue existing conversation
          // Continuing existing conversation
          await this.processChatbotConversation(sessionId, parsedMessage, activeConversation);

          // Mark message as processed by flow-based chatbot to prevent AI interference
          message._flowProcessed = true;
        }
      } else {
        // Check for new flow triggers
        // Checking for new triggers
        await this.checkNewChatbotTriggers(sessionId, parsedMessage);
      }
    } catch (error) {
      this.logger.error(`Error checking chatbot triggers:`, error);
    }
  }

  /**
   * Check for new chatbot flow triggers
   */
  async checkNewChatbotTriggers(sessionId, parsedMessage) {
    try {
      this.logger.info(`🤖 Checking new chatbot triggers for session ${sessionId}`);

      // Always fetch fresh flows to avoid processing deleted flows
      const flowsResult = await this.databaseService.all(`
        SELECT * FROM chatbot_flows
        WHERE session_id = ? AND is_active = 1
        ORDER BY id ASC
      `, [sessionId]);

      this.logger.info(`🤖 Flows query result: ${JSON.stringify(flowsResult)}`);

      if (!flowsResult.success || !flowsResult.data) {
        this.logger.info(`🤖 No active chatbot flows found for session ${sessionId}`);
        return;
      }

      const flows = flowsResult.data;
      this.logger.info(`🤖 Found ${flows.length} active flows for session ${sessionId}`);

      // Log each active flow for debugging
      flows.forEach(flow => {
        this.logger.info(`🤖 Active flow: ${flow.name} (ID: ${flow.id}) - Keywords: ${flow.trigger_keywords}`);
      });

      const originalMessageText = parsedMessage.text.trim();
      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);
      const chatId = parsedMessage.from; // e.g., "1234567890@s.whatsapp.net" or "1234567890@g.us"
      const isGroupMessage = chatId?.endsWith('@g.us');
      this.logger.info(`🤖 Message text: "${originalMessageText}", User phone: ${userPhone}, Is group: ${isGroupMessage}`);

      for (const flow of flows) {
        // Check target type filter
        const targetType = flow.target_type || 'all';
        let shouldProcess = true;

        // Apply target type filtering
        if (targetType === 'individual' && isGroupMessage) {
          this.logger.info(`🤖 Skipping chatbot flow "${flow.name}" - configured for individual chats only, but message is from group`);
          shouldProcess = false;
        } else if (targetType === 'group') {
          if (!isGroupMessage) {
            this.logger.info(`🤖 Skipping chatbot flow "${flow.name}" - configured for groups only, but message is from individual`);
            shouldProcess = false;
          } else {
            // Check if this specific group is in the allowed list
            const targetGroups = flow.target_groups ? JSON.parse(flow.target_groups) : [];
            if (targetGroups.length > 0 && !targetGroups.includes(chatId)) {
              this.logger.info(`🤖 Skipping chatbot flow "${flow.name}" - group ${chatId} not in allowed groups list`);
              shouldProcess = false;
            }
          }
        }

        if (!shouldProcess) {
          continue; // Skip this flow
        }

        const matchType = flow.keyword_match_type || 'contains';
        const caseSensitive = flow.keyword_case_sensitive || false;

        const keywords = caseSensitive
          ? flow.trigger_keywords.split(',').map(k => k.trim())
          : flow.trigger_keywords.toLowerCase().split(',').map(k => k.trim());

        const testMessage = caseSensitive ? originalMessageText : originalMessageText.toLowerCase();

        this.logger.info(`🤖 Flow "${flow.name}" keywords: [${keywords.join(', ')}] (${matchType}, case-sensitive: ${caseSensitive})`);

        // Check if any trigger matches
        const hasMatch = keywords.some(keyword => {
          const match = this.messageProcessor.matchesKeyword(testMessage, keyword, matchType);
          this.logger.info(`🤖 Testing keyword "${keyword}" against "${testMessage}": ${match}`);
          return match;
        });

        this.logger.info(`🤖 Flow "${flow.name}" has match: ${hasMatch}`);

        if (hasMatch) {
          // Check per-user cooldown period for this flow
          if (flow.cooldown_minutes > 0) {
            const cooldownCheck = await this.databaseService.get(`
              SELECT last_triggered_at FROM chatbot_flow_cooldowns
              WHERE flow_id = ? AND user_phone = ?
            `, [flow.id, userPhone]);

            if (cooldownCheck) {
              const lastTriggered = new Date(cooldownCheck.last_triggered_at);
              const now = new Date();
              const minutesSinceLastTrigger = (now - lastTriggered) / (1000 * 60);

              if (minutesSinceLastTrigger < flow.cooldown_minutes) {
                this.logger.info(`🤖 ⏰ Chatbot flow "${flow.name}" cooldown active for user ${userPhone} (${minutesSinceLastTrigger.toFixed(1)} minutes ago, cooldown: ${flow.cooldown_minutes} minutes)`);
                continue; // Skip this flow due to cooldown
              } else {
                this.logger.info(`🤖 ✅ Chatbot flow "${flow.name}" cooldown expired for user ${userPhone} (${minutesSinceLastTrigger.toFixed(1)} minutes ago, cooldown: ${flow.cooldown_minutes} minutes)`);
              }
            } else {
              this.logger.info(`🤖 ✅ Chatbot flow "${flow.name}" no previous cooldown record for user ${userPhone}`);
            }
          }

          // Start new chatbot flow
          await this.startChatbotFlow(sessionId, parsedMessage, flow);

          // Mark message as processed by flow-based chatbot to prevent AI interference
          message._flowProcessed = true;
          break;
        }
      }
    } catch (error) {
      this.logger.error(`Error checking new chatbot triggers:`, error);
    }
  }

  /**
   * Start a new chatbot flow
   */
  async startChatbotFlow(sessionId, parsedMessage, flow) {
    try {
      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);

      // Get first node of the flow
      const firstNode = await this.databaseService.get(`
        SELECT * FROM chatbot_nodes
        WHERE flow_id = ?
        ORDER BY position ASC
        LIMIT 1
      `, [flow.id]);

      if (!firstNode) {
        this.logger.warn(`No nodes found for chatbot flow ${flow.id}`);
        return;
      }

      // Create new conversation
      const conversationResult = await this.databaseService.run(`
        INSERT INTO chatbot_conversations (
          session_id, flow_id, user_phone, current_node_id,
          conversation_data, is_active, started_at, last_activity
        ) VALUES (?, ?, ?, ?, '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [sessionId, flow.id, userPhone, firstNode.id]);

      if (conversationResult.success) {
        // Update flow statistics
        await this.databaseService.run(`
          UPDATE chatbot_flows
          SET conversation_count = COALESCE(conversation_count, 0) + 1,
              last_triggered = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [flow.id]);

        // Update per-user cooldown tracking
        if (flow.cooldown_minutes > 0) {
          const currentTimestamp = new Date().toISOString();
          await this.databaseService.run(`
            INSERT OR REPLACE INTO chatbot_flow_cooldowns (flow_id, user_phone, last_triggered_at)
            VALUES (?, ?, ?)
          `, [flow.id, userPhone, currentTimestamp]);
          this.logger.info(`🤖 ⏰ Updated cooldown record for flow "${flow.name}" and user ${userPhone}`);
        }

        // Send first node message
        await this.sendChatbotNodeMessage(sessionId, parsedMessage.from, firstNode, {
          conversationId: conversationResult.insertId,
          userPhone: userPhone,
          flowName: flow.name
        });

        // Check if there are more nodes in this flow
        const nextNode = await this.databaseService.get(`
          SELECT * FROM chatbot_nodes
          WHERE flow_id = ? AND position > ?
          ORDER BY position ASC
          LIMIT 1
        `, [flow.id, firstNode.position]);

        if (!nextNode) {
          // This is a single-node flow, end the conversation immediately
          await this.endChatbotConversation(conversationResult.insertId);
          this.logger.info(`Ended single-node chatbot flow "${flow.name}" for user ${userPhone}`);
        }

        this.logger.info(`Started chatbot flow "${flow.name}" for user ${userPhone}`);
      }
    } catch (error) {
      this.logger.error(`Error starting chatbot flow:`, error);
    }
  }

  /**
   * Process ongoing chatbot conversation
   */
  async processChatbotConversation(sessionId, parsedMessage, conversation) {
    try {
      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);

      // First, verify the flow still exists and is active
      const flow = await this.databaseService.get(`
        SELECT * FROM chatbot_flows WHERE id = ? AND is_active = 1
      `, [conversation.flow_id]);

      if (!flow) {
        this.logger.info(`🤖 Flow ${conversation.flow_id} not found or inactive, ending conversation ${conversation.id}`);
        await this.endChatbotConversation(conversation.id);
        return;
      }

      // Get current node
      const currentNode = await this.databaseService.get(`
        SELECT * FROM chatbot_nodes WHERE id = ?
      `, [conversation.current_node_id]);

      if (!currentNode) {
        // End conversation if node not found
        this.logger.info(`🤖 Node ${conversation.current_node_id} not found, ending conversation ${conversation.id}`);
        await this.endChatbotConversation(conversation.id);
        return;
      }

      // Update conversation activity
      await this.databaseService.run(`
        UPDATE chatbot_conversations
        SET last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [conversation.id]);

      // Process user response based on node type
      if (currentNode.node_type === 'question') {
        await this.processChatbotQuestionResponse(sessionId, parsedMessage, conversation, currentNode);
      } else {
        // For other node types, move to next node or end conversation
        await this.moveToNextChatbotNode(sessionId, parsedMessage.from, conversation, currentNode);
      }

    } catch (error) {
      this.logger.error(`Error processing chatbot conversation:`, error);
    }
  }

  /**
   * Process response to a chatbot question
   */
  async processChatbotQuestionResponse(sessionId, parsedMessage, conversation, currentNode) {
    try {
      this.logger.info(`🤖 Processing question response for node: ${currentNode.name} (ID: ${currentNode.id})`);
      const userResponse = parsedMessage.text.trim();
      const userPhone = this.messageProcessor.extractPhoneNumber(parsedMessage.from);

      // Processing question response

      // Parse conversation data
      let conversationData = await this.getConversationData(conversation.id);

      // Store user response
      conversationData[`node_${currentNode.id}_response`] = userResponse;
      conversationData.last_response = userResponse;
      conversationData.last_response_at = new Date().toISOString();

      // Extract variables based on node configuration
      if (currentNode.options) {
        try {
          const nodeConfig = JSON.parse(currentNode.options);

          // Handle both old array format and new object format
          let extractVariable = null;
          if (typeof nodeConfig === 'object' && !Array.isArray(nodeConfig)) {
            // New object format: { options: [...], extract_variable: "name" }
            extractVariable = nodeConfig.extract_variable;
          } else if (Array.isArray(nodeConfig)) {
            // Old array format - no variable extraction
            extractVariable = null;
          }

          // Check if this node should extract a specific variable
          if (extractVariable) {
            try {
              // Use smart extraction to get the relevant information
              const extractedValue = this.messageProcessor.extractSmartVariable(userResponse, extractVariable);
              conversationData[`custom_${extractVariable}`] = extractedValue;

              // Special handling for name extraction
              if (extractVariable === 'name' || extractVariable === 'user_name') {
                conversationData.user_name = extractedValue;
              }

              this.logger.info(`🤖 Variable extracted: ${extractVariable} = "${extractedValue}" from "${userResponse}"`);
            } catch (extractionError) {
              // Fallback to original behavior if smart extraction fails
              this.logger.warn(`Smart extraction failed for variable ${extractVariable}, falling back to full response:`, extractionError.message);
              conversationData[`custom_${extractVariable}`] = userResponse;

              // Special handling for name extraction
              if (extractVariable === 'name' || extractVariable === 'user_name') {
                conversationData.user_name = userResponse;
              }
            }
          }
        } catch (e) {
          this.logger.warn(`Invalid node configuration for node ${currentNode.id}:`, e.message);
        }
      }

      // Update conversation data
      await this.databaseService.run(`
        UPDATE chatbot_conversations
        SET conversation_data = ?
        WHERE id = ?
      `, [JSON.stringify(conversationData), conversation.id]);

      // Move to next node with user response
      this.logger.info(`🤖 About to move to next node from question: ${currentNode.name}`);
      await this.moveToNextChatbotNode(sessionId, parsedMessage.from, conversation, currentNode, userResponse);
      this.logger.info(`🤖 Successfully moved to next node from question: ${currentNode.name}`);

    } catch (error) {
      this.logger.error(`Error processing chatbot question response:`, error);
    }
  }

  /**
   * Move to next chatbot node or end conversation
   */
  async moveToNextChatbotNode(sessionId, userJid, conversation, currentNode, userResponse = null) {
    try {
      this.logger.info(`🤖 Moving to next node from current node: ${currentNode.name} (ID: ${currentNode.id})`);
      // Moving to next chatbot node
      let nextNode = null;

      // First, check if current node has a specific next_node_id
      if (currentNode.next_node_id) {
        this.logger.info(`🤖 Current node has next_node_id: ${currentNode.next_node_id}`);
        // Looking for next node

        // Always treat next_node_id as actual database ID (not position)
        nextNode = await this.databaseService.get(`
          SELECT * FROM chatbot_nodes WHERE id = ?
        `, [currentNode.next_node_id]);

        if (nextNode) {
          this.logger.info(`🤖 Found next node by ID: ${nextNode.name} (ID: ${nextNode.id})`);
          // Found next node
        } else {
          this.logger.warn(`🤖 Next node with ID ${currentNode.next_node_id} not found`);
          // Next node not found
        }
      }

      // If no specific next node, use position-based flow
      if (!nextNode) {
        nextNode = await this.databaseService.get(`
          SELECT * FROM chatbot_nodes
          WHERE flow_id = ? AND position > ?
          ORDER BY position ASC
          LIMIT 1
        `, [conversation.flow_id, currentNode.position]);
      }

      // Advanced flow logic: Handle conditional nodes and dynamic routing
      if (nextNode && nextNode.node_type === 'condition') {
        nextNode = await this.processConditionalNode(nextNode, conversation, userResponse);
      }

      // Handle action nodes - process them properly
      if (nextNode && nextNode.node_type === 'action') {
        this.logger.info(`🎬 Processing action node: ${nextNode.name}`);
        try {
          // Process the action node
          await this.processActionNode(nextNode, conversation, userResponse);
          this.logger.info(`🎬 Action node processed successfully: ${nextNode.name}`);
          // Get the next node after the action using next_node_id
          if (nextNode.next_node_id) {
            nextNode = await this.databaseService.get(`
              SELECT * FROM chatbot_nodes WHERE id = ?
            `, [nextNode.next_node_id]);
            this.logger.info(`🎬 Next node after action: ${nextNode ? nextNode.name : 'undefined'} (ID: ${nextNode ? nextNode.id : 'undefined'})`);
          } else {
            nextNode = null;
            this.logger.info(`🎬 Next node after action: END (no next_node_id)`);
          }
        } catch (actionError) {
          this.logger.error(`🎬 Error processing action node ${nextNode.name}:`, actionError);
          throw actionError;
        }
      }

      if (nextNode) {
        this.logger.info(`🤖 Found next node: ${nextNode.name} (ID: ${nextNode.id})`);

        // Update conversation to next node
        await this.databaseService.run(`
          UPDATE chatbot_conversations
          SET current_node_id = ?, last_activity = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [nextNode.id, conversation.id]);

        // Send next node message (unless it's another action node)
        if (nextNode.node_type !== 'action') {
          await this.sendChatbotNodeMessage(sessionId, userJid, nextNode, {
            conversationId: conversation.id,
            userPhone: this.messageProcessor.extractPhoneNumber(userJid),
            flowName: conversation.flow_name
          });
        } else {
          // If next node is also an action, process it immediately
          await this.moveToNextChatbotNode(sessionId, userJid, conversation, nextNode, userResponse);
        }
      } else {
        this.logger.info(`🤖 No next node found, ending conversation ${conversation.id}`);

        // End conversation - no more nodes
        await this.endChatbotConversation(conversation.id);

        // Send completion message if configured
        const flow = await this.databaseService.get(`
          SELECT fallback_message FROM chatbot_flows WHERE id = ?
        `, [conversation.flow_id]);

        this.logger.info(`🤖 Flow fallback_message: "${flow?.fallback_message}"`);

        if (flow && flow.fallback_message && flow.fallback_message.trim() !== '') {
          // Process variables in fallback message too
          const conversationData = await this.getConversationData(conversation.id);
          const messageContext = this.messageContextCache?.get(userJid) || null;

          const processedFallback = await this.messageProcessor.processChatbotMessage(
            flow.fallback_message,
            conversationData,
            sessionId,
            userJid,
            messageContext
          );

          this.logger.info(`🤖 Processed fallback content: "${processedFallback.content}"`);

          // Only send if the processed content is not empty
          if (processedFallback.content && processedFallback.content.trim() !== '') {
            await this.whatsappService.sendMessage(
              sessionId,
              userJid,
              processedFallback.content,
              'text'
            );
          } else {
            this.logger.info(`🤖 Skipping empty fallback message for flow ${conversation.flow_id}`);
          }
        } else {
          this.logger.info(`🤖 No fallback message configured for flow ${conversation.flow_id}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error moving to next chatbot node:`, error);

      // Safety mechanism: If there's an error, end the conversation to prevent getting stuck
      try {
        this.logger.info(`🤖 Ending conversation ${conversation.id} due to error to prevent getting stuck`);
        await this.endChatbotConversation(conversation.id);
      } catch (endError) {
        this.logger.error(`Error ending conversation after node error:`, endError);
      }
    }
  }

  /**
   * Send chatbot node message
   */
  async sendChatbotNodeMessage(sessionId, userJid, node, context = {}) {
    try {
      // Validate node exists
      if (!node) {
        this.logger.error('Cannot send chatbot node message: node is undefined or null');
        return { success: false, error: 'Node is undefined or null' };
      }

      // Get flow data to check for message delay
      let messageDelaySeconds = 0;
      if (context.conversationId) {
        try {
          const conversation = await this.databaseService.get(`
            SELECT flow_id FROM chatbot_conversations WHERE id = ?
          `, [context.conversationId]);

          if (conversation && conversation.flow_id) {
            const flow = await this.databaseService.get(`
              SELECT message_delay_seconds FROM chatbot_flows WHERE id = ?
            `, [conversation.flow_id]);

            if (flow && flow.message_delay_seconds) {
              messageDelaySeconds = flow.message_delay_seconds;
              this.logger.info(`🕐 Message delay configured: ${messageDelaySeconds} seconds for flow ${conversation.flow_id}`);
            }
          }
        } catch (delayError) {
          this.logger.warn('Error getting message delay setting:', delayError);
          // Continue without delay if there's an error
        }
      }

      // Apply delay if configured
      if (messageDelaySeconds > 0) {
        this.logger.info(`⏳ Waiting ${messageDelaySeconds} seconds before sending message...`);
        await new Promise(resolve => setTimeout(resolve, messageDelaySeconds * 1000));
      }

      let messageContent = node.message || '';
      let messageType = 'text';
      let messageOptions = {};

      // Debug logging
      this.logger.info(`Sending chatbot node message: ${node.name}, content: "${messageContent}", type: ${messageType}`);

      // Get conversation data for variable replacement
      let conversationData = {};
      if (context.conversationId) {
        try {
          const conversation = await this.databaseService.get(`
            SELECT conversation_data FROM chatbot_conversations WHERE id = ?
          `, [context.conversationId]);

          if (conversation && conversation.conversation_data) {
            conversationData = JSON.parse(conversation.conversation_data);
          }
        } catch (error) {
          this.logger.warn(`Could not load conversation data for ID ${context.conversationId}:`, error.message);
        }
      }

      // Process template if specified
      if (node.template_id) {
        // For templates, we'll use sendTemplateMessage for better attachment handling
        // First get the template data
        const template = await this.databaseService.get(
          'SELECT * FROM message_templates WHERE id = ?',
          [node.template_id]
        );

        if (template) {

          // Prepare template variables
          const templateVariables = {
            user_phone: context.userPhone,
            flow_name: context.flowName,
            node_name: node.name,
            name: context.userPhone.split('@')[0], // Extract phone number as name
            phone: context.userPhone.split('@')[0],
            ...conversationData
          };

          // Use sendTemplateMessage for proper attachment handling
          result = await this.whatsappService.sendTemplateMessage(
            sessionId,
            userJid,
            template,
            templateVariables
          );

          // Return early since we've sent the message
          return result;
        } else {
          this.logger.warn(`Template ${node.template_id} not found for chatbot node ${node.name}`);
          // Fall back to processing as regular message
        }
      } else {
        // Process message content with variable replacement even without template
        // Get cached message context for contact name resolution
        const messageContext = this.messageContextCache?.get(userJid) || null;

        const processedResult = await this.messageProcessor.processChatbotMessage(
          messageContent,
          conversationData,
          sessionId,
          userJid,
          messageContext
        );

        if (processedResult.success) {
          messageContent = processedResult.content;
        }
      }

      // Safety check: ensure messageContent is a valid string
      if (typeof messageContent !== 'string') {
        this.logger.error(`🤖 ❌ Invalid message content type: ${typeof messageContent}, content: ${JSON.stringify(messageContent)}`);
        messageContent = String(messageContent || 'Sorry, there was an error processing this message.');
      }

      // Additional safety check for [object Object]
      if (messageContent === '[object Object]') {
        this.logger.error(`🤖 ❌ Detected [object Object] in message content, replacing with fallback`);
        messageContent = 'Sorry, there was an error processing this message.';
      }

      // Process attachment if present
      if (node.attachment_data && node.attachment_type) {
        messageType = node.attachment_type;
        messageOptions = {
          caption: messageContent || ''
        };
        // For attachments, we need to format the content differently
        // The attachment data is the URL/base64, and the text becomes the caption
      }

      // Add options for question nodes
      if (node.node_type === 'question' && node.options) {
        try {
          const nodeConfig = JSON.parse(node.options);
          let optionsList = [];

          // Handle both old array format and new object format
          if (typeof nodeConfig === 'object' && !Array.isArray(nodeConfig)) {
            // New object format: { options: [...], extract_variable: "name" }
            optionsList = nodeConfig.options || [];
          } else if (Array.isArray(nodeConfig)) {
            // Old array format
            optionsList = nodeConfig;
          }

          if (optionsList.length > 0) {
            // Check if we should use interactive buttons or text options
            const interactionType = (typeof nodeConfig === 'object' && !Array.isArray(nodeConfig)) ? nodeConfig.interaction_type : 'buttons';
            const useInteractiveButtons = interactionType === 'buttons' && optionsList.length <= 3 && messageType === 'text';

            if (useInteractiveButtons) {
              // Use interactive buttons for better UX - format for Baileys library
              messageType = 'interactive';
              messageOptions = {
                text: messageContent,  // Main message text
                footer: 'Choose an option:',  // Footer text
                buttons: optionsList.map((option, index) => {
                  let optionText = '';
                  let optionId = '';

                  if (typeof option === 'string') {
                    optionText = option;
                    optionId = `option_${index + 1}`;
                  } else if (typeof option === 'object' && option !== null) {
                    optionText = option.display_text || option.title || option.name || option.text || option.value || `Option ${index + 1}`;
                    optionId = option.id || `option_${index + 1}`;
                  } else {
                    optionText = String(option || `Option ${index + 1}`);
                    optionId = `option_${index + 1}`;
                  }

                  return {
                    buttonId: optionId,  // Button ID for callback
                    buttonText: { displayText: optionText },  // Button display text
                    type: 1  // Button type (required by Baileys)
                  };
                }),
                headerType: 1  // Header type (required by Baileys)
              };
              messageContent = messageOptions; // For interactive messages, content is the full object
            } else {
              // Fallback to text-based options for more than 3 options or non-text messages
              const formattedOptions = optionsList.map((opt, index) => {
                let optionText = '';
                if (typeof opt === 'string') {
                  optionText = opt;
                } else if (typeof opt === 'object' && opt !== null) {
                  // Handle object format: {display_text: "text", id: "id", title: "title"}
                  optionText = opt.display_text || opt.title || opt.name || opt.text || opt.value || String(opt);
                } else {
                  optionText = String(opt || '');
                }
                return `${index + 1}. ${optionText}`;
              });

              const optionsText = '\n\nOptions:\n' + formattedOptions.join('\n');
              if (messageType === 'text') {
                messageContent += optionsText;
              } else {
                // For media messages, add options to caption
                messageOptions.caption = (messageOptions.caption || '') + optionsText;
              }
            }
          }
        } catch (e) {
          this.logger.warn(`Invalid options JSON for node ${node.id}:`, e.message);
        }
      }

      // Send message based on type
      let result;

      if (node.attachment_data && node.attachment_type && !node.template_id) {
        // For direct attachments, send using the proper media format
        let attachmentContent = {};

        // Check if it's base64 data
        if (node.attachment_data.startsWith('data:')) {
          // Convert base64 data URL to buffer
          const base64Data = node.attachment_data.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');

          switch (node.attachment_type) {
            case 'image':
              attachmentContent = {
                image: buffer,
                caption: messageContent || ''
              };
              break;
            case 'video':
              attachmentContent = {
                video: buffer,
                caption: messageContent || ''
              };
              break;
            case 'audio':
              attachmentContent = {
                audio: buffer,
                mimetype: 'audio/mp4'
              };
              break;
            case 'document':
              attachmentContent = {
                document: buffer,
                fileName: 'document.pdf',
                caption: messageContent || ''
              };
              break;
          }
        } else {
          // Handle URL format
          attachmentContent = {
            [node.attachment_type]: { url: node.attachment_data },
            caption: messageContent || ''
          };
        }

        result = await this.whatsappService.sendMessage(
          sessionId,
          userJid,
          attachmentContent,
          messageType,
          messageOptions
        );
      } else {
        // For text messages or templates, send with proper format
        if (messageType === 'text') {
          // Check if messageContent is empty before sending
          if (!messageContent || messageContent.trim() === '') {
            this.logger.info(`🤖 ⏭️ Skipping empty text message for node: ${node.name}`);
            return { success: true, skipped: true, reason: 'Empty message content' };
          }

          result = await this.whatsappService.sendMessage(
            sessionId,
            userJid,
            { text: messageContent },
            messageType,
            messageOptions
          );
        } else if (messageType === 'interactive') {
          // For interactive messages, send the content object directly without formatting
          result = await this.whatsappService.sendMessage(
            sessionId,
            userJid,
            messageContent, // messageContent is already the properly formatted object
            messageType,
            messageOptions
          );
        } else {
          // For templates, format the content properly before sending
          const formattedContent = this.messageProcessor.formatMessageContent(
            messageContent,
            messageType,
            messageOptions
          );

          if (messageType === 'mixed_buttons') {
            // For mixed buttons, send the formatted content directly
            result = await this.whatsappService.sendMessage(
              sessionId,
              userJid,
              formattedContent,
              messageType
            );
          } else {
            // For other message types, include messageOptions
            result = await this.whatsappService.sendMessage(
              sessionId,
              userJid,
              formattedContent,
              messageType,
              messageOptions
            );
          }
        }
      }

      if (result.success) {
        this.logger.info(`Chatbot node message sent: ${node.name} (${messageType}) to ${context.userPhone}`);
      } else {
        this.logger.error(`Failed to send chatbot node message: ${result.error}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Error sending chatbot node message:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * End chatbot conversation
   */
  async endChatbotConversation(conversationId) {
    try {
      await this.databaseService.run(`
        UPDATE chatbot_conversations
        SET is_active = 0, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [conversationId]);

      this.logger.info(`Ended chatbot conversation ${conversationId}`);
    } catch (error) {
      this.logger.error(`Error ending chatbot conversation:`, error);
    }
  }

  /**
   * Check call responder rules (deprecated - now handled in whatsapp.service.js)
   */
  async checkCallResponderRules(sessionId, call) {
    // This function is deprecated and no longer used
    // Call responder logic is now handled in whatsapp.service.js processCallResponderRules()
    // This prevents duplicate processing and ensures proper call type mapping
  }

  /**
   * Update contact from message
   */
  async updateContactFromMessage(message) {
    try {
      const phoneNumber = message.from.split('@')[0];
      
      // Check if contact exists
      const existingContact = await this.databaseService.get(
        'SELECT id FROM contacts WHERE phone_number = ?',
        [phoneNumber]
      );

      if (!existingContact) {
        // Create new contact
        await this.databaseService.run(`
          INSERT INTO contacts (phone_number, name, last_message_at, created_at, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [phoneNumber, phoneNumber, message.timestamp]);
      } else {
        // Update last message time
        await this.databaseService.run(`
          UPDATE contacts 
          SET last_message_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE phone_number = ?
        `, [message.timestamp, phoneNumber]);
      }
    } catch (error) {
      this.logger.error(`Error updating contact from message:`, error);
    }
  }

  /**
   * Process action node logic
   */
  async processActionNode(actionNode, conversation, userResponse) {
    try {
      this.logger.info(`🎬 Processing action node: ${actionNode.name}`);

      // Parse action configuration
      let actionConfig = {};
      try {
        actionConfig = JSON.parse(actionNode.options || '{}');
      } catch (e) {
        this.logger.warn(`Invalid action configuration for node ${actionNode.id}`);
        // Return next node using next_node_id
        if (actionNode.next_node_id) {
          return await this.databaseService.get(`
            SELECT * FROM chatbot_nodes WHERE id = ?
          `, [actionNode.next_node_id]);
        }
        return null;
      }

      // Get conversation data for variable replacement
      const conversationData = await this.getConversationData(conversation.id);

      // Execute the action based on type
      this.logger.info(`🎬 Action type: ${actionConfig.action_type}`);
      switch (actionConfig.action_type) {
        case 'email':
          this.logger.info(`🎬 Calling executeEmailAction`);
          await this.executeEmailAction(actionConfig, conversationData, conversation);
          this.logger.info(`🎬 executeEmailAction completed`);
          break;

        case 'webhook':
          await this.executeWebhookAction(actionConfig, conversationData, conversation);
          break;

        case 'api_call':
          await this.executeApiCallAction(actionConfig, conversationData, conversation);
          break;

        case 'save_data':
          await this.executeSaveDataAction(actionConfig, conversationData, conversation);
          break;

        case 'delay':
          await this.executeDelayAction(actionConfig);
          break;

        default:
          this.logger.warn(`Unknown action type: ${actionConfig.action_type}`);
      }

      // Return next node using next_node_id
      if (actionNode.next_node_id) {
        return await this.databaseService.get(`
          SELECT * FROM chatbot_nodes WHERE id = ?
        `, [actionNode.next_node_id]);
      }
      return null;

    } catch (error) {
      this.logger.error(`Error processing action node:`, error);
      // Return next node using next_node_id even in error case
      if (actionNode.next_node_id) {
        return await this.databaseService.get(`
          SELECT * FROM chatbot_nodes WHERE id = ?
        `, [actionNode.next_node_id]);
      }
      return null;
    }
  }

  /**
   * Process conditional node logic (Enhanced Implementation)
   */
  async processConditionalNode(conditionalNode, conversation, userResponse) {
    try {
      this.logger.info(`🔀 Processing condition node: ${conditionalNode.name}`);

      // Parse condition configuration from node options
      let conditionConfig = {};
      try {
        conditionConfig = JSON.parse(conditionalNode.options || '{}');
      } catch (e) {
        this.logger.warn(`Invalid condition configuration for node ${conditionalNode.id}`);
        return null;
      }

      // Get conversation data for condition evaluation
      const conversationData = await this.getConversationData(conversation.id);

      const conditionType = conditionConfig.condition_type || 'user_response';
      this.logger.info(`🔀 Evaluating condition type: ${conditionType}`);

      let conditionResult = false;
      let nextNodeId = null;

      // Evaluate condition based on type
      switch (conditionType) {
        case 'user_response':
          conditionResult = await this.evaluateUserResponseCondition(conditionConfig, userResponse);
          break;

        case 'variable_value':
          conditionResult = await this.evaluateVariableCondition(conditionConfig, conversationData);
          break;

        case 'time_based':
          conditionResult = await this.evaluateTimeCondition(conditionConfig);
          break;

        case 'random':
          // Random selection returns the node directly
          return await this.evaluateRandomCondition(conditionConfig);

        default:
          this.logger.warn(`Unknown condition type: ${conditionType}`);
          return null;
      }

      // Determine next node based on condition result
      if (conditionResult) {
        nextNodeId = conditionConfig.true_path;
        this.logger.info(`🔀 Condition TRUE - routing to node: ${nextNodeId}`);
      } else {
        nextNodeId = conditionConfig.false_path;
        this.logger.info(`🔀 Condition FALSE - routing to node: ${nextNodeId}`);
      }

      // Return the next node if specified
      if (nextNodeId) {
        return await this.databaseService.get(`
          SELECT * FROM chatbot_nodes WHERE id = ?
        `, [nextNodeId]);
      }

      // If no path specified, end conversation
      this.logger.info(`🔀 No path specified for condition result, ending conversation`);
      return null;

    } catch (error) {
      this.logger.error(`Error processing conditional node:`, error);
      return null;
    }
  }

  /**
   * Get next node in sequence (by position)
   */
  async getNextNodeInSequence(currentNode) {
    try {
      return await this.databaseService.get(`
        SELECT * FROM chatbot_nodes
        WHERE flow_id = ? AND position > ?
        ORDER BY position ASC
        LIMIT 1
      `, [currentNode.flow_id, currentNode.position]);
    } catch (error) {
      this.logger.error(`Error getting next node in sequence:`, error);
      return null;
    }
  }

  /**
   * Replace variables in text with conversation data
   */
  replaceVariables(text, conversationData) {
    if (!text || typeof text !== 'string') return text;

    let result = text;

    // Replace {{variable_name}} with actual values
    const variableRegex = /\{\{([^}]+)\}\}/g;
    result = result.replace(variableRegex, (match, variableName) => {
      const value = conversationData[variableName] || conversationData[`custom_${variableName}`] || '';
      return value;
    });

    return result;
  }

  /**
   * Execute email action
   */
  async executeEmailAction(actionConfig, conversationData, conversation) {
    try {
      this.logger.info(`📧 Executing email action`);
      this.logger.info(`📧 Action config:`, JSON.stringify(actionConfig, null, 2));
      this.logger.info(`📧 Conversation data:`, JSON.stringify(conversationData, null, 2));

      // Check if email service is available
      if (!this.emailService) {
        this.logger.info(`📧 Email service not available, creating new instance`);
        const EmailService = require('./email.service');
        this.emailService = new EmailService();
        this.emailService.setDatabaseService(this.databaseService);
        await this.emailService.initialize();
        this.logger.info(`📧 Email service created and initialized`);
      } else {
        this.logger.info(`📧 Email service available`);
      }

      // Validate required fields
      const recipients = actionConfig.email_recipients;
      if (!recipients) {
        this.logger.warn(`Email action missing recipients`);
        return;
      }

      let emailData;

      // Check if using email template
      if (actionConfig.email_template) {
        try {
          this.logger.info(`📧 Processing email template ID: ${actionConfig.email_template}`);

          // Check if processEmailTemplate method exists
          if (typeof this.emailService.processEmailTemplate !== 'function') {
            this.logger.error(`📧 processEmailTemplate method not found on email service`);
            throw new Error('processEmailTemplate method not available');
          }

          const templateData = await this.emailService.processEmailTemplate(
            actionConfig.email_template,
            conversationData
          );

          this.logger.info(`📧 Template processed successfully:`, templateData);

          emailData = {
            to: this.replaceVariables(recipients, conversationData),
            cc: actionConfig.email_cc ? this.replaceVariables(actionConfig.email_cc, conversationData) : null,
            bcc: actionConfig.email_bcc ? this.replaceVariables(actionConfig.email_bcc, conversationData) : null,
            subject: templateData.subject,
            html: templateData.html,
            text: templateData.text,
            template_id: actionConfig.email_template,
            conversation_id: conversation.id
          };
        } catch (templateError) {
          this.logger.error(`📧 Error processing email template:`, templateError);
          this.logger.info(`📧 Falling back to custom email content`);

          // Fallback to custom email content
          const subject = this.replaceVariables(actionConfig.email_subject || 'Thank you for contacting us', conversationData);
          const body = this.replaceVariables(actionConfig.email_body || 'Thank you for providing your email address. We will get back to you soon.', conversationData);

          emailData = {
            to: this.replaceVariables(recipients, conversationData),
            cc: actionConfig.email_cc ? this.replaceVariables(actionConfig.email_cc, conversationData) : null,
            bcc: actionConfig.email_bcc ? this.replaceVariables(actionConfig.email_bcc, conversationData) : null,
            subject: subject,
            html: body,
            text: body,
            conversation_id: conversation.id
          };
        }
      } else {
        // Use custom email content
        const subject = this.replaceVariables(actionConfig.email_subject || 'Notification', conversationData);
        const body = this.replaceVariables(actionConfig.email_body || '', conversationData);

        if (!subject.trim()) {
          this.logger.warn(`Email action missing subject`);
          return;
        }

        emailData = {
          to: this.replaceVariables(recipients, conversationData),
          cc: actionConfig.email_cc ? this.replaceVariables(actionConfig.email_cc, conversationData) : null,
          bcc: actionConfig.email_bcc ? this.replaceVariables(actionConfig.email_bcc, conversationData) : null,
          subject: subject,
          conversation_id: conversation.id
        };

        // Set content based on format
        if (actionConfig.email_format === 'text') {
          emailData.text = body;
        } else {
          emailData.html = body;
          emailData.text = body.replace(/<[^>]*>/g, ''); // Strip HTML for text version
        }
      }

      // Add email options
      if (actionConfig.email_high_priority) {
        emailData.priority = 'high';
      }

      if (actionConfig.email_request_receipt) {
        emailData.requestReceipt = true;
      }

      // Handle attachments
      if (actionConfig.email_attachments && actionConfig.email_attachments.length > 0) {
        emailData.attachments = actionConfig.email_attachments.map(attachment => ({
          filename: attachment.name || attachment.filename,
          path: attachment.path || attachment.url,
          contentType: attachment.type || attachment.contentType
        }));
      }

      // Handle delivery timing
      if (actionConfig.email_delivery_timing === 'delayed' && actionConfig.email_delay_minutes > 0) {
        // Schedule email for later (implement scheduling logic)
        this.logger.info(`📧 Email scheduled for ${actionConfig.email_delay_minutes} minutes delay`);
        setTimeout(async () => {
          const result = await this.emailService.sendEmail(emailData);
          this.logger.info(`📧 Delayed email result:`, result);
        }, actionConfig.email_delay_minutes * 60 * 1000);
      } else {
        // Send immediately
        const result = await this.emailService.sendEmail(emailData);

        if (result.success) {
          this.logger.info(`📧 Email sent successfully to ${emailData.to}`, { messageId: result.messageId });
        } else {
          this.logger.error(`📧 Failed to send email:`, result.error);
        }
      }

    } catch (error) {
      this.logger.error(`Error executing email action:`, error);
    }
  }

  /**
   * Execute webhook action
   */
  async executeWebhookAction(actionConfig, conversationData, conversation) {
    try {
      this.logger.info(`🔗 Executing webhook action`);

      const webhookUrl = actionConfig.webhook_url;
      if (!webhookUrl) {
        this.logger.warn(`Webhook action missing URL`);
        return;
      }

      const payload = {
        conversation_id: conversation.id,
        flow_name: conversation.flow_name,
        user_phone: conversationData.user_phone,
        conversation_data: conversationData,
        timestamp: new Date().toISOString()
      };

      // Send webhook request
      const fetch = require('node-fetch');
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      this.logger.info(`🔗 Webhook sent to ${webhookUrl}, status: ${response.status}`);

    } catch (error) {
      this.logger.error(`Error executing webhook action:`, error);
    }
  }

  /**
   * Execute API call action
   */
  async executeApiCallAction(actionConfig, conversationData, conversation) {
    try {
      this.logger.info(`🌐 Executing API call action`);

      const endpoint = actionConfig.api_endpoint;
      const method = actionConfig.api_method || 'POST';

      if (!endpoint) {
        this.logger.warn(`API call action missing endpoint`);
        return;
      }

      // Parse headers
      let headers = { 'Content-Type': 'application/json' };
      if (actionConfig.api_headers) {
        try {
          const customHeaders = JSON.parse(this.replaceVariables(actionConfig.api_headers, conversationData));
          headers = { ...headers, ...customHeaders };
        } catch (e) {
          this.logger.warn(`Invalid API headers JSON`);
        }
      }

      // Parse body
      let body = null;
      if (actionConfig.api_body && method !== 'GET') {
        try {
          const bodyTemplate = this.replaceVariables(actionConfig.api_body, conversationData);
          body = JSON.stringify(JSON.parse(bodyTemplate));
        } catch (e) {
          this.logger.warn(`Invalid API body JSON`);
        }
      }

      // Make API call
      const fetch = require('node-fetch');
      const response = await fetch(endpoint, {
        method: method,
        headers: headers,
        body: body
      });

      this.logger.info(`🌐 API call to ${endpoint}, method: ${method}, status: ${response.status}`);

    } catch (error) {
      this.logger.error(`Error executing API call action:`, error);
    }
  }

  /**
   * Execute save data action
   */
  async executeSaveDataAction(actionConfig, conversationData, conversation) {
    try {
      this.logger.info(`💾 Executing save data action`);

      const fieldsToSave = actionConfig.save_data_fields || [];

      if (fieldsToSave.length === 0) {
        this.logger.warn(`Save data action has no fields specified`);
        return;
      }

      // Prepare data to save
      const dataToSave = {};
      fieldsToSave.forEach(field => {
        if (conversationData[field] !== undefined) {
          dataToSave[field] = conversationData[field];
        } else if (conversationData[`custom_${field}`] !== undefined) {
          dataToSave[field] = conversationData[`custom_${field}`];
        }
      });

      // Save to database (you can customize this based on your needs)
      await this.databaseService.run(`
        INSERT INTO chatbot_saved_data (conversation_id, flow_id, data, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `, [conversation.id, conversation.flow_id, JSON.stringify(dataToSave)]);

      this.logger.info(`💾 Saved data:`, dataToSave);

    } catch (error) {
      this.logger.error(`Error executing save data action:`, error);
    }
  }

  /**
   * Execute delay action
   */
  async executeDelayAction(actionConfig) {
    try {
      const delaySeconds = actionConfig.delay_seconds || 5;
      this.logger.info(`⏰ Executing delay action: ${delaySeconds} seconds`);

      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));

    } catch (error) {
      this.logger.error(`Error executing delay action:`, error);
    }
  }

  /**
   * Evaluate user response condition (Enhanced)
   */
  async evaluateUserResponseCondition(conditionConfig, userResponse) {
    try {
      const responseConditions = conditionConfig.response_conditions || [];
      const userText = (userResponse || '').toLowerCase().trim();

      this.logger.info(`🔀 Evaluating user response: "${userResponse}" against ${responseConditions.length} conditions`);

      if (!userText) {
        this.logger.info(`🔀 Empty user response`);
        return false;
      }

      // Check each response condition
      for (const condition of responseConditions) {
        const keyword = (condition.keyword || '').toLowerCase().trim();
        const operator = condition.operator || 'contains';

        if (!keyword) continue;

        let matches = false;

        switch (operator) {
          case 'equals':
            matches = userText === keyword;
            break;
          case 'contains':
            matches = userText.includes(keyword);
            break;
          case 'starts_with':
            matches = userText.startsWith(keyword);
            break;
          case 'ends_with':
            matches = userText.endsWith(keyword);
            break;
          case 'regex':
            try {
              const regex = new RegExp(keyword, 'i');
              matches = regex.test(userText);
            } catch (e) {
              this.logger.warn(`Invalid regex pattern: ${keyword}`);
              matches = false;
            }
            break;
          default:
            matches = userText.includes(keyword);
        }

        if (matches) {
          this.logger.info(`🔀 User response condition matched: "${keyword}" (${operator})`);
          return true;
        }
      }

      this.logger.info(`🔀 No user response conditions matched`);
      return false;
    } catch (error) {
      this.logger.error(`Error evaluating user response condition:`, error);
      return false;
    }
  }

  /**
   * Evaluate variable condition (Enhanced)
   */
  async evaluateVariableCondition(conditionConfig, conversationData) {
    try {
      const variableName = conditionConfig.condition_variable;
      const operator = conditionConfig.condition_operator || 'equals';
      const expectedValue = conditionConfig.condition_value || '';

      this.logger.info(`🔀 Evaluating variable condition: ${variableName} ${operator} "${expectedValue}"`);

      if (!variableName) {
        this.logger.warn(`🔀 No variable name specified for condition`);
        return false;
      }

      // Get actual value from conversation data
      const actualValue = conversationData[variableName] ||
                         conversationData[`custom_${variableName}`] ||
                         '';

      this.logger.info(`🔀 Variable "${variableName}" has value: "${actualValue}"`);

      let result = false;

      switch (operator) {
        case 'equals':
          result = actualValue.toString() === expectedValue.toString();
          break;

        case 'not_equals':
          result = actualValue.toString() !== expectedValue.toString();
          break;

        case 'contains':
          result = actualValue.toString().toLowerCase().includes(expectedValue.toLowerCase());
          break;

        case 'not_contains':
          result = !actualValue.toString().toLowerCase().includes(expectedValue.toLowerCase());
          break;

        case 'starts_with':
          result = actualValue.toString().toLowerCase().startsWith(expectedValue.toLowerCase());
          break;

        case 'ends_with':
          result = actualValue.toString().toLowerCase().endsWith(expectedValue.toLowerCase());
          break;

        case 'is_empty':
          result = !actualValue || actualValue.toString().trim() === '';
          break;

        case 'is_not_empty':
          result = actualValue && actualValue.toString().trim() !== '';
          break;

        case 'greater_than':
          const numActual = parseFloat(actualValue);
          const numExpected = parseFloat(expectedValue);
          result = !isNaN(numActual) && !isNaN(numExpected) && numActual > numExpected;
          break;

        case 'less_than':
          const numActual2 = parseFloat(actualValue);
          const numExpected2 = parseFloat(expectedValue);
          result = !isNaN(numActual2) && !isNaN(numExpected2) && numActual2 < numExpected2;
          break;

        case 'regex':
          try {
            const regex = new RegExp(expectedValue, 'i');
            result = regex.test(actualValue.toString());
          } catch (e) {
            this.logger.warn(`Invalid regex pattern: ${expectedValue}`);
            result = false;
          }
          break;

        default:
          this.logger.warn(`Unknown operator: ${operator}`);
          result = false;
      }

      this.logger.info(`🔀 Variable condition result: ${result}`);
      return result;

    } catch (error) {
      this.logger.error(`Error evaluating variable condition:`, error);
      return false;
    }
  }

  /**
   * Evaluate time-based condition (Enhanced)
   */
  async evaluateTimeCondition(conditionConfig) {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const currentTime = currentHour * 60 + currentMinute; // Minutes since midnight

      this.logger.info(`🔀 Evaluating time condition at ${currentHour}:${currentMinute.toString().padStart(2, '0')} (Day: ${currentDay})`);

      const timeType = conditionConfig.time_type || 'business_hours';

      let result = false;

      switch (timeType) {
        case 'business_hours':
          // Default: Monday-Friday, 9 AM to 6 PM
          const startHour = conditionConfig.start_hour || 9;
          const endHour = conditionConfig.end_hour || 18;
          const workDays = conditionConfig.work_days || [1, 2, 3, 4, 5]; // Mon-Fri

          result = workDays.includes(currentDay) &&
                   currentHour >= startHour &&
                   currentHour < endHour;
          break;

        case 'specific_hours':
          // Check if current time is within specified range
          const startTime = this.parseTimeString(conditionConfig.start_time || '09:00');
          const endTime = this.parseTimeString(conditionConfig.end_time || '18:00');

          if (startTime <= endTime) {
            // Same day range
            result = currentTime >= startTime && currentTime <= endTime;
          } else {
            // Overnight range (e.g., 22:00 to 06:00)
            result = currentTime >= startTime || currentTime <= endTime;
          }
          break;

        case 'weekend':
          result = currentDay === 0 || currentDay === 6; // Saturday or Sunday
          break;

        case 'weekday':
          result = currentDay >= 1 && currentDay <= 5; // Monday to Friday
          break;

        case 'specific_day':
          const targetDay = conditionConfig.target_day || 1; // Default Monday
          result = currentDay === targetDay;
          break;

        case 'after_hour':
          const afterHour = conditionConfig.after_hour || 18;
          result = currentHour >= afterHour;
          break;

        case 'before_hour':
          const beforeHour = conditionConfig.before_hour || 9;
          result = currentHour < beforeHour;
          break;

        default:
          // Default to business hours
          result = currentDay >= 1 && currentDay <= 5 && currentHour >= 9 && currentHour < 18;
      }

      this.logger.info(`🔀 Time condition (${timeType}) result: ${result}`);
      return result;

    } catch (error) {
      this.logger.error(`Error evaluating time condition:`, error);
      return false;
    }
  }

  /**
   * Parse time string (HH:MM) to minutes since midnight
   */
  parseTimeString(timeStr) {
    try {
      const [hours, minutes] = timeStr.split(':').map(Number);
      return hours * 60 + (minutes || 0);
    } catch (error) {
      this.logger.warn(`Invalid time format: ${timeStr}`);
      return 0;
    }
  }

  /**
   * Evaluate random condition (Enhanced)
   */
  async evaluateRandomCondition(conditionConfig) {
    try {
      const randomPaths = conditionConfig.random_paths || [];

      this.logger.info(`🔀 Evaluating random condition with ${randomPaths.length} paths`);

      if (randomPaths.length === 0) {
        this.logger.warn(`🔀 No random paths configured`);
        return null;
      }

      // Calculate total weight
      const totalWeight = randomPaths.reduce((sum, path) => sum + (path.weight || 1), 0);
      this.logger.info(`🔀 Total weight: ${totalWeight}`);

      // Generate random number
      const random = Math.random() * totalWeight;
      this.logger.info(`🔀 Random number: ${random}`);

      // Find the selected path
      let currentWeight = 0;
      for (const path of randomPaths) {
        const pathWeight = path.weight || 1;
        currentWeight += pathWeight;

        this.logger.info(`🔀 Checking path: weight=${pathWeight}, cumulative=${currentWeight}, nextNode=${path.nextNode}`);

        if (random <= currentWeight && path.nextNode) {
          this.logger.info(`🔀 Selected random path to node: ${path.nextNode}`);
          return await this.databaseService.get(`
            SELECT * FROM chatbot_nodes WHERE id = ?
          `, [path.nextNode]);
        }
      }

      this.logger.warn(`🔀 No random path selected`);
      return null;
    } catch (error) {
      this.logger.error(`Error evaluating random condition:`, error);
      return null;
    }
  }

  /**
   * Evaluate a single condition (legacy method for backward compatibility)
   */
  async evaluateCondition(condition, conversationData, userResponse) {
    try {
      const { type, field, operator, value } = condition;

      let fieldValue = '';

      // Get field value based on type
      switch (type) {
        case 'user_response':
          fieldValue = userResponse || '';
          break;
        case 'conversation_data':
          fieldValue = conversationData[field] || '';
          break;
        case 'node_response':
          fieldValue = conversationData[`node_${field}_response`] || '';
          break;
        default:
          return false;
      }

      // Evaluate condition based on operator
      switch (operator) {
        case 'equals':
          return fieldValue.toLowerCase() === value.toLowerCase();
        case 'contains':
          return fieldValue.toLowerCase().includes(value.toLowerCase());
        case 'starts_with':
          return fieldValue.toLowerCase().startsWith(value.toLowerCase());
        case 'ends_with':
          return fieldValue.toLowerCase().endsWith(value.toLowerCase());
        case 'not_equals':
          return fieldValue.toLowerCase() !== value.toLowerCase();
        case 'is_empty':
          return !fieldValue || fieldValue.trim() === '';
        case 'is_not_empty':
          return fieldValue && fieldValue.trim() !== '';
        case 'matches_regex':
          try {
            const regex = new RegExp(value, 'i');
            return regex.test(fieldValue);
          } catch (e) {
            return false;
          }
        default:
          return false;
      }
    } catch (error) {
      this.logger.error(`Error evaluating condition:`, error);
      return false;
    }
  }

  /**
   * Get conversation data by conversation ID
   */
  async getConversationData(conversationId) {
    try {
      const conversation = await this.databaseService.get(`
        SELECT conversation_data FROM chatbot_conversations WHERE id = ?
      `, [conversationId]);

      if (conversation && conversation.conversation_data) {
        return JSON.parse(conversation.conversation_data);
      }

      return {};
    } catch (error) {
      this.logger.error(`Error getting conversation data:`, error);
      return {};
    }
  }

  /**
   * Get event statistics
   */
  async getEventStats() {
    try {
      const stats = await this.databaseService.get(`
        SELECT 
          COUNT(CASE WHEN action = 'session_connected' THEN 1 END) as sessions_connected,
          COUNT(CASE WHEN action = 'session_disconnected' THEN 1 END) as sessions_disconnected,
          COUNT(CASE WHEN action = 'call_received' THEN 1 END) as calls_received,
          COUNT(*) as total_events
        FROM activity_logs 
        WHERE DATE(timestamp) = DATE('now')
      `);

      return stats;
    } catch (error) {
      this.logger.error('Error getting event stats:', error);
      return null;
    }
  }


}

module.exports = EventService; 