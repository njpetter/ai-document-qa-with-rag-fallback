import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || '3000', 10),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  chunkSize: parseInt(process.env.CHUNK_SIZE || '500', 10),
  chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '100', 10),
  topK: parseInt(process.env.TOP_K || '3', 10),
  similarityThreshold: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.25'),
};

