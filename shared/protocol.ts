/**
 * Wire format between the extension host and the preview webview.
 *
 * Everything crossing this boundary must be structured-clone safe, so the
 * index carries dates as epoch millis and links as plain records. The webview
 * hydrates them into real Luxon DateTimes and Link instances on arrival.
 */

export interface RawLink {
  /** Vault-relative path if resolved, otherwise the raw link text. */
  path: string;
  /** Link text as written, before resolution. */
  raw: string;
  display?: string;
  subpath?: string;
  type: 'file' | 'header' | 'block';
  embed: boolean;
  /** False when the link points at a note that does not exist yet. */
  resolved: boolean;
}

export interface RawTask {
  text: string;
  /** Raw status char between the brackets: ' ', 'x', '/', '-', ... */
  status: string;
  completed: boolean;
  fullyCompleted: boolean;
  checked: boolean;
  line: number;
  /** Character offset of the status char within the document. */
  statusOffset: number;
  indent: number;
  section: string | null;
  /** Line numbers of nested child tasks/list items. */
  children: number[];
  parent: number | null;
  tags: string[];
  /** Inline `key:: value` fields found on the task line. */
  fields: Record<string, unknown>;
  /** Tasks-plugin emoji metadata, as epoch millis. */
  due: number | null;
  scheduled: number | null;
  start: number | null;
  completion: number | null;
  created: number | null;
  priority: string | null;
  recurrence: string | null;
}

export interface RawListItem {
  text: string;
  line: number;
  indent: number;
  section: string | null;
  task: boolean;
}

export interface RawSection {
  heading: string;
  level: number;
  line: number;
}

export interface RawPage {
  /** Vault-relative, POSIX separators, including extension. */
  path: string;
  /** Basename WITHOUT extension — matches Obsidian's file.name. */
  name: string;
  folder: string;
  ext: string;
  ctime: number;
  mtime: number;
  size: number;
  frontmatter: Record<string, unknown>;
  /** Inline `key:: value` fields from the body. */
  fields: Record<string, unknown>;
  /** All tags including parent expansion, each with a leading '#'. */
  tags: string[];
  /** Exact tags as written, each with a leading '#'. */
  etags: string[];
  aliases: string[];
  /** Derived from frontmatter date or a dated filename, as epoch millis. */
  day: number | null;
  outlinks: RawLink[];
  tasks: RawTask[];
  lists: RawListItem[];
  sections: RawSection[];
}

/** Extension host -> webview. */
export type HostMessage =
  | { type: 'init'; settings: PreviewSettings; currentPath: string }
  | { type: 'document'; path: string; text: string; version: number }
  | { type: 'index'; pages: RawPage[]; complete: boolean }
  | { type: 'indexDelta'; changed: RawPage[]; removed: string[] }
  | { type: 'response'; id: number; ok: true; value: unknown }
  | { type: 'response'; id: number; ok: false; error: string };

/** Webview -> extension host. */
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; args: unknown[] }
  | { type: 'setTaskStatus'; line: number; status: string }
  | { type: 'openLink'; path: string; subpath?: string; newTab?: boolean }
  | { type: 'request'; id: number; method: RequestMethod; params: unknown };

export type RequestMethod =
  | 'loadView'
  | 'loadBase'
  | 'vaultRead'
  | 'vaultModify'
  | 'vaultCreate'
  | 'vaultDelete'
  | 'executeCommand'
  | 'resolveResource';

export interface LoadBaseResult {
  /** Raw YAML of the .base file. */
  yaml: string;
  /** Vault-relative path it was loaded from. */
  path: string;
}

export interface LoadViewResult {
  js: string | null;
  css: string | null;
  /** Path the view was loaded from, for error messages. */
  source: string | null;
}

export interface PreviewSettings {
  enableDataviewJs: boolean;
  dailyNoteFormat: string;
  vaultName: string;
}
