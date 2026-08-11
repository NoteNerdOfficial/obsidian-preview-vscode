export type Expr =
  | { kind: 'literal'; value: unknown }
  | { kind: 'link'; target: string; display?: string; subpath?: string }
  | { kind: 'tag'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'field'; object: Expr; name: string }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'lambda'; params: string[]; body: Expr }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'object'; entries: Array<[string, Expr]> }
  | { kind: 'unary'; op: '!' | '-'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr };

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'and'
  | 'or';

export type Source =
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'link-to'; target: string }
  | { kind: 'link-from'; target: string }
  | { kind: 'and'; left: Source; right: Source }
  | { kind: 'or'; left: Source; right: Source }
  | { kind: 'negate'; source: Source }
  | { kind: 'empty' };

export interface NamedExpr {
  expr: Expr;
  label: string;
}

export type Clause =
  | { kind: 'where'; expr: Expr }
  | { kind: 'sort'; keys: Array<{ expr: Expr; direction: 'asc' | 'desc' }> }
  | { kind: 'group'; expr: Expr; as: string }
  | { kind: 'flatten'; expr: Expr; as: string }
  | { kind: 'limit'; count: number };

export interface Query {
  type: 'TABLE' | 'LIST' | 'TASK' | 'CALENDAR';
  /** TABLE WITHOUT ID */
  withoutId: boolean;
  fields: NamedExpr[];
  source: Source;
  clauses: Clause[];
}
