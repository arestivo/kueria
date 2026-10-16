#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ $# != 1 ]]; then
  echo "Usage: $0 <student_name>" >&2
  exit 1
fi
validate_student "$1"
check_student_ownership "$1"

# A failed database drop stops before DROP ROLE; FORCE disconnects active users.
admin_psql --set=student="$1" <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'student')
\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'student')
\gexec
SQL
