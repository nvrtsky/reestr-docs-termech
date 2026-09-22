ALTER TABLE "registry_document_types"
  ALTER COLUMN "content_required" SET DEFAULT false;
--> statement-breakpoint
UPDATE "registry_document_types"
  SET "content_required" = false, "updated_at" = now()
  WHERE "content_required" = true;
