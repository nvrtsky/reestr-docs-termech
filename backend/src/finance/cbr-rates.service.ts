import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db/database.js';
import { registryExchangeRates } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';

export interface ExchangeRateQuote {
  currency: string;
  nominal: number;
  rubValue: number;
  rubPerUnit: number;
  rateDate: string;
}

export interface ExchangeRateProvider {
  getRates(
    portalUrl: string,
    requestedDate: string,
    currencies: string[],
  ): Promise<Map<string, ExchangeRateQuote>>;
}

interface ParsedCbrResponse {
  rateDate: string;
  rates: Map<string, Omit<ExchangeRateQuote, 'rateDate'>>;
}

const CBR_XML_ENDPOINT = 'https://www.cbr.ru/scripts/XML_daily.asp';
const MAX_RESPONSE_SIZE = 2_000_000;
const CURRENT_DAY_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PORTAL_TIME_ZONE = 'Europe/Minsk';

export class CbrRatesService implements ExchangeRateProvider {
  constructor(
    private readonly database: Database,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getRates(portalUrl: string, requestedDate: string, currencies: string[]) {
    const requestedCurrencies = [...new Set(currencies.map((item) => item.trim().toUpperCase()))];
    if (!requestedCurrencies.length) return new Map<string, ExchangeRateQuote>();
    if (requestedCurrencies.some((currency) => !/^[A-Z]{3}$/.test(currency))) {
      throw new ApiError(400, 'currency_invalid', 'Currency code is invalid.');
    }
    const portalToday = localIsoDate(
      new Date(),
      process.env.PORTAL_TIME_ZONE || DEFAULT_PORTAL_TIME_ZONE,
    );
    if (requestedDate > portalToday) {
      throw new ApiError(
        422,
        'cbr_rate_future_date',
        'The Bank of Russia rate is unavailable for a future date.',
        { requestedDate },
      );
    }

    const cached = await this.database
      .select()
      .from(registryExchangeRates)
      .where(and(
        eq(registryExchangeRates.portalUrl, portalUrl),
        eq(registryExchangeRates.requestedDate, requestedDate),
        inArray(registryExchangeRates.currency, requestedCurrencies),
      ));
    const freshThreshold = Date.now() - CURRENT_DAY_CACHE_TTL_MS;
    const usableCached = cached.filter((row) =>
      requestedDate !== portalToday
      || row.rateDate === requestedDate
      || row.fetchedAt.getTime() >= freshThreshold,
    );
    const quotes = new Map(usableCached.map((row) => [row.currency, this.toQuote(row)]));
    const missing = requestedCurrencies.filter((currency) => !quotes.has(currency));
    if (!missing.length) return quotes;

    const parsed = await this.fetchRates(requestedDate);
    if (parsed.rateDate > requestedDate) {
      throw new ApiError(
        502,
        'cbr_rate_date_invalid',
        'The Bank of Russia returned a rate from a later date.',
        { requestedDate, rateDate: parsed.rateDate },
      );
    }
    const fetched = missing.map((currency) => {
      if (currency === 'RUB') {
        return { currency, nominal: 1, rubValue: 1, rubPerUnit: 1, rateDate: parsed.rateDate };
      }
      const quote = parsed.rates.get(currency);
      if (!quote) {
        throw new ApiError(
          422,
          'cbr_currency_unsupported',
          'The Bank of Russia did not return the requested currency.',
          { currency, requestedDate },
        );
      }
      return { ...quote, rateDate: parsed.rateDate };
    });
    await this.database
      .insert(registryExchangeRates)
      .values(fetched.map((quote) => ({
        portalUrl,
        requestedDate,
        rateDate: quote.rateDate,
        currency: quote.currency,
        nominal: quote.nominal,
        rubValue: quote.rubValue.toFixed(8),
      })))
      .onConflictDoUpdate({
        target: [
          registryExchangeRates.portalUrl,
          registryExchangeRates.requestedDate,
          registryExchangeRates.currency,
        ],
        set: {
          rateDate: parsed.rateDate,
          nominal: sql`excluded.nominal`,
          rubValue: sql`excluded.rub_value`,
          fetchedAt: new Date(),
        },
      });
    for (const quote of fetched) quotes.set(quote.currency, quote);
    return quotes;
  }

  private async fetchRates(requestedDate: string) {
    const [year, month, day] = requestedDate.split('-');
    const url = new URL(CBR_XML_ENDPOINT);
    url.searchParams.set('date_req', `${day}/${month}/${year}`);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/xml,text/xml' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_RESPONSE_SIZE) throw new Error('Response is too large.');
      const xml = await response.text();
      if (xml.length > MAX_RESPONSE_SIZE) throw new Error('Response is too large.');
      return parseCbrDailyXml(xml);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'cbr_rates_unavailable',
        'The Bank of Russia exchange rates are temporarily unavailable.',
        { cause: error instanceof Error ? error.message : 'unknown', requestedDate },
      );
    }
  }

  private toQuote(row: typeof registryExchangeRates.$inferSelect): ExchangeRateQuote {
    const rubValue = Number(row.rubValue);
    return {
      currency: row.currency,
      nominal: row.nominal,
      rubValue,
      rubPerUnit: rubValue / row.nominal,
      rateDate: row.rateDate,
    };
  }
}

export function localIsoDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function parseCbrDailyXml(xml: string): ParsedCbrResponse {
  const dateMatch = /<ValCurs\b[^>]*\bDate="(\d{2})\.(\d{2})\.(\d{4})"/i.exec(xml);
  if (!dateMatch) {
    throw new ApiError(502, 'cbr_response_invalid', 'The Bank of Russia response has no rate date.');
  }
  const rateDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  const rates = new Map<string, Omit<ExchangeRateQuote, 'rateDate'>>();
  for (const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/gi)) {
    const block = match[1];
    const currency = tagValue(block, 'CharCode')?.toUpperCase();
    const nominal = parseCbrNumber(tagValue(block, 'Nominal'));
    const rubValue = parseCbrNumber(tagValue(block, 'Value'));
    if (!currency || !/^[A-Z]{3}$/.test(currency) || !nominal || !rubValue) continue;
    rates.set(currency, {
      currency,
      nominal,
      rubValue,
      rubPerUnit: rubValue / nominal,
    });
  }
  if (!rates.size) {
    throw new ApiError(502, 'cbr_response_invalid', 'The Bank of Russia response has no rates.');
  }
  return { rateDate, rates };
}

function tagValue(block: string, tag: string) {
  return new RegExp(`<${tag}>([^<]+)<\\/${tag}>`, 'i').exec(block)?.[1]?.trim();
}

function parseCbrNumber(value: string | undefined) {
  if (!value) return null;
  const number = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}
