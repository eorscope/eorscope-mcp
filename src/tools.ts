// The tools as pure functions over a data snapshot. Every figure comes from the site's own
// engine and formatters (src/vendor, copied from the site by scripts/sync.mjs): nothing is re-implemented.
import { readFileSync } from 'node:fs';
import { computeScenario, type Country, type Datasets, type Fx, type ScenarioResult } from './vendor/cost-engine';
import { contractorRoute, entityRoute } from './vendor/decision';
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
  leave_note?: string;
  public_holidays: number | null;
  holidays_note?: string;
  probation_months_max: number | null;
  probation_note?: string;
  /** monthly salaries paid in a year (scripts/sync.mjs, schema v2); null = not yet tracked */
  salary_payments?: SalaryPayments | null;
  /** null when the country file's text names a provider (withheld by scripts/sync.mjs) */
  notice_typical: string | null;
  last_reviewed: string;
}
/** One dated change of audit/plugin_data/{iso}.json (schema v1), embedded only once reviewed (REVIEWED.json). */
export interface ScheduledChange {
  /** null when the change has no line in the country's ledger */
  contribution_id: string | null;
  effective_from: string;
  date_basis: 'stated' | 'inferred' | 'derived';
  change: { rate: number | null; cap_annual_local: number | null; threshold_weekly_local: number | null; floor_annual_local: number | null };
  status: 'enacted' | 'budget_announced';
  note?: string;
  source: { url: string; quote: string; read_on: string; kind: 'official' | 'secondary' };
}
export interface SalaryPayment { name: string; statutory: boolean; salary_months: number | null; months: number[] | null; deadline: string | null }
/** count = 12 + the salary_months of the statutory payments; gross_months = count - on_top_months, the months of
 *  salary inside the engine's annual gross (the on_top_lines are statutory extras the ledger adds on top of it) */
export interface SalaryPayments {
  basis: 'statutory' | 'not_statutory';
  count: number;
  gross_months: number;
  on_top_lines: string[];
  on_top_months: number;
  /** statutory extras carried at 0 because the payment is already inside the annual gross (PT, GR, ES) */
  in_gross_lines?: string[];
  payments: SalaryPayment[];
  customary: SalaryPayment[];
  source: Record<string, unknown> | null;
}
/** announced, proposed or awaited, with no dated figure yet: listed, never applied */
export interface Pending { status: string; description: string; contribution_id: string | null; source: { url: string | null } }
export interface ScheduledFile {
  researched_on: string;
  coverage: 'complete' | 'partial';
  pending?: Pending[];
  scheduled_changes: ScheduledChange[];
}
export interface Snapshot {
  snapshot_date: string;
  source_commit: string;
  fx: Fx & { source_name?: string };
  countries: SnapCountry[];
  /** reviewed dated changes by ISO code; a country absent here is "not yet tracked", never "no change" */
  scheduled?: Record<string, ScheduledFile>;
}

export interface SalaryArgs {
  /** gross annual salary; the country's example salary when omitted */
  salary?: number;
  salary_currency?: 'USD' | 'local';
  /** 'month': `salary` is a monthly salary, paid payments_per_year times (the country's statutory number by default) */
  salary_period?: 'year' | 'month';
  /** total monthly salaries the contract pays in a year, statutory ones included (salary_period 'month' only) */
  payments_per_year?: number;
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

export interface ToolOptions {
  /** utm_source added to every page link (the remote server sets "chatgpt"); none by default */
  utm?: string;
}

export function createTools(snapshot: Snapshot, options: ToolOptions = {}) {
  const tag = (url: string) => (options.utm ? `${url}${url.includes('?') ? '&' : '?'}utm_source=${encodeURIComponent(options.utm)}` : url);
  // countries only: the providers' terms forbid redistributing their prices
  const datasets: Datasets = { countries: snapshot.countries, vendors: [], fx: snapshot.fx };
  const meta = (page_url: string) => ({
    snapshot_date: snapshot.snapshot_date,
    page_url: tag(page_url),
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

  // The one place a salary is read. A monthly salary becomes the engine's annual gross: monthly x (payments a year
  // - the statutory payments the ledger adds as lines of its own, such as Brazil's 13th salary), so nothing is counted twice.
  const four = (n: number) => Math.round(n * 1e4) / 1e4;
  const disp = (n: number) => String(Math.round(n * 100) / 100); // 13.3333 reads 13.33 in prose
  const notTrackedPayments = (c: SnapCountry) =>
    `The number of statutory salary payments in ${c.name} is not yet tracked by EOR Scope: the monthly salary is counted 12 times. If the contract pays a 13th or 14th month, pass payments_per_year.`;
  const composition = (c: SnapCountry, monthly: number, cur: string, paymentsPerYear: number | null) => {
    const sp = c.salary_payments ?? null;
    const onTop = sp?.on_top_months ?? 0;
    const p = paymentsPerYear ?? sp?.count ?? 12;
    const grossMonths = four(p - onTop);
    if (!(grossMonths > 0)) throw new Error(`payments_per_year ${p} leaves no month of salary in the annual gross: ${c.name}'s ledger already adds ${onTop} statutory months on top of it.`);
    const annual = monthly * grossMonths;
    const what =
      paymentsPerYear != null
        ? `${disp(p)} payments (your input${sp?.basis === 'statutory' ? `; ${disp(sp.count)} statutory` : ''})`
        : sp?.basis === 'statutory'
          ? `${disp(p)} statutory payments`
          : sp
            ? `${disp(p)} payments (no statutory 13th month)`
            : '12 payments (statutory number not yet tracked)';
    const lines = (sp?.on_top_lines ?? []).map((id) => (c.statutory_extras.find((e) => e.id === id) ?? c.employer_contributions.find((e) => e.id === id))?.name ?? id).join(', ');
    return {
      sp,
      p,
      grossMonths,
      annual,
      text: onTop
        ? `${local(monthly, cur)} a month × ${what}: ${disp(grossMonths)} in the annual gross (${local(annual, cur)} a year), ${disp(onTop)} added by the ledger as statutory lines (${lines})`
        : `${local(monthly, cur)} a month × ${what} = ${local(annual, cur)} a year`,
    };
  };
  const resolveSalary = (c: SnapCountry, a: SalaryArgs) => {
    if (a.salary_period !== 'month') {
      if (a.payments_per_year != null) throw new Error('payments_per_year applies to a monthly salary: pass salary_period "month" with it.');
      return { salary: a.salary, basis: undefined };
    }
    if (a.salary == null) throw new Error('salary_period "month" needs the monthly salary in salary.');
    const cur = a.salary_currency === 'local' ? c.currency : 'USD';
    const x = composition(c, a.salary, cur, a.payments_per_year ?? null);
    const given = a.payments_per_year != null;
    return {
      salary: x.annual,
      basis: {
        period: 'month' as const,
        monthly: a.salary,
        currency: cur,
        payments_per_year: x.p,
        payments_from: given ? 'your input' : x.sp?.basis === 'statutory' ? 'statutory' : x.sp ? 'no statutory 13th month' : 'not yet tracked',
        statutory_payments: x.sp?.count ?? null,
        gross_months: x.grossMonths,
        on_top_months: x.sp?.on_top_months ?? 0,
        composition: x.text,
        annual_gross_used: Math.round(x.annual * 100) / 100,
        note: 'The annual gross used by the ledger is the monthly salary times gross_months; a statutory payment the ledger adds as its own line is not in it, so it is not counted twice.',
        ...((): { flag?: string } => {
          if (!given && !x.sp) return { flag: notTrackedPayments(c) };
          if (given && x.sp?.basis === 'statutory' && x.p < x.sp.count) return { flag: `payments_per_year ${x.p} is below the ${disp(x.sp.count)} statutory payments in ${c.name}.` };
          return {};
        })(),
        source: x.sp?.source ?? null,
      },
    };
  };
  const basisOf = (c: SnapCountry, a: SalaryArgs) => resolveSalary(c, a).basis;

  const scenario = (c: SnapCountry, a: SalaryArgs) => {
    const declared = c.assumptions.filter((x) => ENGINE_ASSUMPTIONS.includes(x.id) && x.adjustable !== false).map((x) => x.id);
    for (const id of Object.keys(a.assumptions ?? {})) {
      if (!declared.includes(id)) {
        throw new Error(`"${id}" cannot be changed for ${c.name}. ${declared.length ? `Adjustable: ${declared.join(', ')}.` : 'This country has no adjustable assumption.'}`);
      }
    }
    const s = resolveSalary(c, a).salary;
    const salaryAnnualUsd = s == null ? c.example_salary_usd : a.salary_currency === 'local' ? s / snapshot.fx.rates[c.currency] : s;
    return computeScenario({ countryIso: c.iso, salaryAnnualUsd, headcount: 1, vendorIds: [], assumptions: a.assumptions }, datasets);
  };

  const salaryBlock = (c: SnapCountry, r: ScenarioResult) =>
    drop({
      annual_usd: cents(r.salaryAnnualUsd),
      annual_local: local(r.salaryAnnualLocal, c.currency),
      is_country_example: r.salaryAnnualUsd === c.example_salary_usd ? `example salary (${c.example_role.toLowerCase()}), not a median` : undefined,
      fx: fxInfo(c),
    });

  /** an amount in the currency the user gave: local with the USD in brackets (as the ledger widget shows it), else USD */
  const inLocal = (c: SnapCountry, ...given: (string | undefined)[]) => c.currency !== 'USD' && given.includes('local');
  const money = (c: SnapCountry, loc: boolean) => (n: number) => (loc ? `${local(n * snapshot.fx.rates[c.currency], c.currency)} (${usd(n)})` : usd(n));

  /** statutory employer charges for one employee, before any EOR fee */
  const costBlock = (c: SnapCountry, r: ScenarioResult, loc = false) => {
    const b = c.total_bound;
    const monthly = r.employerCostAnnualUsd / 12;
    const m = money(c, loc);
    return drop({
      pct_of_gross: bounded(b, pct(r.employerRate, 1)),
      monthly: monthly === 0 ? 'none' : bounded(b, m(monthly)),
      annual: monthly === 0 ? 'none' : bounded(b, m(r.employerCostAnnualUsd)),
      values: { bound: word(b), pct_of_gross: pct4(r.employerRate), monthly_usd: cents(monthly), annual_usd: cents(r.employerCostAnnualUsd) },
      excludes: c.total_excludes,
    });
  };

  const where = (c: SnapCountry) => `${placeName(c.name)}${c.example_place ? ` (${c.example_place} rates)` : ''}`;

  const sentence = (c: SnapCountry, r: ScenarioResult, loc = false) => {
    const b = c.total_bound;
    const monthly = r.employerCostAnnualUsd / 12;
    const m = money(c, loc);
    const amount = monthly === 0 ? 'nothing' : b ? bounded(b, m(monthly)) : `about ${m(monthly)}`;
    return `One employee in ${where(c)} at ${m(r.salaryAnnualUsd)} gross a year costs ${amount} a month in statutory employer charges (${bounded(b, `+${pct(r.employerRate, 1)}`)} of gross)${c.total_excludes ? `, excluding ${c.total_excludes}` : ''}, before any EOR fee.`;
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

  /** salary plus statutory employer charges, the bound of the charges carried over to the total */
  const totalBlock = (c: SnapCountry, r: ScenarioResult) => {
    const annual = r.salaryAnnualUsd + r.employerCostAnnualUsd;
    return drop({ bound: word(c.total_bound), annual_usd: cents(annual), monthly_usd: cents(annual / 12), annual: bounded(c.total_bound, usd(annual)) });
  };
  const ceilingsReached = (r: ScenarioResult) => r.lines.filter((l) => l.capped).map((l) => ({ id: l.id, name: l.label }));
  /** the site's calculator with this scenario (scenario-url.ts format: c, s, n, a_<assumption>) */
  const scenarioUrl = (c: SnapCountry, r: ScenarioResult, assumptions?: Record<string, number>) => {
    const p = new URLSearchParams({ c: c.iso, s: String(Math.round(r.salaryAnnualUsd)), n: '1' });
    for (const [k, v] of Object.entries(assumptions ?? {})) p.set(`a_${k}`, String(v));
    return tag(`${SITE}/eor-cost-calculator/?${p}`);
  };

  // Dated changes (phase 2). Only the files listed in audit/plugin_data/REVIEWED.json reach the snapshot;
  // any other country is "not yet tracked", which never means that nothing is scheduled.
  const tracked = (c: SnapCountry) => snapshot.scheduled?.[c.iso];
  const notTracked = (c: SnapCountry) => `Dated changes for ${c.name} are not yet tracked by EOR Scope: this does not mean that nothing is scheduled.`;
  const lineName = (c: SnapCountry, id: string | null) =>
    id == null ? 'No matching ledger line' : c.employer_contributions.find((k) => k.id === id)?.name ?? c.statutory_extras.find((e) => e.id === id)?.name ?? id;
  const STATUS = { enacted: 'enacted: published law or official text', budget_announced: 'announced in a budget, not yet enacted' } as const;
  const byDate = (x: ScheduledChange, y: ScheduledChange) => x.effective_from.localeCompare(y.effective_from);
  const coverageNote = (f: ScheduledFile) =>
    f.coverage === 'complete' ? `Researched on ${f.researched_on} from the sources read that day.` : `Researched on ${f.researched_on}, coverage partial: other changes may be scheduled that are not yet tracked.`;
  const changeView = (c: SnapCountry, x: ScheduledChange) =>
    drop({
      contribution_id: x.contribution_id,
      name: lineName(c, x.contribution_id),
      effective_from: x.effective_from,
      date_basis: x.date_basis,
      date_note: x.date_basis === 'stated' ? undefined : `effective date ${x.date_basis} from the source, not stated in it`,
      status: x.status,
      status_note: STATUS[x.status],
      change: drop({ ...x.change }),
      currency: c.currency,
      in_force_at_last_review: x.effective_from <= c.last_reviewed || undefined,
      note: x.note,
      source: x.source,
    });
  /** the country with the changes applied in date order, each change saying what it set and what it could not */
  const project = (c: SnapCountry, changes: ScheduledChange[]) => {
    const p: SnapCountry = structuredClone(c);
    const applied = changes.map((x) => {
      const k = p.employer_contributions.find((y) => y.id === x.contribution_id);
      const { rate, cap_annual_local, floor_annual_local, threshold_weekly_local } = x.change;
      const set: Record<string, number> = {};
      const not: string[] = [];
      if (!k) {
        if ([rate, cap_annual_local, floor_annual_local, threshold_weekly_local].some((v) => v != null)) not.push('Not an employer contribution line: nothing applied.');
      } else {
        if (rate != null) set.rate = k.rate = rate;
        if (cap_annual_local != null) set.cap_annual_local = k.cap_annual_local = cap_annual_local;
        if (floor_annual_local != null) set.floor_annual_local = k.floor_annual_local = floor_annual_local;
        if (threshold_weekly_local != null) {
          // a weekly band limit is the line's gross band edge in the ledger (52 weeks, a calculation)
          const t = threshold_weekly_local * 52;
          if (k.max_gross_annual_local != null && k.min_gross_annual_local == null) set.max_gross_annual_local = k.max_gross_annual_local = t;
          else if (k.min_gross_annual_local != null && k.max_gross_annual_local == null) set.min_gross_annual_local = k.min_gross_annual_local = t;
          else not.push('The weekly threshold matches no single gross band edge of this line: not applied.');
        }
      }
      return drop({
        ...changeView(c, x),
        applied_as: Object.keys(set).length ? set : undefined,
        calculation: set.max_gross_annual_local != null || set.min_gross_annual_local != null ? 'annual band edge = weekly threshold x 52 (a calculation, not a citation)' : undefined,
        not_applied: not.length ? not.join(' ') : undefined,
        no_figure: [rate, cap_annual_local, floor_annual_local, threshold_weekly_local].every((v) => v == null) ? 'The source sets no figure yet: the line stays at its current figures.' : undefined,
      });
    });
    return { p, applied };
  };

  /** the monthly salary an annual gross stands for, paid the country's statutory number of times */
  const maxMonthly = (c: SnapCountry, annualUsd: number, annualLocal: number, bound: string | null) => {
    const sp = c.salary_payments ?? null;
    const gm = sp?.gross_months ?? 12;
    const monthlyLocal = Math.floor((annualLocal / gm) * 100) / 100;
    return drop({
      bound,
      monthly_usd: Math.floor((annualUsd / gm) * 100) / 100,
      monthly_local: local(monthlyLocal, c.currency),
      payments_per_year: sp?.count ?? 12,
      statutory_payments: sp?.count ?? null,
      gross_months: gm,
      composition: composition(c, monthlyLocal, c.currency, null).text,
      flag: sp ? undefined : notTrackedPayments(c),
      source: sp?.source ?? null,
    });
  };

  const compareOffers = (a: { offers: (SalaryArgs & { country: string; salary: number })[] }) => {
    const list = a.offers.map((o) => ({ o, c: country(o.country) }));
    if (list.length < 2 || list.length > 6) throw new Error('compare_offers takes 2 to 6 offers.');
    const dup = list.find((x, i) => list.findIndex((y) => y.c.iso === x.c.iso) !== i);
    if (dup) throw new Error(`One offer per country: ${dup.c.name} is given twice.`);
    const rows = list.map(({ o, c }) => ({ o, c, r: scenario(c, o) }));
    const totals = rows.map(({ r }) => r.salaryAnnualUsd + r.employerCostAnnualUsd);
    const smallest = Math.min(...totals);
    const at = totals.indexOf(smallest);
    const bounded_ = rows.some(({ c }) => c.total_bound);
    return {
      summary: `Each offer's total cost to the employer (gross salary plus statutory employer charges), before any EOR fee: ${rows.map(({ c, r }, i) => `${c.name} ${bounded(c.total_bound, usd(totals[i]))} a year (salary ${usd(r.salaryAnnualUsd)}, charges ${bounded(c.total_bound, `+${pct(r.employerRate, 1)}`)})`).join('; ')}.`,
      reading: `Rows are in the order given. difference_from_smallest compares each total with the smallest total (${rows[at].c.name}); ratio_to_smallest divides them.${bounded_ ? ' A total written "at least" or "at most" is a declared bound, and so is any difference computed from it.' : ''}`,
      offers: rows.map(({ o, c, r }, i) =>
        drop({
          iso: c.iso,
          name: c.name,
          priced_for: c.example_place,
          salary: salaryBlock(c, r),
          salary_basis: basisOf(c, o),
          employer_cost: costBlock(c, r),
          total: totalBlock(c, r),
          difference_from_smallest_annual_usd: cents(totals[i] - smallest),
          ratio_to_smallest: Math.round((totals[i] / smallest) * 1000) / 1000,
          ceilings_reached: ceilingsReached(r),
          page_url: tag(pageUrl(c)),
        }),
      ),
      smallest_total: drop({ iso: rows[at].c.iso, name: rows[at].c.name, bound: word(rows[at].c.total_bound), annual_usd: cents(smallest) }),
      meta: meta(`${SITE}/employer-of-record/`),
    };
  };

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
        summary: `${countries.length} countries${a.region ? ` in ${countries[0]?.region ?? a.region}` : ''}, each with its currency, example salary and statutory employer cost at that salary, before any EOR fee.`,
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
      const basis = basisOf(c, a);
      const loc = inLocal(c, a.salary_currency);
      const sp = c.salary_payments ?? null;
      const inGross = sp?.in_gross_lines ?? [];
      const included = sp && inGross.length
        ? {
            months: four(sp.gross_months - 12),
            payments_per_year: sp.count,
            lines: inGross.map((id) => {
              const e = c.statutory_extras.find((x) => x.id === id)!;
              return drop({ id: e.id, name: e.name, notes: notes ? e.notes : undefined, source: e.source });
            }),
            reading: `Statutory payments paid out of the annual gross salary, not on top of it: ${disp(sp.gross_months - 12)} of the ${disp(sp.count)} monthly payments a year. The employer charges above already apply to them.`,
          }
        : undefined;
      return {
        summary: `${sentence(c, r, loc)}${basis ? ` Salary basis: ${basis.composition}.` : ''}${included ? ` Included in the gross salary: ${included.lines.map((l) => l.name).join('; ')} (${included.months} of the ${included.payments_per_year} monthly payments).` : ''}`,
        country: drop({ iso: c.iso, name: c.name, slug: c.slug, region: c.region, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        salary_basis: basis,
        employer_cost: costBlock(c, r, loc),
        lines: ledger(c, r, notes),
        not_in_total: c.statutory_extras
          .filter((e) => !e.in_total && !inGross.includes(e.id))
          .map((e) => drop({ id: e.id, name: e.name, kind: e.kind, value: e.value, notes: notes ? e.notes : undefined, source: e.source })),
        included_in_gross_salary: included,
        assumptions: c.assumptions.map((x) =>
          drop({ id: x.id, label: x.label, value: x.value, used: a.assumptions?.[x.id], notes: notes ? x.notes : undefined }),
        ),
        meta: meta(pageUrl(c)),
      };
    },

    compareCountries(a: { countries: string[]; salary_usd: number; salary_period?: 'year' | 'month'; payments_per_year?: number }) {
      const list = [...new Map(a.countries.map((q) => country(q)).map((c) => [c.iso, c])).values()];
      if (list.length < 2 || list.length > 10) throw new Error('compare_countries takes 2 to 10 different countries.');
      const month = a.salary_period === 'month';
      const args: SalaryArgs = { salary: a.salary_usd, salary_period: a.salary_period, payments_per_year: a.payments_per_year };
      const rows = list.map((c) => ({ c, r: scenario(c, args) }));
      return {
        summary: `Statutory employer charges on ${usd(a.salary_usd)} gross ${month ? "a month, paid the number of times each country's salary_basis gives," : 'a year,'} before any EOR fee: ${rows.map(({ c, r }) => `${c.name} ${bounded(c.total_bound, `+${pct(r.employerRate, 1)}`)}`).join(', ')}.`,
        ...(month ? { salary_monthly_usd: a.salary_usd } : { salary_annual_usd: a.salary_usd }),
        reading: 'Rows are in the order requested, not ranked. A figure written "at least" or "at most" is a declared bound, not a total: compare by ratio and keep the bound in the sentence.',
        countries: rows.map(({ c, r }) => {
          return drop({
            iso: c.iso,
            name: c.name,
            priced_for: c.example_place,
            salary_local: c.currency === 'USD' ? undefined : local(r.salaryAnnualLocal, c.currency),
            salary_annual_usd: month ? cents(r.salaryAnnualUsd) : undefined,
            salary_basis: basisOf(c, args),
            employer_cost: costBlock(c, r),
            page_url: tag(pageUrl(c)),
          });
        }),
        meta: meta(`${SITE}/employer-of-record/`),
      };
    },

    maxSalaryForBudget(a: { country: string; budget: number; budget_currency?: 'USD' | 'local'; budget_period?: 'year' | 'month'; eor_fee_usd_month?: number; assumptions?: Record<string, number> }) {
      const c = country(a.country);
      const perYear = a.budget_period === 'month' ? a.budget * 12 : a.budget;
      const budgetUsd = a.budget_currency === 'local' ? perYear / snapshot.fx.rates[c.currency] : perYear;
      const fee = (a.eor_fee_usd_month ?? 0) * 12;
      const room = budgetUsd - fee;
      if (!(room > 0)) throw new Error(`The EOR fee entered (${usd(fee)} a year) leaves nothing of a ${usd(budgetUsd)} budget for salary and charges.`);
      const at = (s: number) => {
        const r = scenario(c, { salary: s, assumptions: a.assumptions });
        return { r, total: s + r.employerCostAnnualUsd };
      };
      // bisection on the employer_cost ledger itself: the largest salary whose total stays within the budget
      let lo = 0;
      let hi = room;
      if (at(hi).total <= room) lo = hi;
      else while (hi - lo > 0.001) {
        const mid = (lo + hi) / 2;
        if (at(mid).total <= room) lo = mid;
        else hi = mid;
      }
      const salary = Math.floor(lo * 100) / 100;
      if (salary < 1) throw new Error(`A ${usd(budgetUsd)} budget does not cover the fixed statutory charges in ${c.name}.`);
      const { r, total } = at(salary);
      const b = c.total_bound;
      const salaryBound = b === 'floor' ? 'at most' : b === 'ceiling' ? 'at least' : null;
      const unused = room - total;
      const loc = inLocal(c, a.budget_currency);
      const m = money(c, loc);
      return {
        summary: `In ${where(c)}, ${m(budgetUsd)} a year${fee ? `, of which ${m(fee)} for the EOR fee you entered,` : ''} pays a gross salary of ${salaryBound ? `${salaryBound} ` : 'up to '}${m(salary)} a year, with ${bounded(b, m(r.employerCostAnnualUsd))} of statutory employer charges (${bounded(b, `+${pct(r.employerRate, 1)}`)} of gross)${c.total_excludes ? `, excluding ${c.total_excludes}` : ''}.`,
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        budget: drop({ annual_usd: cents(budgetUsd), annual_local: loc ? local(budgetUsd * snapshot.fx.rates[c.currency], c.currency) : undefined, eor_fee_annual_usd: fee ? cents(fee) : undefined, salary_and_charges_annual_usd: cents(room) }),
        max_salary: drop({ bound: salaryBound, annual_usd: cents(salary), monthly_usd: cents(salary / 12), annual_local: local(r.salaryAnnualLocal, c.currency), fx: fxInfo(c) }),
        max_monthly_salary: maxMonthly(c, salary, r.salaryAnnualLocal, salaryBound),
        employer_cost: costBlock(c, r, loc),
        total: { annual_usd: cents(total + fee), monthly_usd: cents((total + fee) / 12), unused_annual_usd: cents(unused) },
        reading:
          unused > 1
            ? `The budget is not reached exactly: a statutory line starts or steps up just above this salary, and a higher salary would cost more than the budget. employer_cost at ${usd(salary)} gives the same ledger.`
            : `Found on the same ledger as employer_cost, to the cent: employer_cost at this salary returns this budget within $1.`,
        meta: meta(pageUrl(c)),
      };
    },

    employmentTerms(a: { country: string }) {
      const c = country(a.country);
      const file = { source: `EOR Scope country file for ${c.name}, ${pageUrl(c)}`, checked_at: c.last_reviewed };
      const months = c.statutory_extras.filter((e) => e.kind === 'months');
      return {
        summary: `${c.name}: ${c.paid_leave_days} days of paid leave${c.leave_note ? ` (${c.leave_note})` : ''}, ${c.public_holidays != null ? `${c.public_holidays} public holidays` : 'public holidays not recorded'}${c.holidays_note ? ` (${c.holidays_note})` : ''}, ${c.probation_months_max != null ? `probation up to ${c.probation_months_max} months` : (c.probation_note ?? 'probation maximum not recorded')}, ${c.thirteenth_month ? 'a 13th-month payment' : 'no 13th-month payment'}.`,
        country: { iso: c.iso, name: c.name, last_reviewed: c.last_reviewed },
        terms: {
          paid_leave_days: drop({ value: c.paid_leave_days, note: c.leave_note, ...file }),
          public_holidays: drop({ value: c.public_holidays, note: c.holidays_note ?? (c.public_holidays == null ? 'not recorded' : undefined), ...file }),
          probation_months_max: drop({ value: c.probation_months_max, note: c.probation_note ?? (c.probation_months_max == null ? 'not recorded' : undefined), ...file }),
          notice: c.notice_typical != null ? { text: c.notice_typical, ...file } : { text: null, note: `Not carried here: the country page has it (${pageUrl(c)}).` },
          thirteenth_month: { value: c.thirteenth_month, ...file },
        },
        // each with its official source and check date
        statutory_extras: c.statutory_extras.map((e) =>
          drop({
            id: e.id,
            name: e.name,
            kind: e.kind,
            value: e.value,
            in_employer_cost_total: e.in_total,
            in_gross_salary: c.salary_payments?.in_gross_lines?.includes(e.id) || undefined,
            source: (e as { source_is_provider?: boolean }).source_is_provider ? { name: `Secondary source, cited on the ${c.name} page`, url: pageUrl(c), checked_at: e.source?.checked_at } : e.source,
          }),
        ),
        extra_month_payments: months.length ? months.map((e) => e.name) : undefined,
        salary_payments: c.salary_payments
          ? { tracking: 'tracked' as const, ...c.salary_payments }
          : { tracking: 'not yet tracked' as const, count: null, note: `The number of statutory salary payments a year in ${c.name} is not yet tracked by EOR Scope.` },
        reading: 'Statutory minimums as recorded in the country file; a contract or collective agreement can grant more. Onboarding times and entity set-up notes are on the country page. salary_payments.count is the number of monthly salaries the law requires in a year (customary payments are listed apart, never counted); on_top_lines are the statutory payments the employer cost ledger adds on top of the annual gross; in_gross_lines (in_gross_salary) are statutory payments already inside the annual gross salary, never on top of it.',
        meta: meta(pageUrl(c)),
      };
    },

    reconcileQuote(a: SalaryArgs & { country: string; amounts_currency?: 'USD' | 'local'; period?: 'month' | 'year'; lines: QuoteLine[] }) {
      const c = country(a.country);
      const r = scenario(c, a);
      const rate = snapshot.fx.rates[c.currency];
      const toLocal = (n: number) => Math.round(n * rate * 100) / 100;
      const toMonthlyUsd = (x: number) => (a.amounts_currency === 'local' ? x / rate : x) / (a.period === 'year' ? 12 : 1);
      const expected = r.lines.filter((l) => l.kind !== 'salary');
      const ids = expected.map((l) => l.id);
      const matchId = (q: QuoteLine) => {
        if (q.statutory_id != null) {
          if (!ids.includes(q.statutory_id)) throw new Error(`Unknown statutory_id "${q.statutory_id}" for ${c.name}. Ids: ${ids.join(', ')}.`);
          return q.statutory_id;
        }
        const n = norm(q.label);
        const hits = expected.filter((l) => [norm(l.label), norm(l.id)].some((m) => m === n || (m.length >= 4 && n.length >= 4 && (m.includes(n) || n.includes(m)))));
        return hits.length === 1 ? hits[0].id : null;
      };
      const quoted = a.lines.map((q) => ({ q, usd: toMonthlyUsd(q.amount), id: q.type === 'employer_charge' ? matchId(q) : null }));
      const sum = (xs: { usd: number }[]) => xs.reduce((s, x) => s + x.usd, 0);
      const salaryLines = quoted.filter((x) => x.q.type === 'salary');
      const charges = quoted.filter((x) => x.q.type === 'employer_charge');
      const basis = basisOf(c, a);
      const loc = inLocal(c, a.amounts_currency, a.salary_currency);
      const m = money(c, loc);
      // A monthly quote shows one monthly payment. When the annual gross holds more than 12 (Spain's 2 pagas extra),
      // the salary line is compared with the monthly salary given; the extra payments are paid outside these lines.
      const extraMonths = a.period !== 'year' && basis && basis.gross_months > 12 ? four(basis.gross_months - 12) : 0;
      const expSalaryAvg = r.salaryAnnualUsd / 12;
      const expSalary = extraMonths ? r.salaryAnnualUsd / basis!.gross_months : expSalaryAvg;
      const expCharges = r.employerCostAnnualUsd / 12;
      const qSalary = salaryLines.length ? sum(salaryLines) : null;
      const qCharges = sum(charges);
      const fees = sum(quoted.filter((x) => x.q.type === 'fee'));
      const other = sum(quoted.filter((x) => x.q.type === 'other'));
      const salaryDiff = qSalary != null ? qSalary - expSalary : 0;
      const chargesDiff = qCharges - expCharges;
      const b = c.total_bound;
      // one global employer-charge line (or several, none naming a single statutory line): compared to the
      // statutory total only, so no statutory line is "missing" from it
      const aggregate = charges.length > 0 && charges.every((x) => x.id == null);
      const owed = expected.filter((l) => !l.skipped && cents(l.monthlyUsd) > 0);
      const gapText = `${m(salaryDiff + chargesDiff + fees + other)} a month, of which ${m(fees)} in fee lines, ${m(chargesDiff)} from employer charges against the statutory ledger${qSalary != null ? ` and ${m(salaryDiff)} on the salary line` : ''}${other ? ` and ${m(other)} in other lines` : ''}.`;
      const extraNames = (c.salary_payments?.payments ?? []).map((p) => p.name).join(', ');
      const salaryLine = extraMonths
        ? drop({
            compared_with: `one monthly payment of ${m(expSalary)}, ${disp(basis!.payments_per_year)} payments a year`,
            extra_payments: drop({ months: extraMonths, names: extraNames || undefined, monthly_average_usd: cents(expSalaryAvg - expSalary) }),
            if_spread_over_12_months: drop({ expected_salary_usd: cents(expSalaryAvg), salary_line_difference_usd: qSalary != null ? cents(qSalary - expSalaryAvg) : undefined }),
            reading: `A monthly quote shows one of the ${disp(basis!.payments_per_year)} payments. Read as such, the ${disp(extraMonths)} extra payments and the employer charges on them are owed outside these monthly lines. If the provider spreads the extra payments over 12 months instead, the salary line should be the annual gross / 12: the quote has to say which.`,
          })
        : undefined;
      const extraText = extraMonths
        ? ` The salary line is compared with the monthly salary of ${m(expSalary)}, one of ${disp(basis!.payments_per_year)} payments a year: the ${disp(extraMonths)} extra payments${extraNames ? ` (${extraNames})` : ''} are not in a monthly quote, so their monthly average of ${m(expSalaryAvg - expSalary)}, and the employer charges on them, are owed outside these lines. Statutory employer charges are the year's charges averaged over 12 months, extra payments included. If the quote instead spreads the extra payments over 12 months, its salary line should be ${m(expSalaryAvg)}${qSalary != null ? ` (${m(qSalary - expSalaryAvg)} against the quote)` : ''}; ask the provider if the quote does not say which.`
        : '';
      return {
        summary: aggregate
          ? `${c.name}, ${m(r.salaryAnnualUsd)} gross a year: the quote gives employer charges as one total (${m(qCharges)} a month), compared with the statutory total of ${bounded(b, m(expCharges))} a month (${owed.length} statutory lines, broken down in expected_breakdown); the quote's gap over the statutory cost is ${gapText}${extraText}`
          : `${c.name}, ${m(r.salaryAnnualUsd)} gross a year: the quote's gap over the statutory cost (${bounded(b, m(expSalary + expCharges))} a month) is ${gapText}${extraText}`,
        quote_detail: aggregate ? ('aggregate' as const) : ('detailed' as const),
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        salary_basis: basis,
        salary_line: salaryLine,
        per_month_usd: drop({
          expected_salary: cents(expSalary),
          quoted_salary: qSalary != null ? cents(qSalary) : undefined,
          expected_statutory_charges: cents(expCharges),
          expected_statutory_bound: word(b),
          quoted_employer_charges: cents(qCharges),
          fee_lines: cents(fees),
          other_lines: cents(other),
          gap_over_statutory: cents(salaryDiff + chargesDiff + fees + other),
        }),
        // the same amounts in the currency the user gave
        per_month_local: loc
          ? drop({
              currency: c.currency,
              expected_salary: toLocal(expSalary),
              quoted_salary: qSalary != null ? toLocal(qSalary) : undefined,
              expected_statutory_charges: toLocal(expCharges),
              quoted_employer_charges: toLocal(qCharges),
              fee_lines: toLocal(fees),
              other_lines: toLocal(other),
              gap_over_statutory: toLocal(salaryDiff + chargesDiff + fees + other),
            })
          : undefined,
        gap_breakdown: drop({
          fee_lines: cents(fees),
          employer_charges_over_statutory: cents(chargesDiff),
          salary_line_difference: qSalary != null ? cents(salaryDiff) : undefined,
          other_lines: other ? cents(other) : undefined,
        }),
        lines: expected.map((l) => {
          const mine = charges.filter((x) => x.id === l.id);
          const q = mine.length ? sum(mine) : null;
          return drop({
            id: l.id,
            name: l.label,
            expected_monthly_usd: cents(l.monthlyUsd),
            quoted_monthly_usd: q != null ? cents(q) : undefined,
            difference_monthly_usd: q != null ? cents(q - l.monthlyUsd) : undefined,
            quoted_as: mine.length ? mine.map((x) => x.q.label) : undefined,
            skipped: l.skipped || undefined,
          });
        }),
        ...(aggregate && {
          expected_breakdown: owed.map((l) => ({ id: l.id, name: l.label, expected_monthly_usd: cents(l.monthlyUsd) })),
          aggregate_lines: charges.map((x) => ({ label: x.q.label, monthly_usd: cents(x.usd) })),
        }),
        missing_from_quote: aggregate ? [] : owed.filter((l) => !charges.some((x) => x.id === l.id)).map((l) => ({ id: l.id, name: l.label, expected_monthly_usd: cents(l.monthlyUsd) })),
        not_in_statutory_ledger: aggregate ? [] : charges.filter((x) => x.id == null).map((x) => ({ label: x.q.label, monthly_usd: cents(x.usd) })),
        ...(aggregate
          ? { missing_note: 'The quote gives employer charges as a total: it is compared with the statutory total, and expected_breakdown lists the statutory lines that total should cover, each at its annual amount / 12 (averaged over the year, extra salary payments included). Ask the provider for the line-by-line split to check each line.' }
          : charges.some((x) => x.id == null) && { missing_note: 'The quote has employer-charge lines that match no single statutory line: the missing lines may be inside them.' }),
        reading: `A salary line above the expected salary is usually an exchange-rate margin (or a different salary); employer charges above the ledger and fee lines are what the quote adds to the statutory cost. A line listed in not_in_statutory_ledger may be a statutory line under another name: pass its statutory_id (the ids in lines) to match it. Rates that depend on a risk class, a place or an assumption can differ legitimately: see employer_cost.`,
        meta: meta(pageUrl(c)),
      };
    },

    compareStructures(a: SalaryArgs & { country: string; headcount?: number; years?: number; eor_fee_usd_month: number; entity_setup_usd?: number; entity_annual_usd?: number; contractor_fee_usd_month?: number }) {
      const c = country(a.country);
      const r = scenario(c, a);
      const headcount = a.headcount ?? 1;
      const years = a.years ?? 3;
      const setupUsd = a.entity_setup_usd ?? 0;
      const annualUsd = a.entity_annual_usd ?? 0;
      const payMonthly = r.salaryAnnualUsd / 12;
      const chargesMonthly = r.employerCostAnnualUsd / 12;
      const cr = contractorRoute({ payMonthly, chargesMonthly, headcount, eorFee: a.eor_fee_usd_month, ctrFee: a.contractor_fee_usd_month ?? null, corFee: null });
      const er = entityRoute({ eorFee: a.eor_fee_usd_month, chargesMonthly, headcount, years, setupUsd, annualUsd });
      const employment = (payMonthly + chargesMonthly) * 12 * headcount * years;
      const b = c.total_bound;
      const be = er.breakEvenHeads;
      return {
        summary: `${headcount} ${headcount === 1 ? 'employee' : 'employees'} in ${where(c)} at ${usd(r.salaryAnnualUsd)} gross a year, over ${years} ${years === 1 ? 'year' : 'years'}: ${usd(employment + er.eorTotal!)} through an EOR at the fee you entered${er.hasEntity ? `, ${usd(employment + er.entityTotal)} through your own entity at the costs you entered` : ''}${cr.contractorMonthly != null ? `, ${usd(cr.contractorMonthly * 12 * years)} as contractors` : ''}. Statutory employer charges (${bounded(b, `+${pct(r.employerRate, 1)}`)} of gross) are owed by an EOR and by an entity alike.`,
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        salary_basis: basisOf(c, a),
        your_inputs: drop({ headcount, years, eor_fee_usd_month: a.eor_fee_usd_month, entity_setup_usd: setupUsd, entity_annual_usd: annualUsd, contractor_fee_usd_month: a.contractor_fee_usd_month }),
        employer_cost: costBlock(c, r),
        per_month_usd: drop({
          eor: cents(cr.employeeMonthly!),
          own_entity_running: er.hasEntity ? cents((payMonthly + chargesMonthly) * headcount + annualUsd / 12) : undefined,
          contractor: cr.contractorMonthly != null ? cents(cr.contractorMonthly) : undefined,
        }),
        over_horizon_usd: drop({
          eor: cents(employment + er.eorTotal!),
          own_entity: er.hasEntity ? cents(employment + er.entityTotal) : undefined,
          contractor: cr.contractorMonthly != null ? cents(cr.contractorMonthly * 12 * years) : undefined,
        }),
        cumulative_usd: er.rows.map((row) => drop({ year: row.y, eor_fees: cents(row.eor!), entity_costs: er.hasEntity ? cents(row.entity) : undefined, statutory_charges_either_way: cents(er.chargesPerYear * row.y) })),
        break_even:
          be != null
            ? { headcount: be < 1 ? 'under 1' : Math.ceil(be), reading: `Over ${years} ${years === 1 ? 'year' : 'years'}, ${usd(setupUsd / years + annualUsd)} of entity cost per year against ${usd(a.eor_fee_usd_month * 12)} of EOR fees per employee per year.` }
            : { headcount: null, reading: 'Enter the entity set-up and running costs to get the headcount where the two routes cross.' },
        caveats: [
          'Costs only, from the figures you entered and the statutory ledger. Whether a person may lawfully be engaged as a contractor is a legal question this tool does not answer.',
          ...(b ? [`The statutory charges here are ${word(b)} the figure shown (a declared bound).`] : []),
        ],
        meta: meta(pageUrl(c)),
      };
    },

    compareOffers,

    fxStress(a: { country: string; salary_local: number; salary_period?: 'year' | 'month'; payments_per_year?: number; budget_usd?: number; assumptions?: Record<string, number> }) {
      const c = country(a.country);
      if (c.currency === 'USD') throw new Error(`${c.name} pays salaries in USD: there is no exchange-rate exposure to test.`);
      const args: SalaryArgs = { salary: a.salary_local, salary_currency: 'local', salary_period: a.salary_period, payments_per_year: a.payments_per_year, assumptions: a.assumptions };
      const { salary: salaryLocal = a.salary_local, basis } = resolveSalary(c, args);
      const r = scenario(c, args);
      const base = r.salaryAnnualUsd + r.employerCostAnnualUsd;
      const rate = snapshot.fx.rates[c.currency];
      const b = c.total_bound;
      const budget = a.budget_usd;
      // salary and charges are owed in local currency: their USD cost moves exactly with the local currency's USD value
      const row = (shift: number) =>
        drop({
          local_currency_change_pct: shift,
          local_per_usd: Math.round((rate / (1 + shift / 100)) * 1e6) / 1e6,
          annual_usd: cents(base * (1 + shift / 100)),
          monthly_usd: cents((base * (1 + shift / 100)) / 12),
          difference_annual_usd: cents((base * shift) / 100),
          within_budget: budget != null ? base * (1 + shift / 100) <= budget : undefined,
          budget_headroom_annual_usd: budget != null ? cents(budget - base * (1 + shift / 100)) : undefined,
        });
      const holds = budget != null ? Math.round((budget / base - 1) * 1000) / 10 : null;
      const totalLocal = salaryLocal + r.employerCostAnnualUsd * rate;
      return {
        summary: `${c.name}, ${local(salaryLocal, c.currency)} gross a year: salary plus statutory employer charges come to ${bounded(b, local(totalLocal, c.currency))}, ${bounded(b, usd(base))} a year at the official rate of ${rate} ${c.currency} per USD. Every 10% the ${c.currency} gains or loses against the USD moves that USD cost by ${usd(base / 10)}${holds != null ? `; ${holds >= 0 ? `the ${usd(budget!)} budget holds until the ${c.currency} gains ${holds}%` : `the ${usd(budget!)} budget is already exceeded at the official rate`}` : ''}.`,
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        exchange_rate: fxInfo(c),
        salary_annual_local: local(salaryLocal, c.currency),
        salary_basis: basis,
        employer_cost: costBlock(c, r),
        total_annual_local: bounded(b, local(totalLocal, c.currency)),
        total_at_official_rate: totalBlock(c, r),
        scenarios: [-20, -10, -5, 0, 5, 10, 20].map(row),
        budget: budget != null ? { annual_usd: budget, headroom_at_official_rate_usd: cents(budget - base), holds_until_local_currency_change_pct: holds } : undefined,
        reading: `local_currency_change_pct is the change in the ${c.currency}'s value against the USD (+10 = one ${c.currency} buys 10% more USD). Salary and employer charges are owed in ${c.currency}, so their USD cost moves by the same percent. These are what-if rates, not forecasts.`,
        meta: meta(pageUrl(c)),
      };
    },

    contractorRateEquivalent(a: SalaryArgs & { country: string; paid_leave_days?: number; public_holidays?: number; working_days?: number; hours_per_day?: number; eor_fee_usd_month?: number }) {
      const c = country(a.country);
      const r = scenario(c, a);
      const leave = a.paid_leave_days ?? c.paid_leave_days;
      const holidays = a.public_holidays ?? c.public_holidays;
      if (a.working_days == null && holidays == null) throw new Error(`Public holidays are not recorded for ${c.name}: pass public_holidays or working_days.`);
      const days = a.working_days ?? 260 - leave - holidays!;
      if (!(days > 0)) throw new Error(`${days} working days a year: check paid_leave_days, public_holidays or working_days.`);
      const hours = a.hours_per_day ?? 8;
      const fee = (a.eor_fee_usd_month ?? 0) * 12;
      const annual = r.salaryAnnualUsd + r.employerCostAnnualUsd + fee;
      const rate = snapshot.fx.rates[c.currency];
      const b = c.total_bound;
      const from = (given: unknown) => (given != null ? 'your input' : `EOR Scope country file for ${c.name}, checked ${c.last_reviewed}`);
      return {
        summary: `One employee in ${where(c)} at ${usd(r.salaryAnnualUsd)} gross a year costs ${bounded(b, usd(annual))} a year${fee ? `, including the ${usd(fee)} EOR fee you entered` : ''}. Over ${days} working days that is ${bounded(b, usd(annual / days))} a day, or ${bounded(b, usd(annual / days / hours))} an hour at ${hours} hours a day: the rate at which a contractor would cost the same.`,
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        salary_basis: basisOf(c, a),
        employer_cost: costBlock(c, r),
        annual_cost: drop({ bound: word(b), usd: cents(annual), eor_fee_usd: fee ? cents(fee) : undefined }),
        working_days: drop({
          value: days,
          formula: a.working_days != null ? 'your input' : `260 weekdays - ${leave} paid leave days - ${holidays} public holidays`,
          paid_leave_days: a.working_days == null ? { value: leave, from: from(a.paid_leave_days), note: a.paid_leave_days == null ? c.leave_note : undefined } : undefined,
          public_holidays: a.working_days == null ? drop({ value: holidays, from: from(a.public_holidays), note: a.public_holidays == null ? c.holidays_note : undefined }) : undefined,
        }),
        hours_per_day: hours,
        equivalent_rate: drop({
          bound: word(b),
          day_usd: cents(annual / days),
          hour_usd: cents(annual / days / hours),
          day_local: c.currency === 'USD' ? undefined : local((annual / days) * rate, c.currency),
          hour_local: c.currency === 'USD' ? undefined : local((annual / days / hours) * rate, c.currency),
        }),
        caveats: [
          'Cost equivalence only: the day or hour rate at which a contractor would cost the employer the same as this employee, before any contractor platform fee.',
          'Public holidays are counted as weekdays; pass public_holidays or working_days for a given year.',
          'Whether a person may lawfully be engaged as a contractor is a legal question this tool does not answer.',
        ],
        meta: meta(pageUrl(c)),
      };
    },

    scheduledChanges(a: { country: string }) {
      const c = country(a.country);
      const f = tracked(c);
      const head = { country: drop({ iso: c.iso, name: c.name, currency: c.currency, last_reviewed: c.last_reviewed }) };
      const reading =
        'status enacted = published law or official text; budget_announced = announced in a budget, not yet enacted. Bills, proposals and awaited figures are in pending, as read, and never applied to a figure. date_basis inferred or derived = the effective date is deduced from the source, not stated in it. Each quote is copied word for word from the source as read on read_on; kind secondary = not the official text. in_force_at_last_review = already in force when the country file was last reviewed, so already in employer_cost.';
      if (!f) return { summary: notTracked(c), tracking: 'not yet tracked' as const, ...head, changes: [], pending: [], reading, meta: meta(pageUrl(c)) };
      const changes = [...f.scheduled_changes].sort(byDate).map((x) => changeView(c, x));
      const n = changes.length;
      const e = changes.filter((x) => x.status === 'enacted').length;
      return {
        summary: n
          ? `${c.name}: ${n} dated ${n === 1 ? 'change' : 'changes'} recorded, ${e} enacted and ${n - e} announced in a budget. ${coverageNote(f)}`
          : `${c.name}: no dated change found in the sources read. ${coverageNote(f)}`,
        tracking: 'tracked' as const,
        researched_on: f.researched_on,
        coverage: f.coverage,
        ...head,
        changes,
        pending: (f.pending ?? []).map((x) => drop({ status: x.status, contribution_id: x.contribution_id, name: x.contribution_id ? lineName(c, x.contribution_id) : undefined, description: x.description, source: x.source })),
        reading,
        meta: meta(pageUrl(c)),
      };
    },

    costNextYear(a: SalaryArgs & { country: string; on_date?: string }) {
      const c = country(a.country);
      const on = a.on_date ?? `${Number(snapshot.snapshot_date.slice(0, 4)) + 1}-01-01`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) throw new Error(`on_date must be a calendar date written YYYY-MM-DD, got "${on}".`);
      const r = scenario(c, a);
      const b = c.total_bound;
      const f = tracked(c);
      const loc = inLocal(c, a.salary_currency);
      const m = money(c, loc);
      const head = {
        country: drop({ iso: c.iso, name: c.name, currency: c.currency, priced_for: c.example_place, last_reviewed: c.last_reviewed }),
        salary: salaryBlock(c, r),
        salary_basis: basisOf(c, a),
        on_date: on,
        current: { as_of: c.last_reviewed, employer_cost: costBlock(c, r, loc), total: totalBlock(c, r) },
      };
      const same = 'The same gross salary and the exchange rate of the data snapshot are used on both dates: no pay rise and no exchange-rate move are projected.';
      if (!f) {
        return {
          summary: `${notTracked(c)} No projection is made: today, ${sentence(c, r, loc).replace(/^One employee/, 'one employee')}`,
          tracking: 'not yet tracked' as const,
          ...head,
          projected: null,
          reading: `current is the statutory employer cost recorded today. ${same}`,
          meta: meta(pageUrl(c)),
        };
      }
      // a change in force when the country file was last reviewed is already in its ledger
      const due = f.scheduled_changes.filter((x) => x.effective_from > c.last_reviewed && x.effective_from <= on).sort(byDate);
      const enacted = due.filter((x) => x.status === 'enacted');
      const announced = due.filter((x) => x.status === 'budget_announced');
      const block = (list: ScheduledChange[]) => {
        const { p, applied } = project(c, list);
        const q = computeScenario({ countryIso: c.iso, salaryAnnualUsd: r.salaryAnnualUsd, headcount: 1, vendorIds: [], assumptions: a.assumptions }, { countries: [p], vendors: [], fx: snapshot.fx });
        const before = new Map(r.lines.map((l) => [l.id, l.annualUsd]));
        return {
          employer_cost: costBlock(c, q, loc),
          total: totalBlock(c, q),
          difference_annual_usd: cents(q.employerCostAnnualUsd - r.employerCostAnnualUsd),
          lines_changed: q.lines
            .filter((l) => l.kind !== 'salary' && cents(l.annualUsd) !== cents(before.get(l.id) ?? 0))
            .map((l) => ({ id: l.id, name: l.label, current_annual_usd: cents(before.get(l.id) ?? 0), projected_annual_usd: cents(l.annualUsd) })),
          changes_applied: applied,
          q,
        };
      };
      const { q, ...projected } = block(enacted);
      const all = announced.length ? block(due) : null;
      const flags = [
        ...due.filter((x) => x.date_basis !== 'stated').map((x) => `${lineName(c, x.contribution_id)}: the ${x.effective_from} date is ${x.date_basis} from the source, not stated in it.`),
        ...due.filter((x) => x.source.kind === 'secondary').map((x) => `${lineName(c, x.contribution_id)}: the ${x.effective_from} change rests on a secondary source, not the official text.`),
        ...(f.coverage === 'partial' ? ['Coverage partial: other changes may be scheduled that are not yet tracked.'] : []),
        // a bill or a proposal on a line whose dated changes fall in the window could replace them (Chile, Ley 21.735 fallback schedule)
        ...(f.pending ?? [])
          .filter((x) => (x.status === 'proposal' || x.status === 'bill') && x.contribution_id != null && due.some((d) => d.contribution_id === x.contribution_id))
          .map((x) => `${lineName(c, x.contribution_id)}: a pending ${x.status}, not enacted, could change the dated changes applied here (see pending in scheduled_changes)${x.source.url ? `. Source: ${x.source.url}` : ''}.`),
      ];
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
      return {
        summary: `${where(c)} at ${m(r.salaryAnnualUsd)} gross a year: statutory employer charges of ${bounded(b, m(r.employerCostAnnualUsd))} a year today${
          enacted.length ? `, ${bounded(b, m(q.employerCostAnnualUsd))} from ${on} with the ${plural(enacted.length, 'enacted change')} recorded` : `; no enacted change is recorded between ${c.last_reviewed} and ${on}, so the projection is today's figure`
        }${all ? `, and ${bounded(b, m(all.q.employerCostAnnualUsd))} if the ${plural(announced.length, 'change')} announced in a budget ${announced.length === 1 ? 'is' : 'are'} enacted as announced` : ''}. Before any EOR fee.`,
        tracking: 'tracked' as const,
        researched_on: f.researched_on,
        coverage: f.coverage,
        ...head,
        projected,
        with_budget_announced: all ? { flag: `Not a projection of the law in force: includes ${plural(announced.length, 'change')} announced in a budget, not yet enacted.`, ...(({ q: _q, ...x }) => x)(all) } : undefined,
        flags,
        reading: `projected applies only the enacted changes effective after the country file's last review (${c.last_reviewed}) and up to on_date; changes announced in a budget are only in with_budget_announced. ${same}`,
        meta: meta(pageUrl(c)),
      };
    },

    /** employer_cost for the ledger widget, with the site's calculator link for the same scenario */
    showLedger(a: SalaryArgs & { country: string }) {
      const c = country(a.country);
      const r = scenario(c, a);
      // the input as given, so the widget recalculates in the same currency and period
      const salary_input = drop({ salary: a.salary, salary_currency: a.salary_currency ?? 'USD', salary_period: a.salary_period ?? 'year', payments_per_year: a.payments_per_year });
      return { ...this.employerCost(a), salary_input, scenario_url: scenarioUrl(c, r, a.assumptions) };
    },

    showCompare(a: { offers: (SalaryArgs & { country: string; salary: number })[] }) {
      const out = compareOffers(a);
      return { ...out, display: out.offers.length > 3 ? 'fullscreen' : 'inline' };
    },
  };
}

export interface QuoteLine {
  label: string;
  amount: number;
  type: 'salary' | 'employer_charge' | 'fee' | 'other';
  /** the id of the statutory line it stands for (ids from employer_cost), when the label alone does not say */
  statutory_id?: string;
}

export type Tools = ReturnType<typeof createTools>;
