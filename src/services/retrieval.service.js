import { env } from '../config/env.js';
import { computeLocalEmbedding, generateEmbedding, tokenizeTerms } from './gemini.service.js';

/**
 * Computes cosine similarity between two numeric vectors.
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Computes lexical term overlap ratio between question and chunk text.
 */
function computeLexicalOverlap(questionTerms, chunkText) {
  if (questionTerms.length === 0) return 0;
  const chunkTerms = new Set(tokenizeTerms(chunkText));
  let hits = 0;
  for (const qTerm of questionTerms) {
    if (chunkTerms.has(qTerm)) {
      hits += 1;
    } else {
      const stem = qTerm.slice(0, Math.max(4, qTerm.length - 2));
      if (
        stem.length >= 4 &&
        Array.from(chunkTerms).some(
          (ct) => ct.startsWith(stem) || qTerm.startsWith(ct.slice(0, Math.max(4, ct.length - 2)))
        )
      ) {
        hits += 0.75;
      }
    }
  }
  return hits / questionTerms.length;
}

/**
 * Retrieves the top-K most relevant chunks for a user question using vector cosine similarity
 * combined with lexical overlap scoring.
 *
 * @param {string} question
 * @param {Array<{ chunkIndex: number, text: string, embedding: number[], documentId?: string, filename?: string }>} chunks
 * @param {number} [topK]
 * @returns {Promise<Array<{ chunkIndex: number, text: string, score: number, vectorScore: number, lexicalScore: number, documentId?: string, filename?: string }>>}
 */
export async function retrieveRelevantChunks(question, chunks, topK = env.topK) {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  const queryEmbedding = await generateEmbedding(question);
  const questionTerms = tokenizeTerms(question);
  let localQueryEmbedding = null;

  const scoredChunks = chunks.map((chunk) => {
    let vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (vectorScore === 0 && queryEmbedding?.length !== chunk.embedding?.length) {
      localQueryEmbedding = localQueryEmbedding || computeLocalEmbedding(question);
      vectorScore = cosineSimilarity(localQueryEmbedding, computeLocalEmbedding(chunk.text));
    }
    const lexicalScore = computeLexicalOverlap(questionTerms, chunk.text);
    // Hybrid relevance score combining embedding similarity and lexical term match
    const combinedScore = vectorScore * 0.65 + lexicalScore * 0.35;

    return {
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      documentId: chunk.documentId,
      filename: chunk.filename,
      vectorScore,
      lexicalScore,
      score: combinedScore,
    };
  });

  scoredChunks.sort((a, b) => b.score - a.score);

  const threshold = env.similarityThreshold || 0.15;
  const filtered = scoredChunks.filter(
    (c) => c.score >= threshold || c.lexicalScore > 0 || c.vectorScore >= 0.45
  );

  return filtered.slice(0, topK);
}

