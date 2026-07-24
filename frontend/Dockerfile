FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY scripts scripts
COPY src/app src/app
COPY frontend frontend

ARG VITE_APP_BASE_URL=/registry/
ARG VITE_BITRIX_APP_CODE=
ENV VITE_APP_BASE_URL=${VITE_APP_BASE_URL}
ENV VITE_BITRIX_APP_CODE=${VITE_BITRIX_APP_CODE}

RUN npm run app:build \
    && npm run build -w frontend

FROM nginx:1.27-alpine AS runtime

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
