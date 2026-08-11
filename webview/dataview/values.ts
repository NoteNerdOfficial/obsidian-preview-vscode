import { DateTime, Duration } from 'luxon';

/** A resolved (or unresolved) link to a note, matching Dataview's Link. */
export class Link {
  constructor(
    public path: string,
    public display: string | undefined,
    public subpath: string | undefined,
    public type: 'file' | 'header' | 'block',
    public embed: boolean,
    public resolved: boolean
  ) {}

  static file(path: string, embed = false, display?: string): Link {
    return new Link(path, display, undefined, 'file', embed, true);
  }

  get fileName(): string {
    const base = this.path.slice(this.path.lastIndexOf('/') + 1);
    return base.replace(/\.md$/i, '');
  }

  withDisplay(display?: string): Link {
    return new Link(this.path, display, this.subpath, this.type, this.embed, this.resolved);
  }

  equals(other: unknown): boolean {
    return other instanceof Link && other.path === this.path && other.subpath === this.subpath;
  }

  toString(): string {
    const inner = this.subpath ? `${this.path}#${this.subpath}` : this.path;
    return this.display ? `[[${inner}|${this.display}]]` : `[[${inner}]]`;
  }

  /** Markdown source Obsidian would produce, used when rendering into cells. */
  markdown(): string {
    return this.toString();
  }
}

export type DataValue = unknown;

/** Dataview's comparison order across mixed types. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;

  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return ta < tb ? -1 : 1;

  switch (ta) {
    case 'number':
      return (a as number) - (b as number);
    case 'boolean':
      return (a === b ? 0 : a ? 1 : -1) as number;
    case 'string':
      return (a as string).localeCompare(b as string);
    case 'date':
      return (a as DateTime).toMillis() - (b as DateTime).toMillis();
    case 'duration':
      return (a as Duration).toMillis() - (b as Duration).toMillis();
    case 'link':
      return (a as Link).path.localeCompare((b as Link).path);
    case 'array': {
      const aa = a as unknown[];
      const ba = b as unknown[];
      for (let i = 0; i < Math.min(aa.length, ba.length); i++) {
        const c = compareValues(aa[i], ba[i]);
        if (c !== 0) return c;
      }
      return aa.length - ba.length;
    }
    default:
      return String(a).localeCompare(String(b));
  }
}

export function typeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isDataArray(value)) return 'array';
  if (DateTime.isDateTime(value)) return 'date';
  if (Duration.isDuration(value)) return 'duration';
  if (value instanceof Link) return 'link';
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    default:
      return 'object';
  }
}

export function valueEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Link || b instanceof Link) {
    if (a instanceof Link && b instanceof Link) return a.equals(b);
    // Comparing a link against a string matches on path or basename, which is
    // what `owner = [[Alice]]` against a plain-text field needs to do.
    const link = (a instanceof Link ? a : b) as Link;
    const other = a instanceof Link ? b : a;
    if (typeof other === 'string') {
      return (
        other === link.path || other === link.fileName || other === link.display
      );
    }
    return false;
  }
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) return a.toMillis() === b.toMillis();
  if (Duration.isDuration(a) && Duration.isDuration(b)) return a.toMillis() === b.toMillis();
  return compareValues(a, b) === 0;
}

// ---------------------------------------------------------------------------
// DataArray
// ---------------------------------------------------------------------------

const DATA_ARRAY_MARKER = Symbol.for('obsidian-preview.dataarray');

export interface DataArray<T = unknown> extends Iterable<T> {
  [index: number]: T;
  readonly length: number;
  readonly values: T[];

  where(predicate: (value: T, index: number) => boolean): DataArray<T>;
  filter(predicate: (value: T, index: number) => boolean): DataArray<T>;
  map<U>(fn: (value: T, index: number) => U): DataArray<U>;
  flatMap<U>(fn: (value: T, index: number) => U[] | DataArray<U>): DataArray<U>;
  mutate(fn: (value: T) => void): DataArray<T>;
  sort<K>(key?: (value: T) => K, direction?: 'asc' | 'desc', comparator?: (a: K, b: K) => number): DataArray<T>;
  groupBy<K>(key: (value: T) => K): DataArray<{ key: K; rows: DataArray<T> }>;
  distinct<K>(key?: (value: T) => K): DataArray<T>;
  every(predicate: (value: T) => boolean): boolean;
  some(predicate: (value: T) => boolean): boolean;
  none(predicate: (value: T) => boolean): boolean;
  first(): T | undefined;
  last(): T | undefined;
  to(key: string): DataArray<unknown>;
  into(key: string): unknown;
  limit(count: number): DataArray<T>;
  slice(start?: number, end?: number): DataArray<T>;
  concat(other: DataArray<T> | T[]): DataArray<T>;
  indexOf(value: T): number;
  find(predicate: (value: T) => boolean): T | undefined;
  findIndex(predicate: (value: T) => boolean): number;
  includes(value: T): boolean;
  join(separator?: string): string;
  reverse(): DataArray<T>;
  sum(): number;
  avg(): number;
  min(): T | undefined;
  max(): T | undefined;
  forEach(fn: (value: T, index: number) => void): void;
  reduce<U>(fn: (acc: U, value: T, index: number) => U, initial: U): U;
  array(): T[];
}

class DataArrayImpl<T> {
  constructor(public readonly values: T[]) {}

  get length(): number {
    return this.values.length;
  }

  where(predicate: (value: T, index: number) => boolean): DataArray<T> {
    return dataArray(this.values.filter((v, i) => predicate(v, i)));
  }
  filter(predicate: (value: T, index: number) => boolean): DataArray<T> {
    return this.where(predicate);
  }
  map<U>(fn: (value: T, index: number) => U): DataArray<U> {
    return dataArray(this.values.map((v, i) => fn(v, i)));
  }
  flatMap<U>(fn: (value: T, index: number) => U[] | DataArray<U>): DataArray<U> {
    const out: U[] = [];
    this.values.forEach((v, i) => {
      const r = fn(v, i);
      if (r === null || r === undefined) return;
      out.push(...(isDataArray(r) ? (r as DataArray<U>).values : (r as U[])));
    });
    return dataArray(out);
  }
  mutate(fn: (value: T) => void): DataArray<T> {
    this.values.forEach((v) => fn(v));
    return dataArray(this.values);
  }
  sort<K>(
    key?: (value: T) => K,
    direction: 'asc' | 'desc' = 'asc',
    comparator?: (a: K, b: K) => number
  ): DataArray<T> {
    const keyFn = key ?? ((v: T) => v as unknown as K);
    const cmp = comparator ?? ((a: K, b: K) => compareValues(a, b));
    const sign = direction === 'desc' ? -1 : 1;
    // Copy first: Dataview's sort is non-mutating, and callers reuse arrays.
    return dataArray([...this.values].sort((a, b) => sign * cmp(keyFn(a), keyFn(b))));
  }
  groupBy<K>(key: (value: T) => K): DataArray<{ key: K; rows: DataArray<T> }> {
    const groups = new Map<string, { key: K; rows: T[] }>();
    for (const value of this.values) {
      const k = key(value);
      // Structural key so DateTimes and Links group correctly rather than by
      // object identity.
      const id = groupKey(k);
      let bucket = groups.get(id);
      if (!bucket) groups.set(id, (bucket = { key: k, rows: [] }));
      bucket.rows.push(value);
    }
    const out = [...groups.values()]
      .map((g) => ({ key: g.key, rows: dataArray(g.rows) }))
      .sort((a, b) => compareValues(a.key, b.key));
    return dataArray(out);
  }
  distinct<K>(key?: (value: T) => K): DataArray<T> {
    const keyFn = key ?? ((v: T) => v as unknown as K);
    const seen = new Set<string>();
    const out: T[] = [];
    for (const value of this.values) {
      const id = groupKey(keyFn(value));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(value);
    }
    return dataArray(out);
  }
  every(predicate: (value: T) => boolean): boolean {
    return this.values.every((v) => predicate(v));
  }
  some(predicate: (value: T) => boolean): boolean {
    return this.values.some((v) => predicate(v));
  }
  none(predicate: (value: T) => boolean): boolean {
    return !this.values.some((v) => predicate(v));
  }
  first(): T | undefined {
    return this.values[0];
  }
  last(): T | undefined {
    return this.values[this.values.length - 1];
  }
  to(key: string): DataArray<unknown> {
    const out: unknown[] = [];
    for (const value of this.values) {
      const field = (value as Record<string, unknown> | null)?.[key];
      if (field === null || field === undefined) continue;
      if (Array.isArray(field)) out.push(...field);
      else if (isDataArray(field)) out.push(...(field as DataArray).values);
      else out.push(field);
    }
    return dataArray(out);
  }
  into(key: string): unknown {
    const parts = key.split('.');
    let current: unknown = this.values;
    for (const part of parts) {
      current = (current as Record<string, unknown> | null)?.[part];
    }
    return current;
  }
  limit(count: number): DataArray<T> {
    return dataArray(this.values.slice(0, count));
  }
  slice(start?: number, end?: number): DataArray<T> {
    return dataArray(this.values.slice(start, end));
  }
  concat(other: DataArray<T> | T[]): DataArray<T> {
    const rhs = isDataArray(other) ? (other as DataArray<T>).values : (other as T[]);
    return dataArray(this.values.concat(rhs));
  }
  indexOf(value: T): number {
    return this.values.findIndex((v) => valueEquals(v, value));
  }
  find(predicate: (value: T) => boolean): T | undefined {
    return this.values.find((v) => predicate(v));
  }
  findIndex(predicate: (value: T) => boolean): number {
    return this.values.findIndex((v) => predicate(v));
  }
  includes(value: T): boolean {
    return this.indexOf(value) >= 0;
  }
  join(separator = ', '): string {
    return this.values.map((v) => stringifyValue(v)).join(separator);
  }
  reverse(): DataArray<T> {
    return dataArray([...this.values].reverse());
  }
  sum(): number {
    return this.values.reduce<number>((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
  }
  avg(): number {
    return this.values.length ? this.sum() / this.values.length : 0;
  }
  min(): T | undefined {
    return this.values.length
      ? this.values.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b))
      : undefined;
  }
  max(): T | undefined {
    return this.values.length
      ? this.values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b))
      : undefined;
  }
  forEach(fn: (value: T, index: number) => void): void {
    this.values.forEach((v, i) => fn(v, i));
  }
  reduce<U>(fn: (acc: U, value: T, index: number) => U, initial: U): U {
    return this.values.reduce((acc, v, i) => fn(acc, v, i), initial);
  }
  array(): T[] {
    return [...this.values];
  }
  [Symbol.iterator](): Iterator<T> {
    return this.values[Symbol.iterator]();
  }
  toString(): string {
    return `DataArray(${this.values.length})`;
  }
}

const IMPL_KEYS = new Set<string | symbol>([
  ...Object.getOwnPropertyNames(DataArrayImpl.prototype),
  'values',
  'length',
  Symbol.iterator
]);

/**
 * Wrap in a Proxy so unknown property access maps over the elements:
 * `pages.file.name` yields a DataArray of names. This is the behaviour most
 * real snippets depend on, and it is exactly what a plain class cannot give.
 */
export function dataArray<T>(values: T[]): DataArray<T> {
  const impl = new DataArrayImpl<T>(values);
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop === DATA_ARRAY_MARKER) return true;
      if (IMPL_KEYS.has(prop) || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);

      // `await someDataArray` must not hang. Without this trap the Promise
      // machinery sees a truthy `.then` produced by field mapping and waits
      // on a thenable that never settles.
      if (prop === 'then') return undefined;

      if (/^-?\d+$/.test(prop)) {
        const i = Number(prop);
        return i < 0 ? target.values[target.values.length + i] : target.values[i];
      }

      return dataArray(
        target.values.map((v) => {
          const record = v as Record<string, unknown> | null | undefined;
          return record === null || record === undefined ? null : record[prop];
        })
      );
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^-?\d+$/.test(prop)) return Number(prop) < target.length;
      return Reflect.has(target, prop);
    }
  }) as unknown as DataArray<T>;
}

export function isDataArray(value: unknown): value is DataArray {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[DATA_ARRAY_MARKER] === true
  );
}

function groupKey(value: unknown): string {
  if (value === null || value === undefined) return ' null';
  if (value instanceof Link) return ` link:${value.path}#${value.subpath ?? ''}`;
  if (DateTime.isDateTime(value)) return ` date:${value.toMillis()}`;
  if (Duration.isDuration(value)) return ` dur:${value.toMillis()}`;
  if (isDataArray(value)) return ` arr:[${value.values.map(groupKey).join(',')}]`;
  if (Array.isArray(value)) return ` arr:[${value.map(groupKey).join(',')}]`;
  if (typeof value === 'object') {
    try {
      return ` obj:${JSON.stringify(value)}`;
    } catch {
      return ` obj:${String(value)}`;
    }
  }
  return `${typeof value}:${String(value)}`;
}

/** Plain-text rendering used by join(), string() and non-markdown contexts. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (DateTime.isDateTime(value)) {
    return value.hour === 0 && value.minute === 0 && value.second === 0
      ? value.toFormat('yyyy-MM-dd')
      : value.toFormat('yyyy-MM-dd HH:mm');
  }
  if (Duration.isDuration(value)) return value.toHuman({ unitDisplay: 'short' });
  if (value instanceof Link) return value.display ?? value.fileName;
  if (isDataArray(value)) return value.values.map(stringifyValue).join(', ');
  if (Array.isArray(value)) return value.map(stringifyValue).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
