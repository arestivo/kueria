#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ $# != 2 || -z "${2:-}" ]]; then
  echo "Usage: $0 <student_name> <password>" >&2
  exit 1
fi
STUDENT=$1
validate_student "$STUDENT"
check_student_ownership "$STUDENT"

# Rerunning repairs partial setup without changing an existing password.
# psql quotes identifiers/literals; ON_ERROR_STOP also covers generated SQL.
admin_psql --set=student="$STUDENT" --set=password="$2" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'student', :'password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'student')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'student', :'student')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'student')
\gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'student')
\gexec
SELECT format('ALTER ROLE %I SET work_mem = %L', :'student', '4MB')
\gexec
SELECT format('ALTER ROLE %I SET temp_file_limit = %L', :'student', '64MB')
\gexec
SQL
