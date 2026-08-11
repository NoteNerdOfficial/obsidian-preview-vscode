import { DateTime, Duration } from 'luxon';
import type { Bridge } from '../bridge';
import type { LoadViewResult } from '../../shared/protocol';
import { PageIndex, PageValue, TaskValue } from './pages';
import { dataArray, DataArray, isDataArray, Link, stringifyValue } from './values';
import { executeQuery, QueryResult } from '../dql/engine';
import { parseExpression } from '../dql/parser';
import { evaluate } from '../dql/engine';
import { FUNCTIONS, parseDate, parseDuration } from '../dql/functions';
import { renderMarkdown } from '../render/markdown';

export interface DvOptions {
  index: PageIndex;
  bridge: Bridge;
  container: HTMLElement;
  currentPath: string;
  loadedViewCss: Set<string>;
}

/**
 * The `dv` object handed to dataviewjs blocks.
 *
 * Method set is driven by what real snippets use: this vault's blocks reach for
 * container, view, span and paragraph, while its view.js files add el, pages
 * and pagePaths. The rest round out the surface so common snippets from
 * elsewhere keep working.
 */
export class DataviewApi {
  readonly container: HTMLElement;
  readonly app: unknown;
  readonly luxon = { DateTime, Duration };
  readonly func = FUNCTIONS;

  private index: PageIndex;
  private bridge: Bridge;
  private currentPath: string;
  private loadedViewCss: Set<string>;

  constructor(opts: DvOptions, app: unknown) {
    this.index = opts.index;
    this.bridge = opts.bridge;
    this.container = opts.container;
    this.currentPath = opts.currentPath;
    this.loadedViewCss = opts.loadedViewCss;
    this.app = app;
  }

  // --- data access ---------------------------------------------------------

  /** All pages matching a source query, e.g. `#tag`, `"folder"`, `[[note]]`. */
  pages(source = ''): DataArray<PageValue> {
    const query = source.trim();
    if (!query) return dataArray(this.index.all());
    const result = executeQuery(`LIST FROM ${query}`, this.index, this.current());
    if (result.type !== 'list') return dataArray([]);
    return dataArray(
      result.items
        .map((item) => (item.primary instanceof Link ? this.index.get(item.primary.path) : null))
        .filter((p): p is PageValue => !!p)
    );
  }

  pagePaths(source = ''): DataArray<string> {
    return dataArray(this.pages(source).values.map((p) => p.file.path));
  }

  page(path: string | Link): PageValue | undefined {
    const target = path instanceof Link ? path.path : path;
    const resolved = this.index.resolvePath(target, this.currentPath) ?? target;
    return this.index.get(resolved);
  }

  current(): PageValue | null {
    return this.index.get(this.currentPath) ?? null;
  }

  array<T>(values: T[] | DataArray<T>): DataArray<T> {
    return isDataArray(values) ? values : dataArray(values as T[]);
  }

  isArray(value: unknown): boolean {
    return Array.isArray(value) || isDataArray(value);
  }

  date(value: unknown): DateTime | null {
    return parseDate(value);
  }

  duration(value: unknown): Duration | null {
    return parseDuration(value);
  }

  fileLink(path: string, embed = false, display?: string): Link {
    return new Link(path, display, undefined, 'file', embed, true);
  }

  sectionLink(path: string, section: string, embed = false, display?: string): Link {
    return new Link(path, display, section, 'header', embed, true);
  }

  compare(a: unknown, b: unknown): number {
    return FUNCTIONS.min ? (stringifyValue(a) < stringifyValue(b) ? -1 : 1) : 0;
  }

  /** Evaluate a DQL expression string against the current page. */
  tryEvaluate(expression: string, context: Record<string, unknown> = {}): unknown {
    try {
      return this.evaluate(expression, context);
    } catch {
      return null;
    }
  }

  evaluate(expression: string, context: Record<string, unknown> = {}): unknown {
    const expr = parseExpression(expression);
    const current = this.current();
    return evaluate(expr, {
      row: (current ?? {}) as Record<string, unknown>,
      current,
      index: this.index,
      locals: context
    });
  }

  /** Run a DQL query string and get the structured result back. */
  query(source: string): { successful: true; value: QueryResult } | { successful: false; error: string } {
    try {
      return { successful: true, value: executeQuery(source, this.index, this.current()) };
    } catch (err) {
      return { successful: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- rendering -----------------------------------------------------------

  el(tag: string, text: unknown, options: { container?: HTMLElement; cls?: string; attr?: Record<string, string> } = {}): HTMLElement {
    const parent = options.container ?? this.container;
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.attr) {
      for (const [k, v] of Object.entries(options.attr)) el.setAttribute(k, v);
    }
    el.innerHTML = this.renderValue(text, true);
    parent.appendChild(el);
    return el;
  }

  header(level: number, text: unknown, options: { container?: HTMLElement } = {}): HTMLElement {
    return this.el(`h${Math.min(6, Math.max(1, level))}`, text, options);
  }

  paragraph(text: unknown, options: { container?: HTMLElement } = {}): HTMLElement {
    return this.el('p', text, options);
  }

  span(text: unknown, options: { container?: HTMLElement } = {}): HTMLElement {
    return this.el('span', text, options);
  }

  /** Alias Obsidian users expect for inline markdown output. */
  markdownTable(headers: string[], values: unknown[][]): string {
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = values.map((row) => `| ${row.map((c) => stringifyValue(c)).join(' | ')} |`);
    return [head, sep, ...body].join('\n');
  }

  table(
    headers: string[],
    values: unknown[][] | DataArray<unknown[]>,
    options: { container?: HTMLElement } = {}
  ): HTMLElement {
    const parent = options.container ?? this.container;
    const rows = isDataArray(values) ? values.values : values;

    const table = document.createElement('table');
    table.className = 'dataview table-view-table';

    const thead = table.createEl('thead', { cls: 'table-view-thead' });
    const headRow = thead.createEl('tr', { cls: 'table-view-tr-header' });
    for (const header of headers) {
      const th = headRow.createEl('th', { cls: 'table-view-th' });
      th.innerHTML = this.renderValue(header, true);
    }

    const tbody = table.createEl('tbody', { cls: 'table-view-tbody' });
    for (const row of rows) {
      const tr = tbody.createEl('tr');
      const cells: unknown[] = Array.isArray(row)
        ? row
        : isDataArray(row)
          ? (row as DataArray<unknown>).values
          : [row];
      for (const cell of cells) {
        const td = tr.createEl('td', { cls: 'table-view-td' });
        this.appendValue(td, cell);
      }
    }

    if (rows.length === 0) {
      const tr = tbody.createEl('tr');
      const td = tr.createEl('td', { cls: 'table-view-td dataview-empty' });
      td.setAttribute('colspan', String(Math.max(1, headers.length)));
      td.textContent = 'No results';
    }

    parent.appendChild(table);
    return table;
  }

  list(values: unknown[] | DataArray<unknown>, options: { container?: HTMLElement } = {}): HTMLElement {
    const parent = options.container ?? this.container;
    const items = isDataArray(values) ? values.values : values;

    const ul = document.createElement('ul');
    ul.className = 'dataview list-view-ul';
    for (const item of items) {
      const li = ul.createEl('li');
      this.appendValue(li, item);
    }
    if (items.length === 0) {
      const li = ul.createEl('li', { cls: 'dataview-empty' });
      li.textContent = 'No results';
    }
    parent.appendChild(ul);
    return ul;
  }

  taskList(
    tasks: TaskValue[] | DataArray<TaskValue>,
    groupByFile = true,
    options: { container?: HTMLElement } = {}
  ): HTMLElement {
    const parent = options.container ?? this.container;
    const items = isDataArray(tasks) ? (tasks.values as TaskValue[]) : tasks;

    const root = document.createElement('div');
    root.className = 'dataview task-view';

    const render = (list: TaskValue[], into: HTMLElement) => {
      const ul = into.createEl('ul', { cls: 'contains-task-list task-list-view-ul' });
      for (const task of list) {
        const li = ul.createEl('li', {
          cls: task.completed ? 'task-list-item is-checked' : 'task-list-item'
        });
        const box = li.createEl('input', { cls: 'task-list-item-checkbox' }) as HTMLInputElement;
        box.type = 'checkbox';
        box.checked = task.completed;
        box.dataset.line = String(task.line);
        box.dataset.path = task.path;
        box.dataset.status = task.status;

        const span = li.createEl('span', { cls: 'task-text' });
        span.innerHTML = renderMarkdown(String(task.text), {
          sourcePath: task.path,
          resolve: (t, f) => this.index.resolvePath(t, f),
          inline: true
        });

        const subtasks = task.subtasks?.values ?? [];
        if (subtasks.length) render(subtasks as TaskValue[], li);
      }
    };

    if (groupByFile) {
      const byFile = new Map<string, TaskValue[]>();
      for (const task of items) {
        const bucket = byFile.get(task.path);
        if (bucket) bucket.push(task);
        else byFile.set(task.path, [task]);
      }
      for (const [path, list] of byFile) {
        const section = root.createEl('div', { cls: 'dataview-task-group' });
        const heading = section.createEl('h4', { cls: 'dataview-task-group-title' });
        this.appendValue(heading, Link.file(path, false, path.replace(/\.md$/, '')));
        render(list, section);
      }
    } else {
      render(items, root);
    }

    if (items.length === 0) {
      root.createEl('p', { cls: 'dataview-empty', text: 'No tasks' });
    }

    parent.appendChild(root);
    return root;
  }

  /**
   * Load and execute a script from the vault, the way `dv.view("name", input)`
   * does in Obsidian: `<name>/view.js` (or `<name>.js`) plus optional
   * sibling CSS, evaluated with `dv` and `input` in scope.
   */
  async view(name: string, input?: unknown): Promise<void> {
    let result: LoadViewResult;
    try {
      result = await this.bridge.request<LoadViewResult>('loadView', { name });
    } catch (err) {
      this.renderError(`dv.view("${name}"): ${(err as Error).message}`);
      return;
    }
    if (!result.js) {
      this.renderError(`dv.view("${name}"): script not found`);
      return;
    }

    if (result.css && !this.loadedViewCss.has(name)) {
      this.loadedViewCss.add(name);
      const style = document.createElement('style');
      style.dataset.view = name;
      style.textContent = result.css;
      document.head.appendChild(style);
    }

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;

    try {
      const fn = new AsyncFunction('dv', 'input', 'app', 'moment', 'luxon', 'DateTime', result.js);
      await fn(
        this,
        input,
        this.app,
        (window as unknown as { moment: unknown }).moment,
        this.luxon,
        DateTime
      );
    } catch (err) {
      this.renderError(
        `dv.view("${name}") failed in ${result.source ?? 'view.js'}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // --- internals -----------------------------------------------------------

  private renderError(message: string): void {
    const div = this.container.createEl('div', { cls: 'dataview-error' });
    div.textContent = message;
  }

  /** Render a value as HTML, treating strings as markdown like Dataview does. */
  private renderValue(value: unknown, inline: boolean): string {
    if (value instanceof HTMLElement) return value.outerHTML;
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
      return renderMarkdown(value, {
        sourcePath: this.currentPath,
        resolve: (t, f) => this.index.resolvePath(t, f),
        inline
      });
    }
    if (value instanceof Link) {
      return renderMarkdown(value.markdown(), {
        sourcePath: this.currentPath,
        resolve: (t, f) => this.index.resolvePath(t, f),
        inline: true
      });
    }
    return renderMarkdown(stringifyValue(value), {
      sourcePath: this.currentPath,
      resolve: (t, f) => this.index.resolvePath(t, f),
      inline
    });
  }

  private appendValue(parent: HTMLElement, value: unknown): void {
    if (value instanceof HTMLElement) {
      parent.appendChild(value);
      return;
    }
    if (value === null || value === undefined) {
      parent.textContent = '';
      return;
    }
    if (isDataArray(value) || Array.isArray(value)) {
      const items = isDataArray(value) ? value.values : value;
      items.forEach((item, i) => {
        if (i > 0) parent.appendText(', ');
        this.appendValue(parent, item);
      });
      return;
    }
    parent.innerHTML = this.renderValue(value, true);
  }
}
