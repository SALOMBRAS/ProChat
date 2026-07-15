/**
 * Live Chat Service
 * Handles all live chat operations including conversations, messages, contacts, and CRM
 */

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

class LiveChatService extends EventEmitter {
  constructor(databaseService, whatsappService = null) {
    super();
    this.db = databaseService;
    this.whatsappService = whatsappService;
    this.initialized = false;
  }

  /**
   * Log to file (for production debugging)
   */
  log(message) {
    try {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] ${message}`;

      // Try to use the global logToFile function if available
      if (typeof global.logToFile === 'function') {
        global.logToFile(logMessage);
      }
    } catch (error) {
      console.error('Error logging:', error);
    }
  }

  /**
   * Initialize Live Chat Service
   */
  async initialize() {
    try {
      this.log('🔄 Live Chat Service: Starting initialization...');

      // Run database migrations
      await this.runMigrations();

      // Setup event listeners for WhatsApp messages
      this.setupEventListeners();

      this.initialized = true;
      this.log('✅ Live Chat Service: Initialized successfully');

      return { success: true };
    } catch (error) {
      this.log(`❌ Live Chat Service: Error initializing: ${error.message}`);
      this.log(`❌ Live Chat Service: Error stack: ${error.stack}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Setup event listeners for WhatsApp messages
   */
  setupEventListeners() {
    if (!this.whatsappService) {
      this.log('⚠️ Live Chat Service: WhatsApp service not available, skipping event listeners');
      return;
    }

    this.log('🔄 Live Chat Service: Setting up event listeners...');

    // Listen for incoming messages from WhatsApp
    this.whatsappService.on('message_received', async (data) => {
      try {
        await this.handleWhatsAppMessage(data);
      } catch (error) {
        this.log(`❌ Live Chat Service: Error handling WhatsApp message: ${error.message}`);
        console.error('❌ Live Chat Service: Error handling WhatsApp message:', error);
      }
    });

    this.log('✅ Live Chat Service: Event listeners setup complete');
  }

  /**
   * Handle incoming WhatsApp message and sync to Live Chat
   */
  async handleWhatsAppMessage(data) {
    try {
      const { sessionId, message, formattedMessage } = data;

      if (!formattedMessage) {
        this.log('⚠️ Live Chat Service: No formatted message, skipping');
        return;
      }

      this.log(`📨 Live Chat Service: Handling message from session ${sessionId}, fromMe: ${message.key.fromMe}`);

      // Extract contact information
      const remoteJid = message.key.remoteJid;
      const contactPhone = remoteJid.split('@')[0];

      // Get contact name from formatted message or use phone number
      const contactName = formattedMessage.senderName || formattedMessage.from || contactPhone;

      // Get or create conversation
      const conversation = await this.getOrCreateConversation(
        sessionId,
        contactPhone,
        contactName,
        null, // avatar
        remoteJid // fullChatId
      );

      if (!conversation.success) {
        this.log(`❌ Live Chat Service: Failed to get/create conversation: ${conversation.error}`);
        return;
      }

      const conversationId = `${sessionId}_${contactPhone}`;

      // Determine sender type
      const senderType = message.key.fromMe ? 'agent' : 'customer';

      // Prepare message data
      const messageData = {
        messageId: message.key.id,
        senderType,
        senderName: contactName,
        content: formattedMessage.text || formattedMessage.caption || '',
        messageType: formattedMessage.type || 'text',
        attachmentUrl: formattedMessage.mediaUrl || null,
        attachmentName: formattedMessage.fileName || null,
        attachmentSize: formattedMessage.fileSize || null,
        attachmentMimeType: formattedMessage.mimeType || null,
        caption: formattedMessage.caption || null,
        metadata: JSON.stringify({
          whatsappMessageId: message.key.id,
          remoteJid: remoteJid,
          timestamp: formattedMessage.timestamp || new Date().toISOString()
        }),
        status: 'sent'
      };

      // Save message to database
      const result = await this.saveMessage(conversationId, messageData);

      if (result.success) {
        this.log(`✅ Live Chat Service: Message saved successfully for conversation ${conversationId}`);

        // Emit event for real-time UI updates
        this.emit('message:new', {
          conversationId,
          sessionId,
          messageData,
          message: formattedMessage
        });
      } else {
        this.log(`❌ Live Chat Service: Failed to save message: ${result.error}`);
      }
    } catch (error) {
      this.log(`❌ Live Chat Service: Error in handleWhatsAppMessage: ${error.message}`);
      console.error('❌ Live Chat Service: Error in handleWhatsAppMessage:', error);
    }
  }

  /**
   * Run database migrations
   */
  async runMigrations() {
    try {
      const migrationPath = path.join(__dirname, '..', 'database', 'migrations', 'live_chat_schema.sql');
      this.log(`🔄 Live Chat Service: Migration path: ${migrationPath}`);
      this.log(`🔄 Live Chat Service: __dirname: ${__dirname}`);

      // Use synchronous fs.readFileSync for better ASAR compatibility
      if (fs.existsSync(migrationPath)) {
        this.log('✅ Live Chat Service: Migration file found, reading...');
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        this.log(`✅ Live Chat Service: Migration SQL loaded (${migrationSQL.length} bytes)`);

        // Execute individual SQL statements
        // Split by semicolon and filter out comments and empty statements
        const statements = migrationSQL
          .split(';')
          .map(stmt => stmt.trim())
          .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

        this.log(`🔄 Live Chat Service: Executing ${statements.length} SQL statements...`);

        for (let i = 0; i < statements.length; i++) {
          const statement = statements[i].trim();
          if (statement) {
            try {
              await this.db.run(statement);
              this.log(`✅ Live Chat Service: Statement ${i + 1}/${statements.length} executed`);
            } catch (stmtError) {
              // Ignore "table already exists" errors
              if (stmtError.message && stmtError.message.includes('already exists')) {
                this.log(`ℹ️ Live Chat Service: Table already exists (statement ${i + 1}), skipping...`);
              } else {
                this.log(`❌ Live Chat Service: Error in statement ${i + 1}: ${stmtError.message}`);
                throw stmtError;
              }
            }
          }
        }

        this.log('✅ Live Chat Service: All migrations executed successfully');
      } else {
        this.log(`❌ Live Chat Service: Migration file not found: ${migrationPath}`);
        throw new Error(`Migration file not found: ${migrationPath}`);
      }

    } catch (error) {
      this.log(`❌ Live Chat Service: Error running migrations: ${error.message}`);
      this.log(`❌ Live Chat Service: Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Get or create conversation
   */
  async getOrCreateConversation(sessionId, contactPhone, contactName = null, contactAvatar = null, fullChatId = null) {
    try {
      const conversationId = `${sessionId}_${contactPhone}`;

      // CRITICAL: Check by fullChatId first (if provided), then by contact_phone
      // This handles LID chats where the same person might have different identifiers
      let existing = null;

      if (fullChatId) {
        // First try to find by fullChatId in metadata
        const byMetadata = await this.db.query(
          `SELECT * FROM live_chat_conversations
           WHERE session_id = ? AND metadata LIKE ?
           ORDER BY updated_at DESC LIMIT 1`,
          [sessionId, `%"fullChatId":"${fullChatId}"%`]
        );

        if (byMetadata.success && byMetadata.data && byMetadata.data.length > 0) {
          existing = byMetadata;
        }
      }

      // If not found by fullChatId, try by contact_phone
      if (!existing) {
        existing = await this.db.query(
          'SELECT * FROM live_chat_conversations WHERE session_id = ? AND contact_phone = ? ORDER BY updated_at DESC LIMIT 1',
          [sessionId, contactPhone]
        );
      }

      if (existing.success && existing.data && existing.data.length > 0) {
        const conv = existing.data[0];

        // If conversation_id doesn't match the expected format, update it
        if (conv.conversation_id !== conversationId) {

          await this.db.run(
            'UPDATE live_chat_conversations SET conversation_id = ? WHERE id = ?',
            [conversationId, conv.id]
          );
          conv.conversation_id = conversationId;
        }

        // Update contact name if:
        // 1. New name is provided AND different from current
        // 2. OR current name is just a phone number and we have a real name
        const currentNameIsPhone = conv.contact_name === contactPhone;
        const shouldUpdateName = contactName && (
          contactName !== conv.contact_name ||
          (currentNameIsPhone && contactName !== contactPhone)
        );

        if (shouldUpdateName) {
          await this.db.run(
            'UPDATE live_chat_conversations SET contact_name = ? WHERE id = ?',
            [contactName, conv.id]
          );
          conv.contact_name = contactName;
        }

        return { success: true, conversation: conv };
      }

      // Create new conversation
      // If contactName is null or "null" string, use formatted phone number
      let finalContactName = contactName;
      if (!contactName || contactName === 'null') {
        finalContactName = '+' + contactPhone;
      }

      const result = await this.db.run(
        `INSERT INTO live_chat_conversations
        (conversation_id, session_id, contact_phone, contact_name, contact_avatar, status, last_message_at)
        VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))`,
        [conversationId, sessionId, contactPhone, finalContactName, contactAvatar]
      );

      if (result.success) {

        // Also create or update contact
        await this.createOrUpdateContact(contactPhone, contactName, contactAvatar);

        const newConversation = await this.db.query(
          'SELECT * FROM live_chat_conversations WHERE id = ?',
          [result.lastID]
        );

        return { success: true, conversation: newConversation.data[0] };
      }

      return { success: false, error: 'Failed to create conversation' };
    } catch (error) {
      console.error('❌ Error getting/creating conversation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save message to database
   */
  async saveMessage(conversationId, messageData) {
    try {
      const {
        messageId,
        senderType,
        senderName,
        content,
        messageType = 'text',
        attachmentUrl = null,
        attachmentName = null,
        attachmentSize = null,
        attachmentMimeType = null,
        caption = null,
        metadata = null,
        status = 'sent'
      } = messageData;

      // Get conversation database ID
      const conv = await this.db.query(
        'SELECT id FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!conv.success || !conv.data || conv.data.length === 0) {
        return { success: false, error: 'Conversation not found' };
      }

      const dbConversationId = conv.data[0].id;

      // Insert message
      const result = await this.db.run(
        `INSERT INTO live_chat_messages
        (message_id, conversation_id, sender_type, sender_name, content, message_type,
         attachment_url, attachment_name, attachment_size, attachment_mime_type, caption, metadata, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [messageId, dbConversationId, senderType, senderName, content, messageType,
         attachmentUrl, attachmentName, attachmentSize, attachmentMimeType, caption,
         metadata ? JSON.stringify(metadata) : null, status]
      );

      if (result.success) {
        // Update conversation last message
        await this.db.run(
          `UPDATE live_chat_conversations
           SET last_message_at = datetime('now'),
               last_message_preview = ?,
               unread_count = CASE WHEN ? = 'customer' THEN unread_count + 1 ELSE unread_count END
           WHERE id = ?`,
          [content || `[${messageType}]`, senderType, dbConversationId]
        );

        // Emit event for real-time updates
        this.emit('message:new', { conversationId, messageData });

        return { success: true, messageId: result.lastID };
      }

      return { success: false, error: 'Failed to save message' };
    } catch (error) {
      console.error('❌ Error saving message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get conversations with filters
   */
  async getConversations(sessionId, filters = {}) {
    try {
      const { status = 'active', assignedTo = null, limit = 50, offset = 0 } = filters;

      let query = `
        SELECT c.*,
               COUNT(DISTINCT m.id) as message_count,
               MAX(m.created_at) as last_message_time
        FROM live_chat_conversations c
        LEFT JOIN live_chat_messages m ON c.id = m.conversation_id
        WHERE c.session_id = ?
      `;

      const params = [sessionId];

      if (status && status !== 'all') {
        query += ' AND c.status = ?';
        params.push(status);
      }

      if (assignedTo) {
        query += ' AND c.assigned_to = ?';
        params.push(assignedTo);
      }

      query += ' GROUP BY c.id ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const result = await this.db.query(query, params);

      return result;
    } catch (error) {
      console.error('❌ Error getting conversations:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get messages for a conversation
   */
  async getMessages(conversationId, limit = 100, offset = 0) {
    try {
      // Get conversation database ID
      const conv = await this.db.query(
        'SELECT id FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!conv.success || !conv.data || conv.data.length === 0) {
        return { success: false, error: 'Conversation not found' };
      }

      const dbConversationId = conv.data[0].id;

      const result = await this.db.query(
        `SELECT * FROM live_chat_messages
         WHERE conversation_id = ? AND is_deleted = 0
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
        [dbConversationId, limit, offset]
      );

      return result;
    } catch (error) {
      console.error('❌ Error getting messages:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Mark conversation as read
   */
  async markAsRead(conversationId) {
    try {

      // Get conversation details to extract session and chat ID
      const convResult = await this.db.query(
        'SELECT session_id, contact_phone, metadata FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!convResult.success || !convResult.data || convResult.data.length === 0) {

        // Try to create the conversation if it doesn't exist
        // Extract session and phone from conversation_id (format: session_phone)
        const parts = conversationId.split('_');
        if (parts.length >= 2) {
          const sessionId = parts.slice(0, -1).join('_'); // Everything except last part
          const contactPhone = parts[parts.length - 1]; // Last part is phone/LID


          // Create the conversation
          const createResult = await this.getOrCreateConversation(sessionId, contactPhone);

          if (createResult.success) {
            // Now mark it as read
            const result = await this.db.run(
              'UPDATE live_chat_conversations SET unread_count = 0 WHERE conversation_id = ?',
              [conversationId]
            );
            return result;
          }
        }

        return { success: false, error: 'Conversation not found and could not be created' };
      }

      const conversation = convResult.data[0];
      const sessionId = conversation.session_id;


      // Extract fullChatId from metadata
      let chatId = null;
      if (conversation.metadata) {
        try {
          const metadata = JSON.parse(conversation.metadata);
          chatId = metadata.fullChatId;
        } catch (e) {
        }
      }

      // Fallback to constructing chat ID from phone number
      if (!chatId && conversation.contact_phone) {
        chatId = `${conversation.contact_phone}@s.whatsapp.net`;
      }

      // Update database unread count
      const result = await this.db.run(
        'UPDATE live_chat_conversations SET unread_count = 0 WHERE conversation_id = ?',
        [conversationId]
      );


      // Also mark as read in WhatsApp if we have the WhatsApp service and chat ID
      if (this.whatsappService && chatId && sessionId) {
        try {
          await this.whatsappService.markChatAsRead(sessionId, chatId);
        } catch (whatsappError) {
          // Don't fail the whole operation if WhatsApp marking fails
        }
      }

      this.emit('conversation:read', { conversationId });

      return result;
    } catch (error) {
      console.error('❌ Error marking conversation as read:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update conversation
   */
  async updateConversation(conversationId, updates) {
    try {
      const fields = [];
      const values = [];

      if (updates.metadata !== undefined) {
        fields.push('metadata = ?');
        values.push(updates.metadata);
      }
      if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.contact_name !== undefined) {
        fields.push('contact_name = ?');
        values.push(updates.contact_name);
      }
      if (updates.contact_phone !== undefined) {
        fields.push('contact_phone = ?');
        values.push(updates.contact_phone);
      }

      if (fields.length === 0) {
        return { success: true };
      }

      values.push(conversationId);

      const result = await this.db.run(
        `UPDATE live_chat_conversations SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      return result;
    } catch (error) {
      console.error('❌ Error updating conversation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update conversation status
   */
  async updateConversationStatus(conversationId, status) {
    try {
      await this.db.run(
        `UPDATE live_chat_conversations
         SET status = ?,
             resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END,
             archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE archived_at END
         WHERE conversation_id = ?`,
        [status, status, status, conversationId]
      );

      // Log activity
      await this.logActivity(conversationId, 'status_changed', null, { newStatus: status });

      this.emit('conversation:status_changed', { conversationId, status });

      return { success: true };
    } catch (error) {
      console.error('❌ Error updating conversation status:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create or update contact (CRM)
   */
  async createOrUpdateContact(phone, name = null, avatar = null, additionalData = {}) {
    try {
      // Check if contact exists
      const existing = await this.db.query(
        'SELECT * FROM live_chat_contacts WHERE phone = ?',
        [phone]
      );

      if (existing.success && existing.data && existing.data.length > 0) {
        // Update existing contact
        const updates = [];
        const params = [];

        if (name) {
          updates.push('name = ?');
          params.push(name);
        }
        if (avatar) {
          updates.push('avatar = ?');
          params.push(avatar);
        }
        if (additionalData.email !== undefined) {
          updates.push('email = ?');
          params.push(additionalData.email);
        }
        if (additionalData.company !== undefined) {
          updates.push('company = ?');
          params.push(additionalData.company);
        }
        if (additionalData.tags !== undefined) {
          updates.push('tags = ?');
          params.push(additionalData.tags);
        }

        updates.push('last_contact_at = datetime(\'now\')');
        updates.push('updated_at = datetime(\'now\')');
        params.push(phone);

        if (updates.length > 0) {
          await this.db.run(
            `UPDATE live_chat_contacts SET ${updates.join(', ')} WHERE phone = ?`,
            params
          );
        }

        // Fetch updated contact
        const updated = await this.db.query(
          'SELECT * FROM live_chat_contacts WHERE phone = ?',
          [phone]
        );

        return { success: true, contact: updated.data[0] };
      } else {
        // Create new contact
        const result = await this.db.run(
          `INSERT INTO live_chat_contacts
          (phone, name, avatar, email, company, tags, first_contact_at, last_contact_at, total_conversations)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)`,
          [phone, name, avatar, additionalData.email || null, additionalData.company || null, additionalData.tags || null]
        );

        if (result.success) {
          const newContact = await this.db.query(
            'SELECT * FROM live_chat_contacts WHERE id = ?',
            [result.lastID]
          );
          return { success: true, contact: newContact.data[0] };
        }
      }

      return { success: false, error: 'Failed to create/update contact' };
    } catch (error) {
      console.error('❌ Error creating/updating contact:', error);
      return { success: false, error: error.message };
    }
  }


  /**
   * Get contact details
   */
  async getContact(phone) {
    try {
      const result = await this.db.query(
        'SELECT * FROM live_chat_contacts WHERE phone = ?',
        [phone]
      );

      return result;
    } catch (error) {
      console.error('❌ Error getting contact:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add note to conversation
   */
  async addNote(conversationId, author, content, noteType = 'general') {
    try {
      // Get conversation database ID
      const conv = await this.db.query(
        'SELECT id, contact_phone FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!conv.success || !conv.data || conv.data.length === 0) {
        return { success: false, error: 'Conversation not found' };
      }

      const dbConversationId = conv.data[0].id;

      // Get contact ID
      const contact = await this.db.query(
        'SELECT id FROM live_chat_contacts WHERE phone = ?',
        [conv.data[0].contact_phone]
      );

      const contactId = contact.success && contact.data && contact.data.length > 0 ? contact.data[0].id : null;

      await this.db.run(
        `INSERT INTO live_chat_notes (conversation_id, contact_id, author, note_type, content)
         VALUES (?, ?, ?, ?, ?)`,
        [dbConversationId, contactId, author, noteType, content]
      );

      this.emit('note:added', { conversationId, noteType, content });

      return { success: true };
    } catch (error) {
      console.error('❌ Error adding note:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for conversation
   */
  async getNotes(conversationId) {
    try {
      const conv = await this.db.query(
        'SELECT id FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!conv.success || !conv.data || conv.data.length === 0) {
        return { success: false, error: 'Conversation not found' };
      }

      const result = await this.db.query(
        'SELECT * FROM live_chat_notes WHERE conversation_id = ? ORDER BY created_at DESC',
        [conv.data[0].id]
      );

      return result;
    } catch (error) {
      console.error('❌ Error getting notes:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update note
   */
  async updateNote(noteId, content) {
    try {
      await this.db.run(
        `UPDATE live_chat_notes
         SET content = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [content, noteId]
      );

      this.emit('note:updated', { noteId, content });

      return { success: true };
    } catch (error) {
      console.error('❌ Error updating note:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete note
   */
  async deleteNote(noteId) {
    try {
      await this.db.run(
        'DELETE FROM live_chat_notes WHERE id = ?',
        [noteId]
      );

      this.emit('note:deleted', { noteId });

      return { success: true };
    } catch (error) {
      console.error('❌ Error deleting note:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Log activity
   */
  async logActivity(conversationId, activityType, actor = null, details = {}) {
    try {
      const conv = await this.db.query(
        'SELECT id FROM live_chat_conversations WHERE conversation_id = ?',
        [conversationId]
      );

      if (!conv.success || !conv.data || conv.data.length === 0) {
        return { success: false, error: 'Conversation not found' };
      }

      const result = await this.db.run(
        `INSERT INTO live_chat_activity_log (conversation_id, activity_type, actor, details)
         VALUES (?, ?, ?, ?)`,
        [conv.data[0].id, activityType, actor, JSON.stringify(details)]
      );

      return result;
    } catch (error) {
      console.error('❌ Error logging activity:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search conversations
   */
  async searchConversations(sessionId, searchTerm) {
    try {
      const result = await this.db.query(
        `SELECT DISTINCT c.* FROM live_chat_conversations c
         LEFT JOIN live_chat_messages m ON c.id = m.conversation_id
         WHERE c.session_id = ? AND (
           c.contact_name LIKE ? OR
           c.contact_phone LIKE ? OR
           m.content LIKE ?
         )
         ORDER BY c.last_message_at DESC
         LIMIT 50`,
        [sessionId, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`]
      );

      return result;
    } catch (error) {
      console.error('❌ Error searching conversations:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get quick replies
   */
  async getQuickReplies() {
    try {
      const result = await this.db.query(
        'SELECT * FROM live_chat_quick_replies WHERE is_active = 1 ORDER BY usage_count DESC'
      );

      return result;
    } catch (error) {
      console.error('❌ Error getting quick replies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create quick reply
   */
  async createQuickReply(shortcut, title, content, category = 'general') {
    try {
      const result = await this.db.run(
        `INSERT INTO live_chat_quick_replies (shortcut, title, content, category)
         VALUES (?, ?, ?, ?)`,
        [shortcut, title, content, category]
      );

      return result;
    } catch (error) {
      console.error('❌ Error creating quick reply:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get conversation statistics
   */
  async getStatistics(sessionId) {
    try {
      const stats = await this.db.query(
        `SELECT
           COUNT(*) as total_conversations,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_conversations,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_conversations,
           SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_conversations,
           SUM(unread_count) as total_unread
         FROM live_chat_conversations
         WHERE session_id = ?`,
        [sessionId]
      );

      return stats;
    } catch (error) {
      console.error('❌ Error getting statistics:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = LiveChatService;
