import fs from 'fs/promises';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { AppError } from '../utils/appError.js';

/**
 * Extracts text and page count from an uploaded PDF file on disk.
 * Handles empty files, invalid PDF headers, corrupted PDFs, and empty extracted text.
 *
 * @param {string} filePath - Path to the temporary uploaded PDF file
 * @returns {Promise<{ text: string, totalPages: number }>}
 */
export async function parsePdfFile(filePath) {
  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch (err) {
    throw new AppError(`Failed to read uploaded PDF file: ${err.message}`, 400, 'FILE_READ_ERROR');
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    throw new AppError('The uploaded PDF file is empty (0 bytes).', 400, 'EMPTY_PDF_FILE');
  }

  // Verify the %PDF- magic header within the first 1024 bytes
  const headerSlice = fileBuffer.subarray(0, Math.min(fileBuffer.length, 1024)).toString('latin1');
  if (!headerSlice.includes('%PDF-')) {
    throw new AppError('Invalid or corrupted PDF file: missing %PDF header signature.', 400, 'CORRUPTED_PDF');
  }

  let parsedData;
  try {
    // Convert Node Buffer to a standalone Uint8Array (byteOffset === 0) so pdf.js LoopbackPort
    // does not allocate from Node's shared 8KB Buffer slab pool for small PDFs (< 4KB).
    const uint8Array = new Uint8Array(fileBuffer);
    parsedData = await pdfParse(uint8Array);
  } catch (err) {
    throw new AppError(
      `Failed to extract text from PDF. The file may be corrupted or encrypted: ${err.message}`,
      422,
      'PDF_EXTRACTION_FAILED'
    );
  }

  const totalPages = parsedData?.numpages || 0;
  const extractedText = (parsedData?.text || '').replace(/\u0000/g, '').trim();

  if (totalPages === 0 || extractedText.length === 0) {
    throw new AppError(
      'The uploaded PDF contains no extractable text (it may be blank or scanned images only).',
      400,
      'EMPTY_PDF_TEXT'
    );
  }

  return {
    text: extractedText,
    totalPages,
  };
}
