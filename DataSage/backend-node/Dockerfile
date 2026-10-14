FROM node:20-slim

WORKDIR /app

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
