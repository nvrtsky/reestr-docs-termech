import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { localIsoDate, parseCbrDailyXml } from './cbr-rates.service.js';

describe('Bank of Russia daily XML parser', () => {
  it('normalizes the effective date, decimal comma and nominal', () => {
    const parsed = parseCbrDailyXml(`<?xml version="1.0" encoding="windows-1251"?>
      <ValCurs Date="03.04.2026" name="Foreign Currency Market">
        <Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>US Dollar</Name><Value>90,5000</Value></Valute>
        <Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Name>Yuan</Name><Value>125,0000</Value></Valute>
      </ValCurs>`);
    assert.equal(parsed.rateDate, '2026-04-03');
    assert.equal(parsed.rates.get('USD')?.rubPerUnit, 90.5);
    assert.equal(parsed.rates.get('CNY')?.rubPerUnit, 12.5);
  });

  it('rejects a response without a trustworthy date or rates', () => {
    assert.throws(() => parseCbrDailyXml('<ValCurs></ValCurs>'), /rate date/i);
    assert.throws(
      () => parseCbrDailyXml('<ValCurs Date="03.04.2026"></ValCurs>'),
      /no rates/i,
    );
  });

  it('compares the current date in the portal time zone instead of UTC', () => {
    assert.equal(
      localIsoDate(new Date('2026-08-06T21:30:00.000Z'), 'Europe/Minsk'),
      '2026-08-07',
    );
  });
});
