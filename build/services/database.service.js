const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { app } = require('electron');

class DatabaseService {
  constructor(dbName = 'wapp.db') {
    // Use user data directory for database (writable location)
    // Better development detection - check if we're in development mode
    const isDev = process.env.NODE_ENV === 'development' ||
                  (!app.isPackaged && process.env.NODE_ENV !== 'production') ||
                  process.argv.includes('--dev') ||
                  __dirname.includes('src');

    if (isDev) {
      // Development: use local data directory
      this.dbPath = path.join(__dirname, '..', 'data', 'wapp.db');
      this.bundledDbPath = null;
    } else {
      // Production: ALWAYS use user data directory to prevent data loss
      // CRITICAL FIX: Never use bundled database if user database might exist
      const userDataPath = app.getPath('userData');
      this.dbPath = path.join(userDataPath, 'data', 'wapp.db');

      // Store bundled database path for initial copy only
      const resourcesPath = process.resourcesPath || path.join(process.cwd(), 'resources');
      this.bundledDbPath = path.join(resourcesPath, 'data', 'wapp.db');

      // Log paths for debugging
      if (global.logToFile) {
        global.logToFile(`📁 Database paths:`);
        global.logToFile(`   User DB: ${this.dbPath}`);
        global.logToFile(`   Bundled DB: ${this.bundledDbPath}`);
      }
    }

    this.db = null;
    this.SQL = null;
    this.isSaving = false;
    this.isInitialized = false;
    this.isShuttingDown = false;
    this.backupPath = null; // For automatic backups
    this.autoSaveInterval = null; // For periodic auto-save
    this.lastSaveTime = Date.now();
  }

  async initialize() {
    try {
      // Initialize sql.js
      this.SQL = await initSqlJs();

      // Ensure data directory exists
      const dataDir = path.dirname(this.dbPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Check if database exists and is valid
      const dbExists = await fs.access(this.dbPath).then(() => true).catch(() => false);

      let filebuffer = null;
      let isFirstTimeInstall = false;
      let isCorruptedDatabase = false;
      let hasUserData = false;

      if (dbExists) {
        try {
          // Load existing database
          filebuffer = await fs.readFile(this.dbPath);

          // Validate database file is not empty or corrupted
          if (filebuffer.length === 0) {
            if (global.logToFile) {
              global.logToFile('⚠️ Database file is empty (0 bytes)');
            }
            isCorruptedDatabase = true;
            filebuffer = null;
          } else {
            // CRITICAL FIX: Check if database has user data before marking as corrupted
            // This prevents accidental data wipe
            try {
              const tempDb = new (await initSqlJs()).Database(filebuffer);

              // Check if database has any user data (sessions, contacts, messages, etc.)
              const tables = ['whatsapp_sessions', 'contacts', 'message_history', 'bulk_campaigns'];
              for (const table of tables) {
                try {
                  const result = tempDb.exec(`SELECT COUNT(*) as count FROM ${table}`);
                  if (result.length > 0 && result[0].values[0][0] > 0) {
                    hasUserData = true;
                    if (global.logToFile) {
                      global.logToFile(`✅ Found user data in table: ${table}`);
                    }
                    break;
                  }
                } catch (e) {
                  // Table might not exist, continue checking
                }
              }

              tempDb.close();

              if (global.logToFile) {
                global.logToFile(`📊 Database has user data: ${hasUserData}`);
              }
            } catch (checkError) {
              if (global.logToFile) {
                global.logToFile(`⚠️ Could not check for user data: ${checkError.message}`);
              }
              // If we can't check, assume it might have data to be safe
              hasUserData = true;
            }
          }
        } catch (error) {
          if (global.logToFile) {
            global.logToFile(`❌ Error reading database: ${error.message}`);
          }
          isCorruptedDatabase = true;
          filebuffer = null;
        }
      } else {
        // Database doesn't exist - check if we should copy from bundled
        if (this.bundledDbPath) {
          try {
            const bundledExists = require('fs').existsSync(this.bundledDbPath);
            if (bundledExists) {
              if (global.logToFile) {
                global.logToFile('📦 Copying bundled database to user location');
              }
              await fs.copyFile(this.bundledDbPath, this.dbPath);
              filebuffer = await fs.readFile(this.dbPath);
              if (global.logToFile) {
                global.logToFile('✅ Bundled database copied successfully');
              }
            }
          } catch (copyError) {
            if (global.logToFile) {
              global.logToFile(`⚠️ Could not copy bundled database: ${copyError.message}`);
            }
          }
        }
        isFirstTimeInstall = true;
      }

      // CRITICAL FIX: Only treat as corrupted if we have no user data
      // If database has user data, try to recover it instead of wiping
      if (isCorruptedDatabase && hasUserData) {
        if (global.logToFile) {
          global.logToFile('⚠️ Database appears corrupted but has user data - attempting recovery');
        }
        // Try to create backup before any operations
        await this.createBackup();
        isCorruptedDatabase = false; // Don't wipe data
      }

      // Only remove corrupted database if it has NO user data
      if (isCorruptedDatabase && !hasUserData) {
        isFirstTimeInstall = true;
        if (global.logToFile) {
          global.logToFile('🗑️ Removing corrupted empty database');
        }
        try {
          await fs.unlink(this.dbPath);
        } catch (error) {
          // Ignore error if file doesn't exist
        }
      }

      // Create database connection
      this.db = new this.SQL.Database(filebuffer);

      // Enable foreign keys
      this.db.run('PRAGMA foreign_keys = ON');

      // Check foreign key status
      const fkStatus = this.db.prepare("PRAGMA foreign_keys");
      fkStatus.step();
      fkStatus.free();

      // Create all tables
      await this.createTables();

      // Insert default settings for new installations
      await this.insertDefaultSettings();

      // Add missing columns for compatibility
      await this.addMissingColumns();
      await this.runCallResponderMigrations();
      await this.addBulkMessageDelayColumns();
      await this.addBulkMessageUnverifiedContactsColumn();
      await this.runPollQuestionMigration();
      await this.runPollTrackingMigration();
      await this.runPollVotesEncryptedFallbackMigration();
      await this.runSupportBotColumnMigrations();
      await this.runLIDMappingsMigration();
      await this.runLiveChatStatusMigration();
      await this.fixBrokenConditionPaths();
      await this.migrateCallResponderDelayToSeconds();

      // CRITICAL FIX: Only clear data for TRUE first-time installations
      // Never clear data if database has user data
      if (isFirstTimeInstall && !hasUserData) {
        if (global.logToFile) {
          global.logToFile('🆕 First time installation - initializing fresh database');
        }
        await this.clearUserData();
        await this.clearAuthSessions();
      } else if (hasUserData) {
        if (global.logToFile) {
          global.logToFile('✅ Existing user data preserved');
        }
      }

      // Save database to file
      await this.saveDatabase();

      this.isInitialized = true;

      // Create automatic backup after successful initialization
      if (hasUserData) {
        await this.createBackup();
      }

      // CRITICAL FIX: Start periodic auto-save to prevent data loss from crashes
      this.startAutoSave();

      if (global.logToFile) {
        global.logToFile('✅ Database initialized successfully');
      }

      return { success: true };
    } catch (error) {
      console.error('❌ Database initialization error:', error);
      if (global.logToFile) {
        global.logToFile(`❌ Database initialization error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Start periodic auto-save to prevent data loss
   * CRITICAL: Saves database every 30 seconds to protect against crashes
   */
  startAutoSave() {
    // Clear any existing interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }

    // Auto-save every 30 seconds
    this.autoSaveInterval = setInterval(async () => {
      try {
        // Only save if database has been modified (check if last save was more than 30 seconds ago)
        const timeSinceLastSave = Date.now() - this.lastSaveTime;
        if (timeSinceLastSave >= 30000 && !this.isSaving && !this.isShuttingDown) {
          if (global.logToFile) {
            global.logToFile('💾 Auto-saving database...');
          }
          await this.saveDatabase();
          this.lastSaveTime = Date.now();
        }
      } catch (error) {
        if (global.logToFile) {
          global.logToFile(`⚠️ Auto-save failed: ${error.message}`);
        }
      }
    }, 30000); // Every 30 seconds

    if (global.logToFile) {
      global.logToFile('✅ Auto-save enabled (every 30 seconds)');
    }
  }

  /**
   * Stop auto-save interval
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
      if (global.logToFile) {
        global.logToFile('⏹️ Auto-save stopped');
      }
    }
  }

  async createTables() {
    const tables = [
      // WhatsApp Devices/Sessions
      `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        device_name TEXT, -- Friendly device name
        phone_number TEXT,
        profile_picture TEXT, -- Profile picture URL
        status TEXT DEFAULT 'disconnected', -- disconnected, connecting, connected, qr_ready
        qr_code TEXT,
        last_connected DATETIME,
        last_seen DATETIME, -- Last activity timestamp
        connected_at DATETIME, -- When session was connected
        disconnected_at DATETIME, -- When session was disconnected
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        session_data TEXT -- JSON string for storing session info
      )`,

      // Message Templates
      `CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE, -- Added UNIQUE constraint to prevent duplicates
        category TEXT DEFAULT 'general', -- welcome, marketing, support, etc.
        type TEXT DEFAULT 'text', -- text, image, document, contact, poll, buttons, list, location, video, audio, cta_button, copy_code, flow, mixed_buttons, carousel
        content TEXT NOT NULL,
        variables TEXT, -- JSON array of variable names
        attachments TEXT, -- JSON array of attachment paths/URLs
        buttons TEXT, -- JSON array of button configurations
        list_sections TEXT, -- JSON array of list sections for list templates

        poll_options TEXT, -- JSON array of poll options
        poll_question TEXT, -- Poll question text (separate from message content)
        contact_info TEXT, -- JSON object with contact information
        location_info TEXT, -- JSON object with location coordinates
        media_settings TEXT, -- JSON object with media-specific settings (caption, viewOnce, etc.)
        interactive_settings TEXT, -- JSON object with interactive message settings
        is_active BOOLEAN DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        cta_data TEXT, -- JSON object for CTA button configuration
        copy_data TEXT, -- JSON object for copy code button configuration
        flow_data TEXT, -- JSON object for flow message configuration
        mixed_buttons_data TEXT, -- JSON array for mixed interactive buttons configuration
        carousel_cards TEXT, -- JSON array for carousel cards configuration
        carousel_settings TEXT -- JSON object for carousel settings configuration
      )`,

      // Contacts
      `CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        email TEXT,
        company TEXT,
        position TEXT,
        notes TEXT,
        tags TEXT, -- JSON array of tags
        custom_fields TEXT, -- JSON object for custom fields
        var1 TEXT, -- Custom variable 1
        var2 TEXT, -- Custom variable 2
        var3 TEXT, -- Custom variable 3
        var4 TEXT, -- Custom variable 4
        var5 TEXT, -- Custom variable 5
        var6 TEXT, -- Custom variable 6
        var7 TEXT, -- Custom variable 7
        var8 TEXT, -- Custom variable 8
        var9 TEXT, -- Custom variable 9
        var10 TEXT, -- Custom variable 10
        whatsapp_verified BOOLEAN DEFAULT 0, -- Whether number is verified on WhatsApp
        verification_status TEXT DEFAULT 'pending', -- pending, verified, invalid
        verification_date DATETIME,
        is_active BOOLEAN DEFAULT 1,
        last_message_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Contact Groups
      `CREATE TABLE IF NOT EXISTS contact_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT DEFAULT '#3b82f6',
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Contact Group Members
      `CREATE TABLE IF NOT EXISTS contact_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        contact_id INTEGER NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE RESTRICT,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
        UNIQUE(group_id, contact_id)
      )`,

      // Bulk Message Campaigns
      `CREATE TABLE IF NOT EXISTS bulk_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        template_id INTEGER,
        session_ids TEXT NOT NULL, -- JSON array of session IDs for multi-device support
        message_content TEXT, -- Actual message content (from template or custom)
        message_type TEXT DEFAULT 'text', -- text, template, media, etc.
        contact_group_ids TEXT, -- JSON array of contact group IDs
        device_rotation BOOLEAN DEFAULT 1, -- Whether to rotate between devices
        attachment_data TEXT, -- JSON object with attachment file data and type
        status TEXT DEFAULT 'draft', -- draft, scheduled, pending, running, completed, paused, stopped, failed
        total_contacts INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        delivery_delay INTEGER DEFAULT 5, -- Legacy: seconds between messages (for backward compatibility)
        delivery_delay_min INTEGER DEFAULT 3, -- Minimum delay between messages in seconds
        delivery_delay_max INTEGER DEFAULT 9, -- Maximum delay between messages in seconds
        max_retries INTEGER DEFAULT 3, -- maximum retry attempts for failed messages
        scheduled_at DATETIME,
        started_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES message_templates(id) ON DELETE SET NULL
      )`,

      // Bulk Campaign Recipients
      `CREATE TABLE IF NOT EXISTS bulk_campaign_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        contact_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, sent, failed, delivered, retry
        sent_at DATETIME,
        delivered_at DATETIME,
        error_message TEXT,
        message_id TEXT, -- WhatsApp message ID
        retry_count INTEGER DEFAULT 0,
        session_id TEXT, -- Which session was used to send this message
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      )`,

      // Communication Preferences & Opt-out Management
      `CREATE TABLE IF NOT EXISTS communication_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL,
        contact_id INTEGER,
        opt_out_status TEXT DEFAULT 'opted_in' CHECK (opt_out_status IN ('opted_in', 'opted_out', 'pending_confirmation')),
        opt_out_date DATETIME,
        opt_out_method TEXT, -- 'keyword', 'manual', 'web_form', 'complaint'
        opt_out_campaign_id INTEGER, -- Which campaign triggered the opt-out
        opt_out_reason TEXT,
        marketing_consent BOOLEAN DEFAULT 1,
        transactional_consent BOOLEAN DEFAULT 1,
        promotional_consent BOOLEAN DEFAULT 1,
        reminder_consent BOOLEAN DEFAULT 1,
        last_consent_update DATETIME,
        consent_source TEXT, -- 'initial_signup', 'explicit_consent', 'implied_consent'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (opt_out_campaign_id) REFERENCES bulk_campaigns(id) ON DELETE SET NULL,
        UNIQUE(phone_number)
      )`,

      // Opt-out Keywords Management
      `CREATE TABLE IF NOT EXISTS opt_out_keywords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword TEXT NOT NULL UNIQUE,
        language TEXT DEFAULT 'en',
        is_active BOOLEAN DEFAULT 1,
        case_sensitive BOOLEAN DEFAULT 0,
        auto_response_template TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Opt-out Requests Log
      `CREATE TABLE IF NOT EXISTS opt_out_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL,
        contact_id INTEGER,
        session_id TEXT,
        request_method TEXT NOT NULL, -- 'keyword', 'manual', 'web_form', 'complaint'
        keyword_used TEXT,
        message_content TEXT,
        campaign_id INTEGER,
        processed BOOLEAN DEFAULT 0,
        processed_at DATETIME,
        confirmation_sent BOOLEAN DEFAULT 0,
        confirmation_sent_at DATETIME,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE SET NULL
      )`,

      // Compliance Audit Log
      `CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL,
        contact_id INTEGER,
        action_type TEXT NOT NULL, -- 'opt_in', 'opt_out', 'message_sent', 'message_blocked', 'preference_updated'
        action_details TEXT, -- JSON with additional details
        campaign_id INTEGER,
        session_id TEXT,
        user_id TEXT,
        ip_address TEXT,
        compliance_status TEXT DEFAULT 'compliant' CHECK (compliance_status IN ('compliant', 'violation', 'warning')),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE SET NULL
      )`,

      // Message History
      `CREATE TABLE IF NOT EXISTS message_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        contact_phone TEXT NOT NULL,
        message_id TEXT, -- WhatsApp message ID
        direction TEXT NOT NULL, -- incoming, outgoing
        message_type TEXT DEFAULT 'text', -- text, image, document, audio, video
        content TEXT,
        media_path TEXT,
        timestamp DATETIME NOT NULL,
        status TEXT, -- sent, delivered, read, failed
        campaign_id INTEGER, -- if sent via bulk campaign
        template_id INTEGER, -- if sent using template
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id),
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id),
        FOREIGN KEY (template_id) REFERENCES message_templates(id)
      )`,

      // Auto Reply Rules
      `CREATE TABLE IF NOT EXISTS auto_reply_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        response TEXT,
        template_id INTEGER,
        is_active BOOLEAN DEFAULT 1,
        priority INTEGER DEFAULT 1,
        cooldown_minutes INTEGER DEFAULT 0, -- cooldown period in minutes
        response_count INTEGER DEFAULT 0,
        last_used DATETIME,
        target_type TEXT DEFAULT 'all', -- 'all', 'individual', 'group'
        target_groups TEXT, -- JSON array of group IDs when target_type is 'group'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES message_templates(id)
      )`,

      // Chatbot Flows
      `CREATE TABLE IF NOT EXISTS chatbot_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        trigger_keywords TEXT NOT NULL, -- comma separated keywords
        keyword_match_type TEXT DEFAULT 'contains', -- exact, contains, starts_with, ends_with
        keyword_case_sensitive BOOLEAN DEFAULT 0, -- case sensitive matching
        is_active BOOLEAN DEFAULT 1,
        welcome_message TEXT,
        fallback_message TEXT,
        cooldown_minutes INTEGER DEFAULT 0, -- cooldown period in minutes
        message_delay_seconds INTEGER DEFAULT 0, -- delay in seconds before sending each message
        conversation_count INTEGER DEFAULT 0,
        last_triggered DATETIME,
        target_type TEXT DEFAULT 'all', -- 'all', 'individual', 'group'
        target_groups TEXT, -- JSON array of group IDs when target_type is 'group'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Chatbot Nodes
      `CREATE TABLE IF NOT EXISTS chatbot_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        node_type TEXT NOT NULL, -- message, question, action, condition
        options TEXT, -- JSON array of options for question nodes
        next_node_id INTEGER,
        position INTEGER DEFAULT 0,
        template_id INTEGER,
        attachment_data TEXT, -- JSON object with attachment file data and type
        attachment_type TEXT, -- image, video, audio, document
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES message_templates(id)
      )`,

      // Chatbot Conversations (for tracking user conversations)
      `CREATE TABLE IF NOT EXISTS chatbot_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        flow_id INTEGER NOT NULL,
        user_phone TEXT NOT NULL,
        current_node_id INTEGER,
        conversation_data TEXT, -- JSON data for storing user responses
        is_active BOOLEAN DEFAULT 1,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE
      )`,

      // Chatbot Saved Data (for Action nodes)
      `CREATE TABLE IF NOT EXISTS chatbot_saved_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        flow_id INTEGER NOT NULL,
        data TEXT NOT NULL, -- JSON object with saved data
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES chatbot_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE
      )`,

      // Auto Reply Cooldowns (for tracking cooldown periods)
      `CREATE TABLE IF NOT EXISTS auto_reply_cooldowns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        user_phone TEXT NOT NULL,
        last_reply_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rule_id) REFERENCES auto_reply_rules(id) ON DELETE CASCADE,
        UNIQUE(rule_id, user_phone)
      )`,

      // Chatbot Flow Cooldowns (for tracking per-user cooldown periods)
      `CREATE TABLE IF NOT EXISTS chatbot_flow_cooldowns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id INTEGER NOT NULL,
        user_phone TEXT NOT NULL,
        last_triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE,
        UNIQUE(flow_id, user_phone)
      )`,

      // Call Response Settings - Enhanced for advanced call responder
      `CREATE TABLE IF NOT EXISTS call_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, -- Changed to TEXT to match whatsapp_sessions.session_id
        name TEXT NOT NULL,
        call_types TEXT NOT NULL, -- JSON array: ['received', 'outgoing', 'missed', 'rejected']
        message_type TEXT DEFAULT 'text', -- 'text' or 'template'
        message_content TEXT, -- Custom message content
        template_id INTEGER, -- Template ID if using template
        attachment_file TEXT, -- File path for attachment
        attachment_type TEXT, -- 'image', 'video', 'audio', 'document'
        delay_minutes INTEGER DEFAULT 1, -- Delay in minutes after call ends
        is_active BOOLEAN DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES message_templates(id)
      )`,



      // Application Settings
      `CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT,
        type TEXT DEFAULT 'string', -- string, number, boolean, json
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Bulk Message Features Settings
      `CREATE TABLE IF NOT EXISTS bulk_message_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spintax_enabled BOOLEAN DEFAULT 1,
        random_enabled BOOLEAN DEFAULT 1,
        random_prefix TEXT DEFAULT 'REF',
        family_numbers_enabled BOOLEAN DEFAULT 1,
        family_numbers TEXT, -- JSON array of phone numbers
        family_message_interval INTEGER DEFAULT 50, -- Send to family numbers after every X messages
        hook_number_enabled BOOLEAN DEFAULT 1,
        hook_number TEXT, -- Single hook number for reply forwarding
        sleep_timing_enabled BOOLEAN DEFAULT 1,
        sleep_after_messages INTEGER DEFAULT 50, -- Pause after X messages
        sleep_duration_seconds INTEGER DEFAULT 30, -- Pause for X seconds
        delivery_delay_min INTEGER DEFAULT 3, -- Default minimum delay between messages
        delivery_delay_max INTEGER DEFAULT 9, -- Default maximum delay between messages
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Email Settings
      `CREATE TABLE IF NOT EXISTS email_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        provider TEXT NOT NULL, -- smtp, gmail, etc.
        smtp_config TEXT NOT NULL, -- JSON configuration for SMTP settings
        from_email TEXT NOT NULL,
        from_name TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 0,
        is_default BOOLEAN DEFAULT 0,
        enabled BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Email Templates
      `CREATE TABLE IF NOT EXISTS email_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'general', -- welcome, notification, marketing, support, etc.
        subject TEXT NOT NULL,
        html_content TEXT NOT NULL,
        text_content TEXT,
        variables TEXT, -- JSON array of available variables
        is_active BOOLEAN DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Warmer Campaigns
      `CREATE TABLE IF NOT EXISTS warmer_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        session_ids TEXT NOT NULL, -- JSON array of session IDs
        messages TEXT NOT NULL, -- JSON array of messages
        delay_min INTEGER DEFAULT 30, -- Minimum delay in seconds
        delay_max INTEGER DEFAULT 120, -- Maximum delay in seconds
        duration_minutes INTEGER DEFAULT 60, -- How long to run the campaign
        template_id INTEGER, -- Optional: reference to warmer_templates
        status TEXT DEFAULT 'stopped', -- running, stopped
        messages_sent INTEGER DEFAULT 0,
        started_at DATETIME,
        stopped_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES warmer_templates(id) ON DELETE SET NULL
      )`,

      // Warmer Templates
      `CREATE TABLE IF NOT EXISTS warmer_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        messages TEXT NOT NULL, -- JSON array of messages
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Warmer Logs
      `CREATE TABLE IF NOT EXISTS warmer_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        sender_session_id TEXT NOT NULL,
        receiver_session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'sent', -- sent, failed
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES warmer_campaigns(id) ON DELETE CASCADE
      )`,

      // Email Logs
      `CREATE TABLE IF NOT EXISTS email_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_email TEXT NOT NULL,
        cc_email TEXT,
        bcc_email TEXT,
        subject TEXT NOT NULL,
        message_id TEXT,
        status TEXT NOT NULL, -- sent, failed, pending
        error_message TEXT,
        template_id INTEGER,
        conversation_id INTEGER,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES email_templates(id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )`,

      // Spintax State Tracking
      `CREATE TABLE IF NOT EXISTS spintax_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        spintax_text TEXT NOT NULL,
        current_index INTEGER DEFAULT 0,
        total_variations INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE CASCADE
      )`,

      // Campaign Message Counts for Family Numbers and Sleep Timing
      `CREATE TABLE IF NOT EXISTS campaign_message_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL UNIQUE,
        message_count INTEGER DEFAULT 0,
        last_family_send_count INTEGER DEFAULT 0,
        last_sleep_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE CASCADE
      )`,

      // Proxy Settings
      `CREATE TABLE IF NOT EXISTS proxy_settings (
        id INTEGER PRIMARY KEY,
        api_key TEXT NOT NULL,
        balance REAL DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        last_sync DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Proxies
      `CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy6_id INTEGER UNIQUE,
        ip TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        type TEXT DEFAULT 'http',
        country TEXT NOT NULL,
        version INTEGER DEFAULT 6,
        date_purchased DATETIME,
        date_expires DATETIME,
        is_active BOOLEAN DEFAULT 1,
        description TEXT,
        auto_renew BOOLEAN DEFAULT 0,
        last_checked DATETIME,
        is_valid BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Campaign Proxy Assignments
      `CREATE TABLE IF NOT EXISTS campaign_proxy_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        proxy_id INTEGER NOT NULL,
        session_id TEXT,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
      )`,

      // Proxy Usage Logs
      `CREATE TABLE IF NOT EXISTS proxy_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_id INTEGER NOT NULL,
        campaign_id INTEGER,
        session_id TEXT,
        messages_sent INTEGER DEFAULT 0,
        used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE SET NULL
      )`,

      // Backup History
      `CREATE TABLE IF NOT EXISTS backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_id TEXT UNIQUE NOT NULL,
        timestamp DATETIME NOT NULL,
        description TEXT,
        file_path TEXT,
        google_drive_file_id TEXT,
        encrypted BOOLEAN DEFAULT 0,
        size INTEGER,
        includes TEXT, -- JSON object with backup includes
        status TEXT DEFAULT 'completed', -- completed, failed, in_progress
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Google Drive Configuration
      `CREATE TABLE IF NOT EXISTS google_drive_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id TEXT,
        folder_url TEXT,
        credentials TEXT, -- Encrypted JSON credentials
        auto_upload BOOLEAN DEFAULT 0,
        auto_backup_enabled BOOLEAN DEFAULT 0,
        auto_backup_schedule TEXT DEFAULT '0 2 * * *', -- Daily at 2 AM
        retention_days INTEGER DEFAULT 30,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Backup Schedules
      `CREATE TABLE IF NOT EXISTS backup_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        schedule_pattern TEXT NOT NULL, -- Cron pattern
        enabled BOOLEAN DEFAULT 1,
        include_database BOOLEAN DEFAULT 1,
        include_settings BOOLEAN DEFAULT 1,
        include_templates BOOLEAN DEFAULT 1,
        include_contacts BOOLEAN DEFAULT 1,
        include_attachments BOOLEAN DEFAULT 1,
        encrypt_backup BOOLEAN DEFAULT 1,
        upload_to_drive BOOLEAN DEFAULT 0,
        last_run DATETIME,
        next_run DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Activity Logs
      `CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        action TEXT, -- action for compatibility
        action_type TEXT NOT NULL, -- message_sent, contact_added, campaign_started, etc.
        description TEXT NOT NULL,
        metadata TEXT, -- JSON object with additional data
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, -- timestamp for compatibility
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )`,

      // Recall Bot Settings
      `CREATE TABLE IF NOT EXISTS recall_bot_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        is_enabled BOOLEAN DEFAULT 0,
        ai_provider TEXT DEFAULT 'openai', -- openai only
        ai_api_key TEXT,
        ai_model TEXT DEFAULT 'gpt-4o-mini',
        ai_temperature REAL DEFAULT 0.3,
        default_timezone TEXT DEFAULT 'UTC',
        voice_transcription_enabled BOOLEAN DEFAULT 1,
        transcription_provider TEXT DEFAULT 'whisper', -- whisper, google, azure
        transcription_api_key TEXT,
        max_reminder_duration_days INTEGER DEFAULT 365,
        reminder_confirmation_enabled BOOLEAN DEFAULT 1,
        auto_delete_completed BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id),
        UNIQUE(session_id)
      )`,

      // Reminders
      `CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_jid TEXT NOT NULL, -- WhatsApp JID of the user who created the reminder
        user_name TEXT, -- Display name of the user
        reminder_text TEXT NOT NULL,
        original_message TEXT NOT NULL, -- Original message from user
        scheduled_time DATETIME NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        recurrence_type TEXT, -- daily, weekly, monthly, yearly
        recurrence_interval INTEGER DEFAULT 1, -- every N days/weeks/months
        recurrence_end_date DATETIME,
        status TEXT DEFAULT 'active', -- active, completed, cancelled, failed
        reminder_sent BOOLEAN DEFAULT 0,
        reminder_sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT, -- JSON object with additional data (parsed AI response, etc.)
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )`,

      // Voice Transcriptions
      `CREATE TABLE IF NOT EXISTS voice_transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_jid TEXT NOT NULL,
        message_id TEXT NOT NULL, -- WhatsApp message ID
        audio_duration INTEGER, -- Duration in seconds
        transcription_text TEXT,
        transcription_confidence REAL,
        transcription_provider TEXT,
        processing_time_ms INTEGER,
        error_message TEXT,
        status TEXT DEFAULT 'pending', -- pending, completed, failed
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )`,

      // Recall Bot Activity Logs
      `CREATE TABLE IF NOT EXISTS recall_bot_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_jid TEXT,
        reminder_id INTEGER,
        action_type TEXT NOT NULL, -- reminder_created, reminder_sent, reminder_updated, reminder_cancelled, voice_transcribed, ai_processed
        message TEXT NOT NULL,
        metadata TEXT, -- JSON object with additional data
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id),
        FOREIGN KEY (reminder_id) REFERENCES reminders(id)
      )`,

      // Translation Keys - Master list of all translation keys in the application
      `CREATE TABLE IF NOT EXISTS translation_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_path TEXT UNIQUE NOT NULL, -- e.g., 'navigation.dashboard', 'dashboard.title'
        category TEXT NOT NULL, -- e.g., 'navigation', 'dashboard', 'common', 'messages'
        english_text TEXT NOT NULL, -- Default English text
        description TEXT, -- Description of where/how this key is used
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Translation Overrides - Custom translations per language
      `CREATE TABLE IF NOT EXISTS translation_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        language_code TEXT NOT NULL, -- e.g., 'es', 'fr', 'ar'
        custom_text TEXT NOT NULL, -- The translated text
        is_approved BOOLEAN DEFAULT 0, -- Whether this translation has been reviewed
        created_by TEXT, -- User who created this translation
        notes TEXT, -- Notes about the translation
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (key_id) REFERENCES translation_keys(id) ON DELETE CASCADE,
        UNIQUE(key_id, language_code)
      )`,

      // Translation Statistics - Track translation progress per language
      `CREATE TABLE IF NOT EXISTS translation_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        language_code TEXT UNIQUE NOT NULL,
        total_keys INTEGER DEFAULT 0,
        translated_keys INTEGER DEFAULT 0,
        approved_keys INTEGER DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Support Bot Settings
      `CREATE TABLE IF NOT EXISTS support_bot_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        trigger_field TEXT NOT NULL, -- Which field to use as trigger (e.g., 'customer_id')
        id_pattern TEXT DEFAULT '^[A-Za-z0-9]+$', -- Regex pattern for customer ID validation
        response_template TEXT NOT NULL, -- Message template with variables
        not_found_message TEXT DEFAULT 'Customer ID not found. Please check and try again.',
        not_found_template_id INTEGER, -- Reference to message_templates table for rich templates
        attachment_path TEXT, -- Path to image/document to send with response
        attachment_type TEXT DEFAULT 'image', -- image, video, document
        priority INTEGER DEFAULT 1, -- Processing priority (lower = higher priority)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Support Bot Customer Data (imported from Excel)
      `CREATE TABLE IF NOT EXISTS support_bot_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        customer_data TEXT NOT NULL, -- JSON object with all customer fields
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES support_bot_settings(session_id) ON DELETE CASCADE
      )`,

      // Support Bot Field Mappings (Excel column to system field mapping)
      `CREATE TABLE IF NOT EXISTS support_bot_field_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        excel_column TEXT NOT NULL, -- Original Excel column name
        field_name TEXT NOT NULL, -- Mapped field name (e.g., 'customer_id', 'name', 'address')
        field_type TEXT DEFAULT 'text', -- text, number, date, phone, email
        is_trigger BOOLEAN DEFAULT 0, -- Whether this field is the trigger field
        display_order INTEGER DEFAULT 0, -- Order in which to display in response
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES support_bot_settings(session_id) ON DELETE CASCADE
      )`,

      // Support Bot Lookup Logs
      `CREATE TABLE IF NOT EXISTS support_bot_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_phone TEXT NOT NULL,
        lookup_value TEXT NOT NULL, -- The customer ID or value that was searched
        success BOOLEAN DEFAULT 0,
        response_sent BOOLEAN DEFAULT 0,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES support_bot_settings(session_id) ON DELETE CASCADE
      )`
    ];

    for (const sql of tables) {
      this.db.run(sql);
    }

    // Handle template duplicates migration
    await this.handleTemplateDuplicatesMigration();

    // Clean up any existing duplicates immediately
    await this.cleanupTemplateDuplicates();

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_message_history_session_contact ON message_history(session_id, contact_phone)',
      'CREATE INDEX IF NOT EXISTS idx_message_history_timestamp ON message_history(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_bulk_recipients_campaign ON bulk_campaign_recipients(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_activity_logs_session ON activity_logs(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)',
      // Opt-out management indexes
      'CREATE INDEX IF NOT EXISTS idx_communication_preferences_phone ON communication_preferences(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_communication_preferences_status ON communication_preferences(opt_out_status)',
      'CREATE INDEX IF NOT EXISTS idx_communication_preferences_contact ON communication_preferences(contact_id)',
      'CREATE INDEX IF NOT EXISTS idx_opt_out_keywords_keyword ON opt_out_keywords(keyword)',
      'CREATE INDEX IF NOT EXISTS idx_opt_out_keywords_active ON opt_out_keywords(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_opt_out_requests_phone ON opt_out_requests(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_opt_out_requests_processed ON opt_out_requests(processed)',
      'CREATE INDEX IF NOT EXISTS idx_opt_out_requests_created ON opt_out_requests(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_compliance_audit_phone ON compliance_audit_log(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_compliance_audit_action ON compliance_audit_log(action_type)',
      'CREATE INDEX IF NOT EXISTS idx_compliance_audit_created ON compliance_audit_log(created_at)',
      // Translation indexes
      'CREATE INDEX IF NOT EXISTS idx_translation_keys_category ON translation_keys(category)',
      'CREATE INDEX IF NOT EXISTS idx_translation_keys_active ON translation_keys(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_translation_overrides_language ON translation_overrides(language_code)',
      'CREATE INDEX IF NOT EXISTS idx_translation_overrides_approved ON translation_overrides(is_approved)',
      'CREATE INDEX IF NOT EXISTS idx_translation_stats_language ON translation_stats(language_code)'
    ];

    for (const sql of indexes) {
      this.db.run(sql);
    }

    // Apply database migrations
    await this.applyMigrations();

    // Add new columns for interactive message types (if they don't exist)
    try {
      this.db.run(`ALTER TABLE message_templates ADD COLUMN cta_data TEXT`);
    } catch (error) {
      // Column already exists, ignore error
    }

    try {
      this.db.run(`ALTER TABLE message_templates ADD COLUMN copy_data TEXT`);
    } catch (error) {
      // Column already exists, ignore error
    }

    try {
      this.db.run(`ALTER TABLE message_templates ADD COLUMN flow_data TEXT`);
    } catch (error) {
      // Column already exists, ignore error
    }

    // Add attachment columns to support_bot_settings (if they don't exist)
    try {
      this.db.run(`ALTER TABLE support_bot_settings ADD COLUMN attachment_path TEXT`);
    } catch (error) {
      // Column already exists, ignore error
    }

    try {
      this.db.run(`ALTER TABLE support_bot_settings ADD COLUMN attachment_type TEXT DEFAULT 'image'`);
    } catch (error) {
      // Column already exists, ignore error
    }

    // Default settings are inserted in the main initialize() method

    // Run migrations for enhanced Auto Reply and Chatbot modules
    await this.runAutoReplyChatbotMigrations();

    // Run AI Chatbot module migrations
    await this.runAIChatbotMigrations();

    // Run Follow Up module migrations
    await this.runFollowUpMigrations();
    await this.runFollowUpTimezoneMigration();
  }

  /**
   * Run migrations for Auto Reply and Chatbot modules
   */
  async runAutoReplyChatbotMigrations() {
    try {

      // Force migration for auto_reply_rules to remove keywords

      try {
        const autoReplyColumns = this.db.exec("PRAGMA table_info(auto_reply_rules)")[0];
        if (autoReplyColumns) {
          const columnNames = autoReplyColumns.values.map(row => row[1]);

          // Check if we need to remove keywords column (new schema)
          if (columnNames.includes('keywords') || columnNames.includes('match_type')) {

            // Backup existing data
            let existingRules = [];
            try {
              const result = this.db.exec("SELECT * FROM auto_reply_rules");
              if (result.length > 0) {
                existingRules = result[0].values;
              }
            } catch (e) {
            }

            // Drop and recreate table with new schema
            this.db.run("DROP TABLE IF EXISTS auto_reply_rules_backup");
            this.db.run("DROP TABLE IF EXISTS auto_reply_rules");

            // Create new table
            this.db.run(`CREATE TABLE auto_reply_rules (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL,
              name TEXT NOT NULL,
              response TEXT,
              template_id INTEGER,
              is_active BOOLEAN DEFAULT 1,
              priority INTEGER DEFAULT 1,
              cooldown_minutes INTEGER DEFAULT 0,
              response_count INTEGER DEFAULT 0,
              last_used DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (template_id) REFERENCES message_templates(id)
            )`);

            // Migrate data if exists
            for (const row of existingRules) {
              try {
                this.db.run(`
                  INSERT INTO auto_reply_rules (
                    session_id, name, response, template_id,
                    is_active, priority, cooldown_minutes, response_count, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                  row[1] || 'default_session', // session_id
                  row[2] || 'Migrated Rule', // name
                  row[4] || row[6] || 'Hello!', // response
                  row[7] || null, // template_id
                  row[8] || 1, // is_active
                  row[10] || 1, // priority
                  0, // cooldown_minutes
                  row[9] || 0, // response_count
                  row[11] || new Date().toISOString(), // created_at
                  row[12] || new Date().toISOString() // updated_at
                ]);
              } catch (e) {
              }
            }

          } else {

            // Check for new target_type and target_groups columns
            if (!columnNames.includes('target_type')) {
              try {
                this.db.run("ALTER TABLE auto_reply_rules ADD COLUMN target_type TEXT DEFAULT 'all'");
              } catch (e) {
              }
            }

            if (!columnNames.includes('target_groups')) {
              try {
                this.db.run("ALTER TABLE auto_reply_rules ADD COLUMN target_groups TEXT");
              } catch (e) {
              }
            }
          }
        } else {
        }
      } catch (e) {

        // Create the table with new schema if it doesn't exist
        try {
          this.db.run(`CREATE TABLE IF NOT EXISTS auto_reply_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            response TEXT,
            template_id INTEGER,
            is_active BOOLEAN DEFAULT 1,
            priority INTEGER DEFAULT 1,
            cooldown_minutes INTEGER DEFAULT 0,
            response_count INTEGER DEFAULT 0,
            last_used DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (template_id) REFERENCES message_templates(id)
          )`);
        } catch (createError) {
          console.error('❌ Failed to create auto_reply_rules table:', createError.message);
        }
      }

      // Check if chatbot_flows table needs migration
      try {
        const chatbotFlowColumns = this.db.exec("PRAGMA table_info(chatbot_flows)")[0];
        if (chatbotFlowColumns) {
          const columnNames = chatbotFlowColumns.values.map(row => row[1]);

          // Check for any missing columns and add them
          let needsMigration = false;

          if (!columnNames.includes('trigger_keywords')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN trigger_keywords TEXT DEFAULT 'help'");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('conversation_count')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN conversation_count INTEGER DEFAULT 0");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('last_triggered')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN last_triggered DATETIME");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('keyword_match_type')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN keyword_match_type TEXT DEFAULT 'contains'");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('keyword_case_sensitive')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN keyword_case_sensitive BOOLEAN DEFAULT 0");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('cooldown_minutes')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN cooldown_minutes INTEGER DEFAULT 0");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('target_type')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN target_type TEXT DEFAULT 'all'");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (!columnNames.includes('target_groups')) {
            try {
              this.db.run("ALTER TABLE chatbot_flows ADD COLUMN target_groups TEXT");
              needsMigration = true;
            } catch (e) {
            }
          }

          if (needsMigration) {
          } else {
          }
        }
      } catch (e) {
      }

      // Check if chatbot_nodes table needs attachment columns
      try {
        const chatbotNodeColumns = this.db.exec("PRAGMA table_info(chatbot_nodes)")[0];
        if (chatbotNodeColumns) {
          const columnNames = chatbotNodeColumns.values.map(row => row[1]);

          // Only add missing attachment columns, don't recreate the table
          if (!columnNames.includes('attachment_data')) {
            try {
              this.db.run("ALTER TABLE chatbot_nodes ADD COLUMN attachment_data TEXT");
            } catch (e) {
            }
          }

          if (!columnNames.includes('attachment_type')) {
            try {
              this.db.run("ALTER TABLE chatbot_nodes ADD COLUMN attachment_type TEXT");
            } catch (e) {
            }
          }
        }
      } catch (e) {
      }

    } catch (error) {
      console.error('❌ Error running Auto Reply and Chatbot migrations:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Run AI Chatbot module migrations
   */
  async runAIChatbotMigrations() {
    try {

      // Check if AI Chatbot tables exist
      const tables = [
        'ai_providers',
        'ai_chatbots',
        'ai_conversations',
        'ai_messages',
        'ai_intents',
        'ai_knowledge_base',
        'ai_global_settings',
        'ai_documents',
        'ai_document_chunks'
      ];

      let needsInitialization = false;

      // Check specifically for ai_providers table (new table)
      try {
        const result = this.db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_providers'`);
        if (!result || result.length === 0) {
          needsInitialization = true;
        }
      } catch (error) {
        needsInitialization = true;
      }

      // If ai_providers doesn't exist, check other tables too
      if (!needsInitialization) {
        for (const table of tables) {
          try {
            const result = this.db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
            if (!result || result.length === 0) {
              needsInitialization = true;
              break;
            }
          } catch (error) {
            needsInitialization = true;
            break;
          }
        }
      }

      if (needsInitialization) {
        await this.createAIChatbotSchema();
      } else {
        // Run column migrations for existing tables
        await this.runAIChatbotColumnMigrations();
        // Run data migration to fix any model mismatches
        await this.fixAIProviderModelMismatches();
      }

    } catch (error) {
      console.error('❌ Error running AI Chatbot migrations:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Fix AI provider model mismatches
   */
  async fixAIProviderModelMismatches() {
    try {

      // Get all providers
      const providers = this.db.exec('SELECT * FROM ai_providers WHERE is_active = 1');

      if (!providers || providers.length === 0) {
        return;
      }

      const providerData = providers[0]?.values || [];
      const columns = providers[0]?.columns || [];

      let fixedCount = 0;

      for (const row of providerData) {
        const provider = {};
        columns.forEach((col, index) => {
          provider[col] = row[index];
        });

        const { id, type, model } = provider;
        let newModel = model;
        let needsUpdate = false;

        // Fix Gemini providers with OpenAI models
        if (type === 'gemini' && (model.startsWith('gpt-') || model === 'gpt-3.5-turbo')) {
          newModel = 'gemini-pro';
          needsUpdate = true;
        }
        // Fix OpenAI providers with Gemini models
        else if (type === 'openai' && model.startsWith('gemini-')) {
          newModel = 'gpt-3.5-turbo';
          needsUpdate = true;
        }

        if (needsUpdate) {
          this.db.run(`
            UPDATE ai_providers SET
              model = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [newModel, id]);
          fixedCount++;
        }
      }

      if (fixedCount > 0) {
      } else {
      }

    } catch (error) {
      console.error('❌ Error fixing AI provider model mismatches:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Run AI Chatbot column migrations for existing tables
   */
  async runAIChatbotColumnMigrations() {
    try {

      // Check if use_documents column exists in ai_chatbots table
      const tableInfo = this.db.exec(`PRAGMA table_info(ai_chatbots)`);
      const columnNames = [];

      if (tableInfo && tableInfo.length > 0) {
        const columns = tableInfo[0]?.values || [];
        columns.forEach(column => {
          columnNames.push(column[1]); // column[1] is the column name
        });
      }

      // Add use_documents column if it doesn't exist
      if (!columnNames.includes('use_documents')) {
        this.db.run('ALTER TABLE ai_chatbots ADD COLUMN use_documents BOOLEAN DEFAULT 0');
      } else {
      }

    } catch (error) {
      console.error('❌ Error running AI Chatbot column migrations:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Run Support Bot column migrations for existing tables
   */
  async runSupportBotColumnMigrations() {
    try {

      // Check if not_found_template_id column exists in support_bot_settings table
      const tableInfo = this.db.exec(`PRAGMA table_info(support_bot_settings)`);
      const columnNames = [];

      if (tableInfo && tableInfo.length > 0) {
        const columns = tableInfo[0]?.values || [];
        columns.forEach(column => {
          columnNames.push(column[1]); // column[1] is the column name
        });
      }

      // Add not_found_template_id column if it doesn't exist
      if (!columnNames.includes('not_found_template_id')) {
        this.db.run('ALTER TABLE support_bot_settings ADD COLUMN not_found_template_id INTEGER');
      } else {
      }

    } catch (error) {
      console.error('❌ Error running Support Bot column migrations:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Run Follow Up module migrations
   */
  async runFollowUpMigrations() {
    try {

      // Check if follow_up_messages table exists
      const tables = [
        'follow_up_messages',
        'follow_up_logs',
        'follow_up_statistics'
      ];

      let needsInitialization = false;

      // Check if follow_up_messages table exists
      try {
        const result = this.db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='follow_up_messages'`);
        if (!result || result.length === 0) {
          needsInitialization = true;
        }
      } catch (error) {
        needsInitialization = true;
      }

      if (needsInitialization) {
        await this.createFollowUpSchema();
      } else {
      }

    } catch (error) {
      console.error('❌ Error running Follow Up migrations:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Fix timezone issue in follow-up messages
   * Converts UTC timestamps (ending with Z) to local timestamps
   * Also fixes timestamps that were incorrectly migrated (time is way off)
   */
  async runFollowUpTimezoneMigration() {
    try {
      // Check if follow_up_messages table exists
      const tableCheck = await this.query(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='follow_up_messages'
      `);

      if (!tableCheck.success || !tableCheck.data || tableCheck.data.length === 0) {
        console.log('⏭️ Skipping follow-up timezone migration - table does not exist');
        return;
      }

      // Get all follow-ups with UTC timestamps (ending with Z)
      // OR timestamps that look suspiciously wrong (e.g., scheduled for early morning when user likely meant afternoon)
      const followUps = await this.query(`
        SELECT id, scheduled_at, name FROM follow_up_messages
        WHERE scheduled_at LIKE '%Z'
      `);

      if (!followUps.success || !followUps.data || followUps.data.length === 0) {
        console.log('✓ No follow-ups with UTC timestamps (ending with Z) found');

        // Also check for timestamps that might have been incorrectly migrated
        // These would be in the past or have unusual times
        const suspiciousFollowUps = await this.query(`
          SELECT id, scheduled_at, name FROM follow_up_messages
          WHERE status = 'scheduled'
          AND scheduled_at NOT LIKE '%Z'
          AND scheduled_at < datetime('now', '+1 hour')
        `);

        if (suspiciousFollowUps.success && suspiciousFollowUps.data && suspiciousFollowUps.data.length > 0) {
          console.log(`⚠️ Found ${suspiciousFollowUps.data.length} follow-up(s) with suspicious timestamps (in the past or very soon)`);
          console.log('   These might have been incorrectly migrated. Please check them manually.');
          suspiciousFollowUps.data.forEach(fu => {
            console.log(`   - ID ${fu.id}: ${fu.name} - ${fu.scheduled_at}`);
          });
        }

        return;
      }

      console.log(`🔄 Migrating ${followUps.data.length} follow-up(s) from UTC to local time...`);

      let migrated = 0;
      for (const followUp of followUps.data) {
        try {
          // Parse the UTC timestamp and convert to local time
          // For "2026-01-04T09:35:21.503Z" (UTC), JavaScript will convert to local time
          const utcDate = new Date(followUp.scheduled_at);

          if (isNaN(utcDate.getTime())) {
            console.error(`  ✗ Invalid timestamp for follow-up ${followUp.id}: ${followUp.scheduled_at}`);
            continue;
          }

          // Get local time components from the converted date
          const year = utcDate.getFullYear();
          const month = String(utcDate.getMonth() + 1).padStart(2, '0');
          const day = String(utcDate.getDate()).padStart(2, '0');
          const hours = String(utcDate.getHours()).padStart(2, '0');
          const minutes = String(utcDate.getMinutes()).padStart(2, '0');
          const seconds = String(utcDate.getSeconds()).padStart(2, '0');
          const ms = String(utcDate.getMilliseconds()).padStart(3, '0');

          // Create local timestamp without timezone suffix
          // This preserves the user's intended local time
          const localTimestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}`;

          // Update the record
          await this.query(
            'UPDATE follow_up_messages SET scheduled_at = ? WHERE id = ?',
            [localTimestamp, followUp.id]
          );

          migrated++;
          console.log(`  ✓ Migrated follow-up ${followUp.id}: ${followUp.scheduled_at} → ${localTimestamp}`);
        } catch (error) {
          console.error(`  ✗ Error migrating follow-up ${followUp.id}:`, error.message);
        }
      }

      console.log(`✓ Successfully migrated ${migrated}/${followUps.data.length} follow-up(s)`);

    } catch (error) {
      console.error('❌ Error running follow-up timezone migration:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Run LID mappings migration for WhatsApp LID resolution
   */
  async runLIDMappingsMigration() {
    try {

      // Check if table exists
      const tableExists = this.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='lid_mappings'
      `);

      const exists = tableExists.step();
      tableExists.free();

      if (!exists) {

        // Create table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS lid_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            lid TEXT NOT NULL,
            jid TEXT NOT NULL,
            contact_name TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id, lid)
          )
        `);

        // Create indexes
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_lid_mappings_session_lid ON lid_mappings(session_id, lid)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_lid_mappings_jid ON lid_mappings(jid)`);

      } else {
      }

    } catch (error) {
      console.error('❌ Error running LID mappings migration:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Fix Live Chat conversations with NULL status
   */
  async runLiveChatStatusMigration() {
    try {

      // Update all conversations with NULL or empty status to 'active'
      this.db.run(`
        UPDATE live_chat_conversations
        SET status = 'active'
        WHERE status IS NULL OR status = ''
      `);


    } catch (error) {
      console.error('❌ Error running Live Chat status migration:', error);
      // Don't throw error to prevent breaking the app
    }
  }

  /**
   * Create Follow Up database schema
   */
  async createFollowUpSchema() {
    try {
      // Read the migration file and execute it
      const fs = require('fs');
      const path = require('path');

      const migrationPath = path.join(__dirname, '..', 'database', 'migrations', 'follow_up_schema.sql');

      if (fs.existsSync(migrationPath)) {
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

        // Execute the entire SQL as one block using db.exec()
        // This handles multi-line statements properly

        try {
          this.db.exec(migrationSQL);
        } catch (error) {
          console.error('❌ Error executing migration SQL:', error.message);

          // Fallback: try to execute individual statements
          const statements = migrationSQL
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

          for (const statement of statements) {
            if (statement.trim()) {
              try {
                this.db.run(statement + ';');
              } catch (stmtError) {
                console.error('❌ Error executing statement:', statement.substring(0, 100) + '...');
                console.error('❌ Error details:', stmtError.message);
                // Continue with other statements
              }
            }
          }
        }

      } else {

        // Fallback: create basic schema if migration file is missing
        this.createBasicFollowUpSchema();
      }

    } catch (error) {
      console.error('❌ Error creating Follow Up schema:', error);
      // Fallback to basic schema
      this.createBasicFollowUpSchema();
    }
  }

  /**
   * Create basic Follow Up schema as fallback
   */
  createBasicFollowUpSchema() {
    try {

      // Main follow_up_messages table with ALL required columns
      this.db.run(`CREATE TABLE IF NOT EXISTS follow_up_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        session_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        contact_name TEXT,
        contact_display_name TEXT,
        message_content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        template_id INTEGER,
        template_name TEXT,
        template_type TEXT,
        attachment_file TEXT,
        attachment_type TEXT,
        attachment_data TEXT,
        scheduled_at DATETIME NOT NULL,
        sent_at DATETIME,
        status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'paused', 'skipped')),
        priority INTEGER DEFAULT 1 CHECK (priority BETWEEN 1 AND 4),
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '[]',
        variables TEXT DEFAULT '{}',
        is_recurring BOOLEAN DEFAULT 0,
        recurring_pattern TEXT,
        parent_follow_up_id INTEGER,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        last_attempt_at DATETIME,
        send_if_replied BOOLEAN DEFAULT 1,
        auto_reschedule BOOLEAN DEFAULT 0,
        notes TEXT,
        message_id TEXT,
        device_name TEXT,
        created_by TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES message_templates(id),
        FOREIGN KEY (parent_follow_up_id) REFERENCES follow_up_messages(id)
      )`);

      // Also create the other Follow Up tables
      this.db.run(`CREATE TABLE IF NOT EXISTS follow_up_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        follow_up_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        status_before TEXT,
        status_after TEXT,
        message TEXT,
        error_details TEXT,
        execution_time INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (follow_up_id) REFERENCES follow_up_messages(id) ON DELETE CASCADE
      )`);

      this.db.run(`CREATE TABLE IF NOT EXISTS follow_up_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        total_scheduled INTEGER DEFAULT 0,
        total_sent INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0,
        total_cancelled INTEGER DEFAULT 0,
        total_skipped INTEGER DEFAULT 0,
        avg_delivery_time REAL,
        success_rate REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date)
      )`);


    } catch (error) {
      console.error('❌ Error creating basic Follow Up schema:', error);
    }
  }

  /**
   * Create AI Chatbot database schema
   */
  async createAIChatbotSchema() {
    try {
      // AI Providers table - separate configuration for reusability
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('openai', 'gemini')),
        api_key TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL DEFAULT 0.7,
        max_tokens INTEGER DEFAULT 1000,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Main AI Chatbots table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_chatbots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        provider_id INTEGER NOT NULL,
        system_prompt TEXT,
        language TEXT DEFAULT 'en',
        is_active BOOLEAN DEFAULT 1,
        session_ids TEXT,
        trigger_keywords TEXT,
        stop_keywords TEXT,
        features TEXT,
        personality TEXT DEFAULT 'professional',
        industry TEXT DEFAULT 'general',
        response_delay INTEGER DEFAULT 1000,
        fallback_message TEXT,
        max_conversation_length INTEGER DEFAULT 50,
        enable_learning BOOLEAN DEFAULT 1,
        confidence_threshold REAL DEFAULT 0.7,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE RESTRICT
      )`);

      // AI Conversations table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        user_phone TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'escalated', 'timeout')),
        context TEXT,
        satisfaction_score REAL,
        resolved BOOLEAN DEFAULT 0,
        escalated_to_human BOOLEAN DEFAULT 0,
        response_time REAL,
        message_count INTEGER DEFAULT 0,
        language_detected TEXT,
        sentiment_score REAL,
        intent_detected TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      // AI Messages table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        message_type TEXT NOT NULL CHECK (message_type IN ('user', 'bot', 'system')),
        content TEXT NOT NULL,
        metadata TEXT,
        tokens_used INTEGER,
        processing_time REAL,
        confidence_score REAL,
        intent TEXT,
        sentiment TEXT,
        language TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
      )`);

      // Poll Messages table for tracking sent polls
      this.db.run(`CREATE TABLE IF NOT EXISTS poll_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE, -- WhatsApp message ID
        session_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL, -- Sender's WhatsApp JID
        recipient_jid TEXT NOT NULL, -- Recipient's WhatsApp JID (individual or group)
        poll_question TEXT NOT NULL,
        poll_options TEXT NOT NULL, -- JSON array of poll options
        selectable_count INTEGER DEFAULT 1,
        campaign_id INTEGER, -- Link to bulk campaign if sent via campaign
        template_id INTEGER, -- Link to template if sent via template
        sent_at DATETIME NOT NULL,
        expires_at DATETIME, -- When poll expires (if applicable)
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id),
        FOREIGN KEY (template_id) REFERENCES message_templates(id)
      )`);

      // Poll Options table for storing individual poll options
      this.db.run(`CREATE TABLE IF NOT EXISTS poll_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_message_id INTEGER NOT NULL,
        option_text TEXT NOT NULL,
        option_index INTEGER NOT NULL, -- Order of option in poll
        option_hash TEXT, -- SHA256 hash used by WhatsApp for voting
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE
      )`);

      // Poll Votes table for tracking individual votes
      this.db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_message_id INTEGER NOT NULL,
        poll_option_id INTEGER NOT NULL,
        voter_jid TEXT NOT NULL, -- Voter's WhatsApp JID
        voter_name TEXT, -- Voter's display name
        vote_message_id TEXT, -- WhatsApp message ID of the vote
        voted_at DATETIME NOT NULL,
        sender_timestamp_ms BIGINT, -- Original timestamp from WhatsApp
        server_timestamp_ms BIGINT, -- Server timestamp from WhatsApp
        is_valid BOOLEAN DEFAULT 1, -- Whether vote is valid (not retracted)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (poll_option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
        UNIQUE(poll_message_id, voter_jid, poll_option_id) -- Prevent duplicate votes for same option
      )`);

      // AI Intents table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        training_phrases TEXT NOT NULL,
        response_templates TEXT,
        action_type TEXT,
        action_data TEXT,
        confidence_threshold REAL DEFAULT 0.7,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      // AI Knowledge Base table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_knowledge_base (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        category TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        keywords TEXT,
        confidence_threshold REAL DEFAULT 0.8,
        usage_count INTEGER DEFAULT 0,
        last_used DATETIME,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      // Global AI Settings table
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_global_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Additional tables for advanced features
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_decision_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        trigger_keywords TEXT,
        flow_data TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        priority INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      this.db.run(`CREATE TABLE IF NOT EXISTS ai_form_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        fields TEXT NOT NULL,
        submit_message TEXT,
        validation_rules TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      this.db.run(`CREATE TABLE IF NOT EXISTS ai_form_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        form_template_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL,
        user_phone TEXT NOT NULL,
        submission_data TEXT NOT NULL,
        status TEXT DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (form_template_id) REFERENCES ai_form_templates(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
      )`);

      this.db.run(`CREATE TABLE IF NOT EXISTS ai_appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL,
        user_phone TEXT NOT NULL,
        appointment_type TEXT,
        appointment_date DATETIME,
        duration INTEGER,
        status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed')),
        notes TEXT,
        reminder_sent BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
      )`);

      this.db.run(`CREATE TABLE IF NOT EXISTS ai_learning_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        bot_response TEXT NOT NULL,
        user_feedback TEXT,
        correction TEXT,
        context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
      )`);

      // AI Documents table for knowledge base documents
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatbot_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'doc', 'docx', 'txt')),
        file_size INTEGER NOT NULL,
        file_path TEXT,
        extracted_text TEXT,
        processing_status TEXT DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
        processing_error TEXT,
        chunk_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
      )`);

      // AI Document Chunks table for better text retrieval
      this.db.run(`CREATE TABLE IF NOT EXISTS ai_document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES ai_documents(id) ON DELETE CASCADE
      )`);

      // Create indexes for performance
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_providers_type ON ai_providers(type)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_providers_is_active ON ai_providers(is_active)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_chatbots_provider_id ON ai_chatbots(provider_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_conversations_chatbot_id ON ai_conversations(chatbot_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_phone ON ai_conversations(user_phone)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_conversations_created_at ON ai_conversations(created_at)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_id ON ai_messages(conversation_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_messages_created_at ON ai_messages(created_at)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_knowledge_base_chatbot_id ON ai_knowledge_base(chatbot_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_intents_chatbot_id ON ai_intents(chatbot_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_appointments_chatbot_id ON ai_appointments(chatbot_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_appointments_date ON ai_appointments(appointment_date)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_documents_chatbot_id ON ai_documents(chatbot_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_documents_processing_status ON ai_documents(processing_status)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_document_id ON ai_document_chunks(document_id)`);

      // Poll-related indexes
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_session ON poll_messages(session_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_sender ON poll_messages(sender_jid)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_recipient ON poll_messages(recipient_jid)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_sent_at ON poll_messages(sent_at)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_active ON poll_messages(is_active)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_messages_campaign ON poll_messages(campaign_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_message_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_message_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_jid)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_votes_voted_at ON poll_votes(voted_at)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_poll_votes_valid ON poll_votes(is_valid)`);

      // Insert default global settings
      this.db.run(`INSERT OR IGNORE INTO ai_global_settings (key, value, description) VALUES
        ('global_config', '{"enableGlobalFallback": true, "enableAnalytics": true, "enableLearning": true}', 'Global AI configuration settings'),
        ('rate_limits', '{"maxConcurrentConversations": 100, "rateLimitPerUser": 10, "rateLimitWindow": 60}', 'Rate limiting configuration'),
        ('features', '{"enableSentimentAnalysis": true, "enableLanguageDetection": true, "enableProfanityFilter": true}', 'Global feature flags')`);

      // Add keyword columns to existing ai_chatbots table if they don't exist
      try {
        const tableInfo = this.db.prepare('PRAGMA table_info(ai_chatbots)').all();
        const columnNames = tableInfo.map(col => col.name);

        if (!columnNames.includes('trigger_keywords')) {
          this.db.run('ALTER TABLE ai_chatbots ADD COLUMN trigger_keywords TEXT');
        }

        if (!columnNames.includes('stop_keywords')) {
          this.db.run('ALTER TABLE ai_chatbots ADD COLUMN stop_keywords TEXT');
        }

        if (!columnNames.includes('use_documents')) {
          this.db.run('ALTER TABLE ai_chatbots ADD COLUMN use_documents BOOLEAN DEFAULT 0');
        }
      } catch (migrationError) {
      }

    } catch (error) {
      console.error('❌ Error creating AI Chatbot schema:', error);
      throw error;
    }
  }

  async insertDefaultSettings() {
    const defaultSettings = [
      { key: 'app_theme', value: 'light', type: 'string', description: 'Application theme' },
      { key: 'message_delay', value: '5', type: 'number', description: 'Default delay between bulk messages (seconds)' },
      { key: 'auto_reply_enabled', value: 'true', type: 'boolean', description: 'Enable auto reply globally' },
      { key: 'call_response_enabled', value: 'true', type: 'boolean', description: 'Enable call response globally' },
      { key: 'max_sessions', value: '10', type: 'number', description: 'Maximum WhatsApp sessions allowed' },
      { key: 'backup_enabled', value: 'true', type: 'boolean', description: 'Enable automatic database backups' },

      { key: 'backup_interval', value: '24', type: 'number', description: 'Backup interval in hours' },
      { key: 'backup_auto_upload', value: 'false', type: 'boolean', description: 'Auto upload backups to Google Drive' },
      { key: 'backup_encryption', value: 'true', type: 'boolean', description: 'Encrypt backups by default' },
      { key: 'backup_retention_days', value: '30', type: 'number', description: 'Number of days to keep backups' },
      { key: 'google_drive_folder_id', value: '', type: 'string', description: 'Google Drive folder ID for backups' },
      { key: 'google_drive_folder_url', value: '', type: 'string', description: 'Google Drive folder URL for backups' },
      { key: 'app_language', value: 'en', type: 'string', description: 'Application language' },
      { key: 'window_show_title_bar', value: 'true', type: 'boolean', description: 'Show window title bar and menu' }
    ];

    for (const setting of defaultSettings) {
      this.db.run(`
        INSERT OR IGNORE INTO app_settings (key, value, type, description)
        VALUES (?, ?, ?, ?)
      `, [setting.key, setting.value, setting.type, setting.description]);
    }

    // Insert default bulk message settings only if none exist
    const existingSettings = this.db.prepare('SELECT COUNT(*) as count FROM bulk_message_settings').get();
    if (existingSettings.count === 0) {
      this.db.run(`
        INSERT INTO bulk_message_settings (
          spintax_enabled, random_enabled, random_prefix, family_numbers_enabled,
          family_numbers, family_message_interval, hook_number_enabled, hook_number,
          sleep_timing_enabled, sleep_after_messages, sleep_duration_seconds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [1, 1, 'LW', 1, '[]', 50, 1, '', 1, 50, 30]);
    }

    // Insert default opt-out keywords
    await this.insertDefaultOptOutKeywords();
  }

  async insertDefaultOptOutKeywords() {
    // Clear existing keywords first
    this.db.run(`DELETE FROM opt_out_keywords`);

    const defaultKeywords = [
      { keyword: 'UNSUBSCRIBE', language: 'en', auto_response_template: 'You have been unsubscribed from our messages. Reply SUBSCRIBE to opt back in.' },
      { keyword: 'SUBSCRIBE', language: 'en', auto_response_template: 'You have been subscribed to our messages. Reply UNSUBSCRIBE to unsubscribe.' }
    ];

    for (const keyword of defaultKeywords) {
      this.db.run(`
        INSERT INTO opt_out_keywords (keyword, language, auto_response_template, case_sensitive)
        VALUES (?, ?, ?, 0)
      `, [keyword.keyword, keyword.language, keyword.auto_response_template]);
    }
  }

  // Save database to file
  async saveDatabase() {
    try {
      if (!this.db) {
        return;
      }

      if (this.isShuttingDown) {
        return;
      }

      // Prevent concurrent saves
      if (this.isSaving) {
        return;
      }

      this.isSaving = true;

      try {
        // Saving database
        const data = this.db.export();

        // Ensure directory exists before writing
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

        // Use timestamp to avoid conflicts with concurrent saves
        const timestamp = Date.now();
        const tempPath = `${this.dbPath}.tmp.${timestamp}`;

        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
          try {
            // Add small delay to avoid race conditions
            if (retryCount > 0) {
              await new Promise(resolve => setTimeout(resolve, 50 * retryCount));
            }

            await fs.writeFile(tempPath, data);

            // Verify temp file was written
            const stats = await fs.stat(tempPath);
            if (stats.size === 0) {
              throw new Error('Temp file is empty after write');
            }

            // Atomic rename
            await fs.rename(tempPath, this.dbPath);

            // Update last save time
            this.lastSaveTime = Date.now();

            // Success - break out of retry loop
            break;

          } catch (error) {
            retryCount++;

            // Clean up temp file if it exists
            try {
              await fs.unlink(tempPath);
            } catch (cleanupError) {
              // Ignore cleanup errors
            }

            if (retryCount >= maxRetries) {
              // Final attempt failed
              if (error.code === 'ENOENT') {
                console.error('❌ ENOENT error - temp file disappeared before rename');
                console.error('This might be caused by antivirus software or file system issues');
              }
              throw error;
            }

            // Log retry attempt
          }
        }

        // Database saved successfully
      } finally {
        this.isSaving = false;
      }

    } catch (error) {
      this.isSaving = false;
      console.error('❌ Error saving database:', error);
      console.error('Database path:', this.dbPath);
      console.error('Error details:', error.message);
      console.error('Error code:', error.code);

      // Don't throw error - just log it to prevent breaking the application
      // The database will remain in memory and can be saved later
    }
  }

  // Utility methods for database operations
  async run(sql, params = []) {
    try {
      // Check if database is initialized
      if (!this.db) {
        // Silently return error if database is not ready
        return { success: false, error: 'Database not initialized' };
      }

      // Convert undefined values to null and objects to strings for sql.js compatibility
      const cleanParams = params.map(param => {
        if (param === undefined) return null;
        if (param === null) return null;
        if (typeof param === 'object') {
          return JSON.stringify(param);
        }
        return param;
      });

      // Executing SQL query

      // Use prepared statement approach for better error handling
      let result, lastID = null, changes = 0;

      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        // For INSERT statements, use prepared statement
        const stmt = this.db.prepare(sql);
        try {
          stmt.run(cleanParams);
          changes = this.db.getRowsModified();

          // Get last inserted row ID
          if (changes > 0) {
            const lastIdStmt = this.db.prepare("SELECT last_insert_rowid() as lastID");
            if (lastIdStmt.step()) {
              lastID = lastIdStmt.getAsObject().lastID;
            }
            lastIdStmt.free();
          }
        } finally {
          stmt.free();
        }
      } else {
        // For other statements, use the regular run method
        result = this.db.run(sql, cleanParams);
        changes = this.db.getRowsModified();
      }

      // SQL executed successfully

      // Save database with error handling
      try {
        await this.saveDatabase();
      } catch (saveError) {
        // Continue execution even if save fails - log only in development
        if (process.env.NODE_ENV === 'development') {
          console.error('❌ Failed to save database after operation:', saveError.message);
        }
      }

      // Debug: Log if INSERT didn't work (development only)
      if (process.env.NODE_ENV === 'development' && sql.trim().toUpperCase().startsWith('INSERT') && changes === 0) {
        console.error('❌ INSERT failed - no rows affected');
        console.error('SQL:', sql);
        console.error('Params:', cleanParams);

        // Check foreign key violations
        try {
          const fkCheck = this.db.prepare("PRAGMA foreign_key_check");
          const violations = [];
          while (fkCheck.step()) {
            violations.push(fkCheck.getAsObject());
          }
          fkCheck.free();
          if (violations.length > 0) {
            console.error('Foreign key violations:', violations);
          } else {
          }

          // Check if message_templates table has any data
          const templateCheck = this.db.prepare("SELECT COUNT(*) as count FROM message_templates");
          if (templateCheck.step()) {
            const templateCount = templateCheck.getAsObject().count;
          }
          templateCheck.free();

          // Check table constraints and indexes
          const constraintCheck = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='bulk_campaigns'");
          while (constraintCheck.step()) {
          }
          constraintCheck.free();

          // Try a simple test with minimal data
          try {
            const minimalTest = this.db.run("INSERT INTO bulk_campaigns (name, session_ids) VALUES (?, ?)", ['MINIMAL_TEST', '[]']);
            const minimalChanges = this.db.getRowsModified();
            if (minimalChanges > 0) {
              // Clean up test record
              this.db.run("DELETE FROM bulk_campaigns WHERE name = 'MINIMAL_TEST'");
            }
          } catch (minimalError) {
            console.error('🔧 Minimal test error:', minimalError);
          }

        } catch (e) {
          console.error('Could not check foreign keys:', e);
        }
      }



      return {
        success: true,
        lastID: lastID,
        insertId: lastID, // For compatibility
        changes: changes,
        data: { lastID: lastID }
      };
    } catch (error) {
      // Only log errors in development mode or for critical errors (not "no such table")
      if (process.env.NODE_ENV === 'development' && !error.message.includes('no such table')) {
        console.error('Database query error:', error);
      }
      return { success: false, error: error.message };
    }
  }

  async get(sql, params = []) {
    try {
      // Check if database is initialized
      if (!this.db) {
        // Silently return null if database is not ready (during initialization)
        return null;
      }

      // Convert undefined values to null for sql.js compatibility
      const cleanParams = params.map(param => param === undefined ? null : param);
      const stmt = this.db.prepare(sql);
      const result = stmt.getAsObject(cleanParams);
      stmt.free();

      // Return the data directly if it exists, otherwise return null
      // Check if any value is not undefined (sql.js returns object with undefined values when no rows found)
      const hasData = Object.values(result).some(value => value !== undefined);
      return hasData ? result : null;
    } catch (error) {
      // Only log errors in development mode or for critical errors (not "no such table")
      if (process.env.NODE_ENV === 'development' && !error.message.includes('no such table')) {
        console.error('Database query error:', error);
      }
      return null;
    }
  }

  async all(sql, params = []) {
    try {
      // Check if database is initialized
      if (!this.db) {
        // Silently return empty result if database is not ready
        return { success: false, error: 'Database not initialized', data: [] };
      }

      // Convert undefined values to null for sql.js compatibility
      const cleanParams = params.map(param => param === undefined ? null : param);
      const stmt = this.db.prepare(sql);

      // Bind parameters if any are provided
      if (cleanParams.length > 0) {
        stmt.bind(cleanParams);
      }

      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return { success: true, data: Array.isArray(results) ? results : [] };
    } catch (error) {
      // Only log errors in development mode or for critical errors (not "no such table")
      if (process.env.NODE_ENV === 'development' && !error.message.includes('no such table')) {
        console.error('Database query error:', error);
      }
      return { success: false, error: error.message, data: [] };
    }
  }

  async query(sql, params = []) {
    try {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        const result = await this.all(sql, params);
        // Ensure data is always an array for SELECT queries
        if (result.success && !Array.isArray(result.data)) {
          result.data = [];
        }
        return result;
      } else {
        return await this.run(sql, params);
      }
    } catch (error) {
      // Only log errors in development mode or for critical errors (not "no such table")
      if (process.env.NODE_ENV === 'development' && !error.message.includes('no such table')) {
        console.error('Database query error:', error);
      }
      return {
        success: false,
        error: error.message,
        data: sql.trim().toUpperCase().startsWith('SELECT') ? [] : null
      };
    }
  }

  /**
   * Execute multiple queries in a transaction
   */
  async transaction(queries) {
    try {

      // Begin transaction
      await this.run('BEGIN TRANSACTION');

      const results = [];

      for (let i = 0; i < queries.length; i++) {
        const { sql, params = [] } = queries[i];

        const result = await this.query(sql, params);

        if (!result.success) {
          console.error(`❌ Query ${i + 1} failed:`, result.error);
          // Rollback on any failure
          await this.run('ROLLBACK');
          return {
            success: false,
            error: `Transaction failed at query ${i + 1}: ${result.error}`,
            failedQueryIndex: i
          };
        }

        results.push(result);
      }

      // Commit transaction
      await this.run('COMMIT');

      return {
        success: true,
        results: results
      };

    } catch (error) {
      console.error('❌ Transaction error:', error);
      try {
        await this.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('❌ Rollback failed:', rollbackError);
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  async close() {
    this.isShuttingDown = true;

    // Stop auto-save before closing
    this.stopAutoSave();

    if (this.db) {
      try {
        // Final save before closing
        await this.saveDatabase();
        this.db.close();
        if (global.logToFile) {
          global.logToFile('✅ Database closed successfully');
        }
      } catch (error) {
        console.error('Error closing database:', error);
        if (global.logToFile) {
          global.logToFile(`❌ Error closing database: ${error.message}`);
        }
      }
    }
  }

  /**
   * Create a backup of the current database
   * CRITICAL: This prevents data loss by maintaining backups
   */
  async createBackup() {
    try {
      if (!this.db || !this.dbPath) {
        return { success: false, error: 'Database not initialized' };
      }

      // Create backups directory
      const backupDir = path.join(path.dirname(this.dbPath), 'backups');
      await fs.mkdir(backupDir, { recursive: true });

      // Create timestamped backup filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      const backupFileName = `wapp_backup_${timestamp}.db`;
      this.backupPath = path.join(backupDir, backupFileName);

      // Export current database
      const data = this.db.export();
      await fs.writeFile(this.backupPath, data);

      // Keep only last 7 backups to save space
      try {
        const backupFiles = await fs.readdir(backupDir);
        const dbBackups = backupFiles
          .filter(f => f.startsWith('wapp_backup_') && f.endsWith('.db'))
          .sort()
          .reverse();

        // Delete old backups (keep only 7 most recent)
        for (let i = 7; i < dbBackups.length; i++) {
          await fs.unlink(path.join(backupDir, dbBackups[i]));
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      if (global.logToFile) {
        global.logToFile(`✅ Database backup created: ${backupFileName}`);
      }

      return { success: true, backupPath: this.backupPath };
    } catch (error) {
      if (global.logToFile) {
        global.logToFile(`❌ Backup creation failed: ${error.message}`);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Restore database from the most recent backup
   */
  async restoreFromBackup() {
    try {
      const backupDir = path.join(path.dirname(this.dbPath), 'backups');
      const backupFiles = await fs.readdir(backupDir);
      const dbBackups = backupFiles
        .filter(f => f.startsWith('wapp_backup_') && f.endsWith('.db'))
        .sort()
        .reverse();

      if (dbBackups.length === 0) {
        return { success: false, error: 'No backups found' };
      }

      const latestBackup = path.join(backupDir, dbBackups[0]);

      if (global.logToFile) {
        global.logToFile(`🔄 Restoring from backup: ${dbBackups[0]}`);
      }

      // Copy backup to main database location
      await fs.copyFile(latestBackup, this.dbPath);

      if (global.logToFile) {
        global.logToFile('✅ Database restored from backup');
      }

      return { success: true, restoredFrom: dbBackups[0] };
    } catch (error) {
      if (global.logToFile) {
        global.logToFile(`❌ Restore failed: ${error.message}`);
      }
      return { success: false, error: error.message };
    }
  }

  // Helper method to get database statistics
  async getStats() {
    const stats = {};

    const tables = [
      'whatsapp_sessions', 'message_templates', 'contacts', 'contact_groups',
      'bulk_campaigns', 'message_history', 'auto_reply_rules'
    ];

    for (const table of tables) {
      try {
        // For message_history, only count outgoing messages (sent from application)
        if (table === 'message_history') {
          const result = await this.query(`SELECT COUNT(*) as count FROM ${table} WHERE direction = 'outgoing'`);
          stats[table] = result.success && result.data && result.data.length > 0 ? result.data[0].count : 0;
        } else {
          const result = await this.query(`SELECT COUNT(*) as count FROM ${table}`);
          stats[table] = result.success && result.data && result.data.length > 0 ? result.data[0].count : 0;
        }
      } catch (error) {
        console.error(`Error getting stats for table ${table}:`, error);
        stats[table] = 0;
      }
    }

    return stats;
  }

  async addMissingColumns() {
    try {
      // Check and add missing columns to whatsapp_sessions table
      const sessionTableResult = await this.query("PRAGMA table_info(whatsapp_sessions)");
      const sessionTableInfo = sessionTableResult.success && Array.isArray(sessionTableResult.data) ? sessionTableResult.data : [];
      const sessionColumnNames = sessionTableInfo.map(col => col.name || col[1]); // Handle both object and array formats

      // Helper function to safely add column to whatsapp_sessions table
      const addSessionColumnSafely = async (columnName, columnType) => {
        if (sessionColumnNames.includes(columnName)) {
          return;
        }

        try {
          await this.query(`ALTER TABLE whatsapp_sessions ADD COLUMN ${columnName} ${columnType}`);
        } catch (error) {
          if (error.message && error.message.includes('duplicate column name')) {
          } else {
            console.error(`❌ Error adding ${columnName} column:`, error.message);
          }
        }
      };

      await addSessionColumnSafely('profile_picture', 'TEXT');
      await addSessionColumnSafely('last_seen', 'DATETIME');
      await addSessionColumnSafely('connected_at', 'DATETIME');
      await addSessionColumnSafely('disconnected_at', 'DATETIME');

      // Check and add missing columns to message_templates table
      const templateTableResult = await this.query("PRAGMA table_info(message_templates)");
      const templateTableInfo = templateTableResult.success && Array.isArray(templateTableResult.data) ? templateTableResult.data : [];
      const templateColumnNames = templateTableInfo.map(col => col.name || col[1]);

      // Helper function for template table columns
      const addTemplateColumnSafely = async (columnName, columnType) => {
        if (templateColumnNames.includes(columnName)) {
          return;
        }

        try {
          await this.query(`ALTER TABLE message_templates ADD COLUMN ${columnName} ${columnType}`);
        } catch (error) {
          if (error.message && error.message.includes('duplicate column name')) {
          } else {
            console.error(`❌ Error adding ${columnName} column:`, error.message);
          }
        }
      };

      await addTemplateColumnSafely('type', "TEXT DEFAULT 'text'");
      await addTemplateColumnSafely('buttons', 'TEXT');
      await addTemplateColumnSafely('list_sections', 'TEXT');


      await addTemplateColumnSafely('poll_options', 'TEXT');
      await addTemplateColumnSafely('contact_info', 'TEXT');
      await addTemplateColumnSafely('location_info', 'TEXT');
      await addTemplateColumnSafely('media_settings', 'TEXT');
      await addTemplateColumnSafely('interactive_settings', 'TEXT');

      await addTemplateColumnSafely('mixed_buttons_data', 'TEXT');
      await addTemplateColumnSafely('carousel_cards', 'TEXT');
      await addTemplateColumnSafely('carousel_settings', 'TEXT');

      // Check and add missing columns to contacts table
      const contactTableResult = await this.query("PRAGMA table_info(contacts)");
      const contactTableInfo = contactTableResult.success && Array.isArray(contactTableResult.data) ? contactTableResult.data : [];
      const contactColumnNames = contactTableInfo.map(col => col.name || col[1]);

      // Helper function for contact table columns
      const addContactColumnSafely = async (columnName, columnType) => {
        if (contactColumnNames.includes(columnName)) {
          return;
        }

        try {
          await this.query(`ALTER TABLE contacts ADD COLUMN ${columnName} ${columnType}`);
        } catch (error) {
          if (error.message && error.message.includes('duplicate column name')) {
          } else {
            console.error(`❌ Error adding ${columnName} column:`, error.message);
          }
        }
      };

      // Add custom variables Var1-Var10
      for (let i = 1; i <= 10; i++) {
        await addContactColumnSafely(`var${i}`, 'TEXT');
      }

      // Add WhatsApp verification columns
      await addContactColumnSafely('whatsapp_verified', 'BOOLEAN DEFAULT 0');
      await addContactColumnSafely('verification_status', "TEXT DEFAULT 'pending'");
      await addContactColumnSafely('verification_date', 'DATETIME');
      await addContactColumnSafely('company', 'TEXT');
      await addContactColumnSafely('position', 'TEXT');

      // Check and add missing columns to bulk_campaigns table for delay range feature
      const campaignTableResult = await this.query("PRAGMA table_info(bulk_campaigns)");
      const campaignTableInfo = campaignTableResult.success && Array.isArray(campaignTableResult.data) ? campaignTableResult.data : [];
      const campaignColumnNames = campaignTableInfo.map(col => col.name || col[1]);

      // Helper function for campaign table columns
      const addCampaignColumnSafely = async (columnName, columnType) => {
        if (campaignColumnNames.includes(columnName)) {
          return;
        }

        try {
          await this.query(`ALTER TABLE bulk_campaigns ADD COLUMN ${columnName} ${columnType}`);
        } catch (error) {
          if (error.message && error.message.includes('duplicate column name')) {
          } else {
            console.error(`❌ Error adding ${columnName} column:`, error.message);
          }
        }
      };

      await addCampaignColumnSafely('delivery_delay_min', 'INTEGER DEFAULT 3');

      await addCampaignColumnSafely('delivery_delay_max', 'INTEGER DEFAULT 9');

      // Check and fix bulk_campaigns table schema
      // Simple approach: check if session_ids column exists, if not, recreate table
      let needsMigration = false;

      try {
        // Try to select from session_ids column (new schema)
        await this.query("SELECT session_ids FROM bulk_campaigns LIMIT 1");
      } catch (error) {
        needsMigration = true;
      }

      if (needsMigration) {

        try {
          // First, drop the temporary table if it exists
          try {
            this.db.run("DROP TABLE IF EXISTS bulk_campaigns_new");
          } catch (e) {
            // Ignore error if table doesn't exist
          }

          // Create new table with correct schema (no session_id column)
          this.db.run(`
            CREATE TABLE bulk_campaigns_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              template_id INTEGER,
              session_ids TEXT NOT NULL DEFAULT '[]',
              message_content TEXT,
              message_type TEXT DEFAULT 'text',
              contact_group_ids TEXT,
              device_rotation BOOLEAN DEFAULT 1,
              status TEXT DEFAULT 'draft',
              total_contacts INTEGER DEFAULT 0,
              sent_count INTEGER DEFAULT 0,
              failed_count INTEGER DEFAULT 0,
              delivery_delay INTEGER DEFAULT 5,
              delivery_delay_min INTEGER DEFAULT 3,
              delivery_delay_max INTEGER DEFAULT 9,
              max_retries INTEGER DEFAULT 3,
              scheduled_at DATETIME,
              started_at DATETIME,
              completed_at DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (template_id) REFERENCES message_templates(id)
            )
          `);

          // Copy data to new table (only using session_ids column)
          this.db.run(`
            INSERT INTO bulk_campaigns_new (
              id, name, template_id, session_ids, message_content, message_type,
              contact_group_ids, device_rotation, status, total_contacts, sent_count,
              failed_count, delivery_delay, max_retries, scheduled_at, started_at,
              completed_at, created_at, updated_at
            )
            SELECT id, name, template_id,
                   CASE
                     WHEN session_ids IS NOT NULL AND session_ids != '' THEN session_ids
                     WHEN session_id IS NOT NULL AND session_id != '' THEN '[' || '"' || session_id || '"' || ']'
                     ELSE '[]'
                   END as session_ids,
                   message_content, message_type, contact_group_ids, device_rotation,
                   status, total_contacts, sent_count, failed_count, delivery_delay,
                   COALESCE(delivery_delay_min, 3) as delivery_delay_min,
                   COALESCE(delivery_delay_max, 9) as delivery_delay_max,
                   max_retries, scheduled_at, started_at, completed_at, created_at, updated_at
            FROM bulk_campaigns
          `);

          // Drop old table and rename new one
          this.db.run("DROP TABLE bulk_campaigns");
          this.db.run("ALTER TABLE bulk_campaigns_new RENAME TO bulk_campaigns");

        } catch (error) {
          console.error('❌ Error migrating bulk_campaigns table:', error);
        }
      }

      // Clean up orphaned foreign key references
      try {

        // Remove orphaned bulk_campaign_recipients
        this.db.run(`
          DELETE FROM bulk_campaign_recipients
          WHERE campaign_id NOT IN (SELECT id FROM bulk_campaigns)
        `);

        // Remove orphaned message_history records
        this.db.run(`
          DELETE FROM message_history
          WHERE campaign_id IS NOT NULL
          AND campaign_id NOT IN (SELECT id FROM bulk_campaigns)
        `);

      } catch (error) {
        console.error('❌ Error cleaning up orphaned references:', error);
      }

      // Force recreate bulk_campaigns table if it's corrupted
      try {

        // Check if the table has the correct foreign key constraint
        const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bulk_campaigns'");
        let tableSql = '';
        if (tableInfo.step()) {
          tableSql = tableInfo.getAsObject().sql;
        }
        tableInfo.free();


        // Check if the foreign key constraint has "ON DELETE SET NULL"
        const hasCorrectFK = tableSql.includes('ON DELETE SET NULL');

        // Try a simple INSERT test
        const testResult = this.db.run(`
          INSERT INTO bulk_campaigns (
            name, session_ids, message_content, message_type,
            contact_group_ids, device_rotation, status, total_contacts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, ['TEST_CAMPAIGN', '["test"]', 'test message', 'text', '[]', 1, 'draft', 0]);

        const changes = this.db.getRowsModified();

        // Test a real campaign INSERT to see if it works
        try {
          const realTestResult = this.db.run(`
            INSERT INTO bulk_campaigns (
              name, session_ids, message_content, message_type,
              contact_group_ids, device_rotation, status, total_contacts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, ['REAL_TEST_CAMPAIGN', '["test_session"]', 'Test message content', 'text', '[]', 1, 'draft', 0]);

          const realTestChanges = this.db.getRowsModified();

          if (realTestChanges > 0) {
            // Get the inserted ID
            const lastIdStmt = this.db.prepare("SELECT last_insert_rowid() as lastID");
            let testCampaignId = null;
            if (lastIdStmt.step()) {
              testCampaignId = lastIdStmt.getAsObject().lastID;
            }
            lastIdStmt.free();

            // Clean up test record
            this.db.run("DELETE FROM bulk_campaigns WHERE name = 'REAL_TEST_CAMPAIGN'");
          }
        } catch (realTestError) {
          console.error('🔧 Real test INSERT error:', realTestError);
        }

        if (changes === 0 || !hasCorrectFK) {

          // Backup existing data
          const existingData = await this.query('SELECT * FROM bulk_campaigns');

          // Drop and recreate table
          this.db.run('DROP TABLE IF EXISTS bulk_campaigns');
          this.db.run(`
            CREATE TABLE bulk_campaigns (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              template_id INTEGER,
              session_ids TEXT NOT NULL DEFAULT '[]',
              message_content TEXT,
              message_type TEXT DEFAULT 'text',
              contact_group_ids TEXT,
              device_rotation BOOLEAN DEFAULT 1,
              status TEXT DEFAULT 'draft',
              total_contacts INTEGER DEFAULT 0,
              sent_count INTEGER DEFAULT 0,
              failed_count INTEGER DEFAULT 0,
              delivery_delay INTEGER DEFAULT 5,
              delivery_delay_min INTEGER DEFAULT 3,
              delivery_delay_max INTEGER DEFAULT 9,
              max_retries INTEGER DEFAULT 3,
              scheduled_at DATETIME,
              started_at DATETIME,
              completed_at DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (template_id) REFERENCES message_templates(id) ON DELETE SET NULL
            )
          `);

          // Restore data if any
          if (existingData.success && existingData.data.length > 0) {
            for (const row of existingData.data) {
              this.db.run(`
                INSERT INTO bulk_campaigns (
                  id, name, template_id, session_ids, message_content, message_type,
                  contact_group_ids, device_rotation, status, total_contacts, sent_count,
                  failed_count, delivery_delay, max_retries, scheduled_at, started_at,
                  completed_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                row.id, row.name, row.template_id, row.session_ids, row.message_content,
                row.message_type, row.contact_group_ids, row.device_rotation,
                row.status, row.total_contacts, row.sent_count, row.failed_count,
                row.delivery_delay, row.max_retries, row.scheduled_at, row.started_at,
                row.completed_at, row.created_at, row.updated_at
              ]);
            }
          }

        } else {
          // Clean up test record
          this.db.run('DELETE FROM bulk_campaigns WHERE name = ?', ['TEST_CAMPAIGN']);
        }
      } catch (error) {
        console.error('❌ Error testing/recreating bulk_campaigns table:', error);
      }

      // Add attachment_data column to bulk_campaigns if it doesn't exist
      try {
        const stmt = this.db.prepare("PRAGMA table_info(bulk_campaigns)");
        const tableInfo = [];
        while (stmt.step()) {
          tableInfo.push(stmt.getAsObject());
        }
        stmt.free();
        const hasAttachmentData = tableInfo.some(column => column.name === 'attachment_data');
        const hasProxyIds = tableInfo.some(column => column.name === 'proxy_ids');

        if (!hasAttachmentData) {
          this.db.run('ALTER TABLE bulk_campaigns ADD COLUMN attachment_data TEXT');
        }

        if (!hasProxyIds) {
          this.db.run('ALTER TABLE bulk_campaigns ADD COLUMN proxy_ids TEXT');
        }
      } catch (error) {
        console.error('❌ Error adding columns to bulk_campaigns:', error);
      }

      // Add proxy_id column to bulk_campaign_recipients if it doesn't exist
      try {
        const stmt = this.db.prepare("PRAGMA table_info(bulk_campaign_recipients)");
        const tableInfo = [];
        while (stmt.step()) {
          tableInfo.push(stmt.getAsObject());
        }
        stmt.free();
        const hasProxyId = tableInfo.some(column => column.name === 'proxy_id');

        if (!hasProxyId) {
          this.db.run('ALTER TABLE bulk_campaign_recipients ADD COLUMN proxy_id INTEGER');
        }
      } catch (error) {
        console.error('❌ Error adding proxy_id column to bulk_campaign_recipients:', error);
      }

    } catch (error) {
      console.error('Error adding missing columns:', error);
    }
  }

  /**
   * Run Call Responder migrations to update schema
   */
  async runCallResponderMigrations() {
    try {

      // Check if call_responses table exists and has old schema
      const stmt = this.db.prepare("PRAGMA table_info(call_responses)");
      const tableInfo = [];
      while (stmt.step()) {
        tableInfo.push(stmt.getAsObject());
      }
      stmt.free();

      const hasOldSchema = tableInfo.some(col => col.name === 'trigger_type' || col.name === 'response_delay');

      if (hasOldSchema) {

        // Backup existing data
        const dataStmt = this.db.prepare("SELECT * FROM call_responses");
        const existingData = [];
        while (dataStmt.step()) {
          existingData.push(dataStmt.getAsObject());
        }
        dataStmt.free();

        // Drop old table
        this.db.run("DROP TABLE IF EXISTS call_responses");

        // Create new table with updated schema
        this.db.run(`CREATE TABLE call_responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          call_types TEXT NOT NULL,
          message_type TEXT DEFAULT 'text',
          message_content TEXT,
          template_id INTEGER,
          attachment_file TEXT,
          attachment_type TEXT,
          delay_minutes INTEGER DEFAULT 1,
          is_active BOOLEAN DEFAULT 1,
          usage_count INTEGER DEFAULT 0,
          last_used DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (template_id) REFERENCES message_templates(id)
        )`);

        // Migrate existing data to new schema
        for (const row of existingData) {
          const callTypes = row.trigger_type ? [row.trigger_type] : ['missed', 'rejected'];
          const delayMinutes = row.response_delay ? Math.ceil(row.response_delay / 60) : 1;

          this.db.run(`INSERT INTO call_responses (
            id, session_id, name, call_types, message_type, message_content,
            template_id, delay_minutes, is_active, usage_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            row.id,
            row.session_id,
            row.name,
            JSON.stringify(callTypes),
            row.response_type || 'text',
            row.response_content,
            row.template_id,
            delayMinutes,
            row.is_active,
            row.usage_count || 0,
            row.created_at,
            row.updated_at
          ]);
        }

      } else {
      }
    } catch (error) {
      console.error('❌ Error running Call Responder migrations:', error);
    }
  }

  async addChatbotAttachmentColumns() {
    try {
      // Check if chatbot_nodes table exists
      const tableExistsResult = this.db.exec(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='chatbot_nodes'
      `);

      if (!tableExistsResult || tableExistsResult.length === 0 || tableExistsResult[0].values.length === 0) {
        return;
      }

      // Get current table schema
      const columnsResult = this.db.exec("PRAGMA table_info(chatbot_nodes)");
      const columnNames = columnsResult && columnsResult.length > 0 && columnsResult[0].values
        ? columnsResult[0].values.map(row => row[1]) // column name is at index 1
        : [];

      // Add missing attachment columns
      if (!columnNames.includes('attachment_data')) {
        this.db.run("ALTER TABLE chatbot_nodes ADD COLUMN attachment_data TEXT");
      } else {
      }

      if (!columnNames.includes('attachment_type')) {
        this.db.run("ALTER TABLE chatbot_nodes ADD COLUMN attachment_type TEXT");
      } else {
      }

    } catch (error) {
      console.error('❌ Error adding chatbot attachment columns:', error);
      throw error;
    }
  }

  async addBulkMessageDelayColumns() {
    try {
      // Check if bulk_message_settings table exists
      const tableExistsResult = this.db.exec(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='bulk_message_settings'
      `);

      if (!tableExistsResult || tableExistsResult.length === 0 || tableExistsResult[0].values.length === 0) {
        return;
      }

      // Get current table schema
      const columnsResult = this.db.exec("PRAGMA table_info(bulk_message_settings)");
      const columnNames = columnsResult && columnsResult.length > 0 && columnsResult[0].values
        ? columnsResult[0].values.map(row => row[1]) // column name is at index 1
        : [];

      // Add missing delay columns
      if (!columnNames.includes('delivery_delay_min')) {
        this.db.run("ALTER TABLE bulk_message_settings ADD COLUMN delivery_delay_min INTEGER DEFAULT 3");
      } else {
      }

      if (!columnNames.includes('delivery_delay_max')) {
        this.db.run("ALTER TABLE bulk_message_settings ADD COLUMN delivery_delay_max INTEGER DEFAULT 9");
      } else {
      }

    } catch (error) {
      console.error('❌ Error adding bulk message delay columns:', error);
      throw error;
    }
  }

  async addBulkMessageUnverifiedContactsColumn() {
    try {
      // Check if bulk_message_settings table exists
      const tableExistsResult = this.db.exec(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='bulk_message_settings'
      `);

      if (!tableExistsResult || tableExistsResult.length === 0 || tableExistsResult[0].values.length === 0) {
        return;
      }

      // Get current table schema
      const columnsResult = this.db.exec("PRAGMA table_info(bulk_message_settings)");
      const columnNames = columnsResult && columnsResult.length > 0 && columnsResult[0].values
        ? columnsResult[0].values.map(row => row[1]) // column name is at index 1
        : [];

      // Add missing allow_unverified_contacts column
      if (!columnNames.includes('allow_unverified_contacts')) {
        this.db.run("ALTER TABLE bulk_message_settings ADD COLUMN allow_unverified_contacts BOOLEAN DEFAULT 0");
      } else {
      }

    } catch (error) {
      console.error('❌ Error adding bulk message unverified contacts column:', error);
      throw error;
    }
  }

  // Data Maintenance Methods
  async getDataMaintenanceStats(dataTypes, cutoffDate) {
    try {
      const stats = {};

      for (const dataType of dataTypes) {
        let query;
        let params;

        if (dataType.customCondition) {
          query = `SELECT COUNT(*) as count FROM ${dataType.table} WHERE ${dataType.customCondition}`;
          params = [cutoffDate];
        } else {
          query = `SELECT COUNT(*) as count FROM ${dataType.table} WHERE ${dataType.dateColumn} < ?`;
          params = [cutoffDate];
        }

        const result = await this.query(query, params);
        stats[dataType.id] = result.success && result.data && result.data.length > 0 ? result.data[0].count : 0;
      }

      return { success: true, data: stats };
    } catch (error) {
      console.error('❌ Error getting data maintenance stats:', error);
      return { success: false, error: error.message, data: {} };
    }
  }

  async deleteOldData(dataType, cutoffDate) {
    try {
      let query;
      let params;

      if (dataType.customCondition) {
        query = `DELETE FROM ${dataType.table} WHERE ${dataType.customCondition}`;
        params = [cutoffDate];
      } else {
        query = `DELETE FROM ${dataType.table} WHERE ${dataType.dateColumn} < ?`;
        params = [cutoffDate];
      }

      const result = await this.run(query, params);

      if (result.success) {
        return { success: true, deletedCount: result.changes || 0 };
      } else {
        return { success: false, error: result.error };
      }
    } catch (error) {
      console.error(`❌ Error deleting old data from ${dataType.table}:`, error);
      return { success: false, error: error.message };
    }
  }

  async getTableSizes() {
    try {
      const tables = [
        'activity_logs',
        'auto_reply_cooldowns',
        'chatbot_conversations',
        'contacts',
        'message_templates',
        'whatsapp_sessions',
        'bulk_campaigns',
        'message_history'
      ];

      const sizes = {};

      for (const table of tables) {
        try {
          const result = await this.query(`SELECT COUNT(*) as count FROM ${table}`);
          sizes[table] = result.success && result.data && result.data.length > 0 ? result.data[0].count : 0;
        } catch (error) {
          console.error(`Error getting size for table ${table}:`, error);
          sizes[table] = 0;
        }
      }

      return { success: true, data: sizes };
    } catch (error) {
      console.error('❌ Error getting table sizes:', error);
      return { success: false, error: error.message, data: {} };
    }
  }

  /**
   * Clear user data for fresh installations
   */
  async clearUserData() {
    try {
      // Get list of existing tables first
      const tablesResult = await this.query("SELECT name FROM sqlite_master WHERE type='table'");
      const existingTables = tablesResult.data.map(row => row.name);

      // Clear user-generated data but keep system tables
      const tablesToClear = [
        'contacts',
        'message_templates',
        'whatsapp_sessions',
        'auto_reply_rules',
        'chatbot_flows',
        'chatbot_nodes',
        'bulk_campaigns',
        'bulk_campaign_recipients',
        'message_history',
        'auto_reply_cooldowns',
        'call_responses'
      ];

      for (const tableName of tablesToClear) {
        if (existingTables.includes(tableName)) {
          try {
            await this.run(`DELETE FROM ${tableName} WHERE 1=1`);
          } catch (error) {
          }
        } else {
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear WhatsApp auth sessions for fresh installations
   */
  async clearAuthSessions() {
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs').promises;

      const authDir = path.join(os.homedir(), 'ChatPro', 'auth');

      try {
        // Remove entire auth directory
        await fs.rm(authDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore if directory doesn't exist
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async optimizeDatabase() {
    try {

      // Run VACUUM to reclaim space and optimize
      await this.run('VACUUM');

      // Analyze tables for better query planning
      await this.run('ANALYZE');

      return { success: true, message: 'Database optimization completed successfully' };
    } catch (error) {
      console.error('❌ Error optimizing database:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle template duplicates migration
   * Remove duplicate templates and ensure unique names
   */
  async handleTemplateDuplicatesMigration() {
    try {

      // Find duplicate template names
      const duplicates = await this.query(`
        SELECT name, COUNT(*) as count
        FROM message_templates
        GROUP BY name
        HAVING COUNT(*) > 1
      `);

      if (duplicates.success && duplicates.data && duplicates.data.length > 0) {

        for (const duplicate of duplicates.data) {
          // Get all templates with this name, ordered by creation date
          const templatesWithSameName = await this.query(`
            SELECT * FROM message_templates
            WHERE name = ?
            ORDER BY created_at ASC
          `, [duplicate.name]);

          if (templatesWithSameName.success && templatesWithSameName.data.length > 1) {
            // Keep the first one, rename the others
            const templates = templatesWithSameName.data;

            for (let i = 1; i < templates.length; i++) {
              const template = templates[i];
              const newName = `${duplicate.name} (${i})`;

              // Update the duplicate template with a new name
              await this.query(`
                UPDATE message_templates
                SET name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `, [newName, template.id]);

            }
          }
        }

      } else {
      }
    } catch (error) {
      console.error('❌ Error handling template duplicates migration:', error);
    }
  }

  /**
   * Clean up template duplicates immediately
   * This is a more aggressive cleanup that deletes duplicates
   */
  async cleanupTemplateDuplicates() {
    try {

      // Find and delete duplicates, keeping only the one with the smallest ID (oldest)
      const deleteResult = await this.query(`
        DELETE FROM message_templates
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM message_templates
          GROUP BY name
        )
      `);

      if (deleteResult.success) {
      } else {
      }
    } catch (error) {
      console.error('❌ Error cleaning template duplicates:', error);
    }
  }

  /**
   * Run poll question migration to add poll_question field
   */
  async runPollQuestionMigration() {
    try {

      // Check if poll_question column exists using sql.js API
      const tableInfoResult = await this.query("PRAGMA table_info(message_templates)");
      if (!tableInfoResult.success) {
        console.error('❌ Error checking table info:', tableInfoResult.error);
        return;
      }

      const tableData = Array.isArray(tableInfoResult.data) ? tableInfoResult.data :
                       (tableInfoResult.data && Array.isArray(tableInfoResult.data.values) ? tableInfoResult.data.values : []);
      const columnNames = tableData.map(col => col.name || col[1]); // col[1] is name in PRAGMA result

      // Check if poll_question column already exists
      if (columnNames.includes('poll_question')) {
        return;
      }


      // Add the new column
      const addColumnResult = await this.query('ALTER TABLE message_templates ADD COLUMN poll_question TEXT');
      if (!addColumnResult.success) {
        console.error('❌ Error adding column:', addColumnResult.error);
        return;
      }

      // Migrate existing poll templates to use poll_question field
      const updateResult = await this.query(`
        UPDATE message_templates
        SET poll_question = content
        WHERE type = 'poll' AND poll_question IS NULL
      `);

      if (updateResult.success) {
      } else {
        console.error('❌ Error migrating data:', updateResult.error);
      }
    } catch (error) {
      console.error('❌ Error running poll question migration:', error);
    }
  }

  /**
   * Run poll tracking migration to add poll tables
   */
  async runPollTrackingMigration() {
    try {

      // Check if poll_messages table exists
      const tableInfoResult = await this.query("SELECT name FROM sqlite_master WHERE type='table' AND name='poll_messages'");
      if (!tableInfoResult.success) {
        console.error('❌ Error checking poll_messages table:', tableInfoResult.error);
        return;
      }

      const tableData = Array.isArray(tableInfoResult.data) ? tableInfoResult.data :
                       (tableInfoResult.data && Array.isArray(tableInfoResult.data.values) ? tableInfoResult.data.values : []);

      // Check if poll_messages table already exists
      if (tableData.length > 0) {
        return;
      }


      // Create poll_messages table
      const createPollMessagesResult = await this.query(`
        CREATE TABLE IF NOT EXISTS poll_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          sender_jid TEXT NOT NULL,
          recipient_jid TEXT NOT NULL,
          poll_question TEXT NOT NULL,
          poll_options TEXT NOT NULL,
          selectable_count INTEGER DEFAULT 1,
          campaign_id INTEGER,
          template_id INTEGER,
          sent_at DATETIME NOT NULL,
          expires_at DATETIME,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id),
          FOREIGN KEY (template_id) REFERENCES message_templates(id)
        )
      `);

      if (!createPollMessagesResult.success) {
        console.error('❌ Error creating poll_messages table:', createPollMessagesResult.error);
        return;
      }

      // Create poll_options table
      const createPollOptionsResult = await this.query(`
        CREATE TABLE IF NOT EXISTS poll_options (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_message_id INTEGER NOT NULL,
          option_text TEXT NOT NULL,
          option_index INTEGER NOT NULL,
          option_hash TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE
        )
      `);

      if (!createPollOptionsResult.success) {
        console.error('❌ Error creating poll_options table:', createPollOptionsResult.error);
        return;
      }

      // Create poll_votes table
      const createPollVotesResult = await this.query(`
        CREATE TABLE IF NOT EXISTS poll_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_message_id INTEGER NOT NULL,
          poll_option_id INTEGER NOT NULL,
          voter_jid TEXT NOT NULL,
          voter_name TEXT,
          vote_message_id TEXT,
          voted_at DATETIME NOT NULL,
          sender_timestamp_ms BIGINT,
          server_timestamp_ms BIGINT,
          is_valid BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE,
          FOREIGN KEY (poll_option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
          UNIQUE(poll_message_id, voter_jid, poll_option_id)
        )
      `);

      if (!createPollVotesResult.success) {
        console.error('❌ Error creating poll_votes table:', createPollVotesResult.error);
        return;
      }

      // Create indexes
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_session ON poll_messages(session_id)',
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_sender ON poll_messages(sender_jid)',
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_recipient ON poll_messages(recipient_jid)',
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_sent_at ON poll_messages(sent_at)',
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_active ON poll_messages(is_active)',
        'CREATE INDEX IF NOT EXISTS idx_poll_messages_campaign ON poll_messages(campaign_id)',
        'CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_message_id)',
        'CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_message_id)',
        'CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_jid)',
        'CREATE INDEX IF NOT EXISTS idx_poll_votes_voted_at ON poll_votes(voted_at)',
        'CREATE INDEX IF NOT EXISTS idx_poll_votes_valid ON poll_votes(is_valid)'
      ];

      for (const indexSql of indexes) {
        const indexResult = await this.query(indexSql);
        if (!indexResult.success) {
          console.error('❌ Error creating index:', indexResult.error);
        }
      }

    } catch (error) {
      console.error('❌ Error running poll tracking migration:', error);
    }
  }

  /**
   * Apply database migrations to fix contact deletion issues
   */
  async applyMigrations() {
    try {

      // Check if contact_group_members table needs migration
      const tableInfoResult = await this.query('PRAGMA table_info(contact_group_members)');
      const tableSqlResult = await this.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='contact_group_members'");

      if (tableSqlResult.success && tableSqlResult.data.length > 0 && tableSqlResult.data[0].sql.includes('ON DELETE CASCADE')) {

        // Create new table with RESTRICT constraints
        this.db.run(`
          CREATE TABLE contact_group_members_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE RESTRICT,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
            UNIQUE(group_id, contact_id)
          )
        `);

        // Copy data from old table
        this.db.run(`
          INSERT INTO contact_group_members_new (id, group_id, contact_id, added_at)
          SELECT id, group_id, contact_id, added_at FROM contact_group_members
        `);

        // Drop old table and rename new one
        this.db.run('DROP TABLE contact_group_members');
        this.db.run('ALTER TABLE contact_group_members_new RENAME TO contact_group_members');

        // Recreate indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_contact_group_members_group ON contact_group_members(group_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact ON contact_group_members(contact_id)');

      }

    } catch (error) {
      console.error('❌ Error applying migrations:', error);
    }
  }

  /**
   * Add is_encrypted_fallback column to poll_votes table
   */
  async runPollVotesEncryptedFallbackMigration() {
    try {

      // Check if is_encrypted_fallback column exists
      const tableInfoResult = await this.query("PRAGMA table_info(poll_votes)");
      if (!tableInfoResult.success) {
        console.error('❌ Error checking poll_votes table info:', tableInfoResult.error);
        return;
      }

      const tableData = Array.isArray(tableInfoResult.data) ? tableInfoResult.data :
                       (tableInfoResult.data && Array.isArray(tableInfoResult.data.values) ? tableInfoResult.data.values : []);
      const columnNames = tableData.map(col => col.name || col[1]);

      // Check if is_encrypted_fallback column already exists
      if (columnNames.includes('is_encrypted_fallback')) {
        return;
      }


      // Add the new column
      const addColumnResult = await this.query('ALTER TABLE poll_votes ADD COLUMN is_encrypted_fallback BOOLEAN DEFAULT 0');
      if (!addColumnResult.success) {
        console.error('❌ Error adding is_encrypted_fallback column:', addColumnResult.error);
        return;
      }


    } catch (error) {
      console.error('❌ Error in poll votes encrypted fallback migration:', error);
    }
  }

  /**
   * Delete all data from the database except translation keys
   * This will clear all user data but preserve translation configurations
   */
  async deleteAllDataExceptTranslations() {
    try {

      // List of all tables to clear (excluding translation tables)
      const tablesToClear = [
        // WhatsApp and messaging
        'whatsapp_sessions',
        'message_templates',
        'contacts',
        'contact_groups',
        'contact_group_members',
        'message_history',

        // Campaigns and bulk messaging
        'bulk_campaigns',
        'bulk_campaign_recipients',
        'campaign_message_counts',
        'campaign_proxy_assignments',
        'spintax_state',

        // Communication preferences
        'communication_preferences',
        'opt_out_keywords',
        'opt_out_requests',
        'compliance_audit_log',

        // Auto reply and chatbot
        'auto_reply_rules',
        'auto_reply_cooldowns',
        'chatbot_flows',
        'chatbot_nodes',
        'chatbot_conversations',
        'chatbot_saved_data',
        'chatbot_flow_cooldowns',

        // Call responder
        'call_responses',

        // Email
        'email_settings',
        'email_templates',
        'email_logs',

        // Warmer
        'warmer_campaigns',
        'warmer_templates',
        'warmer_logs',

        // Proxy
        'proxy_settings',
        'proxies',
        'proxy_usage_logs',

        // Backup
        'backup_history',
        'backup_schedules',

        // Activity logs
        'activity_logs',

        // Recall bot
        'recall_bot_settings',
        'reminders',
        'voice_transcriptions',
        'recall_bot_logs',

        // Support bot
        'support_bot_settings',
        'support_bot_customers',
        'support_bot_field_mappings',
        'support_bot_logs',

        // AI Chatbot
        'ai_providers',
        'ai_chatbots',
        'ai_conversations',
        'ai_messages',
        'ai_intents',
        'ai_knowledge_base',
        'ai_global_settings',
        'ai_decision_flows',
        'ai_form_templates',
        'ai_form_submissions',
        'ai_appointments',
        'ai_learning_data',
        'ai_documents',

        // Polls
        'poll_messages',
        'poll_options',
        'poll_votes',

        // Follow up
        'follow_up_messages',
        'follow_up_logs',
        'follow_up_statistics',

        // Google Drive
        'google_drive_config'
      ];

      let deletedCount = 0;
      let errors = [];

      // Delete data from each table
      for (const table of tablesToClear) {
        try {
          const result = await this.run(`DELETE FROM ${table}`);
          if (result.success) {
            deletedCount++;
          } else {
            // Table might not exist, which is okay
          }
        } catch (error) {
          errors.push({ table, error: error.message });
        }
      }

      // Reset app_settings to defaults (but keep the table)
      try {
        await this.run('DELETE FROM app_settings');
        await this.insertDefaultSettings();
      } catch (error) {
        errors.push({ table: 'app_settings', error: error.message });
      }

      // Reset bulk_message_settings to defaults
      try {
        await this.run('DELETE FROM bulk_message_settings');
      } catch (error) {
      }

      // Save the database to disk
      await this.saveDatabase();


      if (errors.length > 0) {
      }

      return {
        success: true,
        deletedCount,
        errors: errors.length > 0 ? errors : undefined,
        message: `Successfully cleared ${deletedCount} tables. Translation keys preserved.`
      };

    } catch (error) {
      console.error('❌ Error in deleteAllDataExceptTranslations:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Migrate call responder delay from minutes to seconds and add cooldown
   */
  async migrateCallResponderDelayToSeconds() {
    try {
      if (global.logToFile) {
        global.logToFile('🔧 Migrating call responder delay from minutes to seconds...');
      }

      // Check if delay_seconds column already exists
      const tableInfo = this.db.exec("PRAGMA table_info(call_responses)");

      if (!tableInfo || tableInfo.length === 0) {
        if (global.logToFile) {
          global.logToFile('⚠️  call_responses table does not exist yet');
        }
        return;
      }

      const columns = tableInfo[0].values.map(col => col[1]); // column names are at index 1
      const hasDelaySeconds = columns.includes('delay_seconds');
      const hasDelayMinutes = columns.includes('delay_minutes');
      const hasCooldownMinutes = columns.includes('cooldown_minutes');

      // Add cooldown_minutes column if it doesn't exist
      if (!hasCooldownMinutes) {
        if (global.logToFile) {
          global.logToFile('🔧 Adding cooldown_minutes column...');
        }
        this.db.run(`ALTER TABLE call_responses ADD COLUMN cooldown_minutes INTEGER DEFAULT 0`);

        // Create cooldown tracking table
        this.db.run(`CREATE TABLE IF NOT EXISTS call_response_cooldowns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL,
          contact_jid TEXT NOT NULL,
          last_triggered DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (rule_id) REFERENCES call_responses(id) ON DELETE CASCADE,
          UNIQUE(rule_id, contact_jid)
        )`);

        if (global.logToFile) {
          global.logToFile('✅ Added cooldown_minutes column and cooldown tracking table');
        }
      }

      // Add delay_seconds column if it doesn't exist
      if (!hasDelaySeconds && hasDelayMinutes) {
        if (global.logToFile) {
          global.logToFile('🔧 Adding delay_seconds column and converting data...');
        }

        // Add delay_seconds column
        this.db.run(`ALTER TABLE call_responses ADD COLUMN delay_seconds INTEGER DEFAULT 60`);

        // Convert existing delay_minutes to delay_seconds (minutes * 60)
        this.db.run(`UPDATE call_responses SET delay_seconds = delay_minutes * 60`);

        if (global.logToFile) {
          global.logToFile('✅ Successfully migrated delay_minutes to delay_seconds');
        }
      } else if (hasDelaySeconds) {
        if (global.logToFile) {
          global.logToFile('✅ delay_seconds column already exists');
        }
      }

    } catch (error) {
      if (global.logToFile) {
        global.logToFile(`❌ Error migrating call responder: ${error.message}`);
      }
      console.error('❌ Error migrating call responder:', error);
    }
  }

  /**
   * Fix broken condition node paths
   * This migration runs on every startup to auto-correct condition nodes
   * that point to non-existent nodes
   */
  async fixBrokenConditionPaths() {
    try {
      if (global.logToFile) {
        global.logToFile('🔧 Checking for broken condition paths...');
      }

      // Get all condition nodes
      const conditionNodes = this.db.exec(`
        SELECT id, flow_id, name, options
        FROM chatbot_nodes
        WHERE node_type = 'condition'
      `);

      if (!conditionNodes || conditionNodes.length === 0 || !conditionNodes[0].values) {
        if (global.logToFile) {
          global.logToFile('✅ No condition nodes found');
        }
        return;
      }

      let fixedCount = 0;

      for (const row of conditionNodes[0].values) {
        const [nodeId, flowId, nodeName, optionsStr] = row;

        try {
          const options = JSON.parse(optionsStr || '{}');
          const truePath = options.true_path;
          const falsePath = options.false_path;

          // Check if paths exist
          let needsFix = false;
          let newTruePath = truePath;
          let newFalsePath = falsePath;

          if (truePath) {
            const trueNodeExists = this.db.exec(`SELECT id FROM chatbot_nodes WHERE id = ?`, [truePath]);
            if (!trueNodeExists || trueNodeExists.length === 0 || !trueNodeExists[0].values || trueNodeExists[0].values.length === 0) {
              needsFix = true;
              if (global.logToFile) {
                global.logToFile(`⚠️  Node ${nodeId} (${nodeName}): true_path ${truePath} does not exist`);
              }
            }
          }

          if (falsePath) {
            const falseNodeExists = this.db.exec(`SELECT id FROM chatbot_nodes WHERE id = ?`, [falsePath]);
            if (!falseNodeExists || falseNodeExists.length === 0 || !falseNodeExists[0].values || falseNodeExists[0].values.length === 0) {
              needsFix = true;
              if (global.logToFile) {
                global.logToFile(`⚠️  Node ${nodeId} (${nodeName}): false_path ${falsePath} does not exist`);
              }
            }
          }

          if (needsFix) {
            // Find the correct nodes by position in the same flow
            const flowNodes = this.db.exec(`
              SELECT id, name, position
              FROM chatbot_nodes
              WHERE flow_id = ?
              ORDER BY position
            `, [flowId]);

            if (flowNodes && flowNodes.length > 0 && flowNodes[0].values) {
              // Look for "Positive Response" and "Negative Response" nodes
              for (const nodeRow of flowNodes[0].values) {
                const [id, name, position] = nodeRow;

                if (name && name.toLowerCase().includes('positive')) {
                  newTruePath = id;
                }
                if (name && name.toLowerCase().includes('negative')) {
                  newFalsePath = id;
                }
              }

              // Update the options if we found valid nodes
              if (newTruePath !== truePath || newFalsePath !== falsePath) {
                options.true_path = newTruePath;
                options.false_path = newFalsePath;

                this.db.run(`
                  UPDATE chatbot_nodes
                  SET options = ?
                  WHERE id = ?
                `, [JSON.stringify(options), nodeId]);

                fixedCount++;

                if (global.logToFile) {
                  global.logToFile(`✅ Fixed node ${nodeId} (${nodeName}): true_path=${newTruePath}, false_path=${newFalsePath}`);
                }
              }
            }
          }
        } catch (parseError) {
          if (global.logToFile) {
            global.logToFile(`⚠️  Could not parse options for node ${nodeId}: ${parseError.message}`);
          }
        }
      }

      if (fixedCount > 0) {
        if (global.logToFile) {
          global.logToFile(`✅ Fixed ${fixedCount} broken condition path(s)`);
        }
      } else {
        if (global.logToFile) {
          global.logToFile('✅ All condition paths are valid');
        }
      }

    } catch (error) {
      if (global.logToFile) {
        global.logToFile(`❌ Error fixing broken condition paths: ${error.message}`);
      }
      console.error('❌ Error fixing broken condition paths:', error);
    }
  }
}

module.exports = DatabaseService;