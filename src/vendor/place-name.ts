// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
/** Country name as it reads inside a sentence: "the United Kingdom", "the Netherlands", "the Philippines". */
export function placeName(name: string): string {
  return /^(United Kingdom|Netherlands|Philippines|United States|United Arab Emirates|Czech Republic|Dominican Republic)$/.test(name) ? `the ${name}` : name;
}

/**
 * Country name for a <title>, where the 60-character budget binds. The long official form is
 * kept everywhere else; only the title uses the short one, and it is also the form the head
 * keyword and the slug use ("employer of record uae"). Add a row when a name overruns.
 */
const TITLE_NAME: Record<string, string> = { 'United Arab Emirates': 'UAE', 'United States': 'USA' };
export const titleName = (name: string): string => TITLE_NAME[name] ?? name;
