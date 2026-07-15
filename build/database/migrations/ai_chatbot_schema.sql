-- AI Chatbot Module Database Schema

-- Main AI Chatbots table
CREATE TABLE IF NOT EXISTS ai_chatbots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini')),
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    temperature REAL DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 1000,
    system_prompt TEXT,
    language TEXT DEFAULT 'en',
    is_active BOOLEAN DEFAULT 1,
    session_ids TEXT, -- JSON array of WhatsApp session IDs
    features TEXT, -- JSON object with feature flags
    personality TEXT DEFAULT 'professional',
    industry TEXT DEFAULT 'general',
    response_delay INTEGER DEFAULT 1000, -- milliseconds
    fallback_message TEXT,
    max_conversation_length INTEGER DEFAULT 50,
    enable_learning BOOLEAN DEFAULT 1,
    confidence_threshold REAL DEFAULT 0.7,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- AI Conversations table for tracking interactions
CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    user_phone TEXT NOT NULL,
    conversation_id TEXT NOT NULL, -- Unique conversation identifier
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'escalated', 'timeout')),
    context TEXT, -- JSON object with conversation context
    satisfaction_score REAL,
    resolved BOOLEAN DEFAULT 0,
    escalated_to_human BOOLEAN DEFAULT 0,
    response_time REAL, -- Average response time in seconds
    message_count INTEGER DEFAULT 0,
    language_detected TEXT,
    sentiment_score REAL,
    intent_detected TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
);

-- AI Messages table for storing individual messages
CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('user', 'bot', 'system')),
    content TEXT NOT NULL,
    metadata TEXT, -- JSON object with additional data
    tokens_used INTEGER,
    processing_time REAL, -- Time taken to generate response
    confidence_score REAL,
    intent TEXT,
    sentiment TEXT,
    language TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

-- Decision Tree Flows table
CREATE TABLE IF NOT EXISTS ai_decision_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    trigger_keywords TEXT, -- JSON array of trigger words
    flow_data TEXT NOT NULL, -- JSON object with flow structure
    is_active BOOLEAN DEFAULT 1,
    priority INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
);

-- Form Templates table for data collection
CREATE TABLE IF NOT EXISTS ai_form_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    fields TEXT NOT NULL, -- JSON array of form fields
    submit_message TEXT,
    validation_rules TEXT, -- JSON object with validation rules
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
);

-- Form Submissions table
CREATE TABLE IF NOT EXISTS ai_form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_template_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    user_phone TEXT NOT NULL,
    submission_data TEXT NOT NULL, -- JSON object with submitted data
    status TEXT DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (form_template_id) REFERENCES ai_form_templates(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

-- Knowledge Base table for training data
CREATE TABLE IF NOT EXISTS ai_knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    category TEXT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT, -- JSON array of keywords
    confidence_threshold REAL DEFAULT 0.8,
    usage_count INTEGER DEFAULT 0,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
);

-- Intent Recognition table
CREATE TABLE IF NOT EXISTS ai_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    training_phrases TEXT NOT NULL, -- JSON array of training phrases
    response_templates TEXT, -- JSON array of response templates
    action_type TEXT, -- 'response', 'flow', 'form', 'escalate'
    action_data TEXT, -- JSON object with action configuration
    confidence_threshold REAL DEFAULT 0.7,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE
);

-- Appointment Booking table
CREATE TABLE IF NOT EXISTS ai_appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    user_phone TEXT NOT NULL,
    appointment_type TEXT,
    appointment_date DATETIME,
    duration INTEGER, -- minutes
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed')),
    notes TEXT,
    reminder_sent BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

-- Global AI Settings table
CREATE TABLE IF NOT EXISTS ai_global_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Learning Data table for continuous improvement
CREATE TABLE IF NOT EXISTS ai_learning_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    user_input TEXT NOT NULL,
    bot_response TEXT NOT NULL,
    user_feedback TEXT, -- 'positive', 'negative', 'neutral'
    correction TEXT, -- User's correction if response was wrong
    context TEXT, -- JSON object with conversation context
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES ai_chatbots(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

-- Analytics Views for reporting
CREATE VIEW IF NOT EXISTS ai_chatbot_analytics AS
SELECT 
    c.id as chatbot_id,
    c.name as chatbot_name,
    COUNT(DISTINCT conv.id) as total_conversations,
    COUNT(DISTINCT conv.user_phone) as unique_users,
    AVG(conv.satisfaction_score) as avg_satisfaction,
    AVG(conv.response_time) as avg_response_time,
    COUNT(CASE WHEN conv.resolved = 1 THEN 1 END) as resolved_conversations,
    COUNT(CASE WHEN conv.escalated_to_human = 1 THEN 1 END) as escalated_conversations,
    AVG(conv.message_count) as avg_message_count,
    DATE(conv.created_at) as date
FROM ai_chatbots c
LEFT JOIN ai_conversations conv ON c.id = conv.chatbot_id
WHERE conv.created_at >= datetime('now', '-30 days')
GROUP BY c.id, DATE(conv.created_at);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_conversations_chatbot_id ON ai_conversations(chatbot_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_phone ON ai_conversations(user_phone);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_created_at ON ai_conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_id ON ai_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_created_at ON ai_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_base_chatbot_id ON ai_knowledge_base(chatbot_id);
CREATE INDEX IF NOT EXISTS idx_ai_intents_chatbot_id ON ai_intents(chatbot_id);
CREATE INDEX IF NOT EXISTS idx_ai_appointments_chatbot_id ON ai_appointments(chatbot_id);
CREATE INDEX IF NOT EXISTS idx_ai_appointments_date ON ai_appointments(appointment_date);

-- Insert default global settings
INSERT OR IGNORE INTO ai_global_settings (key, value, description) VALUES 
('global_config', '{"enableGlobalFallback": true, "enableAnalytics": true, "enableLearning": true}', 'Global AI configuration settings'),
('rate_limits', '{"maxConcurrentConversations": 100, "rateLimitPerUser": 10, "rateLimitWindow": 60}', 'Rate limiting configuration'),
('features', '{"enableSentimentAnalysis": true, "enableLanguageDetection": true, "enableProfanityFilter": true}', 'Global feature flags');
