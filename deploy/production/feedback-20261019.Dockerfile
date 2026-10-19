# Pass the exact currently running frontend image, preferably by digest.
ARG REGISTRY_FRONTEND_BASE
FROM ${REGISTRY_FRONTEND_BASE}
RUN echo '14cd2f0c42a9362d562c843054015c1a96646bab2dfb7ece7dda8fb91e7429e4  /usr/share/nginx/html/legacy/index.html' | sha256sum -c -
# Preserve the installed shell, help pages, nginx configuration and runtime.
COPY frontend/public/legacy/index.html /usr/share/nginx/html/legacy/index.html
