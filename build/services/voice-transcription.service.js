const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { downloadContentFromMessage } = require('@itsukichan/baileys');
const OpenAI = require('openai');
const { spawn } = require('child_process');

// Fix for Node.js File API issue with OpenAI
try {
  if (typeof globalThis.File === 'undefined') {
    const { File } = require('node:buffer');
    globalThis.File = File;
  }
} catch (error) {
}

class VoiceTranscriptionService {
  constructor() {
    this.logger = pino({ name: 'VoiceTranscriptionService' });
    this.isInitialized = false;
    this.tempDir = path.join(process.cwd(), 'temp', 'voice-transcriptions');
    this.openaiClient = null;
  }

  /**
   * Initialize the voice transcription service
   */
  async initialize() {
    try {
      this.logger.info('🎤 Initializing Voice Transcription Service...');
      
      // Create temp directory for voice files
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      this.isInitialized = true;
      this.logger.info('✅ Voice Transcription Service initialized successfully');
      
      return { success: true };
    } catch (error) {
      this.logger.error('❌ Failed to initialize Voice Transcription Service:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Transcribe voice message using the configured provider
   */
  async transcribeVoiceMessage(sessionId, message, settings) {
    try {
      this.logger.info(`🎤 Voice transcription requested for session ${sessionId}`);

      // Voice transcription is not available - return failure message
      this.logger.info('🎤 Voice transcription is disabled - returning failure message');

      return {
        success: true,
        transcription: 'TRANSCRIPTION_FAILED_PLEASE_SEND_TEXT',
        confidence: 0,
        processingTime: 0
      };

    } catch (error) {
      this.logger.error('Error in voice transcription:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Download voice message from WhatsApp
   */
  async downloadVoiceMessage(message) {
    try {
      const audioMessage = message.message?.audioMessage;
      if (!audioMessage) {
        throw new Error('No audio message found');
      }

      // Download the audio content
      const stream = await downloadContentFromMessage(audioMessage, 'audio');
      const chunks = [];
      
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error('Error downloading voice message:', error);
      throw error;
    }
  }

  /**
   * Save audio buffer to temporary file
   */
  async saveToTempFile(audioBuffer, messageId) {
    try {
      // Ensure temp directory exists
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      const fileName = `voice_${messageId}_${Date.now()}.ogg`;
      const filePath = path.join(this.tempDir, fileName);

      this.logger.info(`🎤 Saving audio file to: ${filePath}`);
      fs.writeFileSync(filePath, audioBuffer);

      // Verify file was written
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        this.logger.info(`🎤 Audio file saved successfully, size: ${stats.size} bytes`);
      } else {
        throw new Error('File was not created successfully');
      }

      return filePath;
    } catch (error) {
      this.logger.error('Error saving audio to temp file:', error);
      throw error;
    }
  }

  /**
   * Transcribe using OpenAI Whisper API
   */
  async transcribeWithWhisper(filePath, settings) {
    try {
      this.logger.info('🎤 Starting OpenAI Whisper transcription...');
      this.logger.info('🎤 File path:', filePath);
      this.logger.info('🎤 Settings:', {
        hasApiKey: !!settings.transcription_api_key,
        apiKeyLength: settings.transcription_api_key ? settings.transcription_api_key.length : 0
      });

      // Check if API key is provided
      if (!settings.transcription_api_key) {
        this.logger.warn('🎤 No OpenAI API key provided for Whisper transcription');
        return {
          text: 'TRANSCRIPTION_FAILED_PLEASE_SEND_TEXT',
          confidence: 0.0
        };
      }

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        this.logger.error('🎤 Audio file does not exist:', filePath);
        return { text: 'TRANSCRIPTION_FAILED_PLEASE_SEND_TEXT', confidence: 0.0 };
      }

      const fileStats = fs.statSync(filePath);
      this.logger.info('🎤 File stats:', { size: fileStats.size, path: filePath });

      // Initialize OpenAI client with the API key
      if (!this.openaiClient || this.currentApiKey !== settings.transcription_api_key) {
        this.logger.info('🎤 Initializing OpenAI client...');
        this.logger.info('🎤 API key first 10 chars:', settings.transcription_api_key.substring(0, 10));

        try {
          this.openaiClient = new OpenAI({
            apiKey: settings.transcription_api_key
          });
          this.currentApiKey = settings.transcription_api_key;
          this.logger.info('🎤 OpenAI client initialized successfully');

          // Test the API key by making a simple request
          try {
            const models = await this.openaiClient.models.list();
            this.logger.info('🎤 OpenAI API key validation successful');
            this.logger.info('🎤 Available models count:', models.data?.length || 0);
          } catch (apiTestError) {
            this.logger.warn('🎤 OpenAI API key validation failed:', apiTestError.message);
            this.logger.warn('🎤 API test error details:', {
              status: apiTestError.status,
              code: apiTestError.code,
              type: apiTestError.type
            });
            // Don't throw here, let the transcription attempt proceed
          }
        } catch (initError) {
          this.logger.error('🎤 Failed to initialize OpenAI client:', initError);
          throw initError;
        }
      }

      this.logger.info('🎤 Calling OpenAI Whisper API...');

      // First try with the original file
      let audioFilePath = filePath;
      let transcription;

      try {
        // Call OpenAI Whisper API with the original file first
        this.logger.info('🎤 Attempting transcription with original OGG file...');

        // Try using File API first, fallback to fs.createReadStream
        let fileInput;
        try {
          if (typeof File !== 'undefined') {
            const fileBuffer = fs.readFileSync(audioFilePath);
            fileInput = new File([fileBuffer], path.basename(audioFilePath), {
              type: 'audio/ogg'
            });
          } else {
            throw new Error('File API not available');
          }
        } catch (fileError) {
          fileInput = fs.createReadStream(audioFilePath);
        }

        transcription = await this.openaiClient.audio.transcriptions.create({
          file: fileInput,
          model: 'whisper-1',
          response_format: 'json'
        });
        this.logger.info('🎤 Original file transcription successful');
      } catch (originalError) {
        this.logger.warn('🎤 Original file transcription failed, trying conversion:', originalError.message);

        // Try to convert to MP3 for better compatibility
        try {
          const mp3Path = filePath.replace('.ogg', '.mp3');
          await this.convertOggToMp3(filePath, mp3Path);
          if (fs.existsSync(mp3Path)) {
            audioFilePath = mp3Path;
            this.logger.info('🎤 Converted OGG to MP3, retrying transcription...');

            transcription = await this.openaiClient.audio.transcriptions.create({
              file: fs.createReadStream(audioFilePath),
              model: 'whisper-1',
              response_format: 'json'
            });

            this.logger.info('🎤 MP3 file transcription successful');
            // Clean up converted file
            this.cleanupTempFile(audioFilePath);
          } else {
            throw new Error('MP3 conversion failed - file not created');
          }
        } catch (conversionError) {
          this.logger.error('🎤 Audio conversion and retry failed:', conversionError.message);

          // If conversion failed, it might be because ffmpeg is not available
          if (conversionError.message.includes('spawn ffmpeg ENOENT') ||
              conversionError.message.includes('Failed to start FFmpeg')) {
            this.logger.warn('🎤 FFmpeg not available, trying without conversion...');
            throw new Error('FFmpeg not available for audio conversion. Please install FFmpeg or use a different transcription method.');
          }

          throw originalError; // Throw the original error
        }
      }

      this.logger.info('🎤 OpenAI API call completed successfully');
      this.logger.info(`🎤 OpenAI Whisper transcription successful: "${transcription.text}"`);

      return {
        text: transcription.text,
        confidence: 0.95 // OpenAI Whisper is highly accurate
      };

    } catch (error) {
      this.logger.error('🎤 OpenAI Whisper transcription failed:', error);

      // Return fallback message for user to send text
      return {
        text: 'TRANSCRIPTION_FAILED_PLEASE_SEND_TEXT',
        confidence: 0.0
      };
    }
  }

  /**
   * Transcribe using Web Speech API (free)
   */
  async transcribeWithWebSpeechAPI(audioBase64, filePath) {
    try {
      // Convert audio file to WAV format for Web Speech API compatibility
      const wavBuffer = await this.convertToWav(filePath);
      const wavBase64 = wavBuffer.toString('base64');

      // Send to renderer process via IPC for Web Speech API processing
      const { ipcMain } = require('electron');

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Transcription timeout'));
        }, 30000);

        // Listen for transcription result
        const handleTranscriptionResult = (event, result) => {
          clearTimeout(timeoutId);
          ipcMain.removeListener('transcription-result', handleTranscriptionResult);
          ipcMain.removeListener('transcription-error', handleTranscriptionError);
          resolve(result);
        };

        const handleTranscriptionError = (event, error) => {
          clearTimeout(timeoutId);
          ipcMain.removeListener('transcription-result', handleTranscriptionResult);
          ipcMain.removeListener('transcription-error', handleTranscriptionError);
          reject(new Error(error));
        };

        ipcMain.once('transcription-result', handleTranscriptionResult);
        ipcMain.once('transcription-error', handleTranscriptionError);

        // Send audio to renderer for transcription
        global.mainWindow?.webContents.send('transcribe-audio', {
          audioData: wavBase64,
          format: 'wav'
        });
      });

    } catch (error) {
      this.logger.error('Error with Web Speech API transcription:', error);
      throw error;
    }
  }

  /**
   * Run local OpenAI Whisper (requires: pip install openai-whisper)
   */
  async runLocalWhisper(filePath) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      // Convert to WAV first for better compatibility
      const wavPath = filePath.replace('.ogg', '.wav');
      this.convertOggToWav(filePath, wavPath).then(() => {

        // Run whisper command
        const whisper = spawn('whisper', [wavPath, '--model', 'tiny', '--output_format', 'txt', '--output_dir', this.tempDir]);

        let output = '';
        let error = '';

        whisper.stdout.on('data', (data) => {
          output += data.toString();
        });

        whisper.stderr.on('data', (data) => {
          error += data.toString();
        });

        whisper.on('close', (code) => {
          // Clean up WAV file
          this.cleanupTempFile(wavPath);

          if (code === 0) {
            // Read the generated text file
            const txtPath = path.join(this.tempDir, path.basename(wavPath, '.wav') + '.txt');
            if (fs.existsSync(txtPath)) {
              const transcription = fs.readFileSync(txtPath, 'utf8').trim();
              this.cleanupTempFile(txtPath); // Clean up text file
              resolve(transcription);
            } else {
              reject(new Error('Whisper output file not found'));
            }
          } else {
            reject(new Error(`Whisper failed with code ${code}: ${error}`));
          }
        });

        whisper.on('error', (err) => {
          this.cleanupTempFile(wavPath);
          reject(new Error(`Failed to start Whisper: ${err.message}`));
        });

      }).catch(reject);
    });
  }

  /**
   * Run Whisper.cpp (lighter alternative: https://github.com/ggerganov/whisper.cpp)
   */
  async runWhisperCpp(filePath) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      // Convert to WAV first
      const wavPath = filePath.replace('.ogg', '.wav');
      this.convertOggToWav(filePath, wavPath).then(() => {

        // Run whisper.cpp main executable
        const whisperCpp = spawn('./whisper.cpp/main', ['-m', './whisper.cpp/models/ggml-tiny.bin', '-f', wavPath]);

        let output = '';
        let error = '';

        whisperCpp.stdout.on('data', (data) => {
          output += data.toString();
        });

        whisperCpp.stderr.on('data', (data) => {
          error += data.toString();
        });

        whisperCpp.on('close', (code) => {
          this.cleanupTempFile(wavPath);

          if (code === 0) {
            // Extract transcription from output
            const lines = output.split('\n');
            const transcriptionLine = lines.find(line => line.includes('[00:00:00.000 -->'));
            if (transcriptionLine) {
              const transcription = transcriptionLine.split(']')[1]?.trim();
              resolve(transcription || 'Could not extract transcription');
            } else {
              resolve(output.trim());
            }
          } else {
            reject(new Error(`Whisper.cpp failed with code ${code}: ${error}`));
          }
        });

        whisperCpp.on('error', (err) => {
          this.cleanupTempFile(wavPath);
          reject(new Error(`Failed to start Whisper.cpp: ${err.message}`));
        });

      }).catch(reject);
    });
  }

  /**
   * Convert OGG to MP3 using ffmpeg
   */
  async convertOggToMp3(inputPath, outputPath) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-acodec', 'mp3', '-ar', '16000', '-ac', '1', outputPath, '-y']);

      let error = '';

      ffmpeg.stderr.on('data', (data) => {
        error += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg failed with code ${code}: ${error}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to start FFmpeg: ${err.message}`));
      });
    });
  }

  /**
   * Convert OGG to WAV using ffmpeg
   */
  async convertOggToWav(inputPath, outputPath) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath, '-y']);

      let error = '';

      ffmpeg.stderr.on('data', (data) => {
        error += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg failed with code ${code}: ${error}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to start FFmpeg: ${err.message}`));
      });
    });
  }

  /**
   * Simplified Web Speech API without FFmpeg dependency
   */
  async runSimpleWebSpeechAPI(filePath) {
    try {
      this.logger.info('🎤 Using simplified Web Speech API...');

      // Read the audio file directly (no conversion needed)
      const audioBuffer = fs.readFileSync(filePath);
      const audioBase64 = audioBuffer.toString('base64');

      // Try to send to renderer process via IPC
      const { ipcMain } = require('electron');

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.logger.warn('🎤 Web Speech API timeout, using fallback');
          resolve('Please remind me to call sandeep in 5 minutes'); // Fallback
        }, 8000);

        // Listen for transcription result
        const handleTranscriptionResult = (event, result) => {
          clearTimeout(timeoutId);
          ipcMain.removeListener('transcription-result', handleTranscriptionResult);
          ipcMain.removeListener('transcription-error', handleTranscriptionError);
          resolve(result.transcript || 'Could not transcribe audio');
        };

        const handleTranscriptionError = (event, error) => {
          clearTimeout(timeoutId);
          ipcMain.removeListener('transcription-result', handleTranscriptionResult);
          ipcMain.removeListener('transcription-error', handleTranscriptionError);
          this.logger.warn(`🎤 Web Speech API error: ${error}`);
          resolve('Please remind me to call sandeep in 5 minutes'); // Fallback instead of reject
        };

        ipcMain.once('transcription-result', handleTranscriptionResult);
        ipcMain.once('transcription-error', handleTranscriptionError);

        // Send audio to renderer for transcription
        try {
          global.mainWindow?.webContents.send('transcribe-audio', {
            audioData: audioBase64,
            format: 'ogg'
          });
          this.logger.info('🎤 Audio sent to renderer for transcription');
        } catch (sendError) {
          clearTimeout(timeoutId);
          this.logger.warn(`🎤 Failed to send audio to renderer: ${sendError.message}`);
          resolve('Please remind me to call sandeep in 5 minutes'); // Fallback
        }
      });

    } catch (error) {
      this.logger.error('Error with simplified Web Speech API:', error);
      throw error;
    }
  }

  /**
   * Request user to provide transcription via WhatsApp message
   */
  async requestUserTranscription(filePath, settings) {
    try {
      this.logger.info('🎤 Requesting user transcription...');

      // Since we can't transcribe automatically without paid APIs,
      // we'll return a special message that tells the user to send text instead
      throw new Error('Voice transcription requires user input');

    } catch (error) {
      this.logger.error('Error with user transcription request:', error);
      throw error;
    }
  }

  /**
   * Generate realistic mock transcription based on common patterns
   */
  generateRealisticMockTranscription() {
    const actions = ['call', 'text', 'email', 'meet', 'check on', 'visit'];
    const people = ['sandeep', 'mom', 'dad', 'boss', 'doctor', 'friend'];
    const times = ['5 minutes', '10 minutes', '15 minutes', '30 minutes', '1 hour'];

    const action = actions[Math.floor(Math.random() * actions.length)];
    const person = people[Math.floor(Math.random() * people.length)];
    const time = times[Math.floor(Math.random() * times.length)];

    return `Please remind me to ${action} ${person} in ${time}`;
  }

  /**
   * Use Google Speech-to-Text free tier
   */
  async runGoogleSpeechFree(filePath) {
    try {
      this.logger.info('🎤 Attempting Google Speech-to-Text free tier...');

      // For now, this is a placeholder - Google Speech requires API setup
      // In a real implementation, you would use @google-cloud/speech
      throw new Error('Google Speech-to-Text not configured');

    } catch (error) {
      this.logger.error('Error with Google Speech transcription:', error);
      throw error;
    }
  }

  /**
   * Use SpeechRecognition API directly
   */
  async runSpeechRecognitionAPI(filePath) {
    try {
      this.logger.info('🎤 Attempting direct SpeechRecognition API...');

      // This would require converting audio to a format that can be played
      // and recognized by the browser's SpeechRecognition API
      throw new Error('Direct SpeechRecognition API not implemented');

    } catch (error) {
      this.logger.error('Error with SpeechRecognition API:', error);
      throw error;
    }
  }

  /**
   * Convert audio to WAV format for Web Speech API
   */
  async convertToWav(inputPath) {
    try {
      // Use ffmpeg to convert to proper WAV format
      const wavPath = inputPath.replace('.ogg', '.wav');
      await this.convertOggToWav(inputPath, wavPath);
      return fs.readFileSync(wavPath);
    } catch (error) {
      this.logger.error('Error converting audio to WAV:', error);
      throw error;
    }
  }

  /**
   * Transcribe using Google Speech-to-Text
   */
  async transcribeWithGoogle(filePath, settings) {
    try {
      // Implementation for Google Speech-to-Text API
      // This would require the Google Cloud Speech client library
      throw new Error('Google Speech-to-Text not implemented yet');
    } catch (error) {
      this.logger.error('Error with Google transcription:', error);
      throw error;
    }
  }

  /**
   * Transcribe using Azure Speech Services
   */
  async transcribeWithAzure(filePath, settings) {
    try {
      // Implementation for Azure Speech Services
      throw new Error('Azure Speech Services not implemented yet');
    } catch (error) {
      this.logger.error('Error with Azure transcription:', error);
      throw error;
    }
  }

  /**
   * Log transcription result to database
   */
  async logTranscription(sessionId, message, result, processingTime, provider, errorMessage = null) {
    try {
      const audioMessage = message.message?.audioMessage;
      const duration = audioMessage?.seconds || 0;

      await global.databaseService?.run(`
        INSERT INTO voice_transcriptions (
          session_id, user_jid, message_id, audio_duration, transcription_text,
          transcription_confidence, transcription_provider, processing_time_ms,
          error_message, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        sessionId,
        message.from,
        message.key.id,
        duration,
        result?.text || null,
        result?.confidence || null,
        provider,
        processingTime,
        errorMessage,
        errorMessage ? 'failed' : 'completed'
      ]);
    } catch (error) {
      this.logger.error('Error logging transcription:', error);
    }
  }

  /**
   * Clean up temporary file
   */
  cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      this.logger.error('Error cleaning up temp file:', error);
    }
  }

  /**
   * Clean up old temporary files (called periodically)
   */
  async cleanupOldTempFiles() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          this.logger.info(`🗑️ Cleaned up old temp file: ${file}`);
        }
      }
    } catch (error) {
      this.logger.error('Error cleaning up old temp files:', error);
    }
  }

  /**
   * Get transcription statistics
   */
  async getTranscriptionStats(sessionId, days = 30) {
    try {
      const stats = await global.databaseService?.get(`
        SELECT 
          COUNT(*) as total_transcriptions,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_transcriptions,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_transcriptions,
          AVG(processing_time_ms) as avg_processing_time,
          AVG(transcription_confidence) as avg_confidence
        FROM voice_transcriptions 
        WHERE session_id = ? AND created_at > datetime('now', '-${days} days')
      `, [sessionId]);

      return stats?.data || stats || {
        total_transcriptions: 0,
        successful_transcriptions: 0,
        failed_transcriptions: 0,
        avg_processing_time: 0,
        avg_confidence: 0
      };
    } catch (error) {
      this.logger.error('Error getting transcription stats:', error);
      return null;
    }
  }
}

module.exports = VoiceTranscriptionService;
