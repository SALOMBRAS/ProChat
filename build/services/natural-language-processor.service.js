const pino = require('pino');
const axios = require('axios');
const OpenAI = require('openai');
const chrono = require('chrono-node');
const moment = require('moment-timezone');

class NaturalLanguageProcessor {
  constructor() {
    this.logger = pino({ name: 'NaturalLanguageProcessor' });
    this.isInitialized = false;
    this.openaiClient = null;
  }

  /**
   * Initialize the natural language processor
   */
  async initialize() {
    try {
      this.logger.info('🧠 Initializing Natural Language Processor...');
      
      this.isInitialized = true;
      this.logger.info('✅ Natural Language Processor initialized successfully');
      
      return { success: true };
    } catch (error) {
      this.logger.error('❌ Failed to initialize Natural Language Processor:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process reminder message using AI
   */
  async processReminderMessage(messageText, settings, userJid) {
    try {
      this.logger.info(`🧠 Processing reminder message with AI provider: ${settings.ai_provider}`);

      // Quick check for "cancel all" before calling AI
      const lowerMessage = messageText.toLowerCase().trim();
      if ((lowerMessage === 'cancel all' || lowerMessage === 'delete all' || lowerMessage === 'clear all' || lowerMessage === 'remove all') ||
          ((lowerMessage.includes('cancel') || lowerMessage.includes('delete') || lowerMessage.includes('remove') || lowerMessage.includes('clear')) &&
           (lowerMessage.includes('all') || lowerMessage.includes('everything')) &&
           !lowerMessage.includes('remind'))) {
        this.logger.info('🔍 Quick match: Detected cancel_all action');
        return {
          success: true,
          response: {
            action: 'cancel_all',
            reminder_text: '',
            scheduled_time: null,
            timezone: settings.default_timezone || 'Asia/Kolkata',
            recurrence_type: null,
            recurrence_interval: null,
            recurrence_end_date: null,
            confidence: 0.95,
            reasoning: 'Quick match for cancel all keywords'
          }
        };
      }

      // First, try to extract basic date/time information using chrono-node
      const chronoResults = chrono.parse(messageText, new Date(), { forwardDate: true });
      
      // Prepare the AI prompt
      const prompt = this.buildReminderPrompt(messageText, chronoResults, settings.default_timezone);
      
      let aiResponse;
      
      // Process with the configured AI provider
      switch (settings.ai_provider) {
        case 'openai':
          aiResponse = await this.processWithOpenAI(prompt, settings);
          break;
        default:
          throw new Error(`Unsupported AI provider: ${settings.ai_provider}. Only OpenAI is supported.`);
      }

      // Validate and parse the AI response
      const parsedResponse = this.parseAIResponse(aiResponse);
      
      this.logger.info(`✅ AI processing completed. Action: ${parsedResponse.action}`);
      this.logger.info('🔍 AI Response Details:', JSON.stringify(parsedResponse, null, 2));

      // Force timezone to Asia/Kolkata if AI returned UTC
      if (parsedResponse.timezone === 'UTC') {
        this.logger.info('🔧 Fixing timezone from UTC to Asia/Kolkata');
        parsedResponse.timezone = 'Asia/Kolkata';
      }

      return { success: true, response: parsedResponse };

    } catch (error) {
      this.logger.error('Error processing reminder message with AI:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build the AI prompt for reminder processing
   */
  buildReminderPrompt(messageText, chronoResults, defaultTimezone) {
    const chronoInfo = chronoResults.length > 0 ?
      `Chrono.js detected: ${JSON.stringify(chronoResults.map(r => ({ text: r.text, start: r.start.date() })))}` :
      'No clear date/time detected by chrono.js';

    // Use Asia/Kolkata as default timezone for Indian users
    const timezone = defaultTimezone || 'Asia/Kolkata';
    const currentTime = moment().tz(timezone).format('YYYY-MM-DD HH:mm:ss z');

    return `You are a smart reminder assistant. Analyze the following message and extract reminder information.

Message: "${messageText}"
${chronoInfo}
Default timezone: ${timezone}
Current time: ${currentTime}

Respond with a JSON object containing:
{
  "action": "create|update|cancel|cancel_all|list|clarify",
  "reminder_text": "clean, concise reminder description (convert 'my' to 'your' when appropriate for bot perspective)",
  "scheduled_time": "ISO 8601 datetime string in ${timezone} timezone (NOT UTC!)",
  "timezone": "${timezone}",
  "recurrence_type": "daily|weekly|monthly|yearly|null",
  "recurrence_interval": "number (e.g., 2 for every 2 days)",
  "recurrence_end_date": "ISO 8601 datetime string or null",
  "confidence": "0.0-1.0 confidence score",
  "reasoning": "brief explanation of your interpretation"
}

CRITICAL: The scheduled_time MUST be in ${timezone} timezone, NOT UTC!
Example: If user says "6 pm today" and current time is 5:30 PM ${timezone},
the scheduled_time should be "2025-11-08T18:00:00+05:30" (for Asia/Kolkata),
NOT "2025-11-08T18:00:00Z" or "2025-11-08T12:30:00Z"

Rules:
1. CRITICAL: If the message is ONLY "cancel all", "delete all", "clear all", "remove all" (with NO other context), set action to "cancel_all" - do NOT ask for clarification
2. If the message is asking to cancel/delete ALL reminders (e.g., "cancel all reminders", "delete all my reminders", "clear all reminders"), set action to "cancel_all"
3. If the message is asking to cancel/delete a single reminder, set action to "cancel"
4. If asking to list reminders, set action to "list"
5. If updating an existing reminder, set action to "update"
6. If no clear time is specified for a NEW reminder, ask for clarification by setting action to "clarify"
7. Always use future dates/times
8. For relative times like "tomorrow", "next week", calculate the actual datetime relative to current time in ${timezone}
9. For recurring reminders, set appropriate recurrence_type and recurrence_interval
10. Default to "create" for new reminders
11. ALWAYS use ${timezone} as the timezone in your response - this is critical for proper scheduling
12. Be conservative - if unsure about the time for a NEW reminder, set confidence low and action to "clarify"
13. When calculating future times, add the time to the current time in ${timezone}, not UTC
14. Recognize common abbreviations: "mins/mnts" = minutes, "hrs" = hours, "secs" = seconds, "tmrw" = tomorrow
15. For time expressions like "in X minutes/hours", add that duration to current time
16. IMPORTANT: When user says "at X pm/am today" or "at X pm/am", set the time to EXACTLY that hour, do NOT add it to current time
17. Example: If current time is 5:30 PM and user says "at 6 pm today", the scheduled time should be 6:00 PM (18:00), NOT 11:30 PM
18. "at 6 pm" means 18:00 hours, "at 6 am" means 06:00 hours - use 24-hour format internally

Examples:
- "Remind me to call mom tomorrow at 3pm" → reminder_text: "call mom", scheduled_time: tomorrow at 15:00
- "Set a reminder for my meeting next Monday at 10am" → reminder_text: "for your meeting", scheduled_time: next Monday at 10:00
- "Remind me to check my emails" → reminder_text: "check your emails", action: "clarify" (no time specified)
- "Remind me to take my medicine" → reminder_text: "take your medicine", action: "clarify" (no time specified)
- "Remind me to call John in 5 mins" → reminder_text: "call John", scheduled_time: current_time + 5 minutes
- "Remind me to call soham at 6 pm today" → reminder_text: "call soham", scheduled_time: TODAY at 18:00 (NOT current_time + 6 hours!)
- "Please remind me at 9 am tomorrow" → scheduled_time: tomorrow at 09:00
- "Please remind me to call Deepali in mnts" → reminder_text: "call Deepali", action: "clarify" (need exact minutes)
- "Cancel my reminder" → action: "cancel"
- "Cancel all reminders" → action: "cancel_all"
- "Delete all my reminders" → action: "cancel_all"
- "Clear everything" → action: "cancel_all"
- "What are my reminders?" → action: "list"
- "Remind me to take medicine every day at 8am" → create with daily recurrence, scheduled_time: today/tomorrow at 08:00

IMPORTANT: Always convert possessive pronouns from user's perspective to bot's perspective:
- "my emails" → "your emails"
- "my medicine" → "your medicine"
- "my meeting" → "your meeting"

Respond only with valid JSON.`;
  }



  /**
   * Process with OpenAI
   */
  async processWithOpenAI(prompt, settings) {
    try {
      this.logger.info('🔍 OpenAI API call starting...');
      this.logger.info(`🔍 API Key: ${settings.ai_api_key ? settings.ai_api_key.substring(0, 10) + '...' : 'NOT SET'}`);
      this.logger.info(`🔍 Model: ${settings.ai_model || 'gpt-4o-mini'}`);

      if (!this.openaiClient && settings.ai_api_key) {
        this.openaiClient = new OpenAI({ apiKey: settings.ai_api_key });
        this.logger.info('✅ OpenAI client initialized');
      }

      if (!this.openaiClient) {
        throw new Error('OpenAI API key not configured');
      }

      // Use the latest OpenAI model if not specified or if using old model
      let model = settings.ai_model || 'gpt-4o-mini';

      // Update old models to latest equivalents
      if (model === 'gpt-3.5-turbo') {
        model = 'gpt-4o-mini'; // Latest cost-effective model
      } else if (model === 'gpt-4') {
        model = 'gpt-4o'; // Latest GPT-4 model
      } else if (model === 'gpt-4-turbo') {
        model = 'gpt-4o'; // Latest GPT-4 model
      }

      this.logger.info('🔍 Request data:', JSON.stringify({
        model: model,
        temperature: settings.ai_temperature || 0.3,
        max_tokens: 1000,
        promptLength: prompt.length
      }, null, 2));

      const completion = await this.openaiClient.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: settings.ai_temperature || 0.3,
        max_tokens: 1000,
      });

      this.logger.info('🔍 OpenAI API response received');
      this.logger.info('🔍 Response data:', JSON.stringify({
        model: completion.model,
        usage: completion.usage,
        choices: completion.choices.length
      }, null, 2));

      const content = completion.choices[0].message.content;
      this.logger.info('🔍 Extracted content:', content);

      return content;

    } catch (error) {
      this.logger.error('❌ Error with OpenAI processing:', error);

      if (error.response) {
        this.logger.error('❌ Response status:', error.response.status);
        this.logger.error('❌ Response data:', JSON.stringify(error.response.data, null, 2));
        this.logger.error('❌ Response headers:', JSON.stringify(error.response.headers, null, 2));
      } else if (error.request) {
        this.logger.error('❌ Request error (no response):', error.request);
      } else {
        this.logger.error('❌ Error message:', error.message);
      }

      // Fallback to basic parsing if API fails
      if (error.message.includes('API key') || error.status === 401 || !settings.ai_api_key) {
        this.logger.warn('⚠️ OpenAI API key invalid or missing, using fallback parsing');
        return this.fallbackParsing(prompt);
      }

      // For other errors, also use fallback parsing instead of throwing
      this.logger.warn('⚠️ OpenAI API failed, using fallback parsing');
      return this.fallbackParsing(prompt);
    }
  }



  /**
   * Fallback parsing when AI APIs are not available
   */
  fallbackParsing(prompt) {
    // Extract the original message from the prompt
    const messageMatch = prompt.match(/Message: "(.+?)"/);
    const messageText = messageMatch ? messageMatch[1] : '';

    // Simple keyword-based parsing
    const lowerMessage = messageText.toLowerCase();

    // Check for cancel all keywords first (more specific)
    if ((lowerMessage.includes('cancel') || lowerMessage.includes('delete') || lowerMessage.includes('remove') || lowerMessage.includes('clear')) &&
        (lowerMessage.includes('all') || lowerMessage.includes('everything') || lowerMessage.includes('every'))) {
      return JSON.stringify({
        action: 'cancel_all',
        reminder_text: '',
        scheduled_time: null,
        timezone: 'Asia/Kolkata',
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.9,
        reasoning: 'Detected cancel all reminders keywords'
      });
    }

    // Check for single cancel keywords
    if (lowerMessage.includes('cancel') || lowerMessage.includes('delete') || lowerMessage.includes('remove')) {
      return JSON.stringify({
        action: 'cancel',
        reminder_text: '',
        scheduled_time: null,
        timezone: 'Asia/Kolkata',
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.8,
        reasoning: 'Detected cancel/delete keywords'
      });
    }

    if (lowerMessage.includes('list') || lowerMessage.includes('show') || lowerMessage.includes('what are my')) {
      return JSON.stringify({
        action: 'list',
        reminder_text: '',
        scheduled_time: null,
        timezone: 'Asia/Kolkata',
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.8,
        reasoning: 'Detected list keywords'
      });
    }

    // Handle common abbreviations before chrono parsing
    let processedMessage = messageText;

    // Replace common abbreviations
    processedMessage = processedMessage.replace(/\bmnts?\b/gi, 'minutes');
    processedMessage = processedMessage.replace(/\bmins?\b/gi, 'minutes');
    processedMessage = processedMessage.replace(/\bhrs?\b/gi, 'hours');
    processedMessage = processedMessage.replace(/\bsecs?\b/gi, 'seconds');
    processedMessage = processedMessage.replace(/\btmrw\b/gi, 'tomorrow');

    // Handle "in X minutes/hours" patterns
    const inTimeMatch = processedMessage.match(/\bin\s+(\d+)\s+(minutes?|hours?|seconds?)/i);
    if (inTimeMatch) {
      const amount = parseInt(inTimeMatch[1]);
      const unit = inTimeMatch[2].toLowerCase();
      const now = moment().tz('Asia/Kolkata');

      let scheduledTime;
      if (unit.startsWith('minute')) {
        scheduledTime = now.add(amount, 'minutes');
      } else if (unit.startsWith('hour')) {
        scheduledTime = now.add(amount, 'hours');
      } else if (unit.startsWith('second')) {
        scheduledTime = now.add(amount, 'seconds');
      }

      if (scheduledTime) {
        const reminderText = processedMessage.replace(/\bin\s+\d+\s+(minutes?|hours?|seconds?)/i, '').replace(/remind me to|please remind me to|set a reminder to/i, '').trim();

        return JSON.stringify({
          action: 'create',
          reminder_text: reminderText || 'Reminder',
          scheduled_time: scheduledTime.toISOString(),
          timezone: 'Asia/Kolkata',
          recurrence_type: null,
          recurrence_interval: null,
          recurrence_end_date: null,
          confidence: 0.7,
          reasoning: `Parsed relative time: in ${amount} ${unit}`
        });
      }
    }

    // Try to parse with chrono-node for basic date/time extraction
    const chronoResults = chrono.parse(processedMessage, new Date(), { forwardDate: true });

    if (chronoResults.length > 0) {
      const firstResult = chronoResults[0];
      // Use Asia/Kolkata as default timezone for proper time handling
      const defaultTz = 'Asia/Kolkata';

      // Get the date components from chrono result
      const chronoDate = firstResult.start.date();

      // Create a moment object in the target timezone using the date components
      // This ensures we interpret the time as Asia/Kolkata time, not convert it
      const scheduledTime = moment.tz({
        year: chronoDate.getFullYear(),
        month: chronoDate.getMonth(),
        day: chronoDate.getDate(),
        hour: chronoDate.getHours(),
        minute: chronoDate.getMinutes(),
        second: chronoDate.getSeconds()
      }, defaultTz).toISOString();

      return JSON.stringify({
        action: 'create',
        reminder_text: messageText.replace(firstResult.text, '').trim() || 'Reminder',
        scheduled_time: scheduledTime,
        timezone: defaultTz,
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.6,
        reasoning: 'Basic chrono-node parsing without AI'
      });
    }

    // Check for incomplete time expressions (e.g., "in mnts" without number)
    const incompleteTimeMatch = processedMessage.match(/\bin\s+(minutes?|mins?|mnts?|hours?|hrs?|seconds?|secs?)\b/i);
    if (incompleteTimeMatch) {
      const unit = incompleteTimeMatch[1].toLowerCase();
      let unitName = 'minutes';
      if (unit.startsWith('hour') || unit === 'hrs') unitName = 'hours';
      if (unit.startsWith('second') || unit === 'secs') unitName = 'seconds';

      return JSON.stringify({
        action: 'clarify',
        reminder_text: messageText,
        scheduled_time: null,
        timezone: 'Asia/Kolkata',
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.6,
        reasoning: `Incomplete time specification: need number of ${unitName}`,
        message: `I understand you want a reminder, but could you please specify how many ${unitName}? For example: "remind me to call Deepali in 5 ${unitName}"`
      });
    }

    // If no clear time detected, ask for clarification
    return JSON.stringify({
      action: 'clarify',
      reminder_text: messageText,
      scheduled_time: null,
      timezone: 'Asia/Kolkata',
      recurrence_type: null,
      recurrence_interval: null,
      recurrence_end_date: null,
      confidence: 0.3,
      reasoning: 'No clear date/time detected, need clarification'
    });
  }

  /**
   * Parse and validate AI response
   */
  parseAIResponse(aiResponseText) {
    try {
      // Clean the response text (remove markdown code blocks if present)
      let cleanedResponse = aiResponseText.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(cleanedResponse);

      // Validate required fields
      if (!parsed.action) {
        throw new Error('Missing action field in AI response');
      }

      // Validate action type
      const validActions = ['create', 'update', 'cancel', 'list', 'clarify'];
      if (!validActions.includes(parsed.action)) {
        throw new Error(`Invalid action: ${parsed.action}`);
      }

      // For create/update actions, validate scheduled_time
      if ((parsed.action === 'create' || parsed.action === 'update') && parsed.scheduled_time) {
        const scheduledMoment = moment(parsed.scheduled_time);
        if (!scheduledMoment.isValid()) {
          throw new Error('Invalid scheduled_time format');
        }
        
        // Ensure it's a future time
        if (scheduledMoment.isBefore(moment())) {
          throw new Error('Scheduled time must be in the future');
        }
      }

      return parsed;

    } catch (error) {
      this.logger.error('Error parsing AI response:', error);
      this.logger.error('AI response text:', aiResponseText);
      
      // Return a clarification request if parsing fails
      return {
        action: 'clarify',
        reminder_text: '',
        scheduled_time: null,
        timezone: 'Asia/Kolkata',
        recurrence_type: null,
        recurrence_interval: null,
        recurrence_end_date: null,
        confidence: 0.1,
        reasoning: 'Failed to parse AI response'
      };
    }
  }
}

module.exports = NaturalLanguageProcessor;
