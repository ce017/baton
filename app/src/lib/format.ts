export function ago(at: number, now = Date.now()): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString();
}

// People keep the same colour everywhere. Their Claudes share it (plus a small bot badge).
const PEOPLE = ['#2b59c3', '#7a4cc2', '#0f8a83', '#b5541e', '#9c3d74', '#4d7c0f', '#5a6b7d', '#a8442f'];

/** "ceo's Claude" → "ceo"; "ceo" → "ceo". */
export function ownerName(label: string): string {
  return label.replace(/'s\s.*$/, '').trim().toLowerCase();
}

export function personColor(label: string): string {
  const name = ownerName(label);
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEOPLE[h % PEOPLE.length] ?? PEOPLE[0]!;
}

export type Presence = 'live' | 'idle' | 'away';

/** live: active in the last 3 minutes; idle: last 30 minutes; away: older. */
export function presence(lastSeen: number, now = Date.now()): Presence {
  const m = (now - lastSeen) / 60000;
  return m < 3 ? 'live' : m < 30 ? 'idle' : 'away';
}

export const presenceText: Record<Presence, string> = { live: 'Active now', idle: 'Idle', away: 'Away' };
