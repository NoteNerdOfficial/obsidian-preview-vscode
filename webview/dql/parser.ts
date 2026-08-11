import { tokenize, Token } from './lexer';
import type { BinaryOp, Clause, Expr, NamedExpr, Query, Source } from './ast';

/** Binding powers for the Pratt expression parser. */
const BINARY_POWER: Record<string, number> = {
  or: 1,
  '||': 1,
  and: 2,
  '&&': 2,
  '=': 3,
  '!=': 3,
  '<>': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6
};

const NORMALIZE_OP: Record<string, BinaryOp> = {
  '||': 'or',
  '&&': 'and',
  '<>': '!='
};

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private at(type: Token['type'], value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  private atKeyword(...values: string[]): boolean {
    const t = this.peek();
    return t.type === 'keyword' && values.includes(t.value);
  }

  private expect(type: Token['type'], value?: string): Token {
    if (!this.at(type, value)) {
      const t = this.peek();
      throw new Error(
        `Expected ${value ?? type} but found "${t.value || t.type}" at position ${t.pos}`
      );
    }
    return this.next();
  }

  private accept(type: Token['type'], value?: string): boolean {
    if (this.at(type, value)) {
      this.next();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  parseQuery(): Query {
    let type: Query['type'] = 'LIST';
    let withoutId = false;

    if (this.atKeyword('table', 'list', 'task', 'calendar')) {
      type = this.next().value.toUpperCase() as Query['type'];
    }

    if (type === 'TABLE' && this.atKeyword('without')) {
      this.next();
      this.expect('keyword', 'id');
      withoutId = true;
    }

    const fields: NamedExpr[] = [];
    if (!this.atClauseBoundary() && !this.at('eof')) {
      do {
        fields.push(this.parseNamedExpr());
      } while (this.accept('punct', ','));
    }

    let source: Source = { kind: 'empty' };
    if (this.atKeyword('from')) {
      this.next();
      source = this.parseSource();
    }

    const clauses: Clause[] = [];
    while (!this.at('eof')) {
      clauses.push(this.parseClause());
    }

    return { type, withoutId, fields, source, clauses };
  }

  private atClauseBoundary(): boolean {
    return this.atKeyword('from', 'where', 'sort', 'group', 'flatten', 'limit');
  }

  private parseNamedExpr(): NamedExpr {
    const start = this.peek();
    const expr = this.parseExpr();
    let label = this.sourceTextFrom(start);
    if (this.atKeyword('as')) {
      this.next();
      const t = this.next();
      if (t.type !== 'string' && t.type !== 'ident' && t.type !== 'keyword') {
        throw new Error(`Expected a label after AS at position ${t.pos}`);
      }
      label = t.raw ?? t.value;
    }
    return { expr, label };
  }

  private sourceTextFrom(start: Token): string {
    // Reconstruct a readable default column header from the consumed tokens.
    const parts: string[] = [];
    for (let i = this.tokens.indexOf(start); i < this.pos; i++) {
      const t = this.tokens[i];
      if (t.type === 'string') parts.push(`"${t.value}"`);
      else if (t.type === 'link') parts.push(`[[${t.value}]]`);
      else parts.push(t.raw ?? t.value);
    }
    return parts
      .join(' ')
      .replace(/\s+\.\s+/g, '.')
      .replace(/\s+([,)\]])/g, '$1')
      .replace(/([([])\s+/g, '$1');
  }

  private parseClause(): Clause {
    if (this.atKeyword('where')) {
      this.next();
      return { kind: 'where', expr: this.parseExpr() };
    }

    if (this.atKeyword('sort')) {
      this.next();
      const keys: Array<{ expr: Expr; direction: 'asc' | 'desc' }> = [];
      do {
        const expr = this.parseExpr();
        let direction: 'asc' | 'desc' = 'asc';
        if (this.atKeyword('asc', 'desc')) {
          direction = this.next().value as 'asc' | 'desc';
        }
        keys.push({ expr, direction });
      } while (this.accept('punct', ','));
      return { kind: 'sort', keys };
    }

    if (this.atKeyword('group')) {
      this.next();
      this.expect('keyword', 'by');
      const start = this.peek();
      const expr = this.parseExpr();
      let as = this.sourceTextFrom(start);
      if (this.atKeyword('as')) {
        this.next();
        as = this.next().value;
      }
      return { kind: 'group', expr, as };
    }

    if (this.atKeyword('flatten')) {
      this.next();
      const start = this.peek();
      const expr = this.parseExpr();
      let as = this.sourceTextFrom(start);
      if (this.atKeyword('as')) {
        this.next();
        as = this.next().value;
      }
      return { kind: 'flatten', expr, as };
    }

    if (this.atKeyword('limit')) {
      this.next();
      const t = this.expect('number');
      return { kind: 'limit', count: Number(t.value) };
    }

    const t = this.peek();
    throw new Error(`Unexpected "${t.value || t.type}" at position ${t.pos}`);
  }

  // -------------------------------------------------------------------------
  // Source (FROM)
  // -------------------------------------------------------------------------

  private parseSource(): Source {
    return this.parseSourceOr();
  }

  private parseSourceOr(): Source {
    let left = this.parseSourceAnd();
    while (this.atKeyword('or')) {
      this.next();
      left = { kind: 'or', left, right: this.parseSourceAnd() };
    }
    return left;
  }

  private parseSourceAnd(): Source {
    let left = this.parseSourceUnary();
    while (this.atKeyword('and')) {
      this.next();
      left = { kind: 'and', left, right: this.parseSourceUnary() };
    }
    return left;
  }

  private parseSourceUnary(): Source {
    if (this.at('op', '-') || this.atKeyword('not')) {
      this.next();
      return { kind: 'negate', source: this.parseSourceUnary() };
    }
    return this.parseSourcePrimary();
  }

  private parseSourcePrimary(): Source {
    if (this.accept('punct', '(')) {
      const inner = this.parseSource();
      this.expect('punct', ')');
      return inner;
    }

    const t = this.peek();

    if (t.type === 'string') {
      this.next();
      return { kind: 'folder', path: t.value };
    }

    if (t.type === 'tag') {
      this.next();
      return { kind: 'tag', tag: t.value };
    }

    if (t.type === 'link') {
      this.next();
      return { kind: 'link-to', target: t.value.split('|')[0].trim() };
    }

    if (t.type === 'ident' && (t.value === 'outgoing' || t.value === 'incoming')) {
      this.next();
      this.expect('punct', '(');
      const inner = this.next();
      const target =
        inner.type === 'link' ? inner.value.split('|')[0].trim() : inner.value;
      this.expect('punct', ')');
      return t.value === 'outgoing'
        ? { kind: 'link-from', target }
        : { kind: 'link-to', target };
    }

    throw new Error(`Unexpected source "${t.value || t.type}" at position ${t.pos}`);
  }

  // -------------------------------------------------------------------------
  // Expressions (Pratt)
  // -------------------------------------------------------------------------

  parseExpr(minPower = 0): Expr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();
      const opValue =
        t.type === 'op' ? t.value : t.type === 'keyword' && (t.value === 'and' || t.value === 'or') ? t.value : null;
      if (!opValue) break;

      const power = BINARY_POWER[opValue];
      if (power === undefined || power < minPower) break;

      this.next();
      const right = this.parseExpr(power + 1);
      const op = (NORMALIZE_OP[opValue] ?? opValue) as BinaryOp;
      left = { kind: 'binary', op, left, right };
    }

    return left;
  }

  private parseUnary(): Expr {
    if (this.at('op', '!')) {
      this.next();
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    if (this.at('op', '-')) {
      this.next();
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    if (this.atKeyword('not')) {
      this.next();
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();

    for (;;) {
      if (this.accept('punct', '.')) {
        const t = this.next();
        if (t.type !== 'ident' && t.type !== 'keyword' && t.type !== 'number') {
          throw new Error(`Expected a field name after '.' at position ${t.pos}`);
        }
        expr = { kind: 'field', object: expr, name: t.raw ?? t.value };
        continue;
      }
      if (this.accept('punct', '[')) {
        const index = this.parseExpr();
        this.expect('punct', ']');
        expr = { kind: 'index', object: expr, index };
        continue;
      }
      if (this.at('punct', '(') && expr.kind === 'variable') {
        const name = expr.name.toLowerCase();
        this.next();

        // `dur(14 days)` is a duration literal, not an expression — `14 days`
        // has no valid parse. Capture the raw token text instead.
        if ((name === 'dur' || name === 'duration') && !this.isSimpleArgList()) {
          const raw = this.captureRawUntilCloseParen();
          expr = { kind: 'call', name, args: [{ kind: 'literal', value: raw }] };
          continue;
        }

        const args: Expr[] = [];
        if (!this.at('punct', ')')) {
          do {
            args.push(this.parseExpr());
          } while (this.accept('punct', ','));
        }
        this.expect('punct', ')');
        expr = { kind: 'call', name, args };
        continue;
      }
      break;
    }

    return expr;
  }

  /** True when the call's arguments are a single ordinary expression. */
  private isSimpleArgList(): boolean {
    const first = this.peek();
    const second = this.peek(1);
    if (first.type === 'string' && second.type === 'punct' && second.value === ')') return true;
    // A field reference like dur(someField) should still evaluate normally.
    if (first.type === 'ident' && second.type === 'punct' && (second.value === ')' || second.value === '.')) {
      return true;
    }
    return false;
  }

  /** Consume tokens up to the matching ')' and return their source text. */
  private captureRawUntilCloseParen(): string {
    const parts: string[] = [];
    let depth = 1;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') throw new Error('Unterminated argument list');
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) {
          this.next();
          break;
        }
      }
      this.next();
      parts.push(t.type === 'string' ? t.value : (t.raw ?? t.value));
    }
    return parts.join(' ');
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === 'number') {
      this.next();
      return { kind: 'literal', value: Number(t.value) };
    }

    if (t.type === 'string') {
      this.next();
      return { kind: 'literal', value: t.value };
    }

    if (t.type === 'tag') {
      this.next();
      return { kind: 'tag', value: t.value };
    }

    if (t.type === 'link') {
      this.next();
      const [targetPart, display] = t.value.split('|');
      const hash = targetPart.indexOf('#');
      return {
        kind: 'link',
        target: (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim(),
        subpath: hash >= 0 ? targetPart.slice(hash + 1).trim() : undefined,
        display: display?.trim()
      };
    }

    if (this.accept('punct', '(')) {
      const inner = this.parseExpr();
      this.expect('punct', ')');
      return inner;
    }

    if (this.accept('punct', '[')) {
      const items: Expr[] = [];
      if (!this.at('punct', ']')) {
        do {
          items.push(this.parseExpr());
        } while (this.accept('punct', ','));
      }
      this.expect('punct', ']');
      return { kind: 'list', items };
    }

    if (this.accept('punct', '{')) {
      const entries: Array<[string, Expr]> = [];
      if (!this.at('punct', '}')) {
        do {
          const key = this.next();
          this.expect('punct', ':');
          entries.push([key.raw ?? key.value, this.parseExpr()]);
        } while (this.accept('punct', ','));
      }
      this.expect('punct', '}');
      return { kind: 'object', entries };
    }

    if (t.type === 'ident' || t.type === 'keyword') {
      this.next();
      const name = t.raw ?? t.value;

      // Lambda: `(x) => expr` is handled above via parens; `x => expr` here.
      if (this.at('op', '=') && this.peek(1).type === 'op' && this.peek(1).value === '>') {
        this.next();
        this.next();
        return { kind: 'lambda', params: [name], body: this.parseExpr() };
      }

      if (name === 'true') return { kind: 'literal', value: true };
      if (name === 'false') return { kind: 'literal', value: false };
      if (name === 'null') return { kind: 'literal', value: null };

      return { kind: 'variable', name };
    }

    throw new Error(`Unexpected token "${t.value || t.type}" at position ${t.pos}`);
  }
}

export function parseQuery(source: string): Query {
  const parser = new Parser(source);
  const query = parser.parseQuery();
  return query;
}

export function parseExpression(source: string): Expr {
  const parser = new Parser(source);
  return parser.parseExpr();
}
