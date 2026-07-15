const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * Proxy Service - Manages proxy6.net integration
 * Handles purchasing, managing, and using proxies for WhatsApp campaigns
 */
class ProxyService extends EventEmitter {
  constructor(databaseService) {
    super();
    this.databaseService = databaseService;
    this.apiBaseUrl = 'https://px6.link/api';
    this.encryptionKey = 'leadwave-proxy-encryption-key-2024'; // Should be stored securely
    this.rateLimitDelay = 350; // 350ms between requests (max 3 per second)
    this.lastRequestTime = 0;
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(text) {
    try {
      const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    } catch (error) {
      console.error('Encryption error:', error);
      return text;
    }
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedText) {
    try {
      const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      return encryptedText;
    }
  }

  /**
   * Rate limiting - ensure we don't exceed 3 requests per second
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Make API request to proxy6.net
   */
  async makeApiRequest(method, params = {}) {
    await this.rateLimit();

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('API key not configured');
    }

    const queryParams = new URLSearchParams(params).toString();
    const url = `${this.apiBaseUrl}/${apiKey}${method ? '/' + method : ''}${queryParams ? '?' + queryParams : ''}`;


    try {
      const fetch = require('node-fetch');
      const response = await fetch(url);
      const data = await response.json();


      if (data.status === 'no') {
        throw new Error(data.error || 'API request failed');
      }

      return data;
    } catch (error) {
      console.error('❌ Proxy6.net API error:', error);
      throw error;
    }
  }

  /**
   * Save API key
   */
  async saveApiKey(apiKey) {
    try {
      const encryptedKey = this.encrypt(apiKey);
      
      // Check if settings exist
      const existing = await this.databaseService.query(
        'SELECT id FROM proxy_settings WHERE id = 1'
      );

      if (existing.success && existing.data.length > 0) {
        await this.databaseService.query(
          'UPDATE proxy_settings SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
          [encryptedKey]
        );
      } else {
        await this.databaseService.query(
          'INSERT INTO proxy_settings (id, api_key) VALUES (1, ?)',
          [encryptedKey]
        );
      }

      // Sync account info
      await this.syncAccountInfo();

      return { success: true };
    } catch (error) {
      console.error('Error saving API key:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get API key
   */
  async getApiKey() {
    try {
      const result = await this.databaseService.query(
        'SELECT api_key FROM proxy_settings WHERE id = 1'
      );

      if (result.success && result.data.length > 0) {
        return this.decrypt(result.data[0].api_key);
      }

      return null;
    } catch (error) {
      console.error('Error getting API key:', error);
      return null;
    }
  }

  /**
   * Get proxy settings
   */
  async getSettings() {
    try {
      const result = await this.databaseService.query(
        'SELECT * FROM proxy_settings WHERE id = 1'
      );

      if (result.success && result.data.length > 0) {
        const settings = result.data[0];
        // Don't return the encrypted API key
        return {
          hasApiKey: !!settings.api_key,
          balance: settings.balance,
          currency: settings.currency,
          last_sync: settings.last_sync
        };
      }

      return { hasApiKey: false, balance: 0, currency: 'USD', last_sync: null };
    } catch (error) {
      console.error('Error getting settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync account info from proxy6.net
   */
  async syncAccountInfo() {
    try {
      const data = await this.makeApiRequest('');

      await this.databaseService.query(
        'UPDATE proxy_settings SET balance = ?, currency = ?, last_sync = CURRENT_TIMESTAMP WHERE id = 1',
        [parseFloat(data.balance), data.currency]
      );

      return { success: true, balance: data.balance, currency: data.currency };
    } catch (error) {
      console.error('Error syncing account info:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get price for proxies
   */
  async getPrice(count, period, version = 6) {
    try {
      const data = await this.makeApiRequest('getprice', { count, period, version });
      return {
        success: true,
        price: data.price,
        price_single: data.price_single,
        period: data.period,
        count: data.count
      };
    } catch (error) {
      console.error('Error getting price:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get available countries
   */
  async getCountries(version = 6) {
    try {
      const data = await this.makeApiRequest('getcountry', { version });
      return { success: true, countries: data.list };
    } catch (error) {
      console.error('Error getting countries:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get available proxy count for a country
   */
  async getCount(country, version = 6) {
    try {
      const data = await this.makeApiRequest('getcount', { country, version });
      return { success: true, count: data.count };
    } catch (error) {
      console.error('Error getting count:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Buy proxies
   */
  async buyProxy(count, period, country, version = 6, type = 'http', description = '', autoProlong = false) {
    try {
      const params = { count, period, country, version, type };
      
      if (description) {
        params.descr = description;
      }
      
      if (autoProlong) {
        params.auto_prolong = '';
      }

      const data = await this.makeApiRequest('buy', params);

      // Save proxies to database
      if (data.list) {
        for (const [key, proxy] of Object.entries(data.list)) {
          await this.databaseService.query(
            `INSERT INTO proxies (
              proxy6_id, ip, host, port, username, password, type, country, version,
              date_purchased, date_expires, is_active, description, auto_renew
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              proxy.id,
              proxy.ip,
              proxy.host,
              proxy.port,
              proxy.user,
              proxy.pass,
              proxy.type,
              country,
              version,
              proxy.date,
              proxy.date_end,
              proxy.active === '1' ? 1 : 0,
              description,
              autoProlong ? 1 : 0
            ]
          );
        }
      }

      // Update balance
      await this.syncAccountInfo();

      this.emit('proxies-purchased', { count, country, price: data.price });

      return {
        success: true,
        order_id: data.order_id,
        count: data.count,
        price: data.price,
        proxies: data.list
      };
    } catch (error) {
      console.error('Error buying proxies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get proxies from proxy6.net and sync to database
   */
  async syncProxies(state = 'active') {
    try {
      const data = await this.makeApiRequest('getproxy', { state });


      if (data.list) {
        // Clear existing proxies if syncing all
        if (state === 'all') {
          await this.databaseService.query('DELETE FROM proxies');
        }

        let syncedCount = 0;
        for (const [key, proxy] of Object.entries(data.list)) {

          // Check if proxy exists
          const existing = await this.databaseService.query(
            'SELECT id FROM proxies WHERE proxy6_id = ?',
            [proxy.id]
          );

          if (existing.success && existing.data.length > 0) {
            // Update existing
            await this.databaseService.query(
              `UPDATE proxies SET
                ip = ?, host = ?, port = ?, username = ?, password = ?, type = ?,
                country = ?, date_purchased = ?, date_expires = ?, is_active = ?,
                description = ?, updated_at = CURRENT_TIMESTAMP
              WHERE proxy6_id = ?`,
              [
                proxy.ip, proxy.host, proxy.port, proxy.user, proxy.pass, proxy.type,
                proxy.country, proxy.date, proxy.date_end, proxy.active === '1' ? 1 : 0,
                proxy.descr || '', proxy.id
              ]
            );
          } else {
            // Insert new
            await this.databaseService.query(
              `INSERT INTO proxies (
                proxy6_id, ip, host, port, username, password, type, country,
                date_purchased, date_expires, is_active, description
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                proxy.id, proxy.ip, proxy.host, proxy.port, proxy.user, proxy.pass,
                proxy.type, proxy.country, proxy.date, proxy.date_end,
                proxy.active === '1' ? 1 : 0, proxy.descr || ''
              ]
            );
          }
          syncedCount++;
        }

      } else {
      }

      this.emit('proxies-synced', { count: data.list_count || 0 });

      return { success: true, count: data.list_count || 0 };
    } catch (error) {
      console.error('❌ Error syncing proxies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get local proxies from database
   */
  async getProxies(filters = {}) {
    try {
      let query = 'SELECT * FROM proxies WHERE 1=1';
      const params = [];

      if (filters.country) {
        query += ' AND country = ?';
        params.push(filters.country);
      }

      if (filters.is_active !== undefined) {
        query += ' AND is_active = ?';
        params.push(filters.is_active ? 1 : 0);
      }

      if (filters.version) {
        query += ' AND version = ?';
        params.push(filters.version);
      }

      if (filters.type) {
        query += ' AND type = ?';
        params.push(filters.type);
      }

      query += ' ORDER BY date_expires DESC';

      const result = await this.databaseService.query(query, params);

      if (result.success) {
        return { success: true, proxies: result.data };
      }

      return { success: false, error: 'Failed to fetch proxies' };
    } catch (error) {
      console.error('Error getting proxies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extend proxy validity
   */
  async prolongProxy(proxyIds, period) {
    try {
      const ids = Array.isArray(proxyIds) ? proxyIds : [proxyIds];

      // Get proxy6_ids from database
      const result = await this.databaseService.query(
        `SELECT proxy6_id FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );

      if (!result.success || result.data.length === 0) {
        throw new Error('Proxies not found');
      }

      const proxy6Ids = result.data.map(p => p.proxy6_id).join(',');

      const data = await this.makeApiRequest('prolong', { period, ids: proxy6Ids });

      // Update local database
      if (data.list) {
        for (const [key, proxy] of Object.entries(data.list)) {
          await this.databaseService.query(
            'UPDATE proxies SET date_expires = ?, updated_at = CURRENT_TIMESTAMP WHERE proxy6_id = ?',
            [proxy.date_end, proxy.id]
          );
        }
      }

      // Update balance
      await this.syncAccountInfo();

      this.emit('proxies-extended', { count: data.count, price: data.price });

      return {
        success: true,
        count: data.count,
        price: data.price
      };
    } catch (error) {
      console.error('Error extending proxies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete proxies
   */
  async deleteProxy(proxyIds) {
    try {
      const ids = Array.isArray(proxyIds) ? proxyIds : [proxyIds];

      // Get proxy6_ids from database
      const result = await this.databaseService.query(
        `SELECT proxy6_id FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );

      if (!result.success || result.data.length === 0) {
        throw new Error('Proxies not found');
      }

      const proxy6Ids = result.data.map(p => p.proxy6_id).join(',');

      const data = await this.makeApiRequest('delete', { ids: proxy6Ids });

      // Delete from local database
      await this.databaseService.query(
        `DELETE FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );

      this.emit('proxies-deleted', { count: data.count });

      return { success: true, count: data.count };
    } catch (error) {
      console.error('Error deleting proxies:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check proxy validity
   */
  async checkProxy(proxyId) {
    try {
      const result = await this.databaseService.query(
        'SELECT proxy6_id FROM proxies WHERE id = ?',
        [proxyId]
      );

      if (!result.success || result.data.length === 0) {
        throw new Error('Proxy not found');
      }

      const data = await this.makeApiRequest('check', { ids: result.data[0].proxy6_id });

      // Update local database
      await this.databaseService.query(
        'UPDATE proxies SET is_valid = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?',
        [data.proxy_status ? 1 : 0, proxyId]
      );

      return { success: true, is_valid: data.proxy_status };
    } catch (error) {
      console.error('Error checking proxy:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Change proxy type (HTTP/SOCKS5)
   */
  async setProxyType(proxyIds, type) {
    try {
      const ids = Array.isArray(proxyIds) ? proxyIds : [proxyIds];

      // Get proxy6_ids from database
      const result = await this.databaseService.query(
        `SELECT proxy6_id FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );

      if (!result.success || result.data.length === 0) {
        throw new Error('Proxies not found');
      }

      const proxy6Ids = result.data.map(p => p.proxy6_id).join(',');

      await this.makeApiRequest('settype', { ids: proxy6Ids, type });

      // Update local database
      await this.databaseService.query(
        `UPDATE proxies SET type = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')})`,
        [type, ...ids]
      );

      return { success: true };
    } catch (error) {
      console.error('Error setting proxy type:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get proxy statistics
   */
  async getStatistics() {
    try {
      const stats = {};

      // Total proxies
      const total = await this.databaseService.query('SELECT COUNT(*) as count FROM proxies');
      stats.total = total.data[0].count;

      // Active proxies
      const active = await this.databaseService.query('SELECT COUNT(*) as count FROM proxies WHERE is_active = 1');
      stats.active = active.data[0].count;

      // Expired proxies
      const expired = await this.databaseService.query(
        "SELECT COUNT(*) as count FROM proxies WHERE date_expires < datetime('now')"
      );
      stats.expired = expired.data[0].count;

      // Expiring soon (within 7 days)
      const expiring = await this.databaseService.query(
        "SELECT COUNT(*) as count FROM proxies WHERE date_expires BETWEEN datetime('now') AND datetime('now', '+7 days')"
      );
      stats.expiring_soon = expiring.data[0].count;

      // By country
      const byCountry = await this.databaseService.query(
        'SELECT country, COUNT(*) as count FROM proxies GROUP BY country'
      );
      stats.by_country = byCountry.data;

      // By type
      const byType = await this.databaseService.query(
        'SELECT type, COUNT(*) as count FROM proxies GROUP BY type'
      );
      stats.by_type = byType.data;

      return { success: true, statistics: stats };
    } catch (error) {
      console.error('Error getting statistics:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Assign proxy to campaign
   */
  async assignProxyToCampaign(campaignId, proxyId, sessionId = null) {
    try {
      await this.databaseService.query(
        'INSERT INTO campaign_proxy_assignments (campaign_id, proxy_id, session_id) VALUES (?, ?, ?)',
        [campaignId, proxyId, sessionId]
      );

      return { success: true };
    } catch (error) {
      console.error('Error assigning proxy to campaign:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get proxy for campaign
   */
  async getProxyForCampaign(campaignId, sessionId = null) {
    try {
      let query = `
        SELECT p.* FROM proxies p
        INNER JOIN campaign_proxy_assignments cpa ON p.id = cpa.proxy_id
        WHERE cpa.campaign_id = ? AND p.is_active = 1
      `;
      const params = [campaignId];

      if (sessionId) {
        query += ' AND (cpa.session_id = ? OR cpa.session_id IS NULL)';
        params.push(sessionId);
      }

      query += ' LIMIT 1';

      const result = await this.databaseService.query(query, params);

      if (result.success && result.data.length > 0) {
        return { success: true, proxy: result.data[0] };
      }

      return { success: false, error: 'No proxy assigned to campaign' };
    } catch (error) {
      console.error('Error getting proxy for campaign:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Log proxy usage
   */
  async logProxyUsage(proxyId, campaignId, sessionId, messagesSent = 1) {
    try {
      await this.databaseService.query(
        'INSERT INTO proxy_usage_logs (proxy_id, campaign_id, session_id, messages_sent) VALUES (?, ?, ?, ?)',
        [proxyId, campaignId, sessionId, messagesSent]
      );

      return { success: true };
    } catch (error) {
      console.error('Error logging proxy usage:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = ProxyService;
