#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

admin_psql -c "SELECT r.rolname AS student, d.datname AS database
FROM pg_roles r JOIN pg_database d ON d.datdba = r.oid AND d.datname = r.rolname
WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
ORDER BY r.rolname"
