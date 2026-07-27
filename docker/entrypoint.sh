#!/bin/sh
set -e

# Katalog danych jest bind mountem z hosta. Docker tworzy go jako root, jeśli
# nie istniał, więc proces działający jako `node` nie mógłby otworzyć bazy
# (SQLITE_CANTOPEN). Właściciela poprawiamy tutaj, będąc jeszcze rootem,
# i dopiero potem zrzucamy uprawnienia.
mkdir -p /app/data

if [ -z "$APP_PASSWORD" ] || [ "$APP_PASSWORD" = "zmien-to-haslo" ]; then
  echo "BŁĄD: ustaw APP_PASSWORD w pliku .env przed uruchomieniem." >&2
  exit 1
fi

if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "zmien-to-na-losowy-ciag-min-32-znaki" ]; then
  echo "BŁĄD: ustaw SESSION_SECRET w pliku .env (openssl rand -hex 32)." >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null || true

  # setpriv jest częścią util-linux i jest obecny w obrazie bazowym Debiana.
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi

  echo "OSTRZEŻENIE: brak setpriv — aplikacja wystartuje jako root." >&2
fi

exec "$@"
