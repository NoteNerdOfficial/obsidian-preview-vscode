/**
 * Headless verification harness.
 *
 * Indexes a real vault with the same parser the extension uses, then runs the
 * vault's own DQL queries and dataviewjs blocks through the same engine. Uses
 * linkedom for a DOM so dv's rendering paths are exercised for real rather
 * than stubbed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildPage } from '../src/index/parse';
import { buildLinkGraph } from '../src/index/links';
import type { RawPage } from '../shared/protocol';

export function indexVault(root: string, dailyNoteFormat = 'yyyy-MM-dd'): RawPage[] {
  const pages: RawPage[] = [];
  const skip = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.claude']);

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        try {
          const text = fs.readFileSync(full, 'utf-8');
          const stat = fs.statSync(full);
          const rel = path.relative(root, full).split(path.sep).join('/');
          pages.push(
            buildPage(
              rel,
              text,
              { ctime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size },
              dailyNoteFormat
            )
          );
        } catch {
          /* unreadable file */
        }
      }
    }
  };

  walk(root);
  buildLinkGraph(pages);
  return pages;
}

export interface ExtractedBlock {
  file: string;
  lang: 'dataview' | 'dataviewjs';
  code: string;
}

const BLOCK_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(dataviewjs|dataview)[ \t]*$([\s\S]*?)^\1\2[ \t]*$/gm;

export function extractBlocks(root: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  const skip = new Set(['.obsidian', '.git', 'node_modules', '.trash']);

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf-8');
        BLOCK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BLOCK_RE.exec(text)) !== null) {
          out.push({
            file: path.relative(root, full).split(path.sep).join('/'),
            lang: m[3] as ExtractedBlock['lang'],
            code: m[4]
          });
        }
      }
    }
  };

  walk(root);
  return out;
}
