#!/usr/bin/env bash
#
# Kopia zapasowa bazy SQLite.
#
# Używa polecenia `.backup`, a nie zwykłego kopiowania pliku — przy włączonym
# WAL kopia plikowa w trakcie zapisu potrafi być niespójna.
#
# Przykład wpisu w cronie (codziennie o 3:30):
#   30 3 * * * /opt/portfolio-manager/scripts/backup.sh >> /var/log/pm-backup.log 2>&1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DATABASE_PATH:-$ROOT/data/portfolio.sqlite}"
DEST="${BACKUP_DIR:-$ROOT/backups}"
KEEP="${BACKUP_KEEP:-30}"

if [ ! -f "$DB" ]; then
  echo "Nie znaleziono bazy: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$DEST/portfolio-$STAMP.sqlite"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$TARGET'"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^portfolio-manager$'; then
  # Gdy sqlite3 nie ma na hoście, korzystamy z tego w kontenerze.
  docker exec portfolio-manager node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_PATH);
    db.backup('/app/data/backup-tmp.sqlite').then(() => process.exit(0));
  "
  cp "$(dirname "$DB")/backup-tmp.sqlite" "$TARGET"
  rm -f "$(dirname "$DB")/backup-tmp.sqlite"
else
  echo "Brak sqlite3 i działającego kontenera — nie mogę zrobić spójnej kopii." >&2
  exit 1
fi

gzip -f "$TARGET"
echo "Kopia zapisana: $TARGET.gz"

# Rotacja: zostawiamy N najnowszych kopii.
find "$DEST" -name 'portfolio-*.sqlite.gz' -type f -printf '%T@ %p\n' \
  | sort -rn | tail -n "+$((KEEP + 1))" | cut -d' ' -f2- \
  | while read -r old; do rm -f "$old" && echo "Usunięto starą kopię: $old"; done
