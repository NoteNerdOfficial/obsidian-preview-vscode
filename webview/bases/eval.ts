import { DateTime, Duration } from 'luxon';
import type { BaseExpr } from './expr';
import type { PageIndex, PageValue } from '../dataview/pages';
import {
  compareValues,
  dataArray,
  DataArray,
  isDataArray,
  Link,
  stringifyValue
} from '../dataview/values';

export interface BaseContext {
  page: PageValue;
  /** The note the base is embedded in, exposed as `this`. */
  current: PageValue | null;
  index: PageIndex;
  formulas: Map<string, BaseExpr | null>;
  /** Memoised per page, since formulas are referenced from filters and columns. */
  formulaCache: Map<string, unknown>;
  /** Guards against a formula referencing itself. */
  evaluating: Set<string>;
}

export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (isDataArray(value)) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function toList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (isDataArray(value)) return value.values;
  if (Array.isArray(value)) return value;
  return [value];
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (isDataArray(value)) return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** `file` object, with the methods Bases exposes on it. */
function fileNamespace(page: PageValue): Record<string, unknown> {
  const f = page.file;
  return {
    name: f.name,
    path: f.path,
    folder: f.folder,
    ext: f.ext,
    size: f.size,
    ctime: f.ctime,
    mtime: f.mtime,
    tags: f.tags,
    etags: f.etags,
    links: f.outlinks,
    backlinks: f.inlinks,
    embeds: dataArray(f.outlinks.values.filter((l) => l.embed)),
    properties: page,

    inFolder: (folder: unknown) => {
      const target = String(folder ?? '').replace(/\/+$/, '');
      if (!target || target === '/') return true;
      return f.folder === target || f.folder.startsWith(target + '/');
    },
    hasTag: (...tags: unknown[]) =>
      tags.some((tag) => {
        const want = String(tag ?? '').replace(/^#/, '').toLowerCase();
        return f.tags.values.some((t) => String(t).replace(/^#/, '').toLowerCase() === want);
      }),
    hasLink: (target: unknown) => {
      const want = target instanceof Link ? target.path : String(target ?? '');
      return f.outlinks.values.some(
        (l) => l.path === want || l.fileName === want || l.path === want + '.md'
      );
    },
    hasProperty: (name: unknown) => {
      const key = String(name ?? '');
      return key in (page as Record<string, unknown>) && (page as Record<string, unknown>)[key] != null;
    },
    asLink: (display?: unknown) =>
      new Link(f.path, display === undefined ? f.name : String(display), undefined, 'file', false, true)
  };
}

const GLOBALS: Record<string, (...args: unknown[]) => unknown> = {
  if: (cond, whenTrue, whenFalse) => (truthy(cond) ? whenTrue : whenFalse ?? null),
  list: (...args) => dataArray(args.flatMap((a) => (isDataArray(a) || Array.isArray(a) ? toList(a) : [a]))),
  date: (value) => parseDate(value),
  today: () => DateTime.now().startOf('day'),
  now: () => DateTime.now(),
  duration: (value) => parseDuration(value),
  number: (value) => {
    if (typeof value === 'number') return value;
    const m = String(value ?? '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  },
  string: (value) => stringifyValue(value),
  link: (target, display) =>
    target instanceof Link
      ? target
      : new Link(String(target ?? ''), display === undefined ? undefined : String(display), undefined, 'file', false, false),
  min: (...args) => {
    const values = args.length === 1 ? toList(args[0]) : args;
    return values.length ? values.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b)) : null;
  },
  max: (...args) => {
    const values = args.length === 1 ? toList(args[0]) : args;
    return values.length ? values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b)) : null;
  },
  sum: (value) => toList(value).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0),
  average: (value) => {
    const nums = toList(value).filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  },
  round: (value, digits) => {
    const n = Number(value);
    if (Number.isNaN(n)) return null;
    const f = Math.pow(10, digits === undefined ? 0 : Number(digits));
    return Math.round(n * f) / f;
  },
  floor: (value) => Math.floor(Number(value)),
  ceil: (value) => Math.ceil(Number(value)),
  abs: (value) => Math.abs(Number(value)),
  // `icon()` renders a glyph in Obsidian; there is no icon set here, so it
  // degrades to nothing rather than throwing mid-row.
  icon: () => ''
};

export function parseDate(value: unknown): DateTime | null {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === 'number') return DateTime.fromMillis(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const iso = DateTime.fromISO(text.replace(' ', 'T'));
  if (iso.isValid) return iso;
  const sql = DateTime.fromSQL(text);
  return sql.isValid ? sql : null;
}

const DURATION_UNITS: Record<string, string> = {
  y: 'years', year: 'years', years: 'years',
  M: 'months', mo: 'months', month: 'months', months: 'months',
  w: 'weeks', week: 'weeks', weeks: 'weeks',
  d: 'days', day: 'days', days: 'days',
  h: 'hours', hour: 'hours', hours: 'hours',
  m: 'minutes', min: 'minutes', minute: 'minutes', minutes: 'minutes',
  s: 'seconds', sec: 'seconds', second: 'seconds', seconds: 'seconds'
};

export function parseDuration(value: unknown): Duration | null {
  if (Duration.isDuration(value)) return value;
  if (typeof value === 'number') return Duration.fromMillis(value);
  if (typeof value !== 'string') return null;
  const obj: Record<string, number> = {};
  let matched = false;
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g)) {
    const unit = DURATION_UNITS[part[2]] ?? DURATION_UNITS[part[2].toLowerCase()];
    if (!unit) continue;
    obj[unit] = (obj[unit] ?? 0) + Number(part[1]);
    matched = true;
  }
  return matched ? Duration.fromObject(obj) : null;
}

/** Methods available on a value, dispatched by its runtime type. */
function callMethod(target: unknown, name: string, args: unknown[]): unknown {
  // Methods defined directly on a namespace object (file.inFolder, ...).
  if (
    target !== null &&
    typeof target === 'object' &&
    typeof (target as Record<string, unknown>)[name] === 'function'
  ) {
    return ((target as Record<string, unknown>)[name] as (...a: unknown[]) => unknown)(...args);
  }

  const universal: Record<string, () => unknown> = {
    isEmpty: () => isEmpty(target),
    isTruthy: () => truthy(target),
    toString: () => stringifyValue(target),
    asLink: () =>
      target instanceof Link
        ? target
        : new Link(String(target ?? ''), undefined, undefined, 'file', false, false)
  };
  if (name in universal) return universal[name]();

  if (isDataArray(target) || Array.isArray(target)) {
    const items = toList(target);
    switch (name) {
      case 'contains':
        return items.some((v) => looseContains(v, args[0]));
      case 'join':
        return items.map((v) => stringifyValue(v)).join(args[0] === undefined ? ', ' : String(args[0]));
      case 'filter':
        return dataArray(items.filter((v) => truthy(applyFn(args[0], [v]))));
      case 'map':
        return dataArray(items.map((v) => applyFn(args[0], [v])));
      case 'sort':
        return dataArray([...items].sort((a, b) => compareValues(a, b)));
      case 'reverse':
        return dataArray([...items].reverse());
      case 'unique':
        return dataArray([...new Map(items.map((v) => [stringifyValue(v), v])).values()]);
      case 'flat':
        return dataArray(items.flat() as unknown[]);
      case 'slice':
        return dataArray(items.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1])));
      case 'first':
        return items[0] ?? null;
      case 'last':
        return items[items.length - 1] ?? null;
      case 'length':
        return items.length;
    }
  }

  if (typeof target === 'string') {
    switch (name) {
      case 'contains':
        return target.includes(String(args[0] ?? ''));
      case 'containsAny':
        return args.some((a) => target.includes(String(a ?? '')));
      case 'startsWith':
        return target.startsWith(String(args[0] ?? ''));
      case 'endsWith':
        return target.endsWith(String(args[0] ?? ''));
      case 'lower':
        return target.toLowerCase();
      case 'upper':
        return target.toUpperCase();
      case 'title':
        return target.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case 'trim':
        return target.trim();
      case 'replace':
        return target.split(String(args[0] ?? '')).join(String(args[1] ?? ''));
      case 'split':
        return dataArray(target.split(new RegExp(String(args[0] ?? ''))));
      case 'slice':
        return target.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
      case 'length':
        return target.length;
      case 'reverse':
        return [...target].reverse().join('');
    }
  }

  if (DateTime.isDateTime(target)) {
    switch (name) {
      case 'format':
        return target.toFormat(String(args[0] ?? 'yyyy-MM-dd'));
      case 'relative':
        return target.toRelative() ?? '';
      case 'date':
        return target.startOf('day');
      case 'time':
        return target.toFormat('HH:mm');
    }
  }

  if (Duration.isDuration(target)) {
    if (name === 'format') return target.toHuman();
  }

  if (target instanceof Link) {
    switch (name) {
      case 'contains':
        return (
          target.path.includes(String(args[0] ?? '')) ||
          target.fileName.includes(String(args[0] ?? ''))
        );
      case 'linksTo':
        return target.path === String(args[0] ?? '');
    }
  }

  throw new Error(`Unknown method .${name}() on ${describeType(target)}`);
}

function describeType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (isDataArray(value) || Array.isArray(value)) return 'list';
  if (DateTime.isDateTime(value)) return 'date';
  if (Duration.isDuration(value)) return 'duration';
  if (value instanceof Link) return 'link';
  return typeof value;
}

function looseContains(candidate: unknown, needle: unknown): boolean {
  if (candidate instanceof Link && typeof needle === 'string') {
    return candidate.path === needle || candidate.fileName === needle;
  }
  if (typeof candidate === 'string' && typeof needle === 'string') {
    return candidate === needle || candidate.replace(/^#/, '') === needle.replace(/^#/, '');
  }
  return compareValues(candidate, needle) === 0;
}

function applyFn(fn: unknown, args: unknown[]): unknown {
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : null;
}

/** Read a property from a value, returning null rather than throwing. */
function readProp(target: unknown, name: string): unknown {
  if (target === null || target === undefined) return null;

  if (DateTime.isDateTime(target)) {
    switch (name) {
      case 'year': return target.year;
      case 'month': return target.month;
      case 'day': return target.day;
      case 'hour': return target.hour;
      case 'minute': return target.minute;
      case 'date': return target.startOf('day');
      case 'time': return target.toFormat('HH:mm');
      default: return null;
    }
  }

  if (Duration.isDuration(target)) {
    const shifted = target.shiftTo('years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds');
    switch (name) {
      case 'years': return shifted.years;
      case 'months': return shifted.months;
      case 'weeks': return shifted.weeks;
      case 'days': return Math.trunc(target.as('days'));
      case 'hours': return Math.trunc(target.as('hours'));
      case 'minutes': return Math.trunc(target.as('minutes'));
      case 'seconds': return Math.trunc(target.as('seconds'));
      case 'milliseconds': return target.toMillis();
      default: return null;
    }
  }

  if (target instanceof Link) {
    switch (name) {
      case 'path': return target.path;
      case 'name': return target.fileName;
      case 'display': return target.display ?? null;
      default: return null;
    }
  }

  if (isDataArray(target)) {
    if (name === 'length') return target.length;
    return (target as unknown as Record<string, unknown>)[name];
  }

  if (Array.isArray(target)) {
    if (name === 'length') return target.length;
    return dataArray(target.map((v) => readProp(v, name)));
  }

  if (typeof target === 'string' && name === 'length') return target.length;

  if (typeof target === 'object') {
    const record = target as Record<string, unknown>;
    return name in record ? record[name] : null;
  }

  return null;
}

export function evaluateBase(expr: BaseExpr, ctx: BaseContext): unknown {
  switch (expr.kind) {
    case 'lit':
      return expr.value;

    case 'list':
      return dataArray(expr.items.map((item) => evaluateBase(item, ctx)));

    case 'lambda':
      return (...args: unknown[]) => {
        const locals: Record<string, unknown> = {};
        expr.params.forEach((p, i) => (locals[p] = args[i]));
        return evaluateBase(expr.body, { ...ctx, page: withLocals(ctx.page, locals) });
      };

    case 'ident': {
      const name = expr.name;
      if (name === 'this') return ctx.current;
      if (name === 'file') return fileNamespace(ctx.page);
      if (name === 'note') return ctx.page;
      if (name === 'formula') return formulaNamespace(ctx);
      if (name in GLOBALS) return GLOBALS[name];

      const local = (ctx.page as Record<string, unknown>).__locals as
        | Record<string, unknown>
        | undefined;
      if (local && name in local) return local[name];

      // Bare identifiers are note properties.
      const page = ctx.page as Record<string, unknown>;
      if (name in page) return page[name];
      return null;
    }

    case 'prop': {
      // `formula.x` and `file.y` resolve through their namespaces.
      if (expr.object.kind === 'ident' && expr.object.name === 'formula') {
        return evaluateFormula(expr.name, ctx);
      }
      const target = evaluateBase(expr.object, ctx);
      return readProp(target, expr.name);
    }

    case 'index': {
      const target = evaluateBase(expr.object, ctx);
      const key = evaluateBase(expr.index, ctx);
      if (typeof key === 'number') return toList(target)[key] ?? null;
      return readProp(target, String(key));
    }

    case 'call': {
      const args = expr.args.map((a) => evaluateBase(a, ctx));

      if (expr.callee.kind === 'ident') {
        const fn = GLOBALS[expr.callee.name];
        if (fn) return fn(...args);
        const value = evaluateBase(expr.callee, ctx);
        if (typeof value === 'function') return (value as (...a: unknown[]) => unknown)(...args);
        throw new Error(`Unknown function ${expr.callee.name}()`);
      }

      if (expr.callee.kind === 'prop') {
        if (expr.callee.object.kind === 'ident' && expr.callee.object.name === 'formula') {
          const value = evaluateFormula(expr.callee.name, ctx);
          if (typeof value === 'function') return (value as (...a: unknown[]) => unknown)(...args);
          return value;
        }
        const target = evaluateBase(expr.callee.object, ctx);
        return callMethod(target, expr.callee.name, args);
      }

      const callee = evaluateBase(expr.callee, ctx);
      if (typeof callee === 'function') return (callee as (...a: unknown[]) => unknown)(...args);
      throw new Error('Attempted to call a non-function');
    }

    case 'unary': {
      const value = evaluateBase(expr.operand, ctx);
      if (expr.op === '!') return !truthy(value);
      if (typeof value === 'number') return -value;
      if (Duration.isDuration(value)) return value.negate();
      return null;
    }

    case 'binary': {
      if (expr.op === '&&') {
        return truthy(evaluateBase(expr.left, ctx)) ? truthy(evaluateBase(expr.right, ctx)) : false;
      }
      if (expr.op === '||') {
        return truthy(evaluateBase(expr.left, ctx)) ? true : truthy(evaluateBase(expr.right, ctx));
      }

      const left = evaluateBase(expr.left, ctx);
      const right = evaluateBase(expr.right, ctx);

      switch (expr.op) {
        case '==':
          return baseEquals(left, right);
        case '!=':
          return !baseEquals(left, right);
        case '<':
          return compareValues(left, right) < 0;
        case '>':
          return compareValues(left, right) > 0;
        case '<=':
          return compareValues(left, right) <= 0;
        case '>=':
          return compareValues(left, right) >= 0;
        case '+':
          return add(left, right);
        case '-':
          return subtract(left, right);
        case '*':
          return numeric(left, right, (a, b) => a * b);
        case '/':
          return numeric(left, right, (a, b) => (b === 0 ? null : a / b));
        case '%':
          return numeric(left, right, (a, b) => (b === 0 ? null : a % b));
      }
      return null;
    }
  }
}

function withLocals(page: PageValue, locals: Record<string, unknown>): PageValue {
  return Object.assign(Object.create(Object.getPrototypeOf(page) as object), page, {
    __locals: locals
  }) as PageValue;
}

function formulaNamespace(ctx: BaseContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ctx.formulas.keys()) {
    Object.defineProperty(out, key, {
      get: () => evaluateFormula(key, ctx),
      enumerable: true
    });
  }
  return out;
}

function evaluateFormula(name: string, ctx: BaseContext): unknown {
  if (ctx.formulaCache.has(name)) return ctx.formulaCache.get(name);
  const expr = ctx.formulas.get(name);
  if (!expr) return null;

  if (ctx.evaluating.has(name)) {
    throw new Error(`Formula "${name}" references itself`);
  }
  ctx.evaluating.add(name);
  try {
    const value = evaluateBase(expr, ctx);
    ctx.formulaCache.set(name, value);
    return value;
  } finally {
    ctx.evaluating.delete(name);
  }
}

function baseEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Link || b instanceof Link) {
    const link = (a instanceof Link ? a : b) as Link;
    const other = a instanceof Link ? b : a;
    if (other instanceof Link) return link.equals(other);
    const text = String(other);
    return link.path === text || link.fileName === text || link.display === text;
  }
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) return a.toMillis() === b.toMillis();
  return compareValues(a, b) === 0;
}

function add(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (DateTime.isDateTime(left) && Duration.isDuration(right)) return left.plus(right);
  if (Duration.isDuration(left) && Duration.isDuration(right)) return left.plus(right);
  if (isDataArray(left) || Array.isArray(left)) return dataArray([...toList(left), ...toList(right)]);
  if (left === null || left === undefined) return right;
  if (right === null || right === undefined) return left;
  return stringifyValue(left) + stringifyValue(right);
}

function subtract(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (DateTime.isDateTime(left) && DateTime.isDateTime(right)) return left.diff(right);
  if (DateTime.isDateTime(left) && Duration.isDuration(right)) return left.minus(right);
  if (Duration.isDuration(left) && Duration.isDuration(right)) return left.minus(right);
  return null;
}

function numeric(
  left: unknown,
  right: unknown,
  fn: (a: number, b: number) => number | null
): unknown {
  if (typeof left === 'number' && typeof right === 'number') return fn(left, right);
  return null;
}

export { toList, isEmpty, fileNamespace };
