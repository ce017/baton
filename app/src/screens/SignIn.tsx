import { ArrowRight } from 'lucide-react';
import { motion, useAnimate } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { ApiError, call, type Me } from '../lib/api.ts';
import { EASE_MOVE, EASE_OUT } from '../ui.tsx';

type Mode = 'key' | 'create';

export function SignIn() {
  const { cfg, update } = useApp();
  const [mode, setMode] = useState<Mode>('key');
  const [server, setServer] = useState(cfg.server ?? 'http://localhost:8787');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, animate] = useAnimate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const base = server.trim().replace(/\/+$/, '');
    try {
      if (mode === 'key') {
        const me = await call<Me>({ server: base, userKey: key.trim() }, 'GET', '/api/me');
        await update({ server: base, userKey: key.trim(), user: me.user });
      } else {
        const r = await call<{ name: string; key: string }>({ server: base }, 'POST', '/api/admin/users', { name }, { admin: adminToken.trim() });
        await update({ server: base, userKey: r.key, user: r.name });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      animate(scope.current, { x: [0, -6, 6, -4, 4, 0] }, { duration: 0.3 }); // a short shake says "no" without a modal
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <motion.form
        className="card signin-card"
        onSubmit={submit}
        ref={scope}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: EASE_OUT }}
      >
        <div className="brand" style={{ padding: '0 0 18px' }}>
          <span className="brand-mark">bt</span>
          <span style={{ fontSize: 16 }}>Baton</span>
        </div>
        <p className="muted" style={{ margin: '0 0 18px' }}>
          One shared workspace for your team and your Claudes, so work carries on when someone stops.
        </p>
        <div className="tabs" role="tablist">
          {(['key', 'create'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className="tab" onClick={() => setMode(m)}>
              {mode === m && <motion.span layoutId="signin-tab" className="tab-bg" transition={{ duration: 0.2, ease: EASE_MOVE }} />}
              <span>{m === 'key' ? 'I have a key' : 'New person'}</span>
            </button>
          ))}
        </div>
        <div className="field">
          <label className="label" htmlFor="server">Server</label>
          <input id="server" className="input mono" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://baton.you.workers.dev" />
        </div>
        {mode === 'key' ? (
          <div className="field">
            <label className="label" htmlFor="key">Your key</label>
            <input id="key" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="bt_u_…" autoFocus />
            <div className="hint">The server admin gives you this once. It stays on this PC.</div>
          </div>
        ) : (
          <>
            <div className="field">
              <label className="label" htmlFor="name">Name</label>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ceo" autoFocus />
            </div>
            <div className="field">
              <label className="label" htmlFor="admin">Server admin token</label>
              <input id="admin" className="input mono" type="password" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
              <div className="hint">Only whoever runs the server has this. It isn't saved.</div>
            </div>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn primary" style={{ width: '100%', height: 34 }} disabled={busy}>
          {mode === 'key' ? 'Sign in' : 'Create and sign in'} <ArrowRight size={15} />
        </button>
      </motion.form>
    </div>
  );
}
