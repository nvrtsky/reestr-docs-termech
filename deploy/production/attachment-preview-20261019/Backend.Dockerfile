FROM reestr-docs-marketplace-backend:inn-search-20261016
USER root
RUN echo 'f27fc386f42ecfe236d9f1fd2449f0c28edc75bb0e98654dbcd73d2719aaa5c5  /app/backend/dist/attachments/attachments.service.js' | sha256sum -c -
RUN apk add --no-cache libreoffice-writer libreoffice-calc libreoffice-impress font-dejavu
COPY --chmod=644 backend/ /app/backend/dist/attachments/
USER node
