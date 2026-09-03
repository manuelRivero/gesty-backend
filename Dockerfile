# syntax=docker/dockerfile:1

###############################################################################
# Etapa 1: build + ofuscación
#   - Instala todas las deps (incl. dev)
#   - Genera el cliente Prisma
#   - Compila TS (sin sourcemaps/declaraciones) y ofusca dist/
###############################################################################
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# OpenSSL es requerido por Prisma.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Requerido por prisma.config.ts en el postinstall (`prisma generate`).
COPY src/config/loadEnv.ts ./src/config/loadEnv.ts
# `postinstall` ejecuta `prisma generate`.
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/obfuscate.mjs ./scripts/obfuscate.mjs

RUN npm run build:obf

###############################################################################
# Etapa 2: dependencias de producción + cliente Prisma
###############################################################################
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Sin scripts para no requerir el CLI de Prisma (dev dep) en este punto.
RUN npm ci --omit=dev --ignore-scripts

# Cliente Prisma ya generado en la etapa builder.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

###############################################################################
# Etapa 3: runtime (imagen final, mínima)
###############################################################################
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=5001

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Archivos estáticos servidos en runtime (REPO_ROOT = dist/.. = /app).
COPY index.html PENDING-FEATURES.md ./

# Usuario sin privilegios.
RUN chown -R node:node /app
USER node

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
