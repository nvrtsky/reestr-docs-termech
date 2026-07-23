UPDATE "registry_field_definitions"
SET "label" = 'Базис поставки',
    "updated_at" = now()
WHERE "key" = 'incoterms'
  AND "label" = 'Базис поставки (Incoterms)';
