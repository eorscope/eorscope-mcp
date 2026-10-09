import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTools, SITE, type Snapshot, type ToolOptions } from './tools';
import { COMPARE_HTML, COMPARE_URI, LEDGER_HTML, LEDGER_URI, WIDGET_MIME } from './widgets';

/** replaced at build time with the version in package.json */
declare const __VERSION__: string;

const country = z.string().min(2).max(60).describe('ISO 3166-1 alpha-2 code ("DE") or country name ("Germany")');
const salary = z.number().positive().max(1e12).optional().describe("Gross salary, a year unless salary_period is \"month\". Omit to use the country's example salary.");
const salary_currency = z.enum(['USD', 'local']).default('USD').describe('Currency of `salary`: USD, or the local currency of the country');
const salary_period = z
  .enum(['year', 'month'])
  .default('year')
  .describe('Whether the salary is a year (default) or a month. Pass a monthly salary as the user gives it, with "month": the statutory number of monthly payments of the country (13th, 14th month) is applied, see salary_basis in the answer.');
const payments_per_year = z
  .number()
  .min(12)
  .max(16)
  .optional()
  .describe('With salary_period "month" only: the total number of monthly salaries the contract pays in a year, statutory ones included (e.g. 14). Omit to use the statutory number of the country.');
const assumptions = z
  .record(z.number())
  .optional()
  .describe('Override an adjustable assumption the country declares, e.g. {"basic_share_of_gross": 0.6}. See `assumptions` in an employer_cost answer.');

// ------------------------------------------------------------------ output schemas
// Top-level keys are declared one by one; nested blocks declare the fields a client can rely on
// and let the rest through (passthrough), so a new detail never breaks a client.
const open = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const str = z.string();
const num = z.number();
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional();
const metaOut = open({ snapshot_date: str, page_url: str, methodology_url: str, disclaimer: str, license: str });
const sourceOut = open({ name: opt(str), url: opt(str), checked_at: opt(str) });
const fxOut = open({ local_per_usd: num, date: str, source: str });
const salaryOut = open({ annual_usd: num, annual_local: str, is_country_example: opt(str), fx: opt(fxOut) });
const costOut = open({
  pct_of_gross: str,
  monthly: str,
  annual: str,
  values: open({ bound: str.nullable(), pct_of_gross: num, monthly_usd: num, annual_usd: num }),
  excludes: opt(str),
});
const countryOut = open({ iso: str, name: str, currency: opt(str), last_reviewed: opt(str) });
const totalOut = open({ bound: opt(str), annual_usd: num, monthly_usd: num, annual: str });
const ledgerLineOut = open({ id: str, name: str, type: z.enum(['contribution', 'statutory_extra']), annual_usd: num, monthly_usd: num, source: opt(sourceOut) });
const salaryBasisOut = opt(
  open({ period: z.literal('month'), monthly: num, currency: str, payments_per_year: num, statutory_payments: num.nullable(), gross_months: num, composition: str, annual_gross_used: num, note: str, flag: opt(str) }),
);
const offerRowOut = open({ iso: str, name: str, salary: salaryOut, employer_cost: costOut, total: totalOut, difference_from_smallest_annual_usd: num, ratio_to_smallest: num, ceilings_reached: z.array(open({ id: str, name: str })), page_url: str });
const changeOut = open({
  contribution_id: opt(str),
  name: str,
  effective_from: str,
  date_basis: z.enum(['stated', 'inferred', 'derived']),
  date_note: opt(str),
  status: z.enum(['enacted', 'budget_announced']),
  status_note: str,
  change: open({ rate: opt(num), cap_annual_local: opt(num), threshold_weekly_local: opt(num), floor_annual_local: opt(num) }),
  currency: str,
  in_force_at_last_review: opt(z.literal(true)),
  note: opt(str),
  source: open({ url: str, quote: str, read_on: str, kind: z.enum(['official', 'secondary']) }),
});
const projectionOut = open({
  employer_cost: costOut,
  total: totalOut,
  difference_annual_usd: num,
  lines_changed: z.array(open({ id: str, name: str, current_annual_usd: num, projected_annual_usd: num })),
  changes_applied: z.array(changeOut.extend({ applied_as: opt(z.record(num)), calculation: opt(str), not_applied: opt(str), no_figure: opt(str) })),
});
const common = { summary: str, meta: metaOut };
/** data tools point at their render tool: the same figures, shown as an interactive table when the model calls it */
const displayOut = (tool: 'show_ledger' | 'show_compare') => opt(open({ tool: z.literal(tool), arguments: z.record(z.unknown()), note: str }));
const tracking = z.enum(['tracked', 'not yet tracked']);
const ledgerOut = {
  ...common,
  country: countryOut,
  salary: salaryOut,
  salary_basis: salaryBasisOut,
  employer_cost: costOut,
  lines: z.array(ledgerLineOut),
  not_in_total: z.array(open({ id: str, name: str })),
  included_in_gross_salary: opt(open({ months: num, payments_per_year: num, lines: z.array(open({ id: str, name: str })), reading: str })),
  assumptions: z.array(open({ id: str, label: str })),
};
const compareOut = { ...common, reading: str, offers: z.array(offerRowOut), smallest_total: open({ iso: str, name: str, annual_usd: num }) };

export const OUTPUT_SCHEMAS = {
  list_countries: { ...common, count: num, reading: str, countries: z.array(open({ iso: str, name: str, slug: str, region: str, currency: str, example_salary_usd: num, employer_cost_at_example: str })) },
  employer_cost: { ...ledgerOut, widget: displayOut('show_ledger') },
  compare_countries: { ...common, salary_annual_usd: opt(num), salary_monthly_usd: opt(num), reading: str, countries: z.array(open({ iso: str, name: str, employer_cost: costOut, page_url: str })), widget: displayOut('show_compare') },
  max_salary_for_budget: {
    ...common,
    country: countryOut,
    budget: open({ annual_usd: num, annual_local: opt(str), salary_and_charges_annual_usd: num }),
    max_salary: open({ annual_usd: num, monthly_usd: num, annual_local: str }),
    max_monthly_salary: open({ monthly_usd: num, monthly_local: str, payments_per_year: num, statutory_payments: num.nullable(), gross_months: num, composition: str }),
    employer_cost: costOut,
    total: open({ annual_usd: num, monthly_usd: num, unused_annual_usd: num }),
    reading: str,
  },
  employment_terms: {
    ...common,
    country: countryOut,
    terms: open({ paid_leave_days: open({}), public_holidays: open({}), probation_months_max: open({}), notice: open({}), thirteenth_month: open({}) }),
    statutory_extras: z.array(open({ id: str, name: str })),
    extra_month_payments: opt(z.array(str)),
    salary_payments: open({ tracking, count: num.nullable() }),
    reading: str,
  },
  reconcile_quote: {
    ...common,
    country: countryOut,
    salary: salaryOut,
    salary_basis: salaryBasisOut,
    salary_line: opt(open({ compared_with: str, extra_payments: open({ months: num, monthly_average_usd: num }), if_spread_over_12_months: open({ expected_salary_usd: num }), reading: str })),
    per_month_usd: open({ expected_salary: num, expected_statutory_charges: num, quoted_employer_charges: num, fee_lines: num, gap_over_statutory: num }),
    per_month_local: opt(open({ currency: str, expected_salary: num, expected_statutory_charges: num, quoted_employer_charges: num, fee_lines: num, gap_over_statutory: num })),
    gap_breakdown: open({ fee_lines: num, employer_charges_over_statutory: num }),
    quote_detail: z.enum(['detailed', 'aggregate']),
    expected_breakdown: opt(z.array(open({ id: str, name: str, expected_monthly_usd: num }))),
    aggregate_lines: opt(z.array(open({ label: str, monthly_usd: num }))),
    lines: z.array(open({ id: str, name: str, expected_monthly_usd: num })),
    missing_from_quote: z.array(open({ id: str, name: str, expected_monthly_usd: num })),
    not_in_statutory_ledger: z.array(open({ label: str, monthly_usd: num })),
    missing_note: opt(str),
    reading: str,
  },
  compare_structures: {
    ...common,
    country: countryOut,
    salary: salaryOut,
    salary_basis: salaryBasisOut,
    your_inputs: open({ headcount: num, years: num, eor_fee_usd_month: num }),
    employer_cost: costOut,
    per_month_usd: open({ eor: num }),
    over_horizon_usd: open({ eor: num }),
    cumulative_usd: z.array(open({ year: num })),
    break_even: open({ headcount: z.union([num, z.literal('under 1')]).nullable(), reading: str }),
    caveats: z.array(str),
  },
  compare_offers: { ...compareOut, widget: displayOut('show_compare') },
  fx_stress: {
    ...common,
    country: countryOut,
    exchange_rate: fxOut,
    salary_annual_local: str,
    salary_basis: salaryBasisOut,
    employer_cost: costOut,
    total_annual_local: str,
    total_at_official_rate: totalOut,
    scenarios: z.array(open({ local_currency_change_pct: num, local_per_usd: num, annual_usd: num, monthly_usd: num, difference_annual_usd: num })),
    budget: opt(open({ annual_usd: num, headroom_at_official_rate_usd: num, holds_until_local_currency_change_pct: num.nullable() })),
    reading: str,
  },
  contractor_rate_equivalent: {
    ...common,
    country: countryOut,
    salary: salaryOut,
    salary_basis: salaryBasisOut,
    employer_cost: costOut,
    annual_cost: open({ usd: num }),
    working_days: open({ value: num, formula: str }),
    hours_per_day: num,
    equivalent_rate: open({ day_usd: num, hour_usd: num }),
    caveats: z.array(str),
  },
  scheduled_changes: {
    ...common,
    tracking,
    researched_on: opt(str),
    coverage: opt(z.enum(['complete', 'partial'])),
    country: countryOut,
    changes: z.array(changeOut),
    pending: z.array(open({ status: str, contribution_id: opt(str), description: str, source: open({ url: str.nullable() }) })),
    reading: str,
  },
  cost_next_year: {
    ...common,
    tracking,
    researched_on: opt(str),
    coverage: opt(z.enum(['complete', 'partial'])),
    country: countryOut,
    salary: salaryOut,
    salary_basis: salaryBasisOut,
    on_date: str,
    current: open({ as_of: str, employer_cost: costOut, total: totalOut }),
    projected: projectionOut.nullable(),
    with_budget_announced: opt(projectionOut.extend({ flag: str })),
    flags: opt(z.array(str)),
    reading: str,
  },
  show_ledger: {
    ...ledgerOut,
    salary_input: open({ salary: opt(num), salary_currency: z.enum(['USD', 'local']), salary_period: z.enum(['year', 'month']), payments_per_year: opt(num) }),
    scenario_url: str,
  },
  show_compare: { ...compareOut, display: z.enum(['inline', 'fullscreen']) },
};

/** the origin the widgets are served for (`_meta.ui.domain`): MCP_PUBLIC_ORIGIN, else the Vercel deployment */
export const DEFAULT_PUBLIC_ORIGIN = 'https://mcp.eorscope.com';
const publicOrigin = (given?: string) => {
  const raw = given ?? process.env.MCP_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`MCP_PUBLIC_ORIGIN "${raw}" is not a URL`);
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`MCP_PUBLIC_ORIGIN "${raw}" must be https (http only for localhost)`);
  return u.origin;
};

export interface ServerOptions extends ToolOptions {
  /** the text block of a data tool: the full JSON (default, for clients that read only text) or the one-sentence summary
   *  plus the disclaimer (remote server: the client reads structuredContent) */
  text?: 'json' | 'summary';
  /** origin the widgets are served for; MCP_PUBLIC_ORIGIN or https://mcp.eorscope.com when absent */
  publicOrigin?: string;
}

export function createServer(snapshot: Snapshot, options: ServerOptions = {}) {
  const tools = createTools(snapshot, options);
  const origin = publicOrigin(options.publicOrigin);
  const server = new McpServer(
    {
      name: 'eorscope-mcp',
      title: 'EOR Scope',
      version: __VERSION__,
      description: 'Statutory employer cost by country, with sources and check dates, before any Employer of Record (EOR) fee.',
      websiteUrl: `${SITE}/`,
      icons: [{ src: `${SITE}/favicon.svg`, mimeType: 'image/svg+xml' }],
    },
    {
      instructions:
        'EOR Scope gives the statutory employer cost of an employee by country (employer contributions with their sources, official wherever one exists, and check dates), before any Employer of Record (EOR) fee. Its tools fit questions about what an employee costs the employer abroad, checking an EOR, PEO or payroll quote, the employer cost of offers in several countries, a salary for a hiring budget, the cost of an EOR, an own entity or contractors, and dated changes to employer contributions. They do not cover net pay, employee income tax, legal advice, job search or the fees a provider charges. Cost comparison, not legal or tax advice.',
    },
  );
  const stamp = `Data snapshot ${snapshot.snapshot_date}. Cost comparison, not legal or tax advice.`;
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  // every tool returns structuredContent (checked against its outputSchema by the SDK) and a text block
  const answer = (fn: () => { summary: string; meta: { disclaimer: string } }) => {
    try {
      const out = fn();
      const text = options.text === 'summary' ? `${out.summary} ${out.meta.disclaimer}` : JSON.stringify(out);
      return { structuredContent: out as unknown as Record<string, unknown>, content: [{ type: 'text' as const, text }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  };

  // a monthly salary is carried over to the render call as given
  const period = (a: { salary_period?: 'year' | 'month'; payments_per_year?: number }) =>
    a.salary_period === 'month' ? { salary_period: 'month' as const, ...(a.payments_per_year != null ? { payments_per_year: a.payments_per_year } : {}) } : {};
  // the render call that shows the same figures, with the arguments normalized (country as ISO code)
  const display = (tool: 'show_ledger' | 'show_compare', args: Record<string, unknown>) => ({
    tool,
    arguments: args,
    note: `${tool} renders ${tool === 'show_ledger' ? 'this breakdown' : 'these figures'} as an interactive table from these arguments.`,
  });

  server.registerTool(
    'list_countries',
    {
      title: "Countries covered",
      description: `Use this when the user asks which countries EOR Scope covers, or wants the countries of a region (Europe, Asia, Latin America...) with ISO code, currency, an example salary and the statutory employer cost at that salary. Do not use for the detailed cost of one country (use employer_cost). ${stamp}`,
      inputSchema: { region: z.string().optional().describe('Filter by region, e.g. "Europe", "Asia", "Latin America"') },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.list_countries,
    },
    (a) => answer(() => tools.listCountries(a)),
  );

  server.registerTool(
    'employer_cost',
    {
      title: "Employer cost of an employee in a country",
      description: `Use this when the user asks what an employee costs the employer in a country beyond the gross salary: employer social security contributions, payroll taxes, pension, health or accident insurance, mandatory levies, or the total cost of employment (e.g. "how much does it cost to employ a developer in Germany at 80k", "employer charges in Spain", "coût employeur d'un salarié en Pologne"). Returns each statutory employer contribution with its rate, base, ceiling, source (official wherever one exists) and check date, then the monthly and annual total and its percent of gross, before any Employer of Record fee. A total the country declares as a floor or a ceiling is written "at least" or "at most". A monthly salary is passed as the user gives it, with salary_period "month": the country's statutory 13th or 14th month is then applied (e.g. "a hire at 4,000 a month in Madrid", "un salarié payé 2 500 par mois à Lisbonne"). Do not use for an employee's net pay or income tax, for legal advice, or for the fees of a provider. Amounts given in the local currency come back in it, with the USD in brackets. ${stamp}`,
      inputSchema: {
        country,
        salary,
        salary_currency,
        salary_period,
        payments_per_year,
        assumptions,
        include_notes: z.boolean().default(false).describe('Include the long legal note behind each line'),
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.employer_cost,
    },
    (a) =>
      answer(() => {
        const out = tools.employerCost(a);
        const args = { country: out.country.iso, ...(a.salary != null ? { salary: a.salary } : {}), salary_currency: a.salary_currency, ...period(a), ...(a.assumptions ? { assumptions: a.assumptions } : {}) };
        return { ...out, widget: display('show_ledger', args) };
      }),
  );

  server.registerTool(
    'compare_countries',
    {
      title: "Employer cost of one salary in several countries",
      description: `Use this when the user wants the statutory employer cost of the same gross salary in 2 to 10 countries (e.g. "employer cost of 70k in Poland, Portugal and Spain", "combien coûte un salaire de 60 000 en Irlande et aux Pays-Bas"). Before any Employer of Record fee; rows come back in the order requested, not ranked. Do not use when each country has its own salary (use compare_offers). ${stamp}`,
      inputSchema: {
        countries: z.array(country).min(2).max(10),
        salary_usd: z.number().positive().max(1e12).describe('Gross salary in USD, a year unless salary_period is "month", applied to every country'),
        salary_period,
        payments_per_year,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.compare_countries,
    },
    (a) =>
      answer(() => {
        const out = tools.compareCountries(a);
        // show_compare takes 2 to 6 offers: beyond that, no render call is suggested
        return out.countries.length > 6 ? out : { ...out, widget: display('show_compare', { offers: out.countries.map((c) => ({ country: c.iso, salary: a.salary_usd, salary_currency: 'USD', ...period(a) })) }) };
      }),
  );

  const usdMonth = (what: string) => z.number().nonnegative().max(1e9).describe(`${what}, in USD per employee per month, as the user gives it`);

  server.registerTool(
    'max_salary_for_budget',
    {
      title: "Gross salary that fits a hiring budget",
      description: `Use this when the user has an all-in budget for a hire in a country and asks what gross salary it allows (e.g. "I have 100k a year for a hire in Germany, what salary can I offer?", "quel salaire brut pour un budget de 8 000 par mois en Espagne"). Returns the largest gross salary whose statutory employer cost (salary plus employer charges, plus an Employer of Record fee if the user gives one) stays within the budget, solved on the same ledger as employer_cost, so ceilings, floors, bands and fixed amounts are taken into account, and the monthly salary it stands for, paid the country's statutory number of times (13th, 14th month). Amounts given in the local currency come back in it, with the USD in brackets. Do not use for net pay. ${stamp}`,
      inputSchema: {
        country,
        budget: z.number().positive().max(1e12).describe('Total employer budget for one employee'),
        budget_currency: z.enum(['USD', 'local']).default('USD').describe('Currency of `budget`: USD, or the local currency of the country'),
        budget_period: z.enum(['year', 'month']).default('year').describe('Whether `budget` is per year or per month'),
        eor_fee_usd_month: usdMonth('An EOR fee to take out of the budget first').optional(),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.max_salary_for_budget,
    },
    (a) => answer(() => tools.maxSalaryForBudget(a)),
  );

  server.registerTool(
    'employment_terms',
    {
      title: "Statutory employment terms",
      description: `Use this when the user, hiring in a country, asks about statutory minimums: paid leave days, public holidays, maximum probation, notice period, 13th-month payment or other mandatory payments (e.g. "how many days of leave in Brazil", "is there a 13th month in Mexico"). Each term comes with its source and check date. Do not use for legal advice on a specific dismissal, contract dispute or visa. ${stamp}`,
      inputSchema: { country },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.employment_terms,
    },
    (a) => answer(() => tools.employmentTerms(a)),
  );

  server.registerTool(
    'reconcile_quote',
    {
      title: "Check an EOR or payroll quote",
      description: `Use this when the user shares a quote, offer, invoice or cost breakdown from an Employer of Record, PEO or payroll provider and asks whether it is fair, correct, overpriced or what it includes (e.g. "here is my EOR quote for Germany: salary 5,900, employer contributions 1,350, fee 560 a month, is it honest?", "voici le devis de mon EOR, est-il correct ?"). Checks the quote lines against the statutory ledger of the country at the same salary: expected and quoted amount per statutory line, statutory lines missing from a detailed quote, charges with no statutory counterpart, and the gap split into fee lines, charges above the statutory ledger and the salary-line difference (often an exchange-rate margin). When the quote gives employer charges as one total, that total is compared with the statutory total and the expected line-by-line breakdown is returned. A monthly quote in a country paying more than 12 monthly salaries a year (e.g. 14 in Spain) is read against one monthly payment, the extra payments being owed outside its lines. Amounts given in the local currency come back in it, with the USD in brackets. Pass the amounts as written on the quote; the provider's name is never needed. Do not use without figures from the user. ${stamp}`,
      inputSchema: {
        country,
        salary: z.number().positive().max(1e12).describe('Gross salary the quote is for, a year unless salary_period is "month"'),
        salary_currency,
        salary_period,
        payments_per_year,
        amounts_currency: z.enum(['USD', 'local']).default('USD').describe('Currency of the quote line amounts'),
        period: z.enum(['month', 'year']).default('month').describe('Whether the quote line amounts are per month or per year (one employee)'),
        lines: z
          .array(
            z.object({
              label: z.string().min(1).max(120).describe('The line as written on the quote'),
              amount: z.number().min(-1e12).max(1e12),
              type: z.enum(['salary', 'employer_charge', 'fee', 'other']).describe('salary; employer_charge (social security, pension, insurance, levy); fee (service, FX, onboarding, deposit); other'),
              statutory_id: z.string().max(60).optional().describe('Id of the statutory line it stands for, from employer_cost lines, when the label alone does not match'),
            }),
          )
          .min(1)
          .max(60),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.reconcile_quote,
    },
    (a) => answer(() => tools.reconcileQuote(a)),
  );

  server.registerTool(
    'compare_structures',
    {
      title: "EOR, own entity or contractor cost",
      description: `Use this when the user is deciding between hiring through an Employer of Record, setting up their own entity, or engaging contractors in a country and wants the cost of each over 1 to 5 years (e.g. "from how many employees should we open an entity in Poland instead of using an EOR?"). Uses the fees and entity costs the user enters plus the statutory employer charges, and gives the headcount at which entity costs and EOR fees cross. Costs only: it does not say whether a contractor arrangement is lawful. ${stamp}`,
      inputSchema: {
        country,
        salary,
        salary_currency,
        salary_period,
        payments_per_year,
        headcount: z.number().int().min(1).max(50).default(1).describe('Number of employees'),
        years: z.number().int().min(1).max(5).default(3).describe('Horizon in years'),
        eor_fee_usd_month: usdMonth('The EOR fee the user has been quoted'),
        entity_setup_usd: z.number().nonnegative().max(5e7).default(0).describe('One-off entity set-up cost in USD, from the user'),
        entity_annual_usd: z.number().nonnegative().max(5e7).default(0).describe('Yearly entity running cost in USD (payroll, accounting, filings), from the user'),
        contractor_fee_usd_month: usdMonth('A contractor platform fee, if the user has one').optional(),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.compare_structures,
    },
    (a) => answer(() => tools.compareStructures(a)),
  );

  const offers = z
    .array(
      z.object({
        country,
        salary: z.number().positive().max(1e12).describe('Gross salary offered in this country, a year unless salary_period is "month"'),
        salary_currency,
        salary_period,
        payments_per_year,
      }),
    )
    .min(2)
    .max(6)
    .describe('One offer per country, 2 to 6 countries, each with its own salary');

  server.registerTool(
    'compare_offers',
    {
      title: "Employer cost of job offers in several countries",
      description: `Use this when the user has job offers or candidates in 2 to 6 countries, each with its own gross salary (in USD or the local currency), and wants the total employer cost of each (e.g. "candidate A in Poland at 240,000 PLN, candidate B in Portugal at 45k: what does each cost the company?"). A monthly offer is passed with salary_period "month", which applies each country's statutory 13th or 14th month (e.g. "un candidat à 3 000 par mois à Madrid et un autre à 60 000 par an à Dublin"). Returns salary plus statutory employer charges, before any Employer of Record fee, the difference and ratio of each total to the smallest one, and the contribution ceilings each salary reaches. Rows come back in the order given. Do not use when the salary is the same in every country (use compare_countries). ${stamp}`,
      inputSchema: { offers },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.compare_offers,
    },
    (a) =>
      answer(() => {
        const out = tools.compareOffers(a);
        return { ...out, widget: display('show_compare', { offers: a.offers.map((o, i) => ({ country: out.offers[i].iso, salary: o.salary, salary_currency: o.salary_currency, ...period(o) })) }) };
      }),
  );

  server.registerTool(
    'fx_stress',
    {
      title: "Exchange-rate stress test",
      description: `Use this when the user pays, or plans to pay, an employee in local currency and asks about exchange-rate risk or a USD budget (e.g. "what if the real moves 10%", "risque de change sur un salaire en pesos"). Returns the USD cost (gross salary plus statutory employer charges, before any Employer of Record fee) at the official exchange rate of the data snapshot, with its date and source, and if the local currency moves by 5, 10 or 20 percent either way; with a USD budget, the headroom in each case and the move at which the budget is reached. Do not use for currency conversion alone. ${stamp}`,
      inputSchema: {
        country,
        salary_local: z.number().positive().max(1e13).describe('Gross salary in the local currency of the country, a year unless salary_period is "month"'),
        salary_period,
        payments_per_year,
        budget_usd: z.number().positive().max(1e12).optional().describe('Annual budget in USD for salary plus employer charges, if the user has one'),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.fx_stress,
    },
    (a) => answer(() => tools.fxStress(a)),
  );

  server.registerTool(
    'contractor_rate_equivalent',
    {
      title: "Contractor rate equivalent to an employee",
      description: `Use this when the user asks what day or hour rate a contractor would need to cost the same as an employee in a country, or wants to set a contractor rate against the full cost of employment (e.g. "what daily rate equals an 80k employee in Germany?"). The employee's annual cost (gross salary plus statutory employer charges, plus an Employer of Record fee if the user gives one) is divided by working days, by default 260 weekdays minus the country's statutory paid leave and public holidays, both adjustable. Costs only: it does not say whether a contractor arrangement is lawful or how to classify a worker. ${stamp}`,
      inputSchema: {
        country,
        salary,
        salary_currency,
        salary_period,
        payments_per_year,
        paid_leave_days: z.number().min(0).max(100).optional().describe("Paid leave days a year. Omit to use the country's statutory minimum."),
        public_holidays: z.number().min(0).max(40).optional().describe('Public holidays falling on weekdays. Omit to use the number recorded for the country.'),
        working_days: z.number().positive().max(366).optional().describe('Working days a year, replacing the default calculation'),
        hours_per_day: z.number().positive().max(24).default(8).describe('Hours per working day'),
        eor_fee_usd_month: usdMonth('An EOR fee to add to the employee cost').optional(),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.contractor_rate_equivalent,
    },
    (a) => answer(() => tools.contractorRateEquivalent(a)),
  );

  server.registerTool(
    'scheduled_changes',
    {
      title: "Scheduled employer contribution changes",
      description: `Use this when the user asks what is changing in a country's statutory employer contributions: new rates, ceilings, floors or thresholds, their effective dates, or measures announced in a budget (e.g. "employer contribution changes in Ireland in 2027", "hausse des cotisations patronales en Allemagne l'an prochain"). Each change comes with its status (enacted, or announced in a budget and not yet enacted), whether the date is stated in the source or deduced from it, and the source with a word-for-word quote and its reading date. A country whose changes are not tracked yet is answered "not yet tracked", which does not mean that nothing is scheduled. ${stamp}`,
      inputSchema: { country },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.scheduled_changes,
    },
    (a) => answer(() => tools.scheduledChanges(a)),
  );

  server.registerTool(
    'cost_next_year',
    {
      title: "Employer cost at a future date",
      description: `Use this when the user budgets an employee for next year or a future date and asks how the statutory employer cost will move (e.g. "what will this hire in Brazil cost the employer in January 2027?"). Returns the cost today and at that date (by default 1 January of next year), at the same gross salary and exchange rate, applying only the enacted dated changes recorded for the country; changes announced in a budget come in a separate, flagged variant, and dates deduced from a source are flagged. A country whose changes are not tracked yet gets today's cost and "not yet tracked", never a projection. Amounts given in the local currency come back in it, with the USD in brackets. ${stamp}`,
      inputSchema: {
        country,
        salary,
        salary_currency,
        salary_period,
        payments_per_year,
        on_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Date of the projection, YYYY-MM-DD. Omit for 1 January of the year after the data snapshot.'),
        assumptions,
      },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.cost_next_year,
    },
    (a) => answer(() => tools.costNextYear(a)),
  );

  // Render tools: the same figures as the data tools, shown in a widget. Only they carry a UI resource,
  // and their text block is always the one-sentence summary.
  const render = (fn: () => { summary: string; meta: { disclaimer: string } }) => {
    const r = answer(fn);
    return r.isError ? r : { ...r, content: [{ type: 'text' as const, text: `${(r.structuredContent as { summary: string }).summary} ${(r.structuredContent as { meta: { disclaimer: string } }).meta.disclaimer}` }] };
  };
  const ui = (uri: string, invoking: string, invoked: string) => ({
    ui: { resourceUri: uri },
    'openai/outputTemplate': uri,
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
  });

  server.registerTool(
    'show_ledger',
    {
      title: "Show the employer cost ledger",
      description: `Use this when the user wants to see, display, keep, copy or export the line-by-line employer cost of one employee in a country as a table or card (e.g. "show me the breakdown", "display it as a table", "affiche le détail des cotisations patronales"). It computes the figures itself: call it directly, with no data tool first, or after employer_cost with the arguments employer_cost returns in \`widget\`. Displays the salary basis (a monthly salary times the statutory number of payments), one row per statutory line with its rate, base, floor or ceiling, source and check date, a monthly or annual view, a salary field to recalculate, and a CSV copy. Takes the same country, salary and assumptions as employer_cost. ${stamp}`,
      inputSchema: { country, salary, salary_currency, salary_period, payments_per_year, assumptions },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.show_ledger,
      _meta: ui(LEDGER_URI, 'Building the ledger…', 'Ledger ready'),
    },
    (a) => render(() => tools.showLedger(a)),
  );

  server.registerTool(
    'show_compare',
    {
      title: "Show the job offer comparison",
      description: `Use this when the user wants the employer cost of job offers or salaries in 2 to 6 countries shown or displayed as a table they can read at a glance: for each country, the gross salary, statutory employer charges, total employer cost, difference and ratio to the smallest total, and contribution ceilings reached. It computes the figures itself: call it directly, with no data tool first, or after compare_offers or compare_countries with the arguments they return in \`widget\`. Inline up to 3 countries, full screen above. Takes the same offers as compare_offers. ${stamp}`,
      inputSchema: { offers },
      annotations: readOnly,
      outputSchema: OUTPUT_SCHEMAS.show_compare,
      _meta: ui(COMPARE_URI, 'Comparing the offers…', 'Comparison ready'),
    },
    (a) => render(() => tools.showCompare(a)),
  );

  const resource = (name: string, uri: string, html: string, description: string) =>
    server.registerResource(name, uri, { mimeType: WIDGET_MIME, description }, async () => ({
      contents: [
        {
          uri,
          mimeType: WIDGET_MIME,
          text: html,
          _meta: {
            // no network access at all: the widget only renders the tool result it is given
            ui: { prefersBorder: true, domain: origin, csp: { connectDomains: [], resourceDomains: [] } },
            'openai/widgetPrefersBorder': true,
            'openai/widgetDomain': origin,
            'openai/widgetDescription': description,
            'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
            // openExternal targets only (links to eorscope.com pages); not a fetch or resource origin
            'openai/widgetCSP': { connect_domains: [], resource_domains: [], redirect_domains: [SITE] },
          },
        },
      ],
    }));
  resource('ledger', LEDGER_URI, LEDGER_HTML, 'The statutory employer cost ledger of one employee, line by line, with sources and check dates.');
  resource('compare', COMPARE_URI, COMPARE_HTML, 'A table of the total employer cost of job offers in several countries.');

  return server;
}
