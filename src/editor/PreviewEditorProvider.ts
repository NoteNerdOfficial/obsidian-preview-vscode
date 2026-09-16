import * as vscode from 'vscode';
import type {
  HostMessage,
  LoadBaseResult,
  LoadViewResult,
  RequestMethod,
  ViewMessage
} from '../../shared/protocol';
import { VaultIndex } from '../index/VaultIndex';

/**
 * A CustomTextEditorProvider rather than a read-only custom editor: it hands us
 * the TextDocument, so undo/redo, dirty state and saving all flow through
 * VS Code's normal pipeline instead of being reimplemented.
 *
 * The same provider backs two viewTypes — markdown notes and standalone
 * `.base` files — since the only real difference is what "mode" the webview
 * is told to render in; everything else (index delivery, RPC, link/task
 * write-back) is identical.
 */
export class PreviewEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext, index: VaultIndex, viewType: string): vscode.Disposable {
    const provider = new PreviewEditorProvider(context, index);
    return vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    });
  }

  private panels = new Set<vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly index: VaultIndex
  ) {
    this.context.subscriptions.push(
      this.index.onDidChange(({ changed, removed, changedFiles, removedFiles }) => {
        this.broadcast({ type: 'indexDelta', changed, removed, changedFiles, removedFiles });
      })
    );

    // A panel resolved before the initial scan lands (e.g. a `.base` file
    // opened straight from the Explorer, which activates the extension and
    // resolves the editor in the same tick) gets an empty index up front.
    // Re-send the full index to every open panel once a scan completes so
    // it doesn't stay stuck showing "0 notes".
    this.context.subscriptions.push(
      this.index.onDidCompleteScan(() => {
        for (const panel of this.panels) {
          this.sendIndex((m) => void panel.webview.postMessage(m));
        }
      })
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.panels.add(panel);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, this.index.rootUri]
    };
    panel.webview.html = this.renderShell(panel.webview);

    const relPath = this.index.toRelative(document.uri) ?? document.uri.path;
    const isBase = relPath.toLowerCase().endsWith('.base');

    const post = (message: HostMessage) => {
      void panel.webview.postMessage(message);
    };

    const pushDocument = () => {
      post({
        type: 'document',
        path: relPath,
        text: document.getText(),
        version: document.version
      });
    };

    const subscriptions: vscode.Disposable[] = [];

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        // Re-index from the buffer so the preview reflects unsaved edits.
        // `.base` files are YAML, not markdown — indexDocument would parse
        // them as a bogus page and register their basename as a link target.
        if (!isBase) this.index.indexDocument(e.document);
        pushDocument();
      })
    );

    subscriptions.push(
      panel.webview.onDidReceiveMessage((message: ViewMessage) =>
        this.handleMessage(message, document, panel, post)
      )
    );

    panel.onDidDispose(() => {
      this.panels.delete(panel);
      for (const d of subscriptions) d.dispose();
    });

    post({
      type: 'init',
      currentPath: relPath,
      mode: isBase ? 'base' : 'markdown',
      settings: {
        enableDataviewJs:
          vscode.workspace.getConfiguration('obsidianPreview').get<boolean>('enableDataviewJs') ??
          true,
        dailyNoteFormat:
          vscode.workspace
            .getConfiguration('obsidianPreview')
            .get<string>('dailyNoteFormat') ?? 'yyyy-MM-dd',
        vaultName: this.index.vaultName
      }
    });
    this.sendIndex(post);
    pushDocument();
  }

  private sendIndex(post: (m: HostMessage) => void): void {
    const pages = this.index.allPages();
    const files = this.index.allFiles();

    // Chunked so a large vault does not block the message channel with one
    // enormous structured clone. Pages carry parsed content and go out in
    // small chunks; file entries are tiny path/stat records and go out in
    // much larger ones.
    const PAGE_CHUNK = 400;
    const FILE_CHUNK = 4000;

    const pageChunks = pages.length ? chunk(pages, PAGE_CHUNK) : [[]];
    const fileChunks = files.length ? chunk(files, FILE_CHUNK) : [[]];
    const totalChunks = pageChunks.length + fileChunks.length;
    let sent = 0;

    for (const slice of pageChunks) {
      sent++;
      post({ type: 'index', pages: slice, files: [], complete: sent >= totalChunks });
    }
    for (const slice of fileChunks) {
      sent++;
      post({ type: 'index', pages: [], files: slice, complete: sent >= totalChunks });
    }
  }

  private broadcast(message: HostMessage): void {
    for (const panel of this.panels) void panel.webview.postMessage(message);
  }

  private async handleMessage(
    message: ViewMessage,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    post: (m: HostMessage) => void
  ): Promise<void> {
    switch (message.type) {
      case 'ready':
        return;

      case 'log': {
        const line = message.args
          .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
          .join(' ');
        console[message.level](`[obsidian-preview] ${line}`);
        return;
      }

      case 'setTaskStatus':
        await this.setTaskStatus(document, message.line, message.status);
        return;

      case 'openLink':
        await this.openLink(message.path, message.subpath, document, message.newTab);
        return;

      case 'request': {
        try {
          const value = await this.handleRequest(message.method, message.params, document);
          post({ type: 'response', id: message.id, ok: true, value });
        } catch (err) {
          post({
            type: 'response',
            id: message.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        return;
      }
    }
  }

  /**
   * Toggle a task checkbox by editing the source document. Going through
   * WorkspaceEdit means the change is a normal undoable edit and participates
   * in the file's dirty state, exactly like typing it by hand.
   */
  private async setTaskStatus(
    document: vscode.TextDocument,
    line: number,
    status: string
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) return;
    const text = document.lineAt(line).text;
    const match = text.match(/^([ \t]*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/);
    if (!match) return;

    const col = match[1].length;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(line, col, line, col + 1),
      status.slice(0, 1) || ' '
    );
    await vscode.workspace.applyEdit(edit);
  }

  private async openLink(
    target: string,
    subpath: string | undefined,
    from: vscode.TextDocument,
    newTab?: boolean
  ): Promise<void> {
    const fromRel = this.index.toRelative(from.uri) ?? '';
    const page = this.index.resolveLink(target, fromRel);

    if (!page) {
      const create = await vscode.window.showInformationMessage(
        `"${target}" does not exist yet.`,
        'Create note'
      );
      if (create) {
        const uri = this.index.toUri(target.endsWith('.md') ? target : `${target}.md`);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${target}\n\n`));
        await vscode.window.showTextDocument(uri, { preview: false });
      }
      return;
    }

    const uri = this.index.toUri(page.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: !newTab,
      viewColumn: vscode.ViewColumn.Active
    });

    if (subpath) {
      const heading = subpath.replace(/^#/, '').toLowerCase();
      const target = page.sections.find((s) => s.heading.toLowerCase() === heading);
      if (target) {
        const pos = new vscode.Position(target.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
      }
    }
  }

  private async handleRequest(
    method: RequestMethod,
    params: unknown,
    document: vscode.TextDocument
  ): Promise<unknown> {
    const p = (params ?? {}) as Record<string, string>;

    switch (method) {
      case 'loadView':
        return this.loadView(p.name ?? '');

      case 'loadBase':
        return this.loadBase(p.path ?? '', document);

      case 'vaultRead': {
        const uri = this.index.toUri(p.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder('utf-8').decode(bytes);
      }

      case 'vaultModify': {
        const uri = this.index.toUri(p.path);
        // Prefer a WorkspaceEdit when the file is open so the change is
        // undoable and does not clobber unsaved buffer state.
        const open = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString()
        );
        if (open) {
          const edit = new vscode.WorkspaceEdit();
          const full = new vscode.Range(
            open.positionAt(0),
            open.positionAt(open.getText().length)
          );
          edit.replace(uri, full, p.text ?? '');
          await vscode.workspace.applyEdit(edit);
        } else {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(p.text ?? ''));
        }
        return true;
      }

      case 'vaultCreate': {
        const uri = this.index.toUri(p.path);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(p.text ?? ''));
        return p.path;
      }

      case 'vaultDelete': {
        const uri = this.index.toUri(p.path);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return true;
      }

      case 'executeCommand': {
        // Obsidian command ids have no VS Code equivalent; map the handful
        // that do and report the rest rather than failing silently.
        const mapped = OBSIDIAN_COMMAND_MAP[p.id];
        if (!mapped) throw new Error(`Unsupported Obsidian command: ${p.id}`);
        await vscode.commands.executeCommand(mapped);
        return true;
      }

      case 'resolveResource': {
        const page = this.index.resolveLink(p.path ?? '', this.index.toRelative(document.uri) ?? '');
        return page ? page.path : null;
      }
    }
  }

  /**
   * Resolve and read a `.base` file. Bases live outside the markdown index, so
   * resolution walks the vault rather than going through the link resolver.
   */
  private async loadBase(target: string, document: vscode.TextDocument): Promise<LoadBaseResult> {
    const clean = target.replace(/\\/g, '/').trim();
    if (!clean) throw new Error('Empty base reference');

    const withExt = clean.endsWith('.base') ? clean : `${clean}.base`;
    const fromRel = this.index.toRelative(document.uri) ?? '';
    const fromFolder = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';

    const candidates = [
      fromFolder ? `${fromFolder}/${withExt}` : withExt,
      withExt
    ];

    for (const candidate of candidates) {
      try {
        const uri = this.index.toUri(candidate);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { yaml: new TextDecoder('utf-8').decode(bytes), path: candidate };
      } catch {
        continue;
      }
    }

    // Fall back to a vault-wide search by basename, matching how Obsidian
    // resolves a bare `![[Something.base]]`.
    const basename = withExt.slice(withExt.lastIndexOf('/') + 1);
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.index.rootUri, `**/${basename}`),
      '**/node_modules/**',
      1
    );
    if (matches.length) {
      const bytes = await vscode.workspace.fs.readFile(matches[0]);
      return {
        yaml: new TextDecoder('utf-8').decode(bytes),
        path: this.index.toRelative(matches[0]) ?? basename
      };
    }

    throw new Error(`Base not found: ${withExt}`);
  }

  private async loadView(name: string): Promise<LoadViewResult> {
    if (!name) return { js: null, css: null, source: null };

    // Obsidian looks for `<name>/view.js` first, then `<name>.js`.
    const candidates = [`${name}/view.js`, `${name}.js`];
    for (const candidate of candidates) {
      try {
        const uri = this.index.toUri(candidate);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const js = new TextDecoder('utf-8').decode(bytes);

        let css: string | null = null;
        const cssCandidate = candidate.replace(/\.js$/, '.css');
        try {
          const cssBytes = await vscode.workspace.fs.readFile(this.index.toUri(cssCandidate));
          css = new TextDecoder('utf-8').decode(cssBytes);
        } catch {
          /* view.css is optional */
        }

        return { js, css, source: candidate };
      } catch {
        continue;
      }
    }
    throw new Error(`dv.view("${name}") — no view.js found at ${candidates.join(' or ')}`);
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );

    // 'unsafe-eval' is what the built-in markdown preview cannot grant, and is
    // the whole reason this is a custom editor: dataviewjs blocks are compiled
    // with AsyncFunction at runtime.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
      `connect-src 'none'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Obsidian Preview</title>
</head>
<body>
<div id="obsidian-preview-root" class="markdown-preview-view"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

const OBSIDIAN_COMMAND_MAP: Record<string, string> = {
  'editor:open-search': 'actions.find',
  'app:go-back': 'workbench.action.navigateBack',
  'app:go-forward': 'workbench.action.navigateForward',
  'workspace:split-vertical': 'workbench.action.splitEditor',
  'app:open-settings': 'workbench.action.openSettings'
};

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
