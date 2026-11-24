import { type Config, call, type Role, tauriInvoke, type TreeItem } from './api.ts';

/**
 * Two-way sync between a project's notes and a folder in an Obsidian vault (desktop app only).
 * Each note is "<path>.md" with its one-line summary in the frontmatter, so [[wikilinks]] just work.
 * Admins and owners sync both ways; members get a read-only copy (their edits stay local).
 * Deleting a file doesn't delete the note: it comes back at the next sync.
 */
export interface Prefs {
  enabled: boolean;
  folder: string;
}
export type SyncState = Record<string, { path: string; version: number; hash: string }>;
export interface Result {
  at: number;
  pulled: number;
  pushed: number;
  conflicts: number;
  localOnly: number;
  error?: string;
}

export const prefsKey = (slug: string) => `baton.obsidian.${slug}`;
export const stateKey = (slug: string) => `baton.obsidian.state.${slug}`;
export const read = <T,>(k: string, d: T): T => {
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(k) ?? '{}') };
  } catch {
    return d;
  }
};
export const loadObsidian = (slug: string) => read<Prefs>(prefsKey(slug), { enabled: false, folder: '' });

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
export function hash(s: string): string {
  let h = 0x811c9dc5;
  const t = norm(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function toFile(p: { summary: string; body: string; kind: string }): string {
  const kind = p.kind === 'decision' ? 'baton-kind: decision\n' : '';
  return `---\nsummary: ${JSON.stringify(p.summary)}\n${kind}---\n\n${norm(p.body)}\n`;
}

export function parseFile(content: string): { summary: string; body: string; kind: 'page' | 'decision' } {
  const t = content.replace(/\r\n/g, '\n');
  let summary = '';
  let kind: 'page' | 'decision' = 'page';
  let body = t;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (fm) {
    body = t.slice(fm[0].length);
    for (const line of (fm[1] ?? '').split('\n')) {
      const m = /^(summary|baton-kind):\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = (m[2] ?? '').trim();
      if (v.startsWith('"')) {
        try {
          v = JSON.parse(v);
        } catch {}
      }
      if (m[1] === 'summary') summary = v;
      else if (v === 'decision') kind = 'decision';
    }
  }
  body = norm(body);
  if (!summary) summary = (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').slice(0, 120);
  return { summary, body, kind };
}

const isConflictCopy = (rel: string) => / \(conflict \d{4}-\d{2}-\d{2}[^)]*\)\.md$/i.test(rel);

interface Page {
  path: string;
  kind: string;
  summary: string;
  body: string;
  version: number;
}

export async function syncObsidian(cfg: Config, slug: string, role: Role, folder: string): Promise<Result> {
  const canEdit = role === 'owner' || role === 'admin';
  const api = (m: 'GET' | 'PUT', path: string, body?: unknown) => call<Page>(cfg, m, path, body);
  const pageOf = (p: string) => api('GET', `/api/projects/${slug}/page?path=${encodeURIComponent(p)}`);
  const write = (rel: string, content: string) => tauriInvoke('vault_write', { folder, rel, content });
  const r: Result = { at: Date.now(), pulled: 0, pushed: 0, conflicts: 0, localOnly: 0 };

  const tree = (await call<TreeItem[]>(cfg, 'GET', `/api/projects/${slug}/tree`)).filter((t) => t.kind !== 'skill');
  const files = await tauriInvoke<{ rel: string; content: string }[]>('vault_scan', { folder });
  const byPath = new Map(files.filter((f) => !isConflictCopy(f.rel)).map((f) => [f.rel.replace(/\.md$/i, '').toLowerCase(), f]));
  const state = read<SyncState>(stateKey(slug), {});
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');

  async function pull(path: string) {
    const page = await pageOf(path);
    const content = toFile(page);
    await write(`${page.path}.md`, content);
    state[path.toLowerCase()] = { path: page.path, version: page.version, hash: hash(content) };
    r.pulled++;
  }
  async function push(path: string, content: string) {
    const f = parseFile(content);
    await api('PUT', `/api/projects/${slug}/page`, { path, body: f.body, summary: f.summary, kind: f.kind, mode: 'replace' });
    const page = await pageOf(path);
    state[path.toLowerCase()] = { path: page.path, version: page.version, hash: hash(content) };
    r.pushed++;
  }

  for (const item of tree) {
    const k = item.path.toLowerCase();
    const s = state[k];
    const f = byPath.get(k);
    byPath.delete(k);
    if (!f) {
      await pull(item.path);
      continue;
    }
    const fileHash = hash(f.content);
    if (!s) {
      // First sync with a file already there: same text counts as in sync.
      const page = await pageOf(item.path);
      if (norm(parseFile(f.content).body) === norm(page.body)) {
        state[k] = { path: item.path, version: page.version, hash: fileHash };
        continue;
      }
    }
    const localChanged = !s || fileHash !== s.hash;
    const serverChanged = !s || item.version !== s.version;
    if (!localChanged && !serverChanged) continue;
    if (serverChanged && !localChanged) await pull(item.path);
    else if (localChanged && !serverChanged) {
      if (canEdit) await push(item.path, f.content);
      else r.localOnly++;
    } else {
      // Both changed: Baton's version wins the note, yours is kept next to it.
      await write(`${item.path} (conflict ${stamp}).md`, f.content);
      await pull(item.path);
      r.conflicts++;
    }
  }

  // Notes made in Obsidian that Baton doesn't have yet.
  for (const f of byPath.values()) {
    const path = f.rel.replace(/\.md$/i, '');
    if (canEdit && norm(f.content)) await push(path, f.content);
    else r.localOnly++;
  }

  localStorage.setItem(stateKey(slug), JSON.stringify(state));
  return r;
}

