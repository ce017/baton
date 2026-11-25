import { DurableObject } from 'cloudflare:workers';
import { BatonError, newId, randomToken, sha256 } from './shared.ts';

/** What a key resolves to. Agents always belong to a human. */
export interface Identity {
  userId: string;
  userName: string;
  agentId?: string;
  agentName?: string;
  defaultProject?: string;
}

export interface ProjectRef {
  id: string;
  slug: string;
  name: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/**
 * The one global object: people, their Claudes, keys and which projects exist. Project
 * content and roles live in each project's own object (ProjectDO).
 */
export class DirectoryDO extends DurableObject<unknown> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, key_hash TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL, default_project TEXT, created_at INTEGER NOT NULL,
        UNIQUE(user_id, name));
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_projects(
        user_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(user_id, project_id));
    `);
    this.ensureAuthTables();
    this.ensureProfileTables();
  }

  async createUser(rawName: string): Promise<{ userId: string; name: string; key: string }> {
    const name = rawName.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      throw new BatonError('Names are 2-32 characters: lowercase letters, digits, - or _.');
    }
    if (this.sql.exec('SELECT 1 FROM users WHERE name = ?', name).toArray().length) {
      throw new BatonError(`The name "${name}" is taken.`, 409);
    }
    const key = `bt_u_${randomToken(32)}`;
    const userId = newId('u');
    this.sql.exec(
      'INSERT INTO users(id, name, key_hash, created_at) VALUES (?, ?, ?, ?)',
      userId,
      name,
      await sha256(key),
      Date.now(),
    );
    return { userId, name, key };
  }

  async createAgent(
    userId: string,
    rawName: string,
  ): Promise<{ agentId: string; name: string; key: string }> {
    const name = rawName.trim() || 'Claude';
    if (name.length > 32) throw new BatonError('Agent names are at most 32 characters.');
    const key = `bt_a_${randomToken(32)}`;
    const agentId = newId('a');
    try {
      this.sql.exec(
        'INSERT INTO agents(id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        agentId,
        userId,
        name,
        await sha256(key),
        Date.now(),
      );
    } catch {
      throw new BatonError(`You already have an agent called "${name}".`, 409);
    }
    return { agentId, name, key };
  }

  /** Replaces an agent's key (the old one stops working at once). */
  async rotateAgentKey(userId: string, agentName: string): Promise<{ key: string }> {
    const key = `bt_a_${randomToken(32)}`;
    const res = this.sql.exec(
      'UPDATE agents SET key_hash = ? WHERE user_id = ? AND name = ?',
      await sha256(key),
      userId,
      agentName,
    );
    if (res.rowsWritten === 0) throw new BatonError(`No agent called "${agentName}".`, 404);
    return { key };
  }

  async identify(keyHash: string): Promise<Identity | null> {
    const user = this.sql
      .exec<{ id: string; name: string }>('SELECT id, name FROM users WHERE key_hash = ?', keyHash)
      .toArray()[0];
    if (user) return { userId: user.id, userName: user.name };
    const sess = this.sql
      .exec<{ id: string; name: string }>('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.key_hash = ?', keyHash)
      .toArray()[0];
    if (sess) return { userId: sess.id, userName: sess.name };
    const agent = this.sql
      .exec<{ id: string; name: string; user_id: string; uname: string; dp: string | null }>(
        `SELECT a.id, a.name, a.user_id, u.name AS uname, a.default_project AS dp
         FROM agents a JOIN users u ON u.id = a.user_id WHERE a.key_hash = ?`,
        keyHash,
      )
      .toArray()[0];
    if (!agent) return null;
    return {
      userId: agent.user_id,
      userName: agent.uname,
      agentId: agent.id,
      agentName: agent.name,
      defaultProject: agent.dp ?? undefined,
    };
  }

  async findUser(rawName: string): Promise<{ userId: string; name: string } | null> {
    const row = this.sql
      .exec<{ id: string; name: string }>(
        'SELECT id, name FROM users WHERE name = ?',
        rawName.trim().toLowerCase(),
      )
      .toArray()[0];
    return row ? { userId: row.id, name: row.name } : null;
  }

  async createProject(ownerId: string, rawSlug: string, name: string): Promise<ProjectRef> {
    const slug = rawSlug.trim().toLowerCase();
    if (!NAME_RE.test(slug)) {
      throw new BatonError('Project slugs are 2-32 characters: lowercase letters, digits, - or _.');
    }
    if (this.sql.exec('SELECT 1 FROM projects WHERE slug = ?', slug).toArray().length) {
      throw new BatonError(`The project slug "${slug}" is taken.`, 409);
    }
    const id = newId('p');
    this.sql.exec(
      'INSERT INTO projects(id, slug, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      slug,
      name.trim() || slug,
      ownerId,
      Date.now(),
    );
    this.sql.exec('INSERT INTO user_projects(user_id, project_id) VALUES (?, ?)', ownerId, id);
    return { id, slug, name: name.trim() || slug };
  }

  async findProject(slug: string): Promise<ProjectRef | null> {
    return (
      this.sql
        .exec<{ id: string; slug: string; name: string }>(
          'SELECT id, slug, name FROM projects WHERE slug = ?',
          slug.trim().toLowerCase(),
        )
        .toArray()[0] ?? null
    );
  }

  async projectsOf(userId: string): Promise<ProjectRef[]> {
    return this.sql
      .exec<{ id: string; slug: string; name: string }>(
        `SELECT p.id, p.slug, p.name FROM projects p
         JOIN user_projects up ON up.project_id = p.id WHERE up.user_id = ? ORDER BY p.name`,
        userId,
      )
      .toArray();
  }

  /** Mirrors a membership change made in the project object, so `projectsOf` stays right. */
  async setMembership(userId: string, projectId: string, member: boolean): Promise<void> {
    if (member) {
      this.sql.exec(
        'INSERT OR IGNORE INTO user_projects(user_id, project_id) VALUES (?, ?)',
        userId,
        projectId,
      );
    } else {
      this.sql.exec(
        'DELETE FROM user_projects WHERE user_id = ? AND project_id = ?',
        userId,
        projectId,
      );
    }
  }

  async setDefaultProject(agentId: string, slug: string): Promise<void> {
    this.sql.exec('UPDATE agents SET default_project = ? WHERE id = ?', slug, agentId);
  }

  async agentsOf(userId: string): Promise<{ name: string; defaultProject: string | null }[]> {
    return this.sql
      .exec<{ name: string; default_project: string | null }>(
        'SELECT name, default_project FROM agents WHERE user_id = ? ORDER BY created_at',
        userId,
      )
      .toArray()
      .map((r) => ({ name: r.name, defaultProject: r.default_project }));
  }

  // ---------------------------------------------------------------- easy sign-in and invites
  private ensureAuthTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions(key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS emails(email TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL,
        role TEXT NOT NULL, uses_left INTEGER NOT NULL, uses INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_invites(email TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
        invited_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(email, project_id));
      CREATE TABLE IF NOT EXISTS login_links(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_requests(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, nonce TEXT NOT NULL,
        key TEXT, user_name TEXT, created_at INTEGER NOT NULL);
    `);
  }

  /** A new sign-in key for an existing person (each device gets its own). */
  async newSession(userId: string): Promise<{ key: string; name: string }> {
    const u = this.sql.exec<{ name: string }>('SELECT name FROM users WHERE id = ?', userId).toArray()[0];
    if (!u) throw new BatonError('No such person.', 404);
    const key = `bt_u_${randomToken(32)}`;
    this.sql.exec('INSERT INTO sessions(key_hash, user_id, created_at) VALUES (?, ?, ?)', await sha256(key), userId, Date.now());
    return { key, name: u.name };
  }

  /** Makes a person with a free name based on `base` ("Boe Smith" → "boe-smith", "boe-smith2"...). */
  async createUserAuto(base: string): Promise<{ userId: string; name: string; key: string }> {
    let stem = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 24);
    if (stem.length < 2) stem = 'member';
    for (let i = 0; i < 200; i++) {
      const name = i ? `${stem}${i + 1}` : stem;
      if (!this.sql.exec('SELECT 1 FROM users WHERE name = ?', name).toArray().length) return this.createUser(name);
    }
    return this.createUser(`${stem.slice(0, 16)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`);
  }

  async userByEmail(email: string): Promise<{ userId: string; name: string } | null> {
    const r = this.sql
      .exec<{ id: string; name: string }>('SELECT u.id, u.name FROM emails e JOIN users u ON u.id = e.user_id WHERE e.email = ?', email.trim().toLowerCase())
      .toArray()[0];
    return r ? { userId: r.id, name: r.name } : null;
  }

  async addEmail(userId: string, email: string): Promise<void> {
    this.sql.exec('INSERT OR IGNORE INTO emails(email, user_id) VALUES (?, ?)', email.trim().toLowerCase(), userId);
  }

  async emailsOf(userId: string): Promise<string[]> {
    return this.sql.exec<{ email: string }>('SELECT email FROM emails WHERE user_id = ?', userId).toArray().map((r) => r.email);
  }

  /** "Add boe@gmail.com as a member": waits until that email signs in. */
  async inviteEmail(email: string, projectId: string, role: string, by: string): Promise<void> {
    this.sql.exec(
      'INSERT INTO email_invites(email, project_id, role, invited_by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email, project_id) DO UPDATE SET role = excluded.role',
      email.trim().toLowerCase(), projectId, role, by, Date.now(),
    );
  }

  async takeEmailInvites(email: string): Promise<{ projectId: string; role: string; invitedBy: string }[]> {
    const e = email.trim().toLowerCase();
    const rows = this.sql.exec<{ project_id: string; role: string; invited_by: string }>('SELECT project_id, role, invited_by FROM email_invites WHERE email = ?', e).toArray();
    this.sql.exec('DELETE FROM email_invites WHERE email = ?', e);
    return rows.map((r) => ({ projectId: r.project_id, role: r.role, invitedBy: r.invited_by }));
  }

  async pendingEmailInvites(projectId: string): Promise<{ email: string; role: string; at: number }[]> {
    return this.sql.exec<{ email: string; role: string; at: number }>('SELECT email, role, at FROM email_invites WHERE project_id = ? ORDER BY at DESC', projectId).toArray();
  }

  async cancelEmailInvite(projectId: string, email: string): Promise<void> {
    this.sql.exec('DELETE FROM email_invites WHERE project_id = ? AND email = ?', projectId, email.trim().toLowerCase());
  }

  /** An invite link: a role, a number of uses and an end date. Only its hash is stored. */
  async createInvite(projectId: string, role: string, uses: number, days: number, by: string) {
    const token = randomToken(24).replace(/[^A-Za-z0-9]/g, '');
    const id = newId('i');
    const expiresAt = Date.now() + Math.max(1, Math.min(30, days)) * 86_400_000;
    const n = Math.max(1, Math.min(100, Math.floor(uses)));
    this.sql.exec(
      'INSERT INTO invites(id, token_hash, project_id, role, uses_left, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, await sha256(token), projectId, role, n, n, expiresAt, by, Date.now(),
    );
    return { id, token, role, usesLeft: n, expiresAt };
  }

  async listInvites(projectId: string) {
    return this.sql
      .exec<{ id: string; role: string; uses_left: number; uses: number; expires_at: number; created_by: string; created_at: number }>(
        'SELECT id, role, uses_left, uses, expires_at, created_by, created_at FROM invites WHERE project_id = ? AND uses_left > 0 AND expires_at > ? ORDER BY created_at DESC',
        projectId, Date.now(),
      )
      .toArray();
  }

  async revokeInvite(projectId: string, id: string): Promise<void> {
    this.sql.exec('UPDATE invites SET uses_left = 0 WHERE id = ? AND project_id = ?', id, projectId);
  }

  async peekInvite(token: string) {
    const r = this.sql
      .exec<{ id: string; project_id: string; role: string; uses_left: number; expires_at: number; created_by: string }>(
        'SELECT id, project_id, role, uses_left, expires_at, created_by FROM invites WHERE token_hash = ?', await sha256(token),
      )
      .toArray()[0];
    if (!r) return null;
    const p = this.sql.exec<{ slug: string; name: string }>('SELECT slug, name FROM projects WHERE id = ?', r.project_id).toArray()[0];
    return { id: r.id, projectId: r.project_id, slug: p?.slug ?? '', projectName: p?.name ?? '', role: r.role, usesLeft: r.uses_left, expiresAt: r.expires_at, invitedBy: r.created_by, ok: r.uses_left > 0 && r.expires_at > Date.now() };
  }

  /** Uses one seat of an invite; throws if it's used up or expired. */
  async useInvite(token: string): Promise<{ projectId: string; slug: string; role: string }> {
    const inv = await this.peekInvite(token);
    if (!inv) throw new BatonError('This invite link is not valid.', 404);
    if (!inv.ok) throw new BatonError('This invite link has expired or is used up. Ask for a new one.', 410);
    this.sql.exec('UPDATE invites SET uses_left = uses_left - 1 WHERE id = ? AND uses_left > 0', inv.id);
    return { projectId: inv.projectId, slug: inv.slug, role: inv.role };
  }

  /** "Sign in on another device": a one-use link that lasts 15 minutes. */
  async createLoginLink(userId: string): Promise<string> {
    const token = randomToken(24).replace(/[^A-Za-z0-9]/g, '');
    this.sql.exec('DELETE FROM login_links WHERE expires_at < ?', Date.now());
    this.sql.exec('INSERT INTO login_links(token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(token), userId, Date.now() + 15 * 60_000);
    return token;
  }

  async useLoginLink(token: string): Promise<{ key: string; name: string }> {
    const h = await sha256(token);
    const r = this.sql.exec<{ user_id: string; expires_at: number }>('SELECT user_id, expires_at FROM login_links WHERE token_hash = ?', h).toArray()[0];
    this.sql.exec('DELETE FROM login_links WHERE token_hash = ?', h);
    if (!r || r.expires_at < Date.now()) throw new BatonError('This sign-in link has expired. Make a new one.', 410);
    return this.newSession(r.user_id);
  }

  /** Google sign-in from the app: the app polls with its secret until the browser finishes. */
  async startLogin(): Promise<{ id: string; secret: string; nonce: string }> {
    const id = randomToken(16).replace(/[^A-Za-z0-9]/g, '');
    const secret = randomToken(24).replace(/[^A-Za-z0-9]/g, '');
    const nonce = randomToken(16).replace(/[^A-Za-z0-9]/g, '');
    this.sql.exec('DELETE FROM login_requests WHERE created_at < ?', Date.now() - 15 * 60_000);
    this.sql.exec('INSERT INTO login_requests(id, secret_hash, nonce, created_at) VALUES (?, ?, ?, ?)', id, await sha256(secret), nonce, Date.now());
    return { id, secret, nonce };
  }

  async loginNonce(id: string): Promise<string | null> {
    return this.sql.exec<{ nonce: string }>('SELECT nonce FROM login_requests WHERE id = ? AND key IS NULL AND created_at > ?', id, Date.now() - 15 * 60_000).toArray()[0]?.nonce ?? null;
  }

  async finishLogin(id: string, userId: string): Promise<void> {
    const s = await this.newSession(userId);
    this.sql.exec('UPDATE login_requests SET key = ?, user_name = ? WHERE id = ?', s.key, s.name, id);
  }

  async pollLogin(id: string, secret: string): Promise<{ key: string; user: string } | null> {
    const r = this.sql.exec<{ secret_hash: string; key: string | null; user_name: string | null }>('SELECT secret_hash, key, user_name FROM login_requests WHERE id = ?', id).toArray()[0];
    if (!r || r.secret_hash !== (await sha256(secret))) throw new BatonError('Unknown sign-in request.', 404);
    if (!r.key) return null;
    this.sql.exec('DELETE FROM login_requests WHERE id = ?', id);
    return { key: r.key, user: r.user_name ?? '' };
  }

  // ---------------------------------------------------------------- profiles and badges
  private ensureProfileTables() {
    try {
      this.sql.exec('ALTER TABLE users ADD COLUMN profile TEXT');
    } catch {}
    this.sql.exec('CREATE TABLE IF NOT EXISTS badges(user_id TEXT NOT NULL, badge TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, badge))');
  }

  /** Badges are given by this server: earned ones are worked out here, special ones only its host can grant. */
  private badgesOf(userId: string): { id: string; label: string; kind: 'earned' | 'host' }[] {
    const out: { id: string; label: string; kind: 'earned' | 'host' }[] = [];
    const u = this.sql.exec<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', userId).toArray()[0];
    if (!u) return out;
    if (this.sql.exec('SELECT 1 FROM projects WHERE owner_id = ? LIMIT 1', userId).toArray().length) out.push({ id: 'founder', label: 'Project founder', kind: 'earned' });
    if (this.sql.exec('SELECT 1 FROM agents WHERE user_id = ? LIMIT 1', userId).toArray().length) out.push({ id: 'claude', label: 'Works with a Claude', kind: 'earned' });
    if (this.sql.exec('SELECT 1 FROM emails WHERE user_id = ? LIMIT 1', userId).toArray().length) out.push({ id: 'verified', label: 'Verified email', kind: 'earned' });
    if (u.created_at < Date.UTC(2027, 0, 1)) out.push({ id: 'early', label: 'Early tester', kind: 'earned' });
    for (const b of this.sql.exec<{ badge: string; label: string }>('SELECT badge, label FROM badges WHERE user_id = ? ORDER BY at', userId).toArray()) {
      out.push({ id: b.badge, label: b.label, kind: 'host' });
    }
    return out;
  }

  async profileOf(userId: string) {
    const u = this.sql.exec<{ name: string; profile: string | null }>('SELECT name, profile FROM users WHERE id = ?', userId).toArray()[0];
    if (!u) return null;
    let p: { display?: string; about?: string; color?: string; status?: string } = {};
    try {
      p = JSON.parse(u.profile ?? '{}');
    } catch {}
    return { name: u.name, display: p.display ?? '', about: p.about ?? '', color: p.color ?? '', status: p.status ?? '', badges: this.badgesOf(userId) };
  }

  async profilesByNames(names: string[]) {
    const out: Record<string, Awaited<ReturnType<DirectoryDO['profileOf']>>> = {};
    for (const n of names.slice(0, 200)) {
      const r = this.sql.exec<{ id: string }>('SELECT id FROM users WHERE name = ?', n).toArray()[0];
      if (r) out[n] = await this.profileOf(r.id);
    }
    return out;
  }

  async setProfile(userId: string, p: { display?: string; about?: string; color?: string; status?: string }) {
    const clean = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
    const color = clean(p.color, 9);
    const next = {
      display: clean(p.display, 40),
      about: clean(p.about, 280),
      status: clean(p.status, 80),
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '',
    };
    this.sql.exec('UPDATE users SET profile = ? WHERE id = ?', JSON.stringify(next), userId);
    return this.profileOf(userId);
  }

  /** Only the server's host (ADMIN_TOKEN) can hand out special badges. */
  async grantBadge(name: string, badge: string, label: string, remove = false) {
    const u = await this.findUser(name);
    if (!u) throw new BatonError(`No person called "${name}".`, 404);
    const id = badge.trim().toLowerCase().slice(0, 32);
    if (!id) throw new BatonError('Give the badge an id.');
    if (remove) this.sql.exec('DELETE FROM badges WHERE user_id = ? AND badge = ?', u.userId, id);
    else this.sql.exec('INSERT OR REPLACE INTO badges(user_id, badge, label, at) VALUES (?, ?, ?, ?)', u.userId, id, label.trim().slice(0, 40) || id, Date.now());
    return this.profileOf(u.userId);
  }

  /** Deletes a person: keys, Claudes, emails, profile. Returns the projects they owned (to delete) and joined (to leave). */
  async deleteUser(userId: string): Promise<{ owned: string[]; joined: string[] }> {
    const owned = this.sql.exec<{ id: string }>('SELECT id FROM projects WHERE owner_id = ?', userId).toArray().map((r) => r.id);
    const joined = this.sql.exec<{ project_id: string }>('SELECT project_id FROM user_projects WHERE user_id = ?', userId).toArray().map((r) => r.project_id).filter((id) => !owned.includes(id));
    for (const id of owned) {
      this.sql.exec('DELETE FROM user_projects WHERE project_id = ?', id);
      this.sql.exec('DELETE FROM invites WHERE project_id = ?', id);
      this.sql.exec('DELETE FROM email_invites WHERE project_id = ?', id);
      this.sql.exec('DELETE FROM projects WHERE id = ?', id);
    }
    for (const t of ['user_projects', 'agents', 'sessions', 'emails', 'login_links', 'badges']) this.sql.exec(`DELETE FROM ${t} WHERE user_id = ?`, userId);
    this.sql.exec('DELETE FROM users WHERE id = ?', userId);
    return { owned, joined };
  }
}
