import * as yaml from 'js-yaml';
import { parseBaseExpr, type BaseExpr } from './expr';
import type { BaseDefinition, BaseFilter, BaseView, BaseViewType } from './types';

function compile(source: string, errors: string[], where: string): BaseExpr | null {
  try {
    return parseBaseExpr(source);
  } catch (err) {
    errors.push(`${where}: ${err instanceof Error ? err.message : String(err)} — ${source}`);
    return null;
  }
}

/**
 * `filters` accepts a bare string, a list of strings, or nested
 * and/or/not combinators.
 */
function parseFilter(node: unknown, errors: string[], where: string): BaseFilter | null {
  if (node === null || node === undefined) return null;

  if (typeof node === 'string') {
    return { kind: 'expr', source: node, expr: compile(node, errors, where) };
  }

  if (Array.isArray(node)) {
    const children = node
      .map((n) => parseFilter(n, errors, where))
      .filter((f): f is BaseFilter => f !== null);
    return children.length ? { kind: 'and', children } : null;
  }

  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    for (const key of ['and', 'or', 'not'] as const) {
      if (!(key in record)) continue;
      const raw = record[key];
      const list = Array.isArray(raw) ? raw : [raw];
      const children = list
        .map((n) => parseFilter(n, errors, where))
        .filter((f): f is BaseFilter => f !== null);
      if (!children.length) continue;
      if (key === 'not') return { kind: 'not', child: children.length === 1 ? children[0] : { kind: 'and', children } };
      return { kind: key, children };
    }
  }

  return null;
}

function parseSort(node: unknown): BaseView['sort'] {
  if (!node) return [];
  const list = Array.isArray(node) ? node : [node];
  const out: BaseView['sort'] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      out.push({ property: entry, direction: 'ASC' });
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const property = String(record.property ?? record.column ?? '');
      if (!property) continue;
      const dir = String(record.direction ?? 'ASC').toUpperCase();
      out.push({ property, direction: dir === 'DESC' ? 'DESC' : 'ASC' });
    }
  }
  return out;
}

function parseView(node: unknown, i: number, errors: string[]): BaseView | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;

  const rawType = String(record.type ?? 'table').toLowerCase();
  const type: BaseViewType =
    rawType === 'cards' ? 'cards' : rawType === 'list' ? 'list' : 'table';

  const name = String(record.name ?? `View ${i + 1}`);
  const order = Array.isArray(record.order) ? record.order.map((o) => String(o)) : [];

  let groupBy: BaseView['groupBy'] = null;
  const rawGroup = record.groupBy ?? record.group_by;
  if (typeof rawGroup === 'string') {
    groupBy = { property: rawGroup, direction: 'ASC' };
  } else if (rawGroup && typeof rawGroup === 'object') {
    const g = rawGroup as Record<string, unknown>;
    const property = String(g.property ?? '');
    if (property) {
      groupBy = {
        property,
        direction: String(g.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      };
    }
  }

  return {
    type,
    name,
    order,
    filters: parseFilter(record.filters, errors, `view "${name}" filter`),
    groupBy,
    sort: parseSort(record.sort),
    limit: record.limit === undefined ? null : Number(record.limit),
    image: record.image === undefined ? null : String(record.image)
  };
}

export function parseBase(source: string): BaseDefinition {
  const errors: string[] = [];

  let doc: Record<string, unknown>;
  try {
    const loaded = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    doc =
      loaded && typeof loaded === 'object' && !Array.isArray(loaded)
        ? (loaded as Record<string, unknown>)
        : {};
  } catch (err) {
    return {
      filters: null,
      formulas: new Map(),
      properties: new Map(),
      views: [],
      errors: [`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`]
    };
  }

  const formulas = new Map<string, { source: string; expr: BaseExpr | null; error?: string }>();
  if (doc.formulas && typeof doc.formulas === 'object') {
    for (const [key, value] of Object.entries(doc.formulas as Record<string, unknown>)) {
      const src = String(value);
      const before = errors.length;
      const expr = compile(src, errors, `formula "${key}"`);
      formulas.set(key, { source: src, expr, error: errors.length > before ? errors[errors.length - 1] : undefined });
    }
  }

  const properties = new Map<string, { displayName?: string }>();
  if (doc.properties && typeof doc.properties === 'object') {
    for (const [key, value] of Object.entries(doc.properties as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        properties.set(key, {
          displayName: v.displayName === undefined ? undefined : String(v.displayName)
        });
      } else {
        properties.set(key, {});
      }
    }
  }

  const rawViews = Array.isArray(doc.views) ? doc.views : [];
  const views = rawViews
    .map((v, i) => parseView(v, i, errors))
    .filter((v): v is BaseView => v !== null);

  // A base with no views still shows all matching notes as a table.
  if (views.length === 0) {
    views.push({
      type: 'table',
      name: 'All',
      order: ['file.name'],
      filters: null,
      groupBy: null,
      sort: [],
      limit: null,
      image: null
    });
  }

  return {
    filters: parseFilter(doc.filters, errors, 'base filter'),
    formulas,
    properties,
    views,
    errors
  };
}
