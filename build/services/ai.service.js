const { EventEmitter } = require('events');
const OpenAI = require('openai');

class AIService extends EventEmitter {
  constructor(databaseService) {
    super();
    this.databaseService = databaseService;
    this.activeConversations = new Map(); // conversationId -> context
    this.rateLimits = new Map(); // userPhone -> { count, resetTime }
    this.logger = require('pino')({ level: 'info' });
    this.documentService = null;
  }

  /**
   * Initialize AI service with database and document service
   */
  async initialize(database) {
    this.database = database;

    // Initialize document service
    try {
      const DocumentService = require('./document.service');
      this.documentService = new DocumentService();
      await this.documentService.initialize(database);
    } catch (error) {
      console.error('❌ AI SERVICE INIT: Failed to initialize document service:', error);
      this.documentService = null;
    }

  }

  /**
   * Process incoming message with AI
   */
  async processMessage(sessionId, userPhone, message, chatbot) {
    try {
      this.logger.info(`🔍 Starting processMessage with chatbot: ${chatbot.name} (ID: ${chatbot.id})`);

      // Check rate limits
      if (!this.checkRateLimit(userPhone)) {
        return {
          success: false,
          error: 'Rate limit exceeded. Please wait before sending another message.'
        };
      }

      // Chatbot configuration is already provided
      this.logger.info(`🤖 Using provided chatbot: ${chatbot ? 'Found' : 'Not found'}`);
      if (chatbot) {
        this.logger.info(`🤖 Chatbot active: ${chatbot.is_active}, Provider: ${chatbot.provider}, API Key: ${chatbot.api_key ? 'Present' : 'Missing'}`);
      } else {
        this.logger.error(`🤖 No chatbot provided`);
      }

      if (!chatbot || !chatbot.is_active) {
        return { success: false, error: 'Chatbot not found or inactive' };
      }


      // Get or create conversation
      const conversation = await this.getOrCreateConversation(chatbot.id, sessionId, userPhone);
      
      // Detect language if enabled
      let detectedLanguage = chatbot.language;
      if (JSON.parse(chatbot.features || '{}').multiLanguage) {
        detectedLanguage = await this.detectLanguage(message.text);
      }

      // Analyze sentiment if enabled
      let sentiment = null;
      if (JSON.parse(chatbot.features || '{}').sentimentAnalysis) {
        sentiment = await this.analyzeSentiment(message.text);
      }

      // Check for intent recognition
      const intent = await this.recognizeIntent(chatbot.id, message.text);

      // Get conversation context
      const context = await this.getConversationContext(conversation.id);

      // Generate AI response
      let aiResponse;
      try {
        aiResponse = await this.generateResponse(chatbot, message.text, context, {
          language: detectedLanguage,
          sentiment: sentiment,
          intent: intent
        });
      } catch (error) {
        console.error('🚨 AI SERVICE ERROR in generateResponse:', error);
        console.error('🚨 ERROR MESSAGE:', error.message);
        console.error('🚨 ERROR STACK:', error.stack);
        throw error; // Re-throw to be caught by outer try-catch
      }

      // Save user message
      await this.saveMessage(conversation.id, 'user', message.text, {
        language: detectedLanguage,
        sentiment: sentiment,
        intent: intent?.name
      });

      // Save bot response
      await this.saveMessage(conversation.id, 'bot', aiResponse.content, {
        tokens_used: aiResponse.tokensUsed,
        processing_time: aiResponse.processingTime,
        confidence_score: aiResponse.confidence
      });

      // Update conversation
      await this.updateConversation(conversation.id, {
        message_count: context.messageCount + 2,
        language_detected: detectedLanguage,
        sentiment_score: sentiment?.score,
        intent_detected: intent?.name
      });

      return {
        success: true,
        response: aiResponse.content,
        metadata: {
          conversationId: conversation.id,
          language: detectedLanguage,
          sentiment: sentiment,
          intent: intent,
          confidence: aiResponse.confidence
        }
      };

    } catch (error) {
      // Only log detailed error info in development
      if (process.env.NODE_ENV === 'development') {
        console.error('🚨 AI SERVICE MAIN CATCH:', error);
        console.error('🚨 ERROR MESSAGE:', error.message);
        console.error('🚨 ERROR STACK:', error.stack);
        console.error('🚨 ERROR NAME:', error.name);
      }

      this.logger.error('Error processing AI message:', error.message || String(error));
      this.logger.error('Error stack:', error.stack || 'No stack trace');
      return {
        success: false,
        error: 'Failed to process message with AI: ' + (error.message || String(error))
      };
    }
  }

  /**
   * Generate AI response using configured provider
   */
  async generateResponse(chatbot, userMessage, context, metadata) {
    const startTime = Date.now();
    
    try {
      let response;
      
      if (chatbot.provider === 'openai') {
        response = await this.generateOpenAIResponse(chatbot, userMessage, context, metadata);
      } else {
        throw new Error(`Unsupported AI provider: ${chatbot.provider}. Only OpenAI is supported.`);
      }

      const processingTime = (Date.now() - startTime) / 1000;

      return {
        content: response.content,
        tokensUsed: response.tokensUsed || 0,
        processingTime: processingTime,
        confidence: response.confidence || 0.8
      };

    } catch (error) {
      console.error('🚨 Error generating AI response:', error.message);
      console.error('🚨 Error stack:', error.stack);
      console.error('🚨 Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        chatbotProvider: chatbot.provider,
        chatbotModel: chatbot.model
      });

      this.logger.error('Error generating AI response:', error.message);
      this.logger.error('Error details:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data,
        status: error.response?.status,
        chatbotProvider: chatbot.provider,
        chatbotModel: chatbot.model
      });

      // Return fallback message
      return {
        content: chatbot.fallback_message || 'I apologize, but I\'m having trouble understanding. Could you please rephrase your question?',
        tokensUsed: 0,
        processingTime: (Date.now() - startTime) / 1000,
        confidence: 0.1
      };
    }
  }

  /**
   * Generate response using OpenAI (Latest API)
   */
  async generateOpenAIResponse(chatbot, userMessage, context, metadata) {
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: chatbot.api_key
    });

    const messages = [
      {
        role: 'system',
        content: this.buildSystemPrompt(chatbot, metadata)
      }
    ];

    // Add conversation history
    if (context.messages && context.messages.length > 0) {
      const recentMessages = context.messages.slice(-10); // Last 10 messages
      recentMessages.forEach(msg => {
        messages.push({
          role: msg.message_type === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      });
    }

    // Get relevant document context if document service is available and chatbot has documents
    let documentContext = '';

    if (this.documentService) {
      try {
        // Check if this chatbot is configured to use documents

        if (chatbot.use_documents) {
          const relevantDocs = await this.documentService.getDocumentContext(chatbot.id, userMessage);

          if (relevantDocs.length > 0) {
            documentContext = '\n\nRelevant information from uploaded documents:\n';
            relevantDocs.forEach((doc, index) => {
              documentContext += `\n[Document: ${doc.original_filename}]\n${doc.content}\n`;
            });
            documentContext += '\nPlease use this information to provide accurate answers when relevant.\n';
          } else {
          }
        } else {
        }
      } catch (error) {
        console.error('⚠️ Document context error details:', error.message, error.stack);
      }
    } else {
    }

    // Add current user message with document context
    const finalUserMessage = userMessage + documentContext;

    messages.push({
      role: 'user',
      content: finalUserMessage
    });


    // Use the latest OpenAI model if not specified or if using old model
    let model = chatbot.model || 'gpt-4o-mini';

    // Update old models to latest equivalents
    if (model === 'gpt-3.5-turbo') {
      model = 'gpt-4o-mini'; // Latest cost-effective model
    } else if (model === 'gpt-4') {
      model = 'gpt-4o'; // Latest GPT-4 model
    } else if (model === 'gpt-4-turbo') {
      model = 'gpt-4o'; // Latest GPT-4 model
    }

    const response = await openai.chat.completions.create({
      model: model,
      messages: messages,
      temperature: chatbot.temperature || 0.7,
      max_tokens: chatbot.max_tokens || 1000,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
    });

    return {
      content: response.choices[0].message.content,
      tokensUsed: response.usage.total_tokens,
      confidence: 0.9
    };
  }



  /**
   * Build system prompt for OpenAI
   */
  buildSystemPrompt(chatbot, metadata) {
    // Use system_prompt if available, otherwise use description, otherwise fallback to default
    let prompt = chatbot.system_prompt || chatbot.description || 'You are a helpful AI assistant.';

    // Add personality
    const personalityPrompts = {
      professional: 'Maintain a professional and courteous tone.',
      friendly: 'Be warm, friendly, and approachable in your responses.',
      casual: 'Use a casual, relaxed tone like talking to a friend.',
      formal: 'Use formal language and maintain proper etiquette.',
      enthusiastic: 'Be energetic, positive, and enthusiastic.'
    };
    
    if (personalityPrompts[chatbot.personality]) {
      prompt += ` ${personalityPrompts[chatbot.personality]}`;
    }

    // Add industry context
    const industryContexts = {
      healthcare: 'You are assisting in a healthcare context. Be empathetic and provide helpful health-related information while noting that you cannot replace professional medical advice.',
      education: 'You are helping in an educational context. Be patient, encouraging, and focus on helping users learn.',
      ecommerce: 'You are assisting customers with their shopping needs. Be helpful with product information, orders, and customer service.',
      restaurant: 'You are helping customers with restaurant services including menu information, reservations, and orders.',
      business: 'You are assisting with business-related inquiries. Be professional and focus on business solutions.'
    };

    if (industryContexts[chatbot.industry]) {
      prompt += ` ${industryContexts[chatbot.industry]}`;
    }

    // Add language instruction
    if (metadata.language && metadata.language !== 'en') {
      prompt += ` Please respond in ${this.getLanguageName(metadata.language)}.`;
    }

    // Add sentiment awareness
    if (metadata.sentiment) {
      if (metadata.sentiment.label === 'negative') {
        prompt += ' The user seems upset or frustrated. Be extra empathetic and helpful.';
      } else if (metadata.sentiment.label === 'positive') {
        prompt += ' The user seems happy or satisfied. Match their positive energy.';
      }
    }

    return prompt;
  }



  /**
   * Detect language of text
   */
  async detectLanguage(text) {
    // Simple language detection - in production, use a proper language detection service
    const languagePatterns = {
      'es': /\b(hola|gracias|por favor|sí|no|cómo|qué|dónde)\b/i,
      'fr': /\b(bonjour|merci|s'il vous plaît|oui|non|comment|que|où)\b/i,
      'de': /\b(hallo|danke|bitte|ja|nein|wie|was|wo)\b/i,
      'pt': /\b(olá|obrigado|por favor|sim|não|como|que|onde)\b/i,
      'it': /\b(ciao|grazie|per favore|sì|no|come|che|dove)\b/i
    };

    for (const [lang, pattern] of Object.entries(languagePatterns)) {
      if (pattern.test(text)) {
        return lang;
      }
    }

    return 'en'; // Default to English
  }

  /**
   * Analyze sentiment of text
   */
  async analyzeSentiment(text) {
    // Simple sentiment analysis - in production, use a proper sentiment analysis service
    const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'like', 'happy', 'satisfied'];
    const negativeWords = ['bad', 'terrible', 'awful', 'horrible', 'hate', 'dislike', 'angry', 'frustrated', 'disappointed', 'upset'];

    const words = text.toLowerCase().split(/\s+/);
    let positiveCount = 0;
    let negativeCount = 0;

    words.forEach(word => {
      if (positiveWords.includes(word)) positiveCount++;
      if (negativeWords.includes(word)) negativeCount++;
    });

    let label = 'neutral';
    let score = 0;

    if (positiveCount > negativeCount) {
      label = 'positive';
      score = Math.min(positiveCount / words.length * 10, 1);
    } else if (negativeCount > positiveCount) {
      label = 'negative';
      score = Math.max(-negativeCount / words.length * 10, -1);
    }

    return { label, score };
  }

  /**
   * Check rate limits for user
   */
  checkRateLimit(userPhone) {
    const now = Date.now();
    const userLimit = this.rateLimits.get(userPhone);

    if (!userLimit) {
      this.rateLimits.set(userPhone, { count: 1, resetTime: now + 60000 });
      return true;
    }

    if (now > userLimit.resetTime) {
      this.rateLimits.set(userPhone, { count: 1, resetTime: now + 60000 });
      return true;
    }

    if (userLimit.count >= 10) { // Max 10 messages per minute
      return false;
    }

    userLimit.count++;
    return true;
  }

  /**
   * Get language name from code
   */
  getLanguageName(code) {
    const languages = {
      'en': 'English',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'pt': 'Portuguese',
      'it': 'Italian'
    };
    return languages[code] || 'English';
  }

  /**
   * Get chatbot configuration
   */
  async getChatbot(chatbotId) {
    try {
      this.logger.info(`🔍 Getting chatbot with ID: ${chatbotId}`);
      const result = await this.databaseService.get(`
        SELECT c.*, p.name as provider_name, p.type as provider, p.api_key, p.model, p.temperature, p.max_tokens
        FROM ai_chatbots c
        LEFT JOIN ai_providers p ON c.provider_id = p.id
        WHERE c.id = ? AND c.is_active = 1 AND p.is_active = 1
      `, [chatbotId]);

      this.logger.info(`🔍 Database result:`, JSON.stringify(result, null, 2));

      // The get() method returns data directly, not wrapped in a result object
      return result;
    } catch (error) {
      this.logger.error('Error getting chatbot:', error);
      return null;
    }
  }

  /**
   * Get or create conversation
   */
  async getOrCreateConversation(chatbotId, sessionId, userPhone) {
    try {
      // Check for existing active conversation
      let conversation = await this.databaseService.get(`
        SELECT * FROM ai_conversations
        WHERE chatbot_id = ? AND session_id = ? AND user_phone = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `, [chatbotId, sessionId, userPhone]);

      if (!conversation) {
        // Create new conversation
        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const result = await this.databaseService.run(`
          INSERT INTO ai_conversations (
            chatbot_id, session_id, user_phone, conversation_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [chatbotId, sessionId, userPhone, conversationId]);

        conversation = {
          id: result.data.lastID,
          chatbot_id: chatbotId,
          session_id: sessionId,
          user_phone: userPhone,
          conversation_id: conversationId,
          status: 'active',
          message_count: 0
        };
      }

      return conversation;
    } catch (error) {
      this.logger.error('Error getting/creating conversation:', error);
      throw error;
    }
  }

  /**
   * Get conversation context
   */
  async getConversationContext(conversationId) {
    try {
      const messages = await this.databaseService.all(`
        SELECT * FROM ai_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
      `, [conversationId]);

      const conversation = await this.databaseService.get(`
        SELECT * FROM ai_conversations WHERE id = ?
      `, [conversationId]);

      return {
        messages: messages || [],
        messageCount: messages?.length || 0,
        conversation: conversation
      };
    } catch (error) {
      this.logger.error('Error getting conversation context:', error);
      return { messages: [], messageCount: 0 };
    }
  }

  /**
   * Save message to database
   */
  async saveMessage(conversationId, messageType, content, metadata = {}) {
    try {
      await this.databaseService.run(`
        INSERT INTO ai_messages (
          conversation_id, message_type, content, metadata,
          tokens_used, processing_time, confidence_score,
          intent, sentiment, language, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        conversationId,
        messageType,
        content,
        JSON.stringify(metadata),
        metadata.tokens_used || null,
        metadata.processing_time || null,
        metadata.confidence_score || null,
        metadata.intent || null,
        metadata.sentiment || null,
        metadata.language || null
      ]);
    } catch (error) {
      this.logger.error('Error saving message:', error);
    }
  }

  /**
   * Update conversation
   */
  async updateConversation(conversationId, updates) {
    try {
      const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const values = Object.values(updates);
      values.push(conversationId);

      await this.databaseService.run(`
        UPDATE ai_conversations
        SET ${setClause}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, values);
    } catch (error) {
      this.logger.error('Error updating conversation:', error);
    }
  }

  /**
   * Recognize intent from user message
   */
  async recognizeIntent(chatbotId, message) {
    try {
      const intents = await this.databaseService.all(`
        SELECT * FROM ai_intents
        WHERE chatbot_id = ? AND is_active = 1
        ORDER BY confidence_threshold DESC
      `, [chatbotId]);

      for (const intent of intents) {
        const trainingPhrases = JSON.parse(intent.training_phrases || '[]');

        for (const phrase of trainingPhrases) {
          if (this.calculateSimilarity(message.toLowerCase(), phrase.toLowerCase()) > intent.confidence_threshold) {
            return {
              id: intent.id,
              name: intent.name,
              confidence: this.calculateSimilarity(message.toLowerCase(), phrase.toLowerCase()),
              action_type: intent.action_type,
              action_data: JSON.parse(intent.action_data || '{}')
            };
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Error recognizing intent:', error);
      return null;
    }
  }

  /**
   * Calculate similarity between two strings
   */
  calculateSimilarity(str1, str2) {
    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);

    let matches = 0;
    words1.forEach(word => {
      if (words2.includes(word)) {
        matches++;
      }
    });

    return matches / Math.max(words1.length, words2.length);
  }

  /**
   * Get chatbots for session
   */
  async getChatbotsForSession(sessionId) {
    try {
      // Always fetch fresh data to avoid cached deleted chatbots
      const result = await this.databaseService.all(`
        SELECT c.*, p.name as provider_name, p.type as provider, p.api_key, p.model, p.temperature, p.max_tokens
        FROM ai_chatbots c
        LEFT JOIN ai_providers p ON c.provider_id = p.id
        WHERE c.is_active = 1 AND p.is_active = 1 AND (
          c.session_ids LIKE '%"${sessionId}"%' OR
          c.session_ids = '[]' OR
          c.session_ids IS NULL
        )
        ORDER BY c.created_at DESC
      `);

      const chatbots = result.data || [];

      // Log active chatbots for debugging
      this.logger.info(`🤖 AI Service: Found ${chatbots.length} active chatbots for session ${sessionId}`);
      chatbots.forEach(chatbot => {
        this.logger.info(`🤖 AI Service: Active chatbot: ${chatbot.name} (ID: ${chatbot.id})`);
      });

      return chatbots;
    } catch (error) {
      this.logger.error('Error getting chatbots for session:', error);
      return [];
    }
  }

  /**
   * Clear chatbot cache (called when chatbot is deleted)
   */
  clearChatbotCache(chatbotId) {
    this.logger.info(`🧹 AI Service: Clearing cache for deleted chatbot ${chatbotId}`);
    // Since we're fetching fresh data each time, this is mainly for logging
    // But we could add cache clearing logic here if needed in the future
  }

  /**
   * End conversation
   */
  async endConversation(conversationId, reason = 'completed') {
    try {
      await this.databaseService.run(`
        UPDATE ai_conversations
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [reason, conversationId]);
    } catch (error) {
      this.logger.error('Error ending conversation:', error);
    }
  }

  /**
   * Record user feedback
   */
  async recordFeedback(conversationId, feedback, correction = null) {
    try {
      const conversation = await this.databaseService.get(`
        SELECT * FROM ai_conversations WHERE id = ?
      `, [conversationId]);

      if (conversation) {
        // Get last bot message
        const lastBotMessage = await this.databaseService.get(`
          SELECT * FROM ai_messages
          WHERE conversation_id = ? AND message_type = 'bot'
          ORDER BY created_at DESC LIMIT 1
        `, [conversationId]);

        // Get last user message
        const lastUserMessage = await this.databaseService.get(`
          SELECT * FROM ai_messages
          WHERE conversation_id = ? AND message_type = 'user'
          ORDER BY created_at DESC LIMIT 1
        `, [conversationId]);

        if (lastBotMessage && lastUserMessage) {
          await this.databaseService.run(`
            INSERT INTO ai_learning_data (
              chatbot_id, conversation_id, user_input, bot_response,
              user_feedback, correction, context, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [
            conversation.chatbot_id,
            conversationId,
            lastUserMessage.content,
            lastBotMessage.content,
            feedback,
            correction,
            JSON.stringify({ conversation_context: conversation.context })
          ]);
        }
      }
    } catch (error) {
      this.logger.error('Error recording feedback:', error);
    }
  }
}

module.exports = AIService;
