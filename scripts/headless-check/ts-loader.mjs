/**
 * Minimal Node ESM loader for the headless check: resolves the project's `@/`
 * alias, extensionless relative imports, and bare packages (three, …) against
 * the repo's node_modules, then transpiles .ts on the fly with the TypeScript
 * already installed in the repo.
 *
 * (The usual bundler path is out: node_modules holds the *Windows* esbuild
 * binary, and installing packages is forbidden by CLAUDE.md.)
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO, 'packages/web/src');

// Anchor bare-specifier resolution inside the repo so node_modules is found.
const ANCHOR = pathToFileURL(`${SRC}/main.ts`).href;

const require = createRequire(`${SRC}/main.ts`);
const ts = require('typescript');

function tryFiles(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not a file — try the next candidate */ }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = tryFiles(path.join(SRC, specifier.slice(2)));
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const target = tryFiles(path.resolve(parentDir, specifier));
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
    // Bare package — resolve it as if imported from inside the web package.
    return nextResolve(specifier, { ...context, parentURL: ANCHOR });
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
      fileName: url,
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
