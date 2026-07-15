const DatabaseService = require('../services/database.service');

class Contact {
  constructor(data = {}) {
    this.id = data.id || null;
    this.phoneNumber = data.phone_number || data.phoneNumber;
    this.name = data.name;
    this.email = data.email;
    this.company = data.company;
    this.position = data.position;
    this.notes = data.notes;
    this.tags = data.tags;
    this.customFields = data.custom_fields || data.customFields;
    // Custom variables Var1-Var10
    this.var1 = data.var1;
    this.var2 = data.var2;
    this.var3 = data.var3;
    this.var4 = data.var4;
    this.var5 = data.var5;
    this.var6 = data.var6;
    this.var7 = data.var7;
    this.var8 = data.var8;
    this.var9 = data.var9;
    this.var10 = data.var10;
    // WhatsApp verification fields
    this.whatsappVerified = data.whatsapp_verified || data.whatsappVerified || false;
    this.verificationStatus = data.verification_status || data.verificationStatus || 'pending';
    this.verificationDate = data.verification_date || data.verificationDate;
    this.isActive = data.is_active !== undefined ? data.is_active : data.isActive !== undefined ? data.isActive : true;
    this.lastMessageAt = data.last_message_at || data.lastMessageAt;
    this.createdAt = data.created_at || data.createdAt;
    this.updatedAt = data.updated_at || data.updatedAt;
  }

  static async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  static async findAll(limit = 100, offset = 0) {
    const rows = await this.db.all(`
      SELECT * FROM contacts 
      WHERE is_active = 1 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    return rows.map(row => new Contact(row));
  }

  static async findById(id) {
    const row = await this.db.get('SELECT * FROM contacts WHERE id = ?', [id]);
    return row ? new Contact(row) : null;
  }

  static async findByPhone(phoneNumber) {
    const row = await this.db.get('SELECT * FROM contacts WHERE phone_number = ?', [phoneNumber]);
    return row ? new Contact(row) : null;
  }

  static async search(query, limit = 50) {
    const rows = await this.db.all(`
      SELECT * FROM contacts 
      WHERE (name LIKE ? OR phone_number LIKE ? OR email LIKE ? OR company LIKE ?) 
        AND is_active = 1
      ORDER BY name ASC
      LIMIT ?
    `, [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit]);
    return rows.map(row => new Contact(row));
  }

  static async findByTag(tag) {
    const rows = await this.db.all(`
      SELECT * FROM contacts 
      WHERE tags LIKE ? AND is_active = 1
      ORDER BY name ASC
    `, [`%"${tag}"%`]);
    return rows.map(row => new Contact(row));
  }

  static async findByGroup(groupId) {
    const rows = await this.db.all(`
      SELECT c.* FROM contacts c
      JOIN contact_group_members cgm ON c.id = cgm.contact_id
      WHERE cgm.group_id = ? AND c.is_active = 1
      ORDER BY c.name ASC
    `, [groupId]);
    return rows.map(row => new Contact(row));
  }

  async save() {
    const now = new Date().toISOString();

    if (this.id) {
      // Update existing record
      const result = await Contact.db.run(`
        UPDATE contacts
        SET phone_number = ?, name = ?, email = ?, company = ?, position = ?,
            notes = ?, tags = ?, custom_fields = ?,
            var1 = ?, var2 = ?, var3 = ?, var4 = ?, var5 = ?,
            var6 = ?, var7 = ?, var8 = ?, var9 = ?, var10 = ?,
            whatsapp_verified = ?, verification_status = ?, verification_date = ?,
            is_active = ?, last_message_at = ?, updated_at = ?
        WHERE id = ?
      `, [
        this.phoneNumber, this.name, this.email, this.company, this.position,
        this.notes, this.tags, this.customFields,
        this.var1, this.var2, this.var3, this.var4, this.var5,
        this.var6, this.var7, this.var8, this.var9, this.var10,
        this.whatsappVerified, this.verificationStatus, this.verificationDate,
        this.isActive, this.lastMessageAt, now, this.id
      ]);

      this.updatedAt = now;
      return result;
    } else {
      // Create new record
      const result = await Contact.db.run(`
        INSERT INTO contacts
        (phone_number, name, email, company, position, notes, tags, custom_fields,
         var1, var2, var3, var4, var5, var6, var7, var8, var9, var10,
         whatsapp_verified, verification_status, verification_date,
         is_active, last_message_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        this.phoneNumber, this.name, this.email, this.company, this.position,
        this.notes, this.tags, this.customFields,
        this.var1, this.var2, this.var3, this.var4, this.var5,
        this.var6, this.var7, this.var8, this.var9, this.var10,
        this.whatsappVerified, this.verificationStatus, this.verificationDate,
        this.isActive, this.lastMessageAt, now, now
      ]);

      this.id = result.lastID;
      this.createdAt = now;
      this.updatedAt = now;
      return result;
    }
  }

  async delete() {
    if (this.id) {
      await Contact.db.run('UPDATE contacts SET is_active = 0 WHERE id = ?', [this.id]);
      this.isActive = false;
    }
  }

  getTagsArray() {
    if (!this.tags) return [];
    try {
      return typeof this.tags === 'string' ? JSON.parse(this.tags) : this.tags;
    } catch (error) {
      console.error('Error parsing tags:', error);
      return [];
    }
  }

  setTags(tags) {
    this.tags = typeof tags === 'object' ? JSON.stringify(tags) : tags;
  }

  addTag(tag) {
    const currentTags = this.getTagsArray();
    if (!currentTags.includes(tag)) {
      currentTags.push(tag);
      this.setTags(currentTags);
    }
  }

  removeTag(tag) {
    const currentTags = this.getTagsArray();
    const filteredTags = currentTags.filter(t => t !== tag);
    this.setTags(filteredTags);
  }

  getCustomFieldsObject() {
    if (!this.customFields) return {};
    try {
      return typeof this.customFields === 'string' ? JSON.parse(this.customFields) : this.customFields;
    } catch (error) {
      console.error('Error parsing custom fields:', error);
      return {};
    }
  }

  setCustomFields(fields) {
    this.customFields = typeof fields === 'object' ? JSON.stringify(fields) : fields;
  }

  updateCustomField(key, value) {
    const fields = this.getCustomFieldsObject();
    fields[key] = value;
    this.setCustomFields(fields);
  }

  async updateLastMessage() {
    this.lastMessageAt = new Date().toISOString();
    if (this.id) {
      await Contact.db.run('UPDATE contacts SET last_message_at = ? WHERE id = ?', [this.lastMessageAt, this.id]);
    }
  }

  async updateVerificationStatus(status, verified = false) {
    this.verificationStatus = status;
    this.whatsappVerified = verified;
    this.verificationDate = new Date().toISOString();

    if (this.id) {
      await Contact.db.run(`
        UPDATE contacts
        SET verification_status = ?, whatsapp_verified = ?, verification_date = ?, updated_at = ?
        WHERE id = ?
      `, [this.verificationStatus, this.whatsappVerified, this.verificationDate, this.verificationDate, this.id]);
    }
  }

  static async findUnverified() {
    const rows = await this.db.all(`
      SELECT * FROM contacts
      WHERE (whatsapp_verified = 0 OR whatsapp_verified IS NULL) AND is_active = 1
      ORDER BY created_at ASC
    `);
    return rows.map(row => new Contact(row));
  }

  static async findNonWhatsApp() {
    const rows = await this.db.all(`
      SELECT * FROM contacts
      WHERE whatsapp_verified = 0 AND is_active = 1
      ORDER BY name ASC
    `);
    return rows.map(row => new Contact(row));
  }

  static async deleteNonWhatsApp() {
    const result = await this.db.run(`
      UPDATE contacts
      SET is_active = 0
      WHERE whatsapp_verified = 0
    `);
    return result.changes;
  }

  static async deleteOrphanedContacts() {
    // Delete contacts that are not in any active groups
    const result = await this.db.run(`
      UPDATE contacts
      SET is_active = 0
      WHERE id NOT IN (
        SELECT DISTINCT cgm.contact_id
        FROM contact_group_members cgm
        INNER JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE cg.is_active = 1
      ) AND is_active = 1
    `);
    return result.changes;
  }

  static async findOrphanedContacts() {
    // Find contacts that are not in any active groups
    const rows = await this.db.all(`
      SELECT * FROM contacts
      WHERE id NOT IN (
        SELECT DISTINCT cgm.contact_id
        FROM contact_group_members cgm
        INNER JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE cg.is_active = 1
      ) AND is_active = 1
      ORDER BY name ASC
    `);
    return rows.map(row => new Contact(row));
  }

  async addToGroup(groupId) {
    if (this.id && groupId) {
      try {
        await Contact.db.run(`
          INSERT OR IGNORE INTO contact_group_members (group_id, contact_id)
          VALUES (?, ?)
        `, [groupId, this.id]);
        return true;
      } catch (error) {
        console.error('Error adding contact to group:', error);
        return false;
      }
    }
    return false;
  }

  async removeFromGroup(groupId) {
    if (this.id && groupId) {
      await Contact.db.run(`
        DELETE FROM contact_group_members 
        WHERE group_id = ? AND contact_id = ?
      `, [groupId, this.id]);
    }
  }

  async getGroups() {
    if (!this.id) return [];
    
    const rows = await Contact.db.all(`
      SELECT cg.* FROM contact_groups cg
      JOIN contact_group_members cgm ON cg.id = cgm.group_id
      WHERE cgm.contact_id = ? AND cg.is_active = 1
    `, [this.id]);
    
    return rows;
  }

  toJSON() {
    return {
      id: this.id,
      phoneNumber: this.phoneNumber,
      name: this.name,
      email: this.email,
      company: this.company,
      position: this.position,
      notes: this.notes,
      tags: this.getTagsArray(),
      customFields: this.getCustomFieldsObject(),
      var1: this.var1,
      var2: this.var2,
      var3: this.var3,
      var4: this.var4,
      var5: this.var5,
      var6: this.var6,
      var7: this.var7,
      var8: this.var8,
      var9: this.var9,
      var10: this.var10,
      whatsappVerified: this.whatsappVerified,
      verificationStatus: this.verificationStatus,
      verificationDate: this.verificationDate,
      isActive: this.isActive,
      lastMessageAt: this.lastMessageAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static async importFromCSV(csvData, options = {}) {
    const results = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };

    for (const row of csvData) {
      try {
        const phoneNumber = row.phone || row.phoneNumber || row.phone_number;
        
        if (!phoneNumber) {
          results.skipped++;
          continue;
        }

        const existingContact = await Contact.findByPhone(phoneNumber);
        
        if (existingContact && !options.updateExisting) {
          results.skipped++;
          continue;
        }

        const contact = existingContact || new Contact();
        contact.phoneNumber = phoneNumber;
        contact.name = row.name || contact.name;
        contact.email = row.email || contact.email;
        contact.company = row.company || contact.company;
        contact.position = row.position || contact.position;
        contact.notes = row.notes || contact.notes;

        if (row.tags) {
          const tags = typeof row.tags === 'string' ? row.tags.split(',').map(t => t.trim()) : row.tags;
          contact.setTags(tags);
        }

        await contact.save();

        if (existingContact) {
          results.updated++;
        } else {
          results.imported++;
        }
      } catch (error) {
        results.errors.push(`Error processing ${row.phone || 'unknown'}: ${error.message}`);
      }
    }

    return results;
  }

  static async getStats() {
    try {
      // Only count contacts that are actually in active groups
      const totalResult = await Contact.db.query(`
        SELECT COUNT(DISTINCT c.id) as count
        FROM contacts c
        INNER JOIN contact_group_members cgm ON c.id = cgm.contact_id
        INNER JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE c.is_active = 1 AND cg.is_active = 1
      `);

      // Only count tags from contacts that are in active groups
      const tagsResult = await Contact.db.query(`
        SELECT c.tags FROM contacts c
        INNER JOIN contact_group_members cgm ON c.id = cgm.contact_id
        INNER JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE c.tags IS NOT NULL AND c.tags != '' AND c.is_active = 1 AND cg.is_active = 1
      `);

      const tagCounts = {};
      const tagsData = tagsResult.success && Array.isArray(tagsResult.data) ? tagsResult.data : [];
      tagsData.forEach(row => {
        try {
          const tags = JSON.parse(row.tags);
          if (Array.isArray(tags)) {
            tags.forEach(tag => {
              tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
          }
        } catch (error) {
          // Skip invalid JSON
        }
      });

      // Only count recent activity from contacts that are in active groups
      const recentActivityResult = await Contact.db.query(`
        SELECT COUNT(DISTINCT c.id) as count FROM contacts c
        INNER JOIN contact_group_members cgm ON c.id = cgm.contact_id
        INNER JOIN contact_groups cg ON cgm.group_id = cg.id
        WHERE c.last_message_at > datetime('now', '-7 days') AND c.is_active = 1 AND cg.is_active = 1
      `);

      const totalCount = totalResult.success && totalResult.data && totalResult.data.length > 0 ? totalResult.data[0].count : 0;
      const recentCount = recentActivityResult.success && recentActivityResult.data && recentActivityResult.data.length > 0 ? recentActivityResult.data[0].count : 0;

      return {
        total: totalCount,
        tagCounts,
        recentActivity: recentCount
      };
    } catch (error) {
      console.error('Error getting contact stats:', error);
      return {
        total: 0,
        tagCounts: {},
        recentActivity: 0
      };
    }
  }

  static async getAllTags() {
    const rows = await Contact.db.all(`
      SELECT DISTINCT tags FROM contacts 
      WHERE tags IS NOT NULL AND tags != '' AND is_active = 1
    `);
    
    const allTags = new Set();
    rows.forEach(row => {
      try {
        const tags = JSON.parse(row.tags);
        tags.forEach(tag => allTags.add(tag));
      } catch (error) {
        // Skip invalid JSON
      }
    });
    
    return Array.from(allTags).sort();
  }
}

module.exports = Contact; 