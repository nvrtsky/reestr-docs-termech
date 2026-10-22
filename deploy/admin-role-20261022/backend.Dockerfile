FROM reestr-admin-base-backend:20261022
COPY patched-runtime/administration/administration.router.js /app/backend/dist/administration/administration.router.js
COPY patched-runtime/administration/configuration-mutation.js /app/backend/dist/administration/configuration-mutation.js
COPY patched-runtime/users/bitrix-users.service.js /app/backend/dist/users/bitrix-users.service.js
