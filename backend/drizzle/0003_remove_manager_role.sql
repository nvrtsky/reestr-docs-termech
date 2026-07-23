DELETE FROM "registry_user_roles" WHERE "role_code" = 'manager';
--> statement-breakpoint
DELETE FROM "registry_department_roles" WHERE "role_code" = 'manager';
--> statement-breakpoint
DELETE FROM "registry_role_policies" WHERE "role_code" = 'manager';
