const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DocumentService {
  constructor() {
    this.database = null;
    this.uploadsDir = path.join(process.cwd(), 'uploads', 'documents');
    this.ensureUploadsDirectory();
  }

  /**
   * Initialize the document service
   */
  async initialize(database) {
    this.database = database;
  }

  /**
   * Ensure uploads directory exists
   */
  ensureUploadsDirectory() {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  /**
   * Upload and process a document for a chatbot
   */
  async uploadDocument(chatbotId, file, originalFilename) {
    try {

      // Validate file type
      const fileExtension = path.extname(originalFilename).toLowerCase();
      const supportedTypes = ['.pdf', '.doc', '.docx', '.txt'];
      
      if (!supportedTypes.includes(fileExtension)) {
        throw new Error(`Unsupported file type: ${fileExtension}. Supported types: ${supportedTypes.join(', ')}`);
      }

      // Generate unique filename
      const fileHash = crypto.createHash('md5').update(file).digest('hex');
      const filename = `${fileHash}_${Date.now()}${fileExtension}`;
      const filePath = path.join(this.uploadsDir, filename);

      // Save file to disk
      fs.writeFileSync(filePath, file);

      // Get file stats
      const stats = fs.statSync(filePath);
      const fileType = fileExtension.substring(1); // Remove the dot

      // Insert document record
      const result = await this.database.query(
        `INSERT INTO ai_documents (
          chatbot_id, name, original_filename, file_type, file_size, 
          file_path, processing_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [chatbotId, originalFilename, originalFilename, fileType, stats.size, filePath]
      );

      const documentId = result.lastID || result.insertId;

      // Process document asynchronously
      this.processDocumentAsync(documentId, filePath, fileType)
        .catch(error => {
          console.error(`❌ Async document processing failed for ID ${documentId}:`, error);
        });

      return {
        success: true,
        documentId: documentId,
        message: 'Document uploaded successfully and is being processed'
      };

    } catch (error) {
      console.error('❌ Error uploading document:', error);
      throw error;
    }
  }

  /**
   * Process document asynchronously
   */
  async processDocumentAsync(documentId, filePath, fileType) {
    try {

      // Update status to processing
      await this.database.query(
        'UPDATE ai_documents SET processing_status = "processing", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [documentId]
      );

      let extractedText = '';

      // Extract text based on file type
      switch (fileType) {
        case 'txt':
          extractedText = await this.extractTextFromTxt(filePath);
          break;
        case 'pdf':
          extractedText = await this.extractTextFromPdf(filePath);
          break;
        case 'doc':
        case 'docx':
          extractedText = await this.extractTextFromDoc(filePath);
          break;
        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }


      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text could be extracted from the document');
      }

      // Split text into chunks for better retrieval
      const chunks = this.splitTextIntoChunks(extractedText);

      // Save chunks to database
      for (let i = 0; i < chunks.length; i++) {
        await this.database.query(
          `INSERT INTO ai_document_chunks (document_id, chunk_index, content, word_count, created_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [documentId, i, chunks[i], chunks[i].split(' ').length]
        );
      }

      // Update document with extracted text and completion status
      await this.database.query(
        `UPDATE ai_documents SET
         extracted_text = ?, processing_status = "completed",
         chunk_count = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [extractedText, chunks.length, documentId]
      );


    } catch (error) {
      console.error(`❌ Error processing document ${documentId}:`, error);

      // Update status to failed
      await this.database.query(
        `UPDATE ai_documents SET
         processing_status = "failed", processing_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error.message, documentId]
      );
    }
  }

  /**
   * Extract text from TXT file
   */
  async extractTextFromTxt(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }

  /**
   * Extract text from PDF file
   */
  async extractTextFromPdf(filePath) {
    try {
      // Try to use pdf-parse if available
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (error) {
      // Fallback: return a message indicating manual processing needed
      return `[PDF Document: ${path.basename(filePath)}]\n\nThis PDF document has been uploaded but automatic text extraction is not available. Please ensure the pdf-parse package is installed for automatic PDF processing, or manually provide the document content in the knowledge base.`;
    }
  }

  /**
   * Extract text from DOC/DOCX file
   */
  async extractTextFromDoc(filePath) {
    try {
      // Try to use mammoth for DOCX or textract for DOC
      if (path.extname(filePath).toLowerCase() === '.docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
      } else {
        // For .doc files, we'd need a different library
        throw new Error('DOC format requires additional processing libraries');
      }
    } catch (error) {
      // Fallback: return a message indicating manual processing needed
      return `[Document: ${path.basename(filePath)}]\n\nThis document has been uploaded but automatic text extraction is not available. Please ensure the mammoth package is installed for DOCX processing, or manually provide the document content in the knowledge base.`;
    }
  }

  /**
   * Split text into manageable chunks
   */
  splitTextIntoChunks(text, maxChunkSize = 1000) {
    const chunks = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (currentChunk.length + trimmedSentence.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmedSentence;
      } else {
        currentChunk += (currentChunk.length > 0 ? '. ' : '') + trimmedSentence;
      }
    }
    
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks.length > 0 ? chunks : [text]; // Fallback to original text if no chunks
  }

  /**
   * Get documents for a chatbot
   */
  async getDocuments(chatbotId) {
    try {

      const result = await this.database.query(
        `SELECT id, name, original_filename, file_type, file_size,
         processing_status, processing_error, chunk_count, is_active,
         created_at, updated_at
         FROM ai_documents
         WHERE chatbot_id = ?
         ORDER BY created_at DESC`,
        [chatbotId]
      );


      if (result.success) {
        const documents = Array.isArray(result.data) ? result.data : [];
        return documents;
      } else {
        console.error('❌ Database query failed:', result.error);
        return [];
      }
    } catch (error) {
      console.error('❌ Error getting documents:', error);
      return [];
    }
  }

  /**
   * Delete a document
   */
  async deleteDocument(documentId) {
    try {

      // Get document info first
      const result = await this.database.query(
        'SELECT file_path FROM ai_documents WHERE id = ?',
        [documentId]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        throw new Error('Document not found');
      }

      const document = result.data[0];

      // Delete file from disk
      if (document.file_path && fs.existsSync(document.file_path)) {
        fs.unlinkSync(document.file_path);
      }

      // Delete from database (chunks will be deleted by CASCADE)
      const deleteResult = await this.database.query('DELETE FROM ai_documents WHERE id = ?', [documentId]);

      if (deleteResult.success) {
        return { success: true, message: 'Document deleted successfully' };
      } else {
        throw new Error('Failed to delete document from database');
      }
    } catch (error) {
      console.error('❌ Error deleting document:', error);
      throw error;
    }
  }

  /**
   * Search document content for relevant information
   */
  async searchDocuments(chatbotId, query, limit = 5) {
    try {

      // Simple text search in document chunks
      const result = await this.database.query(
        `SELECT dc.content, d.name, d.original_filename
         FROM ai_document_chunks dc
         JOIN ai_documents d ON dc.document_id = d.id
         WHERE d.chatbot_id = ? AND d.is_active = 1 AND d.processing_status = 'completed'
         AND dc.content LIKE ?
         ORDER BY dc.chunk_index
         LIMIT ?`,
        [chatbotId, `%${query}%`, limit]
      );

      if (result.success) {
        return Array.isArray(result.data) ? result.data : [];
      } else {
        console.error('❌ Search query failed:', result.error);
        return [];
      }
    } catch (error) {
      console.error('❌ Error searching documents:', error);
      return [];
    }
  }

  /**
   * Check if a chatbot has any documents
   */
  async chatbotHasDocuments(chatbotId) {
    try {
      const result = await this.database.query(
        `SELECT COUNT(*) as count FROM ai_documents
         WHERE chatbot_id = ? AND is_active = 1 AND processing_status = 'completed'`,
        [chatbotId]
      );

      const count = result.data && result.data.length > 0 ? result.data[0].count : 0;
      return count > 0;
    } catch (error) {
      console.error('Error checking if chatbot has documents:', error);
      return false;
    }
  }

  /**
   * Get document content for AI context
   */
  async getDocumentContext(chatbotId, userMessage) {
    try {
      // Extract key terms from user message for search
      const searchTerms = this.extractSearchTerms(userMessage);
      let relevantContent = [];

      for (const term of searchTerms) {
        const chunks = await this.searchDocuments(chatbotId, term, 3);
        relevantContent = relevantContent.concat(chunks);
      }

      // Remove duplicates and limit total content
      const uniqueContent = relevantContent
        .filter((chunk, index, self) => 
          index === self.findIndex(c => c.content === chunk.content)
        )
        .slice(0, 5); // Limit to 5 most relevant chunks

      return uniqueContent;
    } catch (error) {
      console.error('❌ Error getting document context:', error);
      return [];
    }
  }

  /**
   * Extract search terms from user message
   */
  extractSearchTerms(message) {
    // Simple keyword extraction - remove common words and get meaningful terms
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'what', 'where', 'when', 'why', 'how', 'who', 'your', 'our', 'their'];

    // Define synonym mappings for better search
    const synonymMappings = {
      'office': ['office', 'headquarters', 'hq', 'location', 'address', 'building'],
      'located': ['located', 'situated', 'based', 'address', 'location', 'headquarters', 'hq'],
      'address': ['address', 'location', 'headquarters', 'hq', 'office', 'situated', 'based'],
      'location': ['location', 'address', 'headquarters', 'hq', 'office', 'situated', 'based'],
      'headquarters': ['headquarters', 'hq', 'office', 'location', 'address'],
      'contact': ['contact', 'phone', 'email', 'address', 'reach'],
      'company': ['company', 'organization', 'business', 'enterprise', 'corporation'],
      'products': ['products', 'services', 'offerings', 'solutions'],
      'services': ['services', 'products', 'offerings', 'solutions']
    };

    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .split(/\s+/)
      .filter(word => word.length > 2 && !commonWords.includes(word));

    // Expand words with synonyms
    let expandedTerms = [...words];
    words.forEach(word => {
      if (synonymMappings[word]) {
        expandedTerms = expandedTerms.concat(synonymMappings[word]);
      }
    });

    return [...new Set(expandedTerms)]; // Remove duplicates
  }
}

module.exports = DocumentService;
