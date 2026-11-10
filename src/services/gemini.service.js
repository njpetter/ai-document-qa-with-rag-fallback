import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { AppError } from '../utils/appError.js';

export const UNAVAILABLE_MESSAGE = 'The information is unavailable in the provided document.';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'with', 'about', 'against', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'from',
  'up', 'down', 'of', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'can', 'will', 'just', 'should', 'now', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'am', 'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'would', 'could', 'ought', 'and', 'but',
  'if', 'or', 'because', 'as', 'until', 'while', 'by', 'tell', 'me'
]);

let genAiClient = null;

function getClient() {
  if (!env.geminiApiKey) {
    return null;
  }
  if (!genAiClient) {
    genAiClient = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }
  return genAiClient;
}

/**
 * Checks whether a Gemini SDK error represents an HTTP 429 rate-limit or quota-exhausted error.
 */
export function isQuotaOrRateLimitError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.code ?? err?.error?.code;
  if (status === 429 || status === '429' || status === 'RESOURCE_EXHAUSTED') {
    return true;
  }
  const message = `${err.message || ''} ${JSON.stringify(err.error || '')}`.toLowerCase();
  return (
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  );
}

/**
 * Tokenizes text into normalized content terms for fallback embedding and grounding checks.
 */
export function tokenizeTerms(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Deterministic 256-dimensional unit vector embedding used as a fallback
 * when GEMINI_API_KEY is not configured in the environment.
 */
export function computeLocalEmbedding(text, dimensions = 256) {
  const vec = new Float64Array(dimensions);
  const terms = tokenizeTerms(text);

  for (const term of terms) {
    // Hash term and character trigrams for semantic/morphological resilience
    const tokensToHash = [term];
    if (term.length >= 4) {
      for (let i = 0; i <= term.length - 3; i++) {
        tokensToHash.push(term.slice(i, i + 3));
      }
    }

    for (const token of tokensToHash) {
      let hash1 = 2166136261;
      let hash2 = 16777619;
      for (let i = 0; i < token.length; i++) {
        const code = token.charCodeAt(i);
        hash1 ^= code;
        hash1 = Math.imul(hash1, 16777619);
        hash2 ^= code;
        hash2 = Math.imul(hash2, 2166136261);
      }
      const idx = Math.abs(hash1) % dimensions;
      const sign = (hash2 & 1) === 0 ? 1 : -1;
      const weight = token === term ? 2.0 : 0.5;
      vec[idx] += sign * weight;
    }
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vec[i] /= norm;
    }
  }

  return Array.from(vec);
}

/**
 * Generates embeddings for an array of text strings using Gemini's embedding model.
 * Reused across both PDF chunk ingestion, text document ingestion, and query embedding.
 *
 * @param {string[]} texts - Array of text chunks or queries
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function generateEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new AppError('Cannot generate embeddings for an empty array of texts.', 400, 'EMPTY_EMBEDDING_INPUT');
  }

  const client = getClient();
  if (client) {
    try {
      const response = await client.models.embedContent({
        model: env.embeddingModel,
        contents: texts,
      });

      if (response?.embeddings && Array.isArray(response.embeddings)) {
        return response.embeddings.map((emb) => emb.values || []);
      }
    } catch (err) {
      if (isQuotaOrRateLimitError(err)) {
        console.warn(
          '[Gemini 429 Quota/Rate Limit] Embedding quota exceeded; falling back to local deterministic embeddings.'
        );
      } else {
        throw new AppError(
          `Gemini Embedding API error: ${err.message}`,
          502,
          'GEMINI_EMBEDDING_ERROR'
        );
      }
    }
  }

  // Fallback when GEMINI_API_KEY is not configured or quota (429) is exhausted
  return texts.map((t) => computeLocalEmbedding(t));
}

/**
 * Generates a single embedding vector for a query or chunk.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text) {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

/**
 * Generates a grounded answer based strictly on the retrieved document chunks.
 * If the answer is not in the retrieved chunks, returns UNAVAILABLE_MESSAGE.
 *
 * @param {string} question - The user's question
 * @param {Array<{ text: string, score: number, chunkIndex: number }>} relevantChunks - Retrieved chunks
 * @returns {Promise<{ answer: string, available: boolean, provider: string }>}
 */
export async function generateGroundedAnswer(question, relevantChunks) {
  if (!relevantChunks || relevantChunks.length === 0) {
    return {
      answer: UNAVAILABLE_MESSAGE,
      available: false,
      provider: getClient() ? 'gemini' : 'local-fallback',
    };
  }

  const formattedContext = relevantChunks
    .map((chunk, i) => `[Chunk ${i + 1} (index ${chunk.chunkIndex}, score ${chunk.score.toFixed(3)})]:\n${chunk.text}`)
    .join('\n\n---\n\n');

  const systemInstruction = [
    'You are a strict document question-answering assistant.',
    'You must answer the user question ONLY using the facts explicitly present in the provided DOCUMENT CONTEXT.',
    'Do NOT use outside knowledge, assumptions, or extrapolations.',
    `If the provided DOCUMENT CONTEXT does not contain the answer to the question, you MUST respond with the exact sentence: "${UNAVAILABLE_MESSAGE}"`,
  ].join(' ');

  const prompt = `DOCUMENT CONTEXT:\n${formattedContext}\n\nUSER QUESTION:\n${question}`;

  const client = getClient();
  if (client) {
    try {
      const interaction = await client.interactions.create({
        model: env.geminiModel,
        system_instruction: systemInstruction,
        input: prompt,
      });

      const rawAnswer = (interaction?.output_text || '').trim();
      if (!rawAnswer) {
        return {
          answer: UNAVAILABLE_MESSAGE,
          available: false,
          provider: 'gemini',
        };
      }

      const isUnavailable =
        rawAnswer.toLowerCase().includes('information is unavailable') ||
        rawAnswer.toLowerCase().includes('not available in the provided document') ||
        rawAnswer.toLowerCase().includes('cannot be found in the provided');

      return {
        answer: isUnavailable ? UNAVAILABLE_MESSAGE : rawAnswer,
        available: !isUnavailable,
        provider: 'gemini',
      };
    } catch (err) {
      if (isQuotaOrRateLimitError(err)) {
        console.warn(
          '[Gemini 429 Quota/Rate Limit] LLM quota exceeded; falling back to local extractive answer generation.'
        );
      } else {
        throw new AppError(`Gemini LLM generation error: ${err.message}`, 502, 'GEMINI_LLM_ERROR');
      }
    }
  }

  // Deterministic grounded answer extraction when running without GEMINI_API_KEY or when Gemini returns 429
  const questionTerms = tokenizeTerms(question);
  if (questionTerms.length === 0) {
    return {
      answer: UNAVAILABLE_MESSAGE,
      available: false,
      provider: 'local-fallback',
    };
  }

  const allSentences = [];
  for (const chunk of relevantChunks) {
    const sentences = chunk.text
      .split(/(?<=[.?!])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const sentence of sentences) {
      const sentenceTerms = new Set(tokenizeTerms(sentence));
      let matchedCount = 0;
      for (const qTerm of questionTerms) {
        if (sentenceTerms.has(qTerm)) {
          matchedCount++;
        } else {
          // Check prefix stem match (length >= 4)
          const stem = qTerm.slice(0, Math.max(4, qTerm.length - 2));
          if (stem.length >= 4 && Array.from(sentenceTerms).some((st) => st.startsWith(stem) || qTerm.startsWith(st.slice(0, Math.max(4, st.length - 2))))) {
            matchedCount += 0.8;
          }
        }
      }
      if (matchedCount > 0) {
        allSentences.push({
          sentence,
          score: matchedCount / questionTerms.length,
          matchedCount,
        });
      }
    }
  }

  allSentences.sort((a, b) => b.score - a.score || b.matchedCount - a.matchedCount);

  const minRequiredScore = questionTerms.length <= 2 ? 0.5 : 0.45;
  if (
    allSentences.length === 0 ||
    allSentences[0].matchedCount < 1 ||
    allSentences[0].score < minRequiredScore
  ) {
    return {
      answer: UNAVAILABLE_MESSAGE,
      available: false,
      provider: 'local-fallback',
    };
  }

  // Combine top unique matching sentences from the document
  const selected = [];
  const seen = new Set();
  for (const item of allSentences) {
    if (!seen.has(item.sentence) && item.score >= allSentences[0].score * 0.5) {
      seen.add(item.sentence);
      selected.push(item.sentence);
      if (selected.length >= 2) break;
    }
  }

  return {
    answer: selected.join(' '),
    available: true,
    provider: 'local-fallback',
  };
}
