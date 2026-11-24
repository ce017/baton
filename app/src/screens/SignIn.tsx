import { ArrowRight, ChevronDown, Link2 } from 'lucide-react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useApp } from '../main.tsx';
import { ApiError, call, DEFAULT_SERVER, isTauri, type Me, publicCall } from '../lib/api.ts';
import { EASE_OUT } from '../ui.tsx';

/** What a pasted or opened link means: an invite to a project, or a sign-in from another device. */
export function parseBatonLink(raw: string): { server: string; kind: 'join' | 'signin'; token: string } | null {
  try {
    const u = new URL(raw.trim());
    const m = /^\/(join|signin)\/([A-Za-z0-9]{10,64})\/?$/.exec(u.pathname);
    return m ? { server: u.origin, kind: m[1] as 'join' | 'signin', token: m[2] ?? '' } : null;
  } catch {
    return null;
  }
}

interface InviteInfo {
  project: { slug: string; name: string };
  role: string;
  usesLeft: number;
  invitedBy: string;
  ok: boolean;
}

const ROLE_WORD: Record<string, string> = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.location.href = url;
}

export function SignIn() {
  const { cfg, update } = useApp();
  const here = !isTauri && !/localhost:5173$/.test(window.location.host) ? window.location.origin : null;
  const [server, setServer] = useState(cfg.server ?? here ?? DEFAULT_SERVER);
  const [link, setLink] = useState(() => (here && /^\/(join|signin)\//.test(window.location.pathname) ? window.location.href : ''));
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [google, setGoogle] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, animate] = useAnimate();
  const stop = useRef(false);
  const parsed = parseBatonLink(link);
  const base = (parsed?.server ?? server).trim().replace(/\/+$/, '');

  function fail(msg: string) {
    setError(msg);
    animate(scope.current, { x: [0, -6, 6, -4, 4, 0] }, { duration: 0.32 });
  }

  // Does this server offer Google sign-in?
  useEffect(() => {
    let gone = false;
    fetch(`${base}/api/config`)
      .then((r) => r.json())
      .then((c: { google?: boolean }) => !gone && setGoogle(!!c.google))
      .catch(() => !gone && setGoogle(false));
    return () => {
      gone = true;
    };
  }, [base]);

  // Show what an invite link is for.
  useEffect(() => {
    setInvite(null);
    if (parsed?.kind !== 'join') return;
    fetch(`${parsed.server}/api/invites/${parsed.token}`)
      .then((r) => r.json())
      .then((i: InviteInfo & { error?: string }) => (i.error ? setError(i.error) : setInvite(i)))
      .catch(() => setError("Couldn't reach that server."));
  }, [parsed?.kind, parsed?.server, parsed?.token]);

  // Coming back from Google in the browser.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('signin');
    const secret = sessionStorage.getItem(`baton.signin.${id}`);
    if (id && secret) poll(base, id, secret);
    return () => {
      stop.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(srv: string, userKey: string) {
    const me = await call<Me>({ server: srv, userKey }, 'GET', '/api/me');
    // An invite still waiting (Google first, then join).
    const pending = sessionStorage.getItem('baton.join');
    let project = cfg.project;
    if (pending) {
      sessionStorage.removeItem('baton.join');
      const j = await call<{ project: string }>({ server: srv, userKey }, 'POST', `/api/invites/${pending}/join`, {}).catch(() => null);
      if (j) project = j.project;
    }
    if (here) window.history.replaceState(null, '', '/');
    await update({ server: srv, userKey, user: me.user, project: project ?? me.projects[0]?.slug });
  }

  async function poll(srv: string, id: string, secret: string) {
    setWaiting(true);
    stop.current = false;
    const until = Date.now() + 10 * 60_000;
    while (!stop.current && Date.now() < until) {
      try {
        const r = await fetch(`${srv}/api/auth/poll?id=${id}&secret=${secret}`).then((x) => x.json() as Promise<{ key?: string; pending?: boolean; error?: string }>);
        if (r.key) {
          sessionStorage.removeItem(`baton.signin.${id}`);
          await finish(srv, r.key);
          return;
        }
        if (r.error) throw new Error(r.error);
      } catch (e) {
        setWaiting(false);
        return fail((e as Error).message);
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    setWaiting(false);
  }

  async function withGoogle() {
    setError('');
    if (parsed?.kind === 'join') sessionStorage.setItem('baton.join', parsed.token);
    try {
      const r = await fetch(`${base}/api/auth/start${isTauri ? '' : '?web=1'}`, { method: 'POST' }).then((x) => x.json() as Promise<{ id: string; secret: string; url: string; error?: string }>);
      if (r.error) return fail(r.error);
      if (isTauri) {
        await openExternal(r.url);
        poll(base, r.id, r.secret);
      } else {
        sessionStorage.setItem(`baton.signin.${r.id}`, r.secret);
        window.location.href = r.url;
      }
    } catch {
      fail("Couldn't reach the Baton server.");
    }
  }

  async function useLink(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!parsed) return fail('Paste the whole link, starting with https://');
    setBusy(true);
    try {
      if (parsed.kind === 'signin') {
        const r = await publicCall<{ key: string }>(parsed.server, 'POST', `/api/login-links/${parsed.token}`, {});
        await finish(parsed.server, r.key);
      } else {
        if (!name.trim()) return fail('Pick a name your team will see.');
        const r = await publicCall<{ key: string; project: string }>(parsed.server, 'POST', `/api/invites/${parsed.token}/join`, { name });
        if (here) window.history.replaceState(null, '', '/');
        const me = await call<Me>({ server: parsed.server, userKey: r.key }, 'GET', '/api/me');
        await update({ server: parsed.server, userKey: r.key, user: me.user, project: r.project });
      }
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "Couldn't reach that server.");
    } finally {
      setBusy(false);
    }
  }

  async function useKey(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await finish(server.trim().replace(/\/+$/, ''), key.trim());
    } catch (err) {
      fail(err instanceof ApiError && err.status === 401 ? 'That key is not valid on this server.' : "Couldn't reach that server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <motion.div
        ref={scope}
        className="card signin-card"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT } }}
      >
        <div className="brand" style={{ padding: '0 0 14px' }}>
          <span className="brand-mark">bt</span>
          <span>Baton</span>
        </div>

        {invite ? (
          <div className="invitecard">
            <div className="faint" style={{ fontSize: 12.5 }}>{invite.invitedBy} invited you to</div>
            <div className="t">{invite.project.name}</div>
            <div className="muted">as {ROLE_WORD[invite.role] ?? invite.role}{invite.ok ? '' : ' · this link has expired or is used up'}</div>
          </div>
        ) : (
          <p className="muted" style={{ margin: '0 0 18px' }}>One shared workspace for your team and your Claudes, so work carries on when someone stops.</p>
        )}

        {waiting ? (
          <div className="waiting">
            <span className="dot live" /> Finish signing in with Google in your browser…
            <button type="button" className="btn ghost sm" onClick={() => { stop.current = true; setWaiting(false); }}>Cancel</button>
          </div>
        ) : (
          <>
            {google && (
              <button type="button" className="btn googlebtn" onClick={withGoogle}>
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                {invite ? `Join ${invite.project.name} with Google` : 'Continue with Google'}
              </button>
            )}
            {google && <div className="orline"><span>or</span></div>}

            <form onSubmit={useLink}>
              <div className="field">
                <label className="label" htmlFor="link"><Link2 size={13} /> Invite or sign-in link</label>
                <input id="link" className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/join/…  or  …/signin/…" autoFocus={!link} />
              </div>
              {parsed?.kind === 'join' && (
                <div className="field">
                  <label className="label" htmlFor="name">Your name</label>
                  <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Boe" autoFocus />
                  <div className="hint">This makes your account. You can add Google later to sign in anywhere.</div>
                </div>
              )}
              <button className="btn primary" style={{ width: '100%', height: 36 }} disabled={busy || !link.trim()}>
                {parsed?.kind === 'join' ? 'Join' : 'Continue'} <ArrowRight size={15} />
              </button>
            </form>

            <button type="button" className="linkbtn" style={{ marginTop: 14 }} onClick={() => setAdvanced((v) => !v)}>
              <ChevronDown size={13} style={{ transform: advanced ? 'rotate(180deg)' : undefined }} /> Use a key instead
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.form
                  onSubmit={useKey}
                  style={{ overflow: 'hidden' }}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } }}
                  exit={{ height: 0, opacity: 0, transition: { duration: 0.14 } }}
                >
                  <div className="field" style={{ marginTop: 12 }}>
                    <label className="label" htmlFor="server">Server</label>
                    <input id="server" className="input mono" value={server} onChange={(e) => setServer(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="key">Key</label>
                    <input id="key" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="bt_u_…" />
                  </div>
                  <button className="btn" style={{ width: '100%' }} disabled={busy || !key.trim()}>Sign in with key</button>
                </motion.form>
              )}
            </AnimatePresence>
          </>
        )}
        {error && <p className="error-text" style={{ marginBottom: 0 }}>{error}</p>}
      </motion.div>
    </div>
  );
}
