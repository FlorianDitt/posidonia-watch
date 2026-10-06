// Vite plugin: emit THIRD_PARTY_LICENSES.txt next to the site, listing every npm package
// that ends up in the client bundle together with its licence text. The minifier strips
// licence comments, so this is what keeps BSD/Apache notices with the shipped code.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILE = 'THIRD_PARTY_LICENSES.txt';

/** Directory of the package that contains a resolved module path, or null outside node_modules. */
function packageDir(id) {
  const path = id.replace(/^\0/, '').split('?')[0];
  const i = path.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = path.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return join(path.slice(0, i), 'node_modules', name);
}

/** Licence text plus any NOTICE file (Apache-2.0 §4(d) requires passing NOTICE on). */
function licenceText(dir) {
  const files = readdirSync(dir);
  const read = (re) => {
    const file = files.find((f) => re.test(f));
    return file ? readFileSync(join(dir, file), 'utf8').trim() : null;
  };
  const licence = read(/^(licen[cs]e|copying)(\.|$)/i);
  const notice = read(/^notice(\.|$)/i);
  return [notice && `NOTICE:\n\n${notice}`, licence].filter(Boolean).join('\n\n') || null;
}

export default function thirdPartyLicenses() {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (this.environment?.name !== 'client') return;
      const dirs = new Set();
      for (const chunk of Object.values(bundle)) {
        for (const id of chunk.type === 'chunk' ? chunk.moduleIds : []) {
          const dir = packageDir(id);
          if (dir && existsSync(join(dir, 'package.json'))) dirs.add(dir);
        }
      }
      const pkgs = [...dirs]
        .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
        .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
      const sections = pkgs.map(({ dir, pkg }) => {
        const head = `${pkg.name} ${pkg.version} – ${pkg.license ?? 'see licence text'}`;
        const text = licenceText(dir) ?? `No licence file shipped; see ${pkg.homepage ?? dirname(dir)}.`;
        return `${head}\n${'-'.repeat(head.length)}\n\n${text}\n`;
      });
      this.emitFile({
        type: 'asset',
        fileName: FILE,
        source:
          'posidonia-watch includes the following third-party software in the code delivered to your browser.\n\n' +
          sections.join('\n\n'),
      });
    },
  };
}
