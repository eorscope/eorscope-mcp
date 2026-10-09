// Bundles the server with the site's own engine (src/vendor, brought in by scripts/sync.mjs).
// Reads nothing outside the package. The SDK and zod stay runtime dependencies.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(pkg, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: pkg,
  entryPoints: ['src/index.ts', 'src/tools.ts', 'src/http.ts', 'src/server.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  // no tsconfig of a parent folder may change the output
  tsconfigRaw: '{}',
  define: { __VERSION__: JSON.stringify(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version) },
  legalComments: 'none',
  // the bundle mixes two sets of terms: say so in the file itself
  banner: { js: '// eorscope-mcp. Server code: MIT. Bundled cost engine (src/vendor): Copyright EOR Scope, all rights reserved,\n// distributed with this package only, not to be extracted, modified or redistributed separately. See LICENSE.' },
  logLevel: 'info',
});
