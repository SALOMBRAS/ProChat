-- Live Chat Module Database Schema
-- Comprehensive schema for modern helpdesk-style live chat with CRM integration

-- Live Chat Conversations Table
CREATE TABLE IF NOT EXISTS live_chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT UNIQUE NOT NULL, -- WhatsApp chat ID or unique identifier
    session_id TEXT NOT NULL, -- WhatsApp session ID
    contact_phone TEXT NOT NULL,
    contact_name TEXT,
    contact_avatar TEXT, -- Profile picture URL or path
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'pending', 'archived')),
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assigned_to TEXT, -- Agent/user assigned to this conversation
    channel TEXT DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'web', 'email', 'sms')),
    tags TEXT, -- JSON array of tags
    unread_count INTEGER DEFAULT 0,
    last_message_at DATETIME,
    last_message_preview TEXT,
    is_online BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    archived_at DATETIME
);

-- Live Chat Messages Table
CREATE TABLE IF NOT EXISTS live_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL, -- WhatsApp message ID or unique identifier
    conversation_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'system', 'bot')),
    sender_name TEXT,
    content TEXT,
    message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'system')),
    attachment_url TEXT, -- Local file path or URL
    attachment_name TEXT,
    attachment_size INTEGER,
    attachment_mime_type TEXT,
    caption TEXT, -- For media messages
    metadata TEXT, -- JSON object for additional data (reactions, mentions, etc.)
    status TEXT DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
    is_deleted BOOLEAN DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES live_chat_conversations(id) ON DELETE CASCADE
);

-- Live Chat Contacts (CRM) Table
CREATE TABLE IF NOT EXISTS live_chat_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    company TEXT,
    position TEXT,
    avatar TEXT,
    location TEXT,
    timezone TEXT,
    language TEXT DEFAULT 'en',
    tags TEXT, -- JSON array
    custom_fields TEXT, -- JSON object for custom CRM fields
    notes TEXT,
    total_conversations INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    first_contact_at DATETIME,
    last_contact_at DATETIME,
    customer_value REAL DEFAULT 0, -- Lifetime value
    satisfaction_score REAL, -- CSAT score
    is_vip BOOLEAN DEFAULT 0,
    is_blocked BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Live Chat Notes Table (for internal agent notes)
CREATE TABLE IF NOT EXISTS live_chat_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    contact_id INTEGER,
    author TEXT NOT NULL, -- Agent name
    note_type TEXT DEFAULT 'general' CHECK (note_type IN ('general', 'important', 'follow_up', 'issue')),
    content TEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES live_chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES live_chat_contacts(id) ON DELETE CASCADE
);

-- Live Chat Quick Replies / Canned Responses Table
CREATE TABLE IF NOT EXISTS live_chat_quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcut TEXT UNIQUE NOT NULL, -- e.g., /hello, /thanks
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    usage_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Live Chat Assignments Table (for team collaboration)
CREATE TABLE IF NOT EXISTS live_chat_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    assigned_to TEXT NOT NULL,
    assigned_by TEXT,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    unassigned_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (conversation_id) REFERENCES live_chat_conversations(id) ON DELETE CASCADE
);

-- Live Chat Activity Log Table (for audit trail)
CREATE TABLE IF NOT EXISTS live_chat_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('assigned', 'unassigned', 'status_changed', 'priority_changed', 'tagged', 'note_added', 'resolved', 'reopened')),
    actor TEXT, -- Who performed the action
    details TEXT, -- JSON object with activity details
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES live_chat_conversations(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_live_chat_conversations_session ON live_chat_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_live_chat_conversations_status ON live_chat_conversations(status);
CREATE INDEX IF NOT EXISTS idx_live_chat_conversations_contact ON live_chat_conversations(contact_phone);
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_conversation ON live_chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_created ON live_chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_live_chat_contacts_phone ON live_chat_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_live_chat_notes_conversation ON live_chat_notes(conversation_id);
CREATE INDEX IF NOT EXISTS idx_live_chat_activity_conversation ON live_chat_activity_log(conversation_id);

