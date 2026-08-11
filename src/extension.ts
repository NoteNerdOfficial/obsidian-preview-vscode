import * as vscode from 'vscode';
import { VaultIndex } from './index/VaultIndex';
import { PreviewEditorProvider } from './editor/PreviewEditorProvider';

let index: VaultIndex | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = resolveVaultRoot();
  if (!root) {
    // No folder open: the preview needs a vault to index against.
    return;
  }

  index = new VaultIndex(root);
  context.subscriptions.push(index);
  context.subscriptions.push(PreviewEditorProvider.register(context, index, 'obsidianPreview.editor'));
  context.subscriptions.push(
    PreviewEditorProvider.register(context, index, 'obsidianPreview.baseEditor')
  );

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
      if (!index) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Rebuilding vault index…' },
        () => index!.rebuild()
      );
      void vscode.window.showInformationMessage(
        `Obsidian Preview: indexed ${index!.allPages().length} notes.`
      );
    })
  );

  // Index in the background; the editor renders as soon as the scan lands.
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Indexing vault…' },
    () => index!.initialize()
  );
}

function resolveVaultRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const configured = vscode.workspace
    .getConfiguration('obsidianPreview')
    .get<string>('vaultRoot');

  const base = folders[0].uri;
  if (!configured) return base;
  return vscode.Uri.joinPath(base, ...configured.split('/').filter(Boolean));
}

export function deactivate(): void {
  index?.dispose();
  index = undefined;
}
