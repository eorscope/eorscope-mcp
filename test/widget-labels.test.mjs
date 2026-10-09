// Short source labels in the ledger widget (09/10): the code is read from the HTML actually served, then run as the
// browser would run it. An acronym is shown only when the source name itself carries it; otherwise the domain.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEDGER_HTML } from '../src/widgets.ts';

const code = LEDGER_HTML.slice(LEDGER_HTML.indexOf('function shortSrc'), LEDGER_HTML.indexOf('function link('));
const shortSrc = new Function(`${code}; return shortSrc;`)();

test('ledger source label: acronym found in the source name, else the body name or the domain, never an invented acronym', () => {
  assert.equal(
    shortSrc({ name: "Employees' Provident Fund Organisation - FAQs on the revision of the EPFO statutory wage ceiling (Rs 15,000 to Rs 25,000, S.O. 5109(E))", url: 'https://www.epfindia.gov.in/x.pdf' }),
    'EPFO · S.O. 5109(E)',
  );
  assert.equal(shortSrc({ name: 'National Pension Service — Pension contributions: standard monthly income ceiling', url: 'https://www.nps.or.kr/x' }), 'National Pension Service');
  assert.equal(shortSrc({ name: 'Bundesministerium für Arbeit und Soziales — Sozialversicherungsrechengrößen 2026', url: 'https://www.bmas.de/x' }), 'bmas.de');
  assert.equal(shortSrc({ name: 'Revenue — PRSI Class A rates', url: 'https://www.revenue.ie/x' }), 'Revenue');
});
