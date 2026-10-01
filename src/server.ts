import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTools, type Snapshot } from './tools';

/** replaced at build time with the version in package.json */
declare const __VERSION__: string;

const country = z.string().min(2).max(60).describe('ISO 3166-1 alpha-2 code ("DE") or country name ("Germany")');
const salary = z.number().positive().max(1e12).optional().describe("Gross annual salary. Omit to use the country's example salary.");
const salary_currency = z.enum(['USD', 'local']).default('USD').describe('Currency of `salary`: USD, or the local currency of the country');
const assumptions = z
  .record(z.number())
  .optional()
  .describe('Override an adjustable assumption the country declares, e.g. {"basic_share_of_gross": 0.6}. See `assumptions` in an employer_cost answer.');

export function createServer(snapshot: Snapshot) {
  const tools = createTools(snapshot);
  const server = new McpServer({ name: 'eorscope-mcp', version: __VERSION__ });
  const stamp = `Data snapshot ${snapshot.snapshot_date}. Cost comparison, not legal or tax advice.`;
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const answer = (fn: () => unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(fn()) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  };

  server.registerTool(
    'list_countries',
    {
      title: 'List countries',
      description: `Countries covered (${snapshot.countries.length}), with ISO code, currency, example salary and the statutory employer cost at that salary. ${stamp}`,
      inputSchema: { region: z.string().optional().describe('Filter by region, e.g. "Europe", "Asia", "Latin America"') },
      annotations: readOnly,
    },
    (a) => answer(() => tools.listCountries(a)),
  );

  server.registerTool(
    'employer_cost',
    {
      title: 'Statutory employer cost',
      description: `Statutory employer cost of one employee in a country, before any EOR fee: each employer contribution with its rate, base, ceiling, official source and check date, then the monthly and annual total and its percent of gross. A total the country declares as a floor or a ceiling is written "at least" or "at most". ${stamp}`,
      inputSchema: {
        country,
        salary,
        salary_currency,
        assumptions,
        include_notes: z.boolean().default(false).describe('Include the long legal note behind each line'),
      },
      annotations: readOnly,
    },
    (a) => answer(() => tools.employerCost(a)),
  );

  server.registerTool(
    'compare_countries',
    {
      title: 'Compare countries',
      description: `Statutory employer cost of the same gross salary in 2 to 10 countries, before any EOR fee. Rows come back in the order requested, not ranked. ${stamp}`,
      inputSchema: {
        countries: z.array(country).min(2).max(10),
        salary_usd: z.number().positive().max(1e12).describe('Gross annual salary in USD, applied to every country'),
      },
      annotations: readOnly,
    },
    (a) => answer(() => tools.compareCountries(a)),
  );

  server.registerTool(
    'provider_fees',
    {
      title: 'EOR provider fees',
      description: `Published Employer of Record fees per employee per month (${snapshot.vendors.length} providers), each with its pricing-page URL, the date it was read and the countries the provider does not cover. A provider that publishes no price is returned as "quote only". ${stamp}`,
      inputSchema: {
        provider: z.string().max(60).optional().describe('Provider name or id ("Deel", "remote"). Omit for every provider.'),
        country: country.optional().describe('Also say whether each provider covers this country'),
      },
      annotations: readOnly,
    },
    (a) => answer(() => tools.providerFees(a)),
  );

  server.registerTool(
    'total_hiring_cost',
    {
      title: 'Total cost through an EOR provider',
      description: `All-in cost of hiring in a country through one EOR provider: gross salary, statutory employer charges and the provider's published fee, per month and per year, for 1 to 50 employees. ${stamp}`,
      inputSchema: {
        country,
        provider: z.string().min(1).max(60).describe('Provider name or id ("Deel", "remote")'),
        salary,
        salary_currency,
        headcount: z.number().int().min(1).max(50).default(1).describe('Number of employees at this salary'),
        assumptions,
      },
      annotations: readOnly,
    },
    (a) => answer(() => tools.totalHiringCost(a)),
  );

  return server;
}
