ALTER TABLE "registry_document_links" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;
ALTER TABLE "registry_document_links" ADD COLUMN "deal_responsible_id" bigint;
ALTER TABLE "registry_document_links" ADD COLUMN "deal_responsible_name" text;
CREATE INDEX "registry_document_links_responsible_idx" ON "registry_document_links" USING btree ("portal_url", "deal_responsible_id");
