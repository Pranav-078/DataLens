FROM node:20-bookworm-slim

WORKDIR /app

# Prisma 5 needs OpenSSL available both when generating its client and when
# running the migration engine. Install it before `prisma generate` so
# Prisma selects the correct Debian/OpenSSL binary target instead of guessing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /data/storage

EXPOSE 8000

# Migrations run before the server starts. If migrations fail, the
# container exits non-zero rather than serving with a stale schema.
CMD sh -c "npx prisma migrate deploy && npx tsx src/server.ts"
