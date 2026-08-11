import type { HostMessage, RequestMethod, ViewMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Correlated request/response channel to the extension host. */
export class Bridge {
  private vscode = acquireVsCodeApi();
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private handlers = new Set<(message: HostMessage) => void>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === 'response') {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error));
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  onMessage(handler: (message: HostMessage) => void): void {
    this.handlers.add(handler);
  }

  post(message: ViewMessage): void {
    this.vscode.postMessage(message);
  }

  request<T>(method: RequestMethod, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.post({ type: 'request', id, method, params });
      // A hung host request would otherwise leave a snippet awaiting forever.
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Request "${method}" timed out`));
        }
      }, 15000);
    });
  }

  log(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    this.post({ type: 'log', level, args: args.map(serializable) });
  }
}

function serializable(value: unknown): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'function') return '[Function]';
  try {
    structuredClone(value);
    return value;
  } catch {
    return String(value);
  }
}
