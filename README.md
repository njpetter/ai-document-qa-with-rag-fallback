# Amber — AI-Powered Document Q&A REST API

A modular Retrieval-Augmented Generation (RAG) REST API built with **Node.js**, **Express**, **Multer**, **pdf-parse**, and the **Google Gemini API** (`@google/genai`).

## Features

- **PDF Document Upload (`POST /api/documents`)**
  - Accepts PDF files via `multipart/form-data` (`file` field) using `multer`
  - Validates `.pdf` extension and `application/pdf` MIME type
  - Enforces a **10 MB** maximum file size limit
  - Extracts text and page count via `pdf-parse` (`src/services/documentParser.service.js`)
  - Handles 0-byte PDFs, blank/scanned (no-text) PDFs, and corrupted PDFs with descriptive errors
  - Always deletes temporary uploaded files in a `finally` block (including on errors)
- **Shared Chunking, Embeddings & Vector Store**
  - Splits extracted or inline text into overlapping chunks (`src/services/chunker.service.js`)
  - Generates embeddings using Gemini (`gemini-embedding-001` via `@google/genai`)
  - Stores chunks, embeddings, and document metadata in an in-memory vector store (`src/store/document.store.js`) keyed by a unique `documentId`
- **Grounded Document Q&A (`POST /api/ask` & `POST /api/qa`)**
  - Retrieves top-$k$ relevant chunks using cosine similarity + lexical overlap (`src/services/retrieval.service.js`)
  - Passes retrieved context to Gemini (`gemini-3.8-flash`) with strict grounding instructions
  - Responds with `"The information is unavailable in the provided document."` when the answer is not present in the document

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and set your `GEMINI_API_KEY`:
   ```env
   PORT=3000
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_EMBEDDING_MODEL=gemini-embedding-001
   ```

3. **Run the server:**
   ```bash
   npm start
   ```

4. **Run end-to-end verification tests:**
   ```bash
   npm test
   ```

## API Endpoints

### 1. Upload a PDF Document
**`POST /api/documents`** (`multipart/form-data`)
```bash
curl -X POST http://localhost:3000/api/documents \
  -F "file=@sample.pdf"
```
**Response (`201 Created`):**
```json
{
  "documentId": "6b5c8a0d-c017-4e5f-b7c1-d604d98e0760",
  "filename": "sample.pdf",
  "totalPages": 2,
  "totalChunks": 2
}
```

### 2. Ask a Question Against an Uploaded Document
**`POST /api/ask`** (`application/json`)
```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{
    "documentId": "6b5c8a0d-c017-4e5f-b7c1-d604d98e0760",
    "question": "How often are production database backups executed?"
  }'
```

### 3. Single-Step Text Document + Question Q&A
**`POST /api/qa`** (`application/json`)
```bash
curl -X POST http://localhost:3000/api/qa \
  -H "Content-Type: application/json" \
  -d '{
    "document": "Helios operates at a cruising altitude of 18,500 meters and has a wingspan of 32 meters.",
    "question": "What is the cruising altitude of Helios?"
  }'
```

