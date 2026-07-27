#!/bin/sh
set -e

# Katalog danych jest wolumenem — przy pierwszym uruchomieniu bywa pusty.
mkdir -p /app/data

if [ -z "$APP_PASSWORD" ] || [ "$APP_PASSWORD" = "zmien-to-haslo" ]; then
  echo "BŁĄD: ustaw APP_PASSWORD w pliku .env przed uruchomieniem." >&2
  exit 1
fi

if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "zmien-to-na-losowy-ciag-min-32-znaki" ]; then
  echo "BŁĄD: ustaw SESSION_SECRET w pliku .env (openssl rand -hex 32)." >&2
  exit 1
fi

exec "$@"
