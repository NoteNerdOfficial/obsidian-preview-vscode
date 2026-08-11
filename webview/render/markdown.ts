import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';

export interface RenderOptions {
  /** Vault-relative path of the note being rendered, for link resolution. */
  sourcePath: string;
  resolve: (target: string, from: string) => string | null;
  /** True while rendering a table cell, where block markup is not wanted. */
  inline?: boolean;
}

let md: MarkdownIt | null = null;

function build(): MarkdownIt {
  const instance = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false
  });

  instance.inline.ruler.before('link', 'wikilink', wikilinkRule);
  instance.inline.ruler.before('text', 'tag', tagRule);
  instance.inline.ruler.after('emphasis', 'highlight', highlightRule);
  instance.core.ruler.push('task_checkbox', taskCheckboxRule);

  return instance;
}

/** `[[Target|Display]]` and `![[Embed]]`. */
function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;

  const embed = src.charCodeAt(start) === 0x21; /* ! */
  const open = embed ? start + 1 : start;
  if (src.charCodeAt(open) !== 0x5b || src.charCodeAt(open + 1) !== 0x5b) return false;

  const close = src.indexOf(']]', open + 2);
  if (close < 0) return false;

  const inner = src.slice(open + 2, close);
  if (!inner.trim() || inner.includes('\n')) return false;

  if (!silent) {
    const [targetPart, displayPart] = splitOnce(inner, '|');
    const [path, subpath] = splitOnce(targetPart, '#');

    const token = state.push('wikilink', '', 0);
    token.meta = {
      path: path.trim(),
      subpath: subpath?.trim(),
      display: displayPart?.trim(),
      embed
    };
  }

  state.pos = close + 2;
  return true;
}

/** `#tag`, rendered as a chip rather than left as literal text. */
function tagRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x23 /* # */) return false;

  // Must be at a boundary, so `https://x.com/#frag` is not a tag.
  if (start > 0) {
    const prev = state.src[start - 1];
    if (!/[\s(\[{'"]/.test(prev)) return false;
  }

  const match = state.src.slice(start).match(/^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u);
  if (!match) return false;

  if (!silent) {
    const token = state.push('tag', '', 0);
    token.content = match[1];
  }
  state.pos = start + match[0].length;
  return true;
}

/** `==highlight==` */
function highlightRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== '==') return false;
  const close = state.src.indexOf('==', start + 2);
  if (close < 0) return false;

  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const text = state.push('text', '', 0);
    text.content = state.src.slice(start + 2, close);
    state.push('mark_close', 'mark', -1);
  }
  state.pos = close + 2;
  return true;
}

/**
 * Turn `- [ ] text` list items into real checkboxes carrying their source line,
 * which is what makes toggling from the preview possible.
 */
function taskCheckboxRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue;
    const inline = tokens[i];
    const match = inline.content.match(/^\[(.)\]\s+/);
    if (!match) continue;

    // Only inside a list item paragraph.
    const open = tokens[i - 2];
    if (!open || open.type !== 'list_item_open') continue;

    const line = open.map ? open.map[0] : -1;
    const status = match[1];

    inline.content = inline.content.slice(match[0].length);
    if (inline.children && inline.children.length) {
      const first = inline.children[0];
      if (first.type === 'text') first.content = first.content.replace(/^\[(.)\]\s+/, '');
    }

    const checkbox = new state.Token('task_checkbox', '', 0);
    checkbox.meta = { status, line };
    inline.children = [checkbox, ...(inline.children ?? [])];

    open.attrJoin('class', status === ' ' ? 'task-list-item' : 'task-list-item is-checked');
    if (line >= 0) open.attrSet('data-line', String(line));
  }
}

function splitOnce(text: string, sep: string): [string, string | undefined] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, undefined] : [text.slice(0, i), text.slice(i + 1)];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdown(source: string, options: RenderOptions): string {
  if (!md) md = build();

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { path, subpath, display, embed } = tokens[idx].meta as {
      path: string;
      subpath?: string;
      display?: string;
      embed: boolean;
    };
    const resolved = options.resolve(path, options.sourcePath);
    const label = display ?? (subpath && !path ? subpath : path);
    const cls = resolved ? 'internal-link' : 'internal-link is-unresolved';

    if (embed) {
      // An embedded base gets a slot that the render pipeline fills in
      // asynchronously, since the .base file has to be fetched from the host.
      if (/\.base$/i.test(path)) {
        return `<div class="base-embed-slot" data-base="${escapeHtml(path)}"></div>`;
      }
      // Image embeds render inline; note embeds get a placeholder rather than
      // recursing, which would be unbounded on cyclic vaults.
      if (/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(path)) {
        return `<span class="internal-embed image-embed">${escapeHtml(path)}</span>`;
      }
      return `<div class="internal-embed markdown-embed" data-path="${escapeHtml(
        resolved ?? path
      )}"><span class="embed-title">${escapeHtml(label)}</span></div>`;
    }

    return (
      `<a class="${cls}" href="#" data-link="${escapeHtml(path)}"` +
      (subpath ? ` data-subpath="${escapeHtml(subpath)}"` : '') +
      `>${escapeHtml(label)}</a>`
    );
  };

  md.renderer.rules.tag = (tokens, idx) =>
    `<a class="tag" href="#" data-tag="${escapeHtml(tokens[idx].content)}">#${escapeHtml(
      tokens[idx].content
    )}</a>`;

  md.renderer.rules.task_checkbox = (tokens, idx) => {
    const { status, line } = tokens[idx].meta as { status: string; line: number };
    const checked = status !== ' ' ? ' checked' : '';
    return (
      `<input class="task-list-item-checkbox" type="checkbox"` +
      `${checked} data-line="${line}" data-status="${escapeHtml(status)}">`
    );
  };

  return options.inline ? md.renderInline(source) : md.render(source);
}
