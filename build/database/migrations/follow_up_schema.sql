-- Follow Up Messages Module Database Schema
-- This file contains the database schema for Follow Up Messages functionality

-- Create follow_up_messages table
CREATE TABLE IF NOT EXISTS follow_up_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    session_id TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_name TEXT,
    message_content TEXT NOT NULL,
    template_id INTEGER,
    attachment_data TEXT, -- JSON for attachment info
    attachment_type TEXT,
    message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'template', 'image', 'document')),
    scheduled_at DATETIME NOT NULL,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'paused', 'skipped')),
    priority INTEGER DEFAULT 1 CHECK (priority BETWEEN 1 AND 4),
    category TEXT DEFAULT 'general',
    tags TEXT, -- JSON array
    variables TEXT, -- JSON object for template variables
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_attempt_at DATETIME,
    sent_at DATETIME,
    message_id TEXT,
    notes TEXT,
    created_by TEXT DEFAULT 'user',
    is_recurring INTEGER DEFAULT 0,
    recurring_pattern TEXT, -- JSON object for recurring settings
    parent_follow_up_id INTEGER, -- For recurring follow-ups
    send_if_replied INTEGER DEFAULT 1,
    auto_reschedule INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(session_id),
    FOREIGN KEY (template_id) REFERENCES message_templates(id),
    FOREIGN KEY (parent_follow_up_id) REFERENCES follow_up_messages(id)
);

-- Create follow_up_logs table for tracking execution history
CREATE TABLE IF NOT EXISTS follow_up_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follow_up_id INTEGER NOT NULL,
    action TEXT NOT NULL, -- 'created', 'scheduled', 'sent', 'failed', 'cancelled', 'retry'
    status_before TEXT,
    status_after TEXT,
    message TEXT,
    error_details TEXT,
    execution_time INTEGER, -- milliseconds
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (follow_up_id) REFERENCES follow_up_messages(id) ON DELETE CASCADE
);

-- Create follow_up_statistics table for analytics
CREATE TABLE IF NOT EXISTS follow_up_statistics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    total_scheduled INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_cancelled INTEGER DEFAULT 0,
    total_skipped INTEGER DEFAULT 0,
    avg_delivery_time REAL, -- Average time from scheduled to sent in minutes
    success_rate REAL, -- Percentage of successful deliveries
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_session ON follow_up_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_contact ON follow_up_messages(contact_phone);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_status ON follow_up_messages(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_scheduled ON follow_up_messages(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_priority ON follow_up_messages(priority);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_category ON follow_up_messages(category);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_recurring ON follow_up_messages(is_recurring);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_parent ON follow_up_messages(parent_follow_up_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_created_at ON follow_up_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_messages_status_scheduled ON follow_up_messages(status, scheduled_at);

-- Indexes for logs table
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_follow_up_id ON follow_up_logs(follow_up_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_action ON follow_up_logs(action);
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_created_at ON follow_up_logs(created_at);

-- Indexes for statistics table
CREATE INDEX IF NOT EXISTS idx_follow_up_statistics_date ON follow_up_statistics(date);

-- Create view for follow-up analytics
CREATE VIEW IF NOT EXISTS follow_up_analytics AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_created,
    COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled,
    COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
    COUNT(CASE WHEN status = 'skipped' THEN 1 END) as skipped,
    ROUND(
        (COUNT(CASE WHEN status = 'sent' THEN 1 END) * 100.0) / 
        NULLIF(COUNT(CASE WHEN status IN ('sent', 'failed') THEN 1 END), 0), 
        2
    ) as success_rate,
    AVG(
        CASE 
            WHEN status = 'sent' AND sent_at IS NOT NULL AND scheduled_at IS NOT NULL 
            THEN (julianday(sent_at) - julianday(scheduled_at)) * 24 * 60 
        END
    ) as avg_delivery_delay_minutes,
    category,
    priority
FROM follow_up_messages
WHERE created_at >= datetime('now', '-30 days')
GROUP BY DATE(created_at), category, priority
ORDER BY date DESC;

-- Create view for upcoming follow-ups
CREATE VIEW IF NOT EXISTS upcoming_follow_ups AS
SELECT 
    fu.*,
    ws.device_name,
    mt.name as template_name,
    mt.type as template_type,
    c.name as contact_display_name,
    CASE 
        WHEN datetime(fu.scheduled_at) <= datetime('now', '+1 hour') THEN 'urgent'
        WHEN datetime(fu.scheduled_at) <= datetime('now', '+1 day') THEN 'today'
        WHEN datetime(fu.scheduled_at) <= datetime('now', '+7 days') THEN 'this_week'
        ELSE 'later'
    END as urgency_level
FROM follow_up_messages fu
LEFT JOIN whatsapp_sessions ws ON fu.session_id = ws.session_id
LEFT JOIN message_templates mt ON fu.template_id = mt.id
LEFT JOIN contacts c ON fu.contact_phone = c.phone_number
WHERE fu.status = 'scheduled'
AND datetime(fu.scheduled_at) >= datetime('now')
ORDER BY fu.priority DESC, fu.scheduled_at ASC;
