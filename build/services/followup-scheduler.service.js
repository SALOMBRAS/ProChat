const { EventEmitter } = require('events');

class FollowUpSchedulerService extends EventEmitter {
  constructor() {
    super();
    this.databaseService = null;
    this.whatsappService = null;
    this.messageProcessor = null;
    this.isRunning = false;
    this.schedulerInterval = null;
    this.checkInterval = 30000; // Check every 30 seconds
    this.activeProcesses = 0;
  }

  /**
   * Initialize the follow-up scheduler
   */
  async initialize(databaseService, whatsappService, messageProcessor) {
    this.databaseService = databaseService;
    this.whatsappService = whatsappService;
    this.messageProcessor = messageProcessor;

    return this;
  }

  /**
   * Start the follow-up scheduler
   */
  start() {
    console.log('🚀 Follow-up scheduler: Starting...');

    if (this.isRunning) {
      console.log('⚠️ Follow-up scheduler: Already running');
      return;
    }

    this.isRunning = true;
    console.log('✅ Follow-up scheduler: Started successfully');

    // Start the scheduler interval
    this.schedulerInterval = setInterval(() => {
      console.log('⏰ Follow-up scheduler: Running scheduled check...');
      this.checkScheduledFollowUps();
    }, this.checkInterval);

    // Run initial check
    console.log('🔄 Follow-up scheduler: Running initial check...');
    this.checkScheduledFollowUps();

    this.emit('scheduler-started');
  }

  /**
   * Stop the follow-up scheduler
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    this.emit('scheduler-stopped');
  }

  /**
   * Check for scheduled follow-ups that need to be sent
   */
  async checkScheduledFollowUps() {
    if (!this.databaseService || !this.whatsappService) {
      console.log('⚠️ Follow-up scheduler: Missing dependencies', {
        hasDatabaseService: !!this.databaseService,
        hasWhatsappService: !!this.whatsappService
      });
      return;
    }

    try {
      console.log('🔍 Follow-up scheduler: Checking for scheduled follow-ups...');

      // Get current time as Unix timestamp (milliseconds since epoch)
      // This works regardless of timezone and format
      const now = Date.now();
      console.log('⏰ Current timestamp:', now, '(', new Date(now).toISOString(), ')');

      // Get follow-ups that are scheduled and due to be sent
      // We'll filter in JavaScript to handle different date formats properly
      const response = await this.databaseService.query(`
        SELECT fu.*, ws.device_name, ws.status as session_status
        FROM follow_up_messages fu
        LEFT JOIN whatsapp_sessions ws ON fu.session_id = ws.session_id
        WHERE fu.status = 'scheduled'
        AND (ws.status = 'connected' OR ws.status IS NULL)
        ORDER BY fu.priority DESC, fu.scheduled_at ASC
      `);

      if (!response.success) {
        console.error('⚠️ Failed to fetch scheduled follow-ups:', response.error);
        return;
      }

      const allFollowUps = response.data || [];
      console.log(`📋 Found ${allFollowUps.length} total scheduled follow-ups in database`);

      // Filter follow-ups that are due
      // Handle both UTC (with Z) and local time formats
      const followUps = allFollowUps.filter(fu => {
        try {
          // Parse the scheduled_at time
          const scheduledTime = new Date(fu.scheduled_at).getTime();
          const isDue = scheduledTime <= now;

          if (isDue) {
            console.log(`  ✓ ${fu.name} (ID: ${fu.id}) is due:`, {
              scheduled: fu.scheduled_at,
              scheduledTimestamp: scheduledTime,
              currentTimestamp: now,
              diff: (now - scheduledTime) / 1000 / 60, // minutes
            });
          }

          return isDue;
        } catch (error) {
          console.error(`  ✗ Error parsing date for follow-up ${fu.id}:`, error.message);
          return false;
        }
      }).slice(0, 10); // Limit to 10 at a time

      console.log(`📬 Found ${followUps.length} follow-ups ready to send`);

      if (followUps.length === 0) {
        return;
      }

      // Process each follow-up
      for (const followUp of followUps) {
        try {
          console.log(`📤 Processing follow-up: ${followUp.name} (ID: ${followUp.id})`);

          await this.processFollowUp(followUp);
        } catch (error) {
          console.error(`⚠️ Error processing follow-up ${followUp.id}:`, error);
          await this.markFollowUpFailed(followUp.id, error.message);
        }
      }

    } catch (error) {
      console.error('⚠️ Error in checkScheduledFollowUps:', error);
    }
  }

  /**
   * Process a single follow-up message
   */
  async processFollowUp(followUp) {

    this.activeProcesses++;
    this.emit('process-started', { followUpId: followUp.id, name: followUp.name });

    try {
      // Check if session is still connected
      console.log(`🔍 Follow-up ${followUp.id} - Session ID: ${followUp.session_id}, Session Status: ${followUp.session_status}, Device: ${followUp.device_name}`);
      console.log(`🔍 Follow-up ${followUp.id} - Full details:`, JSON.stringify({
        id: followUp.id,
        name: followUp.name,
        session_id: followUp.session_id,
        session_status: followUp.session_status,
        device_name: followUp.device_name,
        scheduled_at: followUp.scheduled_at,
        contact_phone: followUp.contact_phone
      }, null, 2));

      if (followUp.session_status !== 'connected') {
        console.error(`❌ Follow-up ${followUp.id} FAILED: Session ${followUp.session_id} is not connected (status: ${followUp.session_status || 'NULL'})`);
        throw new Error(`Session ${followUp.session_id} is not connected (status: ${followUp.session_status || 'NULL'})`);
      }

      // Update status to sending
      await this.databaseService.query(
        'UPDATE follow_up_messages SET status = ?, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['sending', followUp.id]
      );

      // Check if contact has replied (if send_if_replied is false)
      if (!followUp.send_if_replied) {
        const hasReplied = await this.checkIfContactReplied(followUp.contact_phone, followUp.created_at);
        if (hasReplied) {
          await this.markFollowUpSkipped(followUp.id, 'Contact has replied');
          return;
        }
      }

      // Send the message
      const result = await this.sendFollowUpMessage(followUp);

      if (result.success) {
        // Mark as sent
        await this.databaseService.query(
          'UPDATE follow_up_messages SET status = ?, sent_at = CURRENT_TIMESTAMP, message_id = ? WHERE id = ?',
          ['sent', result.messageId || null, followUp.id]
        );

        // Log to message history
        await this.databaseService.query(`
          INSERT INTO message_history (
            session_id, contact_phone, message_id, direction, message_type,
            content, timestamp, status, template_id, created_at
          ) VALUES (?, ?, ?, 'outgoing', ?, ?, CURRENT_TIMESTAMP, 'sent', ?, CURRENT_TIMESTAMP)`,
          [
            followUp.session_id,
            followUp.contact_phone,
            result.messageId || null,
            followUp.message_type || 'text',
            followUp.message_content,
            followUp.template_id || null
          ]
        );

        this.emit('followup-sent', { followUpId: followUp.id, messageId: result.messageId });

        // Handle recurring follow-ups
        if (followUp.is_recurring) {
          await this.scheduleNextRecurrence(followUp);
        }

      } else {
        throw new Error(result.error || 'Failed to send message');
      }

    } catch (error) {
      console.error(`⚠️ Error sending follow-up ${followUp.id}:`, error);
      console.error(`⚠️ Error details:`, {
        followUpId: followUp.id,
        name: followUp.name,
        errorMessage: error.message,
        errorStack: error.stack,
        currentRetryCount: followUp.retry_count || 0,
        maxRetries: followUp.max_retries
      });

      // Handle retry logic
      const newRetryCount = (followUp.retry_count || 0) + 1;

      if (newRetryCount < followUp.max_retries) {
        // Schedule retry
        const retryDelay = Math.min(newRetryCount * 5, 30); // 5, 10, 15... up to 30 minutes
        const retryTime = new Date();
        retryTime.setMinutes(retryTime.getMinutes() + retryDelay);

        console.log(`🔄 Rescheduling follow-up ${followUp.id} for retry ${newRetryCount}/${followUp.max_retries} in ${retryDelay} minutes at ${retryTime.toISOString()}`);

        await this.databaseService.query(
          'UPDATE follow_up_messages SET status = ?, retry_count = ?, scheduled_at = ?, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['scheduled', newRetryCount, retryTime.toISOString(), followUp.id]
        );

        this.emit('followup-retry-scheduled', { followUpId: followUp.id, retryCount: newRetryCount, retryTime });

      } else {
        // Mark as failed
        console.log(`❌ Follow-up ${followUp.id} exceeded max retries (${followUp.max_retries}), marking as failed`);
        await this.markFollowUpFailed(followUp.id, error.message);
      }

    } finally {
      this.activeProcesses--;
      this.emit('process-completed', { followUpId: followUp.id });
    }
  }

  /**
   * Send the actual follow-up message
   */
  async sendFollowUpMessage(followUp) {
    try {
      let messageContent = followUp.message_content;
      let messageType = followUp.message_type || 'text';

      // If using a template, process it
      if (followUp.template_id) {
        const templateResponse = await this.databaseService.query(
          'SELECT * FROM message_templates WHERE id = ?',
          [followUp.template_id]
        );

        if (templateResponse.success && templateResponse.data.length > 0) {
          const template = templateResponse.data[0];

          // Process template with variables
          const variables = JSON.parse(followUp.variables || '{}');

          // Add follow-up specific variables
          const templateVariables = {
            ...variables,
            contact_name: followUp.contact_name || followUp.contact_phone.split('@')[0],
            contact_phone: followUp.contact_phone.split('@')[0],
            followup_name: followUp.name
          };

          // Use main whatsappService.sendTemplateMessage for proper attachment handling
          return await this.whatsappService.sendTemplateMessage(
            followUp.session_id,
            followUp.contact_phone,
            template,
            templateVariables
          );
        }
      }

      // Process variables in regular message content (not template)
      if (!followUp.template_id) {
        const variables = JSON.parse(followUp.variables || '{}');
        messageContent = this.processTemplateVariables(messageContent, variables, followUp);
      }

      // Send regular message
      return await this.whatsappService.sendMessage(
        followUp.session_id,
        followUp.contact_phone,
        messageContent,
        messageType
      );

    } catch (error) {
      console.error('Error in sendFollowUpMessage:', error);
      return { success: false, error: error.message };
    }
  }



  /**
   * Process template variables including automatic contact name substitution
   */
  processTemplateVariables(content, variables, followUp = null) {
    let processedContent = content;

    // Create enhanced variables object that includes contact name
    const enhancedVariables = { ...variables };

    // Automatically add contact name if available
    if (followUp && followUp.contact_name) {
      enhancedVariables.name = followUp.contact_name;
    }

    // Replace variables in the format {{variable_name}}
    Object.keys(enhancedVariables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      processedContent = processedContent.replace(regex, enhancedVariables[key] || '');
    });

    return processedContent;
  }

  /**
   * Check if contact has replied since follow-up was created
   */
  async checkIfContactReplied(contactPhone, createdAt) {
    try {
      const response = await this.databaseService.query(`
        SELECT COUNT(*) as count FROM message_history
        WHERE contact_phone = ?
        AND direction = 'incoming'
        AND timestamp > ?
      `, [contactPhone, createdAt]);

      return response.success && response.data[0]?.count > 0;
    } catch (error) {
      console.error('Error checking if contact replied:', error);
      return false;
    }
  }

  /**
   * Mark follow-up as failed
   */
  async markFollowUpFailed(followUpId, errorMessage) {
    await this.databaseService.query(
      'UPDATE follow_up_messages SET status = ?, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['failed', followUpId]
    );

    this.emit('followup-failed', { followUpId, error: errorMessage });
  }

  /**
   * Mark follow-up as skipped
   */
  async markFollowUpSkipped(followUpId, reason) {
    await this.databaseService.query(
      'UPDATE follow_up_messages SET status = ?, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['skipped', followUpId]
    );

    this.emit('followup-skipped', { followUpId, reason });
  }

  /**
   * Schedule the next occurrence of a recurring follow-up
   */
  async scheduleNextRecurrence(followUp) {
    try {
      const recurringPattern = JSON.parse(followUp.recurring_pattern || '{}');

      if (recurringPattern.type === 'none') {
        return;
      }

      // Calculate next occurrence date
      const nextDate = this.calculateNextOccurrence(new Date(followUp.scheduled_at), recurringPattern);

      if (!nextDate) {
        return;
      }

      // Check if we've reached the maximum occurrences
      if (recurringPattern.endType === 'count') {
        const currentOccurrences = await this.countOccurrences(followUp.parent_follow_up_id || followUp.id);
        if (currentOccurrences >= recurringPattern.maxOccurrences) {
          return;
        }
      }

      // Check if we've reached the end date
      if (recurringPattern.endType === 'date' && recurringPattern.endDate) {
        const endDate = new Date(recurringPattern.endDate);
        if (nextDate > endDate) {
          return;
        }
      }

      // Create the next occurrence
      const nextFollowUpData = {
        name: `${followUp.name} (Recurring)`,
        description: followUp.description,
        session_id: followUp.session_id,
        contact_phone: followUp.contact_phone,
        contact_name: followUp.contact_name,
        message_content: followUp.message_content,
        template_id: followUp.template_id,
        attachment_data: followUp.attachment_data,
        attachment_type: followUp.attachment_type,
        message_type: followUp.message_type,
        scheduled_at: nextDate.toISOString(),
        status: 'scheduled',
        priority: followUp.priority,
        category: followUp.category,
        tags: followUp.tags,
        variables: followUp.variables,
        retry_count: 0,
        max_retries: followUp.max_retries,
        notes: followUp.notes,
        created_by: followUp.created_by,
        is_recurring: 1,
        recurring_pattern: followUp.recurring_pattern,
        parent_follow_up_id: followUp.parent_follow_up_id || followUp.id,
        send_if_replied: followUp.send_if_replied,
        auto_reschedule: followUp.auto_reschedule
      };

      const insertResult = await this.databaseService.query(`
        INSERT INTO follow_up_messages (
          name, description, session_id, contact_phone, contact_name,
          message_content, template_id, attachment_data, attachment_type,
          message_type, scheduled_at, status, priority, category, tags,
          variables, retry_count, max_retries, notes, created_by,
          is_recurring, recurring_pattern, parent_follow_up_id, send_if_replied, auto_reschedule,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        nextFollowUpData.name,
        nextFollowUpData.description,
        nextFollowUpData.session_id,
        nextFollowUpData.contact_phone,
        nextFollowUpData.contact_name,
        nextFollowUpData.message_content,
        nextFollowUpData.template_id,
        nextFollowUpData.attachment_data,
        nextFollowUpData.attachment_type,
        nextFollowUpData.message_type,
        nextFollowUpData.scheduled_at,
        nextFollowUpData.status,
        nextFollowUpData.priority,
        nextFollowUpData.category,
        nextFollowUpData.tags,
        nextFollowUpData.variables,
        nextFollowUpData.retry_count,
        nextFollowUpData.max_retries,
        nextFollowUpData.notes,
        nextFollowUpData.created_by,
        nextFollowUpData.is_recurring,
        nextFollowUpData.recurring_pattern,
        nextFollowUpData.parent_follow_up_id,
        nextFollowUpData.send_if_replied,
        nextFollowUpData.auto_reschedule
      ]);

      if (insertResult.success) {
        this.emit('recurrence-scheduled', {
          originalId: followUp.id,
          newId: insertResult.insertId,
          scheduledAt: nextDate.toISOString()
        });
      } else {
        console.error(`❌ Failed to schedule next occurrence for follow-up ${followUp.id}:`, insertResult.error);
      }

    } catch (error) {
      console.error(`❌ Error scheduling next recurrence for follow-up ${followUp.id}:`, error);
    }
  }

  /**
   * Calculate the next occurrence date based on recurring pattern
   */
  calculateNextOccurrence(currentDate, recurringPattern) {
    const nextDate = new Date(currentDate);

    switch (recurringPattern.type) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + (recurringPattern.interval || 1));
        break;

      case 'weekly':
        // Find the next occurrence based on selected days of week
        const currentDayOfWeek = nextDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const daysOfWeek = recurringPattern.daysOfWeek || [];

        if (daysOfWeek.length === 0) {
          return null; // No days selected
        }

        // Convert to Monday = 0 format (our UI uses this)
        const currentDay = currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1;

        // Find next day in the selected days
        let nextDay = null;
        for (let i = 1; i <= 7; i++) {
          const checkDay = (currentDay + i) % 7;
          if (daysOfWeek.includes(checkDay)) {
            nextDay = checkDay;
            break;
          }
        }

        if (nextDay !== null) {
          const daysToAdd = nextDay > currentDay ? nextDay - currentDay : 7 - currentDay + nextDay;
          nextDate.setDate(nextDate.getDate() + daysToAdd);
        } else {
          return null;
        }
        break;

      case 'monthly':
        const dayOfMonth = recurringPattern.dayOfMonth || nextDate.getDate();
        nextDate.setMonth(nextDate.getMonth() + (recurringPattern.interval || 1));

        // Handle cases where the day doesn't exist in the next month (e.g., Jan 31 -> Feb 31)
        const lastDayOfMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
        nextDate.setDate(Math.min(dayOfMonth, lastDayOfMonth));
        break;

      case 'custom':
        // For custom patterns, add the interval in days
        nextDate.setDate(nextDate.getDate() + (recurringPattern.interval || 1));
        break;

      default:
        return null;
    }

    return nextDate;
  }

  /**
   * Count existing occurrences for a recurring follow-up series
   */
  async countOccurrences(parentFollowUpId) {
    try {
      const result = await this.databaseService.query(
        'SELECT COUNT(*) as count FROM follow_up_messages WHERE parent_follow_up_id = ? OR id = ?',
        [parentFollowUpId, parentFollowUpId]
      );

      return result.success ? (result.data[0]?.count || 0) : 0;
    } catch (error) {
      console.error('Error counting occurrences:', error);
      return 0;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeProcesses: this.activeProcesses,
      checkInterval: this.checkInterval
    };
  }
}

module.exports = FollowUpSchedulerService;
