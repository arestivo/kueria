#!/bin/bash
set -euo pipefail

POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-kueria_postgres}

validate_student() {
  if ! [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]] || (( ${#1} > 63 )) ||
      [[ "$1" == postgres || "$1" == template0 || "$1" == template1 || "$1" == pg_* ]]; then
    echo "Invalid student username: $1" >&2
    echo 'Use up to 63 lowercase letters, numbers, and underscores; start with a letter or underscore.' >&2
    exit 1
  fi
}

admin_psql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

check_student_ownership() {
  local role_state database_owner
  role_state=$(admin_psql -tAc "SELECT CASE WHEN rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication THEN 'student' ELSE 'privileged' END FROM pg_roles WHERE rolname='$1'")
  if [[ -n "$role_state" && "$role_state" != student ]]; then
    echo "Role $1 is not an ordinary student login." >&2
    exit 1
  fi
  database_owner=$(admin_psql -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='$1'")
  if [[ -n "$database_owner" && "$database_owner" != "$1" ]]; then
    echo "Database $1 belongs to another role." >&2
    exit 1
  fi
}
