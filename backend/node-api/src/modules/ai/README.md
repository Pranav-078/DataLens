# DataLens Gemini RAG and agent assistant

## Configuration

Set `GEMINI_API_KEY` in the repository-root `.env`. The key is read only by the Node API and must never be placed in frontend environment variables or committed.

- Chat and agent planning: `gemini-2.5-flash`
- Text embeddings: `gemini-embedding-001`, 1536 dimensions
- Vector storage and nearest-neighbor retrieval: PostgreSQL pgvector

## API

### Index a knowledge document

`POST /projects/:projectId/knowledge` as multipart form data:

- `file`: a UTF-8 `.txt` or `.md` file (max 10 MB)

The endpoint chunks the document, requests Gemini embeddings, and persists the chunks in the existing `documents` and `document_chunks` tables.

### Ask the DataLens assistant

`POST /projects/:projectId/ai/chat` JSON body:

```json
{
  "question": "Explain the most serious quality issues",
  "versionId": "dataset-version-uuid",
  "sessionId": "optional-existing-chat-session-uuid"
}
```

The planner can select one read-only tool: `quality_issues`, `schema`, `relationships`, or `quality_score`. The final response combines that tool output with retrieved document passages and includes source labels.

## Limitations and safety

- Current knowledge upload supports UTF-8 TXT and Markdown only; PDF extraction is not wired yet.
- Tool execution is read-only. It does not execute generated SQL or modify datasets.
- This is a project-scoped preview API, not an authenticated multi-tenant production endpoint. Add real authentication and authorization before exposing it publicly.
- Gemini free-tier data-use terms may differ from paid-tier terms. Review Google's current terms before indexing confidential data.
- The API uses pgvector's existing `document_chunks.embedding` vector column. The column must be dimension-compatible with 1536-value Gemini embeddings.
