// Talking to the Baton server, and where the app keeps its config.
// In the desktop app the config is the same ~/.baton/config.json the CLI uses (via Rust);
// in a plain browser (dev preview) it lives in localStorage.

export interface Config {
  server?: string;
  user?: string;
  userKey?: string;
  agentName?: string;
  agentKey?: string;
  project?: string;
  dirs?: Record<string, string>;
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

const LS_KEY = 'baton.config';

export async function loadConfig(): Promise<Config> {
  if (isTauri) {
    try {
      return JSON.parse(await tauriInvoke<string>('load_config')) as Config;
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const text = JSON.stringify(cfg, null, 2);
  if (isTauri) await tauriInvoke('save_config', { json: text });
  else localStorage.setItem(LS_KEY, text);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type KeyKind = 'user' | 'agent' | { admin: string };

export async function call<T>(
  cfg: Config,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  key: KeyKind = 'user',
): Promise<T> {
  if (!cfg.server) throw new ApiError('No server set.', 0);
  const token = typeof key === 'object' ? key.admin : key === 'agent' ? cfg.agentKey : cfg.userKey;
  if (!token) throw new ApiError(key === 'agent' ? 'This PC has no Claude key yet.' : 'Not signed in.', 401);
  let res: Response;
  try {
    res = await fetch(new URL(path, cfg.server), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach ${cfg.server}. Is the server running?`, 0);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : text;
    throw new ApiError(msg || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

// ---- server shapes

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

export interface Me {
  user: string;
  agent: string | null;
  projects: { id: string; slug: string; name: string }[];
  agents?: { name: string; defaultProject: string | null }[];
}

export interface LiveCard {
  id: string;
  label: string;
  userId: string;
  isAgent: boolean;
  doing: string;
  where: string;
  next: string;
  updatedAt: number;
  lastSeen: number;
  lastReply: string;
  lastReplyAt: number;
  lastEdit: string;
  lastEditAt: number;
}

export interface Overview {
  project: { slug: string; name: string };
  role: Role;
  me: string;
  members: { name: string; role: Role }[];
  live: LiveCard[];
  locks: { area: string; actor_id: string; label: string; note: string; at: number }[];
  counts: { pages: number; skills: number; openTasks: number };
  unread: number;
  now: number;
}

export interface TreeItem {
  path: string;
  title: string;
  kind: 'page' | 'decision' | 'skill';
  summary: string;
  pinned: number;
  version: number;
  updated_by_name: string;
  updated_at: number;
}

export interface Comment {
  by_name: string;
  text: string;
  at: number;
}

export interface Page {
  path: string;
  title: string;
  kind: 'page' | 'decision' | 'skill';
  summary: string;
  body: string;
  tags: string[];
  pinned: boolean;
  version: number;
  updatedBy: string;
  updatedAt: number;
  files: string[];
  comments: Comment[];
}

export interface Task {
  id: string;
  n: number;
  title: string;
  status: TaskStatus;
  assignee: string;
  area: string;
  notes: string;
  created_by_name: string;
  updated_by_name: string;
  updated_at: number;
  comments: Comment[];
}

export interface Message {
  seq: number;
  from_label: string;
  to_label: string;
  kind: string;
  text: string;
  ref: string;
  at: number;
  unread: boolean;
}

export interface FeedRow {
  seq: number;
  label: string;
  kind: string;
  text: string;
  at: number;
}

export const canEdit = (role?: Role) => role === 'owner' || role === 'admin';
