// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
/**
 * The arithmetic behind the decision instruments (components/calc/DecisionEngine.tsx), kept pure so
 * the eorscope-mcp package runs the very same code (copied by mcp/eorscope-mcp/scripts/sync.mjs).
 * Amounts are USD; per-employee figures are multiplied by the headcount here, never in the caller.
 */
import type { Plan, Vendor } from './cost-engine';

/** the cheapest plan of a scope; for contractors, the contractor-of-record plan when `cor` */
export const planOf = (v: Vendor | undefined, scope: Plan['scope'], cor?: boolean): Plan | null => {
  if (!v) return null;
  const list = v.plans.filter((p) => p.scope === scope && (scope !== 'contractor' || /of record/i.test(p.name) === Boolean(cor)));
  return list.sort((a, b) => (a.price_usd_month ?? Infinity) - (b.price_usd_month ?? Infinity))[0] ?? null;
};
/** a published monthly price, or null when the plan is quote-only */
export const priceOf = (p: Plan | null): number | null => (p && p.pricing_model !== 'quote' ? p.price_usd_month : null);

/** contractor vs contractor of record vs employee through an EOR, same gross pay, per month */
export function contractorRoute(i: { payMonthly: number; chargesMonthly: number; headcount: number; eorFee: number | null; ctrFee: number | null; corFee: number | null }) {
  const contractorMonthly = i.ctrFee != null ? (i.payMonthly + i.ctrFee) * i.headcount : null;
  const corMonthly = i.corFee != null ? (i.payMonthly + i.corFee) * i.headcount : null;
  const employeeMonthly = i.eorFee != null ? (i.payMonthly + i.chargesMonthly + i.eorFee) * i.headcount : null;
  const premium = contractorMonthly != null && employeeMonthly != null ? employeeMonthly - contractorMonthly : null;
  const feeGap = i.ctrFee != null && i.eorFee != null ? (i.eorFee - i.ctrFee) * i.headcount : null;
  return { contractorMonthly, corMonthly, employeeMonthly, premium, feeGap };
}

/** PEO fees vs EOR fees per month (fees only) */
export function peoRoute(i: { eorFee: number | null; peoFee: number | null; headcount: number }) {
  const eorMonthly = i.eorFee != null ? i.eorFee * i.headcount : null;
  const peoMonthly = i.peoFee != null ? i.peoFee * i.headcount : null;
  const gap = eorMonthly != null && peoMonthly != null ? eorMonthly - peoMonthly : null;
  return { eorMonthly, peoMonthly, gap };
}

/** cumulative EOR fees vs own-entity costs over 1-5 years; statutory charges are owed either way */
export function entityRoute(i: { eorFee: number | null; chargesMonthly: number; headcount: number; years: number; setupUsd: number; annualUsd: number }) {
  const { eorFee, headcount, years, setupUsd, annualUsd } = i;
  const feesPerYear = eorFee != null ? eorFee * 12 * headcount : null;
  const chargesPerYear = i.chargesMonthly * 12 * headcount;
  const entityTotal = setupUsd + annualUsd * years;
  const eorTotal = feesPerYear != null ? feesPerYear * years : null;
  const hasEntity = setupUsd > 0 || annualUsd > 0;
  const entityPerYear = setupUsd / years + annualUsd;
  // under half a dollar a year would print as "$0 of entity cost": ask for the quote instead
  const breakEvenHeads = eorFee != null && entityPerYear >= 0.5 ? entityPerYear / (eorFee * 12) : null;
  const rows = [1, 2, 3, 4, 5].map((y) => ({ y, eor: feesPerYear != null ? feesPerYear * y : null, entity: setupUsd + annualUsd * y }));
  return { feesPerYear, chargesPerYear, entityTotal, eorTotal, hasEntity, entityPerYear, breakEvenHeads, rows };
}
