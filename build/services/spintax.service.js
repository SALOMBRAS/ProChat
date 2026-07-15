/**
 * Spintax Service - Handles spintax parsing and sequential rotation
 * Supports format: {option1|option2|option3} or option1|option2|option3
 */
class SpintaxService {
  constructor(databaseService = null) {
    this.databaseService = databaseService;
  }

  /**
   * Parse spintax text and extract all variations
   * @param {string} text - Text containing spintax patterns
   * @returns {Array} Array of all possible variations
   */
  parseSpintax(text) {
    if (!text || typeof text !== 'string') {
      return [text || ''];
    }

    // Find all spintax patterns: {option1|option2|option3}
    const spintaxPattern = /\{([^}]+)\}/g;
    let variations = [text];
    let match;

    while ((match = spintaxPattern.exec(text)) !== null) {
      const fullMatch = match[0]; // {option1|option2|option3}
      const options = match[1].split('|').map(opt => opt.trim()).filter(opt => opt.length > 0);
      
      if (options.length > 1) {
        const newVariations = [];
        
        for (const variation of variations) {
          for (const option of options) {
            newVariations.push(variation.replace(fullMatch, option));
          }
        }
        
        variations = newVariations;
      }
    }

    return variations.length > 0 ? variations : [text];
  }

  /**
   * Get next spintax variation for a campaign (sequential rotation)
   * @param {number} campaignId - Campaign ID
   * @param {string} originalText - Original text with spintax
   * @returns {Promise<string>} Next variation in sequence
   */
  async getNextVariation(campaignId, originalText) {
    try {
      if (!this.databaseService) {
        // Fallback: just parse and return first variation
        const variations = this.parseSpintax(originalText);
        return variations[0] || originalText;
      }

      // Check if we have existing state for this campaign
      const stateResponse = await this.databaseService.query(
        'SELECT * FROM spintax_state WHERE campaign_id = ? AND spintax_text = ?',
        [campaignId, originalText]
      );

      let currentIndex = 0;
      const variations = this.parseSpintax(originalText);
      const totalVariations = variations.length;

      if (stateResponse.success && stateResponse.data.length > 0) {
        // Update existing state
        const state = stateResponse.data[0];
        currentIndex = (state.current_index + 1) % totalVariations;
        
        await this.databaseService.query(
          'UPDATE spintax_state SET current_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [currentIndex, state.id]
        );
      } else {
        // Create new state
        await this.databaseService.query(
          'INSERT INTO spintax_state (campaign_id, spintax_text, current_index, total_variations) VALUES (?, ?, ?, ?)',
          [campaignId, originalText, currentIndex, totalVariations]
        );
      }

      return variations[currentIndex] || originalText;
    } catch (error) {
      console.error('Error getting next spintax variation:', error);
      // Fallback: return original text
      return originalText;
    }
  }

  /**
   * Reset spintax state for a campaign
   * @param {number} campaignId - Campaign ID
   */
  async resetCampaignState(campaignId) {
    try {
      if (!this.databaseService) return;
      
      await this.databaseService.query(
        'DELETE FROM spintax_state WHERE campaign_id = ?',
        [campaignId]
      );
    } catch (error) {
      console.error('Error resetting spintax state:', error);
    }
  }

  /**
   * Check if text contains spintax patterns
   * @param {string} text - Text to check
   * @returns {boolean} True if text contains spintax
   */
  hasSpintax(text) {
    if (!text || typeof text !== 'string') {
      return false;
    }
    
    return /\{[^}]*\|[^}]*\}/.test(text);
  }

  /**
   * Process message content and replace spintax with next variation
   * @param {number} campaignId - Campaign ID
   * @param {string} content - Message content
   * @returns {Promise<string>} Processed content with spintax replaced
   */
  async processMessageContent(campaignId, content) {
    try {
      if (!this.hasSpintax(content)) {
        return content;
      }

      // Find all spintax patterns and replace them sequentially
      const spintaxPattern = /\{([^}]+)\}/g;
      let processedContent = content;
      let match;
      const matches = [];

      // Collect all matches first
      while ((match = spintaxPattern.exec(content)) !== null) {
        matches.push({
          fullMatch: match[0],
          options: match[1].split('|').map(opt => opt.trim()).filter(opt => opt.length > 0)
        });
      }

      // Process each match
      for (const matchData of matches) {
        if (matchData.options.length > 1) {
          const variation = await this.getNextVariation(campaignId, matchData.fullMatch);
          processedContent = processedContent.replace(matchData.fullMatch, variation);
        }
      }

      return processedContent;
    } catch (error) {
      console.error('Error processing spintax content:', error);
      return content;
    }
  }

  /**
   * Get spintax statistics for a campaign
   * @param {number} campaignId - Campaign ID
   * @returns {Promise<Object>} Statistics object
   */
  async getSpintaxStats(campaignId) {
    try {
      if (!this.databaseService) {
        return { totalPatterns: 0, states: [] };
      }

      const response = await this.databaseService.query(
        'SELECT * FROM spintax_state WHERE campaign_id = ?',
        [campaignId]
      );

      if (response.success) {
        return {
          totalPatterns: response.data.length,
          states: response.data.map(state => ({
            text: state.spintax_text,
            currentIndex: state.current_index,
            totalVariations: state.total_variations,
            progress: `${state.current_index + 1}/${state.total_variations}`
          }))
        };
      }

      return { totalPatterns: 0, states: [] };
    } catch (error) {
      console.error('Error getting spintax stats:', error);
      return { totalPatterns: 0, states: [] };
    }
  }
}

module.exports = SpintaxService;
