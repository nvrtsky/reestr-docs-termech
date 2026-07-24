import ExcelJS from '@excel.js/exceljs';
import { eq } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { registryLifecycles } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { loadRegistryPolicy } from '../permissions/policy.service.js';
import { listBitrixUsers } from '../users/bitrix-users.service.js';
import type { DocumentExportQuery } from './documents.schemas.js';
import type { DocumentsService } from './documents.service.js';

const EXPORT_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10_000;

interface ExportDependencies {
  database: Database;
  documents: DocumentsService;
  bitrix: BitrixApiClient;
}

interface ExportColumn {
  header: string;
  key: string;
  width: number;
}

export class DocumentsExportService {
  constructor(private readonly dependencies: ExportDependencies) {}

  async create(context: RegistryContext, query: DocumentExportQuery) {
    const policy = await loadRegistryPolicy(this.dependencies.database, context);
    if (!policy.permissions.export) {
      throw new ApiError(403, 'export_access_denied', 'Document export is not allowed.');
    }

    const firstPage = await this.dependencies.documents.list(context, {
      ...query,
      limit: EXPORT_PAGE_SIZE,
      offset: 0,
    });
    if (firstPage.meta.total > MAX_EXPORT_ROWS) {
      throw new ApiError(
        413,
        'export_row_limit_exceeded',
        `Export is limited to ${MAX_EXPORT_ROWS} documents. Narrow the filters and retry.`,
        { total: firstPage.meta.total, limit: MAX_EXPORT_ROWS },
      );
    }

    const items = [...firstPage.items];
    for (let offset = EXPORT_PAGE_SIZE; offset < firstPage.meta.total; offset += EXPORT_PAGE_SIZE) {
      const page = await this.dependencies.documents.list(context, {
        ...query,
        limit: EXPORT_PAGE_SIZE,
        offset,
      });
      items.push(...page.items);
    }

    const statusLabels = await this.loadStatusLabels(context.portalUrl);
    const responsibleNames = await this.loadResponsibleNames(context);
    const columns = this.exportColumns(
      policy.hideMoney,
      policy.hiddenFields,
      query.columns,
    );
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Реестр документов Bitrix24';
    workbook.created = new Date();
    workbook.modified = new Date();

    const worksheet = workbook.addWorksheet('Документы', {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    worksheet.columns = columns;

    for (const item of items) {
      const row: Record<string, unknown> = {
        number: item.number || '',
        title: item.title,
        type: item.type.name,
      };
      if (query.columns === undefined || query.columns.includes('section')) {
        row.section = item.section.name;
      }
      if (query.columns === undefined || query.columns.includes('counterparty')) {
        row.counterparty = item.counterpartyName || '';
      }
      if (query.columns === undefined || query.columns.includes('status')) {
        row.status = statusLabels.get(item.status) || item.status;
      }
      if ((query.columns === undefined || query.columns.includes('amount')) && !item.moneyHidden) {
        row.amount = item.amount == null ? null : Number(item.amount);
        row.currency = item.currency || '';
      }
      if (query.columns === undefined || query.columns.includes('docDate')) {
        row.documentDate = this.excelDate(item.documentDate);
      }
      if (query.columns === undefined || query.columns.includes('responsible')) {
        row.responsible = responsibleNames.get(item.responsibleId)
          || item.responsibleName
          || `Пользователь #${item.responsibleId}`;
      }
      worksheet.addRow(row);
    }

    const header = worksheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF30343B' } };
    header.alignment = { vertical: 'middle' };
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    if (columns.some((column) => column.key === 'documentDate')) {
      worksheet.getColumn('documentDate').numFmt = 'dd.mm.yyyy';
    }
    if (columns.some((column) => column.key === 'amount')) {
      worksheet.getColumn('amount').numFmt = '#,##0.00';
    }
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.alignment = { vertical: 'top', wrapText: true };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    return {
      buffer: Buffer.from(buffer),
      filename: `registry-documents-${date}.xlsx`,
      rowCount: items.length,
    };
  }

  private exportColumns(
    hideMoney: boolean,
    hiddenFields: string[],
    selectedColumns: string[] | undefined,
  ) {
    const selected = new Set(selectedColumns ?? [
      'section',
      'counterparty',
      'status',
      'amount',
      'docDate',
      'responsible',
    ]);
    const columns: ExportColumn[] = [
      { header: 'Номер', key: 'number', width: 18 },
      { header: 'Документ', key: 'title', width: 42 },
      { header: 'Тип', key: 'type', width: 25 },
    ];
    if (selected.has('section')) {
      columns.push({ header: 'Раздел', key: 'section', width: 20 });
    }
    if (selected.has('counterparty')) {
      columns.push({ header: 'Контрагент', key: 'counterparty', width: 30 });
    }
    if (selected.has('status')) {
      columns.push({ header: 'Статус', key: 'status', width: 20 });
    }
    if (selected.has('amount') && !hideMoney && !hiddenFields.includes('amount')) {
      columns.push({ header: 'Сумма', key: 'amount', width: 18 });
    }
    if (selected.has('amount') && !hideMoney && !hiddenFields.includes('currency')) {
      columns.push({ header: 'Валюта', key: 'currency', width: 12 });
    }
    if (selected.has('docDate')) {
      columns.push({ header: 'Дата документа', key: 'documentDate', width: 17 });
    }
    if (selected.has('responsible')) {
      columns.push({ header: 'Ответственный', key: 'responsible', width: 24 });
    }
    return columns;
  }

  private async loadStatusLabels(portalUrl: string) {
    const lifecycles = await this.dependencies.database
      .select({ config: registryLifecycles.config })
      .from(registryLifecycles)
      .where(eq(registryLifecycles.portalUrl, portalUrl));
    const labels = new Map<string, string>();
    for (const lifecycle of lifecycles) {
      for (const state of lifecycle.config.states) {
        if (!labels.has(state.code)) labels.set(state.code, state.label);
      }
    }
    return labels;
  }

  private async loadResponsibleNames(context: RegistryContext) {
    try {
      const users = await listBitrixUsers(context, this.dependencies.bitrix);
      return new Map(users.map((user) => [user.id, user.name]));
    } catch {
      return new Map<number, string>();
    }
  }

  private excelDate(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
}
