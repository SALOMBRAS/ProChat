const DatabaseService = require('./database.service');
const WhatsAppService = require('./whatsapp.service');
const EventService = require('./event.service');
const EmailService = require('./email.service');
const CampaignSchedulerService = require('./campaign-scheduler.service');
const FollowUpSchedulerService = require('./followup-scheduler.service');
const TranslationService = require('./translation.service');
const WarmerService = require('./warmer.service');
const ProxyService = require('./proxy.service');
const SupportBotService = require('./support-bot.service');

// Development-aware logging
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
const devLog = (...args) => { if (isDev) console.log(...args); };
const devWarn = (...args) => { if (isDev) console.warn(...args); };
const devError = (...args) => { if (isDev) console.error(...args); };
const AIWhatsAppIntegration = require('./ai-whatsapp.integration');
const WhatsAppSession = require('../models/WhatsAppSession');
const MessageTemplate = require('../models/MessageTemplate');
const Contact = require('../models/Contact');

class AppService {
  constructor() {
    this.isInitialized = false;
    this.database = null;
    this.whatsappService = null;
    this.eventService = null;
    this.emailService = null;
    this.campaignScheduler = null;
    this.followUpScheduler = null;
    this.warmerService = null;
    this.proxyService = null;
    this.aiIntegration = null;
    this.translationService = null;
    this.supportBotService = null;
    this.liveChatService = null;
    this.models = {
      WhatsAppSession,
      MessageTemplate,
      Contact
    };
  }

  async initialize() {
    try {

      // Initialize database first
      this.database = new DatabaseService();
      await this.database.initialize();
    
    // Initialize WhatsApp service with database
    this.whatsappService = new WhatsAppService(this.database);
    this.whatsappService.setDatabaseService(this.database);
    
    // Initialize email service with database
    this.emailService = new EmailService();
    this.emailService.setDatabaseService(this.database);
    await this.emailService.initialize();

    // Initialize event service - it sets up listeners automatically in constructor
    this.eventService = new EventService(this.database, this.whatsappService);
    // Pass email service to event service
    this.eventService.emailService = this.emailService;

    // Initialize campaign scheduler service
    this.campaignScheduler = new CampaignSchedulerService();
    await this.campaignScheduler.initialize(this.database, this.whatsappService, this.eventService.messageProcessor);

    // Initialize recall bot service
    try {
      const RecallBotService = require('./recall-bot.service');

      this.recallBotService = new RecallBotService();

      const recallBotResult = await this.recallBotService.initialize(this.database, this.whatsappService);

      if (!recallBotResult.success) {
        this.recallBotService = null;
      } else {
      }
    } catch (error) {
      console.error('⚠️ Failed to initialize Recall Bot service:', error);
      console.error('⚠️ Error stack:', error.stack);
      this.recallBotService = null;
    }

    // Initialize follow-up scheduler service
    this.followUpScheduler = new FollowUpSchedulerService();
    await this.followUpScheduler.initialize(this.database, this.whatsappService, this.eventService.messageProcessor);

    // Initialize warmer service
    try {
      this.warmerService = new WarmerService(this.database, this.whatsappService);
    } catch (error) {
      console.error('⚠️ Failed to initialize Warmer service:', error);
      this.warmerService = null;
    }

    // Initialize proxy service
    try {
      this.proxyService = new ProxyService(this.database);
    } catch (error) {
      console.error('⚠️ Failed to initialize Proxy service:', error);
      this.proxyService = null;
    }

    // Initialize AI service
    try {
      const AIService = require('./ai.service');
      this.aiService = new AIService(this.database);
      await this.aiService.initialize(this.database);
    } catch (error) {
      console.error('⚠️ Failed to initialize AI service:', error);
      this.aiService = null;
    }

// Initialize AI WhatsApp integration
    this.aiIntegration = new AIWhatsAppIntegration(this.whatsappService, this.database, this.aiService);

    // Initialize Translation service
    try {
      this.translationService = new TranslationService(this.database);

      // Auto-sync translation keys on every startup to ensure all keys are up-to-date
      try {
        const fs = require('fs');
        const path = require('path');
        const vm = require('vm');
        const enLocalePath = path.join(__dirname, '..', 'locales', 'en.js');

        // Read the file content and parse it (since it's an ES6 module)
        const fileContent = fs.readFileSync(enLocalePath, 'utf8');

        // Remove 'export default' and trailing semicolon to create a valid JavaScript expression
        const objectContent = fileContent
          .replace(/^export\s+default\s+/, '')
          .trim()
          .replace(/;$/, ''); // Remove trailing semicolon

        // Use VM to safely evaluate the object
        const script = new vm.Script(`(${objectContent})`);
        const enLocale = script.runInNewContext({});

        // Always sync to catch new translation keys
        const syncResult = await this.translationService.syncTranslationKeys(enLocale);
      } catch (syncError) {
        console.error('⚠️ Failed to auto-sync translation keys:', syncError);
      }
    } catch (error) {
      console.error('⚠️ Failed to initialize Translation service:', error);
      this.translationService = null;
    }

    // Initialize Support Bot service
    try {
      this.supportBotService = new SupportBotService(this.database, this.whatsappService);

      // Inject Support Bot service into event service
      if (this.eventService) {
        this.eventService.supportBotService = this.supportBotService;
      }
    } catch (error) {
      console.error('⚠️ Failed to initialize Support Bot service:', error);
      this.supportBotService = null;
    }

    // Initialize Live Chat service
    try {
      const LiveChatService = require('./live-chat.service');
      this.liveChatService = new LiveChatService(this.database, this.whatsappService);
      await this.liveChatService.initialize();
    } catch (error) {
      console.error('⚠️ Failed to initialize Live Chat service:', error);
      this.liveChatService = null;
    }

    // Initialize models
    WhatsAppSession.db = this.database;
    MessageTemplate.db = this.database;
    Contact.db = this.database;
    
    this.models = {
      WhatsAppSession,
      MessageTemplate,
      Contact
    };
    
    // Create default data
    await this.createDefaultData();

    // Restore existing WhatsApp sessions (delayed to prevent file descriptor issues)
    const timeoutId = setTimeout(async () => {
      try {
        await this.whatsappService.restoreAllSessions();
      } catch (error) {
        console.error('❌ [APP SERVICE] Error in restoreAllSessions():', error);
      }
    }, 2000); // Wait 2 seconds after app initialization

    // Start the campaign scheduler
    console.log('🚀 AppService: Starting campaign scheduler...');
    this.campaignScheduler.start();
    console.log('✅ AppService: Campaign scheduler started');

    // Start the follow-up scheduler
    console.log('🚀 AppService: Starting follow-up scheduler...');
    this.followUpScheduler.start();
    console.log('✅ AppService: Follow-up scheduler started');

    this.isInitialized = true;
    console.log('✅ AppService: Initialization complete, all schedulers running');

    } catch (error) {
      console.error('❌ AppService: Initialization failed:', error);
      console.error('❌ AppService: Error stack:', error.stack);
      this.isInitialized = false;
      throw error;
    }
  }

  async createDefaultData() {
    try {
      // Skip creating default templates - they are not needed
      // Users can create their own templates as needed

      // Check if we need to create default settings
      const settingsCount = await this.database.get('SELECT COUNT(*) as count FROM app_settings');

      if (settingsCount.count === 0) {
        // Creating default settings
        // Settings are created in database.service.js insertDefaultSettings()
      }

      // Default data check completed
    } catch (error) {
      devError('Error creating default data:', error);
    }
  }

  async createDefaultTemplates() {
    const defaultTemplates = [
      {
        name: 'Welcome Message',
        category: 'welcome',
        content: 'Hello {{name}}! Welcome to our service. We\'re excited to have you on board! 🎉\n\nHow can we help you today?',
        variables: JSON.stringify(['name']),
        attachments: null
      },
      {
        name: 'Thank You',
        category: 'general',
        content: 'Thank you {{name}} for your interest! We really appreciate it. 😊\n\nWe\'ll get back to you soon.',
        variables: JSON.stringify(['name']),
        attachments: null
      },
      {
        name: 'Product Inquiry Response',
        category: 'sales',
        content: 'Hi {{name}}! 👋\n\nThank you for your inquiry about {{product}}. Here are the details:\n\n💰 Price: ${{price}}\n📦 Availability: In Stock\n🚚 Shipping: Free\n\nWould you like to place an order?',
        variables: JSON.stringify(['name', 'product', 'price']),
        attachments: null
      },
      {
        name: 'Appointment Confirmation',
        category: 'appointments',
        content: 'Hello {{name}}! ✅\n\nYour appointment has been confirmed for:\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Location: {{location}}\n\nPlease arrive 10 minutes early. See you soon!',
        variables: JSON.stringify(['name', 'date', 'time', 'location']),
        attachments: null
      },
      {
        name: 'Follow Up',
        category: 'follow_up',
        content: 'Hi {{name}}! 👋\n\nJust checking in to see how you\'re doing with {{product}}. \n\nDo you have any questions or need any assistance? We\'re here to help! 🤗',
        variables: JSON.stringify(['name', 'product']),
        attachments: null
      },
      {
        name: 'Order Confirmation',
        category: 'orders',
        content: 'Order Confirmed! 🎉\n\nHi {{name}}, your order #{{order_id}} has been confirmed.\n\n📦 Items: {{items}}\n💰 Total: ${{total}}\n🚚 Estimated delivery: {{delivery_date}}\n\nThank you for your purchase!',
        variables: JSON.stringify(['name', 'order_id', 'items', 'total', 'delivery_date']),
        attachments: null
      }
    ];

    for (const templateData of defaultTemplates) {
      const template = new MessageTemplate(templateData);
      await template.save();
    }

    // Default templates created
  }

  async getStats() {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    const stats = await this.database.getStats();

    // Add model-specific stats
    const sessionStats = await WhatsAppSession.getStats();
    const templateStats = await MessageTemplate.getStats();
    const contactStats = await Contact.getStats();

    // Add WhatsApp session real-time stats
    const whatsAppSessions = this.whatsappService ? this.whatsappService.getAllSessions() : [];
    const connectedSessions = whatsAppSessions.filter(s => s.status === 'connected').length;
    const qrReadySessions = whatsAppSessions.filter(s => s.status === 'qr_ready').length;

    // Get additional module statistics
    const moduleStats = await this.getModuleStats();

    return {
      database: stats,
      sessions: {
        ...sessionStats,
        connected: connectedSessions,
        qrReady: qrReadySessions,
        total: whatsAppSessions.length
      },
      templates: templateStats,
      contacts: contactStats,
      modules: moduleStats,
      lastUpdated: new Date().toISOString()
    };
  }

  async getModuleStats() {
    try {
      // Use basic queries that work with existing schema
      const autoReplyStats = await this.database.query(`SELECT COUNT(*) as total_rules FROM auto_reply_rules`);
      const autoReplyActiveStats = await this.database.query(`SELECT COUNT(*) as active_rules FROM auto_reply_rules WHERE is_active = 1`);
      const autoReplyUsageStats = await this.database.query(`SELECT SUM(COALESCE(response_count, 0)) as total_responses FROM auto_reply_rules`);
      const autoReplyUsedStats = await this.database.query(`SELECT COUNT(*) as used_rules FROM auto_reply_rules WHERE COALESCE(response_count, 0) > 0`);

      const chatbotStats = await this.database.query(`SELECT COUNT(*) as total_flows FROM chatbot_flows`);
      const chatbotActiveStats = await this.database.query(`SELECT COUNT(*) as active_flows FROM chatbot_flows WHERE is_active = 1`);
      const chatbotConversations = await this.database.query(`SELECT COUNT(*) as total_conversations FROM chatbot_conversations`);
      const chatbotCompleted = await this.database.query(`SELECT COUNT(*) as completed_conversations FROM chatbot_conversations WHERE completed_at IS NOT NULL`);

      const callResponderStats = await this.database.query(`SELECT COUNT(*) as total_rules FROM call_responses`);
      const callResponderActiveStats = await this.database.query(`SELECT COUNT(*) as active_rules FROM call_responses WHERE is_active = 1`);
      const callResponderUsageStats = await this.database.query(`SELECT SUM(COALESCE(usage_count, 0)) as total_responses FROM call_responses`);

      const bulkCampaignStats = await this.database.query(`SELECT COUNT(*) as total_campaigns FROM bulk_campaigns`);
      const bulkCampaignCompleted = await this.database.query(`SELECT COUNT(*) as completed_campaigns FROM bulk_campaigns WHERE status = 'completed'`);
      const bulkCampaignRunning = await this.database.query(`SELECT COUNT(*) as running_campaigns FROM bulk_campaigns WHERE status = 'running'`);
      const bulkCampaignScheduled = await this.database.query(`SELECT COUNT(*) as scheduled_campaigns FROM bulk_campaigns WHERE status = 'scheduled'`);

      // Debug: Check all campaigns
      const allCampaigns = await this.database.query(`SELECT id, name, status, sent_count, failed_count FROM bulk_campaigns`);

      // Get bulk campaign message statistics from bulk_campaign_recipients table
      const bulkCampaignSent = await this.database.query(`
        SELECT COUNT(*) as total_sent
        FROM bulk_campaign_recipients
        WHERE status = 'sent'
      `);
      const bulkCampaignFailed = await this.database.query(`
        SELECT COUNT(*) as total_failed
        FROM bulk_campaign_recipients
        WHERE status = 'failed'
      `);

      // Debug: Check all bulk campaign recipients
      const allRecipients = await this.database.query(`SELECT id, campaign_id, status FROM bulk_campaign_recipients`);

      // Get overall message statistics from message_history (for general message success rate)
      const overallMessagesSent = await this.database.query(`
        SELECT COUNT(*) as total_sent
        FROM message_history
        WHERE direction = 'outgoing' AND status IN ('sent', 'delivered', 'read')
      `);
      const overallMessagesFailed = await this.database.query(`
        SELECT COUNT(*) as total_failed
        FROM message_history
        WHERE direction = 'outgoing' AND status = 'failed'
      `);

      const messageStats = await this.database.query(`SELECT COUNT(*) as total_messages FROM message_history WHERE direction = 'outgoing'`);
      const recentMessages = await this.database.query(`SELECT COUNT(*) as recent_messages FROM message_history WHERE direction = 'outgoing' AND created_at >= datetime('now', '-1 day')`);

      const templateStats = await this.database.query(`SELECT COUNT(*) as total_templates FROM message_templates`);

      const moduleStatsResult = {
        autoReply: {
          total_rules: autoReplyStats.success && autoReplyStats.data[0] ? autoReplyStats.data[0].total_rules : 0,
          active_rules: autoReplyActiveStats.success && autoReplyActiveStats.data[0] ? autoReplyActiveStats.data[0].active_rules : 0,
          total_responses: autoReplyUsageStats.success && autoReplyUsageStats.data[0] ? (autoReplyUsageStats.data[0].total_responses || 0) : 0,
          used_rules: autoReplyUsedStats.success && autoReplyUsedStats.data[0] ? autoReplyUsedStats.data[0].used_rules : 0
        },
        chatbot: {
          total_flows: chatbotStats.success && chatbotStats.data[0] ? chatbotStats.data[0].total_flows : 0,
          active_flows: chatbotActiveStats.success && chatbotActiveStats.data[0] ? chatbotActiveStats.data[0].active_flows : 0,
          total_conversations: chatbotConversations.success && chatbotConversations.data[0] ? chatbotConversations.data[0].total_conversations : 0,
          active_conversations: 0,
          completed_conversations: chatbotCompleted.success && chatbotCompleted.data[0] ? chatbotCompleted.data[0].completed_conversations : 0
        },
        callResponder: {
          total_rules: callResponderStats.success && callResponderStats.data[0] ? callResponderStats.data[0].total_rules : 0,
          active_rules: callResponderActiveStats.success && callResponderActiveStats.data[0] ? callResponderActiveStats.data[0].active_rules : 0,
          total_responses: callResponderUsageStats.success && callResponderUsageStats.data[0] ? (callResponderUsageStats.data[0].total_responses || 0) : 0
        },
        bulkCampaigns: {
          total_campaigns: bulkCampaignStats.success && bulkCampaignStats.data[0] ? bulkCampaignStats.data[0].total_campaigns : 0,
          completed_campaigns: bulkCampaignCompleted.success && bulkCampaignCompleted.data[0] ? bulkCampaignCompleted.data[0].completed_campaigns : 0,
          running_campaigns: bulkCampaignRunning.success && bulkCampaignRunning.data[0] ? bulkCampaignRunning.data[0].running_campaigns : 0,
          scheduled_campaigns: bulkCampaignScheduled.success && bulkCampaignScheduled.data[0] ? bulkCampaignScheduled.data[0].scheduled_campaigns : 0,
          total_recipients: 0,
          total_sent: bulkCampaignSent.success && bulkCampaignSent.data[0] ? bulkCampaignSent.data[0].total_sent : 0,
          total_failed: bulkCampaignFailed.success && bulkCampaignFailed.data[0] ? bulkCampaignFailed.data[0].total_failed : 0
        },
        // Overall message statistics (for general message success rate)
        overallMessages: {
          total_sent: overallMessagesSent.success && overallMessagesSent.data[0] ? overallMessagesSent.data[0].total_sent : 0,
          total_failed: overallMessagesFailed.success && overallMessagesFailed.data[0] ? overallMessagesFailed.data[0].total_failed : 0
        },
        activity: {
          messages_last_7_days: messageStats.success && messageStats.data[0] ? messageStats.data[0].total_messages : 0,
          messages_last_24_hours: recentMessages.success && recentMessages.data[0] ? recentMessages.data[0].recent_messages : 0
        },
        templateUsage: {
          used_templates: templateStats.success && templateStats.data[0] ? templateStats.data[0].total_templates : 0,
          total_template_usage: 0
        }
      };

      return moduleStatsResult;
    } catch (error) {
      devError('Error getting module stats:', error);
      return {
        autoReply: { total_rules: 0, active_rules: 0, total_responses: 0, used_rules: 0 },
        chatbot: { total_flows: 0, active_flows: 0, total_conversations: 0, active_conversations: 0, completed_conversations: 0 },
        callResponder: { total_rules: 0, active_rules: 0, total_responses: 0 },
        bulkCampaigns: { total_campaigns: 0, completed_campaigns: 0, running_campaigns: 0, scheduled_campaigns: 0, total_recipients: 0, total_sent: 0, total_failed: 0 },
        activity: { messages_last_7_days: 0, messages_last_24_hours: 0 },
        templateUsage: { used_templates: 0, total_template_usage: 0 }
      };
    }
  }

  async getRecentActivities(limit = 10) {
    try {
      const activities = [];

      // Recent device connections
      const recentDevices = await this.database.query(`
        SELECT
          'device' as type,
          'Device ' || name || ' connected' as title,
          'WhatsApp session established successfully' as description,
          updated_at as time,
          'success' as status
        FROM whatsapp_sessions
        WHERE status = 'connected' AND updated_at >= datetime('now', '-7 days')
        ORDER BY updated_at DESC
        LIMIT 3
      `);

      // Recent messages sent
      const recentMessages = await this.database.query(`
        SELECT
          'message' as type,
          'Message sent to ' || mh.contact_phone as title,
          CASE
            WHEN length(mh.content) > 50 THEN substr(mh.content, 1, 50) || '...'
            ELSE mh.content
          END as description,
          mh.timestamp as time,
          CASE WHEN mh.status = 'sent' THEN 'success' ELSE 'info' END as status
        FROM message_history mh
        INNER JOIN whatsapp_sessions ws ON mh.session_id = ws.id
        WHERE mh.direction = 'outgoing' AND mh.timestamp >= datetime('now', '-7 days')
        ORDER BY mh.timestamp DESC
        LIMIT 5
      `);


      // Recent bulk campaigns
      const recentCampaigns = await this.database.query(`
        SELECT
          'campaign' as type,
          'Bulk campaign ' || name || ' completed' as title,
          'Campaign status: ' || status as description,
          updated_at as time,
          CASE WHEN status = 'completed' THEN 'success' ELSE 'info' END as status
        FROM bulk_campaigns
        WHERE updated_at >= datetime('now', '-7 days')
        ORDER BY updated_at DESC
        LIMIT 3
      `);

      // Recent templates
      const recentTemplates = await this.database.query(`
        SELECT
          'template' as type,
          'Template ' || name || ' created' as title,
          'New message template added' as description,
          created_at as time,
          'info' as status
        FROM message_templates
        WHERE created_at >= datetime('now', '-7 days')
        ORDER BY created_at DESC
        LIMIT 2
      `);

      // Recent activity logs
      const recentLogs = await this.database.query(`
        SELECT
          'activity' as type,
          description as title,
          action_type as description,
          created_at as time,
          'info' as status
        FROM activity_logs
        WHERE created_at >= datetime('now', '-7 days')
        ORDER BY created_at DESC
        LIMIT 3
      `);

      // Combine all activities
      if (recentDevices.success) activities.push(...recentDevices.data);
      if (recentMessages.success) activities.push(...recentMessages.data);
      if (recentCampaigns.success) activities.push(...recentCampaigns.data);
      if (recentTemplates.success) activities.push(...recentTemplates.data);
      if (recentLogs.success) activities.push(...recentLogs.data);

      // Sort by time and limit
      activities.sort((a, b) => new Date(b.time) - new Date(a.time));

      return activities.slice(0, limit).map((activity, index) => ({
        id: index + 1,
        ...activity,
        time: this.formatTimeAgo(activity.time)
      }));

    } catch (error) {
      devError('Error getting recent activities:', error);
      return [];
    }
  }

  formatTimeAgo(dateString) {
    const now = new Date();
    const date = new Date(dateString);
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;
    return date.toLocaleDateString();
  }

  async getHealthCheck() {
    return {
      status: this.isInitialized ? 'healthy' : 'initializing',
      database: this.database ? 'connected' : 'disconnected',
      whatsapp: this.whatsappService ? 'ready' : 'not_initialized',
      events: this.eventService ? 'listening' : 'not_initialized',
      models: Object.keys(this.models).length,
      timestamp: new Date().toISOString()
    };
  }

  async shutdown() {
    try {
      // Shutdown WhatsApp service gracefully
      if (this.whatsappService && typeof this.whatsappService.shutdown === 'function') {
        await this.whatsappService.shutdown();
      } else if (this.whatsappService) {
        // Fallback to old method if shutdown method doesn't exist
        const sessions = this.whatsappService.getAllSessions();
        for (const session of sessions) {
          const socket = this.whatsappService.sessions.get(session.id);
          if (socket) {
            try {
              await socket.end();
            } catch (error) {
            }
          }
        }
        this.whatsappService.sessions.clear();
        this.whatsappService.sessionStates.clear();
      }

      // Stop schedulers
      if (this.campaignScheduler) {
        this.campaignScheduler.stop();
      }

      if (this.followUpScheduler) {
        this.followUpScheduler.stop();
      }

      // Close database
      if (this.database) {
        await this.database.close();
      }

      this.isInitialized = false;
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
  }

  // WhatsApp Service Methods
  async createWhatsAppSession(deviceName = 'ChatPro Device') {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Generate unique session ID
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Create session in database first
      await WhatsAppSession.create({
        session_id: sessionId,
        name: deviceName, // Use name column instead of device_name
        device_name: deviceName, // Keep both for compatibility
        status: 'creating',
        is_active: 1 // Make it active
      });

      // Create session in WhatsApp service
      const result = await this.whatsappService.createSession(sessionId);
      
      // WhatsApp session creation initiated
      return {
        success: true,
        sessionId: sessionId,
        message: 'Session created successfully'
      };
    } catch (error) {
      console.error(`Error creating WhatsApp session:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  async disconnectWhatsAppSession(sessionId) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Processing disconnect request

      // Disconnect from WhatsApp service (logout but keep data)
      const result = await this.whatsappService.disconnectSession(sessionId);

      // Session disconnected
      return result;
    } catch (error) {
      console.error(`❌ AppService: Error disconnecting WhatsApp session ${sessionId}:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  async reconnectWhatsAppSession(sessionId) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Processing reconnect request

      // Force reconnect using WhatsApp service (clears auth and generates new QR)
      const result = await this.whatsappService.forceReconnectSession(sessionId);

      // Session reconnected
      return result;
    } catch (error) {
      console.error(`❌ AppService: Error reconnecting WhatsApp session ${sessionId}:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  async deleteWhatsAppSession(sessionId) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Processing delete request
      
      // Delete from WhatsApp service
      const result = await this.whatsappService.deleteSession(sessionId);
      
      // Session deleted
      return result;
    } catch (error) {
      console.error(`❌ AppService: Error deleting WhatsApp session ${sessionId}:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  async getWhatsAppSessions() {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Get sessions from database
      const dbSessions = await WhatsAppSession.findAll();

      // Get real-time status from WhatsApp service
      const whatsAppSessions = this.whatsappService.getAllSessions();

      // Merge database and real-time data
      const sessions = dbSessions.map(dbSession => {
        const whatsAppSession = whatsAppSessions.find(
          ws => ws.id === dbSession.sessionId
        );

        // IMPORTANT: Prioritize database 'connected' status over in-memory 'connecting' status
        // This prevents showing "Reconnecting..." during silent session restoration
        let displayStatus = dbSession.status;
        let displayIsLoggedIn = false;

        if (whatsAppSession) {
          // If database says 'connected' and WhatsApp service is restoring (silentReconnect flag),
          // keep showing 'connected' status to avoid UI flicker
          if (dbSession.status === 'connected' && whatsAppSession.silentReconnect) {
            displayStatus = 'connected';
            displayIsLoggedIn = true;
          } else {
            // Otherwise use real-time status
            displayStatus = whatsAppSession.status;
            displayIsLoggedIn = whatsAppSession.isLoggedIn;
          }
        }

        // Convert dbSession to plain object with correct field mappings
        const sessionData = {
          // Database fields (use the correct property names from toJSON())
          id: dbSession.id,
          sessionId: dbSession.sessionId, // Frontend expects sessionId, not session_id
          session_id: dbSession.sessionId, // Keep for backward compatibility
          name: dbSession.name,
          deviceName: dbSession.deviceName, // Frontend expects deviceName
          device_name: dbSession.deviceName, // Keep for backward compatibility
          phoneNumber: dbSession.phoneNumber, // Frontend expects phoneNumber
          phone_number: dbSession.phoneNumber, // Keep for backward compatibility
          status: dbSession.status,
          qrCode: dbSession.qrCode,
          isActive: dbSession.isActive,
          createdAt: dbSession.createdAt,
          updatedAt: dbSession.updatedAt,
          connectedAt: dbSession.connectedAt,
          disconnectedAt: dbSession.disconnectedAt,
          lastSeen: dbSession.lastSeen,
          // Real-time fields from WhatsApp service (with smart status handling)
          realTimeStatus: displayStatus,
          isLoggedIn: displayIsLoggedIn,
          connectionTimestamp: whatsAppSession ? whatsAppSession.connectionTimestamp : null
        };

        return sessionData;
      });

      return sessions;
    } catch (error) {
      console.error('Error getting WhatsApp sessions:', error);
      return [];
    }
  }

  async sendMessage(sessionId, to, message, type = 'text', options = {}) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      let result;

      switch (type) {
        case 'text':
          result = await this.whatsappService.sendTextMessage(sessionId, to, message);
          break;
        case 'button':
        case 'interactive':
          if (typeof message === 'object' && message.buttons) {
            result = await this.whatsappService.sendInteractiveMessage(sessionId, to, message);
          } else {
            result = await this.whatsappService.sendButtonMessage(sessionId, to, message, options.buttons || []);
          }
          break;
        case 'list':
          if (typeof message === 'object' && message.sections) {
            result = await this.whatsappService.sendInteractiveMessage(sessionId, to, message);
          } else {
            result = await this.whatsappService.sendListMessage(sessionId, to, message, options.buttonText || 'Select Option', options.sections || []);
          }
          break;
        case 'poll':
          result = await this.whatsappService.sendPollMessage(sessionId, to, message);
          break;
        case 'contact':
          result = await this.whatsappService.sendContactMessage(sessionId, to, message);
          break;
        case 'location':
          result = await this.whatsappService.sendLocationMessage(sessionId, to, message);
          break;
        case 'media':
        case 'image':
        case 'video':
        case 'audio':
        case 'document':
          if (typeof message === 'object') {
            // Check if this is a media message with URL or base64 data
            if (message[type]) {
              // Get media data - could be string directly or object with .url or .data
              let mediaData;
              if (typeof message[type] === 'string') {
                mediaData = message[type];
              } else if (message[type].url || message[type].data) {
                mediaData = message[type].url || message[type].data;
              }

              if (mediaData) {
                // If it's a base64 data URL, convert to buffer
                if (typeof mediaData === 'string' && mediaData.startsWith('data:')) {
                  const base64Data = mediaData.split(',')[1];
                  const buffer = Buffer.from(base64Data, 'base64');
                  result = await this.whatsappService.sendMediaMessage(sessionId, to, buffer, type, message.caption || '');
                } else {
                  // Handle URL-based media
                  result = await this.whatsappService.sendMessage(sessionId, to, message, type);
                }
              } else {
                // This might be an interactive message
                result = await this.whatsappService.sendInteractiveMessage(sessionId, to, message);
              }
            } else {
              // This might be an interactive message
              result = await this.whatsappService.sendInteractiveMessage(sessionId, to, message);
            }
          } else {
            result = await this.whatsappService.sendMediaMessage(sessionId, to, options.mediaBuffer, options.mediaType, message);
          }
          break;

        case 'template':
          result = await this.whatsappService.sendTemplateMessage(sessionId, to, message, options.variables || {});
          break;
        case 'cta_button':
          result = await this.whatsappService.sendCTAButtonMessage(sessionId, to, message);
          break;
        case 'copy_code':
          result = await this.whatsappService.sendCopyCodeMessage(sessionId, to, message);
          break;
        case 'mixed_buttons':
          result = await this.whatsappService.sendMixedButtonsMessage(sessionId, to, message);
          break;
        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      // Log message if successful
      if (result.success) {
        // Get the numeric session ID from the database
        const sessionDbId = await this.database.query(
          'SELECT id FROM whatsapp_sessions WHERE session_id = ?',
          [sessionId]
        );


        if (sessionDbId.success && sessionDbId.data.length > 0) {
          const insertResult = await this.database.run(`
            INSERT INTO message_history (
              session_id, message_id, contact_phone,
              content, message_type, direction, status, timestamp
            ) VALUES (?, ?, ?, ?, ?, 'outgoing', 'sent', CURRENT_TIMESTAMP)
          `, [sessionDbId.data[0].id, result.messageId, to.replace('@s.whatsapp.net', ''), message, type]);

        } else {
          console.error('❌ DEBUG - Failed to find session in database:', sessionId);
        }
      }

      return result;
    } catch (error) {
      console.error(`Error sending message from ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Utility methods
  getModel(modelName) {
    if (!this.models[modelName]) {
      throw new Error(`Model ${modelName} not found`);
    }
    return this.models[modelName];
  }

  getDatabaseService() {
    return this.database;
  }

  getWhatsAppService() {
    return this.whatsappService;
  }

  getAIService() {
    return this.aiService;
  }

  getEventService() {
    return this.eventService;
  }

  getAIIntegration() {
    return this.aiIntegration;
  }

  getCampaignScheduler() {
    return this.campaignScheduler;
  }

  getFollowUpScheduler() {
    return this.followUpScheduler;
  }

  getWarmerService() {
    return this.warmerService;
  }

  getProxyService() {
    return this.proxyService;
  }

  getRecallBotService() {
    return this.recallBotService;
  }

  getTranslationService() {
    return this.translationService;
  }

  getSupportBotService() {
    return this.supportBotService;
  }

  getLiveChatService() {
    return this.liveChatService;
  }

  /**
   * Request pairing code for session
   */
  async requestPairingCode(sessionId, phoneNumber) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    return await this.whatsappService.requestPairingCode(sessionId, phoneNumber);
  }

  /**
   * Create a new session specifically for pairing code authentication
   */
  async createPairingCodeSession(phoneNumber) {
    if (!this.isInitialized) {
      throw new Error('Application not initialized');
    }

    try {
      // Creating pairing code session

      // Create pairing code session using WhatsApp service
      const result = await this.whatsappService.createPairingCodeSession(phoneNumber);

      // Pairing code session created
      return result;
    } catch (error) {
      console.error(`❌ AppService: Error creating pairing code session for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error.message,
        phoneNumber: phoneNumber
      };
    }
  }
}

module.exports = AppService;