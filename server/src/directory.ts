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
}
