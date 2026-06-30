# Drona ValueChain — JMC Ops Tracker
# Production image for Coolify (or any Docker host).
# Single stage: build + run on the same Debian base so the Prisma engine that
# `prisma generate` produces (postinstall) matches the runtime libc/openssl.

FROM node:22-slim

# Prisma's query engine needs OpenSSL at runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). prisma/ is needed because the
# package.json "postinstall" runs `prisma generate`. Dev deps are kept so the
# Prisma CLI is available to run `migrate deploy` at container start.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Uploads (proof photos, worker docs, generated PDFs) live here. Mount a Coolify
# persistent volume at this path so files survive redeploys.
ENV UPLOAD_DIR=/app/uploads
RUN mkdir -p /app/uploads

EXPOSE 3000

# Apply any pending DB migrations, then start. If the DB is unreachable the
# container fails fast (Coolify surfaces the error) rather than serving a broken app.
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
