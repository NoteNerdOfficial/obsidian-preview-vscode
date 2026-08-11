import type { PageIndex } from '../dataview/pages';
import type { Bridge } from '../bridge';

/**
 * A minimal `app` object covering the Obsidian surface that vault scripts
 * actually reach for. The audit of this vault's view.js files found exactly
 * five methods in use (vault.read/modify/create/getAbstractFileByPath,
 * workspace.openLinkText) plus activeLeaf and commands.executeCommandById.
 *
 * Anything outside that set throws with a clear message rather than returning
 * undefined and failing somewhere confusing.
 */

export interface TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: { path: string; name: string } | null;
  stat: { ctime: number; mtime: number; size: number };
}

export function makeTFile(path: string, ctime = 0, mtime = 0, size = 0): TFile {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const folder = slash >= 0 ? path.slice(0, slash) : '';
  const dot = name.lastIndexOf('.');
  return {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : '',
    parent: folder
      ? { path: folder, name: folder.slice(folder.lastIndexOf('/') + 1) }
      : { path: '/', name: '/' },
    stat: { ctime, mtime, size }
  };
}

export interface AppShim {
  vault: VaultShim;
  workspace: WorkspaceShim;
  metadataCache: MetadataCacheShim;
  commands: CommandsShim;
  plugins: { plugins: Record<string, never>; enabledPlugins: Set<string> };
  fileManager: { generateMarkdownLink: (file: TFile, from: string) => string };
}

interface VaultShim {
  read(file: TFile | string): Promise<string>;
  cachedRead(file: TFile | string): Promise<string>;
  modify(file: TFile | string, text: string): Promise<void>;
  create(path: string, text: string): Promise<TFile>;
  delete(file: TFile | string): Promise<void>;
  getAbstractFileByPath(path: string): TFile | null;
  getMarkdownFiles(): TFile[];
  getFiles(): TFile[];
  getName(): string;
}

interface WorkspaceShim {
  openLinkText(target: string, source: string, newLeaf?: boolean): Promise<void>;
  getActiveFile(): TFile | null;
  activeLeaf: { view: { file: TFile | null } } | null;
  on(): { unload(): void };
  trigger(): void;
}

interface MetadataCacheShim {
  getFirstLinkpathDest(linkpath: string, source: string): TFile | null;
  getFileCache(file: TFile | string): {
    frontmatter: Record<string, unknown>;
    tags: Array<{ tag: string }>;
    links: Array<{ link: string; displayText?: string }>;
  } | null;
  resolvedLinks: Record<string, Record<string, number>>;
}

interface CommandsShim {
  executeCommandById(id: string): Promise<boolean>;
}

export function createApp(
  index: PageIndex,
  bridge: Bridge,
  getCurrentPath: () => string,
  vaultName: string
): AppShim {
  const pathOf = (file: TFile | string): string =>
    typeof file === 'string' ? file : file.path;

  // Markdown notes carry full parsed content in `getRaw`; every other file
  // (images, PDFs, attachments dropped into an inbox before conversion) only
  // has a lightweight path/stat entry. Both resolve to the same TFile shape.
  const toTFile = (path: string): TFile | null => {
    const raw = index.getRaw(path);
    if (raw) return makeTFile(raw.path, raw.ctime, raw.mtime, raw.size);
    const entry = index.getFileEntry(path);
    if (entry) return makeTFile(entry.path, entry.ctime, entry.mtime, entry.size);
    return null;
  };

  const vault: VaultShim = {
    read: (file) => bridge.request<string>('vaultRead', { path: pathOf(file) }),
    cachedRead: (file) => bridge.request<string>('vaultRead', { path: pathOf(file) }),
    async modify(file, text) {
      await bridge.request('vaultModify', { path: pathOf(file), text });
    },
    async create(path, text) {
      await bridge.request('vaultCreate', { path, text });
      return makeTFile(path);
    },
    async delete(file) {
      await bridge.request('vaultDelete', { path: pathOf(file) });
    },
    getAbstractFileByPath(path) {
      return toTFile(path) ?? toTFile(path.endsWith('.md') ? path : path + '.md');
    },
    getMarkdownFiles() {
      return index.paths().map((p) => toTFile(p)!).filter(Boolean);
    },
    getFiles() {
      // Obsidian's getFiles() returns every vault file, not just notes — an
      // inbox/triage script filtering by path needs to see images and other
      // attachments that haven't become notes yet.
      return index.allFiles().map((f) => toTFile(f.path)!).filter(Boolean);
    },
    getName() {
      return vaultName;
    }
  };

  const workspace: WorkspaceShim = {
    async openLinkText(target, source, newLeaf) {
      const [path, subpath] = target.split('#');
      bridge.post({
        type: 'openLink',
        path: path.trim(),
        subpath: subpath?.trim(),
        newTab: !!newLeaf
      });
    },
    getActiveFile() {
      return toTFile(getCurrentPath());
    },
    get activeLeaf() {
      return { view: { file: toTFile(getCurrentPath()) } };
    },
    // Vault scripts register workspace events for live refresh; the preview
    // already re-renders on document and index changes, so this is a no-op
    // that returns a valid unloadable ref.
    on() {
      return { unload() {} };
    },
    trigger() {}
  };

  const metadataCache: MetadataCacheShim = {
    getFirstLinkpathDest(linkpath, source) {
      const resolved = index.resolvePath(linkpath, source || getCurrentPath());
      return resolved ? toTFile(resolved) : null;
    },
    getFileCache(file) {
      const raw = index.getRaw(pathOf(file));
      if (!raw) return null;
      return {
        frontmatter: raw.frontmatter,
        tags: raw.etags.map((tag) => ({ tag })),
        links: raw.outlinks.map((l) => ({ link: l.raw, displayText: l.display }))
      };
    },
    get resolvedLinks() {
      const out: Record<string, Record<string, number>> = {};
      for (const path of index.paths()) {
        const raw = index.getRaw(path);
        if (!raw) continue;
        const counts: Record<string, number> = {};
        for (const link of raw.outlinks) {
          if (!link.resolved) continue;
          counts[link.path] = (counts[link.path] ?? 0) + 1;
        }
        out[path] = counts;
      }
      return out;
    }
  };

  const commands: CommandsShim = {
    async executeCommandById(id) {
      try {
        await bridge.request('executeCommand', { id });
        return true;
      } catch (err) {
        console.warn(`[obsidian-preview] ${(err as Error).message}`);
        return false;
      }
    }
  };

  return {
    vault,
    workspace,
    metadataCache,
    commands,
    // Reaching into another plugin cannot work outside Obsidian. Surfacing an
    // empty registry lets `app.plugins.plugins["x"]` return undefined so the
    // snippet's own guard fires, instead of throwing on `.plugins` first.
    plugins: { plugins: {}, enabledPlugins: new Set<string>() },
    fileManager: {
      generateMarkdownLink(file, _from) {
        return `[[${file.basename}]]`;
      }
    }
  };
}
