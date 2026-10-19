FROM reestr-docs-marketplace-frontend:preview-height-20261019
RUN echo "0d3e2c56d46ae8c6137a23fcce46f58e6a37ade195bb7513458d34662111ce27  /usr/share/nginx/html/legacy/index.html" | sha256sum -c -
COPY --chmod=644 index.html /usr/share/nginx/html/legacy/index.html
