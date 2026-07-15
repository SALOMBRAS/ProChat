/**
 * Translation Service
 * Manages translation keys, overrides, and statistics
 */

const fs = require('fs');
const path = require('path');

class TranslationService {
  constructor(databaseService) {
    this.db = databaseService;
  }

  /**
   * Extract all translation keys from locale files and store in database
   * @param {Object} localeData - The locale object (e.g., from en.js)
   * @param {string} category - Category for these keys
   * @returns {Promise<Array>} Array of extracted keys
   */
  async extractKeysFromLocale(localeData, category = 'general') {
    const keys = [];

    // Helper function to capitalize first letter
    const capitalize = (str) => {
      if (!str) return 'General';
      return str.charAt(0).toUpperCase() + str.slice(1);
    };

    const flatten = (obj, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'string') {
          const categoryName = category || fullKey.split('.')[0];
          keys.push({
            keyPath: fullKey,
            category: capitalize(categoryName),
            englishText: value
          });
        } else if (typeof value === 'object' && value !== null) {
          flatten(value, fullKey);
        }
      }
    };

    flatten(localeData);
    return keys;
  }

  /**
   * Sync translation keys from locale file to database
   * @param {Object} localeData - The English locale object
   * @returns {Promise<Object>} Sync result with counts
   */
  async syncTranslationKeys(localeData) {
    try {
      const keys = await this.extractKeysFromLocale(localeData);
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const key of keys) {
        // Check if key already exists
        const existingKey = await this.db.query(
          `SELECT id, english_text FROM translation_keys WHERE key_path = ?`,
          [key.keyPath]
        );

        if (existingKey.data && existingKey.data.length > 0) {
          // Key exists - check if English text needs updating
          if (existingKey.data[0].english_text !== key.englishText) {
            await this.db.query(
              `UPDATE translation_keys SET english_text = ?, category = ? WHERE key_path = ?`,
              [key.englishText, key.category, key.keyPath]
            );
            updated++;
          } else {
            skipped++;
          }
        } else {
          // Insert new key
          const result = await this.db.query(
            `INSERT INTO translation_keys (key_path, category, english_text)
             VALUES (?, ?, ?)`,
            [key.keyPath, key.category, key.englishText]
          );

          if (result.success) {
            inserted++;
          }
        }
      }

      return {
        success: true,
        inserted,
        updated,
        skipped,
        total: keys.length
      };
    } catch (error) {
      console.error('Error syncing translation keys:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all translation keys with their overrides for a specific language
   * @param {string} languageCode - Language code (e.g., 'es', 'fr')
   * @returns {Promise<Array>} Array of translation keys with overrides
   */
  async getTranslationsForLanguage(languageCode) {
    const callId = Date.now();
    try {
      // First, get all keys from database with any custom overrides
      const result = await this.db.query(
        `SELECT
          tk.id,
          tk.key_path,
          tk.category,
          tk.english_text,
          tov.custom_text,
          tov.is_approved,
          tov.notes,
          CASE WHEN tov.id IS NOT NULL THEN 1 ELSE 0 END as has_override
        FROM translation_keys tk
        LEFT JOIN translation_overrides tov ON tk.id = tov.key_id AND tov.language_code = ?
        WHERE tk.is_active = 1
        ORDER BY tk.category, tk.key_path`,
        [languageCode]
      );

      const dbTranslations = result.data || [];

      // Load locale file translations for this language (if not English)
      let localeTranslations = {};
      if (languageCode !== 'en') {
        try {
          // Determine the locale file path

          // Try multiple possible paths
          const possiblePaths = [
            path.join(__dirname, '..', 'locales', `${languageCode}.js`),
            path.join(__dirname, '..', '..', 'src', 'locales', `${languageCode}.js`),
            path.join(process.cwd(), 'src', 'locales', `${languageCode}.js`),
          ];


          let localeFilePath = null;
          for (const testPath of possiblePaths) {
            if (fs.existsSync(testPath)) {
              localeFilePath = testPath;
              break;
            }
          }

          if (!localeFilePath) {
            throw new Error('Locale file not found');
          }

          if (fs.existsSync(localeFilePath)) {
            // Read the file content
            let fileContent = fs.readFileSync(localeFilePath, 'utf8');


            // Remove 'export default' statement
            fileContent = fileContent.replace(/export\s+default\s+/g, '');

            // Remove any trailing semicolons
            fileContent = fileContent.trim().replace(/;$/, '');


            // Wrap in parentheses and evaluate
            try {
              localeTranslations = eval('(' + fileContent + ')');

              // Debug: Check if properties are enumerable
            } catch (evalError) {
              console.error(`[${callId}] ❌ Error evaluating locale file:`, evalError.message);
              console.error(`[${callId}] ❌ Error stack:`, evalError.stack);
            }
          } else {
          }
        } catch (error) {
          console.error(`❌ Error loading locale file for ${languageCode}:`, error.message);
          console.error(`❌ Error stack:`, error.stack);
        }
      }

      // Check localeTranslations state before using it

      // Helper function to get value from nested object by path
      const getNestedValue = (obj, path) => {
        const keys = path.split('.');
        let current = obj;

        // Debug logging for the test case
        if (path === 'common.actions') {
        }

        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];

          if (path === 'common.actions') {
            if (current && typeof current === 'object') {
            }
          }

          if (current && typeof current === 'object' && key in current) {
            current = current[key];
            if (path === 'common.actions') {
            }
          } else {
            if (path === 'common.actions') {
            }
            return null;
          }
        }

        const result = typeof current === 'string' ? current : null;
        if (path === 'common.actions') {
        }
        return result;
      };

      // Test the function with a known key
      const testValue = getNestedValue(localeTranslations, 'common.actions');
      if (localeTranslations.common) {
      }

      // Merge locale file translations with database

      let localeMatchCount = 0;
      let customMatchCount = 0;
      let missingCount = 0;

      const mergedTranslations = dbTranslations.map((item, index) => {
        // Priority: custom_text > locale file > english_text
        let translatedText = item.english_text;
        let fromLocaleFile = false;

        if (item.custom_text) {
          // User has customized this translation
          translatedText = item.custom_text;
          customMatchCount++;
        } else {
          // Check if locale file has this translation
          const localeValue = getNestedValue(localeTranslations, item.key_path);
          if (localeValue) {
            translatedText = localeValue;
            fromLocaleFile = true;
            localeMatchCount++;
            // Log first few matches for debugging
            if (localeMatchCount <= 3) {
            }
          } else {
            missingCount++;
            // Log first few misses for debugging
            if (missingCount <= 3) {
            }
          }
        }

        return {
          ...item,
          translated_text: translatedText,
          from_locale_file: fromLocaleFile,
          is_missing: translatedText === item.english_text // Missing if same as English
        };
      });


      return mergedTranslations;
    } catch (error) {
      console.error('Error getting translations:', error);
      return [];
    }
  }

  /**
   * Update a translation override
   * @param {number} keyId - Translation key ID
   * @param {string} languageCode - Language code
   * @param {string} customText - The translated text
   * @param {boolean} isApproved - Whether translation is approved
   * @param {string} notes - Optional notes
   * @returns {Promise<Object>} Update result
   */
  async updateTranslation(keyId, languageCode, customText, isApproved = false, notes = '') {
    try {
      const result = await this.db.query(
        `INSERT OR REPLACE INTO translation_overrides 
         (key_id, language_code, custom_text, is_approved, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [keyId, languageCode, customText, isApproved ? 1 : 0, notes]
      );

      // Update stats
      await this.updateTranslationStats(languageCode);

      return { success: true };
    } catch (error) {
      console.error('Error updating translation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a translation override (reset to default)
   * @param {number} keyId - Translation key ID
   * @param {string} languageCode - Language code
   * @returns {Promise<Object>} Delete result
   */
  async deleteTranslation(keyId, languageCode) {
    try {
      const result = await this.db.query(
        `DELETE FROM translation_overrides
         WHERE key_id = ? AND language_code = ?`,
        [keyId, languageCode]
      );

      // Update stats
      await this.updateTranslationStats(languageCode);

      return { success: true };
    } catch (error) {
      console.error('Error deleting translation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get translation statistics for all languages
   * @returns {Promise<Array>} Array of translation stats
   */
  async getTranslationStats() {
    try {
      const result = await this.db.query(
        `SELECT * FROM translation_stats ORDER BY language_code`
      );

      return result.data || [];
    } catch (error) {
      console.error('Error getting translation stats:', error);
      return [];
    }
  }

  /**
   * Update translation statistics for a language
   * @param {string} languageCode - Language code
   * @returns {Promise<Object>} Update result
   */
  async updateTranslationStats(languageCode) {
    try {
      const totalResult = await this.db.query(
        `SELECT COUNT(*) as count FROM translation_keys WHERE is_active = 1`
      );
      const total = totalResult.data?.[0]?.count || 0;

      const translatedResult = await this.db.query(
        `SELECT COUNT(*) as count FROM translation_overrides 
         WHERE language_code = ? AND custom_text IS NOT NULL`,
        [languageCode]
      );
      const translated = translatedResult.data?.[0]?.count || 0;

      const approvedResult = await this.db.query(
        `SELECT COUNT(*) as count FROM translation_overrides 
         WHERE language_code = ? AND is_approved = 1`,
        [languageCode]
      );
      const approved = approvedResult.data?.[0]?.count || 0;

      await this.db.query(
        `INSERT OR REPLACE INTO translation_stats 
         (language_code, total_keys, translated_keys, approved_keys, last_updated)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [languageCode, total, translated, approved]
      );

      return { success: true, total, translated, approved };
    } catch (error) {
      console.error('Error updating translation stats:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search translations
   * @param {string} languageCode - Language code
   * @param {string} searchTerm - Search term
   * @returns {Promise<Array>} Matching translations
   */
  async searchTranslations(languageCode, searchTerm) {
    try {
      const result = await this.db.query(
        `SELECT
          tk.id,
          tk.key_path,
          tk.category,
          tk.english_text,
          COALESCE(tov.custom_text, tk.english_text) as translated_text,
          tov.custom_text,
          tov.is_approved
        FROM translation_keys tk
        LEFT JOIN translation_overrides tov ON tk.id = tov.key_id AND tov.language_code = ?
        WHERE tk.is_active = 1 AND (
          tk.key_path LIKE ? OR
          tk.english_text LIKE ? OR
          tov.custom_text LIKE ?
        )
        ORDER BY tk.category, tk.key_path`,
        [languageCode, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`]
      );

      return result.data || [];
    } catch (error) {
      console.error('Error searching translations:', error);
      return [];
    }
  }

  /**
   * Export translations for a language
   * @param {string} languageCode - Language code
   * @returns {Promise<Object>} Exported translations as nested object
   */
  async exportTranslations(languageCode) {
    try {
      // DIRECT RETURN OF LOCALE FILE - BYPASS ALL DATABASE LOGIC
      const fs = require('fs');
      const path = require('path');

      const localeFilePath = path.join(__dirname, '..', 'locales', `${languageCode}.js`);
      if (fs.existsSync(localeFilePath)) {
        let fileContent = fs.readFileSync(localeFilePath, 'utf8');
        fileContent = fileContent.replace(/export\s+default\s+/g, '');
        fileContent = fileContent.trim().replace(/;$/, '');
        const localeData = eval('(' + fileContent + ')');
        return localeData;
      }

      return {};

      if (translations.length === 0) {

        // Fallback: Load directly from locale file
        try {
          const possiblePaths = [
            path.join(__dirname, '..', 'locales', `${languageCode}.js`),
            path.join(__dirname, '..', '..', 'src', 'locales', `${languageCode}.js`),
            path.join(process.cwd(), 'src', 'locales', `${languageCode}.js`),
          ];

          let localeFilePath = null;
          for (const testPath of possiblePaths) {
            if (fs.existsSync(testPath)) {
              localeFilePath = testPath;
              break;
            }
          }

          if (localeFilePath && fs.existsSync(localeFilePath)) {
            let fileContent = fs.readFileSync(localeFilePath, 'utf8');
            fileContent = fileContent.replace(/export\s+default\s+/g, '');
            fileContent = fileContent.trim().replace(/;$/, '');
            const localeData = eval('(' + fileContent + ')');
            return localeData;
          }
        } catch (fallbackError) {
          console.error(`❌ [EXPORT] Fallback to locale file failed:`, fallbackError.message);
        }

        return {};
      }

      const result = {};
      let processedCount = 0;
      let skippedCount = 0;


      for (const trans of translations) {
        // Use the text value - priority: custom_text > locale file > english_text
        // The translated_text field is already set by getTranslationsForLanguage
        const textValue = trans.translated_text || trans.custom_text || trans.english_text;

        // Log first few iterations for debugging
        if (processedCount + skippedCount < 3) {
        }

        // Skip if no text value at all
        if (!textValue || (typeof textValue === 'string' && textValue.trim() === '')) {
          if (skippedCount < 5) {
          }
          skippedCount++;
          continue;
        }

        const parts = trans.key_path.split('.');
        let current = result;

        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) {
            current[parts[i]] = {};
          }
          current = current[parts[i]];
        }

        // Use the text value
        current[parts[parts.length - 1]] = textValue;
        processedCount++;
      }


      // Write debug info to a temp file
      try {
        const debugInfo = {
          languageCode,
          translationsCount: translations.length,
          processedCount,
          skippedCount,
          resultKeys: Object.keys(result),
          sampleTranslations: translations.slice(0, 5).map(t => ({
            key: t.key_path,
            hasText: !!t.translated_text,
            textPreview: t.translated_text ? t.translated_text.substring(0, 50) : null
          }))
        };
        fs.writeFileSync(path.join(process.cwd(), 'export-debug.json'), JSON.stringify(debugInfo, null, 2));
      } catch (debugError) {
        console.error(`❌ [EXPORT] Failed to write debug file:`, debugError.message);
      }

      return result;
    } catch (error) {
      console.error('❌ [EXPORT] Error exporting translations:', error);
      console.error('❌ [EXPORT] Error stack:', error.stack);
      return {};
    }
  }

  /**
   * Import translations from a JSON object
   * @param {string} languageCode - Language code
   * @param {Object} translationsData - Nested object with translations
   * @param {boolean} approveAll - Whether to approve all imported translations
   * @returns {Promise<Object>} Import result with counts
   */
  async importTranslations(languageCode, translationsData, approveAll = false) {
    try {
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;

      // Flatten the nested object into key-value pairs
      const flattenTranslations = (obj, prefix = '') => {
        const result = [];
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          if (typeof value === 'string') {
            result.push({ keyPath: fullKey, translation: value });
          } else if (typeof value === 'object' && value !== null) {
            result.push(...flattenTranslations(value, fullKey));
          }
        }
        return result;
      };

      const flatTranslations = flattenTranslations(translationsData);

      for (const { keyPath, translation } of flatTranslations) {
        try {
          // Find the key in the database
          const keyResult = await this.db.query(
            'SELECT id FROM translation_keys WHERE key_path = ? AND is_active = 1',
            [keyPath]
          );

          if (!keyResult.data || keyResult.data.length === 0) {
            skipped++;
            continue;
          }

          const keyId = keyResult.data[0].id;

          // Check if translation already exists
          const existingResult = await this.db.query(
            'SELECT id, custom_text FROM translation_overrides WHERE key_id = ? AND language_code = ?',
            [keyId, languageCode]
          );

          if (existingResult.data && existingResult.data.length > 0) {
            // Update existing translation
            await this.db.query(
              `UPDATE translation_overrides
               SET custom_text = ?, is_approved = ?, updated_at = CURRENT_TIMESTAMP
               WHERE key_id = ? AND language_code = ?`,
              [translation, approveAll ? 1 : 0, keyId, languageCode]
            );
            updated++;
          } else {
            // Insert new translation
            await this.db.query(
              `INSERT INTO translation_overrides (key_id, language_code, custom_text, is_approved)
               VALUES (?, ?, ?, ?)`,
              [keyId, languageCode, translation, approveAll ? 1 : 0]
            );
            imported++;
          }
        } catch (error) {
          console.error(`Error importing translation for ${keyPath}:`, error);
          errors++;
        }
      }

      // Update stats after import
      await this.updateTranslationStats(languageCode);

      return {
        success: true,
        imported,
        updated,
        skipped,
        errors,
        total: flatTranslations.length
      };
    } catch (error) {
      console.error('Error importing translations:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = TranslationService;

