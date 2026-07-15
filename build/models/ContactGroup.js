const DatabaseService = require('../services/database.service');

class ContactGroup {
  constructor(data = {}) {
    this.id = data.id || null;
    this.name = data.name;
    this.description = data.description;
    this.color = data.color || '#3b82f6';
    this.isActive = data.is_active !== undefined ? data.is_active : data.isActive !== undefined ? data.isActive : true;
    this.createdAt = data.created_at || data.createdAt;
    this.updatedAt = data.updated_at || data.updatedAt;
    this.contactCount = data.contact_count || 0;
  }

  static async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  static async findAll() {
    const rows = await this.db.all(`
      SELECT cg.*, COUNT(cgm.contact_id) as contact_count
      FROM contact_groups cg
      LEFT JOIN contact_group_members cgm ON cg.id = cgm.group_id
      WHERE cg.is_active = 1
      GROUP BY cg.id
      ORDER BY cg.name ASC
    `);
    return rows.map(row => new ContactGroup(row));
  }

  static async findById(id) {
    const row = await this.db.get(`
      SELECT cg.*, COUNT(cgm.contact_id) as contact_count
      FROM contact_groups cg
      LEFT JOIN contact_group_members cgm ON cg.id = cgm.group_id
      WHERE cg.id = ? AND cg.is_active = 1
      GROUP BY cg.id
    `, [id]);
    return row ? new ContactGroup(row) : null;
  }

  static async findByName(name) {
    const row = await this.db.get('SELECT * FROM contact_groups WHERE name = ? AND is_active = 1', [name]);
    return row ? new ContactGroup(row) : null;
  }

  async save() {
    const now = new Date().toISOString();
    
    if (this.id) {
      // Update existing record
      const result = await ContactGroup.db.run(`
        UPDATE contact_groups 
        SET name = ?, description = ?, color = ?, updated_at = ?
        WHERE id = ?
      `, [this.name, this.description, this.color, now, this.id]);
      
      this.updatedAt = now;
      return result;
    } else {
      // Create new record
      const result = await ContactGroup.db.run(`
        INSERT INTO contact_groups (name, description, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `, [this.name, this.description, this.color, now, now]);
      
      this.id = result.lastID;
      this.createdAt = now;
      this.updatedAt = now;
      return result;
    }
  }

  async delete() {
    if (this.id) {
      // Remove all members first
      await ContactGroup.db.run('DELETE FROM contact_group_members WHERE group_id = ?', [this.id]);
      // Soft delete the group
      await ContactGroup.db.run('UPDATE contact_groups SET is_active = 0 WHERE id = ?', [this.id]);
      this.isActive = false;
    }
  }

  async addContact(contactId) {
    if (this.id && contactId) {
      try {
        await ContactGroup.db.run(`
          INSERT OR IGNORE INTO contact_group_members (group_id, contact_id)
          VALUES (?, ?)
        `, [this.id, contactId]);
        return true;
      } catch (error) {
        console.error('Error adding contact to group:', error);
        return false;
      }
    }
    return false;
  }

  async removeContact(contactId) {
    if (this.id && contactId) {
      await ContactGroup.db.run(`
        DELETE FROM contact_group_members 
        WHERE group_id = ? AND contact_id = ?
      `, [this.id, contactId]);
    }
  }

  async addContacts(contactIds) {
    if (!this.id || !Array.isArray(contactIds) || contactIds.length === 0) {
      return false;
    }

    try {
      const placeholders = contactIds.map(() => '(?, ?)').join(', ');
      const values = contactIds.flatMap(contactId => [this.id, contactId]);
      
      await ContactGroup.db.run(`
        INSERT OR IGNORE INTO contact_group_members (group_id, contact_id)
        VALUES ${placeholders}
      `, values);
      
      return true;
    } catch (error) {
      console.error('Error adding contacts to group:', error);
      return false;
    }
  }

  async getContacts() {
    if (!this.id) return [];
    
    const rows = await ContactGroup.db.all(`
      SELECT c.* FROM contacts c
      JOIN contact_group_members cgm ON c.id = cgm.contact_id
      WHERE cgm.group_id = ? AND c.is_active = 1
      ORDER BY c.name ASC
    `, [this.id]);
    
    return rows;
  }

  async getContactCount() {
    if (!this.id) return 0;
    
    const result = await ContactGroup.db.get(`
      SELECT COUNT(*) as count FROM contact_group_members cgm
      JOIN contacts c ON cgm.contact_id = c.id
      WHERE cgm.group_id = ? AND c.is_active = 1
    `, [this.id]);
    
    return result.count;
  }

  async getVerifiedContactCount() {
    if (!this.id) return 0;
    
    const result = await ContactGroup.db.get(`
      SELECT COUNT(*) as count FROM contact_group_members cgm
      JOIN contacts c ON cgm.contact_id = c.id
      WHERE cgm.group_id = ? AND c.is_active = 1 AND c.whatsapp_verified = 1
    `, [this.id]);
    
    return result.count;
  }

  async removeNonWhatsAppContacts() {
    if (!this.id) return 0;

    const result = await ContactGroup.db.run(`
      DELETE FROM contact_group_members
      WHERE group_id = ? AND contact_id IN (
        SELECT id FROM contacts
        WHERE whatsapp_verified = 0
      )
    `, [this.id]);

    return result.changes;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      color: this.color,
      isActive: this.isActive,
      contactCount: this.contactCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static async getStats() {
    try {
      const totalResult = await ContactGroup.db.query('SELECT COUNT(*) as count FROM contact_groups WHERE is_active = 1');

      const contactsResult = await ContactGroup.db.query(`
        SELECT COUNT(DISTINCT cgm.contact_id) as count
        FROM contact_group_members cgm
        JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE cg.is_active = 1
      `);

      const totalGroups = totalResult.success && totalResult.data && totalResult.data.length > 0 ? totalResult.data[0].count : 0;
      const totalContacts = contactsResult.success && contactsResult.data && contactsResult.data.length > 0 ? contactsResult.data[0].count : 0;

      return {
        totalGroups: totalGroups,
        totalGroupedContacts: totalContacts
      };
    } catch (error) {
      console.error('Error getting contact group stats:', error);
      return {
        totalGroups: 0,
        totalGroupedContacts: 0
      };
    }
  }
}

module.exports = ContactGroup;
