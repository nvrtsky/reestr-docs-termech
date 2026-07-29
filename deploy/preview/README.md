# Client review deployment

This deployment publishes the client review branch separately from `main`.

- public URL: `https://termech.navrotsky.ru/prototip/`
- local service: `127.0.0.1:3110`
- process name: `termech-prototip`
- shared comment storage: `/var/lib/termech-prototip/comments.json`
- Nginx snippet: `/etc/nginx/snippets/termech-prototip.conf`

The Nginx location strips `/prototip/` before forwarding requests, so the
review server continues to serve `/index.html`, `/health`, and `/api/comments`
internally.
