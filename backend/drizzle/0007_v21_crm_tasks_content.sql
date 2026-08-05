ALTER TABLE "registry_document_types"
  ADD COLUMN IF NOT EXISTS "content_required" boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS "registry_task_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portal_url" text NOT NULL,
  "document_id" uuid NOT NULL,
  "task_id" bigint NOT NULL,
  "task_title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registry_task_links_document_id_registry_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "registry_task_links_task_uidx"
  ON "registry_task_links" USING btree ("portal_url", "document_id", "task_id");
CREATE INDEX IF NOT EXISTS "registry_task_links_lookup_idx"
  ON "registry_task_links" USING btree ("portal_url", "task_id");
