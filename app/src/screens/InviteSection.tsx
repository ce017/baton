import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, LogIn, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { call, type Me } from '../lib/api.ts';
import { useToast } from '../ui.tsx';
import { parseBatonLink } from './SignIn.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

interface Invites {
  links: { id: string; role: string; uses_left: number; uses: number; expires_at: number; created_by: string }[];
  emails: { email: string; role: string; at: number }[];
}

const ROLES = { admin: 'Admins', member: 'Members', viewer: 'Viewers' } as const;
const days = (t: number) => Math.max(1, Math.ceil((t - Date.now()) / 86_400_000));

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Owners and admins: invite links with a number of uses, and adding people by email. */
export function InviteSection() {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const mine = overview?.role;
  const canInvite = mine === 'owner' || mine === 'admin';
  const data = useProjectQuery<Invites>(['invites'], `/api/projects/${slug}/invites`, canInvite);
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [uses, setUses] = useState(5);
  const [validDays, setValidDays] = useState(7);
  const [fresh, setFresh] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailRole, setEmailRole] = useState<'admin' | 'member' | 'viewer'>('member');
  if (!canInvite) return null;
  const roles = (mine === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer']) as ('admin' | 'member' | 'viewer')[];
  const refresh = () => qc.invalidateQueries({ queryKey: ['p', slug] });

  async function makeLink() {
    try {
      const r = await call<{ url: string }>(cfg, 'POST', `/api/projects/${slug}/invites`, { role, uses, days: validDays });
      setFresh(r.url);
      toast((await copy(r.url)) ? 'Invite link copied' : 'Invite link ready');
      refresh();
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  async function revoke(body: { id?: string; email?: string }) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/invite-revoke`, body);
      refresh();
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  async function addEmail(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await call<{ message: string }>(cfg, 'POST', `/api/projects/${slug}/email-invites`, { email, role: emailRole });
      toast(r.message);
      setEmail('');
      refresh();
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  return (
    <>
      <h2 className="setsec">Invite people</h2>
      <div className="setgroup">
        <div className="setrow">
          <div className="tx">
            <div className="t"><Link2 size={14} /> Invite link</div>
            <div className="d">Anyone with the link joins {overview?.project.name} with this role, until its uses run out. Viewers can only look.</div>
          </div>
          <div className="ctl">
            <select className="selectlike" value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Role">
              {roles.map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
            </select>
            <select className="selectlike" value={uses} onChange={(e) => setUses(Number(e.target.value))} aria-label="Uses">
              {[1, 5, 10, 25].map((n) => <option key={n} value={n}>{n === 1 ? '1 use' : `${n} uses`}</option>)}
            </select>
            <select className="selectlike" value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} aria-label="Valid for">
              {[1, 7, 30].map((n) => <option key={n} value={n}>{n === 1 ? '1 day' : `${n} days`}</option>)}
            </select>
            <button type="button" className="btn primary sm" onClick={makeLink}>Create link</button>
          </div>
        </div>
        {fresh && (
          <div className="setrow">
            <input className="input mono grow" readOnly value={fresh} onFocus={(e) => e.target.select()} aria-label="New invite link" />
            <button type="button" className="btn sm" onClick={async () => toast((await copy(fresh)) ? 'Copied' : 'Select the link and copy it', true)}><Copy size={13} /> Copy</button>
          </div>
        )}
        {(data.data?.links ?? []).map((l) => (
          <div key={l.id} className="setrow">
            <div className="tx">
              <div className="t" style={{ fontWeight: 500 }}>{ROLES[l.role as keyof typeof ROLES] ?? l.role} link</div>
              <div className="d">{l.uses_left} of {l.uses} uses left · {days(l.expires_at)} {days(l.expires_at) === 1 ? 'day' : 'days'} left · by {l.created_by}</div>
            </div>
            <div className="ctl"><button type="button" className="btn ghost sm danger" onClick={() => revoke({ id: l.id })}>Turn off</button></div>
          </div>
        ))}
        <form className="setrow" onSubmit={addEmail}>
          <Mail size={15} className="faint" />
          <input className="input grow" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Add by email, e.g. boe@gmail.com" aria-label="Email" />
          <select className="selectlike" value={emailRole} onChange={(e) => setEmailRole(e.target.value as typeof emailRole)} aria-label="Role for this email">
            {roles.map((r) => <option key={r} value={r}>{ROLES[r].slice(0, -1)}</option>)}
          </select>
          <button className="btn sm" disabled={!email.includes('@')}>Add</button>
        </form>
        {(data.data?.emails ?? []).map((m) => (
          <div key={m.email} className="setrow">
            <div className="tx">
              <div className="t" style={{ fontWeight: 500 }}>{m.email}</div>
              <div className="d">Joins as {m.role} the first time they sign in with Google.</div>
            </div>
            <div className="ctl"><button type="button" className="btn ghost sm danger" onClick={() => revoke({ email: m.email })}>Cancel</button></div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Everyone: how you sign in, signing in on another device, and joining another project. */
export function AccountSection() {
  const { cfg, update } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => call<Me & { emails?: string[] }>(cfg, 'GET', '/api/me') });
  const [deviceLink, setDeviceLink] = useState<string | null>(null);
  const [join, setJoin] = useState('');

  async function makeDeviceLink() {
    try {
      const r = await call<{ url: string }>(cfg, 'POST', '/api/login-links', {});
      setDeviceLink(r.url);
      toast((await copy(r.url)) ? 'Sign-in link copied' : 'Sign-in link ready');
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  async function joinProject(e: FormEvent) {
    e.preventDefault();
    const p = parseBatonLink(join);
    if (!p || p.kind !== 'join') return toast('Paste an invite link (…/join/…)', false);
    try {
      const r = await call<{ project: string; role: string }>(cfg, 'POST', `/api/invites/${p.token}/join`, {});
      await qc.invalidateQueries({ queryKey: ['me'] });
      await update({ project: r.project });
      setJoin('');
      toast(`Joined as ${r.role}`);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  const emails = me.data?.emails ?? [];
  return (
    <>
      <h2 className="setsec">Your account</h2>
      <div className="setgroup">
        <div className="setrow">
          <div className="tx">
            <div className="t">{cfg.user}</div>
            <div className="d">{emails.length ? `Signs in with Google as ${emails.join(', ')}` : 'No Google account linked: sign out and use "Continue with Google" with the same email to link it.'}</div>
          </div>
        </div>
        <div className="setrow">
          <div className="tx">
            <div className="t"><LogIn size={14} /> Sign in on another device</div>
            <div className="d">A one-use link, valid for 15 minutes. Open it there, or paste it into Baton's sign-in.</div>
          </div>
          <div className="ctl"><button type="button" className="btn sm" onClick={makeDeviceLink}>Make link</button></div>
        </div>
        {deviceLink && (
          <div className="setrow">
            <input className="input mono grow" readOnly value={deviceLink} onFocus={(e) => e.target.select()} aria-label="Sign-in link" />
            <button type="button" className="btn sm" onClick={async () => toast((await copy(deviceLink)) ? 'Copied' : 'Select the link and copy it')}><Copy size={13} /> Copy</button>
          </div>
        )}
        <form className="setrow" onSubmit={joinProject}>
          <Link2 size={15} className="faint" />
          <input className="input grow" value={join} onChange={(e) => setJoin(e.target.value)} placeholder="Join another project: paste its invite link" aria-label="Invite link" />
          <button className="btn sm" disabled={!join.trim()}>Join</button>
        </form>
      </div>
    </>
  );
}
