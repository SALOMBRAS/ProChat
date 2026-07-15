const DatabaseService = require('../services/database.service');

class WhatsAppGroup {
  constructor(data = {}) {
    this.id = data.id || null;
    this.groupId = data.group_id || data.groupId; // WhatsApp group ID
    this.sessionId = data.session_id || data.sessionId; // Associated WhatsApp session
    this.name = data.name || data.subject;
    this.description = data.description || data.desc;
    this.participants = data.participants ? 
      (typeof data.participants === 'string' ? JSON.parse(data.participants) : data.participants) : [];
    this.admins = data.admins ? 
      (typeof data.admins === 'string' ? JSON.parse(data.admins) : data.admins) : [];
    this.isOwner = data.is_owner !== undefined ? data.is_owner : data.isOwner !== undefined ? data.isOwner : false;
    this.isAdmin = data.is_admin !== undefined ? data.is_admin : data.isAdmin !== undefined ? data.isAdmin : false;
    this.inviteCode = data.invite_code || data.inviteCode;
    this.inviteLink = data.invite_link || data.inviteLink;
    this.profilePicture = data.profile_picture || data.profilePicture;
    this.creation = data.creation;
    this.participantCount = data.participant_count || data.participantCount || (this.participants ? this.participants.length : 0);
    this.settings = data.settings ? 
      (typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings) : {};
    this.lastSync = data.last_sync || data.lastSync;
    this.isActive = data.is_active !== undefined ? data.is_active : data.isActive !== undefined ? data.isActive : true;
    this.createdAt = data.created_at || data.createdAt;
    this.updatedAt = data.updated_at || data.updatedAt;
  }

  static async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  static async findAll(sessionId = null) {
    let query = 'SELECT * FROM whatsapp_groups WHERE is_active = 1';
    let params = [];
    
    if (sessionId) {
      query += ' AND session_id = ?';
      params.push(sessionId);
    }
    
    query += ' ORDER BY name ASC';
    
    const rows = await this.db.all(query, params);
    return rows.map(row => new WhatsAppGroup(row));
  }

  static async findById(id) {
    const row = await this.db.get('SELECT * FROM whatsapp_groups WHERE id = ?', [id]);
    return row ? new WhatsAppGroup(row) : null;
  }

  static async findByGroupId(groupId, sessionId = null) {
    let query = 'SELECT * FROM whatsapp_groups WHERE group_id = ?';
    let params = [groupId];
    
    if (sessionId) {
      query += ' AND session_id = ?';
      params.push(sessionId);
    }
    
    const row = await this.db.get(query, params);
    return row ? new WhatsAppGroup(row) : null;
  }

  static async findBySession(sessionId) {
    const rows = await this.db.all('SELECT * FROM whatsapp_groups WHERE session_id = ? AND is_active = 1 ORDER BY name ASC', [sessionId]);
    return rows.map(row => new WhatsAppGroup(row));
  }

  static async findAdminGroups(sessionId) {
    const rows = await this.db.all('SELECT * FROM whatsapp_groups WHERE session_id = ? AND is_admin = 1 AND is_active = 1 ORDER BY name ASC', [sessionId]);
    return rows.map(row => new WhatsAppGroup(row));
  }

  async save() {
    const now = new Date().toISOString();
    
    // Serialize complex fields
    const participantsJson = JSON.stringify(this.participants || []);
    const adminsJson = JSON.stringify(this.admins || []);
    const settingsJson = JSON.stringify(this.settings || {});

    if (this.id) {
      // Update existing record
      const result = await WhatsAppGroup.db.run(`
        UPDATE whatsapp_groups
        SET group_id = ?, session_id = ?, name = ?, description = ?, participants = ?, admins = ?,
            is_owner = ?, is_admin = ?, invite_code = ?, invite_link = ?, profile_picture = ?,
            creation = ?, participant_count = ?, settings = ?, last_sync = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `, [
        this.groupId, this.sessionId, this.name, this.description, participantsJson, adminsJson,
        this.isOwner, this.isAdmin, this.inviteCode, this.inviteLink, this.profilePicture,
        this.creation, this.participantCount, settingsJson, this.lastSync, this.isActive, now, this.id
      ]);

      this.updatedAt = now;
      return result;
    } else {
      // Create new record
      const result = await WhatsAppGroup.db.run(`
        INSERT INTO whatsapp_groups
        (group_id, session_id, name, description, participants, admins, is_owner, is_admin,
         invite_code, invite_link, profile_picture, creation, participant_count, settings,
         last_sync, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        this.groupId, this.sessionId, this.name, this.description, participantsJson, adminsJson,
        this.isOwner, this.isAdmin, this.inviteCode, this.inviteLink, this.profilePicture,
        this.creation, this.participantCount, settingsJson, this.lastSync, this.isActive, now, now
      ]);

      this.id = result.lastID;
      this.createdAt = now;
      this.updatedAt = now;
      return result;
    }
  }

  async delete() {
    if (this.id) {
      await WhatsAppGroup.db.run('UPDATE whatsapp_groups SET is_active = 0 WHERE id = ?', [this.id]);
      this.isActive = false;
    }
  }

  async hardDelete() {
    if (this.id) {
      await WhatsAppGroup.db.run('DELETE FROM whatsapp_groups WHERE id = ?', [this.id]);
    }
  }

  // Update group metadata from WhatsApp
  async updateFromMetadata(metadata) {
    this.name = metadata.subject || this.name;
    this.description = metadata.desc || this.description;
    this.participants = metadata.participants || this.participants;
    this.admins = metadata.participants ? 
      metadata.participants.filter(p => p.admin).map(p => p.id) : this.admins;
    this.participantCount = metadata.participants ? metadata.participants.length : this.participantCount;
    this.creation = metadata.creation || this.creation;
    
    // Check if current user is admin/owner
    const currentUserJid = metadata.currentUserJid;
    if (currentUserJid && metadata.participants) {
      const currentUser = metadata.participants.find(p => p.id === currentUserJid);
      if (currentUser) {
        this.isAdmin = currentUser.admin === 'admin' || currentUser.admin === 'superadmin';
        this.isOwner = currentUser.admin === 'superadmin';
      }
    }

    this.lastSync = new Date().toISOString();
    return await this.save();
  }

  // Add participant to local record
  addParticipant(participantId, participantData = {}) {
    if (!this.participants.find(p => p.id === participantId)) {
      this.participants.push({
        id: participantId,
        name: participantData.name || null,
        admin: participantData.admin || null,
        ...participantData
      });
      this.participantCount = this.participants.length;
    }
  }

  // Remove participant from local record
  removeParticipant(participantId) {
    this.participants = this.participants.filter(p => p.id !== participantId);
    this.participantCount = this.participants.length;
    
    // Also remove from admins if they were admin
    this.admins = this.admins.filter(adminId => adminId !== participantId);
  }

  // Update participant admin status
  updateParticipantAdmin(participantId, isAdmin) {
    const participant = this.participants.find(p => p.id === participantId);
    if (participant) {
      participant.admin = isAdmin ? 'admin' : null;
      
      if (isAdmin && !this.admins.includes(participantId)) {
        this.admins.push(participantId);
      } else if (!isAdmin) {
        this.admins = this.admins.filter(adminId => adminId !== participantId);
      }
    }
  }

  // Get participant by ID
  getParticipant(participantId) {
    return this.participants.find(p => p.id === participantId);
  }

  // Check if user is admin
  isParticipantAdmin(participantId) {
    return this.admins.includes(participantId);
  }

  // Update group settings
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getParticipantsArray() {
    return Array.isArray(this.participants) ? this.participants : [];
  }

  getAdminsArray() {
    return Array.isArray(this.admins) ? this.admins : [];
  }

  getSettingsObject() {
    return typeof this.settings === 'object' ? this.settings : {};
  }

  toJSON() {
    return {
      id: this.id,
      groupId: this.groupId,
      sessionId: this.sessionId,
      name: this.name,
      description: this.description,
      participants: this.getParticipantsArray(),
      admins: this.getAdminsArray(),
      isOwner: this.isOwner,
      isAdmin: this.isAdmin,
      inviteCode: this.inviteCode,
      inviteLink: this.inviteLink,
      profilePicture: this.profilePicture,
      creation: this.creation,
      participantCount: this.participantCount,
      settings: this.getSettingsObject(),
      lastSync: this.lastSync,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static async bulkSync(sessionId, groupsData) {
    const results = {
      created: 0,
      updated: 0,
      errors: []
    };

    for (const groupData of groupsData) {
      try {
        const existingGroup = await WhatsAppGroup.findByGroupId(groupData.id, sessionId);
        
        if (existingGroup) {
          await existingGroup.updateFromMetadata(groupData);
          results.updated++;
        } else {
          const newGroup = new WhatsAppGroup({
            groupId: groupData.id,
            sessionId: sessionId,
            name: groupData.subject,
            description: groupData.desc,
            participants: groupData.participants || [],
            creation: groupData.creation
          });
          
          await newGroup.updateFromMetadata(groupData);
          results.created++;
        }
      } catch (error) {
        console.error('Error syncing group:', groupData.id, error);
        results.errors.push(`${groupData.subject || groupData.id}: ${error.message}`);
      }
    }

    return results;
  }

  static async getStats(sessionId = null) {
    try {
      let baseQuery = 'FROM whatsapp_groups WHERE is_active = 1';
      let params = [];
      
      if (sessionId) {
        baseQuery += ' AND session_id = ?';
        params.push(sessionId);
      }

      const totalResult = await WhatsAppGroup.db.get(`SELECT COUNT(*) as count ${baseQuery}`, params);
      const adminResult = await WhatsAppGroup.db.get(`SELECT COUNT(*) as count ${baseQuery} AND is_admin = 1`, params);
      const ownerResult = await WhatsAppGroup.db.get(`SELECT COUNT(*) as count ${baseQuery} AND is_owner = 1`, params);
      const participantsResult = await WhatsAppGroup.db.get(`SELECT SUM(participant_count) as count ${baseQuery}`, params);

      return {
        totalGroups: totalResult.count || 0,
        adminGroups: adminResult.count || 0,
        ownerGroups: ownerResult.count || 0,
        totalParticipants: participantsResult.count || 0
      };
    } catch (error) {
      console.error('Error getting WhatsApp group stats:', error);
      return {
        totalGroups: 0,
        adminGroups: 0,
        ownerGroups: 0,
        totalParticipants: 0
      };
    }
  }

  static async search(query, sessionId = null) {
    let sqlQuery = `
      SELECT * FROM whatsapp_groups 
      WHERE (name LIKE ? OR description LIKE ?) AND is_active = 1
    `;
    let params = [`%${query}%`, `%${query}%`];
    
    if (sessionId) {
      sqlQuery += ' AND session_id = ?';
      params.push(sessionId);
    }
    
    sqlQuery += ' ORDER BY name ASC';
    
    const rows = await this.db.all(sqlQuery, params);
    return rows.map(row => new WhatsAppGroup(row));
  }
}

module.exports = WhatsAppGroup;