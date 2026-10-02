// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
/**
 * Cost engine — pure, deterministic, no DOM. The same function renders the
 * default scenario into static HTML at build time and powers the island.
 *
 * Model (per employee, per year, in USD):
 *   gross salary
 * + employer contributions (each: rate × base, base floored/capped, gated by
 *   gross thresholds; base = gross | basic (share of gross) | flat amount)
 * + statutory extras flagged in_total (percent of gross | extra months | days)
 * = employer cost before EOR
 * + EOR fee per employee per month × 12 (list / from price; null when quote-only)
 * = total cost of employment through that provider
 */

export interface Source {
  name?: string;
  url?: string;
  checked_at: string;
}

export interface Contribution {
  id: string;
  name: string;
  rate: number;
  /** gross | basic (share of gross) | flat amount | band (rate × the slice of gross between floor and cap) */
  base: 'gross' | 'basic' | 'flat' | 'band';
  /** multiplier from gross to the statutory base (Mexico's SBC integrates aguinaldo and vacation premium); 1 when absent; ignored for flat */
  base_factor?: number;
  /* Optional rather than `| null` so the island payload can omit them: they are null on
     most lines, and five null keys per contribution were 31 % of what the browser got.
     Every consumer here tests `!= null` or uses `??`, and `undefined` behaves as null
     in both. The build-time data files still carry every key; zod requires them. */
  cap_annual_local?: number | null;
  floor_annual_local?: number | null;
  flat_annual_local?: number | null;
  max_gross_annual_local?: number | null;
  min_gross_annual_local?: number | null;
  applies?: string;
  notes?: string;
  /** absent in the island payload: nothing in the island renders it */
  source?: Source;
}

export interface StatutoryExtra {
  id: string;
  name: string;
  kind: 'percent' | 'months' | 'days';
  value: number;
  in_total: boolean;
  notes?: string;
  /** absent in the island payload: nothing in the island renders it */
  source?: Source;
}

export interface Assumption {
  id: string;
  label: string;
  value: number;
  notes?: string;
  /** false: fixed by law, shown as text rather than as a control */
  adjustable?: boolean;
}

export interface Country {
  iso: string;
  slug: string;
  name: string;
  currency: string;
  example_salary_usd: number;
  example_role: string;
  assumptions: Assumption[];
  employer_contributions: Contribution[];
  statutory_extras: StatutoryExtra[];
  thirteenth_month: boolean;
  paid_leave_days: number;
}

export interface Plan {
  id: string;
  name: string;
  scope: 'eor' | 'contractor' | 'payroll' | 'peo';
  pricing_model: 'list' | 'from' | 'quote';
  price_usd_month: number | null;
  billing: 'monthly' | 'annual' | 'either' | 'unknown';
  annual_price_usd_month: number | null;
  min_term_months: number | null;
  deposit_policy: string;
  fx_markup_pct: number | null;
  addons: string[];
  notes?: string;
  /** kept in the island payload: both islands stamp `source.checked_at` next to the fee */
  source: Source;
}

export interface Vendor {
  id: string;
  name: string;
  cta_url: string;
  affiliate_url: string | null;
  cta_label: string;
  plans: Plan[];
  countries_excluded: string[];
}

export interface Fx {
  as_of: string;
  /** local units per 1 USD */
  rates: Record<string, number>;
  /**
   * Currencies the ECB does not quote because they are pegged to the dollar:
   * the parity comes from the issuing central bank and carries its own date.
   */
  pegged?: Record<string, { rate: number; authority: string; source_url: string; checked_at: string; note: string }>;
  /**
   * Currencies neither regime above reaches: the European Commission's monthly
   * accounting rate. It is fixed for a calendar month, so it is dated by its
   * month (`period`) and not by a market close.
   */
  monthly?: {
    authority: string;
    source_url: string;
    api_url?: string;
    period: string;
    checked_at: string;
    /** the euro-dollar value this regime is re-based on, which is not the ECB's */
    usd_per_eur?: number;
    note: string;
    /** currencies that can move by several points inside one month */
    volatile: string[];
    volatile_note: string;
    rates: Record<string, number>;
  };
}

export interface ScenarioInput {
  countryIso: string;
  salaryAnnualUsd: number;
  headcount: number;
  vendorIds: string[];
  /** override a country assumption (e.g. basic_share_of_gross) */
  assumptions?: Record<string, number>;
}

export type LineKind = 'salary' | 'contribution' | 'extra';

export interface LedgerLine {
  id: string;
  label: string;
  kind: LineKind;
  /** per employee, per year, USD */
  annualUsd: number;
  /** per employee, per month, USD */
  monthlyUsd: number;
  /** effective rate against gross (annualUsd / gross) */
  effectiveRate: number;
  /** nominal rate as published, when applicable */
  rate?: number;
  capped?: boolean;
  skipped?: boolean;
  note?: string;
  source?: Source;
}

export interface VendorResult {
  id: string;
  name: string;
  available: boolean;
  pricingModel: 'list' | 'from' | 'quote';
  plan: Plan | null;
  /** per employee, per month */
  feeMonthlyUsd: number | null;
  /** all employees, per month (salary + employer cost + fee) */
  totalMonthlyUsd: number | null;
  totalAnnualUsd: number | null;
  /** share of the total that is the provider's fee */
  feeShare: number | null;
  ctaUrl: string;
  ctaLabel: string;
}

export interface ScenarioResult {
  country: { iso: string; slug: string; name: string; currency: string };
  headcount: number;
  salaryAnnualUsd: number;
  salaryAnnualLocal: number;
  fxRate: number;
  fxAsOf: string;
  lines: LedgerLine[];
  /** per employee, per year, USD, before EOR fees */
  employerCostAnnualUsd: number;
  /** employer on-cost as a share of gross (0.18 = +18 %) */
  employerRate: number;
  /** per employee, per month, USD, before EOR fees */
  employeeMonthlyUsd: number;
  perVendor: VendorResult[];
  cheapest: VendorResult | null;
  assumptions: Assumption[];
}

export interface Datasets {
  countries: Country[];
  vendors: Vendor[];
  fx: Fx;
}

const clamp = (v: number, min: number | null | undefined, max: number | null | undefined) => {
  let x = v;
  if (min != null && x < min) x = min;
  if (max != null && x > max) x = max;
  return x;
};

export function eorPlan(vendor: Vendor): Plan | null {
  return vendor.plans.find((p) => p.scope === 'eor') ?? null;
}

export function computeScenario(input: ScenarioInput, data: Datasets): ScenarioResult {
  const country = data.countries.find((c) => c.iso === input.countryIso);
  if (!country) throw new Error(`Unknown country ${input.countryIso}`);
  const fxRate = data.fx.rates[country.currency];
  if (!fxRate) throw new Error(`No FX rate for ${country.currency}`);

  const headcount = Math.max(1, Math.min(50, Math.round(input.headcount)));
  const grossUsd = Math.max(0, input.salaryAnnualUsd);
  const grossLocal = grossUsd * fxRate;

  const assumptionValue = (id: string, fallback: number) =>
    input.assumptions?.[id] ?? country.assumptions.find((a) => a.id === id)?.value ?? fallback;

  // Bounded: a share outside [0, 1] or a citizenship flag other than 0/1 has no meaning.
  const share = assumptionValue('basic_share_of_gross', 1);
  const basicShare = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 1;
  const citizenOrPr = assumptionValue('employee_is_citizen_or_pr', 1) >= 1 ? 1 : 0;

  const lines: LedgerLine[] = [
    {
      id: 'salary',
      label: 'Gross salary',
      kind: 'salary',
      annualUsd: grossUsd,
      monthlyUsd: grossUsd / 12,
      effectiveRate: 1,
    },
  ];

  for (const c of country.employer_contributions) {
    // gating by gross thresholds
    const gated =
      (c.max_gross_annual_local != null && grossLocal > c.max_gross_annual_local) ||
      (c.min_gross_annual_local != null && grossLocal < c.min_gross_annual_local);
    // country-specific switch: CPF only for citizens/PR
    const switchedOff = c.id === 'employer_cpf' && citizenOrPr < 1;

    if (gated || switchedOff) {
      lines.push({
        id: c.id,
        label: c.name,
        kind: 'contribution',
        annualUsd: 0,
        monthlyUsd: 0,
        effectiveRate: 0,
        rate: c.rate,
        skipped: true,
        note: switchedOff ? 'Not applicable: employee is not a citizen or permanent resident' : c.applies ?? 'Not applicable at this salary',
        source: c.source,
      });
      continue;
    }

    const factor = c.base_factor ?? 1;
    let baseLocal: number;
    if (c.base === 'flat') baseLocal = c.flat_annual_local ?? 0;
    else if (c.base === 'basic') baseLocal = grossLocal * basicShare * factor;
    else baseLocal = grossLocal * factor;

    let annualLocal: number;
    if (c.base === 'flat') annualLocal = baseLocal;
    else if (c.base === 'band') {
      // only the slice of the base between the floor and the cap is charged (CPP2, Mexican "excedente")
      const slice = Math.min(baseLocal, c.cap_annual_local ?? Number.POSITIVE_INFINITY) - (c.floor_annual_local ?? 0);
      annualLocal = Math.max(0, slice) * c.rate;
    } else annualLocal = clamp(baseLocal, c.floor_annual_local, c.cap_annual_local) * c.rate;
    const annualUsd = annualLocal / fxRate;

    lines.push({
      id: c.id,
      label: c.name,
      kind: 'contribution',
      annualUsd,
      monthlyUsd: annualUsd / 12,
      effectiveRate: grossUsd > 0 ? annualUsd / grossUsd : 0,
      rate: c.base === 'flat' ? undefined : c.rate,
      capped: c.base !== 'flat' && c.cap_annual_local != null && baseLocal > c.cap_annual_local,
      note: c.notes,
      source: c.source,
    });
  }

  for (const e of country.statutory_extras) {
    if (!e.in_total) continue;
    let annualUsd = 0;
    if (e.kind === 'percent') annualUsd = grossUsd * (e.value / 100);
    else if (e.kind === 'months') annualUsd = (grossUsd / 12) * e.value;
    else if (e.kind === 'days') annualUsd = (grossUsd / 260) * e.value;
    lines.push({
      id: e.id,
      label: e.name,
      kind: 'extra',
      annualUsd,
      monthlyUsd: annualUsd / 12,
      effectiveRate: grossUsd > 0 ? annualUsd / grossUsd : 0,
      rate: e.kind === 'percent' ? e.value / 100 : undefined,
      note: e.notes,
      source: e.source,
    });
  }

  const employerCostAnnualUsd = lines.filter((l) => l.kind !== 'salary').reduce((s, l) => s + l.annualUsd, 0);
  const employerRate = grossUsd > 0 ? employerCostAnnualUsd / grossUsd : 0;
  const employeeAnnualUsd = grossUsd + employerCostAnnualUsd;
  const employeeMonthlyUsd = employeeAnnualUsd / 12;

  const perVendor: VendorResult[] = input.vendorIds
    .map((id) => data.vendors.find((v) => v.id === id))
    .filter((v): v is Vendor => Boolean(v))
    .map((v) => {
      const plan = eorPlan(v);
      const available = !v.countries_excluded.includes(country.iso);
      const fee = plan && plan.pricing_model !== 'quote' ? plan.price_usd_month : null;
      const totalMonthly = available && fee != null ? (employeeMonthlyUsd + fee) * headcount : null;
      return {
        id: v.id,
        name: v.name,
        available,
        pricingModel: plan?.pricing_model ?? 'quote',
        plan,
        feeMonthlyUsd: fee,
        totalMonthlyUsd: totalMonthly,
        totalAnnualUsd: totalMonthly != null ? totalMonthly * 12 : null,
        feeShare: totalMonthly != null && fee != null ? (fee * headcount) / totalMonthly : null,
        ctaUrl: v.affiliate_url ?? v.cta_url,
        ctaLabel: v.cta_label,
      };
    });

  const priced = perVendor.filter((r) => r.totalMonthlyUsd != null);
  const cheapest = priced.length ? priced.reduce((a, b) => (a.totalMonthlyUsd! <= b.totalMonthlyUsd! ? a : b)) : null;

  return {
    country: { iso: country.iso, slug: country.slug, name: country.name, currency: country.currency },
    headcount,
    salaryAnnualUsd: grossUsd,
    salaryAnnualLocal: grossLocal,
    fxRate,
    fxAsOf: data.fx.as_of,
    lines,
    employerCostAnnualUsd,
    employerRate,
    employeeMonthlyUsd,
    perVendor,
    cheapest,
    assumptions: country.assumptions,
  };
}

/** Employer on-cost rate for the country's example salary (used in indexes and the manifesto). */
export function exampleEmployerRate(country: Country, data: Datasets): number {
  return computeScenario(
    { countryIso: country.iso, salaryAnnualUsd: country.example_salary_usd, headcount: 1, vendorIds: [] },
    data,
  ).employerRate;
}
