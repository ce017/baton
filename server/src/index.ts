import { createMcpHandler } from '@modelcontextprotocol/server';
import type { DirectoryDO, Identity } from './directory.ts';
import type { ProjectDO, TaskArgs, WriteArgs } from './project.ts';
import { type Actor, BatonError, isRole, readError, sha256 } from './shared.ts';
import { buildMcpServer } from './tools.ts';

export { DirectoryDO } from './directory.ts';
export { ProjectDO } from './project.ts';

interface Env {
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  /** Bootstrap secret for creating people (`wrangler secret put ADMIN_TOKEN`). */
  ADMIN_TOKEN?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}

function projectObj(env: Env, projectId: string) {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId));
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1];
}

async function identify(req: Request, env: Env): Promise<Identity> {
  const key = bearer(req);
  if (!key) throw new BatonError('Missing "Authorization: Bearer <key>".', 401);
  const who = await directory(env).identify(await sha256(key));
  if (!who) throw new BatonError('Unknown or revoked key.', 401);
  return who;
}

function toActor(who: Identity): Actor {
  return { userId: who.userId, userName: who.userName, agentId: who.agentId, agentName: who.agentName };
}

/** Hooks send the Claude Code session id, so each chat can carry its own job. */
function sessionOf(req: Request): string | undefined {
  const v = req.headers.get('x-baton-session')?.trim();
  return v && /^[\w-]{6,80}$/.test(v) ? v : undefined;
}

async function withJob(req: Request, obj: DurableObjectStub<ProjectDO>, actor: Actor): Promise<Actor> {
  const session = sessionOf(req);
  if (!session || !actor.agentId) return actor;
  const dec = (h: string) => {
    try {
      return decodeURIComponent(req.headers.get(h) ?? '');
    } catch {
      return '';
    }
  };
  const job = await obj.jobFor(actor, session, { cwd: dec('x-baton-cwd'), title: dec('x-baton-title') });
  return job ? { ...actor, job } : actor;
}

/** Picks the project for a call: explicit slug, the agent's default, or the person's only one. */
async function resolveProject(env: Env, who: Identity, slug?: string | null) {
  const dir = directory(env);
  const wanted = slug?.trim() || who.defaultProject;
  if (wanted) {
    const p = await dir.findProject(wanted);
    if (!p) throw new BatonError(`No project "${wanted}".`, 404);
    return { ref: p, obj: projectObj(env, p.id) };
  }
  const mine = await dir.projectsOf(who.userId);
  if (mine.length === 1 && mine[0]) return { ref: mine[0], obj: projectObj(env, mine[0].id) };
  if (!mine.length) throw new BatonError(`${who.userName} is not in any project yet.`, 404);
  throw new BatonError(
    `Say which project: ${mine.map((p) => p.slug).join(', ')} (or set a default with \`baton use <slug>\`).`,
  );
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new BatonError('The request body must be JSON.');
  }
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  // MCP clients send no Origin; browsers do. Only the desktop app (and local dev) may call from a page.
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin && !appOrigin(origin)) {
    return json({ error: 'Cross-origin requests are not allowed.' }, 403);
  }
  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  if (path === '/') return text('Baton server. Connect a Claude at /mcp with an agent key.');
  if (path === '/health') return json({ ok: true });

  if (path === '/mcp') {
    const who = await identify(req, env);
    const actor = toActor(who);
    const handler = createMcpHandler(
      () =>
        buildMcpServer({
          actor,
          open: async (slug) => (await resolveProject(env, who, slug)).obj,
        }),
      { responseMode: 'json' },
    );
    return handler.fetch(req);
  }

  const dir = directory(env);

  // Live updates: the WebSocket carries a one-use ticket instead of a key.
  const live = /^\/api\/projects\/([a-z0-9_-]+)\/live$/.exec(path);
  if (live?.[1]) {
    const p = await dir.findProject(live[1]);
    if (!p) throw new BatonError('No such project.', 404);
    return projectObj(env, p.id).fetch(req);
  }

  if (path === '/api/admin/users' && method === 'POST') {
    if (!env.ADMIN_TOKEN) throw new BatonError('This server has no ADMIN_TOKEN set.', 503);
    if (bearer(req) !== env.ADMIN_TOKEN) throw new BatonError('Wrong admin token.', 401);
    const b = await body<{ name: string }>(req);
    return json(await dir.createUser(b.name ?? ''));
  }

  const who = await identify(req, env);
  const actor = toActor(who);

  if (path === '/api/me' && method === 'GET') {
    return json({
      user: who.userName,
      agent: who.agentName ?? null,
      defaultProject: who.defaultProject ?? null,
      projects: await dir.projectsOf(who.userId),
      agents: who.agentId ? undefined : await dir.agentsOf(who.userId),
    });
  }

  if (path === '/api/agents' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own (user) key to create agents.', 403);
    const b = await body<{ name?: string }>(req);
    return json(await dir.createAgent(who.userId, b.name ?? 'Claude'));
  }

  if (path === '/api/agents/rotate' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own (user) key to rotate agent keys.', 403);
    const b = await body<{ name: string }>(req);
    return json(await dir.rotateAgentKey(who.userId, b.name ?? ''));
  }

  if (path === '/api/agents/default' && method === 'POST') {
    if (!who.agentId) throw new BatonError('Use the agent key whose default you want to set.', 403);
    const b = await body<{ project: string }>(req);
    const p = await dir.findProject(b.project ?? '');
    if (!p) throw new BatonError(`No project "${b.project}".`, 404);
    if (!(await projectObj(env, p.id).roleOf(who.userId))) throw new BatonError('You are not in that project.', 403);
    await dir.setDefaultProject(who.agentId, p.slug);
    return json({ ok: true, defaultProject: p.slug });
  }

  if (path === '/api/projects' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own (user) key to create projects.', 403);
    const b = await body<{ slug: string; name?: string }>(req);
    const ref = await dir.createProject(who.userId, b.slug ?? '', b.name ?? b.slug ?? '');
    await projectObj(env, ref.id).init(ref, { userId: who.userId, name: who.userName });
    return json(ref);
  }

  if (path === '/api/brief' && method === 'GET') {
    const { obj } = await resolveProject(env, who, url.searchParams.get('project'));
    return text(await obj.brief(await withJob(req, obj, actor)));
  }

  if (path === '/api/hook/inbox' && method === 'GET') {
    const { obj } = await resolveProject(env, who, url.searchParams.get('project'));
    return text(await obj.hookInbox(await withJob(req, obj, actor)));
  }

  // A chat picks its job ("baton job Scripting" typed in Claude Code); the hook calls this.
  if (path === '/api/chat-job' && method === 'POST') {
    const b = await body<{ project?: string; session?: string; job?: string | null }>(req);
    const session = typeof b.session === 'string' && /^[\w-]{6,80}$/.test(b.session) ? b.session : sessionOf(req);
    if (!session) throw new BatonError('Missing the chat session id.');
    const { obj } = await resolveProject(env, who, b.project);
    return json(await obj.setChatJob(actor, session, b.job ? String(b.job) : null));
  }

  if (path === '/api/events' && method === 'POST') {
    const b = await body<{ project?: string; kind: 'edit' | 'reply' | 'session'; text: string }>(req);
    if (!['edit', 'reply', 'session'].includes(b.kind)) throw new BatonError('kind is edit, reply or session.');
    const { obj } = await resolveProject(env, who, b.project);
    return text(await obj.event(await withJob(req, obj, actor), { kind: b.kind, text: String(b.text ?? '') }));
  }

  const pm = /^\/api\/projects\/([a-z0-9_-]+)\/(members|feed|skills|import|overview|tree|page|tasks|messages|conversations|chat|post|comment|status|ticket|jobs|chatjob|notices)$/.exec(path);
  if (pm?.[1] && pm[2]) {
    const { obj, ref } = await resolveProject(env, who, pm[1]);
    const what = pm[2];
    if (what === 'members' && method === 'GET') return json(await obj.members(actor));
    if (what === 'notices' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? -1);
      return json(await obj.notices(actor, Number.isFinite(after) ? after : -1));
    }
    if (what === 'jobs' && method === 'GET') return json(await obj.jobs(actor));
    if (what === 'jobs' && method === 'POST') {
      const b = await body<{ id?: string; name?: string; instructions?: string; labels?: string[]; delete?: string }>(req);
      return json(b.delete ? await obj.deleteJob(actor, String(b.delete)) : await obj.saveJob(actor, b));
    }
    if (what === 'chatjob' && method === 'POST') {
      const b = await body<{ session: string; job: string | null }>(req);
      if (typeof b.session !== 'string' || !/^[\w-]{6,80}$/.test(b.session)) throw new BatonError('Missing the chat session id.');
      return json(await obj.setChatJob(actor, b.session, b.job ? String(b.job) : null));
    }
    if (what === 'members' && method === 'POST') {
      if (who.agentId) throw new BatonError('Only people manage members, not their Claudes.', 403);
      const b = await body<{ user: string; role: string }>(req);
      const target = await dir.findUser(b.user ?? '');
      if (!target) throw new BatonError(`No person called "${b.user}" on this server.`, 404);
      const role = b.role === 'none' ? 'none' : isRole(b.role) ? b.role : null;
      if (!role) throw new BatonError('role is admin, member, viewer or none.');
      const msg = await obj.setMember(actor, target, role);
      await dir.setMembership(target.userId, ref.id, role !== 'none');
      return json({ ok: true, message: msg });
    }
    if (what === 'overview' && method === 'GET') return json(await obj.overview(actor));
    if (what === 'tree' && method === 'GET') return json(await obj.tree(actor));
    if (what === 'page' && method === 'GET') {
      const page = await obj.page(actor, url.searchParams.get('path') ?? '');
      return page ? json(page) : json({ error: 'No such page.' }, 404);
    }
    if (what === 'page' && method === 'PUT') return json({ message: await obj.write(actor, await body<WriteArgs>(req)) });
    if (what === 'tasks' && method === 'GET') return json(await obj.taskRows(actor));
    if (what === 'tasks' && method === 'POST') return json({ message: await obj.task(actor, await body<TaskArgs>(req)) });
    if (what === 'messages' && method === 'GET') return json(await obj.messageRows(actor));
    if (what === 'conversations' && method === 'GET') return json(await obj.conversations(actor));
    if (what === 'chat' && method === 'GET') return json(await obj.chat(actor, url.searchParams.get('with') ?? 'everyone'));
    if (what === 'post' && method === 'POST') return json({ message: await obj.post(actor, await body<{ to: string; kind: string; text: string; ref?: string }>(req)) });
    if (what === 'comment' && method === 'POST') {
      const b = await body<{ target: string; text: string }>(req);
      return json({ message: await obj.board(actor, { action: 'comment', target: b.target, text: b.text }) });
    }
    if (what === 'status' && method === 'POST') return json({ message: await obj.status(actor, await body<{ doing: string; where?: string; next?: string }>(req)) });
    if (what === 'ticket' && method === 'POST') return json({ ticket: await obj.issueTicket(actor) });
    if (what === 'feed' && method === 'GET') return json(await obj.feed(actor, Number(url.searchParams.get('limit') ?? 50)));
    if (what === 'skills' && method === 'GET') return json(await obj.skillBundle(actor));
    if (what === 'skills' && method === 'POST') {
      const b = await body<{ name: string; body: string; summary: string; files?: Record<string, string> }>(req);
      return json({ message: await obj.skill(actor, { action: 'put', ...b }) });
    }
    if (what === 'import' && method === 'POST') {
      const b = await body<{ pages: WriteArgs[] }>(req);
      const results: { path: string; ok: boolean; message: string }[] = [];
      for (const p of (b.pages ?? []).slice(0, 200)) {
        try {
          results.push({ path: p.path, ok: true, message: await obj.write(actor, p) });
        } catch (e) {
          results.push({ path: p.path, ok: false, message: readError(e).message });
        }
      }
      return json({ results });
    }
  }

  throw new BatonError(`No route ${method} ${path}.`, 404);
}

/** The desktop app's webview (Tauri on Windows/macOS/Linux) and local dev servers. */
function appOrigin(origin: string): boolean {
  return /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin);
}

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin');
  if (!origin || !appOrigin(origin) || res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set('access-control-allow-origin', origin);
  out.headers.set('access-control-allow-headers', 'authorization, content-type');
  out.headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  out.headers.set('access-control-max-age', '86400');
  out.headers.set('vary', 'origin');
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withCors(req, await route(req, env));
    } catch (e) {
      const { status, message } = readError(e);
      if (status >= 500) console.error(e);
      return withCors(req, json({ error: message }, status));
    }
  },
} satisfies ExportedHandler<Env>;
