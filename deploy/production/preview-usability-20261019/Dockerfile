FROM reestr-docs-marketplace-frontend:attachment-preview-20261019
RUN echo "c9d25c15bbb8fc63ab05cb79972e497b719fee158d1bfc5924c9f3e8420c1ce9  /usr/share/nginx/html/legacy/index.html" | sha256sum -c -
COPY frontend/ /usr/share/nginx/html/legacy/
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN find /usr/share/nginx/html/legacy/vendor -type d -exec chmod 755 {} + && find /usr/share/nginx/html/legacy/vendor -type f -exec chmod 644 {} +
