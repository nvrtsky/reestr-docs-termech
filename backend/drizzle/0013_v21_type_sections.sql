CREATE TABLE IF NOT EXISTS "registry_document_type_sections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portal_url" text NOT NULL,
  "type_id" uuid NOT NULL,
  "section_id" uuid NOT NULL,
  "sort_order" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registry_document_type_sections_type_id_registry_document_types_id_fk"
    FOREIGN KEY ("type_id") REFERENCES "public"."registry_document_types"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "registry_document_type_sections_section_id_registry_sections_id_fk"
    FOREIGN KEY ("section_id") REFERENCES "public"."registry_sections"("id")
    ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_document_type_sections_scope_uidx"
  ON "registry_document_type_sections" USING btree ("portal_url", "type_id", "section_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registry_document_type_sections_portal_section_idx"
  ON "registry_document_type_sections" USING btree ("portal_url", "section_id", "sort_order");
--> statement-breakpoint
INSERT INTO "registry_document_type_sections" (
  "portal_url",
  "type_id",
  "section_id",
  "sort_order"
)
SELECT
  type."portal_url",
  type."id",
  type."section_id",
  type."sort_order"
FROM "registry_document_types" AS type
ON CONFLICT ("portal_url", "type_id", "section_id") DO NOTHING;
