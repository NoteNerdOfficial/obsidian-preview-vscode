export interface CodeBlock {
  lang: 'dataview' | 'dataviewjs' | 'base';
  code: string;
  placeholder: string;
}

const BLOCK_RE =
  /^([ \t]*)(`{3,}|~{3,})[ \t]*(dataviewjs|dataview|base)[ \t]*$([\s\S]*?)^\1\2[ \t]*$/gm;

/**
 * Pull dataview blocks out before markdown rendering and drop a placeholder in
 * their place, then fill the placeholders in afterwards. Rendering them inline
 * is impossible: dataviewjs is async and markdown-it's renderer is not.
 *
 * The placeholder is padded to occupy exactly as many lines as the block it
 * replaces. Otherwise every task after a dataview block reports a shifted line
 * number, and toggling its checkbox edits the wrong line of the file.
 */
export function extractBlocks(text: string): { markdown: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  const markdown = text.replace(BLOCK_RE, (match, _indent, _fence, lang, code) => {
    const placeholder = `obsidian-preview-block-${blocks.length}`;
    blocks.push({ lang: lang as CodeBlock['lang'], code, placeholder });
    const newlines = (match.match(/\n/g) ?? []).length;
    return `<div id="${placeholder}" class="dataview-block-slot"></div>` + '\n'.repeat(newlines);
  });
  return { markdown, blocks };
}
