import * as vscode from 'vscode';
import type { RawFileEntry, RawPage } from '../../shared/protocol';
import { buildPage } from './parse';
import { buildLinkGraph, LinkResolver } from './links';
import { isExcluded } from './glob';

export interface IndexChange {
  changed: RawPage[];
  removed: string[];
  changedFiles: RawFileEntry[];
  removedFiles: string[];
}

/**
 * Vault-wide index: full parsing for markdown notes, plus a lightweight
 * path/stat entry for every other file (images, PDFs, attachments — anything
 * `vault.getFiles()` should see in Obsidian). The two are scanned and watched
 * together off a single `**\/*` glob so an inbox-style script that lists
 * unconverted attachments by path sees them immediately, not just notes.
 *
 * Uses `vscode.workspace.fs` rather than `node:fs` so the extension keeps
 * working in Remote/WSL/Codespaces and on virtual filesystems.
 */
export class VaultIndex implements vscode.Disposable {
  private pages = new Map<string, RawPage>();
  private files = new Map<string, RawFileEntry>();
  private inlinks = new Map<string, string[]>();
  private resolver = new LinkResolver([]);
  private watcher: vscode.FileSystemWatcher | undefined;
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

  allFiles(): RawFileEntry[] {
    return [...this.files.values()];
  }

  getPage(path: string): RawPage | undefined {
    return this.pages.get(path);
  }

  getFileEntry(path: string): RawFileEntry | undefined {
    return this.files.get(path);
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
    this.files.clear();
    this.inlinks.clear();
    this.scanning = this.scan();
    await this.scanning;
  }

  private get excludePatterns(): string[] {
    return vscode.workspace.getConfiguration('obsidianPreview').get<string[]>('exclude') ?? [];
  }

  private get excludeGlob(): string {
    const patterns = this.excludePatterns;
    return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
  }

  private get dailyNoteFormat(): string {
    return (
      vscode.workspace.getConfiguration('obsidianPreview').get<string>('dailyNoteFormat') ??
      'yyyy-MM-dd'
    );
  }

  private async scan(): Promise<void> {
    const pattern = new vscode.RelativePattern(this.root, '**/*');
    const uris = await vscode.workspace.findFiles(pattern, this.excludeGlob);
    const format = this.dailyNoteFormat;

    // Bounded concurrency: a vault with thousands of files opened with
    // unbounded Promise.all will exhaust file handles on some platforms.
    const CONCURRENCY = 32;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, uris.length) }, async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor++];
        await this.indexUri(uri, format);
      }
    });
    await Promise.all(workers);

    this.rebuildGraph();
    this._onDidCompleteScan.fire();
  }

  /** Index one vault file: full parse for markdown, a lightweight stat entry for everything else. */
  private async indexUri(uri: vscode.Uri, format: string): Promise<{ page?: RawPage; file?: RawFileEntry } | null> {
    const rel = this.toRelative(uri);
    if (!rel) return null;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const entry = toFileEntry(rel, stat);
      this.files.set(rel, entry);

      if (entry.ext.toLowerCase() === 'md') {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(bytes);
        const page = buildPage(rel, text, { ctime: stat.ctime, mtime: stat.mtime, size: stat.size }, format);
        this.pages.set(rel, page);
        return { page, file: entry };
      }
      return { file: entry };
    } catch {
      // Stat succeeded but the read failed (lock, permission, transient FS
      // hiccup) — or stat itself failed. Either way don't leave a half-baked
      // file entry with no matching page sitting in the map.
      this.files.delete(rel);
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
    this.files.set(rel, {
      path: page.path,
      name: page.name,
      folder: page.folder,
      ext: page.ext,
      ctime: page.ctime,
      mtime: page.mtime,
      size: page.size
    });
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
    // A single `**/*` watcher covers `.base` files too, so editing one fires
    // through the normal flush → indexDelta path and any preview embedding
    // it re-renders — no separate watcher needed.
    const pattern = new vscode.RelativePattern(this.root, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate((uri) => this.markDirty(uri)),
      this.watcher.onDidChange((uri) => this.markDirty(uri)),
      this.watcher.onDidDelete((uri) => this.markDeleted(uri))
    );
  }

  private markDirty(uri: vscode.Uri): void {
    const rel = this.toRelative(uri);
    if (!rel || isExcluded(rel, this.excludePatterns)) return;
    this.dirty.add(rel);
    this.scheduleFlush();
  }

  private markDeleted(uri: vscode.Uri): void {
    const rel = this.toRelative(uri);
    if (!rel || isExcluded(rel, this.excludePatterns)) return;
    this.pages.delete(rel);
    this.files.delete(rel);
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
    const changedFiles: RawFileEntry[] = [];
    const removedFiles: string[] = [];

    for (const rel of paths) {
      const uri = this.toUri(rel);
      const result = await this.indexUri(uri, format);
      if (result?.file) {
        changedFiles.push(result.file);
        if (result.page) changed.push(result.page);
      } else {
        // Deleted, or unreadable — markDeleted already dropped it from both
        // maps; report it as removed either way so the webview drops it too.
        this.pages.delete(rel);
        this.files.delete(rel);
        removed.push(rel);
        removedFiles.push(rel);
      }
    }

    this.rebuildGraph();
    this._onDidChange.fire({ changed, removed, changedFiles, removedFiles });
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.watcher = undefined;
    this._onDidChange.dispose();
    this._onDidCompleteScan.dispose();
  }
}

function toFileEntry(rel: string, stat: vscode.FileStat): RawFileEntry {
  const slash = rel.lastIndexOf('/');
  const folder = slash >= 0 ? rel.slice(0, slash) : '';
  const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = filename.lastIndexOf('.');
  const name = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  return { path: rel, name, folder, ext, ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
}
