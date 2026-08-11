import { DateTime, Duration } from 'luxon';
import { dataArray, isDataArray, Link, stringifyValue, typeOf, valueEquals } from '../dataview/values';

type Fn = (...args: unknown[]) => unknown;

function toArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (isDataArray(value)) return value.values;
  if (Array.isArray(value)) return value;
  return [value];
}

function asString(value: unknown): string {
  return stringifyValue(value);
}

export function parseDate(value: unknown): DateTime | null {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === 'number') return DateTime.fromMillis(value);
  if (typeof value !== 'string') return null;

  const text = value.trim().toLowerCase();
  const now = DateTime.now();
  switch (text) {
    case 'now':
      return now;
    case 'today':
      return now.startOf('day');
    case 'tomorrow':
      return now.startOf('day').plus({ days: 1 });
    case 'yesterday':
      return now.startOf('day').minus({ days: 1 });
    case 'sow':
      return now.startOf('week');
    case 'eow':
      return now.endOf('week');
    case 'som':
      return now.startOf('month');
    case 'eom':
      return now.endOf('month');
    case 'soy':
      return now.startOf('year');
    case 'eoy':
      return now.endOf('year');
  }

  const iso = DateTime.fromISO(value.trim());
  if (iso.isValid) return iso;
  const sql = DateTime.fromSQL(value.trim());
  if (sql.isValid) return sql;
  return null;
}

const DURATION_UNITS: Record<string, keyof Duration> = {
  year: 'years',
  years: 'years',
  yr: 'years',
  yrs: 'years',
  y: 'years',
  month: 'months',
  months: 'months',
  mo: 'months',
  mos: 'months',
  week: 'weeks',
  weeks: 'weeks',
  wk: 'weeks',
  wks: 'weeks',
  w: 'weeks',
  day: 'days',
  days: 'days',
  d: 'days',
  hour: 'hours',
  hours: 'hours',
  hr: 'hours',
  hrs: 'hours',
  h: 'hours',
  minute: 'minutes',
  minutes: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  m: 'minutes',
  second: 'seconds',
  seconds: 'seconds',
  sec: 'seconds',
  secs: 'seconds',
  s: 'seconds'
};

export function parseDuration(value: unknown): Duration | null {
  if (Duration.isDuration(value)) return value;
  if (typeof value === 'number') return Duration.fromMillis(value);
  if (typeof value !== 'string') return null;

  const parts = value.matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g);
  const obj: Record<string, number> = {};
  let matched = false;
  for (const part of parts) {
    const unit = DURATION_UNITS[part[2].toLowerCase()];
    if (!unit) continue;
    obj[unit] = (obj[unit] ?? 0) + Number(part[1]);
    matched = true;
  }
  return matched ? Duration.fromObject(obj) : null;
}

function containsValue(haystack: unknown, needle: unknown, ci = false): boolean {
  if (haystack === null || haystack === undefined) return false;

  if (isDataArray(haystack) || Array.isArray(haystack)) {
    return toArray(haystack).some((v) => containsValue(v, needle, ci));
  }

  if (haystack instanceof Link) {
    if (needle instanceof Link) return haystack.equals(needle);
    const text = asString(needle);
    return (
      haystack.path.includes(text) ||
      haystack.fileName.includes(text) ||
      (haystack.display ?? '').includes(text)
    );
  }

  if (typeof haystack === 'object' && !DateTime.isDateTime(haystack) && !Duration.isDuration(haystack)) {
    return Object.values(haystack as Record<string, unknown>).some((v) =>
      containsValue(v, needle, ci)
    );
  }

  let text = asString(haystack);
  let sub = needle instanceof Link ? needle.toString() : asString(needle);
  if (ci) {
    text = text.toLowerCase();
    sub = sub.toLowerCase();
  }
  return text.includes(sub);
}

export function callLambda(fn: unknown, args: unknown[]): unknown {
  if (typeof fn === 'function') return (fn as Fn)(...args);
  return null;
}

export const FUNCTIONS: Record<string, Fn> = {
  // --- containment / strings -----------------------------------------------
  contains: (haystack, needle) => containsValue(haystack, needle, false),
  icontains: (haystack, needle) => containsValue(haystack, needle, true),
  econtains: (haystack, needle) => {
    if (isDataArray(haystack) || Array.isArray(haystack)) {
      return toArray(haystack).some((v) => valueEquals(v, needle));
    }
    return asString(haystack) === asString(needle);
  },
  containsword: (haystack, needle) =>
    new RegExp(`\\b${escapeRegExp(asString(needle))}\\b`, 'i').test(asString(haystack)),
  startswith: (value, prefix) => asString(value).startsWith(asString(prefix)),
  endswith: (value, suffix) => asString(value).endsWith(asString(suffix)),
  lower: (value) => asString(value).toLowerCase(),
  upper: (value) => asString(value).toUpperCase(),
  replace: (value, from, to) => asString(value).split(asString(from)).join(asString(to)),
  regexreplace: (value, pattern, replacement) =>
    asString(value).replace(new RegExp(asString(pattern), 'g'), asString(replacement)),
  regexmatch: (value, pattern) => new RegExp(`^${asString(pattern)}$`).test(asString(value)),
  regextest: (value, pattern) => new RegExp(asString(pattern)).test(asString(value)),
  split: (value, sep, limit) => {
    const parts = asString(value).split(new RegExp(asString(sep)));
    return dataArray(typeof limit === 'number' ? parts.slice(0, limit) : parts);
  },
  join: (value, sep) => toArray(value).map(asString).join(sep === undefined ? ', ' : asString(sep)),
  padleft: (value, len, pad) => asString(value).padStart(Number(len), pad ? asString(pad) : ' '),
  padright: (value, len, pad) => asString(value).padEnd(Number(len), pad ? asString(pad) : ' '),
  substring: (value, start, end) =>
    end === undefined
      ? asString(value).substring(Number(start))
      : asString(value).substring(Number(start), Number(end)),
  truncate: (value, len, suffix) => {
    const text = asString(value);
    const n = Number(len);
    return text.length <= n ? text : text.slice(0, Math.max(0, n - 3)) + (suffix ? asString(suffix) : '...');
  },

  // --- collections ---------------------------------------------------------
  length: (value) => {
    if (value === null || value === undefined) return 0;
    if (isDataArray(value)) return value.length;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string') return value.length;
    if (typeof value === 'object') return Object.keys(value as object).length;
    return 0;
  },
  sum: (value) => toArray(value).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0),
  average: (value) => {
    const nums = toArray(value).filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  },
  min: (...args) => {
    const values = args.length === 1 ? toArray(args[0]) : args;
    return values.length ? values.reduce((a, b) => (compare(a, b) <= 0 ? a : b)) : null;
  },
  max: (...args) => {
    const values = args.length === 1 ? toArray(args[0]) : args;
    return values.length ? values.reduce((a, b) => (compare(a, b) >= 0 ? a : b)) : null;
  },
  first: (value) => toArray(value)[0] ?? null,
  last: (value) => {
    const arr = toArray(value);
    return arr[arr.length - 1] ?? null;
  },
  reverse: (value) => dataArray([...toArray(value)].reverse()),
  sort: (value) => dataArray([...toArray(value)].sort(compare)),
  flat: (value, depth) => dataArray(toArray(value).flat(depth === undefined ? 1 : Number(depth)) as unknown[]),
  filter: (value, fn) => dataArray(toArray(value).filter((v) => truthy(callLambda(fn, [v])))),
  map: (value, fn) => dataArray(toArray(value).map((v) => callLambda(fn, [v]))),
  any: (value, fn) =>
    fn === undefined
      ? toArray(value).some(truthy)
      : toArray(value).some((v) => truthy(callLambda(fn, [v]))),
  all: (value, fn) =>
    fn === undefined
      ? toArray(value).every(truthy)
      : toArray(value).every((v) => truthy(callLambda(fn, [v]))),
  none: (value, fn) =>
    fn === undefined
      ? !toArray(value).some(truthy)
      : !toArray(value).some((v) => truthy(callLambda(fn, [v]))),
  unique: (value) => {
    const seen = new Set<string>();
    return dataArray(
      toArray(value).filter((v) => {
        const key = asString(v);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    );
  },
  nonnull: (value) => dataArray(toArray(value).filter((v) => v !== null && v !== undefined)),

  /** `list(a, b, c)` / `array(a, b, c)` — literal collections. */
  list: (...args) => dataArray(args),
  array: (...args) => dataArray(args),
  object: (...args) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < args.length; i += 2) out[asString(args[i])] = args[i + 1];
    return out;
  },

  // --- types / conversion ---------------------------------------------------
  number: (value) => {
    if (typeof value === 'number') return value;
    const m = asString(value).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  },
  string: (value) => asString(value),
  typeof: (value) => typeOf(value),
  default: (value, fallback) => (value === null || value === undefined ? fallback : value),
  ldefault: (value, fallback) => (value === null || value === undefined ? fallback : value),
  choice: (condition, ifTrue, ifFalse) => (truthy(condition) ? ifTrue : ifFalse),
  round: (value, digits) => {
    const n = Number(value);
    if (Number.isNaN(n)) return null;
    const d = digits === undefined ? 0 : Number(digits);
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
  },
  floor: (value) => Math.floor(Number(value)),
  ceil: (value) => Math.ceil(Number(value)),
  abs: (value) => Math.abs(Number(value)),

  // --- dates ----------------------------------------------------------------
  date: (value, format) => {
    if (typeof format === 'string' && typeof value === 'string') {
      const parsed = DateTime.fromFormat(value, format);
      return parsed.isValid ? parsed : null;
    }
    return parseDate(value);
  },
  dur: (value) => parseDuration(value),
  duration: (value) => parseDuration(value),
  dateformat: (value, format) => {
    const d = parseDate(value);
    return d ? d.toFormat(asString(format)) : null;
  },
  durationformat: (value, format) => {
    const d = parseDuration(value);
    return d ? d.toFormat(asString(format)) : null;
  },
  striptime: (value) => {
    const d = parseDate(value);
    return d ? d.startOf('day') : null;
  },

  // --- links ----------------------------------------------------------------
  link: (target, display) => {
    if (target instanceof Link) return display ? target.withDisplay(asString(display)) : target;
    return new Link(
      asString(target),
      display === undefined ? undefined : asString(display),
      undefined,
      'file',
      false,
      false
    );
  },
  embed: (target, embed) => {
    if (target instanceof Link) {
      const copy = target.withDisplay(target.display);
      copy.embed = embed === undefined ? true : truthy(embed);
      return copy;
    }
    return target;
  },
  elink: (url, display) => {
    const href = asString(url);
    return `<a href="${escapeHtml(href)}" class="external-link">${escapeHtml(
      display === undefined ? href : asString(display)
    )}</a>`;
  },

  // --- misc -----------------------------------------------------------------
  meta: (value) => value,
  extract: (obj, ...keys) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[asString(key)] = (obj as Record<string, unknown> | null)?.[asString(key)] ?? null;
    }
    return out;
  }
};

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) return a.toMillis() - b.toMillis();
  return asString(a).localeCompare(asString(b));
}

export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (isDataArray(value)) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
