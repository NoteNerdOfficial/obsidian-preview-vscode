/**
 * Obsidian extends HTMLElement.prototype with a small DOM helper API. Vault
 * scripts (view.js in particular) call these directly, so they must exist
 * before any snippet runs or the calls throw.
 */

export interface DomElementInfo {
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

type ElInfo = string | DomElementInfo | undefined;

function applyInfo(el: HTMLElement, info: ElInfo): void {
  if (!info) return;
  if (typeof info === 'string') {
    el.className = info;
    return;
  }
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
    for (const c of classes) if (c) el.classList.add(c);
  }
  if (info.text !== undefined) {
    if (typeof info.text === 'string') el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr) {
    for (const [key, value] of Object.entries(info.attr)) {
      if (value === null || value === false) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (info.title !== undefined) el.title = info.title;
  if (info.href !== undefined) el.setAttribute('href', info.href);
  if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
  if (info.type !== undefined) (el as HTMLInputElement).type = info.type;
  if (info.placeholder !== undefined) (el as HTMLInputElement).placeholder = info.placeholder;
}

function define(target: object, name: string, fn: unknown): void {
  if (name in target) return;
  Object.defineProperty(target, name, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
}

export function installDomShims(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const nodeProto = Node.prototype as unknown as Record<string, unknown>;
  const docFrag = DocumentFragment.prototype as unknown as Record<string, unknown>;

  function createEl(
    this: HTMLElement | DocumentFragment,
    tag: string,
    info?: ElInfo,
    callback?: (el: HTMLElement) => void
  ): HTMLElement {
    const el = document.createElement(tag);
    applyInfo(el, info);
    if (typeof info === 'object' && info?.prepend) this.insertBefore(el, this.firstChild);
    else this.appendChild(el);
    callback?.(el);
    return el;
  }

  for (const target of [proto, docFrag]) {
    define(target, 'createEl', createEl);
    define(target, 'createDiv', function (this: HTMLElement, info?: ElInfo, cb?: (el: HTMLElement) => void) {
      return createEl.call(this, 'div', info, cb);
    });
    define(target, 'createSpan', function (this: HTMLElement, info?: ElInfo, cb?: (el: HTMLElement) => void) {
      return createEl.call(this, 'span', info, cb);
    });
    define(target, 'empty', function (this: HTMLElement) {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    });
    define(target, 'appendText', function (this: HTMLElement, text: string) {
      this.appendChild(document.createTextNode(text));
      return this;
    });
  }

  define(proto, 'setText', function (this: HTMLElement, text: string | DocumentFragment) {
    if (typeof text === 'string') this.textContent = text;
    else {
      this.textContent = '';
      this.appendChild(text);
    }
    return this;
  });
  define(proto, 'addClass', function (this: HTMLElement, ...classes: string[]) {
    for (const c of classes) if (c) this.classList.add(c);
    return this;
  });
  define(proto, 'addClasses', function (this: HTMLElement, classes: string[]) {
    for (const c of classes) if (c) this.classList.add(c);
    return this;
  });
  define(proto, 'removeClass', function (this: HTMLElement, ...classes: string[]) {
    for (const c of classes) this.classList.remove(c);
    return this;
  });
  define(proto, 'removeClasses', function (this: HTMLElement, classes: string[]) {
    for (const c of classes) this.classList.remove(c);
    return this;
  });
  define(proto, 'toggleClass', function (this: HTMLElement, classes: string | string[], value: boolean) {
    const list = Array.isArray(classes) ? classes : [classes];
    for (const c of list) this.classList.toggle(c, value);
    return this;
  });
  define(proto, 'hasClass', function (this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  });
  define(proto, 'setAttr', function (this: HTMLElement, key: string, value: string | number | boolean | null) {
    if (value === null || value === false) this.removeAttribute(key);
    else this.setAttribute(key, String(value));
    return this;
  });
  define(proto, 'setAttrs', function (this: HTMLElement, attrs: Record<string, string>) {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, String(v));
    return this;
  });
  define(proto, 'getAttr', function (this: HTMLElement, key: string) {
    return this.getAttribute(key);
  });
  define(proto, 'show', function (this: HTMLElement) {
    this.style.display = '';
    return this;
  });
  define(proto, 'hide', function (this: HTMLElement) {
    this.style.display = 'none';
    return this;
  });
  define(proto, 'toggle', function (this: HTMLElement, show: boolean) {
    this.style.display = show ? '' : 'none';
    return this;
  });
  define(proto, 'onClickEvent', function (this: HTMLElement, listener: EventListener) {
    this.addEventListener('click', listener);
    return this;
  });
  define(proto, 'insertAfter', function (this: HTMLElement, node: Node) {
    this.parentNode?.insertBefore(node, this.nextSibling);
    return node;
  });

  define(nodeProto, 'detach', function (this: Node) {
    this.parentNode?.removeChild(this);
  });

  // Obsidian also patches a few Array/String helpers scripts occasionally use.
  define(Array.prototype as unknown as object, 'first', function <T>(this: T[]) {
    return this.length ? this[0] : undefined;
  });
  define(Array.prototype as unknown as object, 'last', function <T>(this: T[]) {
    return this.length ? this[this.length - 1] : undefined;
  });
  define(Array.prototype as unknown as object, 'remove', function <T>(this: T[], item: T) {
    const i = this.indexOf(item);
    if (i >= 0) this.splice(i, 1);
    return this;
  });
  define(String.prototype as unknown as object, 'contains', function (this: string, sub: string) {
    return this.indexOf(sub) >= 0;
  });
  define(String.prototype as unknown as object, 'format', function (this: string, ...args: string[]) {
    return this.replace(/\{(\d+)\}/g, (m, i) => args[Number(i)] ?? m);
  });

  define(window as unknown as object, 'createEl', function (tag: string, info?: ElInfo) {
    const el = document.createElement(tag);
    applyInfo(el, info);
    return el;
  });
  define(window as unknown as object, 'createDiv', function (info?: ElInfo) {
    const el = document.createElement('div');
    applyInfo(el, info);
    return el;
  });
  define(window as unknown as object, 'createSpan', function (info?: ElInfo) {
    const el = document.createElement('span');
    applyInfo(el, info);
    return el;
  });
  define(window as unknown as object, 'createFragment', function (
    cb?: (frag: DocumentFragment) => void
  ) {
    const frag = document.createDocumentFragment();
    cb?.(frag);
    return frag;
  });
}
