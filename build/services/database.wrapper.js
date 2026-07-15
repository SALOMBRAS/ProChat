/**
 * Database Wrapper Service
 * Provides a consistent interface for database operations
 * Ensures all queries return predictable data structures
 */

const DatabaseService = require('./database.service');

class DatabaseWrapper {
  constructor() {
    this.db = null;
  }

  async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  /**
   * Execute a SELECT query and always return an array
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Array} - Always returns an array, empty if no results
   */
  async select(sql, params = []) {
    try {
      const result = await this.db.query(sql, params);
      if (result.success && Array.isArray(result.data)) {
        return result.data;
      }
      return [];
    } catch (error) {
      console.error('Database select error:', error);
      return [];
    }
  }

  /**
   * Execute a SELECT query and return the first row or null
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Object|null} - First row or null if no results
   */
  async selectOne(sql, params = []) {
    try {
      const result = await this.db.query(sql, params);
      if (result.success && Array.isArray(result.data) && result.data.length > 0) {
        return result.data[0];
      }
      return null;
    } catch (error) {
      console.error('Database selectOne error:', error);
      return null;
    }
  }

  /**
   * Execute an INSERT/UPDATE/DELETE query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Object} - Result with success, lastID, changes
   */
  async execute(sql, params = []) {
    try {
      const result = await this.db.query(sql, params);
      return {
        success: result.success || false,
        lastID: result.lastID || null,
        changes: result.changes || 0,
        error: result.error || null
      };
    } catch (error) {
      console.error('Database execute error:', error);
      return {
        success: false,
        lastID: null,
        changes: 0,
        error: error.message
      };
    }
  }

  /**
   * Execute a raw query with full result object
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Object} - Full result object
   */
  async raw(sql, params = []) {
    try {
      return await this.db.query(sql, params);
    } catch (error) {
      console.error('Database raw error:', error);
      return {
        success: false,
        error: error.message,
        data: sql.trim().toUpperCase().startsWith('SELECT') ? [] : null
      };
    }
  }
}

// Create a singleton instance
let instance = null;

const getDatabaseWrapper = async () => {
  if (!instance) {
    instance = new DatabaseWrapper();
    await instance.initialize();
  }
  return instance;
};

module.exports = { DatabaseWrapper, getDatabaseWrapper };
