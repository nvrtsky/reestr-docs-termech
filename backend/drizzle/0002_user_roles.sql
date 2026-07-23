CREATE TABLE "registry_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"user_id" bigint NOT NULL,
	"user_name" text,
	"role_code" text NOT NULL,
	"assigned_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_user_roles_portal_user_uidx" ON "registry_user_roles" USING btree ("portal_url","user_id");--> statement-breakpoint
CREATE INDEX "registry_user_roles_portal_role_idx" ON "registry_user_roles" USING btree ("portal_url","role_code");