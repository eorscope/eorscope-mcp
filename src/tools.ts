// The three tools as pure functions over a data snapshot. Every figure comes from the site's own
// engine and formatters (src/vendor, copied from the site by scripts/sync.mjs): nothing is re-implemented.
import { readFileSync } from 'node:fs';
import { computeScenario, type Country, type Datasets, type Fx, type ScenarioResult } from './vendor/cost-engine';
import { local, pct, ratePct, usd } from './vendor/format';
import { placeName } from './vendor/place-name';

export const SITE = 'https://eorscope.com';
const METHODOLOGY = `${SITE}/methodology/`;
const DISCLAIMER = 'Cost comparison, not legal or tax advice.';
const LICENSE = 'Data: CC BY 4.0, attribution "EOR Scope, eorscope.com".';

export type Bound = 'floor' | 'ceiling' | null;
export interface SnapCountry extends Country {
  region: string;
  example_place?: string;
  total_excludes?: string;
  /** the country declares its total as a floor ("at least") or a ceiling ("at most") */
  total_bound: Bound;
  last_reviewed: string;
}
export interface Snapshot {
  snapshot_date: string;
  source_commit: string;
  fx: Fx & { source_name?: string };
  countries: SnapCountry[];
}

export interface SalaryArgs {
  /** gross annual salary; the country's example salary when omitted */
  salary?: number;
  salary_currency?: 'USD' | 'local';
  assumptions?: Record<string, number>;
}

export function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
}

const BOUND_WORDS = { floor: 'at least', ceiling: 'at most' } as const;
/** A declared floor or ceiling is written into the figure itself, never left to a side note. */
const bounded = (b: Bound, text: string) => (b ? `${BOUND_WORDS[b]} ${text}` : text);
const word = (b: Bound) => (b ? BOUND_WORDS[b] : null);
/** Numbers are rounded by the site's own formatters (half away from zero), exactly as the site's
 *  dataset export does: a sum that lands on 1205.62499... is 1205.625 and prints .63. */
const number = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
const cents = (n: number) => number(usd(Math.round(n * 1e6) / 1e6, { cents: true }));
const pct4 = (rate: number) => number(pct(rate, 4));
const drop = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<T>;
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const ALIASES: Record<string, string> = { usa: 'US', unitedstatesofamerica: 'US', greatbritain: 'GB', korea: 'KR', czechia: 'CZ', turkiye: 'TR' };
/** the only assumptions the engine computes with; the others document what a ledger is priced for */
const ENGINE_ASSUMPTIONS = ['basic_share_of_gross', 'employee_is_citizen_or_pr'];

export function createTools(snapshot: Snapshot) {
  // countries only: the providers' terms forbid redistributing their prices
  const datasets: Datasets = { countries: snapshot.countries, vendors: [], fx: snapshot.fx };
  const meta = (page_url: string) => ({
    snapshot_date: snapshot.snapshot_date,
    page_url,
    methodology_url: METHODOLOGY,
    disclaimer: DISCLAIMER,
    license: LICENSE,
  });
  const pageUrl = (c: SnapCountry) => `${SITE}/employer-of-record/${c.slug}/`;

  const country = (q: string): SnapCountry => {
    const n = norm(q);
    const iso = ALIASES[n] ?? q.trim().toUpperCase();
    const c = snapshot.countries.find((x) => x.iso === iso) ?? snapshot.countries.find((x) => norm(x.slug) === n || norm(x.name) === n);
    if (!c) throw new Error(`Unknown country "${q}". Use an ISO 3166-1 alpha-2 code or a name from list_countries (${snapshot.countries.length} countries).`);
    return c;
  };

  const fxInfo = (c: SnapCountry) => {
    if (c.currency === 'USD') return undefined;
    const { fx } = snapshot;
    const local_per_usd = fx.rates[c.currency];
    const peg = fx.pegged?.[c.currency];
    if (peg) return { local_per_usd, date: peg.checked_at, source: `${peg.authority}, official parity` };
    if (fx.monthly?.rates[c.currency] != null) {
      return drop({
        local_per_usd,
        date: fx.monthly.checked_at,
        period: fx.monthly.period,
        source: fx.monthly.authority,
        caution: fx.monthly.volatile.includes(c.currency) ? fx.monthly.volatile_note : undefined,
      });
    }
    return { local_per_usd, date: fx.as_of, source: fx.source_name ?? 'ECB euro foreign exchange reference rates' };
  };

  const scenario = (c: SnapCountry, a: SalaryArgs) => {
    const declared = c.assumptions.filter((x) => ENGINE_ASSUMPTIONS.includes(x.id) && x.adjustable !== false).map((x) => x.id);
    for (const id of Object.keys(a.assumptions ?? {})) {
      if (!declared.includes(id)) {
        throw new Error(`"${id}" cannot be changed for ${c.name}. ${declared.length ? `Adjustable: ${declared.join(', ')}.` : 'This country has no adjustable assumption.'}`);
      }
    }
    const salaryAnnualUsd = a.salary == null ? c.example_salary_usd : a.salary_currency === 'local' ? a.salary / snapshot.fx.rates[c.currency] : a.salary;
    return computeScenario({ countryIso: c.iso, salaryAnnualUsd, headcount: 1, vendorIds: [], assumptions: a.assumptions }, datasets);
  };

  const salaryBlock = (c: SnapCountry, r: ScenarioResult) =>
    drop({
      annual_usd: cents(r.salaryAnnualUsd),
      annual_local: local(r.salaryAnnualLocal, c.currency),
      is_country_example: r.salaryAnnualUsd === c.example_salary_usd ? `example salary (${c.example_role.toLowerCase()}), not a median` : undefined,
      fx: fxInfo(c),
    });

  /** statutory employer charges for one employee, before any EOR fee */
  const costBlock = (c: SnapCountry, r: ScenarioResult) => {
    const b = c.total_bound;
    const monthly = r.employerCostAnnualUsd / 12;
    return drop({
      pct_of_gross: bounded(b, pct(r.employerRate, 1)),
      monthly: monthly === 0 ? 'none' : bounded(b, usd(monthly)),
      annual: monthly === 0 ? 'none' : bounded(b, usd(r.employerCostAnnualUsd)),
      values: { bound: word(b), pct_of_gross: pct4(r.employerRate), monthly_usd: cents(monthly), annual_usd: cents(r.employerCostAnnualUsd) },
      excludes: c.total_excludes,
    });
  };

  const where = (c: SnapCountry) => `${placeName(c.name)}${c.example_place ? ` (${c.example_place} rates)` : ''}`;

  const sentence = (c: SnapCountry, r: ScenarioResult) => {
    const b = c.total_bound;
    const monthly = r.employerCostAnnualUsd / 12;
    const amount = monthly === 0 ? 'nothing' : b ? bounded(b, usd(monthly)) : `about ${usd(monthly)}`;
    return `One employee in ${where(c)} at ${usd(r.salaryAnnualUsd)} gross a year costs ${amount} a month in statutory employer charges (${bounded(b, `+${pct(r.employerRate, 1)}`)} of gross)${c.total_excludes ? `, excluding ${c.total_excludes}` : ''}, before any EOR fee.`;
  };

  const ledger = (c: SnapCountry, r: ScenarioResult, notes: boolean) =>
    r.lines
      .filter((l) => l.kind !== 'salary')
      .map((l) => {
        const amounts = { annual_usd: cents(l.annualUsd), monthly_usd: cents(l.monthlyUsd) };
        const rate = { rate: l.rate, rate_printed: l.rate != null ? ratePct(l.rate) : undefined };
        if (l.kind === 'extra') {
          const e = c.statutory_extras.find((x) => x.id === l.id && x.in_total)!;
          return drop({ id: l.id, name: l.label, type: 'statutory_extra', kind: e.kind, value: e.value, ...rate, ...amounts, notes: notes ? e.notes : undefined, source: e.source });
        }
        const k = c.employer_contributions.find((x) => x.id === l.id)!;
        return drop({
          id: l.id,
          name: l.label,
          type: 'contribution',
          ...rate,
          base: k.base,
          base_factor: k.base !== 'flat' && k.base_factor != null && k.base_factor !== 1 ? k.base_factor : undefined,
          base_floor_annual_local: k.floor_annual_local,
          base_cap_annual_local: k.cap_annual_local,
          flat_annual_local: k.flat_annual_local,
          applies_from_gross_annual_local: k.min_gross_annual_local,
          applies_up_to_gross_annual_local: k.max_gross_annual_local,
          currency: c.currency,
          capped: l.capped || undefined,
          skipped: l.skipped || undefined,
          skipped_reason: l.skipped ? l.note : undefined,
          ...amounts,
          applies: k.applies,
          notes: notes ? k.notes : undefined,
          source: k.source,
        });
      });

  return {
    listCountries(a: { region?: string } = {}) {
      const region = a.region ? norm(a.region) : null;
      const regions = [...new Set(snapshot.countries.map((c) => c.region))].sort();
      if (region && !regions.some((r) => norm(r) === region)) throw new Error(`Unknown region "${a.region}". Regions: ${regions.join(', ')}.`);
      const countries = snapshot.countries
        .filter((c) => !region || norm(c.region) === region)
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((c) => ({
          iso: c.iso,
          name: c.name,
          slug: c.slug,
          region: c.region,
          currency: c.currency,
          example_salary_usd: c.example_salary_usd,
          employer_cost_at_example: bounded(c.total_bound, pct(scenario(c, {}).employerRate, 1)),
        }));
      return {
        count: countries.length,
        reading: `Alphabetical order. employer_cost_at_example is the statutory employer cost as a percent of gross at the country's example salary, before any EOR fee; it changes with the salary. Country page: ${SITE}/employer-of-record/<slug>/.`,
        countries,
        meta: meta(`${SITE}/employer-of-record/`),
      };
    },

    employerCost(a: SalaryArgs & { country: string; include_notes?: boolean }) {
      const c = country(a.country);
      const r = scenario(c, a);
      const notes = a.include_notes === true;
      return {
        summary: sentence(c, r),
        country: drop({ iso: c.iso, name: c.name, slug: c.slug, region: c.region, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        employer_cost: costBlock(c, r),
        lines: ledger(c, r, notes),
        not_in_total: c.statutory_extras
          .filter((e) => !e.in_total)
          .map((e) => drop({ id: e.id, name: e.name, kind: e.kind, value: e.value, notes: notes ? e.notes : undefined, source: e.source })),
        assumptions: c.assumptions.map((x) =>
          drop({ id: x.id, label: x.label, value: x.value, used: a.assumptions?.[x.id], notes: notes ? x.notes : undefined }),
        ),
        meta: meta(pageUrl(c)),
      };
    },

    compareCountries(a: { countries: string[]; salary_usd: number }) {
      const list = [...new Map(a.countries.map((q) => country(q)).map((c) => [c.iso, c])).values()];
      if (list.length < 2 || list.length > 10) throw new Error('compare_countries takes 2 to 10 different countries.');
      return {
        salary_annual_usd: a.salary_usd,
        reading: 'Rows are in the order requested, not ranked. A figure written "at least" or "at most" is a declared bound, not a total: compare by ratio and keep the bound in the sentence.',
        countries: list.map((c) => {
          const r = scenario(c, { salary: a.salary_usd });
          return drop({
            iso: c.iso,
            name: c.name,
            priced_for: c.example_place,
            salary_local: c.currency === 'USD' ? undefined : local(r.salaryAnnualLocal, c.currency),
            employer_cost: costBlock(c, r),
            page_url: pageUrl(c),
          });
        }),
        meta: meta(`${SITE}/employer-of-record/`),
      };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
