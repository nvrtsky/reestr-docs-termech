CREATE TYPE "public"."registry_attachment_kind" AS ENUM('file', 'link');--> statement-breakpoint
CREATE TYPE "public"."registry_entity_type" AS ENUM('deal', 'company');--> statement-breakpoint
CREATE TYPE "public"."registry_field_data_type" AS ENUM('text', 'number', 'date', 'money', 'select', 'boolean', 'file');--> statement-breakpoint
CREATE TABLE "registry_department_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"department_id" bigint NOT NULL,
	"role_code" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_role_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"role_code" text NOT NULL,
	"role_name" text NOT NULL,
	"visible_section_codes" jsonb NOT NULL,
	"visible_type_codes" jsonb,
	"hidden_fields" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"hide_money" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"owner_user_id" bigint,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"section_id" uuid NOT NULL,
	"lifecycle_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_financial" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_lifecycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "registry_attachment_kind" NOT NULL,
	"name" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"disk_file_id" bigint,
	"disk_folder_id" bigint,
	"url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"replaces_attachment_id" uuid,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registry_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"document_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" bigint,
	"actor_name" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_document_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"document_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" "registry_entity_type" NOT NULL,
	"entity_id" bigint NOT NULL,
	"entity_title" text NOT NULL,
	"link_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"section_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"number" text,
	"title" text NOT NULL,
	"document_date" date NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" numeric(18, 2),
	"currency" varchar(3),
	"legal_entity_id" bigint,
	"legal_entity_name" text,
	"counterparty_id" bigint,
	"counterparty_name" text,
	"deal_stage_id" text,
	"status" text NOT NULL,
	"comment" text,
	"responsible_id" bigint NOT NULL,
	"responsible_name" text,
	"created_by" bigint NOT NULL,
	"updated_by" bigint,
	"supersedes_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"data_type" "registry_field_data_type" NOT NULL,
	"options" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_type_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"type_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"label_override" text,
	"options_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_document_types" ADD CONSTRAINT "registry_document_types_section_id_registry_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."registry_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_document_types" ADD CONSTRAINT "registry_document_types_lifecycle_id_registry_lifecycles_id_fk" FOREIGN KEY ("lifecycle_id") REFERENCES "public"."registry_lifecycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_attachments" ADD CONSTRAINT "registry_attachments_document_id_registry_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_audit_log" ADD CONSTRAINT "registry_audit_log_document_id_registry_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_document_field_values" ADD CONSTRAINT "registry_document_field_values_document_id_registry_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_document_field_values" ADD CONSTRAINT "registry_document_field_values_field_definition_id_registry_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."registry_field_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_document_links" ADD CONSTRAINT "registry_document_links_document_id_registry_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."registry_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_documents" ADD CONSTRAINT "registry_documents_section_id_registry_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."registry_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_documents" ADD CONSTRAINT "registry_documents_type_id_registry_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."registry_document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_type_fields" ADD CONSTRAINT "registry_type_fields_type_id_registry_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."registry_document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_type_fields" ADD CONSTRAINT "registry_type_fields_field_definition_id_registry_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."registry_field_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_department_roles_portal_department_role_uidx" ON "registry_department_roles" USING btree ("portal_url","department_id","role_code");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_role_policies_portal_role_uidx" ON "registry_role_policies" USING btree ("portal_url","role_code");--> statement-breakpoint
CREATE INDEX "registry_saved_views_owner_idx" ON "registry_saved_views" USING btree ("portal_url","owner_user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_settings_portal_key_uidx" ON "registry_settings" USING btree ("portal_url","key");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_document_types_portal_code_uidx" ON "registry_document_types" USING btree ("portal_url","code");--> statement-breakpoint
CREATE INDEX "registry_document_types_portal_section_idx" ON "registry_document_types" USING btree ("portal_url","section_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_lifecycles_portal_code_uidx" ON "registry_lifecycles" USING btree ("portal_url","code");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_sections_portal_code_uidx" ON "registry_sections" USING btree ("portal_url","code");--> statement-breakpoint
CREATE INDEX "registry_sections_portal_sort_idx" ON "registry_sections" USING btree ("portal_url","sort_order");--> statement-breakpoint
CREATE INDEX "registry_attachments_document_idx" ON "registry_attachments" USING btree ("portal_url","document_id","is_current");--> statement-breakpoint
CREATE INDEX "registry_audit_log_document_idx" ON "registry_audit_log" USING btree ("portal_url","document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_document_field_values_document_field_uidx" ON "registry_document_field_values" USING btree ("portal_url","document_id","field_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_document_links_entity_uidx" ON "registry_document_links" USING btree ("portal_url","document_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "registry_document_links_lookup_idx" ON "registry_document_links" USING btree ("portal_url","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_status_idx" ON "registry_documents" USING btree ("portal_url","status","deleted_at");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_section_idx" ON "registry_documents" USING btree ("portal_url","section_id","deleted_at");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_type_idx" ON "registry_documents" USING btree ("portal_url","type_id","deleted_at");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_counterparty_idx" ON "registry_documents" USING btree ("portal_url","counterparty_id","deleted_at");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_responsible_idx" ON "registry_documents" USING btree ("portal_url","responsible_id","deleted_at");--> statement-breakpoint
CREATE INDEX "registry_documents_portal_date_idx" ON "registry_documents" USING btree ("portal_url","document_date");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_field_definitions_portal_key_uidx" ON "registry_field_definitions" USING btree ("portal_url","key");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_type_fields_type_field_uidx" ON "registry_type_fields" USING btree ("portal_url","type_id","field_definition_id");--> statement-breakpoint
CREATE INDEX "registry_type_fields_type_sort_idx" ON "registry_type_fields" USING btree ("portal_url","type_id","sort_order");