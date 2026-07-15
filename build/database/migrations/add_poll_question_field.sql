-- Migration: Add poll_question field to message_templates table
-- This separates poll question from message content for better poll handling

-- Add poll_question column to message_templates table
ALTER TABLE message_templates ADD COLUMN poll_question TEXT;

-- Update existing poll templates to move content to poll_question field
-- This ensures backward compatibility
UPDATE message_templates 
SET poll_question = content 
WHERE type = 'poll' AND poll_question IS NULL;
