/**
 * Application Configuration
 * 
 * This file contains app-wide configuration that should NOT be translated.
 * These values remain constant across all languages.
 */

export const APP_CONFIG = {
  // App Identity (DO NOT translate these)
  APP_NAME: 'ChatPro',
  APP_TAGLINE: 'WhatsApp Automation Platform',
  APP_VERSION: 'v3.0.1',

  // Technical Info
  APP_ID: 'com.chatpro.desktop',
  
  // Default Device Name (uses APP_NAME)
  get DEFAULT_DEVICE_NAME() {
    return `${this.APP_NAME} Device`;
  }
};

export default APP_CONFIG;
