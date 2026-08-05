CREATE TABLE IF NOT EXISTS "registry_exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_url" text NOT NULL,
	"requested_date" date NOT NULL,
	"rate_date" date NOT NULL,
	"currency" varchar(3) NOT NULL,
	"nominal" integer NOT NULL,
	"rub_value" numeric(24, 8) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_exchange_rates_request_uidx" ON "registry_exchange_rates" USING btree ("portal_url","requested_date","currency");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registry_exchange_rates_lookup_idx" ON "registry_exchange_rates" USING btree ("portal_url","requested_date","rate_date");
