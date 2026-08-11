/**
 * Render a .base against a real vault, headlessly.
 *
 *   npx tsx test/preview-base.ts <vault> <file.base> [currentNote.md]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['document', 'HTMLElement', 'Node', 'DocumentFragment', 'Element', 'Event']) {
  (globalThis as Record<string, unknown>)[k] = (window as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).window = window;

const [vault, baseFile, currentNote = 'Dashboard.md'] = process.argv.slice(2);
if (!vault || !baseFile) {
  console.error('usage: tsx test/preview-base.ts <vault> <file.base> [currentNote.md]');
  process.exit(1);
}

(async () => {
  const { installDomShims } = await import('../webview/obsidian/dom');
  installDomShims();
  const { indexVault } = await import('./harness');
  const { PageIndex } = await import('../webview/dataview/pages');
  const { parseBase } = await import('../webview/bases/parse');
  const { renderBase } = await import('../webview/bases/render');

  const index = new PageIndex();
  index.upsert(indexVault(vault));

  const yamlText = fs.readFileSync(path.isAbsolute(baseFile) ? baseFile : path.join(vault, baseFile), 'utf-8');
  const definition = parseBase(yamlText);

  console.log(`views:    ${definition.views.map((v) => `${v.name} (${v.type})`).join(', ')}`);
  console.log(`formulas: ${[...definition.formulas.keys()].join(', ') || '(none)'}`);
  console.log(`errors:   ${definition.errors.length ? definition.errors.join('; ') : 'none'}`);

  const el = renderBase(definition, {
    index,
    currentPath: currentNote,
    resolve: (t, f) => index.resolvePath(t, f),
    title: path.basename(baseFile, '.base')
  });

  const q = el as unknown as {
    querySelectorAll(s: string): unknown[];
    querySelector(s: string): { textContent: string } | null;
  };

  // renderBase shows the first view; drive each tab to exercise them all.
  const tabs = q.querySelectorAll('.base-tab') as Array<{
    textContent: string;
    dispatchEvent(e: unknown): void;
    click?: () => void;
  }>;

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i] as unknown as { textContent: string; click?: () => void };
    if (typeof tab.click === 'function') tab.click();
    const view = definition.views[i];
    const count = q.querySelector('.base-count')?.textContent ?? '?';
    console.log(`\n--- view "${view.name}" (${view.type}) -> ${count} ---`);

    if (view.type === 'table') {
      const headers = (q.querySelectorAll('.base-table thead th') as Array<{ textContent: string }>).map(
        (th) => th.textContent
      );
      console.log('  ' + headers.join(' | '));
      const rows = q.querySelectorAll('.base-table tbody tr') as Array<{
        textContent: string;
        classList: { contains(c: string): boolean };
        querySelectorAll(s: string): Array<{ textContent: string }>;
      }>;
      for (const row of rows.slice(0, 8)) {
        if (row.classList.contains('base-group-row')) {
          console.log(`  ▸ ${row.textContent.trim()}`);
        } else {
          console.log('    ' + row.querySelectorAll('td').map((td) => td.textContent.trim()).join(' | '));
        }
      }
      if (rows.length > 8) console.log(`    … ${rows.length - 8} more rows`);
    } else if (view.type === 'cards') {
      const cards = q.querySelectorAll('.base-card') as Array<{ textContent: string }>;
      for (const card of cards.slice(0, 5)) {
        console.log('    ' + card.textContent.trim().replace(/\s+/g, ' ').slice(0, 90));
      }
      console.log(`    (${cards.length} cards)`);
    }
  }

  const errs = q.querySelectorAll('.base-error') as Array<{ textContent: string }>;
  if (errs.length) {
    console.log('\n--- errors ---');
    for (const e of errs) console.log('  ' + e.textContent);
  }
})();
