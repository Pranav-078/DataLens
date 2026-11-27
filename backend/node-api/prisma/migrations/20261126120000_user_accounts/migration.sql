-- Registered DataLens accounts. Existing projects are retained as unowned
-- legacy/admin workspaces; newly registered accounts receive their own project.
CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

ALTER TABLE "projects" ADD COLUMN "owner_user_id" TEXT;
CREATE INDEX "projects_owner_user_id_idx" ON "projects"("owner_user_id");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
