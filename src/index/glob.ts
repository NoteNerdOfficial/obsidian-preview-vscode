/**
 * Minimal glob matching for `obsidianPreview.exclude` patterns, used to
 * filter file-watcher events the same way `vscode.workspace.findFiles`
 * filters its initial scan. No dependency on `vscode`, so it can be tested
 * head-on rather than through the extension host.
 */
export function isExcluded(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // '**/' also matches zero directories
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
