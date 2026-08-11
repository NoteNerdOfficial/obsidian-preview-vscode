import * as vscode from 'vscode';
import type { RawPage } from '../../shared/protocol';
import { buildPage } from './parse';
import { buildLinkGraph, LinkResolver } from './links';

export interface IndexChange {
  changed: RawPage[];
  removed: string[];
}

/**
 * Vault-wide markdown index.
 *
 * Uses `vscode.workspace.fs` rather than `node:fs` so the extension keeps
 * working in Remote/WSL/Codespaces and on virtual filesystems.
 */
export class VaultIndex implements vscode.Disposable {
  private pages = new Map<string, RawPage>();
  private inlinks = new Map<string, string[]>();
  private resolver = new LinkResolver([]);
  private watcher: vscode.FileSystemWatcher | undefined;
  private baseWatcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private scanning: Promise<void> | null = null;
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<IndexChange>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidCompleteScan = new vscode.EventEmitter<void>();
  readonly onDidCompleteScan = this._onDidCompleteScan.event;

  constructor(private readonly root: vscode.Uri) {}

  get rootUri(): vscode.Uri {
    return this.root;
  }

  get vaultName(): string {
    const parts = this.root.path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'vault';
  }

  allPages(): RawPage[] {
    return [...this.pages.values()];
  }

  getPage(path: string): RawPage | undefined {
    return this.pages.get(path);
  }

  getInlinks(path: string): string[] {
    return this.inlinks.get(path) ?? [];
  }

  /** Full inlink map, for shipping to the webview alongside the pages. */
  inlinkMap(): Record<string, string[]> {
    return Object.fromEntries(this.inlinks);
  }

  resolveLink(target: string, fromPath: string): RawPage | null {
    return this.resolver.resolve(target, fromPath);
  }

  toRelative(uri: vscode.Uri): string | null {
    const rootPath = this.root.path.endsWith('/') ? this.root.path : this.root.path + '/';
    if (!uri.path.startsWith(rootPath)) return null;
    return uri.path.slice(rootPath.length);
  }

  toUri(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...relPath.split('/'));
  }

  async initialize(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan();
    await this.scanning;
    this.startWatching();
  }

  async rebuild(): Promise<void> {
    this.pages.clear();
    this.inlinks.clear();
    this.scanning = this.scan();
    await this.scanning;
  }

  private get excludeGlob(): string {
    const cfg = vscode.workspace.getConfiguration('obsidianPreview');
    const patterns = cfg.get<string[]>('exclude') ?? [];
    return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
  }

  private get dailyNoteFormat(): string {
    return (
      vscode.workspace.getConfiguration('obsidianPreview').get<string>('dailyNoteFormat') ??
      'yyyy-MM-dd'
    );
  }

  private async scan(): Promise<void> {
    const pattern = new vscode.RelativePattern(this.root, '**/*.md');
    const files = await vscode.workspace.findFiles(pattern, this.excludeGlob);
    const format = this.dailyNoteFormat;

    // Bounded concurrency: a 2000-note vault opened with unbounded
    // Promise.all will exhaust file handles on some platforms.
    const CONCURRENCY = 32;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (cursor < files.length) {
        const uri = files[cursor++];
        const page = await this.readPage(uri, format);
        if (page) this.pages.set(page.path, page);
      }
    });
    await Promise.all(workers);

    this.rebuildGraph();
    this._onDidCompleteScan.fire();
  }

  private async readPage(uri: vscode.Uri, format: string): Promise<RawPage | null> {
    const rel = this.toRelative(uri);
    if (!rel) return null;
    try {
      const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        vscode.workspace.fs.stat(uri)
      ]);
      const text = new TextDecoder('utf-8').decode(bytes);
      return buildPage(rel, text, { ctime: stat.ctime, mtime: stat.mtime, size: stat.size }, format);
    } catch {
      return null;
    }
  }

  /** Index an in-memory document, so unsaved edits are reflected immediately. */
  indexDocument(document: vscode.TextDocument): RawPage | null {
    const rel = this.toRelative(document.uri);
    if (!rel) return null;
    const existing = this.pages.get(rel);
    const page = buildPage(
      rel,
      document.getText(),
      {
        ctime: existing?.ctime ?? Date.now(),
        mtime: Date.now(),
        size: Buffer.byteLength(document.getText(), 'utf8')
      },
      this.dailyNoteFormat
    );
    this.pages.set(rel, page);
    this.rebuildGraph();
    return page;
  }

  private rebuildGraph(): void {
    const pages = this.allPages();
    this.inlinks = buildLinkGraph(pages);
    this.resolver = new LinkResolver(pages);
  }

  private startWatching(): void {
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(this.root, '**/*.md');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate((uri) => this.markDirty(uri)),
      this.watcher.onDidChange((uri) => this.markDirty(uri)),
      this.watcher.onDidDelete((uri) => this.markDeleted(uri))
    );

    // `.base` files are not indexed as notes, but editing one must still
    // re-render any preview embedding it.
    const basePattern = new vscode.RelativePattern(this.root, '**/*.base');
    this.baseWatcher = vscode.workspace.createFileSystemWatcher(basePattern);
    const fireBaseChange = () => this._onDidChange.fire({ changed: [], removed: [] });
    this.disposables.push(
      this.baseWatcher,
      this.baseWatcher.onDidCreate(fireBaseChange),
      this.baseWatcher.onDidChange(fireBaseChange),
      this.baseWatcher.onDidDelete(fireBaseChange)
    );
  }

  private markDirty(uri: vscode.Uri): void {
    const rel = this.toRelative(uri);
    if (!rel) return;
    this.dirty.add(rel);
    this.scheduleFlush();
  }

  private markDeleted(uri: vscode.Uri): void {
    const rel = this.toRelative(uri);
    if (!rel) return;
    this.pages.delete(rel);
    this.dirty.add(rel);
    this.scheduleFlush();
  }

  /**
   * Coalesce watcher events. Saving a note fires change events for the file
   * and often its siblings; re-resolving the whole link graph per event is
   * wasteful on a large vault.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 120);
  }

  private async flush(): Promise<void> {
    const paths = [...this.dirty];
    this.dirty.clear();
    if (!paths.length) return;

    const format = this.dailyNoteFormat;
    const changed: RawPage[] = [];
    const removed: string[] = [];

    for (const rel of paths) {
      const uri = this.toUri(rel);
      const page = await this.readPage(uri, format);
      if (page) {
        this.pages.set(rel, page);
        changed.push(page);
      } else {
        this.pages.delete(rel);
        removed.push(rel);
      }
    }

    this.rebuildGraph();
    this._onDidChange.fire({ changed, removed });
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.watcher = undefined;
    this.baseWatcher = undefined;
    this._onDidChange.dispose();
    this._onDidCompleteScan.dispose();
  }
}
