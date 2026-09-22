CREATE TABLE "registry_portal_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"domain" text NOT NULL,
	"portal_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"access_token_expires_at" timestamp with time zone,
	"application_token_hash" text NOT NULL,
	"disk_root_folder_id" bigint,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_portal_installations_member_uidx" ON "registry_portal_installations" USING btree ("member_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_portal_installations_domain_uidx" ON "registry_portal_installations" USING btree ("domain");
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_portal_installations_url_uidx" ON "registry_portal_installations" USING btree ("portal_url");
--> statement-breakpoint
CREATE INDEX "registry_portal_installations_retention_idx" ON "registry_portal_installations" USING btree ("status","delete_after");
