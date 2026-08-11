/**
 * Ambient declarations for the DOM helpers Obsidian adds to HTMLElement.
 * `installDomShims()` provides the implementations at runtime; these keep the
 * call sites type-checked.
 */

interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  prepend?: boolean;
}

interface HTMLElement {
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    info?: string | DomElementInfo,
    callback?: (el: HTMLElementTagNameMap[K]) => void
  ): HTMLElementTagNameMap[K];
  createEl(
    tag: string,
    info?: string | DomElementInfo,
    callback?: (el: HTMLElement) => void
  ): HTMLElement;
  createDiv(info?: string | DomElementInfo, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
  createSpan(info?: string | DomElementInfo, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  empty(): this;
  appendText(text: string): this;
  setText(text: string | DocumentFragment): this;
  addClass(...classes: string[]): this;
  addClasses(classes: string[]): this;
  removeClass(...classes: string[]): this;
  removeClasses(classes: string[]): this;
  toggleClass(classes: string | string[], value: boolean): this;
  hasClass(cls: string): boolean;
  setAttr(key: string, value: string | number | boolean | null): this;
  setAttrs(attrs: Record<string, string>): this;
  getAttr(key: string): string | null;
  show(): this;
  hide(): this;
  toggle(show: boolean): this;
  onClickEvent(listener: (event: MouseEvent) => void): this;
  insertAfter(node: Node): Node;
}

interface DocumentFragment {
  createEl(
    tag: string,
    info?: string | DomElementInfo,
    callback?: (el: HTMLElement) => void
  ): HTMLElement;
  createDiv(info?: string | DomElementInfo): HTMLDivElement;
  createSpan(info?: string | DomElementInfo): HTMLSpanElement;
  empty(): this;
  appendText(text: string): this;
}

interface Node {
  detach(): void;
}

interface Array<T> {
  first(): T | undefined;
  last(): T | undefined;
  remove(item: T): this;
}

interface String {
  contains(sub: string): boolean;
  format(...args: string[]): string;
}
