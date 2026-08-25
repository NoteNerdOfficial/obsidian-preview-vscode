import * as vscode from 'vscode';
import { VaultIndex } from './index/VaultIndex';
import { PreviewEditorProvider } from './editor/PreviewEditorProvider';

let index: VaultIndex | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Always register commands so they are discoverable even without a workspace folder
  context.subscriptions.push(
    vscode.commands.registerCommand('obsidianPreview.open', async () => {
      const active = vscode.window.activeTextEditor;
      const path = active?.document.uri.path.toLowerCase() ?? '';
      const viewType = path.endsWith('.base')
        ? 'obsidianPreview.baseEditor'
        : path.endsWith('.md')
          ? 'obsidianPreview.editor'
          : null;
      if (!active || !viewType) {
        void vscode.window.showInformationMessage('Open a markdown note or a .base file first.');
        return;
      }
      if (!index) {
        const fallbackRoot = resolveVaultRoot();
        if (!fallbackRoot) {
          void vscode.window.showInformationMessage(
            'Obsidian Preview: no vault folder open. Open a folder to enable preview.'
          );
          return;
        }
        index = new VaultIndex(fallbackRoot);
        context.subscriptions.push(index);
        context.subscriptions.push(PreviewEditorProvider.register(context, index, 'obsidianPreview.editor'));
        context.subscriptions.push(
          PreviewEditorProvider.register(context, index, 'obsidianPreview.baseEditor')
        );
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Indexing vault…' },
          () => index!.initialize()
        );
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        active.document.uri,
        viewType,
        vscode.ViewColumn.Beside
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('obsidianPreview.reindex', async () => {
      if (!index) {
        void vscode.window.showInformationMessage('Obsidian Preview: no vault to index. Open a folder first.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Rebuilding vault index…' },
        () => index!.rebuild()
      );
      void vscode.window.showInformationMessage(
        `Obsidian Preview: indexed ${index!.allPages().length} notes.`
      );
    })
  );

  const root = resolveVaultRoot();
  if (!root) {
    // No folder open: commands are still registered, index will be created lazily
    // on first `obsidianPreview.open` using the active file's directory.
    return;
  }

  index = new VaultIndex(root);
  context.subscriptions.push(index);
  context.subscriptions.push(PreviewEditorProvider.register(context, index, 'obsidianPreview.editor'));
  context.subscriptions.push(
    PreviewEditorProvider.register(context, index, 'obsidianPreview.baseEditor')
  );

  // Index in the background; the editor renders as soon as the scan lands.
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Indexing vault…' },
    () => index!.initialize()
  );
}

function resolveVaultRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const configured = vscode.workspace
      .getConfiguration('obsidianPreview')
      .get<string>('vaultRoot');
    const base = folders[0].uri;
    if (!configured) return base;
    return vscode.Uri.joinPath(base, ...configured.split('/').filter(Boolean));
  }
  // Fallback: single-file mode - use the active editor's directory as vault root if available
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const path = active.path;
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) return active.with({ path: dir });
  }
  return undefined;
}

export function deactivate(): void {
  index?.dispose();
  index = undefined;
}
