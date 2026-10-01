# eorscope-mcp

A Model Context Protocol server (stdio) that answers two questions about hiring abroad through an Employer of Record (EOR):

- what an employer pays on top of a gross salary in a given country (statutory employer contributions, line by line, each with its official source and the date it was read);
- what EOR providers publish as their fee per employee per month, with the pricing-page URL and the date it was read.

It runs the same engine and the same data as the [EOR Scope calculator](https://eorscope.com/eor-cost-calculator/): 76 countries and 14 providers in the snapshot of 2026-10-01. The data ships inside the package; the server makes no network call.

Cost comparison, not legal or tax advice.

## Install

Node 18 or later.

Claude Code:

```bash
claude mcp add eorscope -- npx -y eorscope-mcp
```

Claude Desktop, or any client that reads an `mcpServers` block:

```json
{
  "mcpServers": {
    "eorscope": {
      "command": "npx",
      "args": ["-y", "eorscope-mcp"]
    }
  }
}
```

## Tools

Every answer is JSON and ends with a `meta` block: the snapshot date, the URL of the matching page on the site, the URL of the methodology page, the disclaimer and the data licence. The examples below are real outputs of the 2026-10-01 snapshot, shortened where marked `…`; `meta` is left out.

Figures come as text (`"at least $156"`) and as numbers under `values`, next to a `bound` field. When a country's total is declared as a floor or a ceiling, the words "at least" or "at most" are part of the figure: keep them when you quote it.

### `list_countries`

Optional `region`. Alphabetical order.

```json
{
  "count": 6,
  "countries": [
    { "iso": "IL", "name": "Israel", "slug": "israel", "region": "Middle East", "currency": "ILS", "example_salary_usd": 75000, "employer_cost_at_example": "at least 15.4%" },
    { "iso": "JO", "name": "Jordan", "slug": "jordan", "region": "Middle East", "currency": "JOD", "example_salary_usd": 24000, "employer_cost_at_example": "14.3%" },
    …
  ]
}
```

### `employer_cost`

`country` (ISO code or name), optional `salary` with `salary_currency` (`USD` or `local`), optional `assumptions`, optional `include_notes`. Without a salary, the country's example salary is used. `{"country": "India"}` returns the figure printed on the [India page](https://eorscope.com/employer-of-record/india/):

```json
{
  "summary": "One employee in India at $30,000 gross a year costs about $154 a month in statutory employer charges (+6.2% of gross), before any EOR fee.",
  "salary": {
    "annual_usd": 30000,
    "annual_local": "INR 2,876,322",
    "is_country_example": "example salary (software engineer), not a median",
    "fx": { "local_per_usd": 95.8774, "date": "2026-09-18", "source": "European Central Bank — euro foreign exchange reference rates" }
  },
  "employer_cost": {
    "pct_of_gross": "6.2%",
    "monthly": "$154",
    "annual": "$1,850",
    "values": { "bound": null, "pct_of_gross": 6.1659, "monthly_usd": 154.15, "annual_usd": 1849.77 }
  },
  "lines": [
    {
      "id": "epf_employer",
      "name": "EPF employer contribution (Employees' Provident Fund)",
      "type": "contribution",
      "rate": 0.0367,
      "rate_printed": "3.67%",
      "base": "basic",
      "base_cap_annual_local": 300000,
      "currency": "INR",
      "capped": true,
      "annual_usd": 114.83,
      "monthly_usd": 9.57,
      "applies": "Applies to basic wage plus dearness allowance, capped at the statutory wage ceiling of Rs 25,000/month (in force since 17 September 2026)",
      "source": {
        "name": "Employees' Provident Fund Organisation - FAQs on the revision of the EPFO statutory wage ceiling (Rs 15,000 to Rs 25,000, S.O. 5109(E))",
        "url": "https://pmvbry-cdn.epfindia.gov.in/wp-content/uploads/2026/09/EPFO_Wage_Ceiling_FAQs.pdf",
        "checked_at": "2026-09-26"
      }
    },
    …
  ],
  "assumptions": [{ "id": "basic_share_of_gross", "label": "Basic wage as a share of gross", "value": 0.5 }]
}
```

### `compare_countries`

`countries` (2 to 10) and `salary_usd`. Rows come back in the order requested, not ranked. `{"countries": ["DE", "PL", "AE"], "salary_usd": 80000}`:

```json
{
  "salary_annual_usd": 80000,
  "countries": [
    { "iso": "DE", "name": "Germany", "salary_local": "EUR 69,808", "employer_cost": { "pct_of_gross": "22.2%", "monthly": "$1,483", "annual": "$17,793", … } },
    { "iso": "PL", "name": "Poland", "salary_local": "PLN 304,607", "employer_cost": { "pct_of_gross": "19.8%", "monthly": "$1,320", "annual": "$15,844", … } },
    { "iso": "AE", "name": "United Arab Emirates", "salary_local": "AED 293,800", "employer_cost": { "pct_of_gross": "at least 2.9%", "monthly": "at least $192", "annual": "at least $2,301", … } }
  ]
}
```

### `provider_fees`

Optional `provider`, optional `country` (adds whether each provider covers it). A provider that publishes no price is returned as `"quote only"`, never as a zero. Two of the 14 rows:

```json
{
  "providers": [
    {
      "id": "remote",
      "name": "Remote",
      "eor": {
        "plan": "Employer of Record",
        "pricing_model": "list",
        "fee_per_month": "$699",
        "fee_usd_month": 699,
        "billing": "monthly",
        "deposit_policy": "No deposit: 'We collect reserve payments in rare, high risk circumstances' (pricing FAQ).",
        "source": { "name": "Remote — Pricing", "url": "https://remote.com/pricing", "checked_at": "2026-09-02" }
      },
      "countries_excluded": [{ "iso": "MM", "name": "Myanmar" }],
      "last_reviewed": "2026-09-02"
    },
    {
      "id": "rippling",
      "name": "Rippling",
      "eor": {
        "plan": "Global Employer of Record",
        "pricing_model": "quote",
        "fee_per_month": "quote only",
        "billing": "unknown",
        "deposit_policy": "Not stated on the pricing page",
        "source": { "name": "Rippling — Pricing", "url": "https://www.rippling.com/pricing", "checked_at": "2026-09-24" }
      },
      "countries_excluded": [{ "iso": "MM", "name": "Myanmar" }],
      "last_reviewed": "2026-09-24"
    },
    …
  ]
}
```

### `total_hiring_cost`

`country`, `provider`, optional `salary` / `salary_currency`, optional `headcount` (1 to 50). Gross salary, statutory employer charges and the provider's published fee. `{"country": "MX", "provider": "remote", "salary": 50000, "headcount": 2}`:

```json
{
  "summary": "2 employees in Mexico at $50,000 gross a year through Remote: $12,189 a month all-in (gross salary, statutory employer charges and the EOR fee, $699 per employee).",
  "headcount": 2,
  "employer_cost_per_employee": { "pct_of_gross": "29.5%", "monthly": "$1,229", "annual": "$14,748", … },
  "salary_plus_statutory": { "monthly": "$10,791", … },
  "provider": { "id": "remote", "name": "Remote", "available": true, "fee_per_month": "$699", "fee_usd_month": 699, … },
  "total": {
    "monthly": "$12,189",
    "annual": "$146,272",
    "values": { "bound": null, "monthly_usd": 12189.31, "annual_usd": 146271.71, "fee_share_pct": 11.4691 }
  }
}
```

With a quote-only provider, `total.monthly` is `"quote only"` and no total is computed. With a provider that does not cover the country, it is `"not available"`.

## Sources and method

- Employer contributions: the tax and social-security administrations and the legislation of each country. Each line carries its source URL and the date it was read; a line that rests on a secondary source says so in its note (`include_notes`).
- Provider fees: each provider's own pricing page, with the date it was read. "from" is the provider's published starting price.
- Exchange rates: ECB reference rates; the issuing central bank's parity for currencies pegged to the dollar; the European Commission's monthly accounting rate for the rest. The rate, its date and its source are in every answer.
- Calculation: each contribution on its own base (gross, basic wage, fixed amount or a band of gross), floored and capped as the law writes it and skipped where a salary threshold excludes it, plus the recurring statutory extras the country counts in its total. Employee-side deductions and income tax are not modelled.

The full method, its known limits and the list of sources are on the [methodology page](https://eorscope.com/methodology/).

The numbers are an illustrative model of statutory charges and published list prices. Confirm every figure with the provider and a qualified local adviser before hiring.

## Development

```bash
npm ci
npm run build   # bundles src/ into dist/
npm test        # the built package against the site's published dataset, country by country, then over stdio
```

The engine is the site's own, not a rewrite, and it is not under the MIT terms of the rest of the code (see Licence). `src/vendor/` (engine and formatters), `data/snapshot.json` and `test/fixtures/country_summary.csv` are copied from the site's repository by `npm run sync`; do not edit them here. `sync` only has something to do inside that repository. In a checkout of this package alone it says so and changes nothing.

## Licence

Three parts, three sets of terms, all in `LICENSE`:

- Server code (`src/` outside `src/vendor/`, `scripts/`, tests, documentation): MIT.
- Cost engine (`src/vendor/`, and its bundled form in `dist/`): Copyright EOR Scope, all rights reserved. It is distributed with this package only: you may run it as part of eorscope-mcp, not extract, modify or redistribute it separately.
- Data (`data/snapshot.json`, `test/fixtures/`): CC BY 4.0, attribution "EOR Scope, eorscope.com". Terms in `LICENSE-DATA`.

Published by [EOR Scope](https://eorscope.com/).
