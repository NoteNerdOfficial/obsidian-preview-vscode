/**
 * Print the rendered properties panel for a real note, so the output can be
 * eyeballed without launching VS Code.
 *
 *   npx tsx test/preview-frontmatter.ts /path/to/note.md
 */
import * as fs from 'node:fs';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['document', 'HTMLElement', 'Node', 'DocumentFragment', 'Element']) {
  (globalThis as Record<string, unknown>)[k] = (window as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).window = window;

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx test/preview-frontmatter.ts <note.md>');
  process.exit(1);
}

(async () => {
  const { installDomShims } = await import('../webview/obsidian/dom');
  installDomShims();
  const { splitFrontmatter, renderProperties } = await import('../webview/render/frontmatter');

  const text = fs.readFileSync(file, 'utf-8');
  const { data, body } = splitFrontmatter(text);
  const panel = renderProperties(data, { sourcePath: file, resolve: () => null, raw: text.slice(0, 300) });

  console.log('--- parsed keys ---');
  console.log(data ? Object.keys(data).join(', ') : '(none / invalid)');

  console.log('\n--- rendered rows (key -> text) ---');
  if (panel) {
    const rows = (panel as unknown as { querySelectorAll(s: string): unknown[] }).querySelectorAll('.prop-row');
    for (const row of rows as Array<{ querySelector(s: string): { textContent: string } | null }>) {
      const key = row.querySelector('.prop-key-name')?.textContent ?? '?';
      const value = row.querySelector('.prop-value')?.textContent ?? '';
      console.log(`  ${key.padEnd(14)} ${value.trim()}`);
    }
  } else {
    console.log('  (no panel)');
  }

  console.log('\n--- line alignment ---');
  console.log(`  source lines: ${text.split('\n').length}, body lines: ${body.split('\n').length}`);
})();
