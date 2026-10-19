FROM reestr-docs-marketplace-frontend:feedback-20261019
RUN echo 'e24953d5e6d7615e65b0ea6fb23b770c1418b4c351150f66234a9dad1a291e62  /usr/share/nginx/html/legacy/index.html' | sha256sum -c -
COPY --chmod=644 frontend/ /usr/share/nginx/html/legacy/
