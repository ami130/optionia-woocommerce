import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { InvoiceStatus } from '../common/database/enums';

/** One jurisdiction's collected tax, for one currency, over a period. */
export interface TaxReportRow {
  readonly taxCountry: string | null;
  readonly currency: string;
  readonly invoiceCount: number;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

export interface TaxReport {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly TaxReportRow[];
}

/**
 * *"What tax did we collect, by country, in a period"* (M22.E6, ADR-115).
 *
 * 🔴 **ADR-115 makes filing ours.** Stripe Tax calculates and collects, and
 * produces reports a return is filed *from* — it does not file. Filing needs
 * local rows, which is why `invoices` exists (F91), and a compliance table with
 * no way to ask this question is a table whose correctness nobody checks.
 *
 * ⚠️ **Only the e2e test asked it until now.** The query below is the one that
 * suite proved; this service is the surface it never had.
 */
@Injectable()
export class TaxReportService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 🔴 **Grouped by currency as well as country.** Summing minor units across
   * currencies produces a number that looks like money and is not — 100 cents
   * and 100 pence are not 200 of anything. The invoice row stores no exchange
   * rate, so the only honest answer keeps them apart.
   *
   * ⚠️ **`status = 'paid'` only.** A draft or open invoice is tax not yet
   * collected; including it would overstate a return, and an uncollectible one
   * would overstate it worse.
   */
  async collected(input: { from: Date; to: Date }): Promise<TaxReport> {
    if (Number.isNaN(input.from.getTime()) || Number.isNaN(input.to.getTime())) {
      throw new BadRequestException('from and to must be valid dates');
    }

    if (input.from >= input.to) {
      throw new BadRequestException('from must be earlier than to');
    }

    /*
     * 📌 **Half-open interval `[from, to)`**, so consecutive periods neither
     * overlap nor leave a gap. A closed upper bound double-counts every invoice
     * issued exactly at midnight on the boundary, in both quarters.
     */
    const rows: Array<{
      taxCountry: string | null;
      currency: string;
      invoiceCount: string;
      netMinor: string;
      taxMinor: string;
      grossMinor: string;
    }> = await this.dataSource.query(
      `SELECT taxCountry,
              currency,
              COUNT(*)          AS invoiceCount,
              SUM(subtotalMinor) AS netMinor,
              SUM(taxMinor)      AS taxMinor,
              SUM(totalMinor)    AS grossMinor
         FROM invoices
        WHERE issuedAt >= ? AND issuedAt < ? AND status = ?
        GROUP BY taxCountry, currency
        ORDER BY taxCountry, currency`,
      [input.from, input.to, InvoiceStatus.PAID],
    );

    return {
      from: input.from.toISOString(),
      to: input.to.toISOString(),

      /*
       * ⚠️ **MySQL returns SUM() over a bigint as a string**, and `Number` on a
       * string is how a total silently becomes `NaN` or loses precision. These
       * are minor units, so every figure is an integer and the conversion is
       * exact well beyond any plausible quarter.
       */
      rows: rows.map((row) => ({
        taxCountry: row.taxCountry,
        currency: row.currency,
        invoiceCount: Number(row.invoiceCount),
        netMinor: Number(row.netMinor),
        taxMinor: Number(row.taxMinor),
        grossMinor: Number(row.grossMinor),
      })),
    };
  }
}
