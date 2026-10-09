// Builds the plugin-directory ZIP (OpenAI Plugins, Agent Plugins format) from submission/plugin/ and
// validates it against the final-submission rules of developers.openai.com/plugins/deploy/submission
// (read 2026-10-09). Uploads and submits nothing.
//   node scripts/package-submission.mjs [--out dir]   -> <dir>/eorscope-<version>.zip (default submission/dist)
// An empty review.demo_recording_url is left out of the ZIP (an empty string would clear the value typed
// in the dashboard): fill it in plugin.json, or type it in the dashboard, before submitting.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(pkg, 'submission', 'plugin');
export const CATEGORIES = ['Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics', 'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'];
/** listing URL on the MCP host -> the file under public/ that serves it */
export const PAGES = { supportURL: 'support.html', privacyPolicyURL: 'privacy.html', termsOfServiceURL: 'terms.html' };

const oneLine = (s) => typeof s === 'string' && s.trim() !== '' && !/[\r\n\t]/.test(s);
const len = (s) => [...s].length;
const https = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && s.length <= 1024;
  } catch {
    return false;
  }
};
const luminance = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** width and height of a PNG, or null */
const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);

/** every final-submission rule the package can be checked against offline; returns a list of errors */
export function validate(manifest, mcp, root = PLUGIN_DIR, publicDir = join(pkg, 'public')) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') err('$schema must be the Agent Plugins schema');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(manifest.name ?? '')) err('name: ASCII letters, digits, _ and -, at most 64');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '') || manifest.version.length > 64) err('version: semantic version');
  if (manifest.description !== undefined && len(manifest.description) > 4000) err('description: at most 4000 characters');
  if (!oneLine(manifest.author?.name) || len(manifest.author.name) > 120) err('author.name: required, one line, at most 120');
  if (manifest.author?.url !== undefined && !https(manifest.author.url)) err('author.url: https');
  if (manifest.homepage !== undefined && !https(manifest.homepage)) err('homepage: https');
  const oa = manifest.extensions?.['com.openai'] ?? {};
  const ui = oa.interface ?? {};
  for (const [k, max] of [['displayName', 30], ['shortDescription', 30], ['developerName', 80]]) if (!oneLine(ui[k]) || len(ui[k]) > max) err(`interface.${k}: required, one line, at most ${max} characters`);
  if (typeof ui.longDescription !== 'string' || !ui.longDescription.trim() || len(ui.longDescription) > 4000) err('interface.longDescription: required, at most 4000 characters');
  if (!CATEGORIES.includes(ui.category)) err(`interface.category: one of ${CATEGORIES.join(', ')}`);
  const caps = ui.capabilities ?? [];
  if (!Array.isArray(caps) || caps.length > 20 || caps.some((c) => !oneLine(c) || len(c) > 120)) err('interface.capabilities: at most 20, one line, at most 120 characters each');
  const prompts = ui.defaultPrompt === undefined ? [] : [].concat(ui.defaultPrompt);
  if (prompts.length > 3 || prompts.some((p) => !oneLine(p) || len(p) > 128 || /(^|\s)@\S/.test(p))) err('interface.defaultPrompt: at most 3, one line, at most 128 characters, no @mention');
  if (new Set(prompts.map((p) => p.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase())).size !== prompts.length) err('interface.defaultPrompt: prompts must be unique');
  for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) if (!https(ui[k] ?? '')) err(`interface.${k}: required https URL, at most 1024 characters`);
  for (const [k, file] of Object.entries(PAGES)) {
    if (!existsSync(join(publicDir, file))) err(`interface.${k}: public/${file} is missing`);
    if (ui[k] && new URL(ui[k]).pathname !== `/${file}`) err(`interface.${k}: must point to /${file}`);
  }
  if (ui.brandColor !== undefined && (!/^#[0-9A-Fa-f]{6}$/.test(ui.brandColor) || contrast(ui.brandColor, '#FFFFFF') < 2)) err('interface.brandColor: #RRGGBB with at least 2:1 contrast against white');
  if (ui.brandColorDark !== undefined && (!/^#[0-9A-Fa-f]{6}$/.test(ui.brandColorDark) || contrast(ui.brandColorDark, '#212121') < 2)) err('interface.brandColorDark: #RRGGBB with at least 2:1 contrast against #212121');
  for (const k of ['logo', 'composerIcon', 'logoDark', 'composerIconDark']) {
    if (ui[k] === undefined) {
      if (k === 'logo' || k === 'composerIcon') err(`interface.${k}: required`);
      continue;
    }
    const p = String(ui[k]);
    if (!p.startsWith('./') || p.includes('..') || !existsSync(join(root, p))) {
      err(`interface.${k}: ./-relative path to an included file`);
      continue;
    }
    const buf = readFileSync(join(root, p));
    const size = pngSize(buf);
    if (!size) err(`interface.${k}: PNG expected`);
    else if (size[0] !== size[1] || size[0] < 48 || size[0] > 4096 || buf.length > 5 * 1024 * 1024) err(`interface.${k}: square, 48 to 4096 px, at most 5 MiB`);
  }
  const review = oa.review ?? {};
  const pos = review.test_cases?.positive ?? [];
  const neg = review.test_cases?.negative ?? [];
  if (pos.length !== 5) err('review.test_cases.positive: exactly 5 cases');
  if (neg.length !== 3) err('review.test_cases.negative: exactly 3 cases');
  pos.forEach((c, i) => {
    for (const k of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) if (typeof c[k] !== 'string' || !c[k].trim()) err(`review.test_cases.positive[${i}].${k}: required`);
    if (len(c.description ?? '') > 4000) err(`review.test_cases.positive[${i}].description: at most 4000 characters`);
  });
  neg.forEach((c, i) => {
    for (const k of ['description', 'prompt']) if (typeof c[k] !== 'string' || !c[k].trim()) err(`review.test_cases.negative[${i}].${k}: required`);
  });
  for (const k of ['test_credentials', 'reviewer_instructions']) if (k in review || k in oa) err(`${k}: not allowed in the package (dashboard only)`);
  if (review.demo_recording_url && !https(review.demo_recording_url)) err('review.demo_recording_url: https URL');
  if (typeof review.commerce !== 'boolean') err('review.commerce: boolean');
  const pub = oa.publication ?? {};
  if (!Array.isArray(pub.countries) || pub.countries.some((c) => !/^[A-Z]{2}$/.test(c))) err('publication.countries: array of uppercase ISO codes ([] = no restriction)');
  if (typeof pub.release_notes !== 'string' || !pub.release_notes.trim()) err('publication.release_notes: required');
  const servers = Object.values(mcp?.mcpServers ?? {});
  if (mcp?.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') err('mcp.json: $schema must be the Agent Plugins MCP schema');
  if (servers.length !== 1) err('mcp.json: exactly one MCP server (plugin-level test cases)');
  else if (servers[0].type !== 'streamable-http' || !https(servers[0].url ?? '')) err('mcp.json: streamable-http server on an https URL');
  return errors;
}

/** the facts the listing states, checked against the data the server ships */
export function factCheck(manifest, mcp) {
  const errors = [];
  const ui = manifest.extensions['com.openai'].interface;
  const snapshot = JSON.parse(readFileSync(join(pkg, 'data', 'snapshot.json'), 'utf8'));
  const n = snapshot.countries.length;
  const text = `${ui.longDescription}\n${manifest.extensions['com.openai'].publication.release_notes}`;
  for (const m of text.matchAll(/(\d+) countries/g)) if (Number(m[1]) !== n) errors.push(`listing says ${m[1]} countries, the snapshot has ${n}`);
  const server = JSON.parse(readFileSync(join(pkg, 'server.json'), 'utf8'));
  const url = Object.values(mcp.mcpServers)[0]?.url;
  if (!(server.remotes ?? []).some((r) => r.url === url)) errors.push(`mcp.json url ${url} is not a remote of server.json`);
  for (const k of Object.keys(PAGES)) if (new URL(ui[k]).origin !== new URL(url).origin) errors.push(`interface.${k} is not on the MCP host ${new URL(url).origin}`);
  return errors;
}

// ---- ZIP (stored/deflated, UTF-8 names, fixed timestamp for reproducible bytes) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 9;

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    head.copy(cen, 8, 6, 30);
    cen.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, deflated);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** reads a ZIP back: [{ name, data }], throws on a bad signature or CRC */
export function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
    const [method, crc, csize, nlen, xlen, clen, off] = [buf.readUInt16LE(p + 10), buf.readUInt32LE(p + 16), buf.readUInt32LE(p + 20), buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32), buf.readUInt32LE(p + 42)];
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** validates submission/plugin/ and writes the ZIP; returns { file, entries, warnings } or throws with every error */
export function packageSubmission(outDir = join(pkg, 'submission', 'dist')) {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(PLUGIN_DIR, 'mcp.json'), 'utf8'));
  const errors = [...validate(manifest, mcp), ...factCheck(manifest, mcp)];
  if (errors.length) throw new Error(`submission package invalid:\n- ${errors.join('\n- ')}`);
  const warnings = [];
  const review = manifest.extensions['com.openai'].review;
  if (!review.demo_recording_url) {
    delete review.demo_recording_url;
    warnings.push('review.demo_recording_url is empty: left out of the ZIP; required before "Submit for review" (plugin.json or dashboard)');
  }
  const ui = manifest.extensions['com.openai'].interface;
  const assets = [...new Set(['logo', 'composerIcon', 'logoDark', 'composerIconDark'].map((k) => ui[k]).filter(Boolean))].map((p) => p.slice(2));
  const entries = [
    { name: 'plugin.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: 'mcp.json', data: readFileSync(join(PLUGIN_DIR, 'mcp.json')) },
    ...assets.map((a) => ({ name: a, data: readFileSync(join(PLUGIN_DIR, a)) })),
  ];
  const buf = zip(entries);
  // read the archive back before handing it over
  const back = unzip(buf);
  if (back.length !== entries.length || back.some((e, i) => e.name !== entries[i].name || !e.data.equals(entries[i].data))) throw new Error('zip: read-back differs from the input');
  JSON.parse(back[0].data.toString('utf8'));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${manifest.name}-${manifest.version}.zip`);
  writeFileSync(file, buf);
  if (statSync(file).size > 100 * 1024 * 1024) throw new Error('zip: larger than 100 MB');
  return { file, entries: entries.map((e) => e.name), warnings };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf('--out');
  try {
    const { file, entries, warnings } = packageSubmission(i > 0 ? resolve(process.argv[i + 1]) : undefined);
    for (const w of warnings) console.warn(`warning: ${w}`);
    console.log(`package:submission OK -> ${file} (${entries.join(', ')})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
