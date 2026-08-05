CREATE TABLE IF NOT EXISTS "registry_bulk_upload_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"created_by" bigint NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"client_row_id" varchar(100) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_bulk_upload_items_document_id_registry_documents_id_fk"
		FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_bulk_upload_items_idempotency_uidx"
	ON "registry_bulk_upload_items" USING btree ("portal_url", "created_by", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registry_bulk_upload_items_document_idx"
	ON "registry_bulk_upload_items" USING btree ("portal_url", "document_id");
