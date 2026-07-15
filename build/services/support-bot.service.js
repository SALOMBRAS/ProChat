const pino = require('pino');

/**
 * Support Bot Service
 * Handles customer data lookup from Excel imports with dynamic field mapping
 */
class SupportBotService {
  constructor(databaseService, whatsappService) {
    this.db = databaseService;
    this.whatsapp = whatsappService;
    this.logger = pino({ level: 'info' });
  }

  /**
   * Process incoming message for support bot lookup
   * @param {string} sessionId - WhatsApp session ID
   * @param {object} message - Incoming message object
   * @returns {boolean} - True if message was processed by support bot
   */
  async processMessage(sessionId, message) {
    try {
      // Get support bot settings for this session
      const settings = await this.getSettings(sessionId);

      if (!settings) {
        return false;
      }

      if (!settings.is_active) {
        this.logger.info(`⚠️ Support Bot: Bot is inactive for session ${sessionId}`);
        return false; // Support bot not enabled for this session
      }

      this.logger.info(`✅ Support Bot: Active bot found - "${settings.name}"`);
      this.logger.info(`   Trigger Field: ${settings.trigger_field}`);
      this.logger.info(`   ID Pattern: ${settings.id_pattern}`);

      // Extract message text
      const messageText = this.extractMessageText(message);

      if (!messageText || !messageText.trim()) {
        this.logger.info(`⚠️ Support Bot: Empty message, skipping`);
        return false; // Empty message
      }

      const trimmedText = messageText.trim();
      this.logger.info(`📝 Support Bot: Message text = "${trimmedText}"`);

      // Check if message matches the ID pattern
      const regex = new RegExp(settings.id_pattern);
      const patternMatches = regex.test(trimmedText);

      this.logger.info(`🔍 Support Bot: Pattern test - "${trimmedText}" vs /${settings.id_pattern}/ = ${patternMatches}`);

      if (!patternMatches) {
        this.logger.info(`❌ Support Bot: Message does not match pattern, skipping`);
        return false; // Not a customer ID
      }

      this.logger.info(`🤖 Support Bot: Pattern matched! Processing lookup for "${trimmedText}"`);

      // Extract recipient JID from message
      const recipientJid = message.key?.remoteJid || message.from;

      // Lookup customer data
      const customerData = await this.lookupCustomer(sessionId, settings.trigger_field, trimmedText);

      const userPhone = this.extractPhoneNumber(recipientJid);

      if (customerData) {
        this.logger.info(`✅ Support Bot: Customer found!`);
        this.logger.info(`   Customer Data: ${JSON.stringify(customerData)}`);

        // Send success response with attachment if configured
        await this.sendResponse(
          sessionId,
          recipientJid,
          customerData,
          settings.response_template,
          settings.attachment_path,
          settings.attachment_type || 'image'
        );

        // Log success
        await this.logLookup(sessionId, userPhone, trimmedText, true, true, null);

        this.logger.info(`✅ Support Bot: Successfully sent response for "${trimmedText}"`);
        return true; // Message processed
      } else {
        this.logger.info(`❌ Support Bot: Customer "${trimmedText}" not found in database`);

        // Send not found message
        await this.sendNotFoundMessage(sessionId, recipientJid, settings);

        // Log failure
        await this.logLookup(sessionId, userPhone, trimmedText, false, true, 'Customer not found');

        this.logger.info(`⚠️ Support Bot: Sent "not found" message`);
        return true; // Message processed (even though not found)
      }
    } catch (error) {
      this.logger.error('❌ Support Bot: Error in message processing:', error);
      return false;
    }
  }

  /**
   * Lookup customer in database by trigger field
   * @param {string} sessionId - Session ID
   * @param {string} triggerField - Field name to search by
   * @param {string} value - Value to search for
   * @returns {object|null} - Customer data or null
   */
  async lookupCustomer(sessionId, triggerField, value) {
    try {
      this.logger.info(`🔍 Looking up customer: session=${sessionId}, field=${triggerField}, value="${value}"`);

      const result = await this.db.query(
        'SELECT customer_data FROM support_bot_customers WHERE session_id = ?',
        [sessionId]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        this.logger.info(`⚠️ No customer records found for session ${sessionId}`);
        return null;
      }

      this.logger.info(`📊 Found ${result.data.length} customer records to search`);

      // Search through all customer records
      let recordIndex = 0;
      for (const record of result.data) {
        try {
          const customerData = JSON.parse(record.customer_data);
          const triggerValue = customerData[triggerField];

          this.logger.info(`   Record ${recordIndex + 1}: ${triggerField} = "${triggerValue}" (comparing with "${value}")`);

          // Check if trigger field matches (case-insensitive)
          if (triggerValue && triggerValue.toString().toLowerCase() === value.toLowerCase()) {
            this.logger.info(`✅ MATCH FOUND at record ${recordIndex + 1}!`);
            return customerData;
          }

          recordIndex++;
        } catch (parseError) {
          this.logger.error(`Error parsing customer data at record ${recordIndex}:`, parseError);
          recordIndex++;
        }
      }

      this.logger.info(`❌ No matching customer found after checking ${recordIndex} records`);
      return null;
    } catch (error) {
      this.logger.error('Error looking up customer:', error);
      return null;
    }
  }

  /**
   * Send formatted response with customer data
   * @param {string} sessionId - Session ID
   * @param {string} recipientJid - Recipient WhatsApp JID
   * @param {object} customerData - Customer data object
   * @param {string} template - Message template with variables
   * @param {string} attachmentPath - Optional path to attachment file
   * @param {string} attachmentType - Type of attachment (image, video, document)
   */
  async sendResponse(sessionId, recipientJid, customerData, template, attachmentPath = null, attachmentType = 'image') {
    try {
      // Replace variables in template
      let message = template;

      // Replace all customer fields using {{field_name}} syntax
      Object.keys(customerData).forEach(key => {
        const value = customerData[key] || '';
        const regex = new RegExp(`{{${key}}}`, 'g');
        message = message.replace(regex, value);
      });

      // Send with attachment if provided
      if (attachmentPath) {
        const fs = require('fs').promises;

        // Read file and convert to buffer
        const fileBuffer = await fs.readFile(attachmentPath);

        await this.whatsapp.sendMediaMessage(sessionId, recipientJid, fileBuffer, attachmentType, message);
        this.logger.info(`📤 Support Bot: Sent response with ${attachmentType} to ${recipientJid}`);
      } else {
        // Send text only
        await this.whatsapp.sendMessage(sessionId, recipientJid, message);
        this.logger.info(`📤 Support Bot: Sent response to ${recipientJid}`);
      }
    } catch (error) {
      this.logger.error('Error sending support bot response:', error);
      throw error;
    }
  }

  /**
   * Send not found message
   * @param {string} sessionId - WhatsApp session ID
   * @param {string} recipientJid - Recipient JID
   * @param {object} settings - Support bot settings containing not_found_message and not_found_template_id
   */
  async sendNotFoundMessage(sessionId, recipientJid, settings) {
    try {
      // Check if a template is selected
      if (settings.not_found_template_id) {
        // Load the template from database
        const template = await this.db.get(
          'SELECT * FROM message_templates WHERE id = ?',
          [settings.not_found_template_id]
        );

        if (template) {
          this.logger.info(`📤 Support Bot: Sending template "${template.name}" as not found message`);

          // Parse template data
          const templateData = {
            ...template,
            buttons: template.buttons ? JSON.parse(template.buttons) : null,
            attachments: template.attachments ? JSON.parse(template.attachments) : null,
            interactive_settings: template.interactive_settings ? JSON.parse(template.interactive_settings) : null
          };

          // Send using template message method
          await this.whatsapp.sendTemplateMessage(sessionId, recipientJid, templateData, {});
          this.logger.info(`📤 Support Bot: Sent template not found message to ${recipientJid}`);
          return;
        } else {
          this.logger.warn(`⚠️ Support Bot: Template ${settings.not_found_template_id} not found, falling back to text message`);
        }
      }

      // Fall back to plain text message
      await this.whatsapp.sendMessage(sessionId, recipientJid, settings.not_found_message);
      this.logger.info(`📤 Support Bot: Sent text not found message to ${recipientJid}`);
    } catch (error) {
      this.logger.error('Error sending not found message:', error);
    }
  }

  /**
   * Get support bot settings for a session
   */
  async getSettings(sessionId) {
    try {
      const result = await this.db.get(
        'SELECT * FROM support_bot_settings WHERE session_id = ? AND is_active = 1',
        [sessionId]
      );
      // db.get() returns the data directly, not wrapped in {success, data}
      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * Import customer data from Excel
   * @param {string} sessionId - Session ID
   * @param {array} customerRecords - Array of customer data objects
   * @returns {object} - Import result with success count
   */
  async importCustomerData(sessionId, customerRecords) {
    try {
      let successCount = 0;
      let errorCount = 0;

      // Clear existing customer data for this session
      await this.db.run(
        'DELETE FROM support_bot_customers WHERE session_id = ?',
        [sessionId]
      );

      // Insert new customer records
      for (const record of customerRecords) {
        try {
          const result = await this.db.run(
            `INSERT INTO support_bot_customers (session_id, customer_data, created_at, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [sessionId, JSON.stringify(record)]
          );

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          this.logger.error('Error inserting customer record:', error);
          errorCount++;
        }
      }

      this.logger.info(`📊 Support Bot: Imported ${successCount} records, ${errorCount} errors`);

      return {
        success: true,
        imported: successCount,
        errors: errorCount,
        total: customerRecords.length
      };
    } catch (error) {
      this.logger.error('Error importing customer data:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Save field mappings
   */
  async saveFieldMappings(sessionId, mappings) {
    try {
      // Clear existing mappings
      await this.db.run(
        'DELETE FROM support_bot_field_mappings WHERE session_id = ?',
        [sessionId]
      );

      // Insert new mappings
      for (const mapping of mappings) {
        await this.db.run(
          `INSERT INTO support_bot_field_mappings
           (session_id, excel_column, field_name, field_type, is_trigger, display_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            sessionId,
            mapping.excelColumn,
            mapping.fieldName,
            mapping.fieldType || 'text',
            mapping.isTrigger ? 1 : 0,
            mapping.displayOrder || 0
          ]
        );
      }

      this.logger.info(`✅ Support Bot: Saved ${mappings.length} field mappings`);
      return { success: true };
    } catch (error) {
      this.logger.error('Error saving field mappings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get field mappings for a session
   */
  async getFieldMappings(sessionId) {
    try {
      const result = await this.db.query(
        'SELECT * FROM support_bot_field_mappings WHERE session_id = ? ORDER BY display_order ASC',
        [sessionId]
      );
      return result.success ? result.data : [];
    } catch (error) {
      this.logger.error('Error getting field mappings:', error);
      return [];
    }
  }

  /**
   * Log lookup attempt
   */
  async logLookup(sessionId, userPhone, lookupValue, success, responseSent, errorMessage) {
    try {
      // Use local time instead of UTC
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const localTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

      await this.db.run(
        `INSERT INTO support_bot_logs
         (session_id, user_phone, lookup_value, success, response_sent, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, userPhone, lookupValue, success ? 1 : 0, responseSent ? 1 : 0, errorMessage, localTime]
      );
    } catch (error) {
      this.logger.error('Error logging lookup:', error);
    }
  }

  /**
   * Get statistics for a session
   */
  async getStatistics(sessionId) {
    try {
      const result = await this.db.get(
        `SELECT
          COUNT(*) as total_lookups,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_lookups,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_lookups
         FROM support_bot_logs
         WHERE session_id = ?`,
        [sessionId]
      );

      const customerCountResult = await this.db.get(
        'SELECT COUNT(*) as customer_count FROM support_bot_customers WHERE session_id = ?',
        [sessionId]
      );

      return {
        totalLookups: result.data?.total_lookups || 0,
        successfulLookups: result.data?.successful_lookups || 0,
        failedLookups: result.data?.failed_lookups || 0,
        customerCount: customerCountResult.data?.customer_count || 0
      };
    } catch (error) {
      this.logger.error('Error getting statistics:', error);
      return {
        totalLookups: 0,
        successfulLookups: 0,
        failedLookups: 0,
        customerCount: 0
      };
    }
  }

  /**
   * Extract message text from WhatsApp message object
   */
  extractMessageText(message) {
    // Handle ephemeral (disappearing) messages
    if (message.message?.ephemeralMessage?.message) {
      const ephemeralMsg = message.message.ephemeralMessage.message;
      if (ephemeralMsg.conversation) {
        return ephemeralMsg.conversation;
      }
      if (ephemeralMsg.extendedTextMessage?.text) {
        return ephemeralMsg.extendedTextMessage.text;
      }
    }

    // Handle regular messages
    if (message.message?.conversation) {
      return message.message.conversation;
    }
    if (message.message?.extendedTextMessage?.text) {
      return message.message.extendedTextMessage.text;
    }
    if (message.text) {
      return message.text;
    }
    return '';
  }

  /**
   * Extract phone number from JID
   */
  extractPhoneNumber(jid) {
    if (!jid) return '';
    return jid.split('@')[0];
  }

  /**
   * Upload attachment file
   * @param {object} file - File object with name, type, and data (base64)
   * @param {string} sessionId - Session ID for organizing files
   * @returns {object} - Result with path to saved file
   */
  async uploadAttachment(file, sessionId) {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const { app } = require('electron');

      // Create attachments directory if it doesn't exist
      const attachmentsDir = path.join(app.getPath('userData'), 'support-bot-attachments', sessionId);
      await fs.mkdir(attachmentsDir, { recursive: true });

      // Generate unique filename
      const timestamp = Date.now();
      const ext = path.extname(file.name);
      const filename = `${timestamp}${ext}`;
      const filePath = path.join(attachmentsDir, filename);

      // Convert base64 to buffer and save
      const base64Data = file.data.replace(/^data:.*?;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(filePath, buffer);

      this.logger.info(`📎 Support Bot: Attachment saved to ${filePath}`);

      return {
        success: true,
        path: filePath
      };
    } catch (error) {
      this.logger.error('Error uploading attachment:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = SupportBotService;

