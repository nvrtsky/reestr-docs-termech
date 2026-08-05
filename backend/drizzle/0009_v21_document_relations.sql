CREATE TABLE "registry_document_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"parent_document_id" uuid NOT NULL,
	"child_document_id" uuid NOT NULL,
	"relation_type" varchar(30) NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_document_relations_not_self" CHECK ("parent_document_id" <> "child_document_id"),
	CONSTRAINT "registry_document_relations_type" CHECK ("relation_type" IN ('addendum', 'appendix', 'other'))
);
--> statement-breakpoint
ALTER TABLE "registry_document_relations" ADD CONSTRAINT "registry_document_relations_parent_document_id_registry_documents_id_fk" FOREIGN KEY ("parent_document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "registry_document_relations" ADD CONSTRAINT "registry_document_relations_child_document_id_registry_documents_id_fk" FOREIGN KEY ("child_document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_document_relations_child_uidx" ON "registry_document_relations" USING btree ("portal_url", "child_document_id");
--> statement-breakpoint
CREATE INDEX "registry_document_relations_parent_idx" ON "registry_document_relations" USING btree ("portal_url", "parent_document_id");
