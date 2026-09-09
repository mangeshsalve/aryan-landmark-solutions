# syntax=docker/dockerfile:1

# ---- deps: install all dependencies once ----
FROM node:22-slim AS deps

WORKDIR /app

# Prisma needs OpenSSL available when generating/detecting
# the correct query engine binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci


# ---- build: compile the NestJS application ----
FROM deps AS build

WORKDIR /app

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build


# ---- runtime: production dependencies only ----
FROM node:22-slim AS runtime

WORKDIR /app

# Prisma query engine requires OpenSSL at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN npm prune --omit=dev

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]