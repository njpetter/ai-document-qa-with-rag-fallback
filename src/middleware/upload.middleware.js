import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/appError.js';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

// Ensure temporary uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.pdf';
    const uniqueName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    cb(null, uniqueName);
  },
});

function pdfFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  const isPdfMime = mime === 'application/pdf' || mime === 'application/x-pdf';
  const isPdfExt = ext === '.pdf';

  if (!isPdfMime || !isPdfExt) {
    return cb(
      new AppError(
        'Invalid file type. Only PDF files (.pdf, application/pdf) are allowed.',
        400,
        'INVALID_FILE_TYPE'
      ),
      false
    );
  }

  cb(null, true);
}

const multerUpload = multer({
  storage,
  fileFilter: pdfFileFilter,
  limits: {
    fileSize: env.maxFileSizeBytes, // 10 MB
    files: 1,
  },
});

/**
 * Middleware that handles multipart/form-data PDF uploads via Multer
 * and translates Multer errors (e.g. >10MB file size, wrong field, non-PDF) into AppErrors.
 */
export function pdfUploadMiddleware(req, res, next) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();

  // If the client sends JSON (e.g. raw text document input), skip Multer and let controller validate
  if (contentType.includes('application/json')) {
    return next();
  }

  const singleUpload = multerUpload.single('file');

  singleUpload(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new AppError(
              'File size exceeds the maximum allowed limit of 10MB.',
              413,
              'FILE_TOO_LARGE'
            )
          );
        }
        return next(new AppError(`File upload error: ${err.message}`, 400, err.code));
      }
      return next(err);
    }
    next();
  });
}

