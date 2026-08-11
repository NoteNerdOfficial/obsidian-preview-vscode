import type { BaseExpr } from './expr';

/** A `filters:` node — either a raw expression or a boolean combinator. */
export type BaseFilter =
  | { kind: 'expr'; source: string; expr: BaseExpr | null; error?: string }
  | { kind: 'and'; children: BaseFilter[] }
  | { kind: 'or'; children: BaseFilter[] }
  | { kind: 'not'; child: BaseFilter };

export type BaseViewType = 'table' | 'cards' | 'list';

export interface BaseView {
  type: BaseViewType;
  name: string;
  /** Column / field order, as property ids like `file.name` or `formula.x`. */
  order: string[];
  filters: BaseFilter | null;
  groupBy: { property: string; direction: 'ASC' | 'DESC' } | null;
  sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
  limit: number | null;
  /** cards view: property used as the card image. */
  image: string | null;
}

export interface BaseDefinition {
  filters: BaseFilter | null;
  formulas: Map<string, { source: string; expr: BaseExpr | null; error?: string }>;
  properties: Map<string, { displayName?: string }>;
  views: BaseView[];
  /** Parse errors that should surface in the UI rather than be swallowed. */
  errors: string[];
}
