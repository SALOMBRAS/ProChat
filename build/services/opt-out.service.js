const DatabaseService = require('./database.service');

/**
 * OptOutService - Manages customer communication preferences and opt-out functionality
 * Provides professional compliance with messaging regulations and customer preferences
 */
class OptOutService {
  constructor(databaseService = null) {
    this.databaseService = databaseService || new DatabaseService();
    this.logger = require('pino')({ level: 'info' });
  }

  /**
   * Set the database service instance
   * @param {DatabaseService} databaseService - Database service instance
   */
  setDatabaseService(databaseService) {
    this.databaseService = databaseService;
  }

  async ensureTablesExist() {
    try {

      // Create communication_preferences table
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS communication_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone_number TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'promotional',
          opted_out BOOLEAN DEFAULT 0,
          consent_given BOOLEAN DEFAULT 1,
          consent_date DATETIME DEFAULT CURRENT_TIMESTAMP,
          opt_out_date DATETIME,
          opt_out_method TEXT,
          opt_out_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(phone_number, message_type)
        )
      `);

      // Create opt_out_keywords table
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS opt_out_keywords (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          keyword TEXT NOT NULL UNIQUE,
          auto_response_template TEXT,
          case_sensitive BOOLEAN DEFAULT 0,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create opt_out_requests table
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS opt_out_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone_number TEXT NOT NULL,
          request_type TEXT NOT NULL,
          keyword_used TEXT,
          session_id TEXT,
          processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT DEFAULT 'processed'
        )
      `);

      // Create compliance_audit_log table
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS compliance_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone_number TEXT NOT NULL,
          action TEXT NOT NULL,
          details TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_agent TEXT,
          ip_address TEXT
        )
      `);

      // Insert default keywords (only SUBSCRIBE and UNSUBSCRIBE)
      await this.databaseService.run(`
        INSERT OR IGNORE INTO opt_out_keywords (keyword, auto_response_template, case_sensitive, is_active)
        VALUES
        ('UNSUBSCRIBE', 'You have been unsubscribed from our messages. Reply SUBSCRIBE to opt back in.', 0, 1),
        ('SUBSCRIBE', 'You have been subscribed to our messages. Reply UNSUBSCRIBE to unsubscribe.', 0, 1)
      `);

      // Remove old keywords that are no longer used
      await this.databaseService.run(`
        DELETE FROM opt_out_keywords
        WHERE keyword NOT IN ('SUBSCRIBE', 'UNSUBSCRIBE')
      `);

      // Create opt_out_settings table for auto-response messages
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS opt_out_settings (
          id INTEGER PRIMARY KEY,
          subscribe_message TEXT,
          unsubscribe_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Insert default auto-response messages if not exists
      await this.databaseService.run(`
        INSERT OR IGNORE INTO opt_out_settings (id, subscribe_message, unsubscribe_message)
        VALUES (1,
          'You have been subscribed to ChatPro messages. Reply UNSUBSCRIBE to unsubscribe.',
          'You have been unsubscribed from ChatPro messages. Reply SUBSCRIBE to opt back in.'
        )
      `);

    } catch (error) {
      this.logger.error('Error creating opt-out tables:', error);
      throw error;
    }
  }

  /**
   * Check if a phone number is opted out from receiving messages
   * @param {string} phoneNumber - Phone number to check
   * @param {string} messageType - Type of message (marketing, transactional, promotional, reminder)
   * @returns {Promise<{isOptedOut: boolean, reason?: string, optOutDate?: Date}>}
   */
  async isOptedOut(phoneNumber, messageType = 'marketing') {
    try {
      // Check if database service is available
      if (!this.databaseService || !this.databaseService.db) {
        return { isOptedOut: false, reason: 'Database not available' };
      }

      const normalizedNumber = this.normalizePhoneNumber(phoneNumber);

      const queryResult = await this.databaseService.get(`
        SELECT
          opt_out_status,
          opt_out_date,
          opt_out_reason,
          marketing_consent,
          transactional_consent,
          promotional_consent,
          reminder_consent
        FROM communication_preferences
        WHERE phone_number = ?
      `, [normalizedNumber]);

      // Extract the actual result from the database response
      const result = queryResult?.success ? queryResult.data : queryResult;

      if (!result) {
        // No preference record exists, assume opted in
        return { isOptedOut: false };
      }

      // Check global opt-out status
      if (result.opt_out_status === 'opted_out') {
        return {
          isOptedOut: true,
          reason: result.opt_out_reason || 'Global opt-out',
          optOutDate: result.opt_out_date ? new Date(result.opt_out_date) : null
        };
      }

      // Check specific message type consent
      const consentField = `${messageType}_consent`;
      if (result[consentField] === 0) {
        return {
          isOptedOut: true,
          reason: `Opted out from ${messageType} messages`,
          optOutDate: result.opt_out_date ? new Date(result.opt_out_date) : null
        };
      }

      return { isOptedOut: false };
    } catch (error) {
      this.logger.error('Error checking opt-out status:', error);
      // In case of database error, assume not opted out to avoid blocking legitimate messages
      // This is a business decision - you may want to change this based on your compliance requirements
      return { isOptedOut: false, reason: 'Error checking opt-out status' };
    }
  }

  /**
   * Opt out a phone number from receiving messages
   * @param {string} phoneNumber - Phone number to opt out
   * @param {Object} options - Opt-out options
   * @param {string} options.method - How the opt-out was requested ('keyword', 'manual', 'web_form', 'complaint')
   * @param {string} options.reason - Reason for opt-out
   * @param {number} options.campaignId - Campaign ID that triggered the opt-out
   * @param {string} options.sessionId - Session ID
   * @param {Array<string>} options.messageTypes - Specific message types to opt out from (default: all)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async optOut(phoneNumber, options = {}) {
    try {
      const normalizedNumber = this.normalizePhoneNumber(phoneNumber);
      const {
        method = 'manual',
        reason = 'User request',
        campaignId = null,
        sessionId = null,
        messageTypes = ['all']
      } = options;

      // Get contact ID if exists - try multiple phone number formats
      let contact = await this.databaseService.get(
        'SELECT id FROM contacts WHERE phone_number = ? OR phone_number = ? OR phone_number = ?',
        [normalizedNumber, phoneNumber, `+${normalizedNumber}`]
      );

      const now = new Date().toISOString();

      // Create or update communication preferences
      if (messageTypes.includes('all')) {
        // Global opt-out
        await this.databaseService.run(`
          INSERT OR REPLACE INTO communication_preferences (
            phone_number, contact_id, opt_out_status, opt_out_date, opt_out_method,
            opt_out_campaign_id, opt_out_reason, marketing_consent, transactional_consent,
            promotional_consent, reminder_consent, last_consent_update, updated_at
          ) VALUES (?, ?, 'opted_out', ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
        `, [
          normalizedNumber, contact?.id || null, now, method, campaignId, reason, now, now
        ]);
      } else {
        // Specific message type opt-out
        const updates = messageTypes.map(type => `${type}_consent = 0`).join(', ');
        await this.databaseService.run(`
          INSERT OR REPLACE INTO communication_preferences (
            phone_number, contact_id, opt_out_date, opt_out_method,
            opt_out_campaign_id, opt_out_reason, last_consent_update, updated_at,
            ${updates}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${messageTypes.map(() => '0').join(', ')})
        `, [
          normalizedNumber, contact?.id || null, now, method, campaignId, reason, now, now
        ]);
      }

      // Log the opt-out request
      await this.databaseService.run(`
        INSERT INTO opt_out_requests (
          phone_number, contact_id, session_id, request_method, campaign_id,
          processed, processed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `, [normalizedNumber, contact?.id || null, sessionId, method, campaignId, now]);

      // Log compliance audit
      await this.logComplianceAction(normalizedNumber, 'opt_out', {
        method,
        reason,
        messageTypes,
        campaignId,
        sessionId
      });

      this.logger.info(`Successfully opted out ${normalizedNumber} via ${method}`);
      
      return {
        success: true,
        message: `Successfully opted out ${normalizedNumber} from ${messageTypes.includes('all') ? 'all' : messageTypes.join(', ')} messages`
      };
    } catch (error) {
      this.logger.error('Error opting out phone number:', error);
      return {
        success: false,
        message: `Failed to opt out ${phoneNumber}: ${error.message}`
      };
    }
  }

  /**
   * Opt in a phone number to receive messages
   * @param {string} phoneNumber - Phone number to opt in
   * @param {Object} options - Opt-in options
   * @param {string} options.method - How the opt-in was requested
   * @param {string} options.sessionId - Session ID
   * @param {Array<string>} options.messageTypes - Specific message types to opt in to (default: all)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async optIn(phoneNumber, options = {}) {
    try {
      const normalizedNumber = this.normalizePhoneNumber(phoneNumber);
      const {
        method = 'manual',
        sessionId = null,
        messageTypes = ['all']
      } = options;

      // Get contact ID if exists - try multiple phone number formats
      const contact = await this.databaseService.get(
        'SELECT id FROM contacts WHERE phone_number = ? OR phone_number = ? OR phone_number = ?',
        [normalizedNumber, phoneNumber, `+${normalizedNumber}`]
      );

      const now = new Date().toISOString();

      if (messageTypes.includes('all')) {
        // Global opt-in
        await this.databaseService.run(`
          INSERT OR REPLACE INTO communication_preferences (
            phone_number, contact_id, opt_out_status, marketing_consent, transactional_consent,
            promotional_consent, reminder_consent, last_consent_update, consent_source, updated_at
          ) VALUES (?, ?, 'opted_in', 1, 1, 1, 1, ?, ?, ?)
        `, [normalizedNumber, contact?.id || null, now, method, now]);
      } else {
        // Specific message type opt-in
        const updates = messageTypes.map(type => `${type}_consent = 1`).join(', ');
        await this.databaseService.run(`
          UPDATE communication_preferences 
          SET ${updates}, last_consent_update = ?, updated_at = ?
          WHERE phone_number = ?
        `, [now, now, normalizedNumber]);
      }

      // Log compliance audit
      await this.logComplianceAction(normalizedNumber, 'opt_in', {
        method,
        messageTypes,
        sessionId
      });

      this.logger.info(`Successfully opted in ${normalizedNumber} via ${method}`);
      
      return {
        success: true,
        message: `Successfully opted in ${normalizedNumber} to ${messageTypes.includes('all') ? 'all' : messageTypes.join(', ')} messages`
      };
    } catch (error) {
      this.logger.error('Error opting in phone number:', error);
      return {
        success: false,
        message: `Failed to opt in ${phoneNumber}: ${error.message}`
      };
    }
  }

  /**
   * Process incoming message for opt-out keywords
   * @param {string} phoneNumber - Sender's phone number
   * @param {string} messageContent - Message content
   * @param {string} sessionId - Session ID
   * @returns {Promise<{isOptOutKeyword: boolean, action?: string, response?: string}>}
   */
  async processOptOutKeyword(phoneNumber, messageContent, sessionId) {
    try {
      const normalizedContent = messageContent.trim().toUpperCase();

      // Check if database service is available
      if (!this.databaseService) {
        throw new Error('Database service not initialized');
      }

      if (typeof this.databaseService.all !== 'function') {
        throw new Error('Database service.all method not available');
      }

      // Ensure opt-out tables exist
      await this.ensureTablesExist();

      // Get auto-response messages from opt_out_settings
      const settingsResult = await this.databaseService.get(`
        SELECT subscribe_message, unsubscribe_message
        FROM opt_out_settings
        WHERE id = 1
      `);

      // Check for SUBSCRIBE keyword
      if (normalizedContent === 'SUBSCRIBE') {
        await this.optIn(phoneNumber, {
          method: 'keyword',
          sessionId
        });

        const response = settingsResult?.subscribe_message ||
          'You have been subscribed to ChatPro messages. Reply UNSUBSCRIBE to unsubscribe.';

        return {
          isOptOutKeyword: true,
          action: 'opt_in',
          response
        };
      }

      // Check for UNSUBSCRIBE keyword
      if (normalizedContent === 'UNSUBSCRIBE') {
        await this.optOut(phoneNumber, {
          method: 'keyword',
          reason: 'Keyword: UNSUBSCRIBE',
          sessionId
        });

        const response = settingsResult?.unsubscribe_message ||
          'You have been unsubscribed from ChatPro messages. Reply SUBSCRIBE to opt back in.';

        return {
          isOptOutKeyword: true,
          action: 'opt_out',
          response
        };
      }

      return { isOptOutKeyword: false };
    } catch (error) {
      this.logger.error('Error processing opt-out keyword:', error);
      return { isOptOutKeyword: false };
    }
  }

  /**
   * Get opt-out statistics
   * @param {Object} filters - Optional filters
   * @returns {Promise<Object>} Statistics object
   */
  async getOptOutStatistics(filters = {}) {
    try {

      const { startDate, endDate, campaignId } = filters;

      let whereClause = '';
      let params = [];

      if (startDate && endDate) {
        whereClause += ' WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }

      if (campaignId) {
        whereClause += whereClause ? ' AND' : ' WHERE';
        whereClause += ' opt_out_campaign_id = ?';
        params.push(campaignId);
      }



      const statsResult = await this.databaseService.get(`
        SELECT
          COUNT(*) as total_preferences,
          SUM(CASE WHEN opt_out_status = 'opted_out' THEN 1 ELSE 0 END) as total_opted_out,
          SUM(CASE WHEN opt_out_status = 'opted_in' THEN 1 ELSE 0 END) as total_opted_in,
          SUM(CASE WHEN marketing_consent = 0 THEN 1 ELSE 0 END) as marketing_opt_outs,
          SUM(CASE WHEN promotional_consent = 0 THEN 1 ELSE 0 END) as promotional_opt_outs,
          SUM(CASE WHEN transactional_consent = 0 THEN 1 ELSE 0 END) as transactional_opt_outs
        FROM communication_preferences${whereClause}
      `, params);

      // Extract the actual stats from the database response
      const stats = statsResult?.success ? statsResult.data : statsResult;

      const methodStatsResult = await this.databaseService.all(`
        SELECT opt_out_method, COUNT(*) as count
        FROM communication_preferences
        WHERE opt_out_status = 'opted_out'${whereClause.replace('created_at', 'opt_out_date')}
        GROUP BY opt_out_method
      `, params);

      // Extract the actual method stats from the database response
      const methodStats = methodStatsResult?.success ? methodStatsResult.data : methodStatsResult;

      // Get recent activity (last 10 opt-out/opt-in actions)
      const recentActivityResult = await this.databaseService.all(`
        SELECT
          cp.phone_number,
          cp.opt_out_date as activity_date,
          cp.opt_out_method,
          cp.opt_out_reason,
          cp.opt_out_status,
          c.name
        FROM communication_preferences cp
        LEFT JOIN contacts c ON cp.contact_id = c.id
        WHERE cp.opt_out_date IS NOT NULL
        ORDER BY cp.opt_out_date DESC
        LIMIT 10
      `);

      // Extract and format recent activity
      const recentActivityData = recentActivityResult?.success ? recentActivityResult.data : recentActivityResult;
      const recentActivity = Array.isArray(recentActivityData) ? recentActivityData.map(activity => ({
        phone_number: activity.phone_number,
        name: activity.name || 'Unknown',
        action: activity.opt_out_status === 'opted_out' ? 'Opted Out' : 'Opted In',
        method: activity.opt_out_method || 'Unknown',
        reason: activity.opt_out_reason || 'No reason provided',
        created_at: activity.activity_date,
        icon: activity.opt_out_status === 'opted_out' ? 'opt-out' : 'opt-in'
      })) : [];

      // Calculate weekly statistics (current week)
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay()); // Start of current week (Sunday)
      startOfWeek.setHours(0, 0, 0, 0);

      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6); // End of current week (Saturday)
      endOfWeek.setHours(23, 59, 59, 999);

      const weeklyStatsResult = await this.databaseService.get(`
        SELECT COUNT(*) as thisWeek
        FROM communication_preferences
        WHERE opt_out_status = 'opted_out'
        AND opt_out_date >= ?
        AND opt_out_date <= ?
      `, [startOfWeek.toISOString(), endOfWeek.toISOString()]);

      // Extract weekly stats
      const weeklyStats = weeklyStatsResult?.success ? weeklyStatsResult.data : weeklyStatsResult;
      const thisWeek = weeklyStats?.thisWeek || 0;



      // Calculate today's statistics
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 999);

      const todayStatsResult = await this.databaseService.get(`
        SELECT COUNT(*) as today
        FROM communication_preferences
        WHERE opt_out_status = 'opted_out'
        AND opt_out_date >= ?
        AND opt_out_date <= ?
      `, [startOfToday.toISOString(), endOfToday.toISOString()]);

      const todayStats = todayStatsResult?.success ? todayStatsResult.data : todayStatsResult;
      const today = todayStats?.today || 0;

      // Calculate this month's statistics
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const monthlyStatsResult = await this.databaseService.get(`
        SELECT COUNT(*) as thisMonth
        FROM communication_preferences
        WHERE opt_out_status = 'opted_out'
        AND opt_out_date >= ?
        AND opt_out_date <= ?
      `, [startOfMonth.toISOString(), endOfMonth.toISOString()]);

      const monthlyStats = monthlyStatsResult?.success ? monthlyStatsResult.data : monthlyStatsResult;
      const thisMonth = monthlyStats?.thisMonth || 0;

      const finalStats = {
        ...stats,
        optOutMethods: methodStats,
        optOutRate: stats && stats.total_preferences > 0 ? (stats.total_opted_out / stats.total_preferences * 100).toFixed(2) : 0,
        recentActivity: recentActivity,
        today: today,
        thisWeek: thisWeek,
        thisMonth: thisMonth
      };

      return finalStats;
    } catch (error) {
      this.logger.error('Error getting opt-out statistics:', error);
      return null;
    }
  }

  /**
   * Log compliance action for audit trail
   * @private
   */
  async logComplianceAction(phoneNumber, actionType, details) {
    try {
      const contact = await this.databaseService.get(
        'SELECT id FROM contacts WHERE phone_number = ?',
        [phoneNumber]
      );

      await this.databaseService.run(`
        INSERT INTO compliance_audit_log (
          phone_number, contact_id, action_type, action_details, campaign_id, session_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        phoneNumber,
        contact?.id || null,
        actionType,
        JSON.stringify(details),
        details.campaignId || null,
        details.sessionId || null
      ]);
    } catch (error) {
      this.logger.error('Error logging compliance action:', error);
    }
  }

  /**
   * Filter contacts for bulk messaging based on opt-out preferences
   * @param {Array} contacts - Array of contact objects with phone_number
   * @param {string} messageType - Type of message (marketing, transactional, promotional, reminder)
   * @returns {Promise<{allowedContacts: Array, blockedContacts: Array}>}
   */
  async filterContactsForBulkMessaging(contacts, messageType = 'marketing') {
    try {
      const allowedContacts = [];
      const blockedContacts = [];

      for (const contact of contacts) {
        try {
          const optOutStatus = await this.isOptedOut(contact.phone_number, messageType);

          if (optOutStatus.isOptedOut) {
            blockedContacts.push({
              ...contact,
              blockReason: optOutStatus.reason,
              optOutDate: optOutStatus.optOutDate
            });
          } else {
            allowedContacts.push(contact);
          }
        } catch (contactError) {
          // If there's an error checking a specific contact, log it but continue
          this.logger.warn(`Error checking opt-out status for ${contact.phone_number}:`, contactError);
          // Assume contact is allowed if we can't check (fail-open for individual contacts)
          allowedContacts.push(contact);
        }
      }

      this.logger.info(`Filtered ${contacts.length} contacts: ${allowedContacts.length} allowed, ${blockedContacts.length} blocked`);

      return { allowedContacts, blockedContacts };
    } catch (error) {
      this.logger.error('Error filtering contacts for bulk messaging:', error);
      // On critical error, fail-open: allow all contacts to proceed
      // The campaign scheduler will check opt-out status again before sending
      return { allowedContacts: contacts, blockedContacts: [] };
    }
  }

  /**
   * Get all opted-out contacts
   * @param {Object} filters - Optional filters
   * @returns {Promise<Array>} Array of opted-out contacts
   */
  async getOptedOutContacts(filters = {}) {
    try {
      const { messageType, startDate, endDate, method } = filters;

      let whereClause = 'WHERE cp.opt_out_status = "opted_out"';
      let params = [];

      if (messageType && messageType !== 'all') {
        whereClause += ` AND cp.${messageType}_consent = 0`;
      }

      if (startDate && endDate) {
        whereClause += ' AND cp.opt_out_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }

      if (method) {
        whereClause += ' AND cp.opt_out_method = ?';
        params.push(method);
      }

      const contactsResult = await this.databaseService.all(`
        SELECT
          cp.phone_number,
          cp.opt_out_date,
          cp.opt_out_method,
          cp.opt_out_reason,
          c.name,
          c.email,
          c.company
        FROM communication_preferences cp
        LEFT JOIN contacts c ON cp.contact_id = c.id
        ${whereClause}
        ORDER BY cp.opt_out_date DESC
      `, params);

      // Robust extraction of contacts array from various possible response formats
      let contacts = [];

      if (contactsResult) {
        if (Array.isArray(contactsResult)) {
          // Direct array response
          contacts = contactsResult;
        } else if (contactsResult.success && contactsResult.data) {
          if (Array.isArray(contactsResult.data)) {
            // Standard success response with data array
            contacts = contactsResult.data;
          } else if (contactsResult.data.rows && Array.isArray(contactsResult.data.rows)) {
            // Response with rows property
            contacts = contactsResult.data.rows;
          } else if (contactsResult.data.results && Array.isArray(contactsResult.data.results)) {
            // Response with results property
            contacts = contactsResult.data.results;
          }
        } else if (contactsResult.data && Array.isArray(contactsResult.data)) {
          // Response without success flag but with data
          contacts = contactsResult.data;
        }
      }

      return contacts;
    } catch (error) {
      this.logger.error('Error getting opted-out contacts:', error);
      return [];
    }
  }

  /**
   * Bulk opt-out multiple contacts
   * @param {Array} phoneNumbers - Array of phone numbers
   * @param {Object} options - Opt-out options
   * @returns {Promise<{success: number, failed: number, results: Array}>}
   */
  async bulkOptOut(phoneNumbers, options = {}) {
    try {
      const results = [];
      let successCount = 0;
      let failedCount = 0;

      for (const phoneNumber of phoneNumbers) {
        const result = await this.optOut(phoneNumber, options);
        results.push({ phoneNumber, ...result });

        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
      }

      this.logger.info(`Bulk opt-out completed: ${successCount} success, ${failedCount} failed`);

      return {
        success: successCount,
        failed: failedCount,
        results
      };
    } catch (error) {
      this.logger.error('Error in bulk opt-out:', error);
      return {
        success: 0,
        failed: phoneNumbers.length,
        results: phoneNumbers.map(phone => ({ phoneNumber: phone, success: false, message: error.message }))
      };
    }
  }

  /**
   * Check compliance before sending a message
   * @param {string} phoneNumber - Phone number to check
   * @param {string} messageType - Type of message
   * @param {number} campaignId - Campaign ID
   * @returns {Promise<{canSend: boolean, reason?: string, complianceStatus: string}>}
   */
  async checkComplianceBeforeSending(phoneNumber, messageType, campaignId = null) {
    try {
      const optOutStatus = await this.isOptedOut(phoneNumber, messageType);

      if (optOutStatus.isOptedOut) {
        // Log compliance violation attempt
        await this.logComplianceAction(phoneNumber, 'message_blocked', {
          messageType,
          campaignId,
          reason: optOutStatus.reason,
          complianceStatus: 'violation_prevented'
        });

        return {
          canSend: false,
          reason: optOutStatus.reason,
          complianceStatus: 'blocked'
        };
      }

      // Log compliant message attempt
      await this.logComplianceAction(phoneNumber, 'message_sent', {
        messageType,
        campaignId,
        complianceStatus: 'compliant'
      });

      return {
        canSend: true,
        complianceStatus: 'compliant'
      };
    } catch (error) {
      this.logger.error('Error checking compliance:', error);
      return {
        canSend: false,
        reason: 'Compliance check failed',
        complianceStatus: 'error'
      };
    }
  }

  /**
   * Get compliance report
   * @param {Object} filters - Report filters
   * @returns {Promise<Object>} Compliance report
   */
  async getComplianceReport(filters = {}) {
    try {
      const { startDate, endDate, campaignId } = filters;

      let whereClause = '';
      let params = [];

      if (startDate && endDate) {
        whereClause = 'WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }

      if (campaignId) {
        whereClause += whereClause ? ' AND' : 'WHERE';
        whereClause += ' campaign_id = ?';
        params.push(campaignId);
      }

      const report = await this.databaseService.get(`
        SELECT
          COUNT(*) as total_actions,
          SUM(CASE WHEN action_type = 'message_sent' THEN 1 ELSE 0 END) as messages_sent,
          SUM(CASE WHEN action_type = 'message_blocked' THEN 1 ELSE 0 END) as messages_blocked,
          SUM(CASE WHEN action_type = 'opt_out' THEN 1 ELSE 0 END) as opt_outs,
          SUM(CASE WHEN action_type = 'opt_in' THEN 1 ELSE 0 END) as opt_ins,
          SUM(CASE WHEN compliance_status = 'violation' THEN 1 ELSE 0 END) as violations
        FROM compliance_audit_log
        ${whereClause}
      `, params);

      const actionsByType = await this.databaseService.all(`
        SELECT action_type, compliance_status, COUNT(*) as count
        FROM compliance_audit_log
        ${whereClause}
        GROUP BY action_type, compliance_status
      `, params);

      return {
        ...report,
        actionsByType,
        complianceRate: report.total_actions > 0 ?
          ((report.total_actions - report.violations) / report.total_actions * 100).toFixed(2) : 100
      };
    } catch (error) {
      this.logger.error('Error generating compliance report:', error);
      return null;
    }
  }



  /**
   * Update auto-response messages for keywords
   * @param {Object} messages - Messages object with subscribe and unsubscribe properties
   * @returns {Promise<Object>} Update result
   */
  async updateAutoResponseMessages(messages) {
    try {

      // Ensure opt_out_settings table exists
      await this.databaseService.run(`
        CREATE TABLE IF NOT EXISTS opt_out_settings (
          id INTEGER PRIMARY KEY,
          subscribe_message TEXT,
          unsubscribe_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);


      const result = await this.databaseService.run(`
        INSERT OR REPLACE INTO opt_out_settings (id, subscribe_message, unsubscribe_message, updated_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      `, [messages.subscribe, messages.unsubscribe]);


      // CRITICAL: Save the database to disk (sql.js is in-memory)
      await this.databaseService.saveDatabase();

      return {
        success: true,
        message: 'Auto-response messages updated successfully'
      };
    } catch (error) {
      console.error('❌ Error updating auto-response messages:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Normalize phone number format
   * @private
   */
  normalizePhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    let normalized = phoneNumber.replace(/[^\d]/g, '');

    // Add country code if missing (assuming India +91)
    if (!normalized.startsWith('91') && normalized.length === 10) {
      normalized = '91' + normalized;
    }

    return normalized;
  }

  /**
   * Get opt-out statistics
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics() {
    try {
      const result = await this.databaseService.get(`
        SELECT 
          COUNT(*) as total_contacts,
          SUM(CASE WHEN opt_out_status = 'opted_out' THEN 1 ELSE 0 END) as opted_out_count,
          SUM(CASE WHEN opt_out_status = 'opted_in' THEN 1 ELSE 0 END) as opted_in_count,
          SUM(CASE WHEN marketing_consent = 0 THEN 1 ELSE 0 END) as marketing_opt_out,
          SUM(CASE WHEN promotional_consent = 0 THEN 1 ELSE 0 END) as promotional_opt_out,
          SUM(CASE WHEN transactional_consent = 0 THEN 1 ELSE 0 END) as transactional_opt_out,
          SUM(CASE WHEN reminder_consent = 0 THEN 1 ELSE 0 END) as reminder_opt_out
        FROM communication_preferences
      `);

      if (result.success && result.data) {
        return {
          success: true,
          stats: result.data
        };
      } else {
        return {
          success: true,
          stats: {
            total_contacts: 0,
            opted_out_count: 0,
            opted_in_count: 0,
            marketing_opt_out: 0,
            promotional_opt_out: 0,
            transactional_opt_out: 0,
            reminder_opt_out: 0
          }
        };
      }
    } catch (error) {
      this.logger.error('Error getting opt-out statistics:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get auto-response messages settings
   * @returns {Promise<Object>} Auto-response messages
   */
  async getAutoResponseMessages() {
    try {

      const result = await this.databaseService.get(`
        SELECT subscribe_message, unsubscribe_message
        FROM opt_out_settings
        WHERE id = 1
      `);


      // databaseService.get() returns the row object directly, or null if no data
      if (result && result.subscribe_message && result.unsubscribe_message) {
        return {
          success: true,
          messages: {
            subscribe: result.subscribe_message,
            unsubscribe: result.unsubscribe_message
          }
        };
      } else {
        return {
          success: true,
          messages: {
            subscribe: 'You have been subscribed to our messages. Reply UNSUBSCRIBE to unsubscribe.',
            unsubscribe: 'You have been unsubscribed from our messages. Reply SUBSCRIBE to opt back in.'
          }
        };
      }
    } catch (error) {
      console.error('❌ Error getting auto-response messages:', error);
      this.logger.error('Error getting auto-response messages:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

}

module.exports = OptOutService;
