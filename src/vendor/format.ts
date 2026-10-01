// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
/** Number formatting shared by build-time rendering and the island. */

export const usd = (n: number, opts: { cents?: boolean } = {}) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
    minimumFractionDigits: opts.cents ? 2 : 0,
  }).format(n);

export const usdCompact = (n: number) => usd(Math.round(n));

/** A statutory charge that is genuinely nil is an answer, so it is rendered as a word.
 *  "$0" reads as a broken number and `verify_dist` refuses the string anywhere on a page.
 *  Exact zero only: a tiny non-zero amount must not be hidden behind "none" — carry it as
 *  a statutory extra instead. Armenia is the case this exists for. */
export const usdOrNone = (n: number, none = 'none') => (n === 0 ? none : usd(n));

/** Local amounts use the ISO code ("INR 2,849,249"): unambiguous, and it keeps
 *  currency symbols outside the latin subset (₹ would pull a 90 kB latin-ext font). */
export const local = (n: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 0 })
    .format(n)
    .replace(/ /g, ' ');

/** Rounded to 6 decimals first: 0.1425 * 100 is 14.249999… in binary, which printed Jordan's
 *  14.25% as "14.2%" beside prose that says 14.25%. */
export const pct = (rate: number, digits = 1) =>
  `${(Math.round(rate * 1e8) / 1e6).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

/** A published rate as printed in a ledger: whole percents bare, otherwise two decimals, and three
 *  under 0.1% where two would misstate it by a quarter or more (0.033% printed 0.03%, 0.016% printed 0.02%). */
export const ratePct = (rate: number) =>
  pct(rate, (rate * 100) % 1 === 0 ? 0 : rate < 0.001 && Math.abs(Math.round(rate * 1e4) - rate * 1e4) > 1e-6 ? 3 : 2);

export const int = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n));

/** "Checked 21 Aug 2026" from an ISO date */
export const stamp = (iso: string, prefix = 'Checked') => {
  const d = new Date(`${iso}T00:00:00Z`);
  const s = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${prefix} ${s}`;
};

/** "Checked 2–22 Sept 2026" for a set of dates read on different days. A stamp that covers
 *  several prices shows its oldest date too, or it overstates how fresh the set is. */
export const stampRange = (from: string, to: string, prefix = 'Checked') => {
  if (from === to) return stamp(to, prefix).trim();
  const [a, b] = [from, to].map((iso) => new Date(`${iso}T00:00:00Z`));
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = sameYear && a.getUTCMonth() === b.getUTCMonth()
    ? fmt(a, { day: 'numeric' })
    : fmt(a, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return `${prefix} ${left}–${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}`.trim();
};

/** "September 2026" from a YYYY-MM period, for a rate that is fixed for a calendar month */
export const monthName = (period: string) => {
  const d = new Date(`${period}-01T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
