ALTER TABLE "registry_documents" ADD COLUMN "external_document_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_documents_external_document_uidx" ON "registry_documents" USING btree ("portal_url","external_source","external_document_id");
--> statement-breakpoint
CREATE TABLE "registry_document_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portal_url" text NOT NULL,
  "document_id" uuid NOT NULL,
  "source" varchar(40) NOT NULL,
  "external_document_id" text NOT NULL,
  "version_id" text NOT NULL,
  "released_at" timestamp with time zone NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "pdf_sha256" varchar(64) NOT NULL,
  "attachment_id" uuid,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registry_document_releases_document_id_registry_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "registry_document_releases_attachment_id_registry_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."registry_attachments"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_document_releases_identity_uidx" ON "registry_document_releases" USING btree ("portal_url","source","external_document_id","version_id");
--> statement-breakpoint
CREATE INDEX "registry_document_releases_latest_idx" ON "registry_document_releases" USING btree ("portal_url","document_id","status","released_at");
