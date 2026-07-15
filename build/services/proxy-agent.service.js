const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const https = require('https');

/**
 * Proxy Agent Service - Creates proxy agents for HTTP/HTTPS/SOCKS proxies
 * Used to route WhatsApp connections through proxies
 */
class ProxyAgentService {
  constructor() {
    this.activeAgents = new Map(); // sessionId -> agent
  }

  /**
   * Create a proxy agent based on proxy configuration
   * @param {Object} proxy - Proxy configuration from database
   * @param {string} proxy.host - Proxy host
   * @param {number} proxy.port - Proxy port
   * @param {string} proxy.type - Proxy type (http, https, socks4, socks5)
   * @param {string} proxy.username - Optional proxy username
   * @param {string} proxy.password - Optional proxy password
   * @returns {Object} - HTTP/HTTPS agent configured with proxy
   */
  createProxyAgent(proxy) {
    try {
      if (!proxy || !proxy.host || !proxy.port) {
        console.error('❌ Invalid proxy configuration:', proxy);
        return null;
      }

      const proxyType = (proxy.type || 'http').toLowerCase();
      let proxyUrl;
      let agent;

      // Build proxy URL with authentication if provided
      if (proxy.username && proxy.password) {
        proxyUrl = `${proxyType}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
      } else {
        proxyUrl = `${proxyType}://${proxy.host}:${proxy.port}`;
      }


      // Create appropriate agent based on proxy type
      if (proxyType === 'socks' || proxyType === 'socks4' || proxyType === 'socks5') {
        // SOCKS proxy
        agent = new SocksProxyAgent(proxyUrl);
      } else {
        // HTTP/HTTPS proxy
        agent = new HttpsProxyAgent(proxyUrl);
      }

      return agent;
    } catch (error) {
      console.error(`❌ Error creating proxy agent:`, error.message);
      return null;
    }
  }

  /**
   * Set proxy agent for a specific session
   * @param {string} sessionId - WhatsApp session ID
   * @param {Object} proxy - Proxy configuration
   * @returns {Object|null} - Created agent or null
   */
  setSessionProxy(sessionId, proxy) {
    try {
      // Remove existing agent if any
      if (this.activeAgents.has(sessionId)) {
        this.removeSessionProxy(sessionId);
      }

      const agent = this.createProxyAgent(proxy);
      if (agent) {
        this.activeAgents.set(sessionId, {
          agent,
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: proxy.type,
            id: proxy.id
          }
        });
        return agent;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error setting session proxy:`, error.message);
      return null;
    }
  }

  /**
   * Get proxy agent for a session
   * @param {string} sessionId - WhatsApp session ID
   * @returns {Object|null} - Proxy agent or null
   */
  getSessionProxy(sessionId) {
    const proxyData = this.activeAgents.get(sessionId);
    return proxyData ? proxyData.agent : null;
  }

  /**
   * Get proxy info for a session
   * @param {string} sessionId - WhatsApp session ID
   * @returns {Object|null} - Proxy info or null
   */
  getSessionProxyInfo(sessionId) {
    const proxyData = this.activeAgents.get(sessionId);
    return proxyData ? proxyData.proxy : null;
  }

  /**
   * Remove proxy agent for a session
   * @param {string} sessionId - WhatsApp session ID
   */
  removeSessionProxy(sessionId) {
    if (this.activeAgents.has(sessionId)) {
      const proxyData = this.activeAgents.get(sessionId);
      
      // Destroy the agent to clean up connections
      if (proxyData.agent && typeof proxyData.agent.destroy === 'function') {
        proxyData.agent.destroy();
      }
      
      this.activeAgents.delete(sessionId);
    }
  }

  /**
   * Clear all proxy agents
   */
  clearAll() {
    
    for (const [sessionId, proxyData] of this.activeAgents.entries()) {
      if (proxyData.agent && typeof proxyData.agent.destroy === 'function') {
        proxyData.agent.destroy();
      }
    }
    
    this.activeAgents.clear();
  }

  /**
   * Get fetch options with proxy agent
   * @param {string} sessionId - WhatsApp session ID
   * @returns {Object} - Fetch options with agent
   */
  getFetchOptions(sessionId) {
    const agent = this.getSessionProxy(sessionId);
    if (agent) {
      return {
        agent: (parsedURL) => {
          // Use the proxy agent for both HTTP and HTTPS
          return agent;
        }
      };
    }
    return {};
  }

  /**
   * Get axios config with proxy agent
   * @param {string} sessionId - WhatsApp session ID
   * @returns {Object} - Axios config with proxy
   */
  getAxiosConfig(sessionId) {
    const agent = this.getSessionProxy(sessionId);
    if (agent) {
      return {
        httpAgent: agent,
        httpsAgent: agent
      };
    }
    return {};
  }
}

module.exports = ProxyAgentService;

