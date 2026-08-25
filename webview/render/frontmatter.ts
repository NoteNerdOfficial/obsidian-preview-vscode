import * as yaml from 'js-yaml';
import { DateTime } from 'luxon';
import { renderMarkdown, escapeHtml } from './markdown';

export interface FrontmatterSplit {
  data: Record<string, unknown> | null;
  raw?: string;
  /**
   * Source with the frontmatter lines blanked out rather than removed, so
   * every downstream line number still matches the real document. Task
   * toggling depends on that alignment.
   */
  body: string;
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { data: null, body: text, raw: undefined };

  let data: Record<string, unknown> | null = null;
  try {
    const loaded = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    data =
      loaded && typeof loaded === 'object' && !Array.isArray(loaded)
        ? (loaded as Record<string, unknown>)
        : {};
  } catch {
    const consumed = match[0].replace(/\r?\n$/, '').split(/\r?\n/).length;
    const body = '\n'.repeat(consumed) + text.slice(match[0].length);
    return { data: null, body, raw: match[1] };
  }

  const consumed = match[0].replace(/\r?\n$/, '').split(/\r?\n/).length;
  const body = '\n'.repeat(consumed) + text.slice(match[0].length);

  return { data, body, raw: undefined };
}

export interface PropertyRenderOptions {
  sourcePath: string;
  resolve: (target: string, from: string) => string | null;
  /** Raw YAML, shown when parsing failed. */
  raw?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;
const WIKILINK = /^\[\[([^\]]+)\]\]$/;
const URL_RE = /^https?:\/\/\S+$/;

/** Keys Obsidian treats specially, rendered as chips rather than plain text. */
const CHIP_KEYS = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'cssclass']);

function valueType(key: string, value: unknown): string {
  if (CHIP_KEYS.has(key.toLowerCase())) return 'list';
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return 'date';
    if (WIKILINK.test(value)) return 'link';
    if (URL_RE.test(value)) return 'url';
  }
  return 'text';
}

const TYPE_GLYPH: Record<string, string> = {
  text: 'A',
  number: '#',
  date: '◷',
  checkbox: '✓',
  list: '≡',
  link: '↗',
  url: '↗',
  object: '{}',
  empty: '–'
};

function renderScalar(
  value: unknown,
  key: string,
  options: PropertyRenderOptions
): HTMLElement {
  const span = document.createElement('span');

  if (value === null || value === undefined || value === '') {
    span.className = 'prop-empty';
    span.textContent = '—';
    return span;
  }

  if (typeof value === 'boolean') {
    span.className = 'prop-bool';
    span.textContent = value ? '✓ true' : '✗ false';
    return span;
  }

  if (typeof value === 'number') {
    span.className = 'prop-number';
    span.textContent = String(value);
    return span;
  }

  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) {
      const dt = DateTime.fromISO(value.replace(' ', 'T'));
      if (dt.isValid) {
        span.className = 'prop-date';
        const hasTime = /[T ]\d{2}:\d{2}/.test(value);
        span.textContent = dt.toFormat(hasTime ? 'DDD, t' : 'DDD');
        span.title = value;
        return span;
      }
    }

    if (URL_RE.test(value)) {
      const a = document.createElement('a');
      a.href = value;
      a.className = 'external-link';
      a.textContent = value.replace(/^https?:\/\//, '');
      a.title = value;
      return wrap(a);
    }

    // Wikilinks, inline code, bold — render as markdown so they behave like
    // they do in the body of the note.
    span.innerHTML = renderMarkdown(value, {
      sourcePath: options.sourcePath,
      resolve: options.resolve,
      inline: true
    });
    return span;
  }

  if (typeof value === 'object') {
    const pre = document.createElement('code');
    pre.className = 'prop-object';
    try {
      pre.textContent = JSON.stringify(value);
    } catch {
      pre.textContent = String(value);
    }
    return wrap(pre);
  }

  span.textContent = String(value);
  return span;
}

function wrap(child: HTMLElement): HTMLElement {
  const span = document.createElement('span');
  span.appendChild(child);
  return span;
}

function renderChips(
  values: unknown[],
  key: string,
  options: PropertyRenderOptions
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'prop-chips';

  const isTagKey = key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag';

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;

    if (isTagKey && typeof value === 'string') {
      const tag = value.startsWith('#') ? value.slice(1) : value;
      const a = document.createElement('a');
      a.className = 'tag';
      a.href = '#';
      a.dataset.tag = tag;
      a.textContent = '#' + tag;
      wrapper.appendChild(a);
      continue;
    }

    const chip = document.createElement('span');
    chip.className = 'prop-chip';
    chip.appendChild(renderScalar(value, key, options));
    wrapper.appendChild(chip);
  }

  if (!wrapper.childNodes.length) {
    const empty = document.createElement('span');
    empty.className = 'prop-empty';
    empty.textContent = '—';
    return empty;
  }

  return wrapper;
}

/**
 * Render frontmatter as a properties panel, the way Obsidian's reading view
 * does — rather than letting markdown-it turn `---` into horizontal rules and
 * the YAML into a stray paragraph.
 */
export function renderProperties(
  data: Record<string, unknown> | null,
  options: PropertyRenderOptions
): HTMLElement | null {
  if (data === null) {
    if (!options.raw) return null;
    const panel = document.createElement('div');
    panel.className = 'frontmatter-properties is-invalid';
    const title = document.createElement('div');
    title.className = 'prop-error';
    title.textContent = 'Invalid YAML frontmatter';
    const pre = document.createElement('pre');
    pre.textContent = options.raw;
    panel.append(title, pre);
    return panel;
  }

  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  const details = document.createElement('details');
  details.className = 'frontmatter-properties';
  details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'prop-summary';
  const label = document.createElement('span');
  label.className = 'prop-summary-label';
  label.textContent = 'Properties';
  const count = document.createElement('span');
  count.className = 'prop-summary-count';
  count.textContent = String(entries.length);
  summary.append(label, count);
  details.appendChild(summary);

  const table = document.createElement('div');
  table.className = 'prop-table';

  for (const [key, value] of entries) {
    const row = document.createElement('div');
    row.className = 'prop-row';

    const keyCell = document.createElement('div');
    keyCell.className = 'prop-key';

    const type = valueType(key, value);
    const glyph = document.createElement('span');
    glyph.className = 'prop-glyph';
    glyph.textContent = TYPE_GLYPH[type] ?? 'A';
    glyph.setAttribute('aria-hidden', 'true');

    const keyName = document.createElement('span');
    keyName.className = 'prop-key-name';
    keyName.textContent = key;
    keyName.title = key;

    keyCell.append(glyph, keyName);

    const valueCell = document.createElement('div');
    valueCell.className = 'prop-value';

    if (Array.isArray(value) || CHIP_KEYS.has(key.toLowerCase())) {
      const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      valueCell.appendChild(renderChips(list, key, options));
    } else {
      valueCell.appendChild(renderScalar(value, key, options));
    }

    row.append(keyCell, valueCell);
    table.appendChild(row);
  }

  details.appendChild(table);
  return details;
}

export { escapeHtml };
