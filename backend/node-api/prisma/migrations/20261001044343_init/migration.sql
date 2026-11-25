-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "label" TEXT,
    "duckdb_path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_tables" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "row_count" INTEGER,
    "column_count" INTEGER,
    "file_size_bytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sample_rows" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_columns" (
    "id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "column_name" TEXT NOT NULL,
    "ordinal_position" INTEGER NOT NULL,
    "inferred_type" TEXT,
    "semantic_type" TEXT,
    "is_pk_candidate" BOOLEAN NOT NULL DEFAULT false,
    "pk_confidence" DECIMAL(4,3),

    CONSTRAINT "dataset_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "column_statistics" (
    "column_id" TEXT NOT NULL,
    "null_count" INTEGER NOT NULL,
    "null_percentage" DECIMAL(6,3) NOT NULL,
    "distinct_count" INTEGER NOT NULL,
    "uniqueness_ratio" DECIMAL(6,5) NOT NULL,
    "min_value" TEXT,
    "max_value" TEXT,
    "mean" DECIMAL,
    "stddev" DECIMAL,
    "top_values" JSONB,
    "type_distribution" JSONB,
    "sample_values" JSONB,

    CONSTRAINT "column_statistics_pkey" PRIMARY KEY ("column_id")
);

-- CreateTable
CREATE TABLE "quality_issues" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "table_id" TEXT,
    "column_id" TEXT,
    "issue_type" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "affected_rows" INTEGER NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "affected_percentage" DECIMAL(6,3) NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "suggested_action" TEXT,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_scores" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "overall_score" DECIMAL(5,2),
    "completeness" DECIMAL(5,2),
    "uniqueness" DECIMAL(5,2),
    "validity" DECIMAL(5,2),
    "consistency" DECIMAL(5,2),
    "referential_integrity" DECIMAL(5,2),
    "applicable_dimensions" TEXT[],
    "weights_used" JSONB NOT NULL,
    "cap_applied" DECIMAL(5,2),
    "cap_reason" TEXT,
    "calculation_breakdown" JSONB NOT NULL,
    "critical_count" INTEGER NOT NULL DEFAULT 0,
    "high_count" INTEGER NOT NULL DEFAULT 0,
    "medium_count" INTEGER NOT NULL DEFAULT 0,
    "low_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inferred_relationships" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "parent_table_id" TEXT NOT NULL,
    "parent_column_id" TEXT NOT NULL,
    "child_table_id" TEXT NOT NULL,
    "child_column_id" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "confidence_band" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inferred',
    "value_overlap" DECIMAL(6,5) NOT NULL,
    "orphan_count" INTEGER NOT NULL,
    "orphan_percentage" DECIMAL(6,3) NOT NULL,
    "orphan_examples" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inferred_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_explanations" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "business_impact" TEXT,
    "recommended_action" TEXT,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_facts" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_explanations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "page_number" INTEGER,
    "section_heading" TEXT,
    "embedding" vector(1536),

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "retrieved_chunk_ids" TEXT[],
    "retrieval_scores" JSONB,
    "refused" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sql_queries" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "natural_language_question" TEXT NOT NULL,
    "generated_sql" TEXT NOT NULL,
    "validated_sql" TEXT,
    "validation_passed" BOOLEAN NOT NULL,
    "rejection_reason" TEXT,
    "row_count" INTEGER,
    "execution_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sql_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'html',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version_id" TEXT,
    "job_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "current_step" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dataset_versions_project_id_created_at_idx" ON "dataset_versions"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_project_id_version_number_key" ON "dataset_versions"("project_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_tables_version_id_table_name_key" ON "dataset_tables"("version_id", "table_name");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_tables_version_id_normalized_name_key" ON "dataset_tables"("version_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_columns_table_id_column_name_key" ON "dataset_columns"("table_id", "column_name");

-- CreateIndex
CREATE INDEX "quality_issues_version_id_severity_idx" ON "quality_issues"("version_id", "severity");

-- CreateIndex
CREATE INDEX "quality_issues_version_id_table_id_idx" ON "quality_issues"("version_id", "table_id");

-- CreateIndex
CREATE INDEX "quality_issues_version_id_issue_type_idx" ON "quality_issues"("version_id", "issue_type");

-- CreateIndex
CREATE INDEX "quality_issues_version_id_fingerprint_idx" ON "quality_issues"("version_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "quality_scores_version_id_key" ON "quality_scores"("version_id");

-- CreateIndex
CREATE INDEX "inferred_relationships_version_id_confidence_idx" ON "inferred_relationships"("version_id", "confidence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_explanations_issue_id_key" ON "ai_explanations"("issue_id");

-- CreateIndex
CREATE INDEX "document_chunks_document_id_chunk_index_idx" ON "document_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "jobs_project_id_created_at_idx" ON "jobs"("project_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_tables" ADD CONSTRAINT "dataset_tables_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_columns" ADD CONSTRAINT "dataset_columns_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dataset_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "column_statistics" ADD CONSTRAINT "column_statistics_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "dataset_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dataset_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "dataset_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_scores" ADD CONSTRAINT "quality_scores_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inferred_relationships" ADD CONSTRAINT "inferred_relationships_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inferred_relationships" ADD CONSTRAINT "inferred_relationships_parent_table_id_fkey" FOREIGN KEY ("parent_table_id") REFERENCES "dataset_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inferred_relationships" ADD CONSTRAINT "inferred_relationships_parent_column_id_fkey" FOREIGN KEY ("parent_column_id") REFERENCES "dataset_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inferred_relationships" ADD CONSTRAINT "inferred_relationships_child_table_id_fkey" FOREIGN KEY ("child_table_id") REFERENCES "dataset_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inferred_relationships" ADD CONSTRAINT "inferred_relationships_child_column_id_fkey" FOREIGN KEY ("child_column_id") REFERENCES "dataset_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "quality_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sql_queries" ADD CONSTRAINT "sql_queries_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
