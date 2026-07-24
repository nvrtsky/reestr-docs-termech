FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend backend
RUN npm run build -w backend

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend --include-workspace-root \
    && npm cache clean --force

COPY --from=build /app/backend/dist backend/dist
COPY backend/drizzle backend/drizzle

WORKDIR /app/backend

USER node

EXPOSE 3001

CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
