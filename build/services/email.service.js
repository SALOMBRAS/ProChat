const nodemailer = require('nodemailer');
const DatabaseService = require('./database.service');

class EmailService {
  constructor() {
    this.databaseService = new DatabaseService();
    this.transporter = null;
    this.currentConfig = null;
  }

  /**
   * Set database service (for dependency injection)
   */
  setDatabaseService(databaseService) {
    this.databaseService = databaseService;
  }

  // Simple logging method
  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
  }

  /**
   * Initialize email service with configuration
   */
  async initialize() {
    try {
      await this.loadEmailConfiguration();
      if (this.currentConfig && this.currentConfig.enabled) {
        await this.createTransporter();
      }
    } catch (error) {
      this.log('Failed to initialize email service: ' + error.message, 'error');
    }
  }

  /**
   * Load email configuration from database
   */
  async loadEmailConfiguration() {
    try {
      const configResult = await this.databaseService.query(
        'SELECT * FROM email_settings WHERE enabled = 1 AND is_default = 1 ORDER BY id DESC LIMIT 1'
      );

      if (configResult.success && configResult.data.length > 0) {
        this.currentConfig = configResult.data[0];
        this.log('Email configuration loaded successfully');
      } else {
        this.log('No active email configuration found', 'warn');
        this.currentConfig = null;
      }
    } catch (error) {
      this.log('Error loading email configuration: ' + error.message, 'error');
      this.currentConfig = null;
    }
  }

  /**
   * Create nodemailer transporter based on configuration
   */
  async createTransporter() {
    try {
      if (!this.currentConfig) {
        throw new Error('No email configuration available');
      }

      const config = JSON.parse(this.currentConfig.smtp_config);
      
      // Create transporter based on provider type
      let transportConfig;
      
      switch (this.currentConfig.provider) {
        case 'smtp':
          transportConfig = {
            host: config.host,
            port: parseInt(config.port) || 587,
            secure: config.secure || false,
            auth: {
              user: config.username,
              pass: config.password
            },
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 10000
          };

          // Handle TLS configuration
          if (config.disable_tls) {
            transportConfig.ignoreTLS = true;
            transportConfig.secure = false;
          } else {
            transportConfig.tls = {
              rejectUnauthorized: config.reject_unauthorized !== false,
              ciphers: 'SSLv3',
              secureProtocol: 'TLSv1_2_method'
            };
          }

          // Adjust configuration based on port
          if (parseInt(config.port) === 465) {
            transportConfig.secure = true;
          } else if (parseInt(config.port) === 587 || parseInt(config.port) === 25) {
            transportConfig.secure = false;
            if (!config.disable_tls) {
              transportConfig.requireTLS = true;
            }
          }
          break;

        case 'gmail':
          transportConfig = {
            service: 'gmail',
            auth: {
              user: config.email,
              pass: config.app_password
            }
          };
          break;



        default:
          throw new Error(`Unsupported email provider: ${this.currentConfig.provider}`);
      }

      this.transporter = nodemailer.createTransport(transportConfig);
      
      // Verify connection
      await this.transporter.verify();
      this.log(`Email transporter created successfully for provider: ${this.currentConfig.provider}`);

    } catch (error) {
      this.log('Error creating email transporter: ' + error.message, 'error');
      this.transporter = null;
      throw error;
    }
  }

  /**
   * Send email using configured transporter
   */
  async sendEmail(emailData) {
    try {
      if (!this.transporter) {
        await this.initialize();
        if (!this.transporter) {
          throw new Error('Email service not configured or unavailable');
        }
      }

      const mailOptions = {
        from: emailData.from || `${this.currentConfig.from_name} <${this.currentConfig.from_email}>`,
        to: emailData.to,
        cc: emailData.cc,
        bcc: emailData.bcc,
        subject: emailData.subject,
        text: emailData.text,
        html: emailData.html,
        attachments: emailData.attachments || []
      };

      // Send email
      const result = await this.transporter.sendMail(mailOptions);
      
      // Log email sent
      await this.logEmailSent({
        ...emailData,
        message_id: result.messageId,
        status: 'sent',
        sent_at: new Date().toISOString()
      });

      this.log(`Email sent successfully to ${emailData.to} (messageId: ${result.messageId})`);

      return {
        success: true,
        messageId: result.messageId,
        response: result.response
      };

    } catch (error) {
      this.log('Error sending email: ' + error.message, 'error');
      
      // Log failed email
      await this.logEmailSent({
        ...emailData,
        status: 'failed',
        error_message: error.message,
        sent_at: new Date().toISOString()
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Process email template with variables
   */
  async processEmailTemplate(templateId, variables = {}) {
    try {
      const templateResult = await this.databaseService.query(
        'SELECT * FROM email_templates WHERE id = ? AND is_active = 1',
        [templateId]
      );

      if (!templateResult.success || templateResult.data.length === 0) {
        throw new Error(`Email template with ID ${templateId} not found`);
      }

      const template = templateResult.data[0];
      
      // Replace variables in subject and content
      let subject = template.subject;
      let htmlContent = template.html_content;
      let textContent = template.text_content;

      // Replace variables using regex
      Object.keys(variables).forEach(key => {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
        const value = variables[key] || '';
        
        subject = subject.replace(regex, value);
        htmlContent = htmlContent.replace(regex, value);
        textContent = textContent.replace(regex, value);
      });

      return {
        subject,
        html: htmlContent,
        text: textContent,
        template_name: template.name
      };

    } catch (error) {
      this.log('Error processing email template: ' + error.message, 'error');
      throw error;
    }
  }

  /**
   * Log email sending activity
   */
  async logEmailSent(emailData) {
    try {
      await this.databaseService.query(
        `INSERT INTO email_logs (
          to_email, cc_email, bcc_email, subject, message_id, 
          status, error_message, template_id, conversation_id, 
          sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          emailData.to,
          emailData.cc || null,
          emailData.bcc || null,
          emailData.subject,
          emailData.message_id || null,
          emailData.status,
          emailData.error_message || null,
          emailData.template_id || null,
          emailData.conversation_id || null,
          emailData.sent_at
        ]
      );
    } catch (error) {
      this.log('Error logging email activity: ' + error.message, 'error');
    }
  }

  /**
   * Test email configuration
   */
  async testEmailConfiguration(config) {
    try {
      this.log(`Testing email configuration for provider: ${config.provider}`, 'info');

      // Create temporary transporter for testing
      let testTransporter;

      switch (config.provider) {
        case 'smtp':
          // Enhanced SMTP configuration with better TLS handling
          const smtpConfig = {
            host: config.host,
            port: parseInt(config.port) || 587,
            secure: config.secure || false, // true for 465, false for other ports
            auth: {
              user: config.username,
              pass: config.password
            },
            // Add connection timeout
            connectionTimeout: 10000, // 10 seconds
            greetingTimeout: 5000, // 5 seconds
            socketTimeout: 10000, // 10 seconds
            // Enable debug for troubleshooting
            debug: true,
            logger: true
          };

          // Handle TLS configuration
          if (config.disable_tls) {
            // Completely disable TLS for troubleshooting
            smtpConfig.ignoreTLS = true;
            smtpConfig.secure = false;
          } else {
            smtpConfig.tls = {
              // Don't fail on invalid certs for testing
              rejectUnauthorized: config.reject_unauthorized !== false,
              // Add more TLS options for better compatibility
              ciphers: 'SSLv3',
              secureProtocol: 'TLSv1_2_method'
            };
          }

          // Adjust configuration based on port
          if (parseInt(config.port) === 465) {
            smtpConfig.secure = true; // Use SSL for port 465
          } else if (parseInt(config.port) === 587 || parseInt(config.port) === 25) {
            smtpConfig.secure = false; // Use STARTTLS for ports 587/25
            smtpConfig.requireTLS = true; // Force STARTTLS
          }

          this.log(`SMTP Config: ${JSON.stringify(smtpConfig, null, 2)}`, 'debug');
          testTransporter = nodemailer.createTransport(smtpConfig);
          break;

        case 'gmail':
          testTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: config.email,
              pass: config.app_password
            },
            // Add timeout for Gmail as well
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 10000
          });
          break;

        default:
          throw new Error(`Testing not implemented for provider: ${config.provider}`);
      }

      this.log('Attempting to verify SMTP connection...', 'info');

      // Verify connection with timeout
      const verifyPromise = testTransporter.verify();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout after 15 seconds')), 15000);
      });

      await Promise.race([verifyPromise, timeoutPromise]);

      this.log('Email configuration test successful', 'info');
      return { success: true, message: 'Email configuration test successful' };

    } catch (error) {
      this.log('Email configuration test failed: ' + error.message, 'error');

      // Provide more specific error messages
      let errorMessage = error.message;
      if (error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Connection refused. Please check the SMTP host and port.';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = 'SMTP host not found. Please check the hostname.';
      } else if (error.message.includes('ETIMEDOUT')) {
        errorMessage = 'Connection timeout. Please check your network connection and SMTP settings.';
      } else if (error.message.includes('TLS')) {
        errorMessage = 'TLS/SSL connection failed. Try disabling SSL/TLS or check your security settings.';
      } else if (error.message.includes('authentication')) {
        errorMessage = 'Authentication failed. Please check your username and password.';
      }

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get email statistics
   */
  async getEmailStats(days = 30) {
    try {
      const result = await this.databaseService.query(
        `SELECT 
          COUNT(*) as total_emails,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_emails,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_emails,
          DATE(sent_at) as date
        FROM email_logs 
        WHERE sent_at >= datetime('now', '-${days} days')
        GROUP BY DATE(sent_at)
        ORDER BY date DESC`
      );

      return result.success ? result.data : [];
    } catch (error) {
      this.log('Error getting email stats: ' + error.message, 'error');
      return [];
    }
  }
}

module.exports = EmailService;
