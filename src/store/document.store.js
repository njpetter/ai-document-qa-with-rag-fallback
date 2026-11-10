import crypto from 'crypto';
import { AppError } from '../utils/appError.js';

/**
 * In-memory vector store holding uploaded documents, their chunks, and embedding vectors.
 */
class DocumentVectorStore {
  constructor() {
    /** @type {Map<string, { documentId: string, filename: string, totalPages: number, totalChunks: number, createdAt: string, chunks: Array<{ chunkIndex: number, text: string, embedding: number[] }> }>} */
    this.documents = new Map();
  }

  /**
   * Stores a parsed document's chunks and embeddings in memory with a unique documentId.
   *
   * @param {object} params
   * @param {string} params.filename
   * @param {number} params.totalPages
   * @param {string[]} params.chunks
   * @param {number[][]} params.embeddings
   * @returns {{ documentId: string, filename: string, totalPages: number, totalChunks: number, createdAt: string }}
   */
  saveDocument({ filename, totalPages = 1, chunks, embeddings }) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new AppError('Cannot store a document with zero chunks.', 400, 'EMPTY_CHUNKS');
    }
    if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
      throw new AppError('Chunks and embeddings count mismatch.', 500, 'EMBEDDING_MISMATCH');
    }

    const documentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const chunkRecords = chunks.map((text, index) => ({
      chunkIndex: index,
      text,
      embedding: embeddings[index],
    }));

    const docRecord = {
      documentId,
      filename: filename || 'text-document.txt',
      totalPages,
      totalChunks: chunkRecords.length,
      createdAt,
      chunks: chunkRecords,
    };

    this.documents.set(documentId, docRecord);

    return {
      documentId: docRecord.documentId,
      filename: docRecord.filename,
      totalPages: docRecord.totalPages,
      totalChunks: docRecord.totalChunks,
    };
  }

  /**
   * Retrieves a document record by its documentId.
   *
   * @param {string} documentId
   */
  getDocument(documentId) {
    return this.documents.get(documentId) || null;
  }

  /**
   * Lists metadata for all uploaded documents in the vector store.
   */
  listDocuments() {
    return Array.from(this.documents.values()).map(({ chunks, ...metadata }) => metadata);
  }

  /**
   * Returns all chunk records for a specific documentId, or across all documents if documentId is not provided.
   *
   * @param {string} [documentId]
   */
  getChunks(documentId) {
    if (documentId) {
      const doc = this.documents.get(documentId);
      if (!doc) {
        throw new AppError(`Document with ID "${documentId}" was not found.`, 404, 'DOCUMENT_NOT_FOUND');
      }
      return doc.chunks.map((c) => ({
        ...c,
        documentId: doc.documentId,
        filename: doc.filename,
      }));
    }

    // If no documentId specified, search across all stored documents (most recent if any)
    if (this.documents.size === 0) {
      throw new AppError('No documents have been uploaded yet. Please upload a document first or provide inline document text.', 400, 'NO_DOCUMENTS_AVAILABLE');
    }

    const allChunks = [];
    for (const doc of this.documents.values()) {
      for (const c of doc.chunks) {
        allChunks.push({
          ...c,
          documentId: doc.documentId,
          filename: doc.filename,
        });
      }
    }
    return allChunks;
  }
}

export const documentStore = new DocumentVectorStore();

