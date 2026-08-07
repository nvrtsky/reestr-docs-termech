ALTER TABLE "registry_documents"
  ADD COLUMN IF NOT EXISTS "is_finalized" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_documents_active_supersedes_uidx"
  ON "registry_documents" USING btree ("portal_url", "supersedes_id")
  WHERE "supersedes_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registry_documents_portal_finalized_idx"
  ON "registry_documents" USING btree ("portal_url", "is_finalized", "deleted_at");
