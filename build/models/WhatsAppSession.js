const DatabaseService = require('../services/database.service');

class WhatsAppSession {
  constructor(data = {}) {
    this.id = data.id || null;
    this.sessionId = data.session_id || data.sessionId;
    this.name = data.name;
    this.deviceName = data.device_name || data.deviceName || data.name; // Handle both columns
    this.phoneNumber = data.phone_number || data.phoneNumber;
    this.status = data.status || 'disconnected';
    this.qrCode = data.qr_code || data.qrCode;
    this.lastConnected = data.last_connected || data.lastConnected;
    this.isActive = data.is_active !== undefined ? data.is_active : data.isActive !== undefined ? data.isActive : true;
    this.sessionData = data.session_data || data.sessionData;
    this.createdAt = data.created_at || data.createdAt;
    this.updatedAt = data.updated_at || data.updatedAt;
  }

  static async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  static async findAll() {
    const result = await this.db.query('SELECT * FROM whatsapp_sessions WHERE is_active = 1 ORDER BY created_at DESC');
    const rows = result.success ? result.data : [];
    return rows.map(row => new WhatsAppSession(row));
  }

  static async findById(id) {
    const result = await this.db.query('SELECT * FROM whatsapp_sessions WHERE id = ?', [id]);
    const row = result.success && result.data.length > 0 ? result.data[0] : null;
    return row ? new WhatsAppSession(row) : null;
  }

  static async findBySessionId(sessionId) {
    const row = await this.db.get('SELECT * FROM whatsapp_sessions WHERE session_id = ?', [sessionId]);
    return row ? new WhatsAppSession(row) : null;
  }

  static async findConnected() {
    const rows = await this.db.all('SELECT * FROM whatsapp_sessions WHERE status = ? AND is_active = 1', ['connected']);
    return rows.map(row => new WhatsAppSession(row));
  }

  async save() {
    
    const now = new Date().toISOString();
    
    if (this.id) {
      // Update existing record
      const result = await WhatsAppSession.db.run(`
        UPDATE whatsapp_sessions 
        SET session_id = ?, name = ?, device_name = ?, phone_number = ?, status = ?, qr_code = ?, 
            last_connected = ?, is_active = ?, session_data = ?, updated_at = ?
        WHERE id = ?
      `, [
        this.sessionId, this.name, this.deviceName, this.phoneNumber, this.status, this.qrCode,
        this.lastConnected, this.isActive, this.sessionData, now, this.id
      ]);
      
      this.updatedAt = now;
      return result;
    } else {
      // Create new record
      const result = await WhatsAppSession.db.run(`
        INSERT INTO whatsapp_sessions 
        (session_id, name, device_name, phone_number, status, qr_code, last_connected, is_active, session_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        this.sessionId, this.name, this.deviceName, this.phoneNumber, this.status, this.qrCode,
        this.lastConnected, this.isActive, this.sessionData, now, now
      ]);
      
      this.id = result.id;
      this.createdAt = now;
      this.updatedAt = now;
      return result;
    }
  }

  async delete() {
    if (this.id) {
      await WhatsAppSession.db.run('UPDATE whatsapp_sessions SET is_active = 0 WHERE id = ?', [this.id]);
      this.isActive = false;
    }
  }

  async updateStatus(status, qrCode = null) {
    this.status = status;
    if (qrCode !== null) {
      this.qrCode = qrCode;
    }
    if (status === 'connected') {
      this.lastConnected = new Date().toISOString();
    }
    return await this.save();
  }

  async updateSessionData(sessionData) {
    this.sessionData = typeof sessionData === 'object' ? JSON.stringify(sessionData) : sessionData;
    return await this.save();
  }

  getSessionDataObject() {
    if (!this.sessionData) return null;
    try {
      return typeof this.sessionData === 'string' ? JSON.parse(this.sessionData) : this.sessionData;
    } catch (error) {
      console.error('Error parsing session data:', error);
      return null;
    }
  }

  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      name: this.name,
      deviceName: this.deviceName,
      phoneNumber: this.phoneNumber,
      status: this.status,
      qrCode: this.qrCode,
      lastConnected: this.lastConnected,
      isActive: this.isActive,
      sessionData: this.getSessionDataObject(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static async create(data) {
    
    const session = new WhatsAppSession(data);
    
    await session.save();
    
    return session;
  }

  static async getStats() {
    const result = await WhatsAppSession.db.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM whatsapp_sessions
      WHERE is_active = 1
      GROUP BY status
    `);
    const stats = result.success ? result.data : [];

    const statsResult = {
      total: 0,
      connected: 0,
      connecting: 0,
      disconnected: 0
    };

    stats.forEach(stat => {
      statsResult[stat.status] = stat.count;
      statsResult.total += stat.count;
    });

    return statsResult;
  }
}

module.exports = WhatsAppSession; 