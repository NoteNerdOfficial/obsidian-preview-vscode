import { DateTime, Duration } from 'luxon';
import moment from 'moment';
import type { HostMessage, LoadBaseResult, PreviewSettings } from '../shared/protocol';
import { parseBase } from './bases/parse';
import { renderBase } from './bases/render';
import { Bridge } from './bridge';
import { PageIndex } from './dataview/pages';
import { DataviewApi } from './dataview/api';
import { createApp } from './obsidian/app';
import { installDomShims } from './obsidian/dom';
import { renderMarkdown } from './render/markdown';
import { renderProperties, splitFrontmatter } from './render/frontmatter';
import { extractBlocks } from './render/blocks';
import { executeQuery, QueryResult } from './dql/engine';
import { dataArray, Link, stringifyValue } from './dataview/values';
import type { TaskValue } from './dataview/pages';

installDomShims();

const bridge = new Bridge();
const index = new PageIndex();
const loadedViewCss = new Set<string>();

let settings: PreviewSettings = {
  enableDataviewJs: true,
  dailyNoteFormat: 'yyyy-MM-dd',
  vaultName: 'vault'
};
let currentPath = '';
let documentText = '';
let indexReady = false;
let renderToken = 0;
/** 'base' when this panel is showing a standalone .base file, not a note. */
let mode: 'markdown' | 'base' = 'markdown';

// Obsidian exposes these as globals and vault scripts rely on them.
const w = window as unknown as Record<string, unknown>;
w.moment = moment;
w.DateTime = DateTime;
w.Duration = Duration;
w.luxon = { DateTime, Duration };

const app = createApp(index, bridge, () => currentPath, settings.vaultName);
w.app = app;

const root = document.getElementById('obsidian-preview-root') as HTMLElement;

bridge.onMessage((message: HostMessage) => {
  switch (message.type) {
    case 'init':
      settings = message.settings;
      currentPath = message.currentPath;
      mode = message.mode;
      root.classList.toggle('is-base-root', mode === 'base');
      break;

    case 'document':
      currentPath = message.path;
      documentText = message.text;
      scheduleRender();
      break;

    case 'index':
      index.upsert(message.pages);
      index.upsertFiles(message.files);
      if (message.complete) {
        indexReady = true;
        scheduleRender();
      }
      break;

    case 'indexDelta':
      index.upsert(message.changed);
      index.remove(message.removed);
      index.upsertFiles(message.changedFiles);
      index.removeFiles(message.removedFiles);
      scheduleRender();
      break;
  }
});

bridge.post({ type: 'ready' });

let renderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void render(), 40);
}

// ---------------------------------------------------------------------------
// Render pipeline
// ---------------------------------------------------------------------------

async function render(): Promise<void> {
  const token = ++renderToken;

  if (mode === 'base') {
    if (!indexReady) {
      root.innerHTML = '<div class="dataview-loading">Indexing vault…</div>';
      return;
    }
    renderStandaloneBase();
    return;
  }

  // Frontmatter becomes a properties panel; its lines are blanked (not
  // removed) so body line numbers still match the source document.
  const { data: frontmatter, body, raw: frontmatterRaw } = splitFrontmatter(documentText);
  const { markdown, blocks } = extractBlocks(body);

  root.innerHTML = renderMarkdown(markdown, {
    sourcePath: currentPath,
    resolve: (target, from) => index.resolvePath(target, from)
  });

  const properties = renderProperties(frontmatter, {
    sourcePath: currentPath,
    resolve: (target, from) => index.resolvePath(target, from),
    raw: frontmatterRaw
  });
  if (properties) root.insertBefore(properties, root.firstChild);

  if (!indexReady && blocks.length) {
    for (const block of blocks) {
      const slot = document.getElementById(block.placeholder);
      if (slot) slot.innerHTML = '<div class="dataview-loading">Indexing vault…</div>';
    }
    return;
  }

  for (const block of blocks) {
    if (token !== renderToken) return; // A newer render superseded this one.
    const slot = document.getElementById(block.placeholder);
    if (!slot) continue;
    if (block.lang === 'dataview') renderDql(block.code, slot);
    else if (block.lang === 'base') renderInlineBase(block.code, slot);
    else await runDataviewJs(block.code, slot);
  }

  await renderBaseEmbeds(token);
  await renderInlineQueries(token);
}

const baseOptions = () => ({
  index,
  currentPath,
  resolve: (target: string, from: string) => index.resolvePath(target, from),
  title: ''
});

/** ```base fenced blocks carry their definition inline. */
function renderInlineBase(source: string, container: HTMLElement): void {
  try {
    const definition = parseBase(source);
    container.appendChild(renderBase(definition, { ...baseOptions(), title: 'Base' }));
  } catch (err) {
    container.createEl('div', {
      cls: 'base-error',
      text: `Base: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

/** `![[Something.base]]` — fetch the .base file, then render it. */
async function renderBaseEmbeds(token: number): Promise<void> {
  const slots = [...root.querySelectorAll('.base-embed-slot')] as HTMLElement[];
  if (!slots.length) return;

  for (const slot of slots) {
    if (token !== renderToken) return;
    const target = slot.dataset.base ?? '';
    slot.textContent = '';

    try {
      const result = await bridge.request<LoadBaseResult>('loadBase', { path: target });
      if (token !== renderToken) return;
      const definition = parseBase(result.yaml);
      const title = result.path.slice(result.path.lastIndexOf('/') + 1).replace(/\.base$/, '');
      slot.appendChild(renderBase(definition, { ...baseOptions(), title }));
    } catch (err) {
      slot.createEl('div', {
        cls: 'base-error',
        text: `${target}: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
}

/**
 * A `.base` file opened directly (not embedded in a note) renders as the
 * whole panel — no markdown, no frontmatter, just the tabbed Bases view
 * against its own YAML.
 */
function renderStandaloneBase(): void {
  root.innerHTML = '';
  try {
    const definition = parseBase(documentText);
    const title = currentPath.slice(currentPath.lastIndexOf('/') + 1).replace(/\.base$/i, '');
    root.appendChild(renderBase(definition, { ...baseOptions(), title }));
  } catch (err) {
    root.createEl('div', {
      cls: 'base-error',
      text: `Failed to parse ${currentPath}: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

/**
 * Inline queries live in ordinary code spans:
 *   `= this.created`        inline DQL, evaluated against the current page
 *   `$= dv.pages().length`  inline JS, same sandbox as a dataviewjs block
 */
async function renderInlineQueries(token: number): Promise<void> {
  const spans = [...root.querySelectorAll('code')].filter((el) => {
    const text = el.textContent ?? '';
    return text.startsWith('=') || text.startsWith('$=');
  });
  if (!spans.length) return;

  const dv = new DataviewApi(
    { index, bridge, container: root, currentPath, loadedViewCss },
    app
  );

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  for (const span of spans) {
    if (token !== renderToken) return;
    const text = (span.textContent ?? '').trim();
    const isJs = text.startsWith('$=');
    const source = text.slice(isJs ? 2 : 1).trim();
    if (!source) continue;

    const out = document.createElement('span');
    out.className = 'dataview-inline-query';

    try {
      let value: unknown;
      if (isJs) {
        if (!settings.enableDataviewJs) throw new Error('DataviewJS is disabled');
        const fn = new AsyncFunction('dv', 'app', 'moment', 'luxon', 'DateTime', `return (${source});`);
        value = await fn(dv, app, moment, { DateTime, Duration }, DateTime);
      } else {
        value = dv.evaluate(source);
      }
      out.innerHTML = renderMarkdown(
        value instanceof Link ? value.markdown() : stringifyValue(value),
        { sourcePath: currentPath, resolve: (t, f) => index.resolvePath(t, f), inline: true }
      );
    } catch (err) {
      out.className = 'dataview-inline-error';
      out.textContent = err instanceof Error ? err.message : String(err);
    }

    span.replaceWith(out);
  }
}

function renderDql(source: string, container: HTMLElement): void {
  const dv = new DataviewApi(
    { index, bridge, container, currentPath, loadedViewCss },
    app
  );
  try {
    const result = executeQuery(source, index, dv.current());
    renderQueryResult(result, dv, container);
  } catch (err) {
    const div = container.createEl('div', { cls: 'dataview-error' });
    div.textContent = `Dataview: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderQueryResult(result: QueryResult, dv: DataviewApi, container: HTMLElement): void {
  switch (result.type) {
    case 'table':
      dv.table(result.headers, result.rows, { container });
      break;
    case 'list':
      // `LIST expr` renders "<link>: value" — build an element so the link
      // stays clickable instead of being flattened into text.
      dv.list(
        result.items.map((item) => {
          if (item.value === null || item.value === undefined) return item.primary;
          const span = document.createElement('span');
          span.innerHTML = renderMarkdown(
            `${stringifyValue(item.primary) && item.primary instanceof Link ? item.primary.markdown() : stringifyValue(item.primary)}: ${stringifyValue(item.value)}`,
            {
              sourcePath: currentPath,
              resolve: (t, f) => index.resolvePath(t, f),
              inline: true
            }
          );
          return span;
        }),
        { container }
      );
      break;
    case 'task':
      dv.taskList(result.tasks as TaskValue[], true, { container });
      break;
    case 'grouped':
      for (const group of result.groups) {
        const section = container.createEl('div', { cls: 'dataview-group' });
        const heading = section.createEl('h4', { cls: 'dataview-group-title' });
        heading.innerHTML = renderMarkdown(stringifyValue(group.key), {
          sourcePath: currentPath,
          resolve: (t, f) => index.resolvePath(t, f),
          inline: true
        });
        renderQueryResult(group.result, dv, section);
      }
      break;
  }
}

async function runDataviewJs(code: string, container: HTMLElement): Promise<void> {
  if (!settings.enableDataviewJs) {
    container.createEl('div', {
      cls: 'dataview-error',
      text: 'DataviewJS is disabled (obsidianPreview.enableDataviewJs).'
    });
    return;
  }

  const dv = new DataviewApi(
    { index, bridge, container, currentPath, loadedViewCss },
    app
  );

  // dataviewjs blocks are async by nature — they `await dv.view(...)` — which
  // is precisely what a synchronous markdown-it renderer rule cannot host.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  try {
    const fn = new AsyncFunction(
      'dv',
      'dataview',
      'app',
      'moment',
      'luxon',
      'DateTime',
      'Duration',
      'input',
      'this_',
      code
    );
    // `this` inside a dataviewjs block is the component; snippets use
    // `this.container`, so bind an object exposing it.
    await fn.call(
      { container, app, dv },
      dv,
      dv,
      app,
      moment,
      { DateTime, Duration },
      DateTime,
      Duration,
      undefined,
      dv.current()
    );
  } catch (err) {
    const div = container.createEl('div', { cls: 'dataview-error' });
    div.createEl('strong', { text: 'DataviewJS error: ' });
    div.appendText(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      const pre = div.createEl('pre', { cls: 'dataview-error-stack' });
      pre.textContent = err.stack.split('\n').slice(0, 6).join('\n');
    }
    bridge.log('error', err);
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const checkbox = target.closest('input.task-list-item-checkbox') as HTMLInputElement | null;
  if (checkbox) {
    event.preventDefault();
    const line = Number(checkbox.dataset.line ?? '-1');
    if (line < 0) return;
    // Toggling only makes sense against the note being previewed; tasks pulled
    // in from other files via a query are display-only for now.
    const path = checkbox.dataset.path;
    if (path && path !== currentPath) {
      bridge.log('warn', `Task in ${path} cannot be toggled from this preview yet.`);
      return;
    }
    const nowChecked = checkbox.dataset.status === ' ';
    bridge.post({ type: 'setTaskStatus', line, status: nowChecked ? 'x' : ' ' });
    return;
  }

  const link = target.closest('a[data-link]') as HTMLElement | null;
  if (link) {
    event.preventDefault();
    bridge.post({
      type: 'openLink',
      path: link.dataset.link ?? '',
      subpath: link.dataset.subpath,
      newTab: (event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey
    });
    return;
  }

  const embed = target.closest('.markdown-embed[data-path]') as HTMLElement | null;
  if (embed) {
    event.preventDefault();
    bridge.post({ type: 'openLink', path: embed.dataset.path ?? '' });
  }
});
