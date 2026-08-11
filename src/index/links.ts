import type { RawPage } from '../../shared/protocol';

/**
 * Obsidian's link resolution, in the order it actually applies:
 *
 *   1. Exact vault-relative path (with and without `.md`)
 *   2. Path relative to the linking note's folder
 *   3. Unique basename match across the vault
 *   4. Ambiguous basename -> shortest path wins, ties broken alphabetically
 *   5. Alias match
 *
 * Getting step 4 wrong is subtle: two notes named `Index.md` in different
 * folders resolve deterministically in Obsidian, and users rely on it.
 */
export class LinkResolver {
  private byPath = new Map<string, RawPage>();
  private byLowerPath = new Map<string, RawPage>();
  private byBasename = new Map<string, RawPage[]>();
  private byAlias = new Map<string, RawPage[]>();

  constructor(pages: Iterable<RawPage>) {
    for (const page of pages) this.add(page);
    this.sortBuckets();
  }

  private add(page: RawPage): void {
    this.byPath.set(page.path, page);
    this.byLowerPath.set(page.path.toLowerCase(), page);

    const key = page.name.toLowerCase();
    const bucket = this.byBasename.get(key);
    if (bucket) bucket.push(page);
    else this.byBasename.set(key, [page]);

    for (const alias of page.aliases) {
      const akey = alias.toLowerCase();
      const abucket = this.byAlias.get(akey);
      if (abucket) abucket.push(page);
      else this.byAlias.set(akey, [page]);
    }
  }

  private sortBuckets(): void {
    const cmp = (a: RawPage, b: RawPage) => {
      const da = a.path.split('/').length;
      const db = b.path.split('/').length;
      if (da !== db) return da - db;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    };
    for (const bucket of this.byBasename.values()) bucket.sort(cmp);
    for (const bucket of this.byAlias.values()) bucket.sort(cmp);
  }

  /**
   * @param target   Link text, e.g. `Notes/Foo`, `Foo`, `../Foo`
   * @param fromPath Vault-relative path of the note containing the link
   */
  resolve(target: string, fromPath: string): RawPage | null {
    const clean = target.replace(/\\/g, '/').trim();
    if (!clean) return null;

    const candidates = clean.endsWith('.md') ? [clean] : [clean + '.md', clean];
    const fromFolder = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

    // Relative to the linking note's folder FIRST. Obsidian prefers the
    // nearest match, so `[[Foo]]` in `Deep/Other.md` resolves to `Deep/Foo.md`
    // even when a vault-root `Foo.md` also exists.
    for (const candidate of candidates) {
      const joined = normalizePath(fromFolder ? `${fromFolder}/${candidate}` : candidate);
      const hit = this.byPath.get(joined) ?? this.byLowerPath.get(joined.toLowerCase());
      if (hit) return hit;
    }

    // Then the path as written, relative to the vault root.
    for (const candidate of candidates) {
      const exact = this.byPath.get(candidate) ?? this.byLowerPath.get(candidate.toLowerCase());
      if (exact) return exact;
    }

    // Basename match. Prefer a note in the same folder before falling back to
    // the shortest path, which is what Obsidian does.
    const base = clean.slice(clean.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const bucket = this.byBasename.get(base.toLowerCase());
    if (bucket && bucket.length) {
      if (fromFolder) {
        const sameFolder = bucket.find((p) => p.folder === fromFolder);
        if (sameFolder) return sameFolder;
      }
      return bucket[0];
    }

    const aliasBucket = this.byAlias.get(clean.toLowerCase());
    if (aliasBucket && aliasBucket.length) return aliasBucket[0];

    return null;
  }
}

export function normalizePath(path: string): string {
  const parts = path.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Resolve every outgoing link in place and build the reverse index.
 * Returns a map of path -> paths that link to it.
 */
export function buildLinkGraph(pages: RawPage[]): Map<string, string[]> {
  const resolver = new LinkResolver(pages);
  const inlinks = new Map<string, Set<string>>();

  for (const page of pages) {
    for (const link of page.outlinks) {
      const hit = resolver.resolve(link.raw, page.path);
      if (hit) {
        link.path = hit.path;
        link.resolved = true;
        let set = inlinks.get(hit.path);
        if (!set) inlinks.set(hit.path, (set = new Set()));
        set.add(page.path);
      } else {
        link.path = link.raw;
        link.resolved = false;
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [path, set] of inlinks) out.set(path, [...set].sort());
  return out;
}
