/**
 * Focused regression tests for the correctness traps this engine is meant to
 * avoid — several of which are live bugs in other VS Code Dataview ports.
 */
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
for (const key of ['document', 'HTMLElement', 'Node', 'DocumentFragment', 'Element']) {
  (globalThis as Record<string, unknown>)[key] = (window as Record<string, unknown>)[key];
}
(globalThis as Record<string, unknown>).window = window;

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
    console.log(`  FAIL  ${name}`);
  }
}

function throws(name: string, fn: () => unknown): void {
  try {
    fn();
    failures.push(`${name} — expected a throw, got none`);
    console.log(`  FAIL  ${name}`);
  } catch {
    passed++;
    console.log(`  ok    ${name}`);
  }
}

async function main() {
  const { installDomShims } = await import('../webview/obsidian/dom');
  installDomShims();

  const { parseMarkdown, buildPage, resolveDay } = await import('../src/index/parse');
  const { LinkResolver, buildLinkGraph } = await import('../src/index/links');
  const { tokenize } = await import('../webview/dql/lexer');
  const { parseQuery } = await import('../webview/dql/parser');
  const { executeQuery } = await import('../webview/dql/engine');
  const { PageIndex } = await import('../webview/dataview/pages');
  const { dataArray, isDataArray, Link } = await import('../webview/dataview/values');
  const { DateTime } = await import('luxon');
  const stat = { ctime: 0, mtime: 0, size: 0 };

  // -------------------------------------------------------------------------
  console.log('\n[lexer] keywords inside literals');
  // The classic failure: a regex clause-splitter sees "From" inside the string.
  check(
    'FROM inside a string is one string token',
    tokenize('WHERE title = "From Russia With Love"').filter((t) => t.type === 'keyword').map((t) => t.value),
    ['where']
  );
  check(
    'SORT inside a wikilink is not a keyword',
    tokenize('WHERE x = [[Sort of a Note]]').filter((t) => t.type === 'keyword').map((t) => t.value),
    ['where']
  );
  const q1 = parseQuery('TABLE file.name WHERE title = "From Russia" SORT file.mtime DESC');
  check('query with keyword-in-string parses', q1.clauses.map((c) => c.kind), ['where', 'sort']);
  throws('unterminated string throws', () => tokenize('WHERE x = "oops'));

  // -------------------------------------------------------------------------
  console.log('\n[parser] precedence and structure');
  const q2 = parseQuery('LIST WHERE a = 1 OR b = 2 AND c = 3');
  const w2 = q2.clauses[0];
  // AND binds tighter than OR: a=1 OR (b=2 AND c=3)
  check(
    'AND binds tighter than OR',
    w2.kind === 'where' && w2.expr.kind === 'binary' ? w2.expr.op : null,
    'or'
  );
  const q3 = parseQuery('TABLE WITHOUT ID file.link AS "Note", len AS "Len" FROM "a" OR "b"');
  check('TABLE WITHOUT ID', q3.withoutId, true);
  check('AS labels', q3.fields.map((f) => f.label), ['Note', 'Len']);
  check('multi-source FROM ... OR ...', q3.source.kind, 'or');
  const q4 = parseQuery('TASK FROM "M" WHERE !completed AND owner = [[Alice]]');
  check('TASK type', q4.type, 'TASK');
  const q5 = parseQuery('TABLE rows.file.link FROM #x GROUP BY status FLATTEN tags AS t LIMIT 5');
  check('all clause kinds parse', q5.clauses.map((c) => c.kind), ['group', 'flatten', 'limit']);

  // -------------------------------------------------------------------------
  console.log('\n[parse] frontmatter, tags, names');
  const crlf = parseMarkdown('---\r\ntitle: Hi\r\ntags: [a, b]\r\n---\r\n\r\nBody\r\n');
  check('CRLF frontmatter parses', crlf.frontmatter.title, 'Hi');

  const tagDoc = parseMarkdown(
    ['#real/tag', 'See https://example.com/#notatag', '```', '#fenced', '```', 'Use `#inline` too', 'Issue #1'].join('\n')
  );
  check('tags exclude URLs, fences, inline code, bare numbers', tagDoc.etags.sort(), ['#real/tag']);
  check('nested tags expand to parents', tagDoc.tags.sort(), ['#real', '#real/tag']);

  const page = buildPage('Notes/Deep/My Note.md', '# Hi\n', stat, 'yyyy-MM-dd');
  check('file.name excludes the extension', page.name, 'My Note');
  check('file.folder', page.folder, 'Notes/Deep');
  check('file.ext', page.ext, 'md');

  // -------------------------------------------------------------------------
  console.log('\n[parse] tasks');
  const tasks = parseMarkdown(
    [
      '## Section',
      '- [ ] open task #work 📅 2024-03-01 ⏫',
      '- [x] done parent',
      '    - [ ] open child',
      '- [x] fully done',
      '    - [x] done child'
    ].join('\n')
  );
  check('task count', tasks.tasks.length, 5);
  check('status chars', tasks.tasks.map((t) => t.status), [' ', 'x', ' ', 'x', 'x']);
  check('due date parsed from emoji', tasks.tasks[0].due, DateTime.fromISO('2024-03-01').toMillis());
  check('priority parsed', tasks.tasks[0].priority, 'high');
  check('emoji stripped from text', tasks.tasks[0].text, 'open task #work');
  check('task tags', tasks.tasks[0].tags, ['#work']);
  check('section attached', tasks.tasks[0].section, 'Section');
  check(
    'fullyCompleted rolls up subtasks',
    tasks.tasks.map((t) => t.fullyCompleted),
    [false, false, false, true, true]
  );

  // statusOffset must point exactly at the status char.
  const src = '- [ ] alpha\n  - [x] beta\n';
  const off = parseMarkdown(src);
  check('statusOffset points at status char', off.tasks.map((t) => src[t.statusOffset]), [' ', 'x']);

  // -------------------------------------------------------------------------
  console.log('\n[parse] dates');
  // Must not round-trip through `new Date().toISOString()`, which shifts
  // date-only values across the UTC boundary in negative-offset zones.
  const day = resolveDay({}, '2024-03-15', 'yyyy-MM-dd');
  const asDt = DateTime.fromMillis(day!);
  check('file.day keeps the local calendar date', [asDt.year, asDt.month, asDt.day], [2024, 3, 15]);
  check('file.day is local midnight', [asDt.hour, asDt.minute], [0, 0]);

  // -------------------------------------------------------------------------
  console.log('\n[links] resolution');
  const linkPages = [
    buildPage('Index.md', '[[Foo]] [[Deep/Foo]] [[Bar|alias text]] [[Nope]]', stat, 'yyyy-MM-dd'),
    buildPage('Foo.md', '', stat, 'yyyy-MM-dd'),
    buildPage('Deep/Foo.md', '', stat, 'yyyy-MM-dd'),
    buildPage('Deep/Nested/Bar.md', '', stat, 'yyyy-MM-dd')
  ];
  buildLinkGraph(linkPages);
  const idx = linkPages[0];
  check('exact path wins over basename', idx.outlinks[1].path, 'Deep/Foo.md');
  check('shortest path wins for ambiguous basename', idx.outlinks[0].path, 'Foo.md');
  check('display text preserved', idx.outlinks[2].display, 'alias text');
  check('missing target is unresolved', idx.outlinks[3].resolved, false);

  const resolver = new LinkResolver(linkPages);
  check('same-folder preferred', resolver.resolve('Foo', 'Deep/Other.md')?.path, 'Deep/Foo.md');

  // -------------------------------------------------------------------------
  console.log('\n[DataArray] proxy behaviour');
  const arr = dataArray([{ file: { name: 'a' } }, { file: { name: 'b' } }]);
  check('field auto-mapping', (arr as never as { file: { name: { values: string[] } } }).file.name.values, ['a', 'b']);
  check('numeric index', JSON.stringify(arr[0]), JSON.stringify({ file: { name: 'a' } }));
  check('negative index', JSON.stringify(arr[-1]), JSON.stringify({ file: { name: 'b' } }));
  check('length', arr.length, 2);
  check('spread works', [...dataArray([1, 2, 3])], [1, 2, 3]);
  check('isDataArray', isDataArray(arr), true);
  // Without a `then` trap, awaiting a DataArray hangs forever.
  const awaited = await Promise.race([
    Promise.resolve(dataArray([1, 2])),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 300))
  ]);
  check('awaiting a DataArray does not hang', isDataArray(awaited), true);
  check('sort is non-mutating', (() => {
    const original = [3, 1, 2];
    dataArray(original).sort((x) => x);
    return original;
  })(), [3, 1, 2]);
  check('groupBy', dataArray([1, 2, 3, 4]).groupBy((n) => n % 2).values.map((g) => g.rows.length), [2, 2]);

  // -------------------------------------------------------------------------
  console.log('\n[engine] source matching');
  const enginePages = [
    buildPage('notes/a.md', '---\ntype: concept\n---\n#alpha\n', stat, 'yyyy-MM-dd'),
    buildPage('notes/deep/b.md', '---\ntype: essay\n---\n', stat, 'yyyy-MM-dd'),
    buildPage('my-notes-archive/c.md', '---\ntype: concept\n---\n', stat, 'yyyy-MM-dd'),
    buildPage('other/d.md', '#alpha/beta\n', stat, 'yyyy-MM-dd')
  ];
  buildLinkGraph(enginePages);
  const index = new PageIndex();
  index.upsert(enginePages);

  const run = (q: string) => {
    const r = executeQuery(q, index, null);
    if (r.type === 'list') return r.items.length;
    if (r.type === 'table') return r.rows.length;
    if (r.type === 'task') return r.tasks.length;
    return r.groups.length;
  };

  // Prefix match on a path boundary, not a substring match.
  check('FROM "notes" excludes my-notes-archive', run('LIST FROM "notes"'), 2);
  check('FROM subfolder', run('LIST FROM "notes/deep"'), 1);
  // Tag sources are hierarchical: FROM #alpha also matches #alpha/beta.
  check('FROM #tag includes subtags', run('LIST FROM #alpha'), 2);
  check('FROM #parent/child is exact', run('LIST FROM #alpha/beta'), 1);
  check('FROM -#tag negates', run('LIST FROM "" AND -#alpha'), 2);
  check('FROM a OR b', run('LIST FROM "notes" OR "other"'), 3);
  check('FROM a AND negation', run('LIST FROM "notes" AND -"notes/deep"'), 1);
  check('WHERE with OR', run('LIST WHERE type = "concept" OR type = "essay"'), 3);
  check('WHERE with AND + negation', run('LIST WHERE type = "concept" AND !contains(file.path, "archive")'), 1);
  check('contains() on path', run('LIST WHERE contains(file.path, "deep")'), 1);
  check('LIMIT', run('LIST FROM "" LIMIT 2'), 2);
  check('GROUP BY', run('TABLE rows.file.link FROM "" GROUP BY type'), 3);

  const table = executeQuery('TABLE type AS "Kind" FROM "notes"', index, null);
  check('TABLE headers include File by default', table.type === 'table' ? table.headers : null, ['File', 'Kind']);
  const tableNoId = executeQuery('TABLE WITHOUT ID type FROM "notes"', index, null);
  check('WITHOUT ID drops the File column', tableNoId.type === 'table' ? tableNoId.headers : null, ['type']);

  // `this` must refer to the querying note.
  const self = executeQuery('LIST WHERE file.name != this.file.name', index, index.get('notes/a.md')!);
  check('this.file.name excludes self', self.type === 'list' ? self.items.length : null, 3);

  // -------------------------------------------------------------------------
  console.log('\n[engine] values and functions');
  const ev = (expr: string) => {
    const r = executeQuery(`TABLE WITHOUT ID ${expr} FROM "notes/a.md"`, index, index.get('notes/a.md')!);
    return r.type === 'table' ? r.rows[0]?.[0] : undefined;
  };
  check('contains on array', ev('contains(file.tags, "alpha")'), true);
  check('length()', ev('length(file.tags)'), 1);
  check('body tag survives frontmatter offset', ev('join(file.tags)'), '#alpha');
  check('default()', ev('default(nothing, "fallback")'), 'fallback');
  check('choice()', ev('choice(true, "y", "n")'), 'y');
  check('round()', ev('round(3.14159, 2)'), 3.14);
  check('upper()', ev('upper("abc")'), 'ABC');
  check('arithmetic', ev('2 + 3 * 4'), 14);
  check('paren precedence', ev('(2 + 3) * 4'), 20);
  check('string concat', ev('"a" + "b"'), 'ab');
  check('date arithmetic yields a duration', typeof ev('date("2024-03-10") - date("2024-03-01")'), 'object');
  check('dateformat()', ev('dateformat(date("2024-03-05"), "yyyy/MM/dd")'), '2024/03/05');
  check('striptime()', ev('dateformat(striptime(date("2024-03-05T13:45")), "HH:mm")'), '00:00');

  // Link equality against plain strings, needed by `owner = [[Alice]]`.
  const link = new Link('People/Alice.md', undefined, undefined, 'file', false, true);
  const { valueEquals } = await import('../webview/dataview/values');
  check('link equals its basename', valueEquals(link, 'Alice'), true);
  check('link equals its path', valueEquals(link, 'People/Alice.md'), true);
  check('link does not equal an unrelated string', valueEquals(link, 'Bob'), false);

  // -------------------------------------------------------------------------
  console.log('\n[engine] grouping, literals, task inheritance');

  const gPages = [
    buildPage('g/a.md', '---\ntype: note\nstatus: draft\n---\n- [ ] one\n- [ ] two\n', stat, 'yyyy-MM-dd'),
    buildPage('g/b.md', '---\ntype: note\nstatus: done\n---\n- [x] three\n', stat, 'yyyy-MM-dd'),
    buildPage('g/c.md', '---\ntype: essay\nstatus: draft\n---\n- [ ] four\n', stat, 'yyyy-MM-dd'),
    buildPage('g/d.md', 'no frontmatter\n', stat, 'yyyy-MM-dd')
  ];
  buildLinkGraph(gPages);
  const gi = new PageIndex();
  gi.upsert(gPages);
  const gcur = gi.get('g/a.md')!;

  const gTable = (q: string) => {
    const r = executeQuery(q, gi, gcur);
    return r.type === 'table' ? r.rows.map((row) => row.map((c) => (c instanceof Link ? c.fileName : c))) : null;
  };

  // list() was missing entirely; a WHERE that used it silently matched nothing.
  check(
    'list() literal',
    gTable('TABLE WITHOUT ID file.name FROM "g" WHERE !contains(list("done"), status) AND status != null')?.flat().sort(),
    ['a', 'c']
  );
  check('array() alias', gTable('TABLE WITHOUT ID length(array(1,2,3)) FROM "g/a.md"'), [[3]]);

  // `rows` must be bound after GROUP BY, and SORT must order the groups.
  check(
    'GROUP BY binds rows, SORT orders groups',
    gTable('TABLE length(rows) AS count FROM "g" WHERE type != null GROUP BY type SORT length(rows) DESC'),
    [['note', 2], ['essay', 1]]
  );
  check(
    'grouped TABLE collapses to one table with the key first',
    (() => {
      const r = executeQuery('TABLE length(rows) AS n FROM "g" WHERE type != null GROUP BY type', gi, gcur);
      return r.type === 'table' ? r.headers : null;
    })(),
    ['type', 'n']
  );
  check(
    'WHERE after GROUP BY filters groups',
    gTable('TABLE length(rows) AS n FROM "g" WHERE type != null GROUP BY type WHERE length(rows) > 1'),
    [['note', 2]]
  );

  // Task rows inherit their page, so file.link and frontmatter resolve.
  const taskGroups = executeQuery('TASK FROM "g" WHERE !completed GROUP BY file.link', gi, gcur);
  check(
    'TASK GROUP BY file.link groups per file',
    taskGroups.type === 'grouped'
      ? taskGroups.groups.map((g) => [
          g.key instanceof Link ? g.key.fileName : String(g.key),
          g.result.type === 'task' ? g.result.tasks.length : -1
        ])
      : null,
    [['a', 2], ['c', 1]]
  );
  check(
    'task row inherits page frontmatter',
    (() => {
      const r = executeQuery('TASK FROM "g" WHERE !completed AND type = "note"', gi, gcur);
      return r.type === 'task' ? r.tasks.length : null;
    })(),
    2
  );
  // `status` exists on both a task (the checkbox char) and page frontmatter.
  // Dataview gives the task's own implicit field precedence; keep that.
  check(
    'task implicit fields shadow page fields',
    (() => {
      const r = executeQuery('TASK FROM "g" WHERE status = " "', gi, gcur);
      return r.type === 'task' ? r.tasks.length : null;
    })(),
    3
  );

  // dur(14 days) is a duration literal, not a parsable expression.
  check('bare duration literal', gTable('TABLE WITHOUT ID dur(14 days).days FROM "g/a.md"'), [[14]]);
  check('quoted duration', gTable('TABLE WITHOUT ID dur("2 weeks").weeks FROM "g/a.md"'), [[2]]);
  check(
    'date keyword + duration arithmetic',
    (() => {
      const r = executeQuery('TABLE WITHOUT ID (date(today) - dur(1 day)) < date(today) FROM "g/a.md"', gi, gcur);
      return r.type === 'table' ? r.rows[0][0] : null;
    })(),
    true
  );
  check(
    'mtime window filter runs',
    (() => {
      const r = executeQuery('LIST FROM "g" WHERE file.mtime >= date(today) - dur(14 days)', gi, gcur);
      return r.type === 'list' ? typeof r.items.length : null;
    })(),
    'number'
  );

  check(
    'type = null finds unfrontmattered notes',
    gTable('TABLE WITHOUT ID file.name FROM "g" WHERE type = null OR status = null')?.flat(),
    ['d']
  );

  // -------------------------------------------------------------------------
  console.log('\n[markdown] rendering');
  const { renderMarkdown } = await import('../webview/render/markdown');
  const resolve = (t: string) => (t === 'Foo' ? 'Foo.md' : null);
  const html = renderMarkdown('A [[Foo]] and [[Missing]] and #tag here', {
    sourcePath: 'x.md',
    resolve,
    inline: true
  });
  check('resolved wikilink', html.includes('class="internal-link" href="#" data-link="Foo"'), true);
  check('unresolved wikilink flagged', html.includes('is-unresolved'), true);
  check('tag rendered as chip', html.includes('class="tag"'), true);

  const taskHtml = renderMarkdown('- [ ] alpha\n- [x] beta\n', { sourcePath: 'x.md', resolve });
  check('checkbox rendered', (taskHtml.match(/task-list-item-checkbox/g) ?? []).length, 2);
  check('checkbox carries source line', taskHtml.includes('data-line="0"'), true);
  check('checked state', taskHtml.includes('checked data-line="1"'), true);
  check('bracket text stripped from label', taskHtml.includes('[ ] alpha'), false);

  const cellHtml = renderMarkdown('**bold** and [[Foo]]', { sourcePath: 'x.md', resolve, inline: true });
  check('markdown renders inside cells', cellHtml.includes('<strong>bold</strong>'), true);

  // -------------------------------------------------------------------------
  console.log('\n[frontmatter] properties panel');
  const { splitFrontmatter, renderProperties } = await import('../webview/render/frontmatter');

  const doc = [
    '---',
    'type: dashboard',
    'status: living',
    'created: 2026-08-10',
    'categories:',
    '  - meta',
    '  - demo',
    'draft: false',
    'weight: 3',
    'owner: "[[Alice]]"',
    'home: https://example.com',
    '---',
    '',
    '# Dashboard',
    '',
    '- [ ] first task'
  ].join('\n');

  const split = splitFrontmatter(doc);
  check('frontmatter parsed', split.data?.type, 'dashboard');
  check('list value parsed', split.data?.categories, ['meta', 'demo']);
  // Blanked, not removed — otherwise every line number below it shifts.
  check('body preserves line count', split.body.split('\n').length, doc.split('\n').length);
  check('body line 15 is the task', split.body.split('\n')[15], '- [ ] first task');
  check('frontmatter text is gone from body', split.body.includes('type: dashboard'), false);

  const panel = renderProperties(split.data, { sourcePath: 'x.md', resolve: () => 'Alice.md' })!;
  const panelHtml = (panel as unknown as { outerHTML: string }).outerHTML;
  check('panel is a details element', panel.tagName.toLowerCase(), 'details');
  check('row per key', (panelHtml.match(/class="prop-row"/g) ?? []).length, 8);
  check('summary count', panelHtml.includes('>8<'), true);
  check('boolean rendered', panelHtml.includes('✗ false'), true);
  check('number rendered', panelHtml.includes('prop-number'), true);
  check('date formatted, not raw ISO', panelHtml.includes('prop-date'), true);
  check('list rendered as chips', (panelHtml.match(/class="prop-chip"/g) ?? []).length, 2);
  check('wikilink in frontmatter is a link', panelHtml.includes('data-link="Alice"'), true);
  check('url rendered as external link', panelHtml.includes('external-link'), true);
  check('no stray hr from ---', panelHtml.includes('<hr'), false);

  const tagged = splitFrontmatter('---\ntags:\n  - a/b\n  - c\n---\n');
  const tagPanel = renderProperties(tagged.data, { sourcePath: 'x.md', resolve: () => null })!;
  check(
    'tags render as clickable tag chips',
    ((tagPanel as unknown as { outerHTML: string }).outerHTML.match(/class="tag"/g) ?? []).length,
    2
  );

  check('no frontmatter yields no panel', renderProperties(splitFrontmatter('# Hi\n').data, {
    sourcePath: 'x.md',
    resolve: () => null
  }), null);
  check('empty frontmatter yields no panel', renderProperties({}, {
    sourcePath: 'x.md',
    resolve: () => null
  }), null);

  const bad = splitFrontmatter('---\nkey: [unclosed\n---\n\nBody\n');
  check('malformed YAML still blanks the block', bad.body.includes('unclosed'), false);
  const badPanel = renderProperties(bad.data, { sourcePath: 'x.md', resolve: () => null, raw: 'key: [unclosed' });
  check(
    'malformed YAML surfaces an error panel',
    badPanel ? (badPanel as unknown as { outerHTML: string }).outerHTML.includes('is-invalid') : false,
    true
  );

  // -------------------------------------------------------------------------
  console.log('\n[blocks] placeholder line alignment');
  const { extractBlocks } = await import('../webview/render/blocks');

  const withBlock = [
    '# Title',                 // 0
    '',                        // 1
    '```dataview',             // 2
    'TABLE file.name',         // 3
    'FROM ""',                 // 4
    'WHERE x = 1',             // 5
    '```',                     // 6
    '',                        // 7
    '- [ ] task after block'   // 8
  ].join('\n');

  const extracted = extractBlocks(withBlock);
  check('block captured', extracted.blocks.length, 1);
  check('block language', extracted.blocks[0].lang, 'dataview');
  // A shorter replacement would shift every later line, so a checkbox toggle
  // would rewrite the wrong line of the user's file.
  check(
    'placeholder preserves total line count',
    extracted.markdown.split('\n').length,
    withBlock.split('\n').length
  );
  check(
    'task stays on its original line',
    extracted.markdown.split('\n')[8],
    '- [ ] task after block'
  );

  const taskAfterBlock = renderMarkdown(extracted.markdown, {
    sourcePath: 'x.md',
    resolve: () => null
  });
  check('checkbox after a block reports line 8', taskAfterBlock.includes('data-line="8"'), true);

  // Frontmatter + block together: both offsets must compose.
  const combined = splitFrontmatter(
    ['---', 'a: 1', '---', '', '```dataview', 'LIST', '```', '', '- [ ] later'].join('\n')
  );
  const combinedExtract = extractBlocks(combined.body);
  check(
    'frontmatter and block offsets compose',
    combinedExtract.markdown.split('\n')[8],
    '- [ ] later'
  );
  check(
    'combined checkbox reports line 8',
    renderMarkdown(combinedExtract.markdown, { sourcePath: 'x.md', resolve: () => null }).includes(
      'data-line="8"'
    ),
    true
  );

  // -------------------------------------------------------------------------
  console.log('\n[bases] expression language');
  const { parseBaseExpr } = await import('../webview/bases/expr');
  const { evaluateBase } = await import('../webview/bases/eval');
  const { parseBase } = await import('../webview/bases/parse');
  const { renderBase } = await import('../webview/bases/render');

  const bPages = [
    buildPage('Research/Alpha.md', '---\ntype: interview\nstatus: raw\ncreated: 2026-08-01\n---\n#topic/a\n', stat, 'yyyy-MM-dd'),
    buildPage('Research/Beta.md', '---\ntype: teardown\nstatus: done\ncreated: 2026-08-02\n---\n', stat, 'yyyy-MM-dd'),
    buildPage('Product/Gamma.md', '---\ntype: spec\nstatus: draft\ncreated: 2026-08-03\n---\n[[Research/Alpha]]\n', stat, 'yyyy-MM-dd'),
    buildPage('Notes.md', 'no frontmatter\n', stat, 'yyyy-MM-dd')
  ];
  buildLinkGraph(bPages);
  const bi = new PageIndex();
  bi.upsert(bPages);

  const be = (source: string, page = 'Research/Alpha.md') => {
    const ctx = {
      page: bi.get(page)!,
      current: bi.get('Notes.md') ?? null,
      index: bi,
      formulas: new Map(),
      formulaCache: new Map(),
      evaluating: new Set<string>()
    };
    return evaluateBase(parseBaseExpr(source), ctx);
  };

  // Bases uses == / && / ||, unlike DQL.
  check('== equality', be('type == "interview"'), true);
  check('!= inequality', be('type != "spec"'), true);
  check('&& conjunction', be('type == "interview" && status == "raw"'), true);
  check('|| disjunction', be('type == "nope" || status == "raw"'), true);
  check('! negation', be('!(type == "spec")'), true);
  check('null comparison', be('missing == null'), true);
  check('property not null', be('type != null'), true);

  // Method-call chaining is the core idiom and has no DQL equivalent.
  check('list().contains()', be('list("done","raw").contains(status)'), true);
  check('negated list().contains()', be('!list("done","current").contains(status)'), true);
  check('string method', be('type.upper()'), 'INTERVIEW');
  check('chained string methods', be('type.upper().lower()'), 'interview');
  check('startsWith', be('type.startsWith("inter")'), true);
  check('isEmpty on missing', be('missing.isEmpty()'), true);
  check('isEmpty on present', be('type.isEmpty()'), false);

  // file namespace and its methods.
  check('file.name', be('file.name'), 'Alpha');
  check('file.folder', be('file.folder'), 'Research');
  check('file.ext', be('file.ext'), 'md');
  check('file.inFolder true', be('file.inFolder("Research")'), true);
  check('file.inFolder false', be('file.inFolder("Product")'), false);
  // Prefix matching must respect path boundaries.
  check('file.inFolder is not a substring match', be('file.inFolder("Res")'), false);
  check('file.hasTag', be('file.hasTag("topic/a")'), true);
  check('file.hasTag with hash', be('file.hasTag("#topic/a")'), true);
  check('file.hasTag missing', be('file.hasTag("nope")'), false);
  check('file.hasLink', be('file.hasLink("Research/Alpha.md")', 'Product/Gamma.md'), true);
  check('file.hasProperty', be('file.hasProperty("status")'), true);
  check('this refers to the embedding note', be('this.file.name'), 'Notes');
  check('file.name != this.file.name', be('file.name != this.file.name'), true);

  // Dates and durations.
  check('today() is a date', DateTime.isDateTime(be('today()')), true);
  check('date() parses frontmatter strings', be('date(created).year'), 2026);
  check('date subtraction yields duration days', typeof be('(today() - date(created)).days'), 'number');
  check('if() true branch', be('if(type, "yes", "no")'), 'yes');
  check('if() false branch', be('if(missing, "yes", "no")'), 'no');
  check('nested if with duration', typeof be('if(created, (today() - date(created)).days, "")'), 'number');

  check('unknown method reports clearly', (() => {
    try {
      be('type.bogus()');
      return 'no error';
    } catch (err) {
      return err instanceof Error && err.message.includes('bogus') ? 'clear error' : 'unclear';
    }
  })(), 'clear error');

  // -------------------------------------------------------------------------
  console.log('\n[bases] definition and views');
  const baseYaml = [
    'filters:',
    '  and:',
    "    - 'file.ext == \"md\"'",
    "    - 'type != null'",
    "    - 'file.name != this.file.name'",
    'formulas:',
    '  is_open: \'!list("done").contains(status)\'',
    'properties:',
    '  file.folder:',
    '    displayName: "Folder"',
    'views:',
    '  - type: table',
    '    name: "All"',
    '    order:',
    '      - file.name',
    '      - type',
    '      - file.folder',
    '    groupBy:',
    '      property: file.folder',
    '      direction: ASC',
    '  - type: table',
    '    name: "Open"',
    '    filters:',
    '      and:',
    "        - 'formula.is_open == true'",
    '    order:',
    '      - file.name',
    '  - type: cards',
    '    name: "Research"',
    '    filters:',
    '      and:',
    '        - \'file.inFolder("Research")\'',
    '    order:',
    '      - file.name',
    '      - status'
  ].join('\n');

  const def = parseBase(baseYaml);
  check('base parses without errors', def.errors, []);
  check('views parsed', def.views.map((v) => `${v.name}:${v.type}`), ['All:table', 'Open:table', 'Research:cards']);
  check('formulas parsed', [...def.formulas.keys()], ['is_open']);
  check('displayName mapping', def.properties.get('file.folder')?.displayName, 'Folder');
  check('groupBy parsed', def.views[0].groupBy?.property, 'file.folder');

  const rendered = renderBase(def, {
    index: bi,
    currentPath: 'Notes.md',
    resolve: (t, f) => bi.resolvePath(t, f),
    title: 'Test'
  });
  const rq = rendered as unknown as {
    querySelectorAll(s: string): Array<{ textContent: string; click?: () => void }>;
    querySelector(s: string): { textContent: string } | null;
  };

  check('a tab per view', rq.querySelectorAll('.base-tab').map((t) => t.textContent), ['All', 'Open', 'Research']);
  check('displayName used as header', rq.querySelectorAll('.base-table th').map((t) => t.textContent), ['Name', 'Type', 'Folder']);
  // Base filters exclude Notes.md (no type) and the embedding note itself.
  check('base-level filters applied', rq.querySelector('.base-count')?.textContent, '3 notes');
  check('groupBy emits group rows', rq.querySelectorAll('.base-group-row').length, 2);

  const openTab = rq.querySelectorAll('.base-tab')[1];
  openTab.click?.();
  check('view filter + formula narrows results', rq.querySelector('.base-count')?.textContent, '2 notes');

  const cardsTab = rq.querySelectorAll('.base-tab')[2];
  cardsTab.click?.();
  check('cards view renders cards', rq.querySelectorAll('.base-card').length, 2);
  check('switching views clears the table', rq.querySelectorAll('.base-table').length, 0);

  // A malformed expression must surface, not silently filter everything out.
  const broken = parseBase('filters:\n  - \'type ===== "x"\'\nviews:\n  - type: table\n    name: "V"\n');
  check('malformed filter reported', broken.errors.length > 0, true);
  const brokenEl = renderBase(broken, {
    index: bi,
    currentPath: 'Notes.md',
    resolve: () => null,
    title: 'Broken'
  }) as unknown as { querySelectorAll(s: string): unknown[]; querySelector(s: string): { textContent: string } | null };
  check('malformed filter shows an error', brokenEl.querySelectorAll('.base-error').length > 0, true);
  // ...and does not hide every row.
  check('malformed filter does not empty the view', brokenEl.querySelector('.base-count')?.textContent, '4 notes');

  const noViews = parseBase('filters:\n  - \'type != null\'\n');
  check('base with no views gets a default', noViews.views.length, 1);

  // -------------------------------------------------------------------------
  console.log('\n[bases] embeds and blocks');
  const embedHtml = renderMarkdown('![[Vault Overview.base]]', { sourcePath: 'x.md', resolve: () => null });
  check('base embed becomes a slot', embedHtml.includes('class="base-embed-slot"'), true);
  check('base embed carries its target', embedHtml.includes('data-base="Vault Overview.base"'), true);
  check(
    'image embeds still render as images',
    renderMarkdown('![[pic.png]]', { sourcePath: 'x.md', resolve: () => null }).includes('image-embed'),
    true
  );

  const baseSource = '# T\n\n```base\nviews:\n  - type: table\n    name: X\n```\n\n- [ ] after\n';
  const baseBlock = extractBlocks(baseSource);
  check('base fenced block captured', baseBlock.blocks[0]?.lang, 'base');
  check(
    'base block preserves line count',
    baseBlock.markdown.split('\n').length,
    baseSource.split('\n').length
  );
  check('task after base block keeps its line', baseBlock.markdown.split('\n')[8], '- [ ] after');
  check(
    'checkbox after a base block reports line 8',
    renderMarkdown(baseBlock.markdown, { sourcePath: 'x.md', resolve: () => null }).includes('data-line="8"'),
    true
  );

  // -------------------------------------------------------------------------
  console.log('\n[vault files] non-markdown files are visible');
  // Reproduces the reported bug directly: an inbox script filters
  // vault.getFiles() by path prefix looking for images dropped in before
  // conversion. If the index only tracks .md, this silently returns nothing
  // even though the files are sitting right there.
  const { createApp } = await import('../webview/obsidian/app');

  const fPages = [buildPage('creditor/notes.md', '---\ntype: note\n---\n', stat, 'yyyy-MM-dd')];
  buildLinkGraph(fPages);
  const fIndex = new PageIndex();
  fIndex.upsert(fPages);
  fIndex.upsertFiles([
    { path: 'creditor/_inbox/IMG_0359.HEIC', name: 'IMG_0359', folder: 'creditor/_inbox', ext: 'HEIC', ctime: 1, mtime: 2, size: 1200000 },
    { path: 'creditor/_inbox/IMG_0360.HEIC', name: 'IMG_0360', folder: 'creditor/_inbox', ext: 'HEIC', ctime: 1, mtime: 2, size: 1100000 },
    { path: 'creditor/notes.md', name: 'notes', folder: 'creditor', ext: 'md', ctime: 0, mtime: 0, size: 20 }
  ]);

  const stubBridge = { request: async () => null, post: () => {}, log: () => {} };
  const fakeApp = createApp(fIndex, stubBridge as never, () => 'creditor/notes.md', 'test-vault');

  check('vault.getFiles() count includes non-markdown files', fakeApp.vault.getFiles().length, 3);
  check(
    // Real TFile.name includes the extension ("IMG_0359.HEIC"); .basename
    // is the stripped form — an inbox script displaying files uses basename.
    'inbox script filter finds the HEIC files',
    fakeApp.vault
      .getFiles()
      .filter((f) => f.path.startsWith('creditor/_inbox/'))
      .map((f) => f.basename)
      .sort(),
    ['IMG_0359', 'IMG_0360']
  );
  check('TFile.name keeps the real extension', fakeApp.vault.getFiles().find((f) => f.basename === 'IMG_0359')?.name, 'IMG_0359.HEIC');
  check(
    'HEIC file carries its real extension and size',
    (() => {
      const f = fakeApp.vault.getFiles().find((x) => x.basename === 'IMG_0359');
      return f ? [f.extension, f.stat.size] : null;
    })(),
    ['HEIC', 1200000]
  );
  check(
    'vault.getMarkdownFiles() still excludes attachments',
    fakeApp.vault.getMarkdownFiles().map((f) => f.path),
    ['creditor/notes.md']
  );
  check(
    'getAbstractFileByPath resolves a non-markdown file',
    fakeApp.vault.getAbstractFileByPath('creditor/_inbox/IMG_0359.HEIC')?.basename,
    'IMG_0359'
  );
  check(
    'getAbstractFileByPath still resolves a markdown file by bare path',
    fakeApp.vault.getAbstractFileByPath('creditor/notes')?.path,
    'creditor/notes.md'
  );
  check(
    'getAbstractFileByPath returns null for a genuinely missing file',
    fakeApp.vault.getAbstractFileByPath('nope/nothing.png'),
    null
  );

  fIndex.removeFiles(['creditor/_inbox/IMG_0360.HEIC']);
  check('removeFiles drops the entry', fakeApp.vault.getFiles().length, 2);

  // -------------------------------------------------------------------------
  console.log('\n[vault files] PageIndex file map');
  const pi = new PageIndex();
  check('allFiles starts empty', pi.allFiles(), []);
  pi.upsertFiles([{ path: 'a.png', name: 'a', folder: '', ext: 'png', ctime: 0, mtime: 0, size: 10 }]);
  check('upsertFiles adds an entry', pi.allFiles().length, 1);
  check('getFileEntry finds it', pi.getFileEntry('a.png')?.ext, 'png');
  check('getFileEntry misses a non-existent path', pi.getFileEntry('missing.png'), undefined);
  pi.upsertFiles([{ path: 'a.png', name: 'a', folder: '', ext: 'png', ctime: 0, mtime: 5, size: 20 }]);
  check('upsertFiles overwrites by path rather than duplicating', pi.allFiles().length, 1);
  check('overwrite carries the new stat', pi.getFileEntry('a.png')?.size, 20);
  pi.removeFiles(['a.png']);
  check('removeFiles empties the map', pi.allFiles(), []);

  // -------------------------------------------------------------------------
  console.log('\n[bases] standalone .base rendering uses the same engine as embeds');
  // main.ts's renderStandaloneBase() is just parseBase + renderBase against
  // the document text directly — the exact same functions already covered by
  // the embed tests above, so this pins that the wiring produces the same
  // shape rather than re-deriving full coverage.
  const standaloneYaml = [
    'views:',
    '  - type: table',
    '    name: "All"',
    '    order:',
    '      - file.name',
    '      - type'
  ].join('\n');
  const standaloneDef = parseBase(standaloneYaml);
  check('standalone base parses', standaloneDef.errors, []);
  const standaloneEl = renderBase(standaloneDef, {
    index: fIndex,
    currentPath: 'Overview.base',
    resolve: () => null,
    title: 'Overview'
  });
  const stq = standaloneEl as unknown as { querySelector(s: string): { textContent: string } | null };
  check('standalone base title comes from the file name, not a note', stq.querySelector('.base-title')?.textContent, 'Overview');

  // -------------------------------------------------------------------------
  console.log('\n[glob] exclude pattern matching for watcher events');
  const { isExcluded } = await import('../src/index/glob');
  const defaultExcludes = ['**/node_modules/**', '**/.git/**', '**/.obsidian/**', '**/.trash/**'];
  check(
    'a dotfolder deep in the tree is excluded',
    isExcluded('.obsidian/workspace.json', defaultExcludes),
    true
  );
  check(
    'node_modules anywhere in the path is excluded',
    isExcluded('vendor/node_modules/pkg/index.md', defaultExcludes),
    true
  );
  check('an ordinary note is not excluded', isExcluded('Notes/Today.md', defaultExcludes), false);
  check('a single * does not cross a path separator', isExcluded('a/b.md', ['*.md']), false);
  check('a bare pattern still matches at the root', isExcluded('b.md', ['*.md']), true);

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

void main();
