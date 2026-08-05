ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_source" varchar(40);
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_entity_type_id" integer;
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_entity_id" bigint;
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_status" text;
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN IF NOT EXISTS "external_synced_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_documents_external_entity_uidx"
  ON "registry_documents" USING btree (
    "portal_url",
    "external_source",
    "external_entity_type_id",
    "external_entity_id"
  );
--> statement-breakpoint
INSERT INTO "registry_document_types" (
  "portal_url",
  "section_id",
  "lifecycle_id",
  "code",
  "name",
  "description",
  "is_financial",
  "content_required",
  "sort_order",
  "is_active"
)
SELECT
  section."portal_url",
  section."id",
  lifecycle."id",
  'client_quote',
  'Коммерческое предложение',
  'Карточка коммерческого предложения, синхронизированная из Bitrix24',
  true,
  false,
  45,
  true
FROM "registry_sections" AS section
INNER JOIN "registry_lifecycles" AS lifecycle
  ON lifecycle."portal_url" = section."portal_url"
 AND lifecycle."code" = 'simple'
WHERE section."code" = 'client'
ON CONFLICT ("portal_url", "code") DO NOTHING;
