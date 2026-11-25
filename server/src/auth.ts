import type { DirectoryDO, Identity } from './directory.ts';
import type { ProjectDO } from './project.ts';
import { BatonError, isRole, type Role } from './shared.ts';

/**
 * Easy sign-in: Google (ID token, so no client secret is needed), invite links with a number of
 * uses, "sign in on another device" links, and adding people by email.
 */
export interface AuthDeps {
  dir: DurableObjectStub<DirectoryDO>;
  project: (id: string) => DurableObjectStub<ProjectDO>;
  identify: (req: Request) => Promise<Identity>;
  body: <T>(req: Request) => Promise<T>;
  googleClientId?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function htmlPage(title: string, message: string, extra = ''): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Baton</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#ececec;font:15px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:28px;border:1px solid #2b2b2b;border-radius:12px;background:#181818}h1{font-size:18px;margin:0 0 8px}p{color:#a1a1a1;margin:0}a{color:#ececec}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// ---------------------------------------------------------------- Google ID token check
let certs: { keys: (JsonWebKey & { kid: string })[]; at: number } | null = null;

async function googleKeys() {
  if (certs && Date.now() - certs.at < 3_600_000) return certs.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new BatonError('Could not reach Google to check the sign-in.', 502);
  certs = { keys: ((await r.json()) as { keys: (JsonWebKey & { kid: string })[] }).keys, at: Date.now() };
  return certs.keys;
}

function b64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyGoogleIdToken(token: string, clientId: string, nonce: string) {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new BatonError('Google sent a broken sign-in.', 400);
  const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid: string; alg: string };
  if (header.alg !== 'RS256') throw new BatonError('Unexpected Google sign-in format.', 400);
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new BatonError('Google sign-in key not found; try again.', 400);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new BatonError('The Google sign-in did not check out.', 401);
  const c = JSON.parse(new TextDecoder().decode(b64url(p))) as {
    iss: string; aud: string; exp: number; nonce?: string; email?: string; email_verified?: boolean; name?: string;
  };
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new BatonError('Not a Google sign-in.', 401);
  if (c.aud !== clientId) throw new BatonError('This sign-in was meant for another app.', 401);
  if (c.exp * 1000 < Date.now()) throw new BatonError('The Google sign-in expired; try again.', 401);
  if (c.nonce !== nonce) throw new BatonError('The sign-in request did not match; try again.', 401);
  if (!c.email || !c.email_verified) throw new BatonError('Your Google email is not verified.', 401);
  return { email: c.email.toLowerCase(), name: c.name ?? c.email.split('@')[0] ?? 'member' };
}

/** Puts a person into every project their email was invited to. */
async function applyEmailInvites(d: AuthDeps, user: { userId: string; name: string }, email: string) {
  for (const inv of await d.dir.takeEmailInvites(email)) {
    if (!isRole(inv.role)) continue;
    await d.project(inv.projectId).joinMember(user, inv.role);
    await d.dir.setMembership(user.userId, inv.projectId, true);
  }
}

/** Public and sign-in routes. Returns null when the path isn't one of them. */
export async function authRoutes(req: Request, url: URL, path: string, d: AuthDeps): Promise<Response | null> {
  const method = req.method;
  const origin = url.origin;

  if (path === '/privacy' && method === 'GET') {
    return htmlPage(
      'Baton privacy',
      'Baton keeps what you put in it: your name, your email if you sign in with Google, and the notes, to-dos, messages and Claude updates you share with your projects. It is only shown to people in those projects. Nothing is sold or shared with anyone else, and there are no ads or trackers. Google sign-in only gives Baton your name and email. To delete your data or ask anything, open an issue at github.com/ce017/baton.',
    );
  }
  if (path === '/api/config' && method === 'GET') {
    return json({ google: !!d.googleClientId, web: origin });
  }

  // ---- Google sign-in: the app starts a request, the browser signs in, the app polls.
  if (path === '/api/auth/start' && method === 'POST') {
    if (!d.googleClientId) throw new BatonError('Google sign-in is not set up on this server yet.', 503);
    const r = await d.dir.startLogin();
    const web = url.searchParams.get('web') === '1' ? '&web=1' : '';
    return json({ id: r.id, secret: r.secret, url: `${origin}/auth/google?req=${r.id}${web}` });
  }
  if (path === '/api/auth/poll' && method === 'GET') {
    const r = await d.dir.pollLogin(url.searchParams.get('id') ?? '', url.searchParams.get('secret') ?? '');
    return json(r ?? { pending: true });
  }
  if (path === '/auth/google' && method === 'GET') {
    if (!d.googleClientId) return htmlPage('Not set up', 'Google sign-in is not set up on this server yet.');
    const id = url.searchParams.get('req') ?? '';
    const nonce = await d.dir.loginNonce(id);
    if (!nonce) return htmlPage('Sign-in expired', 'Go back to Baton and press "Continue with Google" again.');
    const q = new URLSearchParams({
      client_id: d.googleClientId,
      redirect_uri: `${origin}/auth/google/callback`,
      response_type: 'id_token',
      response_mode: 'form_post',
      scope: 'openid email profile',
      prompt: 'select_account',
      nonce,
      state: url.searchParams.get('web') === '1' ? `${id}.w` : id,
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
  }
  if (path === '/auth/google/callback' && method === 'POST') {
    const form = await req.formData();
    const state = String(form.get('state') ?? '');
    const [id = '', web] = state.split('.');
    const nonce = await d.dir.loginNonce(id);
    if (!nonce || !d.googleClientId) return htmlPage('Sign-in expired', 'Go back to Baton and try again.');
    try {
      const g = await verifyGoogleIdToken(String(form.get('id_token') ?? ''), d.googleClientId, nonce);
      let user = await d.dir.userByEmail(g.email);
      if (!user) {
        const made = await d.dir.createUserAuto(g.name || g.email.split('@')[0] || 'member');
        user = { userId: made.userId, name: made.name };
        await d.dir.addEmail(user.userId, g.email);
      }
      await applyEmailInvites(d, user, g.email);
      await d.dir.finishLogin(id, user.userId);
      if (web === 'w') return Response.redirect(`${origin}/?signin=${id}`, 303);
      return htmlPage(`Signed in as ${user.name}`, 'You can close this tab and go back to the Baton app.');
    } catch (e) {
      return htmlPage("Couldn't sign in", e instanceof Error ? e.message.replace(/^E\d+:/, '') : 'Try again.');
    }
  }

  // ---- Invite links: anyone with the link joins with its role, until its uses run out.
  const inv = /^\/api\/invites\/([A-Za-z0-9]{10,64})(\/join)?$/.exec(path);
  if (inv?.[1]) {
    const token = inv[1];
    if (!inv[2] && method === 'GET') {
      const p = await d.dir.peekInvite(token);
      if (!p) return json({ error: 'This invite link is not valid.' }, 404);
      return json({ project: { slug: p.slug, name: p.projectName }, role: p.role, usesLeft: p.usesLeft, expiresAt: p.expiresAt, invitedBy: p.invitedBy, ok: p.ok });
    }
    if (inv[2] && method === 'POST') {
      const signedIn = req.headers.get('authorization') ? await d.identify(req) : null;
      if (signedIn?.agentId) throw new BatonError('Join with your own sign-in, not a Claude key.', 403);
      const b = await d.body<{ name?: string }>(req).catch(() => ({}) as { name?: string });
      const seat = await d.dir.useInvite(token);
      let user: { userId: string; name: string };
      let key: string | undefined;
      if (signedIn) user = { userId: signedIn.userId, name: signedIn.userName };
      else {
        const made = await d.dir.createUserAuto(String(b.name ?? '').trim() || 'member');
        user = { userId: made.userId, name: made.name };
        key = made.key;
      }
      const role = await d.project(seat.projectId).joinMember(user, seat.role as Role);
      await d.dir.setMembership(user.userId, seat.projectId, true);
      return json({ ok: true, user: user.name, key, project: seat.slug, role });
    }
  }

  // ---- "Sign in on another device"
  const ll = /^\/api\/login-links\/([A-Za-z0-9]{10,64})$/.exec(path);
  if (ll?.[1] && method === 'POST') {
    const s = await d.dir.useLoginLink(ll[1]);
    return json({ key: s.key, user: s.name });
  }
  if (path === '/api/login-links' && method === 'POST') {
    const who = await d.identify(req);
    if (who.agentId) throw new BatonError('Use your own sign-in to make a sign-in link.', 403);
    const token = await d.dir.createLoginLink(who.userId);
    return json({ url: `${origin}/signin/${token}`, expiresInMinutes: 15 });
  }
  return null;
}

/** Project routes for invites and email adds (the caller already resolved the project). */
export async function projectInviteRoutes(
  req: Request,
  url: URL,
  what: string,
  who: Identity,
  project: { id: string; slug: string },
  d: AuthDeps,
): Promise<Response | null> {
  const method = req.method;
  if (!['invites', 'invite-revoke', 'email-invites'].includes(what)) return null;
  if (who.agentId) throw new BatonError('Only people manage invites, not their Claudes.', 403);
  const mine = await d.project(project.id).roleOf(who.userId);
  if (mine !== 'owner' && mine !== 'admin') throw new BatonError('Only owners and admins can invite people.', 403);

  if (what === 'invites' && method === 'GET') {
    return json({ links: await d.dir.listInvites(project.id), emails: await d.dir.pendingEmailInvites(project.id) });
  }
  if (what === 'invites' && method === 'POST') {
    const b = await d.body<{ role?: string; uses?: number; days?: number }>(req);
    const role = b.role ?? 'member';
    if (!isRole(role) || role === 'owner') throw new BatonError('role is admin, member or viewer.');
    if (role === 'admin' && mine !== 'owner') throw new BatonError('Only the owner can invite administrators.', 403);
    const r = await d.dir.createInvite(project.id, role, Number(b.uses ?? 5), Number(b.days ?? 7), who.userName);
    return json({ ...r, url: `${url.origin}/join/${r.token}` });
  }
  if (what === 'invite-revoke' && method === 'POST') {
    const b = await d.body<{ id?: string; email?: string }>(req);
    if (b.email) await d.dir.cancelEmailInvite(project.id, b.email);
    else await d.dir.revokeInvite(project.id, String(b.id ?? ''));
    return json({ ok: true });
  }
  if (what === 'email-invites' && method === 'POST') {
    const b = await d.body<{ email?: string; role?: string }>(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BatonError('That email doesn\'t look right.');
    const role = b.role ?? 'member';
    if (!isRole(role) || role === 'owner') throw new BatonError('role is admin, member or viewer.');
    if (role === 'admin' && mine !== 'owner') throw new BatonError('Only the owner can add administrators.', 403);
    const known = await d.dir.userByEmail(email);
    if (known) {
      await d.project(project.id).joinMember(known, role);
      await d.dir.setMembership(known.userId, project.id, true);
      return json({ ok: true, added: known.name, message: `Added ${known.name} (${email}) as ${role}.` });
    }
    await d.dir.inviteEmail(email, project.id, role, who.userName);
    return json({ ok: true, pending: true, message: `${email} joins as ${role} the first time they sign in with Google.` });
  }
  return null;
}
