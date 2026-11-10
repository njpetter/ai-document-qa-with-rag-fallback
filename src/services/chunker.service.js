import { env } from '../config/env.js';
import { AppError } from '../utils/appError.js';

/**
 * Splits raw document text into overlapping chunks for embedding and retrieval.
 * Shared across both PDF uploads and raw text inputs.
 *
 * @param {string} text - Raw extracted or submitted document text
 * @param {object} [options]
 * @param {number} [options.chunkSize] - Max characters per chunk
 * @param {number} [options.chunkOverlap] - Overlap characters between consecutive chunks
 * @returns {string[]} Array of non-empty text chunks
 */
export function chunkText(text, options = {}) {
  if (!text || typeof text !== 'string') {
    throw new AppError('Document text must be a non-empty string.', 400, 'INVALID_TEXT');
  }

  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    throw new AppError('Document contains no usable text after normalization.', 400, 'EMPTY_TEXT');
  }

  const chunkSize = options.chunkSize || env.chunkSize || 500;
  const chunkOverlap = Math.min(
    options.chunkOverlap ?? env.chunkOverlap ?? 100,
    Math.floor(chunkSize / 2)
  );

  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    // If not at the end of the text, try to break at a natural boundary (newline, period, space)
    if (end < normalized.length) {
      const slice = normalized.slice(start, end);
      const lastParagraph = slice.lastIndexOf('\n\n');
      const lastNewline = slice.lastIndexOf('\n');
      const lastSentence = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! ')
      );
      const lastSpace = slice.lastIndexOf(' ');

      const minBreakOffset = Math.floor(chunkSize * 0.5);

      if (lastParagraph >= minBreakOffset) {
        end = start + lastParagraph + 2;
      } else if (lastSentence >= minBreakOffset) {
        end = start + lastSentence + 2;
      } else if (lastNewline >= minBreakOffset) {
        end = start + lastNewline + 1;
      } else if (lastSpace >= minBreakOffset) {
        end = start + lastSpace + 1;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(start + 1, end - chunkOverlap);
  }

  if (chunks.length === 0) {
    throw new AppError('Failed to create text chunks from document.', 422, 'CHUNKING_FAILED');
  }

  return chunks;
}

