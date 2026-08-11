/**
 * Runs every dataview / dataviewjs block found in a vault and reports what
 * parses, executes, and renders. Point it at a vault:
 *
 *   npx tsx test/run-vault.ts /path/to/vault
 */
import { parseHTML } from 'linkedom';
import { indexVault, extractBlocks } from './harness';

const root = process.argv[2];
if (!root) {
  console.error('usage: tsx test/run-vault.ts <vault-path>');
  process.exit(1);
}

// A DOM must exist before the webview modules are imported, since installing
// the Obsidian prototype shims touches HTMLElement at module load.
const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
for (const key of [
  'document',
  'HTMLElement',
  'Node',
  'DocumentFragment',
  'Element',
  'MouseEvent',
  'Event',
  'customElements'
]) {
  (globalThis as Record<string, unknown>)[key] = (window as Record<string, unknown>)[key];
}
(globalThis as Record<string, unknown>).window = window;

async function main() {
  const { installDomShims } = await import('../webview/obsidian/dom');
  const { PageIndex } = await import('../webview/dataview/pages');
  const { executeQuery } = await import('../webview/dql/engine');
  const { DataviewApi } = await import('../webview/dataview/api');
  const luxon = await import('luxon');
  const momentModule = await import('moment');
  const moment = (momentModule as unknown as { default: unknown }).default ?? momentModule;

  installDomShims();

  (globalThis as Record<string, unknown>).moment = moment;
  (globalThis as Record<string, unknown>).DateTime = luxon.DateTime;
  (window as Record<string, unknown>).moment = moment;

  console.log(`Indexing ${root} ...`);
  const pages = indexVault(root);
  const index = new PageIndex();
  index.upsert(pages);
  console.log(`  ${pages.length} notes indexed`);

  const totalTasks = pages.reduce((a, p) => a + p.tasks.length, 0);
  const totalLinks = pages.reduce((a, p) => a + p.outlinks.length, 0);
  const resolved = pages.reduce(
    (a, p) => a + p.outlinks.filter((l) => l.resolved).length,
    0
  );
  console.log(`  ${totalTasks} tasks, ${totalLinks} links (${resolved} resolved)`);

  const blocks = extractBlocks(root);
  const dql = blocks.filter((b) => b.lang === 'dataview');
  const js = blocks.filter((b) => b.lang === 'dataviewjs');

  // --- DQL ---------------------------------------------------------------
  console.log(`\n=== DQL: ${dql.length} blocks ===`);
  let dqlOk = 0;
  const dqlFail: Array<{ file: string; code: string; error: string }> = [];

  for (const block of dql) {
    const current = index.get(block.file) ?? null;
    try {
      const result = executeQuery(block.code, index, current);
      const count =
        result.type === 'table'
          ? result.rows.length
          : result.type === 'list'
            ? result.items.length
            : result.type === 'task'
              ? result.tasks.length
              : result.groups.length;
      dqlOk++;
      console.log(
        `  ok   ${String(count).padStart(4)} ${result.type.padEnd(7)} ${block.file}`
      );
    } catch (err) {
      dqlFail.push({
        file: block.file,
        code: block.code.trim(),
        error: err instanceof Error ? err.message : String(err)
      });
      console.log(`  FAIL          ${block.file}`);
    }
  }

  // --- DataviewJS --------------------------------------------------------
  console.log(`\n=== DataviewJS: ${js.length} blocks ===`);
  let jsOk = 0;
  const jsFail: Array<{ file: string; error: string }> = [];

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const stubBridge = {
    request: async (method: string, params: unknown) => {
      if (method === 'loadView') {
        const name = (params as { name: string }).name;
        const fs = await import('node:fs');
        const path = await import('node:path');
        for (const candidate of [`${name}/view.js`, `${name}.js`]) {
          const full = path.join(root, candidate);
          if (fs.existsSync(full)) {
            const cssPath = full.replace(/\.js$/, '.css');
            return {
              js: fs.readFileSync(full, 'utf-8'),
              css: fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf-8') : null,
              source: candidate
            };
          }
        }
        throw new Error(`no view.js for "${name}"`);
      }
      throw new Error(`stub: ${method}`);
    },
    post: () => {},
    log: () => {}
  };

  for (const block of js) {
    const container = window.document.createElement('div');
    const dv = new DataviewApi(
      {
        index,
        bridge: stubBridge as never,
        container: container as never,
        currentPath: block.file,
        loadedViewCss: new Set()
      },
      { vault: {}, workspace: {}, plugins: { plugins: {} }, metadataCache: {} }
    );

    try {
      const fn = new AsyncFunction(
        'dv',
        'app',
        'moment',
        'luxon',
        'DateTime',
        'Duration',
        'input',
        block.code
      );
      await fn.call(
        { container, dv },
        dv,
        { vault: {}, workspace: {}, plugins: { plugins: {} }, metadataCache: {} },
        moment,
        luxon,
        luxon.DateTime,
        luxon.Duration,
        undefined
      );
      const html = (container as unknown as { innerHTML: string }).innerHTML;
      jsOk++;
      console.log(`  ok   ${String(html.length).padStart(6)}b  ${block.file}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jsFail.push({ file: block.file, error: msg });
      console.log(`  FAIL            ${block.file}  — ${msg}`);
    }
  }

  // --- summary -----------------------------------------------------------
  console.log('\n=== summary ===');
  console.log(`DQL         ${dqlOk}/${dql.length}`);
  console.log(`DataviewJS  ${jsOk}/${js.length}`);

  if (dqlFail.length) {
    console.log('\n--- DQL failures ---');
    for (const f of dqlFail) {
      console.log(`\n${f.file}\n  ${f.error}\n  query: ${f.code.replace(/\n/g, '\n         ')}`);
    }
  }
  if (jsFail.length) {
    console.log('\n--- DataviewJS failures ---');
    for (const f of jsFail) console.log(`  ${f.file}: ${f.error}`);
  }

  process.exit(dqlFail.length || jsFail.length ? 1 : 0);
}

void main();
