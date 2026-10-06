// Copies synthetic fixtures from web/fixtures/data/ into web/public/data/,
// but ONLY for files that do not exist there yet. Never overwrites pipeline output.
// Usage: npm run fixtures
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'fixtures', 'data');
const dst = join(root, 'public', 'data');
mkdirSync(dst, { recursive: true });

for (const name of readdirSync(src)) {
  const target = join(dst, name);
  if (existsSync(target)) {
    console.log(`skip   ${name} (already present)`);
    continue;
  }
  copyFileSync(join(src, name), target);
  console.log(`copied ${name}`);
}
