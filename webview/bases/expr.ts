/**
 * The Obsidian Bases expression language.
 *
 * Deliberately separate from the DQL parser: Bases uses `==` / `&&` / `||`,
 * treats `list` and `sort` as ordinary identifiers rather than query keywords,
 * and is method-oriented — `list("a").contains(x)`, `file.inFolder("R")`,
 * `(today() - date(created)).days`. Reusing the DQL lexer would misclassify
 * half of that as keywords.
 */

export type BaseExpr =
  | { kind: 'lit'; value: unknown }
  | { kind: 'ident'; name: string }
  | { kind: 'prop'; object: BaseExpr; name: string }
  | { kind: 'index'; object: BaseExpr; index: BaseExpr }
  | { kind: 'call'; callee: BaseExpr; args: BaseExpr[] }
  | { kind: 'unary'; op: '!' | '-'; operand: BaseExpr }
  | { kind: 'binary'; op: BinaryOp; left: BaseExpr; right: BaseExpr }
  | { kind: 'list'; items: BaseExpr[] }
  | { kind: 'lambda'; params: string[]; body: BaseExpr };

export type BinaryOp =
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '&&'
  | '||'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

interface Token {
  type: 'ident' | 'number' | 'string' | 'op' | 'punct' | 'eof';
  value: string;
  pos: number;
}

const MULTI_OPS = ['==', '!=', '>=', '<=', '&&', '||', '=>'];
const SINGLE_OPS = '+-*/%<>!';
const PUNCT = '(),.[]';

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          out += source[j++];
        }
      }
      if (j >= source.length) throw new Error(`Unterminated string at ${i}`);
      tokens.push({ type: 'string', value: out, pos: i });
      i = j + 1;
      continue;
    }

    if (/\d/.test(ch)) {
      let j = i;
      while (j < source.length && /[\d.]/.test(source[j])) j++;
      tokens.push({ type: 'number', value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (/[\p{L}_$]/u.test(ch)) {
      let j = i;
      while (j < source.length && /[\p{L}\p{N}_$]/u.test(source[j])) j++;
      tokens.push({ type: 'ident', value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    if (SINGLE_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }

    if (PUNCT.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i });
      i++;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}

const POWER: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
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

class BaseParser {
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
  private accept(type: Token['type'], value?: string): boolean {
    if (this.at(type, value)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(type: Token['type'], value?: string): Token {
    if (!this.at(type, value)) {
      const t = this.peek();
      throw new Error(`Expected ${value ?? type} but found "${t.value || t.type}" at ${t.pos}`);
    }
    return this.next();
  }

  parse(): BaseExpr {
    const expr = this.parseExpr();
    if (!this.at('eof')) {
      const t = this.peek();
      throw new Error(`Unexpected "${t.value}" at ${t.pos}`);
    }
    return expr;
  }

  parseExpr(minPower = 0): BaseExpr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();
      if (t.type !== 'op') break;
      const power = POWER[t.value];
      if (power === undefined || power < minPower) break;
      this.next();
      const right = this.parseExpr(power + 1);
      left = { kind: 'binary', op: t.value as BinaryOp, left, right };
    }

    return left;
  }

  private parseUnary(): BaseExpr {
    if (this.at('op', '!')) {
      this.next();
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    if (this.at('op', '-')) {
      this.next();
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): BaseExpr {
    let expr = this.parsePrimary();

    for (;;) {
      if (this.accept('punct', '.')) {
        const name = this.expect('ident').value;
        expr = { kind: 'prop', object: expr, name };
        continue;
      }
      if (this.at('punct', '(')) {
        this.next();
        const args: BaseExpr[] = [];
        if (!this.at('punct', ')')) {
          do {
            args.push(this.parseExpr());
          } while (this.accept('punct', ','));
        }
        this.expect('punct', ')');
        expr = { kind: 'call', callee: expr, args };
        continue;
      }
      if (this.accept('punct', '[')) {
        const index = this.parseExpr();
        this.expect('punct', ']');
        expr = { kind: 'index', object: expr, index };
        continue;
      }
      break;
    }

    return expr;
  }

  private parsePrimary(): BaseExpr {
    const t = this.peek();

    if (t.type === 'number') {
      this.next();
      return { kind: 'lit', value: Number(t.value) };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'lit', value: t.value };
    }

    if (this.accept('punct', '(')) {
      // Could be a parenthesised expression or a lambda parameter list.
      const start = this.pos;
      if (this.isLambdaAhead()) {
        const params: string[] = [];
        if (!this.at('punct', ')')) {
          do {
            params.push(this.expect('ident').value);
          } while (this.accept('punct', ','));
        }
        this.expect('punct', ')');
        this.expect('op', '=>');
        return { kind: 'lambda', params, body: this.parseExpr() };
      }
      this.pos = start;
      const inner = this.parseExpr();
      this.expect('punct', ')');
      return inner;
    }

    if (this.accept('punct', '[')) {
      const items: BaseExpr[] = [];
      if (!this.at('punct', ']')) {
        do {
          items.push(this.parseExpr());
        } while (this.accept('punct', ','));
      }
      this.expect('punct', ']');
      return { kind: 'list', items };
    }

    if (t.type === 'ident') {
      this.next();
      // Single-parameter lambda without parens: `x => expr`
      if (this.at('op', '=>')) {
        this.next();
        return { kind: 'lambda', params: [t.value], body: this.parseExpr() };
      }
      if (t.value === 'true') return { kind: 'lit', value: true };
      if (t.value === 'false') return { kind: 'lit', value: false };
      if (t.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'ident', name: t.value };
    }

    throw new Error(`Unexpected "${t.value || t.type}" at ${t.pos}`);
  }

  /** Look ahead for `ident, ident) =>` to disambiguate lambdas from grouping. */
  private isLambdaAhead(): boolean {
    let i = this.pos;
    let depth = 1;
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.type === 'punct' && t.value === '(') depth++;
      else if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) {
          const after = this.tokens[i + 1];
          return !!after && after.type === 'op' && after.value === '=>';
        }
      } else if (t.type === 'eof') break;
      i++;
    }
    return false;
  }
}

export function parseBaseExpr(source: string): BaseExpr {
  return new BaseParser(source).parse();
}
