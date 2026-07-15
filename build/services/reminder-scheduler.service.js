const pino = require('pino');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

class ReminderScheduler {
  constructor(databaseService, whatsappService) {
    this.logger = pino({ name: 'ReminderScheduler' });
    this.databaseService = databaseService;
    this.whatsappService = whatsappService;
    this.scheduledJobs = new Map(); // Map of reminder IDs to scheduled jobs
    this.isInitialized = false;
  }

  /**
   * Initialize the reminder scheduler
   */
  async initialize() {
    try {
      this.logger.info('⏰ Initializing Reminder Scheduler...');
      
      // Load and schedule all active reminders
      await this.loadActiveReminders();
      
      // Set up cleanup job for completed reminders
      this.setupCleanupJob();
      
      this.isInitialized = true;
      this.logger.info('✅ Reminder Scheduler initialized successfully');
      
      return { success: true };
    } catch (error) {
      this.logger.error('❌ Failed to initialize Reminder Scheduler:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Schedule a reminder
   */
  async scheduleReminder(reminderId, scheduledTime) {
    try {
      // Cancel existing job if it exists
      if (this.scheduledJobs.has(reminderId)) {
        this.scheduledJobs.get(reminderId).cancel();
        this.scheduledJobs.delete(reminderId);
      }

      // Schedule the new job
      const job = schedule.scheduleJob(scheduledTime, async () => {
        await this.executeReminder(reminderId);
      });

      if (job) {
        this.scheduledJobs.set(reminderId, job);
        this.logger.info(`📅 Scheduled reminder ${reminderId} for ${moment(scheduledTime).format()}`);
        return { success: true };
      } else {
        throw new Error('Failed to schedule job');
      }

    } catch (error) {
      this.logger.error(`Error scheduling reminder ${reminderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel a scheduled reminder
   */
  async cancelReminder(reminderId) {
    try {
      if (this.scheduledJobs.has(reminderId)) {
        this.scheduledJobs.get(reminderId).cancel();
        this.scheduledJobs.delete(reminderId);
        this.logger.info(`❌ Cancelled scheduled reminder ${reminderId}`);
      }

      // Update reminder status in database
      await this.databaseService.run(
        'UPDATE reminders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['cancelled', reminderId]
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`Error cancelling reminder ${reminderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a reminder (send the reminder message)
   */
  async executeReminder(reminderId) {
    try {
      this.logger.info(`🔔 Executing reminder ${reminderId}`);

      // Get reminder details from database
      const reminder = await this.databaseService.get(
        'SELECT * FROM reminders WHERE id = ? AND status = ?',
        [reminderId, 'active']
      );


      if (!reminder) {
        this.logger.warn(`Reminder ${reminderId} not found or not active`);
        return;
      }

      const reminderData = reminder;

      // Prepare reminder message
      const reminderMessage = this.formatReminderMessage(reminderData);

      // Send the reminder message
      const sendResult = await this.whatsappService.sendMessage(
        reminderData.session_id,
        reminderData.user_jid,
        reminderMessage,
        'text'
      );

      if (sendResult.success) {
        // Mark reminder as sent
        await this.databaseService.run(`
          UPDATE reminders 
          SET reminder_sent = 1, reminder_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [reminderId]);

        // Log the activity
        await this.logReminderActivity(reminderData.session_id, reminderData.user_jid, reminderId, 
          'reminder_sent', `Reminder sent: "${reminderData.reminder_text}"`);

        // Handle recurrence
        if (reminderData.recurrence_type) {
          await this.handleRecurrence(reminderData);
        } else {
          // Mark as completed if not recurring
          await this.databaseService.run(
            'UPDATE reminders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['completed', reminderId]
          );
        }

        this.logger.info(`✅ Reminder ${reminderId} executed successfully`);
      } else {
        // Mark as failed
        await this.databaseService.run(
          'UPDATE reminders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['failed', reminderId]
        );

        await this.logReminderActivity(reminderData.session_id, reminderData.user_jid, reminderId, 
          'reminder_failed', `Failed to send reminder: ${sendResult.error}`);

        this.logger.error(`❌ Failed to send reminder ${reminderId}:`, sendResult.error);
      }

      // Remove from scheduled jobs
      this.scheduledJobs.delete(reminderId);

    } catch (error) {
      this.logger.error(`Error executing reminder ${reminderId}:`, error);
      
      // Mark as failed
      try {
        await this.databaseService.run(
          'UPDATE reminders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['failed', reminderId]
        );
      } catch (dbError) {
        this.logger.error('Error updating failed reminder status:', dbError);
      }
    }
  }

  /**
   * Format reminder message for sending
   */
  formatReminderMessage(reminderData) {
    const scheduledTime = moment(reminderData.scheduled_time).tz(reminderData.timezone);

    // Casual reminder message options
    const casualReminders = [
      `🔔 *Hey there!* Time for your reminder!\n\n💡 Don't forget to ${reminderData.reminder_text}\n\n⏰ You asked me to remind you at ${scheduledTime.format('h:mm A')} and here I am! 😊`,
      `⏰ *Ding ding!* Reminder time!\n\n📝 Time to ${reminderData.reminder_text}\n\n🎯 Just like you asked - right on time at ${scheduledTime.format('h:mm A')}! Hope I'm not interrupting anything important! 😄`,
      `🔔 *Knock knock!* Your reminder is here!\n\n✨ Time to ${reminderData.reminder_text}\n\n⏰ Scheduled for ${scheduledTime.format('h:mm A')} and delivered fresh! 🚀`,
      `🎵 *Reminder alert!* 🎵\n\n📋 Don't forget to ${reminderData.reminder_text}\n\n⏰ You set this for ${scheduledTime.format('h:mm A')} and I never forget! That's what I'm here for! 💪`,
      `🔔 *Beep beep!* Your personal reminder assistant reporting for duty!\n\n📝 Time to ${reminderData.reminder_text}\n\n⏰ Right on schedule at ${scheduledTime.format('h:mm A')}! Hope this helps! 🤝`
    ];

    let message = casualReminders[Math.floor(Math.random() * casualReminders.length)];

    if (reminderData.recurrence_type) {
      message += `\n\n🔄 P.S. This reminder repeats ${reminderData.recurrence_type}, so I'll be back! 📅`;
    }

    message += `\n\n_Your friendly Recall Bot 🤖_`;

    return message;
  }

  /**
   * Handle recurring reminders
   */
  async handleRecurrence(reminderData) {
    try {
      const currentTime = moment(reminderData.scheduled_time).tz(reminderData.timezone);
      let nextTime;

      // Calculate next occurrence based on recurrence type
      switch (reminderData.recurrence_type) {
        case 'daily':
          nextTime = currentTime.add(reminderData.recurrence_interval || 1, 'days');
          break;
        case 'weekly':
          nextTime = currentTime.add(reminderData.recurrence_interval || 1, 'weeks');
          break;
        case 'monthly':
          nextTime = currentTime.add(reminderData.recurrence_interval || 1, 'months');
          break;
        case 'yearly':
          nextTime = currentTime.add(reminderData.recurrence_interval || 1, 'years');
          break;
        default:
          this.logger.warn(`Unknown recurrence type: ${reminderData.recurrence_type}`);
          return;
      }

      // Check if we've reached the end date
      if (reminderData.recurrence_end_date && nextTime.isAfter(moment(reminderData.recurrence_end_date))) {
        await this.databaseService.run(
          'UPDATE reminders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['completed', reminderData.id]
        );
        this.logger.info(`Recurring reminder ${reminderData.id} completed (reached end date)`);
        return;
      }

      // Update the reminder with the next scheduled time
      await this.databaseService.run(`
        UPDATE reminders 
        SET scheduled_time = ?, reminder_sent = 0, reminder_sent_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [nextTime.toISOString(), reminderData.id]);

      // Schedule the next occurrence
      await this.scheduleReminder(reminderData.id, nextTime.toDate());

      this.logger.info(`🔄 Scheduled next occurrence of reminder ${reminderData.id} for ${nextTime.format()}`);

    } catch (error) {
      this.logger.error(`Error handling recurrence for reminder ${reminderData.id}:`, error);
    }
  }

  /**
   * Load and schedule all active reminders
   */
  async loadActiveReminders() {
    try {
      const reminders = await this.databaseService.all(`
        SELECT * FROM reminders 
        WHERE status = 'active' AND scheduled_time > datetime('now')
      `);

      let scheduledCount = 0;
      for (const reminder of reminders) {
        const scheduledTime = moment(reminder.scheduled_time).toDate();
        const result = await this.scheduleReminder(reminder.id, scheduledTime);
        if (result.success) {
          scheduledCount++;
        }
      }

      this.logger.info(`📅 Loaded and scheduled ${scheduledCount} active reminders`);
    } catch (error) {
      this.logger.error('Error loading active reminders:', error);
    }
  }

  /**
   * Set up cleanup job for old completed reminders
   */
  setupCleanupJob() {
    // Run cleanup every day at 2 AM
    schedule.scheduleJob('0 2 * * *', async () => {
      await this.cleanupOldReminders();
    });
  }

  /**
   * Clean up old completed reminders
   */
  async cleanupOldReminders() {
    try {
      // Delete completed reminders older than 30 days
      const result = await this.databaseService.run(`
        DELETE FROM reminders 
        WHERE status IN ('completed', 'failed') 
        AND updated_at < datetime('now', '-30 days')
      `);

      this.logger.info(`🗑️ Cleaned up ${result.changes} old reminders`);
    } catch (error) {
      this.logger.error('Error cleaning up old reminders:', error);
    }
  }

  /**
   * Get reminder statistics
   */
  async getReminderStats(sessionId) {
    try {
      const stats = await this.databaseService.get(`
        SELECT 
          COUNT(*) as total_reminders,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_reminders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_reminders,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_reminders,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_reminders,
          COUNT(CASE WHEN reminder_sent = 1 THEN 1 END) as sent_reminders
        FROM reminders 
        WHERE session_id = ?
      `, [sessionId]);

      return stats?.data || stats || {
        total_reminders: 0,
        active_reminders: 0,
        completed_reminders: 0,
        cancelled_reminders: 0,
        failed_reminders: 0,
        sent_reminders: 0
      };
    } catch (error) {
      this.logger.error('Error getting reminder stats:', error);
      return null;
    }
  }

  /**
   * Log reminder activity
   */
  async logReminderActivity(sessionId, userJid, reminderId, actionType, message, metadata = null) {
    try {
      await this.databaseService.run(`
        INSERT INTO recall_bot_logs (session_id, user_jid, reminder_id, action_type, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sessionId, userJid, reminderId, actionType, message, metadata ? JSON.stringify(metadata) : null]);
    } catch (error) {
      this.logger.error('Error logging reminder activity:', error);
    }
  }

  /**
   * Get scheduled jobs count
   */
  getScheduledJobsCount() {
    return this.scheduledJobs.size;
  }

  /**
   * Cancel all scheduled jobs (for shutdown)
   */
  cancelAllJobs() {
    for (const [reminderId, job] of this.scheduledJobs) {
      job.cancel();
      this.logger.info(`Cancelled job for reminder ${reminderId}`);
    }
    this.scheduledJobs.clear();
  }
}

module.exports = ReminderScheduler;
