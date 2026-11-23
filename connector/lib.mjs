// Shared bits for the baton CLI and the Claude Code hook. Node 22+, no dependencies.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Where the config lives: --config <path>, $BATON_CONFIG, or ~/.baton/config.json. */
export function configPath(argv = process.argv) {
  const i = argv.indexOf('--config');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return process.env.BATON_CONFIG ? resolve(process.env.BATON_CONFIG) : join(homedir(), '.baton', 'config.json');
}

/**
 * {
 *   server: "https://baton.example.workers.dev",
 *   user: "ceo", userKey: "bt_u_…",          // the person (manages projects, members, agents)
 *   agentName: "Claude", agentKey: "bt_a_…",  // this PC's Claude
 *   project: "roll-a-fish",                   // default project
 *   dirs: { "D:/Roll a Fish": "roll-a-fish" } // optional per-folder projects
 * }
 */
export function loadConfig(path = configPath()) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

/** The project for a working directory: the longest matching `dirs` entry, else the default. */
export function projectFor(cfg, cwd) {
  if (cwd && cfg.dirs) {
    const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const here = norm(cwd);
    let best;
    for (const [dir, slug] of Object.entries(cfg.dirs)) {
      const d = norm(dir);
      if ((here === d || here.startsWith(`${d}/`)) && (!best || d.length > best[0].length)) best = [d, slug];
    }
    if (best) return best[1];
  }
  return cfg.project;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Calls the Baton server. `key` is 'user' | 'agent' | 'admin:<token>'. */
export async function api(cfg, method, path, { key = 'agent', body, timeoutMs = 15000, raw = false } = {}) {
  if (!cfg.server) throw new ApiError('No server set. Run: baton login --server <url> --key <user key>', 0);
  const token = key.startsWith('admin:') ? key.slice(6) : key === 'user' ? cfg.userKey : cfg.agentKey;
  if (!token) throw new ApiError(key === 'user' ? 'No user key. Run: baton login' : 'No agent key. Run: baton agent create', 0);
  const res = await fetch(new URL(path, cfg.server), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const textBody = await res.text();
  if (!res.ok) {
    let msg = textBody;
    try {
      msg = JSON.parse(textBody).error ?? textBody;
    } catch {}
    throw new ApiError(msg, res.status);
  }
  if (raw) return textBody;
  try {
    return JSON.parse(textBody);
  } catch {
    return textBody;
  }
}
