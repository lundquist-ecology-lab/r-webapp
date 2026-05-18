#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="$(cd "$(dirname "$0")" && pwd)/backups"
VOLUME="r-webapp_user-data"
KEEP=10   # number of backups to retain

usage() {
  echo "Usage: $0 [backup|restore <file>]"
  echo ""
  echo "  backup          Create a timestamped backup (default)"
  echo "  restore <file>  Restore from a .tar.gz in the backups/ directory"
  exit 1
}

do_backup() {
  mkdir -p "$BACKUP_DIR"
  local name="users-$(date +%Y%m%d-%H%M%S).tar.gz"
  echo "Backing up volume '$VOLUME' → backups/$name"
  docker run --rm \
    -v "${VOLUME}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine tar czf "/backup/${name}" -C /data .
  echo "Done: backups/$name"

  # Remove oldest backups beyond KEEP
  local count
  count=$(ls -1 "$BACKUP_DIR"/users-*.tar.gz 2>/dev/null | wc -l)
  if [ "$count" -gt "$KEEP" ]; then
    ls -1t "$BACKUP_DIR"/users-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs rm -f
    echo "Pruned old backups (keeping last $KEEP)"
  fi
}

do_restore() {
  local file="${1:-}"
  [ -z "$file" ] && usage
  local path="$BACKUP_DIR/$file"
  [ -f "$path" ] || { echo "File not found: $path"; exit 1; }
  echo "WARNING: This will overwrite all data in '$VOLUME'."
  read -r -p "Type 'yes' to continue: " confirm
  [ "$confirm" = "yes" ] || { echo "Aborted."; exit 0; }
  echo "Restoring from $file ..."
  docker run --rm \
    -v "${VOLUME}:/data" \
    -v "${BACKUP_DIR}:/backup" \
    alpine sh -c "cd /data && tar xzf /backup/${file}"
  echo "Done. Restart the container: docker compose restart webapp"
}

case "${1:-backup}" in
  backup)  do_backup ;;
  restore) do_restore "${2:-}" ;;
  *)       usage ;;
esac
