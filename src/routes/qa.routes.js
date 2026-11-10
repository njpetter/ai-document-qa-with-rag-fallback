import { Router } from 'express';
import { pdfUploadMiddleware } from '../middleware/upload.middleware.js';
import {
  uploadDocument,
  askQuestion,
  listDocuments,
  getDocumentById,
} from '../controllers/qa.controller.js';

const router = Router();

// Document upload & inspection routes
router.post('/documents', pdfUploadMiddleware, uploadDocument);
router.get('/documents', listDocuments);
router.get('/documents/:documentId', getDocumentById);

// Question-Answering routes (supports both stored documentId and inline document text)
router.post('/ask', askQuestion);
router.post('/qa', askQuestion);

export default router;

