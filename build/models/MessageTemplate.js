const DatabaseService = require('../services/database.service');

class MessageTemplate {
  constructor(data = {}) {
    this.id = data.id || null;
    this.name = data.name;
    this.category = data.category || 'general';
    this.content = data.content;
    this.variables = data.variables;
    this.attachments = data.attachments;
    this.isActive = data.is_active !== undefined ? data.is_active : data.isActive !== undefined ? data.isActive : true;
    this.usageCount = data.usage_count || data.usageCount || 0;
    this.createdAt = data.created_at || data.createdAt;
    this.updatedAt = data.updated_at || data.updatedAt;
  }

  static async initialize() {
    this.db = new DatabaseService();
    await this.db.initialize();
  }

  static async findAll() {
    const rows = await this.db.all('SELECT * FROM message_templates WHERE is_active = 1 ORDER BY usage_count DESC, created_at DESC');
    return rows.map(row => new MessageTemplate(row));
  }

  static async findById(id) {
    const row = await this.db.get('SELECT * FROM message_templates WHERE id = ?', [id]);
    return row ? new MessageTemplate(row) : null;
  }

  static async findByCategory(category) {
    const rows = await this.db.all('SELECT * FROM message_templates WHERE category = ? AND is_active = 1', [category]);
    return rows.map(row => new MessageTemplate(row));
  }

  static async search(query) {
    const rows = await this.db.all(`
      SELECT * FROM message_templates 
      WHERE (name LIKE ? OR content LIKE ?) AND is_active = 1
      ORDER BY usage_count DESC
    `, [`%${query}%`, `%${query}%`]);
    return rows.map(row => new MessageTemplate(row));
  }

  async save() {
    const now = new Date().toISOString();
    
    if (this.id) {
      // Update existing record
      const result = await MessageTemplate.db.run(`
        UPDATE message_templates 
        SET name = ?, category = ?, content = ?, variables = ?, attachments = ?, 
            is_active = ?, updated_at = ?
        WHERE id = ?
      `, [
        this.name, this.category, this.content, this.variables, this.attachments,
        this.isActive, now, this.id
      ]);
      
      this.updatedAt = now;
      return result;
    } else {
      // Create new record
      const result = await MessageTemplate.db.run(`
        INSERT INTO message_templates 
        (name, category, content, variables, attachments, is_active, usage_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        this.name, this.category, this.content, this.variables, this.attachments,
        this.isActive, this.usageCount, now, now
      ]);
      
      this.id = result.id;
      this.createdAt = now;
      this.updatedAt = now;
      return result;
    }
  }

  async delete() {
    if (this.id) {
      await MessageTemplate.db.run('UPDATE message_templates SET is_active = 0 WHERE id = ?', [this.id]);
      this.isActive = false;
    }
  }

  async incrementUsage() {
    if (this.id) {
      this.usageCount += 1;
      await MessageTemplate.db.run('UPDATE message_templates SET usage_count = usage_count + 1 WHERE id = ?', [this.id]);
    }
  }

  getVariablesArray() {
    if (!this.variables) return [];
    try {
      return typeof this.variables === 'string' ? JSON.parse(this.variables) : this.variables;
    } catch (error) {
      console.error('Error parsing variables:', error);
      return [];
    }
  }

  setVariables(variables) {
    this.variables = typeof variables === 'object' ? JSON.stringify(variables) : variables;
  }

  getAttachmentsArray() {
    if (!this.attachments) return [];
    try {
      return typeof this.attachments === 'string' ? JSON.parse(this.attachments) : this.attachments;
    } catch (error) {
      console.error('Error parsing attachments:', error);
      return [];
    }
  }

  setAttachments(attachments) {
    this.attachments = typeof attachments === 'object' ? JSON.stringify(attachments) : attachments;
  }

  processTemplate(variables = {}) {
    let processedContent = this.content;
    
    // Replace variables in the format {{variable_name}}
    const variableRegex = /\{\{(\w+)\}\}/g;
    processedContent = processedContent.replace(variableRegex, (match, varName) => {
      return variables[varName] || match;
    });
    
    return processedContent;
  }

  extractVariables() {
    const variableRegex = /\{\{(\w+)\}\}/g;
    const variables = [];
    let match;
    
    while ((match = variableRegex.exec(this.content)) !== null) {
      if (!variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }
    
    return variables;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      content: this.content,
      variables: this.getVariablesArray(),
      attachments: this.getAttachmentsArray(),
      isActive: this.isActive,
      usageCount: this.usageCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static async getStats() {
    try {
      const totalResult = await MessageTemplate.db.query('SELECT COUNT(*) as count FROM message_templates WHERE is_active = 1');
      const categoryStatsResult = await MessageTemplate.db.query(`
        SELECT category, COUNT(*) as count
        FROM message_templates
        WHERE is_active = 1
        GROUP BY category
      `);

      const mostUsedResult = await MessageTemplate.db.query(`
        SELECT * FROM message_templates
        WHERE is_active = 1
        ORDER BY usage_count DESC
        LIMIT 5
      `);

      const totalCount = totalResult.success && totalResult.data && totalResult.data.length > 0 ? totalResult.data[0].count : 0;
      const categoryStats = categoryStatsResult.success && Array.isArray(categoryStatsResult.data) ? categoryStatsResult.data : [];
      const mostUsed = mostUsedResult.success && Array.isArray(mostUsedResult.data) ? mostUsedResult.data : [];

      return {
        total: totalCount,
        byCategory: categoryStats.reduce((acc, stat) => {
          acc[stat.category] = stat.count;
          return acc;
        }, {}),
        mostUsed: mostUsed.map(row => new MessageTemplate(row))
      };
    } catch (error) {
      console.error('Error getting template stats:', error);
      return {
        total: 0,
        byCategory: {},
        mostUsed: []
      };
    }
  }

  static async getCategories() {
    const rows = await MessageTemplate.db.all(`
      SELECT DISTINCT category, COUNT(*) as count 
      FROM message_templates 
      WHERE is_active = 1 
      GROUP BY category 
      ORDER BY count DESC
    `);
    
    return rows.map(row => ({
      name: row.category,
      count: row.count
    }));
  }
}

module.exports = MessageTemplate; 