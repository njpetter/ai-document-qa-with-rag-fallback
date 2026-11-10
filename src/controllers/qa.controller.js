import fs from 'fs/promises';
import { parsePdfFile } from '../services/documentParser.service.js';
import { chunkText } from '../services/chunker.service.js';
import {
  generateEmbeddings,
  generateGroundedAnswer,
  UNAVAILABLE_MESSAGE,
} from '../services/gemini.service.js';
import { retrieveRelevantChunks } from '../services/retrieval.service.js';
import { documentStore } from '../store/document.store.js';
import { AppError } from '../utils/appError.js';

/**
 * Safely deletes a temporary uploaded file from disk, ignoring errors if already removed.
 *
 * @param {string | undefined} filePath
 */
async function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Warning: Failed to delete temporary file ${filePath}:`, err.message);
    }
  }
}

/**
 * Shared ingestion helper that chunks text, generates embeddings, and stores in vector store.
 * Avoids any duplication between PDF upload and raw text upload.
 */
async function ingestDocumentText({ text, filename, totalPages = 1 }) {
  const chunks = chunkText(text);
  const embeddings = await generateEmbeddings(chunks);

  return documentStore.saveDocument({
    filename,
    totalPages,
    chunks,
    embeddings,
  });
}

/**
 * POST /api/documents
 * Accepts either:
 * 1) multipart/form-data with a PDF file in `file`
 * 2) application/json with `{ text / document, filename? }`
 */
export async function uploadDocument(req, res, next) {
  const tempFilePath = req.file?.path;

  try {
    // Case 1: Multipart PDF file upload
    if (req.file) {
      const { text, totalPages } = await parsePdfFile(tempFilePath);
      const result = await ingestDocumentText({
        text,
        filename: req.file.originalname,
        totalPages,
      });

      return res.status(201).json({
        documentId: result.documentId,
        filename: result.filename,
        totalPages: result.totalPages,
        totalChunks: result.totalChunks,
      });
    }

    // Case 2: Raw text document sent via JSON
    const rawText = req.body?.text ?? req.body?.document;
    if (typeof rawText === 'string') {
      if (!rawText.trim()) {
        throw new AppError('Provided document text cannot be empty.', 400, 'EMPTY_TEXT');
      }
      const filename = req.body?.filename || 'text-document.txt';
      const result = await ingestDocumentText({
        text: rawText,
        filename,
        totalPages: 1,
      });

      return res.status(201).json({
        documentId: result.documentId,
        filename: result.filename,
        totalPages: result.totalPages,
        totalChunks: result.totalChunks,
      });
    }

    throw new AppError(
      'No PDF file uploaded. Please attach a valid PDF file under the "file" field using multipart/form-data.',
      400,
      'MISSING_FILE'
    );
  } catch (err) {
    return next(err);
  } finally {
    // Always delete temporary uploaded file after processing, including on errors
    await cleanupTempFile(tempFilePath);
  }
}

/**
 * POST /api/ask and POST /api/qa
 * Accepts a user question (and optionally a `documentId` or inline `document` text),
 * retrieves relevant chunks, passes them to Gemini LLM, and returns a grounded answer.
 */
export async function askQuestion(req, res, next) {
  try {
    const { question, documentId, document, text } = req.body || {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      throw new AppError(
        'A valid non-empty "question" string is required.',
        400,
        'INVALID_QUESTION'
      );
    }

    const trimmedQuestion = question.trim();
    const inlineDocument = document ?? text;

    let candidateChunks = [];
    let activeDocumentId = documentId || null;

    if (typeof inlineDocument === 'string') {
      if (!inlineDocument.trim()) {
        throw new AppError(
          'Provided inline "document" text cannot be empty.',
          400,
          'EMPTY_DOCUMENT'
        );
      }
      // Ingest inline document so it uses the exact same chunking + embedding + vector store pipeline
      const saved = await ingestDocumentText({
        text: inlineDocument,
        filename: req.body?.filename || 'inline-document.txt',
        totalPages: 1,
      });
      activeDocumentId = saved.documentId;
      candidateChunks = documentStore.getChunks(activeDocumentId);
    } else {
      candidateChunks = documentStore.getChunks(activeDocumentId);
    }

    const relevantChunks = await retrieveRelevantChunks(trimmedQuestion, candidateChunks);

    if (relevantChunks.length === 0) {
      return res.status(200).json({
        question: trimmedQuestion,
        answer: UNAVAILABLE_MESSAGE,
        available: false,
        provider: 'local-fallback',
        documentId: activeDocumentId,
        relevantChunks: [],
      });
    }

    const llmResult = await generateGroundedAnswer(trimmedQuestion, relevantChunks);

    return res.status(200).json({
      question: trimmedQuestion,
      answer: llmResult.answer,
      available: llmResult.available,
      provider: llmResult.provider,
      documentId: activeDocumentId,
      relevantChunks: relevantChunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        text: c.text,
        score: Number(c.score.toFixed(4)),
        documentId: c.documentId,
        filename: c.filename,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/documents
 * Lists all uploaded documents in the in-memory vector store.
 */
export function listDocuments(_req, res) {
  const documents = documentStore.listDocuments();
  return res.status(200).json({
    count: documents.length,
    documents,
  });
}

/**
 * GET /api/documents/:documentId
 * Returns metadata and extracted chunks for a specific uploaded document.
 */
export function getDocumentById(req, res, next) {
  const doc = documentStore.getDocument(req.params.documentId);
  if (!doc) {
    return next(
      new AppError(
        `Document with ID "${req.params.documentId}" was not found.`,
        404,
        'DOCUMENT_NOT_FOUND'
      )
    );
  }

  return res.status(200).json({
    documentId: doc.documentId,
    filename: doc.filename,
    totalPages: doc.totalPages,
    totalChunks: doc.totalChunks,
    createdAt: doc.createdAt,
    chunks: doc.chunks.map((c) => ({
      chunkIndex: c.chunkIndex,
      text: c.text,
      embeddingDimensions: c.embedding?.length || 0,
    })),
  });
}

