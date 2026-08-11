import { DateTime } from 'luxon';
import type { RawPage, RawTask } from '../../shared/protocol';
import { dataArray, DataArray, Link } from './values';

export interface TaskValue extends Record<string, unknown> {
  text: string;
  status: string;
  completed: boolean;
  fullyCompleted: boolean;
  checked: boolean;
  line: number;
  path: string;
  section: Link;
  link: Link;
  subtasks: DataArray<TaskValue>;
  children: DataArray<TaskValue>;
  real: boolean;
  tags: DataArray<string>;
  due: DateTime | null;
  scheduled: DateTime | null;
  start: DateTime | null;
  completion: DateTime | null;
  created: DateTime | null;
  priority: string | null;
  recurrence: string | null;
}

export interface PageValue extends Record<string, unknown> {
  file: PageFile;
}

export interface PageFile extends Record<string, unknown> {
  path: string;
  name: string;
  folder: string;
  ext: string;
  link: Link;
  size: number;
  ctime: DateTime;
  cday: DateTime;
  mtime: DateTime;
  mday: DateTime;
  day: DateTime | null;
  tags: DataArray<string>;
  etags: DataArray<string>;
  aliases: DataArray<string>;
  inlinks: DataArray<Link>;
  outlinks: DataArray<Link>;
  tasks: DataArray<TaskValue>;
  lists: DataArray<Record<string, unknown>>;
  frontmatter: Record<string, unknown>;
  starred: boolean;
}

const dt = (millis: number | null): DateTime | null =>
  millis === null ? null : DateTime.fromMillis(millis);

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Shortest path wins: fewer segments, then shorter, then alphabetical. */
function comparePaths(a: string, b: string): number {
  const da = a.split('/').length;
  const db = b.split('/').length;
  if (da !== db) return da - db;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Frontmatter values arrive as JSON, so anything date-shaped is a string.
 * Dataview surfaces those as DateTimes, and snippets compare them against
 * date() results, so coerce here rather than at every call site.
 */
function coerceFrontmatterValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) {
      const parsed = DateTime.fromISO(value.replace(' ', 'T'));
      if (parsed.isValid) return parsed;
    }
    const link = value.match(/^\[\[([^\]]+)\]\]$/);
    if (link) {
      const [target, display] = link[1].split('|');
      return new Link(target.trim(), display?.trim(), undefined, 'file', false, false);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(coerceFrontmatterValue);
  return value;
}

function buildTask(
  raw: RawTask,
  page: RawPage,
  byLine: Map<number, RawTask>,
  built: Map<number, TaskValue>
): TaskValue {
  const existing = built.get(raw.line);
  if (existing) return existing;

  const sectionLink = new Link(
    page.path,
    raw.section ?? undefined,
    raw.section ?? undefined,
    raw.section ? 'header' : 'file',
    false,
    true
  );

  const task: TaskValue = {
    text: raw.text,
    status: raw.status,
    completed: raw.completed,
    fullyCompleted: raw.fullyCompleted,
    checked: raw.checked,
    line: raw.line,
    path: page.path,
    section: sectionLink,
    link: new Link(page.path, raw.text, undefined, 'file', false, true),
    subtasks: dataArray<TaskValue>([]),
    children: dataArray<TaskValue>([]),
    real: true,
    tags: dataArray(raw.tags),
    due: dt(raw.due),
    scheduled: dt(raw.scheduled),
    start: dt(raw.start),
    completion: dt(raw.completion),
    created: dt(raw.created),
    priority: raw.priority,
    recurrence: raw.recurrence,
    ...raw.fields
  };
  built.set(raw.line, task);

  const kids = raw.children
    .map((line) => byLine.get(line))
    .filter((t): t is RawTask => !!t)
    .map((t) => buildTask(t, page, byLine, built));
  task.subtasks = dataArray(kids);
  task.children = task.subtasks;

  return task;
}

export function buildPageValue(
  page: RawPage,
  inlinks: string[],
  resolveLink: (target: string, from: string) => string | null
): PageValue {
  const byLine = new Map(page.tasks.map((t) => [t.line, t]));
  const built = new Map<number, TaskValue>();
  const tasks = page.tasks.map((t) => buildTask(t, page, byLine, built));

  const outlinks = page.outlinks.map(
    (l) =>
      new Link(
        l.resolved ? l.path : (resolveLink(l.raw, page.path) ?? l.raw),
        l.display,
        l.subpath,
        l.type,
        l.embed,
        l.resolved
      )
  );

  const file: PageFile = {
    path: page.path,
    name: page.name,
    folder: page.folder,
    ext: page.ext,
    link: Link.file(page.path, false, page.name),
    size: page.size,
    ctime: DateTime.fromMillis(page.ctime),
    cday: DateTime.fromMillis(page.ctime).startOf('day'),
    mtime: DateTime.fromMillis(page.mtime),
    mday: DateTime.fromMillis(page.mtime).startOf('day'),
    day: dt(page.day),
    tags: dataArray(page.tags),
    etags: dataArray(page.etags),
    aliases: dataArray(page.aliases),
    inlinks: dataArray(inlinks.map((p) => Link.file(p))),
    outlinks: dataArray(outlinks),
    tasks: dataArray(tasks),
    lists: dataArray(
      page.lists.map((l) => ({
        text: l.text,
        line: l.line,
        section: l.section,
        task: l.task,
        path: page.path
      }))
    ),
    frontmatter: page.frontmatter,
    starred: false
  };

  const value: PageValue = { file };

  for (const [key, raw] of Object.entries(page.frontmatter)) {
    if (key === 'file') continue;
    value[key] = coerceFrontmatterValue(raw);
  }
  for (const [key, raw] of Object.entries(page.fields)) {
    if (key === 'file') continue;
    value[key] = coerceFrontmatterValue(raw);
  }

  return value;
}

/** Index of the whole vault as Dataview page values. */
export class PageIndex {
  private raw = new Map<string, RawPage>();
  private built = new Map<string, PageValue>();
  private inlinks = new Map<string, string[]>();

  upsert(pages: RawPage[]): void {
    for (const page of pages) {
      this.raw.set(page.path, page);
      this.built.delete(page.path);
    }
    this.recomputeInlinks();
  }

  remove(paths: string[]): void {
    for (const path of paths) {
      this.raw.delete(path);
      this.built.delete(path);
    }
    this.recomputeInlinks();
  }

  clear(): void {
    this.raw.clear();
    this.built.clear();
    this.inlinks.clear();
  }

  private recomputeInlinks(): void {
    this.inlinks.clear();
    for (const page of this.raw.values()) {
      for (const link of page.outlinks) {
        if (!link.resolved) continue;
        const bucket = this.inlinks.get(link.path);
        if (bucket) {
          if (!bucket.includes(page.path)) bucket.push(page.path);
        } else {
          this.inlinks.set(link.path, [page.path]);
        }
      }
    }
    // Built pages cache inlinks, so they must be invalidated together.
    this.built.clear();
  }

  /** Mirrors the host-side LinkResolver: nearest match first, then vault root. */
  private resolve = (target: string, from: string): string | null => {
    const clean = target.replace(/\\/g, '/').replace(/\.md$/i, '').trim();
    if (!clean) return null;
    const fromFolder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';

    const relative = normalize(fromFolder ? `${fromFolder}/${clean}` : clean);
    const nearby = this.raw.get(relative + '.md') ?? this.raw.get(relative);
    if (nearby) return nearby.path;

    const direct = this.raw.get(clean + '.md') ?? this.raw.get(clean);
    if (direct) return direct.path;

    const base = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
    let best: RawPage | null = null;
    for (const page of this.raw.values()) {
      if (page.name.toLowerCase() !== base) continue;
      if (page.folder === fromFolder) return page.path;
      if (!best || comparePaths(page.path, best.path) < 0) best = page;
    }
    if (best) return best.path;

    for (const page of this.raw.values()) {
      if (page.aliases.some((a) => a.toLowerCase() === clean.toLowerCase())) return page.path;
    }
    return null;
  };

  get(path: string): PageValue | undefined {
    const raw = this.raw.get(path);
    if (!raw) return undefined;
    let value = this.built.get(path);
    if (!value) {
      value = buildPageValue(raw, this.inlinks.get(path) ?? [], this.resolve);
      this.built.set(path, value);
    }
    return value;
  }

  getRaw(path: string): RawPage | undefined {
    return this.raw.get(path);
  }

  paths(): string[] {
    return [...this.raw.keys()];
  }

  all(): PageValue[] {
    return this.paths()
      .map((p) => this.get(p))
      .filter((p): p is PageValue => !!p);
  }

  resolvePath(target: string, from: string): string | null {
    return this.resolve(target, from);
  }

  get size(): number {
    return this.raw.size;
  }
}
