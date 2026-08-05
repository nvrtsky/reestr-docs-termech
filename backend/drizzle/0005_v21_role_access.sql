ALTER TABLE "registry_document_links" ADD COLUMN "deal_closed" boolean;
--> statement-breakpoint
ALTER TABLE "registry_document_links" ADD COLUMN "deal_state_checked_at" timestamp with time zone;
--> statement-breakpoint
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "portal_url", "department_id"
    ORDER BY "priority" ASC, "role_code" ASC, "created_at" ASC, "id" ASC
  ) AS position
  FROM "registry_department_roles"
)
DELETE FROM "registry_department_roles"
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);
--> statement-breakpoint
DROP INDEX "registry_department_roles_portal_department_role_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "registry_department_roles_portal_department_uidx"
ON "registry_department_roles" USING btree ("portal_url", "department_id");
