# Приём выпущенных КП и счетов

Реестр принимает выпущенные PDF через `POST /api/v1/document-releases`. Endpoint
предназначен только для серверной доставки из конструктора: пользовательские
OAuth-токены Bitrix24 в запросе и постоянной ссылке не используются.

## Доступ

Для каждого разрешённого портала задаётся отдельный секрет длиной не менее 32
символов:

```text
DOCUMENT_RELEASE_TOKENS_JSON={"https://thermech.bitrix24.ru":"<random secret>"}
```

Запрос передаёт заголовки:

```http
Authorization: Bearer <random secret>
X-Registry-Portal: https://thermech.bitrix24.ru
Content-Type: application/json
```

Значения `X-Registry-Portal` и `portalUrl` в теле должны совпадать с точным HTTPS
origin, для которого выпущен секрет. После проверки реестр получает OAuth-токен
из таблицы установок Marketplace и использует его только для записи PDF в
Bitrix24 Disk.

## Контракт выпуска

```json
{
  "portalUrl": "https://thermech.bitrix24.ru",
  "source": "kp_constructor",
  "externalDocumentId": "93fe60d8-31c3-4a4a-8468-40209d874f1c",
  "versionId": "version-7",
  "releasedAt": "2026-09-22T12:00:00.000Z",
  "document": {
    "number": "КП-42",
    "title": "Коммерческое предложение КП-42",
    "documentDate": "2026-09-22",
    "amount": "125000.00",
    "currency": "RUB",
    "legalEntityId": 10,
    "legalEntityName": "ООО Термомеханикс",
    "counterpartyId": 25,
    "counterpartyName": "ООО Ромашка",
    "responsibleId": 7,
    "responsibleName": "Иван Петров"
  },
  "crm": {
    "company": { "id": 25, "title": "ООО Ромашка" },
    "deals": [{ "id": 1001, "title": "Поставка оборудования", "closed": false }]
  },
  "internalUrl": "https://kp.example.ru/documents/93fe60d8-31c3-4a4a-8468-40209d874f1c",
  "pdf": {
    "name": "КП-42.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123456,
    "sha256": "<64 lowercase hex characters>",
    "contentBase64": "<base64 PDF>"
  }
}
```

Для собственного КП используется `source: "kp_constructor"`, а
`externalDocumentId` обязан быть UUID. Он хранится в строковом поле реестра.

Для smart-счёта используются `source: "bitrix_smart_invoice"`,
`externalEntityTypeId: 31`, числовой `externalEntityId` и его строковое
представление в `externalDocumentId`. Благодаря этому автоматическая доставка
обновляет карточку, уже созданную ручной синхронизацией Bitrix24.

PDF проверяется по размеру, сигнатуре `%PDF-` и SHA-256. Максимальный размер
задаёт `DOCUMENT_RELEASE_MAX_PDF_BYTES`; значение по умолчанию — 20 MiB.

## Повторы и порядок версий

Комбинация портала, источника, ID документа и `versionId` является ключом
идемпотентности. Повтор того же содержимого возвращает существующий результат;
другое содержимое с тем же ключом отклоняется с `409`.

`releasedAt` определяет порядок выпусков. Запоздавший старый выпуск сохраняется
как историческая версия PDF и получает `current: false`; он не меняет реквизиты,
ссылку и текущий файл карточки. Новый выпуск обновляет исходные реквизиты и CRM-
связи, сохраняя ручного ответственного, комментарий и архивное состояние.

Ответ `201` имеет `status: "stored"` или `"stored_stale"`. Идемпотентный повтор
возвращает `200` и `status: "replayed"`.
