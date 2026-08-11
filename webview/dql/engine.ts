import { DateTime, Duration } from 'luxon';
import type { Expr, Query, Source } from './ast';
import { parseQuery } from './parser';
import { FUNCTIONS, truthy } from './functions';
import {
  compareValues,
  dataArray,
  DataArray,
  isDataArray,
  Link,
  valueEquals
} from '../dataview/values';
import type { PageIndex, PageValue, TaskValue } from '../dataview/pages';

export interface EvalContext {
  /** The row currently being evaluated: a page, a task, or a flattened row. */
  row: Record<string, unknown>;
  /** The note the query lives in, exposed as `this`. */
  current: PageValue | null;
  index: PageIndex;
  /** Extra bindings introduced by FLATTEN / GROUP BY / lambdas. */
  locals: Record<string, unknown>;
}

const DATE_KEYWORDS = new Set([
  'today',
  'now',
  'tomorrow',
  'yesterday',
  'sow',
  'eow',
  'som',
  'eom',
  'soy',
  'eoy'
]);

export function evaluate(expr: Expr, ctx: EvalContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'tag':
      return expr.value;

    case 'link': {
      const resolved = ctx.index.resolvePath(expr.target, ctx.current?.file.path ?? '');
      return new Link(
        resolved ?? expr.target,
        expr.display,
        expr.subpath,
        expr.subpath ? 'header' : 'file',
        false,
        resolved !== null
      );
    }

    case 'variable': {
      const name = expr.name;
      if (name === 'this') return ctx.current;
      if (Object.prototype.hasOwnProperty.call(ctx.locals, name)) return ctx.locals[name];
      if (Object.prototype.hasOwnProperty.call(ctx.row, name)) return ctx.row[name];
      // Bare `completed` on a TASK query, `file` on a page, etc.
      const fromFile = (ctx.row as { file?: Record<string, unknown> }).file;
      if (fromFile && Object.prototype.hasOwnProperty.call(fromFile, name)) return fromFile[name];
      // Date keywords are bare identifiers in DQL: `date(today) - dur(7 days)`.
      // Checked last so a real field named `today` still takes precedence.
      if (DATE_KEYWORDS.has(name.toLowerCase())) return name.toLowerCase();
      return null;
    }

    case 'field': {
      const obj = evaluate(expr.object, ctx);
      return readField(obj, expr.name);
    }

    case 'index': {
      const obj = evaluate(expr.object, ctx);
      const key = evaluate(expr.index, ctx);
      if (typeof key === 'number') {
        if (isDataArray(obj)) return obj.values[key] ?? null;
        if (Array.isArray(obj)) return obj[key] ?? null;
        return null;
      }
      return readField(obj, String(key));
    }

    case 'list':
      return dataArray(expr.items.map((item) => evaluate(item, ctx)));

    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of expr.entries) out[key] = evaluate(value, ctx);
      return out;
    }

    case 'lambda':
      return (...args: unknown[]) => {
        const locals = { ...ctx.locals };
        expr.params.forEach((p, i) => (locals[p] = args[i]));
        return evaluate(expr.body, { ...ctx, locals });
      };

    case 'call': {
      const fn = FUNCTIONS[expr.name];
      if (!fn) throw new Error(`Unknown function "${expr.name}()"`);
      const args = expr.args.map((a) => evaluate(a, ctx));
      return fn(...args);
    }

    case 'unary': {
      const value = evaluate(expr.operand, ctx);
      if (expr.op === '!') return !truthy(value);
      if (typeof value === 'number') return -value;
      if (Duration.isDuration(value)) return value.negate();
      return null;
    }

    case 'binary':
      return evaluateBinary(expr.op, expr.left, expr.right, ctx);
  }
}

function readField(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) return null;

  if (isDataArray(obj)) {
    // Field access over a DataArray maps, matching dv's behaviour.
    return (obj as unknown as Record<string, unknown>)[name];
  }

  if (DateTime.isDateTime(obj)) {
    const dt = obj as unknown as Record<string, unknown>;
    return name in dt ? dt[name] : null;
  }

  if (Duration.isDuration(obj)) {
    const d = obj as unknown as Record<string, unknown>;
    return name in d ? d[name] : null;
  }

  if (obj instanceof Link) {
    if (name === 'path') return obj.path;
    if (name === 'display') return obj.display ?? null;
    if (name === 'subpath') return obj.subpath ?? null;
    if (name === 'type') return obj.type;
    if (name === 'embed') return obj.embed;
    return null;
  }

  if (Array.isArray(obj)) {
    return dataArray(obj.map((v) => readField(v, name)));
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    if (name in record) return record[name];
    // `page.name` should fall through to `page.file.name`, which is how
    // Dataview lets you write `sort name` on a TABLE.
    const file = record.file as Record<string, unknown> | undefined;
    if (file && name in file) return file[name];
    return null;
  }

  return null;
}

function evaluateBinary(
  op: string,
  leftExpr: Expr,
  rightExpr: Expr,
  ctx: EvalContext
): unknown {
  // Short-circuit before evaluating the right operand.
  if (op === 'and') {
    const left = evaluate(leftExpr, ctx);
    return truthy(left) ? truthy(evaluate(rightExpr, ctx)) : false;
  }
  if (op === 'or') {
    const left = evaluate(leftExpr, ctx);
    return truthy(left) ? true : truthy(evaluate(rightExpr, ctx));
  }

  const left = evaluate(leftExpr, ctx);
  const right = evaluate(rightExpr, ctx);

  switch (op) {
    case '=':
      return valueEquals(left, right);
    case '!=':
      return !valueEquals(left, right);
    case '<':
      return compareValues(left, right) < 0;
    case '>':
      return compareValues(left, right) > 0;
    case '<=':
      return compareValues(left, right) <= 0;
    case '>=':
      return compareValues(left, right) >= 0;
    case '+':
      return addValues(left, right);
    case '-':
      return subtractValues(left, right);
    case '*':
      return numericOp(left, right, (a, b) => a * b);
    case '/':
      return numericOp(left, right, (a, b) => (b === 0 ? null : a / b));
    case '%':
      return numericOp(left, right, (a, b) => (b === 0 ? null : a % b));
    default:
      return null;
  }
}

function addValues(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (DateTime.isDateTime(left) && Duration.isDuration(right)) return left.plus(right);
  if (Duration.isDuration(left) && DateTime.isDateTime(right)) return right.plus(left);
  if (Duration.isDuration(left) && Duration.isDuration(right)) return left.plus(right);
  if (isDataArray(left) || Array.isArray(left)) {
    const l = isDataArray(left) ? left.values : (left as unknown[]);
    const r = isDataArray(right) ? right.values : Array.isArray(right) ? right : [right];
    return dataArray([...l, ...r]);
  }
  if (left === null || left === undefined) return right;
  if (right === null || right === undefined) return left;
  return String(left) + String(right);
}

function subtractValues(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (DateTime.isDateTime(left) && DateTime.isDateTime(right)) return left.diff(right);
  if (DateTime.isDateTime(left) && Duration.isDuration(right)) return left.minus(right);
  if (Duration.isDuration(left) && Duration.isDuration(right)) return left.minus(right);
  return null;
}

function numericOp(
  left: unknown,
  right: unknown,
  fn: (a: number, b: number) => number | null
): unknown {
  if (typeof left === 'number' && typeof right === 'number') return fn(left, right);
  if (Duration.isDuration(left) && typeof right === 'number') {
    const result = fn(left.toMillis(), right);
    return result === null ? null : Duration.fromMillis(result);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

function matchesSource(page: PageValue, source: Source, index: PageIndex, from: string): boolean {
  switch (source.kind) {
    case 'empty':
      return true;

    case 'folder': {
      const folder = source.path.replace(/\/+$/, '');
      if (folder === '' || folder === '/') return true;
      // Prefix match on a path boundary. A substring match here is a real bug:
      // FROM "notes" must not pull in "my-notes-archive/".
      return page.file.path === folder || page.file.path.startsWith(folder + '/');
    }

    case 'tag': {
      const want = source.tag.toLowerCase();
      return page.file.tags.values.some((t) => String(t).toLowerCase() === want);
    }

    case 'link-to': {
      // FROM [[X]] — notes that link TO X.
      const target = index.resolvePath(source.target, from) ?? source.target;
      return page.file.outlinks.values.some((l) => l.path === target);
    }

    case 'link-from': {
      // FROM outgoing([[X]]) — notes that X links to.
      const target = index.resolvePath(source.target, from) ?? source.target;
      const targetPage = index.get(target);
      if (!targetPage) return false;
      return targetPage.file.outlinks.values.some((l) => l.path === page.file.path);
    }

    case 'and':
      return (
        matchesSource(page, source.left, index, from) &&
        matchesSource(page, source.right, index, from)
      );

    case 'or':
      return (
        matchesSource(page, source.left, index, from) ||
        matchesSource(page, source.right, index, from)
      );

    case 'negate':
      return !matchesSource(page, source.source, index, from);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface TableResult {
  type: 'table';
  headers: string[];
  rows: unknown[][];
}
export interface ListResult {
  type: 'list';
  items: Array<{ primary: unknown; value: unknown | null }>;
}
export interface TaskResult {
  type: 'task';
  tasks: TaskValue[];
}
export interface GroupedResult {
  type: 'grouped';
  groups: Array<{ key: unknown; result: QueryResult }>;
}
export type QueryResult = TableResult | ListResult | TaskResult | GroupedResult;

interface Row {
  data: Record<string, unknown>;
  page: PageValue;
}

export function executeQuery(
  source: string,
  index: PageIndex,
  current: PageValue | null
): QueryResult {
  const query = parseQuery(source);
  return runQuery(query, index, current);
}

function runQuery(query: Query, index: PageIndex, current: PageValue | null): QueryResult {
  const from = current?.file.path ?? '';

  let rows: Row[] = index
    .all()
    .filter((page) => matchesSource(page, query.source, index, from))
    .map((page) => ({ data: page as Record<string, unknown>, page }));

  // TASK queries operate on the task rows, not the page rows. Tasks inherit
  // their page's fields, so `file.link`, `status` and frontmatter all resolve
  // from a task row the way they do in Dataview.
  if (query.type === 'TASK') {
    const taskRows: Row[] = [];
    for (const row of rows) {
      const pageFields = row.page as Record<string, unknown>;
      for (const task of row.page.file.tasks.values) {
        taskRows.push({
          data: { ...pageFields, ...(task as unknown as Record<string, unknown>) },
          page: row.page
        });
      }
    }
    rows = taskRows;
  }

  let groupKeyExpr: { expr: Expr; as: string } | null = null;
  let grouped: Array<{ key: unknown; rows: Row[] }> | null = null;

  const mkCtx = (row: Row, locals: Record<string, unknown> = {}): EvalContext => ({
    row: row.data,
    current,
    index,
    locals
  });

  /**
   * Context for a whole group. After GROUP BY, Dataview exposes `rows` (the
   * grouped items) plus the key under its label, and later clauses operate on
   * groups rather than on the underlying rows.
   */
  const mkGroupCtx = (group: { key: unknown; rows: Row[] }): EvalContext => {
    const locals: Record<string, unknown> = {
      rows: dataArray(group.rows.map((r) => r.data)),
      key: group.key
    };
    if (groupKeyExpr) locals[groupKeyExpr.as] = group.key;
    return {
      row: (group.rows[0]?.data ?? {}) as Record<string, unknown>,
      current,
      index,
      locals
    };
  };

  for (const clause of query.clauses) {
    switch (clause.kind) {
      case 'where': {
        if (grouped) {
          // After GROUP BY, WHERE filters groups, not their contents.
          grouped = grouped.filter((g) => {
            try {
              return truthy(evaluate(clause.expr, mkGroupCtx(g)));
            } catch {
              return false;
            }
          });
        } else {
          rows = rows.filter((row) => {
            try {
              return truthy(evaluate(clause.expr, mkCtx(row)));
            } catch {
              return false;
            }
          });
        }
        break;
      }

      case 'flatten': {
        const apply = (list: Row[]) => {
          const out: Row[] = [];
          for (const row of list) {
            const value = evaluate(clause.expr, mkCtx(row));
            const items = isDataArray(value)
              ? value.values
              : Array.isArray(value)
                ? value
                : [value];
            if (items.length === 0) {
              out.push({ ...row, data: { ...row.data, [clause.as]: null } });
              continue;
            }
            for (const item of items) {
              out.push({ ...row, data: { ...row.data, [clause.as]: item } });
            }
          }
          return out;
        };
        if (grouped) grouped = grouped.map((g) => ({ ...g, rows: apply(g.rows) }));
        else rows = apply(rows);
        break;
      }

      case 'sort': {
        if (grouped) {
          // After GROUP BY, SORT orders the groups — this is what makes
          // `GROUP BY type SORT length(rows) DESC` mean what it reads like.
          grouped = [...grouped].sort((a, b) => {
            for (const key of clause.keys) {
              const av = safeEval(key.expr, mkGroupCtx(a));
              const bv = safeEval(key.expr, mkGroupCtx(b));
              const cmp = compareValues(av, bv) * (key.direction === 'desc' ? -1 : 1);
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        } else {
          rows = [...rows].sort((a, b) => {
            for (const key of clause.keys) {
              const av = safeEval(key.expr, mkCtx(a));
              const bv = safeEval(key.expr, mkCtx(b));
              const cmp = compareValues(av, bv) * (key.direction === 'desc' ? -1 : 1);
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        }
        break;
      }

      case 'group': {
        groupKeyExpr = { expr: clause.expr, as: clause.as };
        const buckets = new Map<string, { key: unknown; rows: Row[] }>();
        for (const row of rows) {
          const key = safeEval(clause.expr, mkCtx(row));
          const id = JSON.stringify(keyId(key));
          let bucket = buckets.get(id);
          if (!bucket) buckets.set(id, (bucket = { key, rows: [] }));
          bucket.rows.push(row);
        }
        grouped = [...buckets.values()].sort((a, b) => compareValues(a.key, b.key));
        break;
      }

      case 'limit': {
        if (grouped) grouped = grouped.slice(0, clause.count);
        else rows = rows.slice(0, clause.count);
        break;
      }
    }
  }

  const project = (list: Row[], groupKey?: unknown): QueryResult => {
    const locals: Record<string, unknown> =
      groupKeyExpr && groupKey !== undefined
        ? { [groupKeyExpr.as]: groupKey, key: groupKey, rows: dataArray(list.map((r) => r.data)) }
        : {};

    switch (query.type) {
      case 'TASK':
        return { type: 'task', tasks: list.map((r) => r.data as unknown as TaskValue) };

      case 'LIST': {
        return {
          type: 'list',
          items: list.map((row) => ({
            primary: row.page.file.link,
            value:
              query.fields.length > 0
                ? safeEval(query.fields[0].expr, mkCtx(row, locals))
                : null
          }))
        };
      }

      case 'CALENDAR':
      case 'TABLE': {
        const headers = query.withoutId
          ? query.fields.map((f) => f.label)
          : ['File', ...query.fields.map((f) => f.label)];
        const dataRows = list.map((row) => {
          const cells = query.fields.map((f) => safeEval(f.expr, mkCtx(row, locals)));
          return query.withoutId ? cells : [row.page.file.link, ...cells];
        });
        return { type: 'table', headers, rows: dataRows };
      }
    }
  };

  if (grouped) {
    // A grouped TABLE collapses to one table whose first column is the group
    // key, rather than a stack of nested tables.
    if (query.type === 'TABLE' || query.type === 'CALENDAR') {
      const keyLabel = groupKeyExpr?.as ?? 'Group';
      const headers = query.withoutId
        ? query.fields.map((f) => f.label)
        : [keyLabel, ...query.fields.map((f) => f.label)];
      const dataRows = grouped.map((g) => {
        const ctx = mkGroupCtx(g);
        const cells = query.fields.map((f) => safeEval(f.expr, ctx));
        return query.withoutId ? cells : [g.key, ...cells];
      });
      return { type: 'table', headers, rows: dataRows };
    }

    return {
      type: 'grouped',
      groups: grouped.map((g) => ({ key: g.key, result: project(g.rows, g.key) }))
    };
  }

  return project(rows);
}

function safeEval(expr: Expr, ctx: EvalContext): unknown {
  try {
    return evaluate(expr, ctx);
  } catch {
    return null;
  }
}

function keyId(value: unknown): unknown {
  if (value instanceof Link) return `link:${value.path}`;
  if (DateTime.isDateTime(value)) return `date:${value.toMillis()}`;
  if (isDataArray(value)) return value.values.map(keyId);
  return value;
}
