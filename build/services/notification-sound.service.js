class NotificationSoundService {
  constructor() {
    this.audioContext = null;
    this.isEnabled = true;
    this.volume = 0.5;
    this.initAudioContext();
  }

  initAudioContext() {
    try {
      // Create audio context for better browser compatibility
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (error) {
    }
  }

  // Create a simple notification sound using Web Audio API
  createNotificationSound() {
    if (!this.audioContext || !this.isEnabled) return;

    try {
      // Resume audio context if suspended (required by some browsers)
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();

      // Connect nodes
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Configure sound
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
      oscillator.frequency.setValueAtTime(600, this.audioContext.currentTime + 0.1);
      
      // Configure volume envelope
      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(this.volume * 0.3, this.audioContext.currentTime + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.3);

      // Play sound
      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + 0.3);

    } catch (error) {
      // Fallback to HTML5 audio
      this.playFallbackSound();
    }
  }

  // Fallback method using HTML5 audio with data URI
  playFallbackSound() {
    if (!this.isEnabled) return;

    try {
      // Create a simple beep sound using data URI
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT');
      audio.volume = this.volume;
      audio.play().catch(error => {
      });
    } catch (error) {
    }
  }

  // Play notification sound
  playNotificationSound() {
    this.createNotificationSound();
  }

  // Enable/disable sounds
  setEnabled(enabled) {
    this.isEnabled = enabled;
    // Save preference to localStorage
    localStorage.setItem('notificationSoundsEnabled', enabled.toString());
  }

  // Check if sounds are enabled
  isNotificationSoundEnabled() {
    const saved = localStorage.getItem('notificationSoundsEnabled');
    if (saved !== null) {
      this.isEnabled = saved === 'true';
    }
    return this.isEnabled;
  }

  // Set volume (0.0 to 1.0)
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    localStorage.setItem('notificationSoundVolume', this.volume.toString());
  }

  // Get current volume
  getVolume() {
    const saved = localStorage.getItem('notificationSoundVolume');
    if (saved !== null) {
      this.volume = parseFloat(saved);
    }
    return this.volume;
  }

  // Test sound
  testSound() {
    const wasEnabled = this.isEnabled;
    this.isEnabled = true;
    this.playNotificationSound();
    this.isEnabled = wasEnabled;
  }

  // Initialize from saved preferences
  loadPreferences() {
    this.isNotificationSoundEnabled();
    this.getVolume();
  }
}

// Create singleton instance
const notificationSoundService = new NotificationSoundService();

// Load preferences on initialization
notificationSoundService.loadPreferences();

export default notificationSoundService;
