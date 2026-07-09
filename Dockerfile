# AI Discord Moderator — container image.
# Single stage keeps the Prisma CLI available so the entrypoint can apply the
# SQLite schema at startup. onnxruntime-node needs glibc, so we use a Debian
# (bookworm) base rather than Alpine.
FROM node:22-bookworm-slim

WORKDIR /app

# ca-certificates: HTTPS model/binary downloads. libgomp1: onnxruntime runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching). package-lock.json is
# committed, so `npm ci` gives a reproducible install.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources and generate the Prisma client.
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

# Ship the example env so `docker compose run` can bootstrap if needed.
COPY .env.example ./.env.example
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

ENV NODE_ENV=production \
    DATABASE_URL="file:/app/data/moderation.db" \
    TRANSFORMERS_CACHE="/app/models"

# Persist the SQLite DB and the downloaded model weights across restarts.
VOLUME ["/app/data", "/app/models"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
