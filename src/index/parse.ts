import * as yaml from 'js-yaml';
import { DateTime } from 'luxon';
import type {
  RawLink,
  RawListItem,
  RawPage,
  RawSection,
  RawTask
} from '../../shared/protocol';

/** Regions of the document that must not be scanned for tags/links/tasks. */
interface Mask {
  ranges: Array<[number, number]>;
}

const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;

/**
 * Build a mask of fenced code blocks and inline code spans. Obsidian does not
 * index tags or links inside code, and the naive whole-body regex approach is
 * where most homegrown indexers produce phantom tags.
 */
function buildCodeMask(lines: string[]): Set<number> {
  const masked = new Set<number>();
  let fence: { marker: string; indent: number } | null = null;

  lines.forEach((line, i) => {
    const m = line.match(FENCE_RE);
    if (fence) {
      masked.add(i);
      if (m && m[2][0] === fence.marker[0] && m[2].length >= fence.marker.length && m[3].trim() === '') {
        fence = null;
      }
      return;
    }
    if (m) {
      fence = { marker: m[2], indent: m[1].length };
      masked.add(i);
    }
  });

  return masked;
}

function stripInlineCode(line: string): string {
  // Replace inline code spans with spaces so offsets stay stable.
  return line.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length));
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** Number of lines the frontmatter block occupies, including delimiters. */
  lineCount: number;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  // Tolerates CRLF, which a `^---\n([\s\S]*?)\n---` regex does not.
  const m = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, lineCount: 0 };
  try {
    const loaded = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
    const data =
      loaded && typeof loaded === 'object' && !Array.isArray(loaded)
        ? (loaded as Record<string, unknown>)
        : {};
    // Lines consumed by the block itself; the body starts at this index.
    return { data, lineCount: m[0].replace(/\r?\n$/, '').split(/\r?\n/).length };
  } catch {
    return { data: {}, lineCount: 0 };
  }
}

const TAG_RE = /(?:^|[\s(\[{'"])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/**
 * Extract tags from a line. Requires a boundary before '#' so that
 * `https://example.com/#section` and `#1` (a bare number) are not tags,
 * both of which are real false positives in ordinary notes.
 */
function extractTags(line: string, into: Set<string>): void {
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(line)) !== null) {
    into.add('#' + m[1]);
    TAG_RE.lastIndex = m.index + m[0].length - m[1].length;
  }
}

/** Obsidian exposes both `#a/b/c` and its parents `#a`, `#a/b` via file.tags. */
function expandTags(tags: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    out.add(tag);
    const parts = tag.slice(1).split('/');
    for (let i = 1; i < parts.length; i++) {
      out.add('#' + parts.slice(0, i).join('/'));
    }
  }
  return [...out];
}

const LINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

function parseLinkTarget(raw: string, embed: boolean): RawLink {
  let rest = raw;
  let display: string | undefined;

  const pipe = rest.indexOf('|');
  if (pipe >= 0) {
    display = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe);
  }

  let subpath: string | undefined;
  let type: RawLink['type'] = 'file';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    subpath = rest.slice(hash + 1).trim();
    type = subpath.startsWith('^') ? 'block' : 'header';
    rest = rest.slice(0, hash);
  }

  return {
    path: rest.trim(),
    raw: rest.trim(),
    display,
    subpath,
    type,
    embed,
    resolved: false
  };
}

function extractLinks(line: string, into: RawLink[]): void {
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(line)) !== null) {
    if (!m[2].trim()) continue;
    into.push(parseLinkTarget(m[2], m[1] === '!'));
  }
}

/**
 * Inline fields: `key:: value`, `[key:: value]`, `(key:: value)`.
 * Rare in practice but cheap to support, and snippets that use them break
 * silently without it.
 */
const INLINE_FIELD_RE = /(?:^|[\[(]|\s)([\p{L}][\p{L}\p{N}_ -]{0,40}?)\s*::\s*([^\]\)\n]*)/gu;

function extractInlineFields(line: string, into: Record<string, unknown>): void {
  INLINE_FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_FIELD_RE.exec(line)) !== null) {
    const key = m[1].trim();
    if (!key) continue;
    const value = m[2].trim();
    into[key] = coerceScalar(value);
  }
}

function coerceScalar(value: string): unknown {
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[(.)\]\s*(.*)$/;

/** Tasks-plugin emoji metadata. */
const EMOJI_DATE = {
  due: '📅',
  scheduled: '⏳',
  start: '🛫',
  completion: '✅',
  created: '➕'
} as const;
const PRIORITY_EMOJI: Record<string, string> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest'
};

function extractTaskMetadata(text: string): {
  clean: string;
  dates: Record<string, number | null>;
  priority: string | null;
  recurrence: string | null;
} {
  let clean = text;
  const dates: Record<string, number | null> = {
    due: null,
    scheduled: null,
    start: null,
    completion: null,
    created: null
  };

  for (const [key, emoji] of Object.entries(EMOJI_DATE)) {
    const re = new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`, 'u');
    const m = clean.match(re);
    if (m) {
      const dt = DateTime.fromISO(m[1]);
      dates[key] = dt.isValid ? dt.toMillis() : null;
      clean = clean.replace(m[0], '');
    }
  }

  let priority: string | null = null;
  for (const [emoji, level] of Object.entries(PRIORITY_EMOJI)) {
    if (clean.includes(emoji)) {
      priority = level;
      clean = clean.split(emoji).join('');
    }
  }

  let recurrence: string | null = null;
  const rec = clean.match(/🔁\s*([^📅⏳🛫✅➕🔺⏫🔼🔽⏬]*)/u);
  if (rec) {
    recurrence = rec[1].trim() || null;
    clean = clean.replace(rec[0], '');
  }

  return { clean: clean.trim(), dates, priority, recurrence };
}

export interface ParseResult {
  frontmatter: Record<string, unknown>;
  fields: Record<string, unknown>;
  tags: string[];
  etags: string[];
  aliases: string[];
  outlinks: RawLink[];
  tasks: RawTask[];
  lists: RawListItem[];
  sections: RawSection[];
}

export function parseMarkdown(text: string): ParseResult {
  const fm = parseFrontmatter(text);
  const lines = text.split(/\r?\n/);
  const masked = buildCodeMask(lines);

  const etagSet = new Set<string>();
  const fields: Record<string, unknown> = {};
  const outlinks: RawLink[] = [];
  const tasks: RawTask[] = [];
  const lists: RawListItem[] = [];
  const sections: RawSection[] = [];

  let currentSection: string | null = null;
  // Stack of open list items by indent, used to attach children to parents.
  const stack: Array<{ indent: number; line: number; task: RawTask | null }> = [];

  // Character offset of the start of each line, for precise task edits.
  const lineOffsets: number[] = new Array(lines.length);
  {
    let off = 0;
    const nlLen = text.includes('\r\n') ? 2 : 1;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = off;
      off += lines[i].length + nlLen;
    }
  }

  for (let i = fm.lineCount; i < lines.length; i++) {
    const rawLine = lines[i];
    if (masked.has(i)) continue;
    const line = stripInlineCode(rawLine);

    const heading = line.match(HEADING_RE);
    if (heading) {
      currentSection = heading[2].trim();
      sections.push({ heading: currentSection, level: heading[1].length, line: i });
      extractTags(line, etagSet);
      extractLinks(line, outlinks);
      stack.length = 0;
      continue;
    }

    extractTags(line, etagSet);
    extractLinks(line, outlinks);
    extractInlineFields(line, fields);

    const listMatch = line.match(LIST_RE);
    if (!listMatch) continue;

    const indent = listMatch[1].replace(/\t/g, '    ').length;
    const body = listMatch[3];
    const taskMatch = body.match(TASK_RE);

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentFrame = stack[stack.length - 1] ?? null;

    lists.push({
      text: taskMatch ? taskMatch[2].trim() : body.trim(),
      line: i,
      indent,
      section: currentSection,
      task: !!taskMatch
    });

    if (taskMatch) {
      const status = taskMatch[1];
      const meta = extractTaskMetadata(taskMatch[2]);
      const taskTags = new Set<string>();
      extractTags(taskMatch[2], taskTags);
      const taskFields: Record<string, unknown> = {};
      extractInlineFields(taskMatch[2], taskFields);

      // Offset of the status character: line start + indent + bullet + space + '['
      const bulletLen = listMatch[2].length;
      const leadingLen = listMatch[1].length;
      const spacesAfterBullet = body.length === 0 ? 1 : rawLine.length - leadingLen - bulletLen - body.length;
      const statusOffset =
        lineOffsets[i] + leadingLen + bulletLen + spacesAfterBullet + 1;

      const task: RawTask = {
        text: meta.clean,
        status,
        completed: status.toLowerCase() === 'x',
        fullyCompleted: status.toLowerCase() === 'x',
        checked: status !== ' ',
        line: i,
        statusOffset,
        indent,
        section: currentSection,
        children: [],
        parent: parentFrame?.task ? parentFrame.task.line : null,
        tags: [...taskTags],
        fields: taskFields,
        due: meta.dates.due,
        scheduled: meta.dates.scheduled,
        start: meta.dates.start,
        completion: meta.dates.completion,
        created: meta.dates.created,
        priority: meta.priority,
        recurrence: meta.recurrence
      };
      if (parentFrame?.task) parentFrame.task.children.push(i);
      tasks.push(task);
      stack.push({ indent, line: i, task });
    } else {
      stack.push({ indent, line: i, task: null });
    }
  }

  // Frontmatter tags participate in the tag list too.
  for (const key of ['tags', 'tag']) {
    const value = fm.data[key];
    if (typeof value === 'string') {
      for (const t of value.split(/[,\s]+/)) {
        if (t.trim()) etagSet.add(t.startsWith('#') ? t.trim() : '#' + t.trim());
      }
    } else if (Array.isArray(value)) {
      for (const t of value) {
        if (typeof t === 'string' && t.trim()) {
          etagSet.add(t.startsWith('#') ? t.trim() : '#' + t.trim());
        }
      }
    }
  }

  const aliasRaw = fm.data['aliases'] ?? fm.data['alias'];
  const aliases: string[] = Array.isArray(aliasRaw)
    ? aliasRaw.filter((a): a is string => typeof a === 'string')
    : typeof aliasRaw === 'string'
      ? [aliasRaw]
      : [];

  // A task's completion rolls up: a parent is fully complete only if its
  // subtree is, which is what Dataview's fullyCompleted means.
  const byLine = new Map(tasks.map((t) => [t.line, t]));
  const computeFully = (t: RawTask, seen = new Set<number>()): boolean => {
    if (seen.has(t.line)) return t.completed;
    seen.add(t.line);
    return (
      t.completed &&
      t.children.every((c) => {
        const child = byLine.get(c);
        return !child || computeFully(child, seen);
      })
    );
  };
  for (const t of tasks) t.fullyCompleted = computeFully(t);

  return {
    frontmatter: fm.data,
    fields,
    tags: expandTags(etagSet),
    etags: [...etagSet],
    aliases,
    outlinks,
    tasks,
    lists,
    sections
  };
}

/** Derive file.day from frontmatter or a dated filename. */
export function resolveDay(
  frontmatter: Record<string, unknown>,
  basename: string,
  format: string
): number | null {
  for (const key of ['date', 'day']) {
    const value = frontmatter[key];
    if (typeof value === 'string') {
      const dt = DateTime.fromISO(value);
      if (dt.isValid) return dt.startOf('day').toMillis();
    } else if (value instanceof Date) {
      return DateTime.fromJSDate(value).startOf('day').toMillis();
    }
  }
  // Parse from the filename without round-tripping through `new Date()`,
  // which would shift date-only values across the UTC boundary.
  const byFormat = DateTime.fromFormat(basename.slice(0, format.length), format);
  if (byFormat.isValid) return byFormat.startOf('day').toMillis();

  const m = basename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const dt = DateTime.fromObject({
      year: +m[1],
      month: +m[2],
      day: +m[3]
    });
    if (dt.isValid) return dt.toMillis();
  }
  return null;
}

export function buildPage(
  path: string,
  text: string,
  stat: { ctime: number; mtime: number; size: number },
  dailyNoteFormat: string
): RawPage {
  const parsed = parseMarkdown(text);
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash) : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const name = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : '';

  return {
    path,
    name,
    folder,
    ext,
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    frontmatter: parsed.frontmatter,
    fields: parsed.fields,
    tags: parsed.tags,
    etags: parsed.etags,
    aliases: parsed.aliases,
    day: resolveDay(parsed.frontmatter, name, dailyNoteFormat),
    outlinks: parsed.outlinks,
    tasks: parsed.tasks,
    lists: parsed.lists,
    sections: parsed.sections
  };
}
