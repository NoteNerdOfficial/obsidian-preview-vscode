export type TokenType =
  | 'ident'
  | 'keyword'
  | 'number'
  | 'string'
  | 'link'
  | 'tag'
  | 'op'
  | 'punct'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  /** For links: the inner text, unsplit. */
  raw?: string;
  pos: number;
}

export const KEYWORDS = new Set([
  'table',
  'list',
  'task',
  'calendar',
  'from',
  'where',
  'sort',
  'group',
  'by',
  'flatten',
  'limit',
  'as',
  'asc',
  'desc',
  'and',
  'or',
  'not',
  'without',
  'id'
]);

const MULTI_OPS = ['>=', '<=', '!=', '<>', '&&', '||'];
const SINGLE_OPS = '+-*/%<>=!';
const PUNCT = '(),.[]{}:';

/**
 * Tokenize a DQL query.
 *
 * Keyword detection happens here rather than via a regex over the raw source,
 * so a keyword appearing inside a string literal or a wikilink — `WHERE title
 * = "From Russia"` — cannot corrupt clause splitting.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Line comments.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Wikilink literal: [[Target|Display]]
    if (ch === '[' && source[i + 1] === '[') {
      const end = source.indexOf(']]', i + 2);
      if (end < 0) throw new Error(`Unterminated [[link]] at position ${i}`);
      tokens.push({ type: 'link', value: source.slice(i + 2, end), pos: i });
      i = end + 2;
      continue;
    }

    // String literal, double or single quoted, with escapes.
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
      if (j >= source.length) throw new Error(`Unterminated string at position ${i}`);
      tokens.push({ type: 'string', value: out, pos: i });
      i = j + 1;
      continue;
    }

    // Tag literal.
    if (ch === '#') {
      let j = i + 1;
      while (j < source.length && /[\p{L}\p{N}_/-]/u.test(source[j])) j++;
      if (j > i + 1) {
        tokens.push({ type: 'tag', value: source.slice(i, j), pos: i });
        i = j;
        continue;
      }
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
      while (j < source.length && /[\p{L}\p{N}_$-]/u.test(source[j])) j++;
      const word = source.slice(i, j);
      const lower = word.toLowerCase();
      tokens.push({
        type: KEYWORDS.has(lower) ? 'keyword' : 'ident',
        value: KEYWORDS.has(lower) ? lower : word,
        raw: word,
        pos: i
      });
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

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}
