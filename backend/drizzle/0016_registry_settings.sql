ALTER TABLE "registry_settings"
  ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;

CREATE TABLE IF NOT EXISTS "registry_settings_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portal_url" text NOT NULL,
  "setting_key" text NOT NULL,
  "version" integer NOT NULL,
  "actor_id" bigint NOT NULL,
  "actor_name" text,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "registry_settings_audit_portal_key_idx"
  ON "registry_settings_audit" USING btree ("portal_url", "setting_key", "created_at");
