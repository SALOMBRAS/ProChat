/**
 * Web Speech API Transcription Service (Renderer Process)
 * This service runs in the renderer process and uses the browser's Web Speech API
 * for free voice transcription without requiring any API keys.
 */

class WebSpeechTranscriptionService {
  constructor() {
    this.isSupported = false;
    this.recognition = null;
    this.isListening = false;
    this.initializeWebSpeechAPI();
    this.setupIpcHandlers();
  }

  /**
   * Initialize Web Speech API
   */
  initializeWebSpeechAPI() {
    try {
      // Check if Web Speech API is supported
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      
      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = false;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US'; // You can make this configurable
        this.recognition.maxAlternatives = 1;
        
        this.isSupported = true;
        // Web Speech API initialized successfully
      } else {
        // Web Speech API not supported in this browser
      }
    } catch (error) {
      // Error initializing Web Speech API
    }
  }

  /**
   * Setup IPC handlers for communication with main process
   */
  setupIpcHandlers() {
    if (window.electronAPI && window.electronAPI.ipcRenderer) {
      // Listen for transcription requests from main process
      window.electronAPI.ipcRenderer.on('transcribe-audio', async (event, data) => {
        try {
          const result = await this.transcribeAudioData(data.audioData, data.format);
          window.electronAPI.ipcRenderer.send('transcription-result', result);
        } catch (error) {
          // Transcription error
          window.electronAPI.ipcRenderer.send('transcription-error', error.message);
        }
      });
    }
  }

  /**
   * Transcribe audio data using Web Speech API
   */
  async transcribeAudioData(audioBase64, format) {
    return new Promise((resolve, reject) => {
      if (!this.isSupported) {
        reject(new Error('Web Speech API not supported'));
        return;
      }

      try {
        // Convert base64 to blob
        const audioBlob = this.base64ToBlob(audioBase64, `audio/${format}`);
        
        // Create audio element to play the audio for recognition
        const audio = new Audio();
        const audioUrl = URL.createObjectURL(audioBlob);
        audio.src = audioUrl;
        
        // Setup recognition event handlers
        this.recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          const confidence = event.results[0][0].confidence;
          
          // Clean up
          URL.revokeObjectURL(audioUrl);
          
          resolve({
            text: transcript.trim(),
            confidence: confidence || 0.8
          });
        };

        this.recognition.onerror = (event) => {
          // Speech recognition error
          URL.revokeObjectURL(audioUrl);
          reject(new Error(`Speech recognition error: ${event.error}`));
        };

        this.recognition.onend = () => {
          this.isListening = false;
        };

        // Start recognition
        this.isListening = true;
        this.recognition.start();
        
        // Play audio to trigger recognition
        audio.play().catch(error => {
          // Audio playback failed, trying direct recognition
        });

        // Timeout after 10 seconds
        setTimeout(() => {
          if (this.isListening) {
            this.recognition.stop();
            URL.revokeObjectURL(audioUrl);
            reject(new Error('Transcription timeout'));
          }
        }, 10000);

      } catch (error) {
        // Error in transcribeAudioData
        reject(error);
      }
    });
  }

  /**
   * Convert base64 string to Blob
   */
  base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  /**
   * Test transcription with microphone input
   */
  async testMicrophoneTranscription() {
    return new Promise((resolve, reject) => {
      if (!this.isSupported) {
        reject(new Error('Web Speech API not supported'));
        return;
      }

      this.recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        const confidence = event.results[0][0].confidence;
        
        resolve({
          text: transcript.trim(),
          confidence: confidence || 0.8
        });
      };

      this.recognition.onerror = (event) => {
        reject(new Error(`Speech recognition error: ${event.error}`));
      };

      this.recognition.start();
    });
  }
}

// Initialize the service when the script loads
let webSpeechService = null;

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    webSpeechService = new WebSpeechTranscriptionService();
  });
} else {
  webSpeechService = new WebSpeechTranscriptionService();
}

// Export for potential use
window.webSpeechTranscriptionService = webSpeechService;
