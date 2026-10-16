#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ $# != 1 ]]; then
  echo "Usage: $0 <student_name>" >&2
  exit 1
fi
validate_student "$1"
exec docker exec -it "$POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$1" -d "$1"
