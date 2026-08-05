CREATE TABLE "registry_attachment_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"deal_id" bigint NOT NULL,
	"deal_title" text NOT NULL,
	"disk_file_id" bigint NOT NULL,
	"disk_folder_id" bigint NOT NULL,
	"storage_path" text NOT NULL,
	"url" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "registry_attachment_copies" ADD CONSTRAINT "registry_attachment_copies_attachment_id_registry_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."registry_attachments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_attachment_copies_deal_uidx" ON "registry_attachment_copies" USING btree ("portal_url", "attachment_id", "deal_id");
--> statement-breakpoint
CREATE INDEX "registry_attachment_copies_deal_lookup_idx" ON "registry_attachment_copies" USING btree ("portal_url", "deal_id", "deleted_at");
