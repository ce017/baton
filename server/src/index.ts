import { createMcpHandler } from '@modelcontextprotocol/server';
import type { DirectoryDO, Identity } from './directory.ts';
import type { ProjectDO, TaskArgs, WriteArgs } from './project.ts';
import { type Actor, BatonError, isRole, readError, sha256 } from './shared.ts';
import { buildMcpServer } from './tools.ts';
import { type AuthDeps, authRoutes, projectInviteRoutes } from './auth.ts';

export { DirectoryDO } from './directory.ts';
export { ProjectDO } from './project.ts';

interface Env {
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  /** Bootstrap secret for creating people (`wrangler secret put ADMIN_TOKEN`). */
  ADMIN_TOKEN?: string;
  /** Google OAuth client id (public) for "Continue with Google". */
  GOOGLE_CLIENT_ID?: string;
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
  const job = await obj.jobFor(actor, session, { cwd: dec('x-baton-cwd'), title: dec('x-baton-title'), name: dec('x-baton-name') });
  return job ? { ...actor, job } : actor;
}

/** Picks the project for a call: explicit slug, the agent's default, or the person's only one. */
async function resolveProject(env: Env, who: Identity, slug?: string | null, session?: string) {
  const dir = directory(env);
  // A chat that has a job in a project works there, whatever its folder or the default says.
  const bound = session ? await dir.chatProject(who.userId, session) : null;
  if (bound) {
    const p = await dir.findProject(bound);
    if (p) return { ref: p, obj: projectObj(env, p.id) };
  }
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

  const deps: AuthDeps = {
    dir: directory(env),
    project: (id) => projectObj(env, id),
    identify: (r) => identify(r, env),
    body,
    googleClientId: env.GOOGLE_CLIENT_ID,
  };
  // Google posts the sign-in back from its own site, so this one skips the origin check.
  if (path === '/auth/google/callback' || path === '/auth/google') {
    const r = await authRoutes(req, url, path, deps);
    if (r) return r;
  }

  // MCP clients send no Origin; browsers do. Only the desktop app (and local dev) may call from a page.
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin && !appOrigin(origin)) {
    return json({ error: 'Cross-origin requests are not allowed.' }, 403);
  }
  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  const auth = await authRoutes(req, url, path, deps);
  if (auth) return auth;

  if (path === '/') return text('Baton server. Connect a Claude at /mcp with an agent key.');
  if (path === '/health') return json({ ok: true });

  // Profile pictures are public by name, so <img> tags can load them without a key.
  const avm = /^\/api\/avatars\/([a-z0-9_-]{2,32})$/.exec(path);
  if (avm?.[1] && method === 'GET') {
    const av = await directory(env).avatarOf(avm[1]);
    if (!av) return new Response('No picture', { status: 404, headers: { 'access-control-allow-origin': '*' } });
    const bytes = Uint8Array.from(atob(av.b64), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'content-type': av.mime, 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' } });
  }

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

  if (path === '/api/admin/badges' && method === 'POST') {
    if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) throw new BatonError('Wrong admin token.', 401);
    const b = await body<{ user: string; badge: string; label?: string; remove?: boolean }>(req);
    return json(await dir.grantBadge(b.user ?? '', b.badge ?? '', b.label ?? '', !!b.remove));
  }

  const who = await identify(req, env);
  const actor = toActor(who);

  if (path === '/api/me/profile' && method === 'GET') return json(await dir.profileOf(who.userId));
  if (path === '/api/me/profile' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own sign-in to edit your profile.', 403);
    return json(await dir.setProfile(who.userId, await body(req)));
  }
  if (path === '/api/me/avatar' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own sign-in to change your picture.', 403);
    const b = await body<{ data?: string }>(req);
    return json(await dir.setAvatar(who.userId, String(b.data ?? '')));
  }
  if (path === '/api/me/delete' && method === 'POST') {
    if (who.agentId) throw new BatonError('Use your own sign-in to delete your account.', 403);
    const b = await body<{ confirm?: string }>(req);
    if ((b.confirm ?? '').trim().toLowerCase() !== who.userName) throw new BatonError('Type your name to confirm.');
    const r = await dir.deleteUser(who.userId);
    for (const id of r.owned) await projectObj(env, id).wipe();
    for (const id of r.joined) await projectObj(env, id).dropMember(who.userId);
    return json({ ok: true, deletedProjects: r.owned.length });
  }

  if (path === '/api/me/chat-projects' && method === 'GET') return json(await dir.chatProjectsOf(who.userId));

  if (path === '/api/me' && method === 'GET') {
    return json({
      user: who.userName,
      agent: who.agentName ?? null,
      defaultProject: who.defaultProject ?? null,
      projects: await dir.projectsOf(who.userId),
      emails: who.agentId ? undefined : await dir.emailsOf(who.userId),
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
    const { obj } = await resolveProject(env, who, url.searchParams.get('project'), sessionOf(req));
    return text(await obj.brief(await withJob(req, obj, actor)));
  }

  if (path === '/api/hook/inbox' && method === 'GET') {
    const { obj } = await resolveProject(env, who, url.searchParams.get('project'), sessionOf(req));
    return text(await obj.hookInbox(await withJob(req, obj, actor), url.searchParams.get('urgent') === '1'));
  }

  // A chat picks its job ("baton job Scripting" typed in Claude Code); the hook calls this.
  if (path === '/api/chat-job' && method === 'POST') {
    const b = await body<{ project?: string; session?: string; job?: string | null }>(req);
    const session = typeof b.session === 'string' && /^[\w-]{6,80}$/.test(b.session) ? b.session : sessionOf(req);
    if (!session) throw new BatonError('Missing the chat session id.');
    const { obj, ref } = await resolveProject(env, who, b.project, session);
    const r = await obj.setChatJob(actor, session, b.job ? String(b.job) : null);
    await dir.setChatProject(who.userId, session, r.job ? ref.slug : null);
    return json(r);
  }

  if (path === '/api/events' && method === 'POST') {
    const b = await body<{ project?: string; kind: 'edit' | 'reply' | 'session'; text: string }>(req);
    if (!['edit', 'reply', 'session'].includes(b.kind)) throw new BatonError('kind is edit, reply or session.');
    const { obj } = await resolveProject(env, who, b.project, sessionOf(req));
    return text(await obj.event(await withJob(req, obj, actor), { kind: b.kind, text: String(b.text ?? '') }));
  }

  const pm = /^\/api\/projects\/([a-z0-9_-]+)\/(members|feed|skills|import|overview|tree|page|tasks|messages|conversations|chat|post|comment|status|ticket|jobs|chatjob|notices|wake|wakes|wake-opt|wake-claim|wake-finish|invites|invite-revoke|email-invites|profiles|dispatch-claim|dispatch-finish|delete|background|tag-color)$/.exec(path);
  if (pm?.[1] && pm[2]) {
    const { obj, ref } = await resolveProject(env, who, pm[1]);
    const what = pm[2];
    const inv = await projectInviteRoutes(req, url, what, who, ref, deps);
    if (inv) return inv;
    if (what === 'members' && method === 'GET') return json(await obj.members(actor));
    if (what === 'profiles' && method === 'GET') return json(await dir.profilesByNames((await obj.members(actor)).map((m) => m.name)));
    if (what === 'wakes' && method === 'GET') return json(await obj.wakes(actor));
    if (what === 'wake' && method === 'POST') return json(await obj.wake(actor, await body<{ to: string; text: string; task?: string }>(req)));
    if (what === 'wake-opt' && method === 'POST') return json(await obj.setWakeOpt(actor, !!(await body<{ enabled: boolean }>(req)).enabled));
    if (what === 'wake-claim' && method === 'POST') return json(await obj.claimWake(actor, String((await body<{ id: string }>(req)).id ?? '')));
    if (what === 'wake-finish' && method === 'POST') {
      const b = await body<{ id: string; status: 'done' | 'failed' | 'refused'; result: string }>(req);
      return json(await obj.finishWake(actor, String(b.id ?? ''), b));
    }
    if (what === 'notices' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? -1);
      return json(await obj.notices(actor, Number.isFinite(after) ? after : -1));
    }
    if (what === 'jobs' && method === 'GET') return json(await obj.jobs(actor));
    if (what === 'tag-color' && method === 'POST') return json(await obj.setTagColor(actor, await body<{ tag?: string; color?: number }>(req)));
    if (what === 'background' && method === 'GET') return json(await obj.background(actor));
    if (what === 'background' && method === 'POST') return json(await obj.setBackground(actor, await body<{ preset?: string; data?: string }>(req)));
    if (what === 'dispatch-claim' && method === 'POST') return json(await obj.claimDispatch(actor, String((await body<{ id: string }>(req)).id ?? '')));
    if (what === 'dispatch-finish' && method === 'POST') {
      const b = await body<{ id: string; status?: string; result?: string }>(req);
      return json(await obj.finishDispatch(actor, String(b.id ?? ''), b));
    }
    if (what === 'delete' && method === 'POST') {
      await obj.assertOwner(actor);
      const b = await body<{ confirm?: string }>(req);
      if ((b.confirm ?? '').trim().toLowerCase() !== ref.slug.toLowerCase()) throw new BatonError(`Type ${ref.slug} to confirm.`);
      await dir.deleteProject(ref.id);
      await obj.wipe();
      return json({ ok: true });
    }
    if (what === 'jobs' && method === 'POST') {
      const b = await body<{ id?: string; name?: string; instructions?: string; labels?: string[]; kind?: string; auto?: boolean; delete?: string }>(req);
      return json(b.delete ? await obj.deleteJob(actor, String(b.delete)) : await obj.saveJob(actor, b));
    }
    if (what === 'chatjob' && method === 'POST') {
      const b = await body<{ session: string; job: string | null; title?: string; cwd?: string }>(req);
      if (typeof b.session !== 'string' || !/^[\w-]{6,80}$/.test(b.session)) throw new BatonError('Missing the chat session id.');
      const r = await obj.setChatJob(actor, b.session, b.job ? String(b.job) : null, { title: String(b.title ?? ''), cwd: String(b.cwd ?? '') });
      // Giving a chat a job here ties it to this project; clearing the job unties it (if it was tied here).
      if (r.job) await dir.setChatProject(who.userId, b.session, ref.slug);
      else if ((await dir.chatProject(who.userId, b.session)) === ref.slug) await dir.setChatProject(who.userId, b.session, null);
      return json(r);
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
