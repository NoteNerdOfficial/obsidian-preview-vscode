/**
 * Sanity-check the link resolver: an unresolved link should mean the target
 * genuinely does not exist, not that resolution failed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { indexVault } from './harness';

const root = process.argv[2];
if (!root) {
  console.error('usage: tsx test/check-links.ts <vault-path>');
  process.exit(1);
}

const pages = indexVault(root);
const byName = new Map<string, string[]>();
for (const p of pages) {
  const key = p.name.toLowerCase();
  const bucket = byName.get(key);
  if (bucket) bucket.push(p.path);
  else byName.set(key, [p.path]);
}

const unresolved = pages.flatMap((p) =>
  p.outlinks.filter((l) => !l.resolved).map((l) => ({ from: p.path, raw: l.raw, embed: l.embed }))
);

// Split unresolved links into ones we should have caught and ones that are
// genuinely dangling.
const shouldHaveResolved: typeof unresolved = [];
const nonMarkdown: typeof unresolved = [];
const genuinelyMissing: typeof unresolved = [];

for (const link of unresolved) {
  const base = link.raw.slice(link.raw.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  if (/\.(png|jpe?g|gif|svg|webp|pdf|mp4|mp3|excalidraw|canvas|webm|mov)$/i.test(link.raw)) {
    nonMarkdown.push(link);
  } else if (byName.has(base.toLowerCase())) {
    shouldHaveResolved.push(link);
  } else {
    genuinelyMissing.push(link);
  }
}

console.log(`notes:              ${pages.length}`);
console.log(`links:              ${pages.reduce((a, p) => a + p.outlinks.length, 0)}`);
console.log(`resolved:           ${pages.reduce((a, p) => a + p.outlinks.filter((l) => l.resolved).length, 0)}`);
console.log(`unresolved:         ${unresolved.length}`);
console.log(`  attachments:      ${nonMarkdown.length}   (images/pdfs — not indexed, expected)`);
console.log(`  dangling:         ${genuinelyMissing.length}   (target note does not exist)`);
console.log(`  RESOLVER BUGS:    ${shouldHaveResolved.length}   (a note with this basename exists!)`);

if (shouldHaveResolved.length) {
  console.log('\nLinks that should have resolved:');
  for (const l of shouldHaveResolved.slice(0, 20)) {
    const base = l.raw.slice(l.raw.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    console.log(`  [[${l.raw}]] in ${l.from}`);
    console.log(`     candidates: ${byName.get(base.toLowerCase())!.join(', ')}`);
  }
}

console.log('\nSample dangling links (expected — targets do not exist):');
for (const l of genuinelyMissing.slice(0, 8)) console.log(`  [[${l.raw}]]  in ${l.from}`);

// Ambiguous basenames are where shortest-path tie-breaking matters.
const ambiguous = [...byName.entries()].filter(([, paths]) => paths.length > 1);
console.log(`\nambiguous basenames: ${ambiguous.length}`);
for (const [name, paths] of ambiguous.slice(0, 5)) {
  console.log(`  "${name}" -> ${paths.length} notes: ${paths.slice(0, 3).join(' | ')}`);
}

process.exit(shouldHaveResolved.length > 0 ? 1 : 0);
