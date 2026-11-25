import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Check } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useApp } from '../main.tsx';
import { call } from '../lib/api.ts';
import { useToast } from '../ui.tsx';
import { AccountSection } from './InviteSection.tsx';
import { JobsSection } from './JobsSection.tsx';
import { NotifySettings } from './Notifier.tsx';
import { ObsidianSettings } from './Obsidian.tsx';
import { ThisClaude } from './PeopleScreen.tsx';
import { useProject } from './Shell.tsx';
import { WakeSettings } from './Waker.tsx';

export interface Badge {
  id: string;
  label: string;
  kind: 'earned' | 'host';
}
export interface Profile {
  name: string;
  display: string;
  about: string;
  color: string;
  status: string;
  badges: Badge[];
}

const COLORS = ['#5b8def', '#3fa37a', '#c9a23f', '#d0743c', '#c4566b', '#9a6fd1', '#4fa3b5', '#8a8a8a'];

/** Small badge chips. Earned ones come from what you did; "host" ones only this server's host can give. */
export function Badges({ list, max = 4 }: { list?: Badge[]; max?: number }) {
  if (!list?.length) return null;
  return (
    <span className="badges">
      {list.slice(0, max).map((b) => (
        <span key={b.id} className={`badge ${b.kind}`} title={b.kind === 'host' ? `${b.label}: given by this server's host` : `${b.label}: earned`}>
          {b.kind === 'host' && <Award size={11} />}
          {b.label}
        </span>
      ))}
    </span>
  );
}

function ProfileSection() {
  const { cfg } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const prof = useQuery({ queryKey: ['profile'], queryFn: () => call<Profile>(cfg, 'GET', '/api/me/profile') });
  const [p, setP] = useState({ display: '', status: '', about: '', color: '' });
  useEffect(() => {
    if (prof.data) setP({ display: prof.data.display, status: prof.data.status, about: prof.data.about, color: prof.data.color });
  }, [prof.data]);
  const dirty = !!prof.data && (p.display !== prof.data.display || p.status !== prof.data.status || p.about !== prof.data.about || p.color !== prof.data.color);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await call(cfg, 'POST', '/api/me/profile', p);
      await qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['p'] });
      toast('Profile saved');
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  const initial = (p.display || cfg.user || '?').trim()[0]?.toUpperCase();
  return (
    <>
      <h2 className="setsec">Your profile</h2>
      <form className="setgroup" onSubmit={save}>
        <div className="setrow">
          <span className={`avatar xl ${p.color ? "colored" : ""}`} style={{ background: p.color || undefined }}>{initial}</span>
          <div className="tx">
            <div className="t">{p.display || cfg.user} <span className="faint" style={{ fontWeight: 400 }}>@{cfg.user}</span></div>
            <div className="d">{p.status || 'No status'} </div>
            <div style={{ marginTop: 6 }}><Badges list={prof.data?.badges} max={8} /></div>
          </div>
        </div>
        <div className="setrow">
          <div className="tx"><div className="t">Display name</div><div className="d">What your team sees next to your messages.</div></div>
          <div className="ctl"><input className="input" style={{ width: 220 }} value={p.display} maxLength={40} onChange={(e) => setP({ ...p, display: e.target.value })} placeholder={cfg.user} aria-label="Display name" /></div>
        </div>
        <div className="setrow">
          <div className="tx"><div className="t">Status</div><div className="d">A short line, like "on the shop UI" or "away till Monday".</div></div>
          <div className="ctl"><input className="input" style={{ width: 220 }} value={p.status} maxLength={80} onChange={(e) => setP({ ...p, status: e.target.value })} aria-label="Status" /></div>
        </div>
        <div className="setrow" style={{ alignItems: 'flex-start' }}>
          <div className="tx"><div className="t">About</div><div className="d">What you do on the team.</div></div>
          <div className="ctl"><textarea className="input" rows={2} style={{ width: 220 }} value={p.about} maxLength={280} onChange={(e) => setP({ ...p, about: e.target.value })} aria-label="About" /></div>
        </div>
        <div className="setrow">
          <div className="tx"><div className="t">Colour</div><div className="d">Your avatar colour.</div></div>
          <div className="ctl swatches">
            <button type="button" className={`swatch none ${!p.color ? 'on' : ''}`} onClick={() => setP({ ...p, color: '' })} aria-label="Default colour">{!p.color && <Check size={12} />}</button>
            {COLORS.map((c) => (
              <button key={c} type="button" className={`swatch ${p.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setP({ ...p, color: c })} aria-label={`Colour ${c}`}>
                {p.color === c && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>
        <div className="setrow" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary sm" disabled={!dirty}>Save profile</button>
        </div>
      </form>
    </>
  );
}

function DangerZone() {
  const { cfg, update } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  async function del() {
    try {
      await call(cfg, 'POST', '/api/me/delete', { confirm });
      await update({ userKey: undefined, user: undefined, project: undefined, agentKey: undefined, agentName: undefined });
      location.reload();
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  return (
    <>
      <h2 className="setsec">Delete account</h2>
      <div className="setgroup">
        <div className="setrow">
          <div className="tx">
            <div className="t">Delete your Baton account</div>
            <div className="d">Removes you from every project. Projects you own are deleted with everything in them. This can't be undone.</div>
          </div>
          {!open && <div className="ctl"><button type="button" className="btn ghost sm danger" onClick={() => setOpen(true)}>Delete…</button></div>}
        </div>
        {open && (
          <div className="setrow">
            <input className="input grow" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Type ${cfg.user} to confirm`} aria-label="Confirm your name" />
            <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn sm danger-solid" disabled={confirm.trim().toLowerCase() !== cfg.user} onClick={del}>Delete forever</button>
          </div>
        )}
      </div>
    </>
  );
}

/** Your own things: profile, this PC's Claude, notifications, account. Team is for the project's people. */
export function SettingsScreen() {
  const { overview } = useProject();
  return (
    <div className="pagewrap">
      <div className="setpage">
        <div className="sethead">
          <div className="grow">
            <h1>Settings</h1>
            <p>Your profile, your Claude on this PC, and how Baton behaves here.</p>
          </div>
        </div>
        <ProfileSection />
        <ThisClaude />
        <JobsSection />
        <NotifySettings />
        <WakeSettings />
        <ObsidianSettings key={overview?.project.slug} />
        <AccountSection />
        <DangerZone />
      </div>
    </div>
  );
}
