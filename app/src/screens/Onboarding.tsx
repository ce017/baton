import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Copy, FolderPlus, Link2 } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { call } from '../lib/api.ts';
import { EASE_OUT, useToast } from '../ui.tsx';
import { parseBatonLink } from './SignIn.tsx';

const enter = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT } } };

/** First thing after signing in when you're in no project yet: make one or join one. */
export function Welcome({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  const { cfg } = useApp();
  return (
    <div className="onb">
      <motion.div className="onb-inner" {...enter}>
        <h1>Welcome to Baton{cfg.user ? `, ${cfg.user}` : ''}</h1>
        <p className="muted">A project is where your team and your Claudes share to-dos, notes and messages, so work carries on when someone stops.</p>
        <div className="onb-cards">
          <button type="button" className="onb-card" onClick={onCreate}>
            <FolderPlus size={20} />
            <b>Create a project</b>
            <span>Start fresh and invite your team with a link.</span>
            <ArrowRight size={15} className="go" />
          </button>
          <button type="button" className="onb-card" onClick={onJoin}>
            <Link2 size={20} />
            <b>Join a project</b>
            <span>Paste the invite link someone sent you.</span>
            <ArrowRight size={15} className="go" />
          </button>
        </div>
        <p className="faint" style={{ fontSize: 12.5 }}>After that, connect Claude Code from Settings and your Claude joins in on its own.</p>
      </motion.div>
    </div>
  );
}

/** A real page for making a project: name it, then get an invite link to share. */
export function NewProject({ onDone, onCancel }: { onDone: (slug: string) => void; onCancel?: () => void }) {
  const { cfg } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ slug: string; link: string } | null>(null);
  const auto = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await call<{ slug: string }>(cfg, 'POST', '/api/projects', { slug: slug || auto, name });
      const inv = await call<{ url: string }>(cfg, 'POST', `/api/projects/${r.slug}/invites`, { role: 'member', uses: 10, days: 7 }).catch(() => ({ url: '' }));
      await qc.invalidateQueries({ queryKey: ['me'] });
      setMade({ slug: r.slug, link: inv.url });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    return (
      <div className="onb">
        <motion.div className="onb-inner" {...enter}>
          <h1>{name} is ready</h1>
          <p className="muted">Send this link to your team. It works 10 times for 7 days, and makes people members. You can make more links, or admin ones, in Team.</p>
          {made.link && (
            <div className="row" style={{ margin: '18px 0' }}>
              <input className="input mono grow" readOnly value={made.link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
              <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(made.link); toast('Copied'); } catch { toast('Select the link and copy it', false); } }}><Copy size={14} /> Copy</button>
            </div>
          )}
          <button type="button" className="btn primary" onClick={() => onDone(made.slug)}>Open {name} <ArrowRight size={15} /></button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="onb">
      <motion.form className="onb-inner" onSubmit={submit} {...enter}>
        {onCancel && <button type="button" className="linkbtn" onClick={onCancel} style={{ marginBottom: 18 }}><ArrowLeft size={14} /> Back</button>}
        <h1>New project</h1>
        <p className="muted">Usually one per game, app or repo. Everyone you invite (and their Claudes) works from it.</p>
        <div className="field" style={{ marginTop: 22 }}>
          <label className="label" htmlFor="np-name">Name</label>
          <input id="np-name" className="input big" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Roll a Fish" autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="np-slug">Short name</label>
          <input id="np-slug" className="input mono" value={slug || auto} onChange={(e) => setSlug(e.target.value)} placeholder="roll-a-fish" />
          <div className="hint">Claudes use this to point at the project. Lowercase, no spaces.</div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" style={{ height: 36 }} disabled={busy || !name.trim()}>Create project <ArrowRight size={15} /></button>
      </motion.form>
    </div>
  );
}

/** Join another project with its invite link. */
export function JoinProject({ onDone, onCancel }: { onDone: (slug: string) => void; onCancel?: () => void }) {
  const { cfg } = useApp();
  const qc = useQueryClient();
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = parseBatonLink(link);
    if (!p || p.kind !== 'join') return setError('Paste the whole invite link, like https://…/join/…');
    setBusy(true);
    setError('');
    try {
      const r = await call<{ project: string }>(cfg, 'POST', `/api/invites/${p.token}/join`, {});
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone(r.project);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="onb">
      <motion.form className="onb-inner" onSubmit={submit} {...enter}>
        {onCancel && <button type="button" className="linkbtn" onClick={onCancel} style={{ marginBottom: 18 }}><ArrowLeft size={14} /> Back</button>}
        <h1>Join a project</h1>
        <p className="muted">Paste the invite link a teammate sent you.</p>
        <div className="field" style={{ marginTop: 22 }}>
          <label className="label" htmlFor="jp-link">Invite link</label>
          <input id="jp-link" className="input big" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/join/…" autoFocus />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" style={{ height: 36 }} disabled={busy || !link.trim()}>Join <ArrowRight size={15} /></button>
      </motion.form>
    </div>
  );
}
