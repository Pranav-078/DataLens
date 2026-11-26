# DataLens RAG and data intelligence assistant

DataLens uses a project-scoped retrieval-augmented generation (RAG) pipeline. It combines document evidence with read-only dataset intelligence tools.

## Architecture

- **Generation / embeddings:** Gemini 2.5 Flash and Gemini Embedding 001 (1,536 dimensions).
- **Vector store:** PostgreSQL 16 with pgvector.
- **Lexical retrieval:** PostgreSQL full-text search using `websearch_to_tsquery` and `ts_rank_cd`.
- **Hybrid fusion:** Reciprocal Rank Fusion (RRF), so vector distance and lexical rank are not incorrectly treated as the same score.
- **Reranking:** Gemini-based candidate reranking. When reranking is disabled or fails, the system falls back to fused retrieval.
- **Conversation context:** A configurable recent-message window is supplied to the planner, retrieval query and answer prompt.
- **Evidence:** Sources include document, chunk, section, page (when extraction provides it), vector similarity and fusion metadata.
- **Evaluation:** Pure evaluation utilities report Precision@K, Recall@K, MRR and nDCG@K. Unit tests cover chunking, fusion, safe reranking and metric calculations.

## Pipeline

1. Validate and extract an uploaded PDF, TXT or Markdown file.
2. Split text around paragraph boundaries, preserving Markdown headings and page markers when present.
3. Generate Gemini embeddings and store chunk text, metadata and vectors in PostgreSQL.
4. Retrieve candidate evidence from vector search and PostgreSQL full-text search in parallel.
5. Merge candidate rankings with Reciprocal Rank Fusion.
6. Optionally rerank candidates with Gemini; retain the RRF order on reranker failure.
7. Pass retrieved evidence, recent conversation context and selected read-only dataset-tool output to Gemini.
8. Return source citations and retrieval diagnostics with the answer; persist evidence metadata with the chat messages.

## Configuration

Set `GEMINI_API_KEY` in the repository-root `.env`. Never put this secret in frontend environment variables or commit it.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RAG_RERANK_ENABLED` | `true` | Enable Gemini candidate reranking |
| `RAG_RETRIEVAL_CANDIDATES` | `25` | Candidate count from each retriever |
| `RAG_TOP_K` | `5` | Final evidence passages |
| `RAG_MIN_SIMILARITY` | `0.20` | Minimum vector similarity for vector-only candidates |
| `RAG_HISTORY_MESSAGES` | `8` | Recent chat messages supplied as context |

Docker Compose passes these settings to the API service. The values can be overridden in the root `.env`.

## API

### Index a document

`POST /projects/:projectId/knowledge` (multipart form field `file`, max 10 MB):

- `.pdf`, `.txt`, or `.md`
- Documents are stored as project-scoped records.
- Chunks are embedded and stored in `document_chunks`.
- Document status is set to `ready` only after indexing finishes; a failed indexing attempt is marked `failed`.

### Ask the assistant

`POST /projects/:projectId/ai/chat/stream` (SSE) or `POST /projects/:projectId/ai/chat` (JSON):

```json
{
  "question": "Explain the most serious quality issues",
  "versionId": "dataset-version-uuid",
  "sessionId": "optional-existing-chat-session-uuid"
}
```

The response includes a `sources` array and `retrieval` diagnostics. Stream clients receive both in the initial `meta` event.

### Inspect RAG status

`GET /projects/:projectId/ai/rag/status` returns document counts, indexed chunk count, retrieval mode, candidate limits and reranker configuration. It never returns provider secrets.

## Database migration

The additive migration `20261126110000_professional_rag_search` creates:
- a project/status index for ready-document filtering;
- a GIN full-text index over section heading plus chunk content;
- an HNSW cosine index over existing embeddings;
- a chronological chat-message index for conversation memory.

The migration does not delete documents, chunks, embeddings, chat sessions or messages. The API Dockerfile runs `prisma migrate deploy` before starting the server.

## Evaluation

Run backend tests:

```powershell
cd backend/node-api
npm test
npm run build
```

RAG utility tests cover:
- heading-aware chunk splitting and invalid chunk settings;
- vector/keyword reciprocal rank fusion;
- validating model-produced rerank IDs;
- Precision@K, Recall@K, MRR and nDCG@K calculations.

For a meaningful deployment evaluation, prepare a held-out set of real user questions with manually reviewed relevant chunk IDs and evaluate retrieval against that ground truth. Unit tests prove metric calculations, not the real-world quality of your corpus.

## Operational and security notes

- All dataset tools are read-only; generated SQL is not executed.
- Retrieved files and conversation text are untrusted data, not instructions.
- Gemini API credentials remain on the server.
- When no documents are indexed, document retrieval is skipped; dataset-tool chat can still proceed.
- PDF text extraction currently relies on Gemini native PDF extraction. Page markers are requested for citation metadata, but page numbers may be unavailable when the model does not return them. Scanned/image-only documents can require OCR.
- Hybrid search is not a guarantee of factual correctness. Validate citations and dataset measurements against the source files.
- Single-admin authentication is not tenant isolation. Do not expose this preview to independent customers without user/project authorization and a security review.
- Review Gemini data-use terms and deployment region requirements before processing confidential customer documents.
