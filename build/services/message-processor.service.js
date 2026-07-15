const pino = require('pino');

/**
 * Message Processing Service
 * Handles message processing, template rendering, and content formatting
 */
class MessageProcessorService {
  constructor(databaseService) {
    this.databaseService = databaseService;
    this.logger = pino({ level: 'info' });
  }

  /**
   * Process and render a template with variables
   */
  async processTemplate(templateId, variables = {}, conversationData = {}, sessionId = null, userJid = null) {
    try {
      const templateResult = await this.databaseService.get(
        'SELECT * FROM message_templates WHERE id = ?',
        [templateId]
      );

      if (!templateResult) {
        throw new Error(`Template with ID ${templateId} not found`);
      }

      // Handle both direct result and wrapped result
      const template = templateResult.data || templateResult;

      if (!template) {
        throw new Error(`Template data with ID ${templateId} not found`);
      }

      let content = template.content;

      // Replace variables in template using enhanced variable replacement
      content = await this.replaceVariables(content, variables, conversationData, sessionId, userJid);

      // Replace common variables
      const now = new Date();
      content = content.replace(/{{date}}/g, now.toLocaleDateString());
      content = content.replace(/{{time}}/g, now.toLocaleTimeString());
      content = content.replace(/{{datetime}}/g, now.toLocaleString());

      // Build metadata based on template type
      const metadata = {};
      const templateType = template.type || 'text';

      // Handle different template types
      switch (templateType) {
        case 'image':
        case 'video':
        case 'audio':
        case 'document':
          if (template.attachments) {
            const attachments = JSON.parse(template.attachments);
            if (attachments.length > 0) {
              // For media templates, include the attachment data in metadata
              // This will be used by formatMessageContent to create proper media message
              metadata.attachments = attachments;
              this.logger.info(`Processing ${templateType} template with attachment`);
            }
          }
          if (template.media_settings) {
            Object.assign(metadata, JSON.parse(template.media_settings));
          }
          break;

        case 'poll':
          if (template.poll_options) {
            metadata.pollOptions = JSON.parse(template.poll_options);
            metadata.name = template.poll_question || template.content; // Use poll_question if available, fallback to content
          }
          break;

        case 'contact':
          if (template.contact_info) {
            metadata.contactInfo = JSON.parse(template.contact_info);
          }
          break;

        case 'location':
          if (template.location_info) {
            metadata.locationInfo = JSON.parse(template.location_info);
          }
          break;

        case 'buttons':
        case 'interactive':
          if (template.buttons) {
            const buttons = JSON.parse(template.buttons);
            metadata.buttons = buttons;

            // Don't modify content here - let formatMessageContent handle it
            // Just store the buttons in metadata for later use
          }
          if (template.interactive_settings) {
            Object.assign(metadata, JSON.parse(template.interactive_settings));
          }
          break;

        case 'list':
          if (template.list_sections) {
            metadata.sections = JSON.parse(template.list_sections);
          }
          break;



        case 'cta_button':
          if (template.cta_data) {
            metadata.ctaData = JSON.parse(template.cta_data);
          }
          break;

        case 'mixed_buttons':
          if (template.mixed_buttons_data) {
            const mixedButtonsData = JSON.parse(template.mixed_buttons_data);
            metadata.body = mixedButtonsData.body || { text: content };
            metadata.footer = mixedButtonsData.footer;
            metadata.buttons = mixedButtonsData.buttons || [];
          }
          break;
      }

      return {
        success: true,
        content,
        type: templateType,
        metadata
      };
    } catch (error) {
      this.logger.error('Error processing template:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format message content for different types
   */
  formatMessageContent(content, type = 'text', options = {}) {
    try {
      // Message processor formatting content

      // Validate and sanitize content to prevent [object Object] issues
      let sanitizedContent = content;

      if (typeof content === 'object' && content !== null) {
        if (content.text) {
          sanitizedContent = content.text;
        } else if (content.content) {
          sanitizedContent = content.content;
        } else if (content.body && content.body.text) {
          sanitizedContent = content.body.text;
        } else if (content.message) {
          sanitizedContent = content.message;
        } else {
          this.logger.warn('Message content is an object without text/content/body/message property:', content);
          // Try to extract meaningful text from the object
          const keys = Object.keys(content);
          const textKey = keys.find(key =>
            typeof content[key] === 'string' &&
            content[key].trim() !== '' &&
            !key.includes('id') &&
            !key.includes('url')
          );
          if (textKey) {
            sanitizedContent = content[textKey];
            this.logger.info(`Extracted text from object key "${textKey}": "${sanitizedContent}"`);
          } else {
            this.logger.warn('No suitable text property found in object, using JSON string');
            sanitizedContent = JSON.stringify(content);
          }
        }
      } else if (typeof content !== 'string') {
        this.logger.warn('Message content is not a string, converting:', content);
        sanitizedContent = String(content);
      }

      // Final validation
      if (!sanitizedContent || sanitizedContent.trim() === '' || sanitizedContent === '[object Object]') {
        this.logger.error('Invalid message content detected, using fallback. Original content:', content);
        sanitizedContent = 'Sorry, I encountered an error processing your message.';
      }

      switch (type) {
        case 'text':
          return { text: sanitizedContent };

        case 'image':
          // Check if we have attachment data in options
          if (options.attachments && options.attachments.length > 0) {
            const attachment = options.attachments[0];
            let imageData;

            if (typeof attachment === 'object') {
              if (attachment.data && attachment.data.startsWith('data:')) {
                // Handle base64 data URL - convert to buffer
                const base64Data = attachment.data.split(',')[1];
                imageData = Buffer.from(base64Data, 'base64');
              } else if (attachment.url) {
                // Handle URL
                imageData = { url: attachment.url };
              } else if (attachment.data) {
                // Handle direct data (could be URL or base64)
                if (attachment.data.startsWith('http')) {
                  imageData = { url: attachment.data };
                } else {
                  imageData = { url: attachment.data };
                }
              }
            } else if (typeof attachment === 'string') {
              // Handle string attachment
              if (attachment.startsWith('data:')) {
                const base64Data = attachment.split(',')[1];
                imageData = Buffer.from(base64Data, 'base64');
              } else {
                imageData = { url: attachment };
              }
            }

            return {
              image: imageData,
              caption: options.caption || sanitizedContent,
              ...(options.viewOnce && { viewOnce: true })
            };
          } else {
            // Fallback to content as URL
            return {
              image: { url: sanitizedContent },
              caption: options.caption || sanitizedContent,
              ...(options.viewOnce && { viewOnce: true })
            };
          }

        case 'document':
          // Check if we have attachment data in options
          if (options.attachments && options.attachments.length > 0) {
            const attachment = options.attachments[0];
            let documentData;

            if (typeof attachment === 'object') {
              if (attachment.data && attachment.data.startsWith('data:')) {
                // Handle base64 data URL - convert to buffer
                const base64Data = attachment.data.split(',')[1];
                documentData = Buffer.from(base64Data, 'base64');
              } else if (attachment.url) {
                // Handle URL
                documentData = { url: attachment.url };
              } else if (attachment.data) {
                // Handle direct data (could be URL or base64)
                if (attachment.data.startsWith('http')) {
                  documentData = { url: attachment.data };
                } else {
                  documentData = { url: attachment.data };
                }
              }
            } else if (typeof attachment === 'string') {
              // Handle string attachment
              if (attachment.startsWith('data:')) {
                const base64Data = attachment.split(',')[1];
                documentData = Buffer.from(base64Data, 'base64');
              } else {
                documentData = { url: attachment };
              }
            }

            return {
              document: documentData,
              fileName: options.fileName || (typeof attachment === 'object' ? attachment.name : null) || 'document.pdf',
              caption: sanitizedContent || options.caption || '',
              ...(options.viewOnce && { viewOnce: true })
            };
          } else {
            // Fallback to content as URL
            return {
              document: { url: content },
              fileName: options.fileName || 'document.pdf',
              caption: sanitizedContent || options.caption || '',
              ...(options.viewOnce && { viewOnce: true })
            };
          }

        case 'video':
          // Check if we have attachment data in options
          if (options.attachments && options.attachments.length > 0) {
            const attachment = options.attachments[0];
            let videoData;

            if (typeof attachment === 'object') {
              if (attachment.data && attachment.data.startsWith('data:')) {
                // Handle base64 data URL - convert to buffer
                const base64Data = attachment.data.split(',')[1];
                videoData = Buffer.from(base64Data, 'base64');
              } else if (attachment.url) {
                // Handle URL
                videoData = { url: attachment.url };
              } else if (attachment.data) {
                // Handle direct data (could be URL or base64)
                if (attachment.data.startsWith('http')) {
                  videoData = { url: attachment.data };
                } else {
                  videoData = { url: attachment.data };
                }
              }
            } else if (typeof attachment === 'string') {
              // Handle string attachment
              if (attachment.startsWith('data:')) {
                const base64Data = attachment.split(',')[1];
                videoData = Buffer.from(base64Data, 'base64');
              } else {
                videoData = { url: attachment };
              }
            }

            // Use sanitized content as caption, with options.caption as fallback only if content is empty
            const captionText = sanitizedContent || options.caption || '';

            return {
              video: videoData,
              caption: captionText,
              ...(options.viewOnce && { viewOnce: true })
            };
          } else {
            // Fallback to content as URL
            const captionText = sanitizedContent || options.caption || '';
            return {
              video: { url: content },
              caption: captionText,
              ...(options.viewOnce && { viewOnce: true })
            };
          }

        case 'audio':
          // Check if we have attachment data in options
          if (options.attachments && options.attachments.length > 0) {
            const attachment = options.attachments[0];
            let audioData;

            if (typeof attachment === 'object') {
              if (attachment.data && attachment.data.startsWith('data:')) {
                // Handle base64 data URL - convert to buffer
                const base64Data = attachment.data.split(',')[1];
                audioData = Buffer.from(base64Data, 'base64');
              } else if (attachment.url) {
                // Handle URL
                audioData = { url: attachment.url };
              } else if (attachment.data) {
                // Handle direct data (could be URL or base64)
                if (attachment.data.startsWith('http')) {
                  audioData = { url: attachment.data };
                } else {
                  audioData = { url: attachment.data };
                }
              }
            } else if (typeof attachment === 'string') {
              // Handle string attachment
              if (attachment.startsWith('data:')) {
                const base64Data = attachment.split(',')[1];
                audioData = Buffer.from(base64Data, 'base64');
              } else {
                audioData = { url: attachment };
              }
            }

            return {
              audio: audioData,
              mimetype: options.mimetype || (typeof attachment === 'object' ? attachment.type : null) || 'audio/mp4'
            };
          } else {
            // Fallback to content as URL
            return {
              audio: { url: content },
              mimetype: options.mimetype || 'audio/mp4'
            };
          }

        case 'location':
          if (options.locationInfo) {
            return {
              location: {
                degreesLatitude: parseFloat(options.locationInfo.latitude),
                degreesLongitude: parseFloat(options.locationInfo.longitude)
              }
            };
          } else {
            const coords = content.split(',');
            return {
              location: {
                degreesLatitude: parseFloat(coords[0]),
                degreesLongitude: parseFloat(coords[1])
              }
            };
          }

        case 'contact':
          if (options.contactInfo) {
            // Use existing vcard if available, otherwise generate one
            let vcard = options.contactInfo.vcard;

            if (!vcard) {
              // Generate vCard from contact info
              const contactName = options.contactInfo.name || options.contactInfo.displayName || 'Contact';
              const contactPhone = options.contactInfo.phone || '';
              const contactEmail = options.contactInfo.email || '';
              const contactOrg = options.contactInfo.organization || '';

              vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contactName}
N:${contactName.split(' ').reverse().join(';')}
${contactPhone ? `TEL;TYPE=CELL:${contactPhone}` : ''}
${contactEmail ? `EMAIL:${contactEmail}` : ''}
${contactOrg ? `ORG:${contactOrg}` : ''}
END:VCARD`.replace(/\n\n/g, '\n').trim();
            }

            return {
              contacts: {
                displayName: options.contactInfo.name || options.contactInfo.displayName || 'Contact',
                contacts: [{ vcard: vcard }]
              }
            };
          } else {
            return {
              contacts: {
                displayName: options.displayName || 'Contact',
                contacts: [{ vcard: content }]
              }
            };
          }

        case 'poll':
          if (options.pollOptions) {
            return {
              poll: {
                name: options.name || content,
                values: options.pollOptions.map(option =>
                  typeof option === 'string' ? option : option.text
                ),
                selectableCount: options.selectableCount || 1
              }
            };
          } else {
            const pollData = JSON.parse(content);
            return {
              poll: {
                name: pollData.name,
                values: pollData.options,
                selectableCount: pollData.selectableCount || 1
              }
            };
          }

        case 'buttons':
        case 'interactive':
          if (options.buttons) {
            // Use Itsukichann/Baileys regular buttons format
            return {
              text: content,
              footer: options.footer || 'Choose an option:',
              buttons: options.buttons.map((btn, index) => ({
                buttonId: btn.id || `btn_${index}`,
                buttonText: {
                  displayText: btn.text || btn
                }
              }))
            };
          } else {
            // Check if content is already an object (from processTemplate)
            let buttonData;
            try {
              buttonData = typeof content === 'object' ? content : JSON.parse(content);
            } catch (e) {
              // If parsing fails, treat as text message
              return { text: content };
            }
            return {
              text: buttonData.text,
              footer: buttonData.footer || 'Choose an option:',
              buttons: buttonData.buttons.map((btn, index) => ({
                buttonId: `btn_${index}`,
                buttonText: {
                  displayText: btn
                }
              }))
            };
          }

        case 'list':
          if (options.sections) {
            // Use Itsukichann/Baileys list format
            return {
              text: content,
              footer: options.footer || 'Select an option:',
              title: options.title || '',
              buttonText: options.buttonText || 'Select Option',
              sections: options.sections
            };
          } else {
            const listData = JSON.parse(content);
            return {
              text: listData.text,
              footer: listData.footer || 'Select an option:',
              title: listData.title || '',
              buttonText: listData.buttonText || 'Select Option',
              sections: listData.sections
            };
          }



        case 'cta_button':
          if (options.ctaData) {
            return {
              body: { text: content },
              footer: options.ctaData.footer && options.ctaData.footer.text ? { text: options.ctaData.footer.text } : undefined,
              button: {
                text: options.ctaData.button.text,
                url: options.ctaData.button.url
              }
            };
          } else {
            const ctaData = JSON.parse(content);
            return {
              body: { text: ctaData.body?.text || ctaData.text || content },
              footer: ctaData.footer && ctaData.footer.text ? { text: ctaData.footer.text } : undefined,
              button: {
                text: ctaData.button.text,
                url: ctaData.button.url
              }
            };
          }

        case 'mixed_buttons':
          // Handle both direct options and metadata structure
          const buttonsData = options.buttons || metadata.buttons || [];
          const bodyData = options.body || metadata.body || { text: content };
          const footerData = options.footer || metadata.footer;

          if (buttonsData.length > 0) {
            // Use the SAME format as Single Message and Templates modules - don't transform buttons
            return {
              body: bodyData,
              footer: footerData && footerData.text ? footerData : undefined,
              buttons: buttonsData  // Keep original button format, don't transform
            };
          } else {
            // Fallback to text message if no buttons data available
            return { text: content };
          }

        default:
          return { text: content };
      }
    } catch (error) {
      this.logger.error('Error formatting message content:', error);
      return { text: content }; // Fallback to text
    }
  }

  /**
   * Extract phone number from WhatsApp JID
   */
  extractPhoneNumber(jid) {
    return jid.split('@')[0];
  }

  /**
   * Format phone number for WhatsApp
   */
  formatWhatsAppNumber(phoneNumber) {
    if (phoneNumber.includes('@')) {
      return phoneNumber;
    }
    return `${phoneNumber}@s.whatsapp.net`;
  }

  /**
   * Check if message matches keyword criteria
   * Note: Case sensitivity should be handled by the caller
   * Supports multi-line keywords with line breaks
   */
  matchesKeyword(messageText, keyword, matchType = 'contains') {
    const text = messageText.trim();
    const key = keyword.trim();

    // Normalize line breaks for consistent matching
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normalizedKey = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    switch (matchType) {
      case 'exact':
        return normalizedText === normalizedKey;
      case 'starts_with':
        return normalizedText.startsWith(normalizedKey);
      case 'ends_with':
        return normalizedText.endsWith(normalizedKey);
      case 'contains':
      default:
        return normalizedText.includes(normalizedKey);
    }
  }

  /**
   * Parse message content and extract relevant information
   */
  parseIncomingMessage(message) {
    try {
      const parsed = {
        id: message.key?.id,
        from: message.key?.remoteJid,
        fromMe: message.key?.fromMe || false,
        timestamp: message.messageTimestamp,
        type: 'text',
        text: '',
        media: null,
        quoted: message.message?.extendedTextMessage?.contextInfo?.quotedMessage || null
      };

      // Extract text content
      // Handle ephemeral (disappearing) messages first
      if (message.message?.ephemeralMessage?.message) {
        const ephemeralMsg = message.message.ephemeralMessage.message;
        if (ephemeralMsg.conversation) {
          parsed.text = ephemeralMsg.conversation;
        } else if (ephemeralMsg.extendedTextMessage?.text) {
          parsed.text = ephemeralMsg.extendedTextMessage.text;
        } else if (ephemeralMsg.imageMessage?.caption) {
          parsed.type = 'image';
          parsed.text = ephemeralMsg.imageMessage.caption;
          parsed.media = ephemeralMsg.imageMessage;
        } else if (ephemeralMsg.videoMessage?.caption) {
          parsed.type = 'video';
          parsed.text = ephemeralMsg.videoMessage.caption;
          parsed.media = ephemeralMsg.videoMessage;
        }
      } else if (message.message?.conversation) {
        parsed.text = message.message.conversation;
      } else if (message.message?.extendedTextMessage?.text) {
        parsed.text = message.message.extendedTextMessage.text;
      } else if (message.message?.interactiveResponseMessage?.nativeFlowResponseMessage) {
        // Handle interactive list/flow responses (newer format)
        const nativeFlow = message.message.interactiveResponseMessage.nativeFlowResponseMessage;
        if (nativeFlow.paramsJson) {
          try {
            const params = JSON.parse(nativeFlow.paramsJson);
            // For list responses, prioritize display text over ID for better chatbot triggering
            parsed.text = params.title || params.display_text || params.id || 'Unknown selection';
            parsed.type = 'interactive_list_response';
            this.logger.info(`📱 Parsed interactive list response - params: ${JSON.stringify(params)}, final text: "${parsed.text}"`);
          } catch (error) {
            this.logger.error(`Error parsing interactive response params:`, error);
            parsed.text = 'Unknown selection';
            parsed.type = 'interactive_list_response';
          }
        } else {
          parsed.text = 'Unknown selection';
          parsed.type = 'interactive_list_response';
        }
      } else if (message.message?.interactiveResponseMessage?.body?.text) {
        // Handle interactive button responses
        parsed.text = message.message.interactiveResponseMessage.body.text;
        parsed.type = 'interactive_response';
        this.logger.info(`📱 Parsed interactive button response: "${parsed.text}"`);
      } else if (message.message?.buttonsResponseMessage?.selectedButtonId) {
        // Handle legacy button responses (fallback)
        const buttonId = message.message.buttonsResponseMessage.selectedButtonId;
        const displayText = message.message.buttonsResponseMessage.selectedDisplayText;
        parsed.text = displayText || buttonId;
        parsed.type = 'button_response';
        this.logger.info(`📱 Parsed legacy button response: "${parsed.text}"`);
      } else if (message.message?.listResponseMessage) {
        // Handle list responses (check for listResponseMessage existence, not just selectedRowId)
        const rowId = message.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
        const title = message.message.listResponseMessage.title;
        const description = message.message.listResponseMessage.description;

        // Get the original text - prioritize description over title for better matching
        let originalText = description || title || rowId;

        // For chatbot triggering, use only the description (last line) to match keywords
        // This matches the fix applied to whatsapp.service.js formatMessage function
        let triggerText = description || title || rowId;

        this.logger.info(`📱 List response - rowId: "${rowId}", title: "${title}", description: "${description}", using: "${triggerText}"`);

        // Legacy handling for multi-line titles (keeping for backward compatibility)
        if (triggerText && (triggerText.includes('\n') || triggerText.includes('\\n'))) {
          // Handle both actual newlines and escaped newlines
          const normalizedText = triggerText.replace(/\\n/g, '\n');
          const lines = normalizedText.split('\n').map(line => line.trim()).filter(line => line);
          if (lines.length > 0) {
            triggerText = lines[lines.length - 1]; // Use the last line
            this.logger.info(`📱 List response - extracted last line: "${originalText}" → "${triggerText}"`);
          }
        }

        parsed.text = triggerText;
        parsed.type = 'list_response';
      } else if (message.message?.templateButtonReplyMessage?.selectedDisplayText) {
        // Handle template button responses
        parsed.text = message.message.templateButtonReplyMessage.selectedDisplayText;
        parsed.type = 'template_button_response';
        this.logger.info(`📱 Parsed template button response: "${parsed.text}"`);
      } else if (message.message?.imageMessage?.caption) {
        parsed.type = 'image';
        parsed.text = message.message.imageMessage.caption;
        parsed.media = message.message.imageMessage;
      } else if (message.message?.videoMessage?.caption) {
        parsed.type = 'video';
        parsed.text = message.message.videoMessage.caption;
        parsed.media = message.message.videoMessage;
      } else if (message.message?.documentMessage?.caption) {
        parsed.type = 'document';
        parsed.text = message.message.documentMessage.caption;
        parsed.media = message.message.documentMessage;
      } else if (message.message?.audioMessage) {
        parsed.type = 'audio';
        parsed.media = message.message.audioMessage;
      } else if (message.message?.locationMessage) {
        parsed.type = 'location';
        parsed.media = message.message.locationMessage;
      } else if (message.message?.contactMessage) {
        parsed.type = 'contact';
        parsed.media = message.message.contactMessage;
      }

      return parsed;
    } catch (error) {
      this.logger.error('Error parsing incoming message:', error);
      return {
        id: null,
        from: null,
        fromMe: false,
        timestamp: Date.now(),
        type: 'text',
        text: '',
        media: null,
        quoted: null
      };
    }
  }

  /**
   * Validate message content for sending
   */
  validateMessageContent(content, type = 'text') {
    try {
      switch (type) {
        case 'text':
          return content && content.trim().length > 0;
        case 'image':
        case 'video':
        case 'audio':
        case 'document':
          return content && (content.startsWith('http') || content.startsWith('/'));
        case 'location':
          const coords = content.split(',');
          return coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1]);
        case 'poll':
        case 'buttons':
        case 'list':
          try {
            JSON.parse(content);
            return true;
          } catch {
            return false;
          }
        default:
          return true;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Enhanced variable replacement for chatbot conversations
   * Supports dynamic variables from conversation data and contact information
   * Now supports [name] format to avoid JavaScript interpretation issues
   */
  async replaceVariables(content, variables = {}, conversationData = {}, sessionId = null, userJid = null, messageContext = null) {
    try {
      let processedContent = content;

      // Replace basic variables first ({{variable}} format)
      Object.keys(variables).forEach(key => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        processedContent = processedContent.replace(regex, variables[key] || '');
      });

      // Replace conversation-specific variables
      if (conversationData && Object.keys(conversationData).length > 0) {
        // Replace [name] with contact name from conversation data or fallback methods
        if (processedContent.includes('[name]') && userJid) {
          const contactName = await this.getContactName(sessionId, userJid, messageContext, conversationData);
          processedContent = processedContent.replace(/\[name\]/g, contactName);
        }

        // Replace {{user_name}} with contact name
        if (processedContent.includes('{{user_name}}') && userJid) {
          const contactName = await this.getContactName(sessionId, userJid, messageContext, conversationData);
          processedContent = processedContent.replace(/{{user_name}}/g, contactName);
        }

        // Replace {{user_email}} with contact email
        if (processedContent.includes('{{user_email}}') && userJid) {
          const contactEmail = await this.getContactEmail(sessionId, userJid, messageContext, conversationData);
          processedContent = processedContent.replace(/{{user_email}}/g, contactEmail);
        }

        // Replace {{previous_response}} with last user response
        if (processedContent.includes('{{previous_response}}') && conversationData.last_response) {
          processedContent = processedContent.replace(/{{previous_response}}/g, conversationData.last_response);
        }

        // Replace node-specific responses {{node_X_response}}
        const nodeResponseRegex = /{{node_(\d+)_response}}/g;
        let match;
        while ((match = nodeResponseRegex.exec(processedContent)) !== null) {
          const nodeId = match[1];
          const responseKey = `node_${nodeId}_response`;
          const response = conversationData[responseKey] || '';
          processedContent = processedContent.replace(match[0], response);
        }

        // Replace custom variables from conversation data
        Object.keys(conversationData).forEach(key => {
          if (key.startsWith('custom_')) {
            const varName = key.replace('custom_', '');
            const regex = new RegExp(`{{${varName}}}`, 'g');
            processedContent = processedContent.replace(regex, conversationData[key] || '');
          }
        });
      }

      return processedContent;
    } catch (error) {
      this.logger.error('Error replacing variables:', error);
      return content; // Return original content on error
    }
  }

  /**
   * Get contact name using multiple sources
   * Priority: 1. Conversation data (user_name), 2. Message context (pushName), 3. Database contacts, 4. Baileys store, 5. Phone number
   */
  async getContactName(sessionId, userJid, messageContext = null, conversationData = {}) {
    try {
      this.logger.info(`🔍 Getting contact name for JID: ${userJid} in session: ${sessionId}`);

      // 1. Try to get name from conversation data (highest priority for chatbot)
      if (conversationData && (conversationData.user_name || conversationData.custom_name)) {
        const userName = conversationData.user_name || conversationData.custom_name;
        this.logger.info(`✅ Found contact name from conversation data: ${userName}`);
        return userName.trim();
      }

      // 2. Try to get name from message context (pushName from incoming message)
      if (messageContext && messageContext.pushName) {
        this.logger.info(`✅ Found contact name from message context: ${messageContext.pushName}`);
        return messageContext.pushName.trim();
      }

      // 3. Try to get name from database contacts
      const phoneNumber = this.extractPhoneNumber(userJid);
      if (phoneNumber) {
        try {
          const databaseService = require('./database.service');
          const dbInstance = new databaseService();

          const contactResult = await dbInstance.get(
            'SELECT name FROM contacts WHERE phone_number = ? AND is_active = 1',
            [phoneNumber]
          );

          if (contactResult && contactResult.name) {
            this.logger.info(`✅ Found contact name from database: ${contactResult.name}`);
            return contactResult.name.trim();
          }
        } catch (dbError) {
          this.logger.warn('Error querying database for contact name:', dbError);
        }
      }

      // 4. Try to get name from Baileys store
      const storeContactName = await this.getContactNameFromStore(sessionId, userJid);
      if (storeContactName && storeContactName !== phoneNumber && storeContactName !== 'User') {
        this.logger.info(`✅ Found contact name from Baileys store: ${storeContactName}`);
        return storeContactName;
      }

      // 5. Fallback to phone number
      this.logger.info(`🔄 Using phone number as fallback for ${userJid}: ${phoneNumber}`);
      return phoneNumber || 'User';
    } catch (error) {
      this.logger.error('Error getting contact name:', error);
      const phoneNumber = this.extractPhoneNumber(userJid);
      return phoneNumber || 'User';
    }
  }

  /**
   * Get contact name from Baileys store
   * Falls back to phone number if name not available
   */
  async getContactNameFromStore(sessionId, userJid) {
    try {
      // Get WhatsApp service instance from global services
      const whatsappService = global.services?.whatsapp;
      if (!whatsappService) {
        this.logger.warn('WhatsApp service not available for contact name retrieval');
        const phoneNumber = this.extractPhoneNumber(userJid);
        return phoneNumber || 'User';
      }

      const store = whatsappService.getStore(sessionId);

      if (store && store.contacts) {
        const contact = store.contacts[userJid];

        if (contact) {
          // Try different name properties from Baileys contact object
          const contactName = contact.notify || contact.name || contact.verifiedName;
          if (contactName && contactName.trim()) {
            this.logger.info(`✅ Found contact name from store for ${userJid}: ${contactName}`);
            return contactName.trim();
          }
        }
      }

      // Fallback to phone number extraction
      const phoneNumber = this.extractPhoneNumber(userJid);
      return phoneNumber || 'User';
    } catch (error) {
      this.logger.error('Error getting contact name from store:', error);
      // Fallback to phone number
      const phoneNumber = this.extractPhoneNumber(userJid);
      return phoneNumber || 'User';
    }
  }

  /**
   * Get contact email using multiple sources
   * Priority: 1. Conversation data (user_email), 2. Database contacts, 3. Empty string
   */
  async getContactEmail(sessionId, userJid, messageContext = null, conversationData = {}) {
    try {
      this.logger.info(`🔍 Getting contact email for JID: ${userJid} in session: ${sessionId}`);

      // 1. Try to get email from conversation data (highest priority for chatbot)
      if (conversationData && (conversationData.user_email || conversationData.custom_email)) {
        const userEmail = conversationData.user_email || conversationData.custom_email;
        this.logger.info(`✅ Found contact email from conversation data: ${userEmail}`);
        return userEmail.trim();
      }

      // 2. Try to get email from database contacts
      const phoneNumber = this.extractPhoneNumber(userJid);
      if (phoneNumber) {
        try {
          const databaseService = require('./database.service');
          const dbInstance = new databaseService();

          const contactResult = await dbInstance.get(
            'SELECT email FROM contacts WHERE phone_number = ? AND is_active = 1',
            [phoneNumber]
          );

          if (contactResult && contactResult.email) {
            this.logger.info(`✅ Found contact email from database: ${contactResult.email}`);
            return contactResult.email.trim();
          }
        } catch (dbError) {
          this.logger.warn('Error querying database for contact email:', dbError);
        }
      }

      // 3. Fallback to empty string
      this.logger.info(`🔄 No email found for ${userJid}, using empty string`);
      return '';
    } catch (error) {
      this.logger.error('Error getting contact email:', error);
      return '';
    }
  }

  /**
   * Get user name from conversation data or fallback to phone number
   */
  async getUserName(sessionId, userJid, conversationData = {}) {
    try {
      // First check if name is stored in conversation data
      if (conversationData.user_name) {
        return conversationData.user_name;
      }

      // Extract phone number from JID and use as fallback
      const phoneNumber = this.extractPhoneNumber(userJid);
      return phoneNumber || 'User';
    } catch (error) {
      this.logger.error('Error getting user name:', error);
      return userJid ? this.extractPhoneNumber(userJid) : 'User';
    }
  }

  /**
   * Process chatbot message with conversation context
   */
  async processChatbotMessage(message, conversationData = {}, sessionId = null, userJid = null, messageContext = null) {
    try {
      // Replace variables in the message
      const processedMessage = await this.replaceVariables(message, {}, conversationData, sessionId, userJid, messageContext);

      return {
        success: true,
        content: processedMessage,
        type: 'text'
      };
    } catch (error) {
      this.logger.error('Error processing chatbot message:', error);
      return {
        success: false,
        error: error.message,
        content: message
      };
    }
  }

  /**
   * Extract variables from message content
   */
  extractVariablesFromContent(content) {
    const variableRegex = /{{(\w+)}}/g;
    const variables = [];
    let match;

    while ((match = variableRegex.exec(content)) !== null) {
      if (!variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }

    return variables;
  }

  /**
   * Store custom variable in conversation data
   */
  storeCustomVariable(conversationData, variableName, value) {
    if (!conversationData) {
      conversationData = {};
    }

    conversationData[`custom_${variableName}`] = value;
    return conversationData;
  }

  /**
   * Smart extraction of specific information from user responses
   * Uses pattern matching to extract relevant data based on variable type
   */
  extractSmartVariable(userResponse, variableName) {
    try {
      // Validate inputs
      if (!userResponse || typeof userResponse !== 'string') {
        return userResponse || '';
      }

      if (!variableName || typeof variableName !== 'string') {
        return userResponse;
      }

      const response = userResponse.trim();
      const lowerResponse = response.toLowerCase();

      switch (variableName.toLowerCase()) {
        case 'name':
        case 'user_name':
        case 'first_name':
        case 'last_name':
          return this.extractName(response, lowerResponse);

        case 'email':
        case 'email_address':
          return this.extractEmail(response);

        case 'phone':
        case 'phone_number':
        case 'mobile':
          return this.extractPhone(response);

        case 'age':
          return this.extractAge(response);

        case 'city':
        case 'location':
          return this.extractLocation(response, lowerResponse);

        default:
          // For unknown variable types, return the full response
          return response;
      }
    } catch (error) {
      // If any error occurs, return the original response
      return userResponse;
    }
  }

  /**
   * Extract name from user response
   */
  extractName(response, lowerResponse) {
    // Common patterns for name responses
    const namePatterns = [
      // "My name is John", "my name is John Doe"
      /(?:my name is|i am|i'm)\s+(?:mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)?\s*([a-zA-Z\s]+)/i,
      // "Call me John"
      /(?:call me)\s+([a-zA-Z\s]+)/i,
      // "It's Mike here", "It's Mike"
      /(?:it's|its)\s+([a-zA-Z]+)(?:\s+here)?/i,
      // "Name: John", "Name - John"
      /(?:name\s*[:|-]\s*)([a-zA-Z\s]+)/i,
      // "I am called John"
      /(?:i am called|they call me|people call me)\s+([a-zA-Z\s]+)/i,
      // "This is John", "Here is John"
      /(?:this is|here is)\s+(?:mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)?\s*([a-zA-Z\s]+)/i,
      // Just a name without any prefix (if it looks like a name)
      /^([a-zA-Z]+(?:\s+[a-zA-Z]+)*)$/
    ];

    for (const pattern of namePatterns) {
      const match = response.match(pattern);
      if (match && match[1]) {
        let extractedName = match[1].trim();

        // Clean up the extracted name
        extractedName = this.cleanExtractedName(extractedName);

        if (extractedName && this.isValidName(extractedName)) {
          return extractedName;
        }
      }
    }

    // If no pattern matches, try to extract the first meaningful word(s)
    const words = response.split(/\s+/).filter(word =>
      word.length > 1 &&
      /^[a-zA-Z]+$/.test(word) &&
      !this.isCommonWord(word.toLowerCase())
    );

    if (words.length > 0) {
      // Return first 1-2 words that look like a name
      const nameWords = words.slice(0, 2);
      const extractedName = nameWords.join(' ');

      if (this.isValidName(extractedName)) {
        return extractedName;
      }
    }

    // Fallback: return the original response
    return response;
  }

  /**
   * Clean extracted name by removing common prefixes/suffixes
   */
  cleanExtractedName(name) {
    // Remove common words that might be captured
    const wordsToRemove = [
      'sir', 'madam', 'mr', 'mrs', 'ms', 'dr', 'prof', 'professor',
      'and', 'the', 'a', 'an', 'is', 'am', 'are', 'was', 'were'
    ];

    let cleanName = name;

    // Remove words from the beginning and end
    const words = cleanName.split(/\s+/);
    const filteredWords = words.filter(word =>
      !wordsToRemove.includes(word.toLowerCase())
    );

    return filteredWords.join(' ').trim();
  }

  /**
   * Check if extracted text looks like a valid name
   */
  isValidName(name) {
    if (!name || name.length < 2) return false;

    // Should contain only letters and spaces
    if (!/^[a-zA-Z\s]+$/.test(name)) return false;

    // Should not be too long (probably not a name if > 50 chars)
    if (name.length > 50) return false;

    // Should not contain only common words
    const words = name.split(/\s+/);
    const hasProperName = words.some(word =>
      word.length > 2 &&
      !this.isCommonWord(word.toLowerCase()) &&
      word[0] === word[0].toUpperCase()
    );

    return hasProperName || words.length <= 2;
  }

  /**
   * Check if a word is a common English word (not likely to be a name)
   */
  isCommonWord(word) {
    const commonWords = [
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
      'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before',
      'after', 'above', 'below', 'between', 'among', 'this', 'that', 'these',
      'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
      'us', 'them', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'am',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
      'must', 'can', 'shall', 'hello', 'hi', 'hey', 'good', 'morning', 'evening',
      'afternoon', 'night', 'please', 'thank', 'thanks', 'welcome', 'sorry',
      'yes', 'no', 'okay', 'ok', 'sure', 'fine', 'great', 'nice', 'well'
    ];

    return commonWords.includes(word);
  }

  /**
   * Extract email from user response
   */
  extractEmail(response) {
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
    const match = response.match(emailPattern);
    return match ? match[0] : response;
  }

  /**
   * Extract phone number from user response
   */
  extractPhone(response) {
    // Extract phone number patterns first
    const phonePatterns = [
      /(\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/,
      /(\+?\d{10,15})/,
      /(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/,
      /(\(\d{3}\)\s*\d{3}[-.\s]?\d{4})/
    ];

    for (const pattern of phonePatterns) {
      const match = response.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    // If no pattern matches, try removing common prefixes and search again
    let cleanResponse = response.replace(/(?:my (?:phone|number|mobile) is|call me at|reach me at|phone:|mobile:)/i, '').trim();

    for (const pattern of phonePatterns) {
      const match = cleanResponse.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return response;
  }

  /**
   * Extract age from user response
   */
  extractAge(response) {
    const agePatterns = [
      /(?:i am|i'm|my age is|age:|years old)\s*(\d{1,3})/i,
      /(\d{1,3})\s*(?:years old|yrs old|years|yrs)/i,
      /^(\d{1,3})$/
    ];

    for (const pattern of agePatterns) {
      const match = response.match(pattern);
      if (match && match[1]) {
        const age = parseInt(match[1]);
        if (age > 0 && age < 150) {
          return age.toString();
        }
      }
    }

    return response;
  }

  /**
   * Extract location/city from user response
   */
  extractLocation(response, lowerResponse) {
    const locationPatterns = [
      /(?:i am from|i live in|my city is|city:|location:)\s*([a-zA-Z\s,]+)/i,
      /(?:from|in)\s+([a-zA-Z\s,]+)$/i
    ];

    for (const pattern of locationPatterns) {
      const match = response.match(pattern);
      if (match && match[1]) {
        let location = match[1].trim();
        // Remove trailing punctuation
        location = location.replace(/[.,;!?]+$/, '');

        if (location.length > 1 && location.length < 100) {
          return location;
        }
      }
    }

    // If it's a short response that might be just a city name
    if (response.length < 50 && /^[a-zA-Z\s,.-]+$/.test(response)) {
      return response;
    }

    return response;
  }
}

module.exports = MessageProcessorService;
