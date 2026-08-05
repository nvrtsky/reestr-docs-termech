import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/database.js';
import { registryDocumentTypes, registryNumberSequences } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';

const FORMAT_TOKEN = /\{(YYYY|YY|MM|DD|TYPE|COMPANY|SEQ(?::([1-9]|1[0-2]))?)\}/g;
const SEQUENCE_TOKEN = /\{SEQ(?::(?:[1-9]|1[0-2]))?\}/;
const NUMBER_UNIQUE_CONSTRAINT = 'registry_documents_portal_number_scope_uidx';

export interface DocumentNumberingConfiguration {
  typeId: string;
  typeCode: string;
  numberFormat: string | null;
  numberAutoGenerate: boolean;
  numberUniquenessEnabled: boolean;
}

interface ResolveNumberInput {
  portalUrl: string;
  number: string | null | undefined;
  documentDate: string;
  counterpartyId: number | null | undefined;
}

export class DocumentNumberingService {
  async resolve(
    database: Database,
    configuration: DocumentNumberingConfiguration,
    input: ResolveNumberInput,
  ) {
    await lockDocumentNumberingScope(database, input.portalUrl, configuration.typeId);
    const [persisted] = await database
      .select({
        numberFormat: registryDocumentTypes.numberFormat,
        numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
        numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
      })
      .from(registryDocumentTypes)
      .where(and(
        eq(registryDocumentTypes.portalUrl, input.portalUrl),
        eq(registryDocumentTypes.id, configuration.typeId),
      ))
      .limit(1);
    if (!persisted) {
      throw new ApiError(400, 'document_type_not_found', 'Тип документа не найден.');
    }
    configuration = { ...configuration, ...persisted };
    const format = normalizeFormat(configuration.numberFormat);
    let number = normalizeNumber(input.number);
    if (!number && configuration.numberAutoGenerate) {
      if (!format) {
        throw new ApiError(
          409,
          'number_format_not_configured',
          'Для автоматической нумерации не настроен формат номера.',
        );
      }
      const sequence = await this.nextSequence(
        database,
        input.portalUrl,
        configuration.typeId,
        companyScope(input.counterpartyId),
      );
      number = renderNumber(format, {
        typeCode: configuration.typeCode,
        documentDate: input.documentDate,
        counterpartyId: input.counterpartyId,
        sequence,
      });
    }
    if (number && format && !matchesNumberFormat(number, format, {
      typeCode: configuration.typeCode,
      documentDate: input.documentDate,
      counterpartyId: input.counterpartyId,
    })) {
      throw new ApiError(
        400,
        'document_number_format_invalid',
        `Номер не соответствует формату «${format}».`,
        { format },
      );
    }
    return {
      number,
      numberUniquenessKey: configuration.numberUniquenessEnabled && number
        ? documentNumberUniquenessKey(number, input.counterpartyId)
        : null,
    };
  }

  private async nextSequence(
    database: Database,
    portalUrl: string,
    typeId: string,
    scope: number,
  ) {
    const [sequence] = await database
      .insert(registryNumberSequences)
      .values({ portalUrl, typeId, companyScope: scope, lastValue: 1 })
      .onConflictDoUpdate({
        target: [
          registryNumberSequences.portalUrl,
          registryNumberSequences.typeId,
          registryNumberSequences.companyScope,
        ],
        set: {
          lastValue: sql`${registryNumberSequences.lastValue} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ value: registryNumberSequences.lastValue });
    if (!sequence || sequence.value <= 0) {
      throw new ApiError(500, 'document_number_generation_failed', 'Не удалось сгенерировать номер документа.');
    }
    return sequence.value;
  }
}

export function validateNumberingConfiguration(
  value: Pick<DocumentNumberingConfiguration, 'numberFormat' | 'numberAutoGenerate'>,
) {
  const format = normalizeFormat(value.numberFormat);
  if (value.numberAutoGenerate && !format) {
    return 'Для автоматической нумерации укажите формат.';
  }
  if (!format) return null;
  const tokens = [...format.matchAll(FORMAT_TOKEN)];
  const remainder = format.replace(FORMAT_TOKEN, '');
  if (/[{}]/.test(remainder)) {
    return 'Формат содержит неизвестный плейсхолдер.';
  }
  if (tokens.filter((token) => token[1].startsWith('SEQ')).length > 1) {
    return 'Плейсхолдер последовательности можно использовать только один раз.';
  }
  if (value.numberAutoGenerate && !SEQUENCE_TOKEN.test(format)) {
    return 'Автоматический формат должен содержать {SEQ} или {SEQ:N}.';
  }
  return null;
}

export function isDocumentNumberConflict(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    const record = current as Record<string, unknown>;
    if (
      record.code === '23505'
      && (
        record.constraint_name === NUMBER_UNIQUE_CONSTRAINT
        || record.constraint === NUMBER_UNIQUE_CONSTRAINT
      )
    ) return true;
    current = record.cause;
  }
  return false;
}

export function documentNumberUniquenessKey(
  number: string,
  counterpartyId: number | null | undefined,
) {
  return `${companyScope(counterpartyId)}\u001f${normalizeUniqueNumber(number)}`;
}

export async function lockDocumentNumberingScope(
  database: Database,
  portalUrl: string,
  typeId: string,
) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${portalUrl}\u001f${typeId}`}, 0))`,
  );
}

function renderNumber(
  format: string,
  input: {
    typeCode: string;
    documentDate: string;
    counterpartyId: number | null | undefined;
    sequence: number;
  },
) {
  const date = dateParts(input.documentDate);
  return format.replace(FORMAT_TOKEN, (token, name: string, width?: string) => {
    if (name === 'YYYY') return date.year;
    if (name === 'YY') return date.year.slice(-2);
    if (name === 'MM') return date.month;
    if (name === 'DD') return date.day;
    if (name === 'TYPE') return input.typeCode;
    if (name === 'COMPANY') return String(companyScope(input.counterpartyId));
    if (name.startsWith('SEQ')) return String(input.sequence).padStart(Number(width || 1), '0');
    return token;
  });
}

function matchesNumberFormat(
  number: string,
  format: string,
  input: {
    typeCode: string;
    documentDate: string;
    counterpartyId: number | null | undefined;
  },
) {
  const date = dateParts(input.documentDate);
  let cursor = 0;
  let pattern = '^';
  for (const token of format.matchAll(FORMAT_TOKEN)) {
    pattern += escapeRegExp(format.slice(cursor, token.index));
    const name = token[1];
    const width = Number(token[2] || 1);
    if (name === 'YYYY') pattern += escapeRegExp(date.year);
    else if (name === 'YY') pattern += escapeRegExp(date.year.slice(-2));
    else if (name === 'MM') pattern += escapeRegExp(date.month);
    else if (name === 'DD') pattern += escapeRegExp(date.day);
    else if (name === 'TYPE') pattern += escapeRegExp(input.typeCode);
    else if (name === 'COMPANY') pattern += escapeRegExp(String(companyScope(input.counterpartyId)));
    else if (name.startsWith('SEQ')) pattern += `\\d{${width},}`;
    cursor = (token.index || 0) + token[0].length;
  }
  pattern += `${escapeRegExp(format.slice(cursor))}$`;
  return new RegExp(pattern, 'u').test(number);
}

function dateParts(value: string) {
  const [year, month, day] = value.split('-');
  return { year, month, day };
}

function normalizeFormat(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeNumber(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeUniqueNumber(value: string) {
  return value.normalize('NFKC').trim().toLocaleUpperCase('ru');
}

function companyScope(value: number | null | undefined) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
