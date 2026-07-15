const AIService = require('./ai.service');

class AIWhatsAppIntegration {
  constructor(whatsappService, databaseService, aiService = null) {
    this.whatsappService = whatsappService;
    this.databaseService = databaseService;
    // Use provided AI service or create a new one (for backward compatibility)
    this.aiService = aiService || new AIService(databaseService);
    this.logger = require('pino')({ level: 'info' });
    
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for WhatsApp messages
   */
  setupEventListeners() {
    // Listen for incoming messages
    this.whatsappService.on('message_received', async (data) => {
      await this.handleIncomingMessage(data);
    });

    this.logger.info('AI WhatsApp integration initialized');
  }

  /**
   * Handle incoming WhatsApp message
   */
  async handleIncomingMessage(data) {
    try {
      const { sessionId, message, formattedMessage } = data;

      this.logger.info(`🤖 AI Integration received message for session ${sessionId}`);

      // Skip if message is from bot itself
      if (message.key.fromMe) {
        this.logger.debug('Skipping message from bot itself');
        return;
      }

      // Skip if message was already processed by flow-based chatbot system
      if (message._flowProcessed) {
        this.logger.info('🤖 ⏭️ Skipping AI processing - message already processed by flow-based chatbot system');
        return;
      }

      // Extract user phone number
      const userPhone = message.key.remoteJid.replace('@s.whatsapp.net', '');
      const messageText = formattedMessage.text || formattedMessage.caption || '';

      this.logger.info(`🤖 Processing message: "${messageText}" from ${userPhone} in session ${sessionId}`);

      // Check if there's an active flow-based chatbot conversation
      // If so, don't interfere with AI responses
      const activeFlowConversation = await this.databaseService.get(`
        SELECT cc.*, cf.name as flow_name FROM chatbot_conversations cc
        JOIN chatbot_flows cf ON cc.flow_id = cf.id
        WHERE cc.session_id = ? AND cc.user_phone = ? AND cc.is_active = 1
        ORDER BY cc.last_activity DESC
        LIMIT 1
      `, [sessionId, userPhone]);

      if (activeFlowConversation) {
        this.logger.info(`🤖 ⏭️ Skipping AI processing - active flow-based conversation found: "${activeFlowConversation.flow_name}" (ID: ${activeFlowConversation.id})`);
        return;
      }

      // Get active chatbots for this session
      const chatbots = await this.aiService.getChatbotsForSession(sessionId);

      this.logger.info(`🤖 Found ${chatbots.length} active chatbots for session ${sessionId}`);

      if (chatbots.length === 0) {
        this.logger.debug(`No active AI chatbots found for session ${sessionId}`);
        return;
      }

      // Process message with each active chatbot
      let aiProcessed = false;
      for (const chatbot of chatbots) {
        this.logger.info(`🤖 Checking chatbot: ${chatbot.name} (ID: ${chatbot.id})`);
        const processed = await this.processMessageWithChatbot(sessionId, userPhone, formattedMessage, chatbot);
        if (processed) {
          aiProcessed = true;
          break; // Stop processing other chatbots if one successfully processed the message
        }
      }

      // Mark the message as processed by AI to prevent old chatbot system interference
      if (aiProcessed) {
        formattedMessage._aiProcessed = true;
        message._aiProcessed = true; // Also mark the raw message
      }

    } catch (error) {
      this.logger.error('Error handling incoming message for AI:', error);
    }
  }

  /**
   * Process message with specific chatbot
   */
  async processMessageWithChatbot(sessionId, userPhone, message, chatbot) {
    try {
      // Check if this chatbot should respond to this message
      if (!(await this.shouldChatbotRespond(chatbot, message, sessionId, userPhone))) {
        return false;
      }

      this.logger.info(`Processing message with AI chatbot: ${chatbot.name}`);

      // Log chatbot details for debugging
      this.logger.info(`🤖 Chatbot details: ID=${chatbot.id}, Provider=${chatbot.provider}, API Key=${chatbot.api_key ? 'Present' : 'Missing'}, Model=${chatbot.model}`);

      // Process with AI service
      let aiResult;
      try {
        aiResult = await this.aiService.processMessage(
          sessionId,
          userPhone,
          message,
          chatbot
        );
      } catch (error) {
        // Log error using proper logger
        this.logger.error('AI processing error:', error.message || String(error));
        this.logger.error('Error stack:', error.stack || 'No stack trace');

        this.logger.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack,
          cause: error.cause,
          toString: String(error)
        });
        return false;
      }

      if (!aiResult || !aiResult.success) {
        this.logger.error('AI processing failed:', aiResult?.error || 'Unknown error');
        this.logger.error('Full AI result:', JSON.stringify(aiResult, null, 2));
        return false;
      }

      this.logger.info('🔍 About to add response delay and send typing indicator');

      // Add response delay if configured
      if (chatbot.response_delay > 0) {
        this.logger.info(`🔍 Adding response delay: ${chatbot.response_delay}ms`);
        await this.delay(chatbot.response_delay);
      }

      this.logger.info('🔍 About to send typing indicator');
      // Send typing indicator
      try {
        await this.whatsappService.sendPresenceUpdate('composing', message.from);
        await this.delay(1000); // Show typing for 1 second
        this.logger.info('🔍 Typing indicator sent successfully');
      } catch (typingError) {
        this.logger.error('🔍 Error sending typing indicator (continuing anyway):', typingError.message);
      }

      this.logger.info('🔍 About to send AI response');
      // Send AI response
      try {
        await this.sendAIResponse(sessionId, userPhone, aiResult, chatbot);
        this.logger.info('🔍 AI response sent successfully');
      } catch (sendError) {
        this.logger.error('🚨 CRITICAL ERROR: Failed to send AI response:', {
          error: sendError.message,
          stack: sendError.stack,
          userPhone: userPhone,
          sessionId: sessionId,
          chatbotId: chatbot.id
        });
        // Don't return false here - the AI processing was successful, just the sending failed
        // We'll still mark it as processed to prevent the old chatbot system from interfering
      }

      // Handle special actions based on intent
      if (aiResult.metadata.intent) {
        try {
          await this.handleIntentAction(sessionId, userPhone, aiResult.metadata.intent, chatbot);
        } catch (intentError) {
          this.logger.error('🚨 ERROR handling intent action:', intentError.message);
        }
      }

      return true; // Successfully processed (even if sending failed, we processed the message)

    } catch (error) {
      this.logger.error('🚨 DETAILED ERROR in processMessageWithChatbot:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
        cause: error.cause,
        toString: String(error),
        userPhone: userPhone,
        sessionId: sessionId,
        chatbotId: chatbot?.id,
        chatbotName: chatbot?.name
      });
      // Error already logged above
      return false; // Failed to process
    }
  }

  /**
   * Determine if chatbot should respond to this message
   */
  async shouldChatbotRespond(chatbot, message, sessionId, userPhone) {
    this.logger.info(`🤖 Checking if chatbot "${chatbot.name}" should respond`);

    // Check if message type is supported
    if (!message.text && !message.caption) {
      this.logger.debug('Message has no text or caption, skipping');
      return false;
    }

    // Check if chatbot is configured for this session
    const sessionIds = JSON.parse(chatbot.session_ids || '[]');
    this.logger.info(`🤖 Chatbot session IDs: ${JSON.stringify(sessionIds)}, Message session: ${sessionId}`);

    if (sessionIds.length > 0 && !sessionIds.includes(sessionId)) {
      this.logger.info(`Session ${sessionId} not in chatbot's allowed sessions`);
      return false;
    }

    const messageText = (message.text || message.caption || '').toLowerCase().trim();
    this.logger.info(`🤖 Processing message text: "${messageText}"`);

    // Check stop keywords first - if any stop keyword matches, don't respond and end conversation
    const stopKeywords = JSON.parse(chatbot.stop_keywords || '[]');
    this.logger.info(`🤖 Stop keywords: ${JSON.stringify(stopKeywords)}`);

    if (stopKeywords.length > 0) {
      for (const keyword of stopKeywords) {
        if (messageText.includes(keyword.toLowerCase().trim())) {
          this.logger.info(`Stop keyword "${keyword}" matched, AI will stop responding and end conversation`);
          // End any active conversation
          await this.endActiveConversation(chatbot.id, sessionId, userPhone);
          return false;
        }
      }
    }

    // Check if there's an active conversation for this user and chatbot
    const hasActiveConversation = await this.hasActiveConversation(chatbot.id, sessionId, userPhone);
    if (hasActiveConversation) {
      this.logger.info(`Active conversation found, AI will continue responding`);
      return true;
    }

    // Check trigger keywords - if defined, message must match at least one to start new conversation
    const triggerKeywords = JSON.parse(chatbot.trigger_keywords || '[]');
    this.logger.info(`🤖 Trigger keywords: ${JSON.stringify(triggerKeywords)}`);

    if (triggerKeywords.length > 0) {
      let hasMatch = false;
      for (const keyword of triggerKeywords) {
        if (messageText.includes(keyword.toLowerCase().trim())) {
          this.logger.info(`Trigger keyword "${keyword}" matched, AI will respond`);
          hasMatch = true;
          break;
        }
      }
      if (!hasMatch) {
        this.logger.info(`No trigger keywords matched for message: "${messageText}"`);
        return false;
      }
    }

    // If no trigger keywords are defined, respond to all messages (default behavior)
    return true;
  }

  /**
   * Check if there's an active conversation for this user and chatbot
   */
  async hasActiveConversation(chatbotId, sessionId, userPhone) {
    try {
      this.logger.info(`🔍 Checking for active conversation: chatbot=${chatbotId}, session=${sessionId}, user=${userPhone}`);

      const result = await this.databaseService.get(`
        SELECT id FROM ai_conversations
        WHERE chatbot_id = ? AND session_id = ? AND user_phone = ? AND status = 'active'
        LIMIT 1
      `, [chatbotId, sessionId, userPhone]);

      this.logger.info(`🔍 Active conversation query result: ${JSON.stringify(result)}`);

      // The get() method returns the row directly or null, not wrapped in {success, data}
      const hasConversation = result !== null;
      this.logger.info(`🔍 Has active conversation: ${hasConversation}`);

      return hasConversation;
    } catch (error) {
      this.logger.error('Error checking active conversation:', error);
      return false;
    }
  }

  /**
   * End active conversation for this user and chatbot
   */
  async endActiveConversation(chatbotId, sessionId, userPhone) {
    try {
      await this.databaseService.run(`
        UPDATE ai_conversations
        SET status = 'ended', updated_at = CURRENT_TIMESTAMP
        WHERE chatbot_id = ? AND session_id = ? AND user_phone = ? AND status = 'active'
      `, [chatbotId, sessionId, userPhone]);

      this.logger.info(`Ended active conversation for chatbot ${chatbotId}, session ${sessionId}, user ${userPhone}`);
    } catch (error) {
      this.logger.error('Error ending active conversation:', error);
    }
  }

  /**
   * Send AI response via WhatsApp
   */
  async sendAIResponse(sessionId, userPhone, aiResult, chatbot) {
    try {
      this.logger.info(`🤖 📤 Starting to send AI response to ${userPhone}`);
      this.logger.info(`🤖 📤 AI Response content: "${aiResult.response}"`);

      const recipientJid = `${userPhone}@s.whatsapp.net`;

      // Validate and sanitize the response content
      let responseText = aiResult.response;

      // Handle cases where response might be an object
      if (typeof responseText === 'object') {
        if (responseText && responseText.text) {
          responseText = responseText.text;
        } else if (responseText && responseText.content) {
          responseText = responseText.content;
        } else {
          // Fallback: stringify the object but log a warning
          this.logger.warn(`🤖 ⚠️ AI response is an object, converting to string: ${JSON.stringify(responseText)}`);
          responseText = JSON.stringify(responseText);
        }
      }

      // Ensure we have a string
      if (typeof responseText !== 'string') {
        this.logger.warn(`🤖 ⚠️ AI response is not a string, converting: ${responseText}`);
        responseText = String(responseText);
      }

      // Validate that we have actual content
      if (!responseText || responseText.trim() === '' || responseText === '[object Object]') {
        this.logger.error(`🤖 ❌ Invalid AI response content: "${responseText}"`);
        responseText = "I apologize, but I'm having trouble generating a response right now. Please try again.";
      }

      this.logger.info(`🤖 📤 Sanitized response text: "${responseText}"`);

      // Determine response format based on chatbot features
      const features = JSON.parse(chatbot.features || '{}');

      // Basic text response
      let messageContent = {
        text: responseText
      };

      this.logger.info(`🤖 📤 Message content prepared: ${JSON.stringify(messageContent)}`);

      // Add interactive elements if supported
      if (features.decisionTree && aiResult.metadata.intent?.action_type === 'flow') {
        messageContent = await this.buildFlowResponse(aiResult.metadata.intent.action_data, responseText);
      } else if (features.formCollection && aiResult.metadata.intent?.action_type === 'form') {
        messageContent = await this.buildFormResponse(aiResult.metadata.intent.action_data, responseText);
      }

      // Send the message
      this.logger.info(`🤖 📤 Calling whatsappService.sendMessage with sessionId: ${sessionId}, recipientJid: ${recipientJid}`);

      // Add timeout to prevent hanging
      const sendPromise = this.whatsappService.sendMessage(
        sessionId,
        recipientJid,
        messageContent,
        'text'
      );

      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Send message timeout' }), 10000)
      );

      const result = await Promise.race([sendPromise, timeoutPromise]);

      this.logger.info(`🤖 📤 WhatsApp send result: ${JSON.stringify(result)}`);

      if (result.success) {
        this.logger.info(`🤖 ✅ AI response sent successfully to ${userPhone}`);

        // Record successful interaction
        try {
          await this.recordInteraction(aiResult.metadata.conversationId, 'response_sent', {
            messageId: result.messageId,
            responseLength: aiResult.response.length,
            confidence: aiResult.metadata.confidence
          });
        } catch (recordError) {
          this.logger.error(`🤖 ⚠️ Failed to record interaction (message still sent):`, recordError.message);
        }
      } else {
        this.logger.error(`🤖 ❌ Failed to send AI response: ${result.error}`);
        throw new Error(`Failed to send AI response: ${result.error}`);
      }

    } catch (error) {
      this.logger.error('🚨 DETAILED ERROR in sendAIResponse:', {
        message: error.message,
        stack: error.stack,
        userPhone: userPhone,
        sessionId: sessionId,
        chatbotId: chatbot.id,
        chatbotName: chatbot.name
      });
      throw error; // Re-throw to be caught by calling function
    }
  }

  /**
   * Build flow response with interactive buttons
   */
  async buildFlowResponse(actionData, baseResponse) {
    try {
      if (!actionData.flowId) {
        return { text: baseResponse };
      }

      // Get flow data
      const flow = await this.databaseService.get(`
        SELECT * FROM ai_decision_flows WHERE id = ? AND is_active = 1
      `, [actionData.flowId]);

      if (!flow) {
        return { text: baseResponse };
      }

      const flowData = JSON.parse(flow.flow_data || '{}');
      
      // Build interactive message with buttons
      if (flowData.buttons && flowData.buttons.length > 0) {
        return {
          text: baseResponse,
          footer: flowData.footer || 'Please select an option:',
          buttons: flowData.buttons.map((button, index) => ({
            buttonId: `flow_${flow.id}_${index}`,
            buttonText: { displayText: button.text },
            type: 1
          }))
        };
      }

      return { text: baseResponse };
    } catch (error) {
      this.logger.error('Error building flow response:', error);
      return { text: baseResponse };
    }
  }

  /**
   * Build form response for data collection
   */
  async buildFormResponse(actionData, baseResponse) {
    try {
      if (!actionData.formId) {
        return { text: baseResponse };
      }

      // Get form template
      const form = await this.databaseService.get(`
        SELECT * FROM ai_form_templates WHERE id = ? AND is_active = 1
      `, [actionData.formId]);

      if (!form) {
        return { text: baseResponse };
      }

      const fields = JSON.parse(form.fields || '[]');
      
      if (fields.length > 0) {
        const firstField = fields[0];
        return {
          text: `${baseResponse}\n\n📝 Let's collect some information.\n\n${firstField.label}:`
        };
      }

      return { text: baseResponse };
    } catch (error) {
      this.logger.error('Error building form response:', error);
      return { text: baseResponse };
    }
  }

  /**
   * Handle intent-based actions
   */
  async handleIntentAction(sessionId, userPhone, intent, chatbot) {
    try {
      switch (intent.action_type) {
        case 'escalate':
          await this.escalateToHuman(sessionId, userPhone, intent.action_data);
          break;
          
        case 'appointment':
          await this.handleAppointmentBooking(sessionId, userPhone, intent.action_data, chatbot);
          break;
          
        case 'form':
          await this.startFormCollection(sessionId, userPhone, intent.action_data);
          break;
          
        default:
          // No special action needed
          break;
      }
    } catch (error) {
      this.logger.error('Error handling intent action:', error);
    }
  }

  /**
   * Escalate conversation to human agent
   */
  async escalateToHuman(sessionId, userPhone, actionData) {
    try {
      const recipientJid = `${userPhone}@s.whatsapp.net`;
      
      const escalationMessage = actionData.message || 
        'I\'m connecting you with a human agent who can better assist you. Please wait a moment.';
      
      await this.whatsappService.sendMessage(
        sessionId,
        recipientJid,
        { text: escalationMessage },
        'text'
      );

      // Mark conversation as escalated
      // This would integrate with your existing support system
      this.logger.info(`Conversation escalated to human for user ${userPhone}`);
      
    } catch (error) {
      this.logger.error('Error escalating to human:', error);
    }
  }

  /**
   * Handle appointment booking flow
   */
  async handleAppointmentBooking(sessionId, userPhone, actionData, chatbot) {
    try {
      const recipientJid = `${userPhone}@s.whatsapp.net`;
      
      // This is a simplified appointment booking flow
      const appointmentMessage = {
        text: '📅 I can help you book an appointment!\n\nPlease let me know:\n1. Preferred date\n2. Preferred time\n3. Type of appointment\n\nExample: "Tomorrow at 2 PM for consultation"'
      };

      await this.whatsappService.sendMessage(
        sessionId,
        recipientJid,
        appointmentMessage,
        'text'
      );

    } catch (error) {
      this.logger.error('Error handling appointment booking:', error);
    }
  }

  /**
   * Start form collection process
   */
  async startFormCollection(sessionId, userPhone, actionData) {
    try {
      // Implementation for form collection would go here
      this.logger.info(`Starting form collection for user ${userPhone}`);
    } catch (error) {
      this.logger.error('Error starting form collection:', error);
    }
  }

  /**
   * Record interaction for analytics
   */
  async recordInteraction(conversationId, interactionType, metadata) {
    try {
      // This could be expanded to record detailed analytics
      this.logger.debug(`Recording interaction: ${interactionType}`, metadata);
    } catch (error) {
      this.logger.error('Error recording interaction:', error);
    }
  }

  /**
   * Utility function for delays
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get AI chatbot statistics
   */
  async getStatistics(chatbotId, days = 30) {
    try {
      const stats = await this.databaseService.get(`
        SELECT 
          COUNT(DISTINCT conversation_id) as total_conversations,
          COUNT(*) as total_messages,
          AVG(confidence_score) as avg_confidence,
          COUNT(CASE WHEN message_type = 'bot' THEN 1 END) as bot_messages,
          COUNT(CASE WHEN message_type = 'user' THEN 1 END) as user_messages
        FROM ai_messages m
        JOIN ai_conversations c ON m.conversation_id = c.id
        WHERE c.chatbot_id = ? AND m.created_at >= datetime('now', '-${days} days')
      `, [chatbotId]);

      return stats || {};
    } catch (error) {
      this.logger.error('Error getting AI statistics:', error);
      return {};
    }
  }
}

module.exports = AIWhatsAppIntegration;
