-- Hybrid RAG retrieval indexes. These indexes are additive and preserve existing documents/chunks.
CREATE INDEX IF NOT EXISTS "documents_project_id_status_idx"
  ON "documents"("project_id", "status");

-- PostgreSQL full-text index used by websearch_to_tsquery in the hybrid retriever.
CREATE INDEX IF NOT EXISTS "document_chunks_content_fts_idx"
  ON "document_chunks"
  USING GIN (to_tsvector('simple', coalesce("section_heading", '') || ' ' || "content"));

-- Approximate nearest-neighbour index for cosine distance over Gemini embeddings.
CREATE INDEX IF NOT EXISTS "document_chunks_embedding_hnsw_idx"
  ON "document_chunks"
  USING hnsw ("embedding" vector_cosine_ops);

-- Fast chronological fetch of the recent messages used for conversation context.
CREATE INDEX IF NOT EXISTS "chat_messages_session_id_created_at_idx"
  ON "chat_messages"("session_id", "created_at" DESC);
