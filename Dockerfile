# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# Etap 1: instalacja zależności
# Osobna warstwa dla manifestów — zmiana kodu nie unieważnia cache npm.
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# better-sqlite3 kompiluje moduł natywny, jeśli nie ma gotowego pakietu
# dla tej wersji Node — build-essential i python3 są potrzebne tylko tutaj.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────
# Etap 2: build
# ─────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

RUN npm run build --workspace @portfolio/backend \
 && npm run build --workspace @portfolio/frontend

# Manifest dla obrazu produkcyjnego: zależności runtime backendu bez pakietów
# deweloperskich i bez workspace'u `shared`, który jest już wbudowany w bundle.
# "type": "module" jest konieczne — bundle to ESM, a bez tego pola Node
# próbuje go najpierw sparsować jako CommonJS.
RUN node -e "\
  const pkg = require('./backend/package.json'); \
  delete pkg.dependencies['@portfolio/shared']; \
  require('fs').writeFileSync('/app/runtime-package.json', JSON.stringify({ \
    name: 'portfolio-manager-runtime', \
    private: true, \
    type: 'module', \
    dependencies: pkg.dependencies \
  }, null, 2)); \
"

# ─────────────────────────────────────────────────────────────
# Etap 3: zależności produkcyjne
# Instalowane osobno, żeby do obrazu nie trafiły paczki deweloperskie.
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app

COPY --from=build /app/runtime-package.json ./package.json

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# ─────────────────────────────────────────────────────────────
# Etap 4: obraz produkcyjny
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/portfolio.sqlite

# W obrazie zostaje wyłącznie to, co potrzebne w czasie działania:
# zbundlowany backend, jego zależności, migracje i statyczny frontend.
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/drizzle ./drizzle
COPY --from=build /app/frontend/dist ./public

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app

# Kontener startuje jako root wyłącznie po to, żeby entrypoint mógł naprawić
# właściciela zamontowanego katalogu danych — bind mount z hosta przykrywa
# uprawnienia ustawione podczas budowania. Sama aplikacja działa jako `node`;
# zrzucenie uprawnień robi entrypoint przez setpriv.
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
