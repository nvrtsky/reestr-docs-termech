ALTER TABLE "registry_document_types" ADD COLUMN "number_format" text;
--> statement-breakpoint
ALTER TABLE "registry_document_types" ADD COLUMN "number_auto_generate" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "registry_document_types" ADD COLUMN "number_uniqueness_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "registry_documents" ADD COLUMN "number_uniqueness_key" text;
--> statement-breakpoint
ALTER TABLE "registry_attachments" ADD COLUMN "field_definition_id" uuid;
--> statement-breakpoint
ALTER TABLE "registry_attachments" ADD CONSTRAINT "registry_attachments_field_definition_id_registry_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."registry_field_definitions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "registry_documents_portal_number_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_documents_portal_number_scope_uidx" ON "registry_documents" USING btree ("portal_url", "type_id", "number_uniqueness_key");
--> statement-breakpoint
CREATE INDEX "registry_attachments_document_field_idx" ON "registry_attachments" USING btree ("portal_url", "document_id", "field_definition_id", "is_current");
--> statement-breakpoint
CREATE TABLE "registry_number_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"type_id" uuid NOT NULL,
	"company_scope" bigint DEFAULT 0 NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_number_sequences_type_id_registry_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."registry_document_types"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_number_sequences_scope_uidx" ON "registry_number_sequences" USING btree ("portal_url", "type_id", "company_scope");
