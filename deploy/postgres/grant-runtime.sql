-- Run as the migration/admin role after prisma migrate deploy.
-- The API gets DML rights only; schema changes remain a migration concern.
-- Read credentials from the container environment rather than command-line
-- arguments so the runtime password is not exposed in the process list.
\set ON_ERROR_STOP on
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv migration_user POSTGRES_USER
\getenv db_name POSTGRES_DB

SELECT format(
  'CREATE ROLE %I WITH LOGIN PASSWORD %L',
  :'app_user',
  :'app_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'app_user'
)
\gexec

ALTER ROLE :"app_user" WITH LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_user";

ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_user" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";
