// Types and small helpers shared by the Worker and the Durable Objects.

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

export function isRole(v: unknown): v is Role {
  return v === 'owner' || v === 'admin' || v === 'member' || v === 'viewer';
}

/** Who is calling: a human (user key) or one of a human's Claudes (agent key). */
export interface Actor {
  userId: string;
  userName: string;
  agentId?: string;
  agentName?: string;
}

export function actorId(a: Actor): string {
  return a.agentId ?? a.userId;
}

/** "ceo's Claude" for agents, "ceo" for humans. */
export function actorLabel(a: Actor): string {
  return a.agentId ? `${a.userName}'s ${a.agentName ?? 'Claude'}` : a.userName;
}

/**
 * An expected, user-facing failure. Durable Object RPC keeps only an error's message, so the
 * HTTP status rides in it ("E403:…") and `readError` takes it back out on the Worker side.
 */
export class BatonError extends Error {
  constructor(message: string, status = 400) {
    super(`E${status}:${message}`);
  }
}

export function readError(e: unknown): { status: number; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /E(\d{3}):([\s\S]*)$/.exec(raw);
  if (m?.[1] && m[2] !== undefined) return { status: Number(m[1]), message: m[2] };
  return { status: 500, message: `Baton hit an internal error: ${raw}` };
}

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomToken(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += B62[b % 62];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Single line, at most `max` characters. */
export function clip(text: string | null | undefined, max: number): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Things that must never land in a shared vault. Matching is deliberately broad: a refused
// write costs one retry, a leaked token costs an account.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/_\|WARNING:-DO-NOT-SHARE-THIS/i, 'a Roblox .ROBLOSECURITY cookie'],
  [/\.ROBLOSECURITY\s*[=:]\s*\S{20,}/i, 'a Roblox cookie'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}/, 'an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'a GitHub token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/, 'a JWT / session token'],
  [/\bbt_[ua]_[A-Za-z0-9]{32}\b/, 'a Baton key'],
  [/[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/, 'a Discord bot token'],
  [/\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"']{12,}/i, 'a password or key'],
];

/** Returns what kind of secret the text seems to contain, or undefined. */
export function findSecret(text: string): string | undefined {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return undefined;
}

export function assertNoSecret(...texts: (string | undefined)[]): void {
  for (const t of texts) {
    if (!t) continue;
    const what = findSecret(t);
    if (what) {
      throw new BatonError(
        `Refused: this looks like it contains ${what}. Secrets never go into the shared vault; remove it and write again.`,
      );
    }
  }
}
