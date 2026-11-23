import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Download, Plug, PlugZap, Plus, Unplug } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { call, isTauri, type Role, tauriInvoke, type TreeItem } from '../lib/api.ts';
import { Avatar, DrawCheck, Skel, useToast } from '../ui.tsx';
import { CreateProject, useProject, useProjectQuery } from './Shell.tsx';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including admins',
  admin: 'Edit everything, manage members and viewers',
  member: 'Read and use it; post, comment, lock, set status',
  viewer: 'Look in the app; their Claude stays out',
};

export function PeopleScreen(_: { onCreateProject: () => void }) {
  const { overview } = useProject();
  const [newProject, setNewProject] = useState(false);
  return (
    <>
      <header className="topbar">
        <h1>People &amp; Claude</h1>
        <span className="faint">Who can do what, and this PC's Claude</span>
        <div className="grow" />
        <button type="button" className="btn" onClick={() => setNewProject((v) => !v)}>
          <Plus size={15} /> New project
        </button>
      </header>
      <div className="content scroll">
        <div className="page-pad" style={{ maxWidth: 880, display: 'grid', gap: 20 }}>
          {newProject && <CreateProject onDone={() => setNewProject(false)} />}
          <ThisClaude />
          {overview ? <Members /> : <Skel h={180} r={10} />}
          <Skills />
        </div>
      </div>
    </>
  );
}

function Members() {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const mine = overview!.role;
  const canManage = mine === 'owner' || mine === 'admin';
  const assignable: Role[] = mine === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];

  async function setMember(user: string, r: Role | 'none') {
    try {
      const res = await call<{ message: string }>(cfg, 'POST', `/api/projects/${slug}/members`, { user, role: r });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(res.message);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await setMember(name.trim().toLowerCase(), role);
    setName('');
  }

  return (
    <section className="card">
      <div className="card-pad" style={{ paddingBottom: 0 }}>
        <h2 className="section-title">Members of {overview!.project.name}</h2>
      </div>
      <table className="plain">
        <thead>
          <tr><th>Person</th><th>Role</th><th>Can</th><th /></tr>
        </thead>
        <tbody>
          {overview!.members.map((m) => {
            const editableRow = canManage && m.role !== 'owner' && (mine === 'owner' || m.role !== 'admin') && m.name !== cfg.user;
            return (
              <tr key={m.name}>
                <td><span className="row"><Avatar label={m.name} /> {m.name}{m.name === cfg.user ? <span className="faint"> (you)</span> : null}</span></td>
                <td>
                  {editableRow ? (
                    <select className="input" style={{ width: 120, height: 28 }} value={m.role} onChange={(e) => setMember(m.name, e.target.value as Role)}>
                      {assignable.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="chip role">{m.role}</span>
                  )}
                </td>
                <td className="muted">{ROLE_HELP[m.role]}</td>
                <td style={{ textAlign: 'right' }}>
                  {editableRow && <button type="button" className="btn ghost sm danger" onClick={() => setMember(m.name, 'none')}>Remove</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canManage && (
        <form onSubmit={add} className="row card-pad" style={{ borderTop: '1px solid var(--line)' }}>
          <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their Baton name, e.g. boe" />
          <select className="input" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {assignable.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn" disabled={!name.trim()}>Add</button>
        </form>
      )}
    </section>
  );
}

interface ClaudeStatus {
  mcp: boolean;
  hooks: boolean;
  claudeFound: boolean;
}

function ThisClaude() {
  const { cfg, update } = useApp();
  const { slug, overview } = useProject();
  const toast = useToast();
  const [agentName, setAgentName] = useState('Claude');
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ['claude-status', cfg.agentKey],
    queryFn: () => tauriInvoke<ClaudeStatus>('claude_status'),
    enabled: isTauri,
  });
  const agentCard = overview?.live.find((c) => c.isAgent && c.label === `${cfg.user}'s ${cfg.agentName ?? 'Claude'}`);
  const connected = status.data?.mcp && status.data?.hooks;

  async function createKey(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await call<{ key: string; name: string }>(cfg, 'POST', '/api/agents', { name: agentName });
      const next = { ...cfg, agentKey: r.key, agentName: r.name, project: slug };
      await call(next, 'POST', '/api/agents/default', { project: slug }, 'agent');
      await update({ agentKey: r.key, agentName: r.name, project: slug });
      toast(`${cfg.user}'s ${r.name} has a key`);
    } catch (err) {
      toast((err as Error).message, false);
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      await call(cfg, 'POST', '/api/agents/default', { project: slug }, 'agent');
      const msg = await tauriInvoke<string>('connect_claude');
      await status.refetch();
      toast(msg);
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      toast(await tauriInvoke<string>('disconnect_claude'));
      await status.refetch();
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <h2 className="section-title"><Bot size={14} /> This PC's Claude</h2>
      {!cfg.agentKey ? (
        <form onSubmit={createKey}>
          <p className="muted" style={{ marginTop: 0 }}>Give your Claude its own key. It works as you, with your role, and you can revoke it any time.</p>
          <div className="row">
            <input className="input" style={{ width: 200 }} value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            <button className="btn primary" disabled={busy || !agentName.trim()}>Create key</button>
          </div>
        </form>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Avatar label={cfg.user ?? '?'} bot size="lg" />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{cfg.user}'s {cfg.agentName ?? 'Claude'}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                Default project: <span className="mono">{cfg.project ?? slug}</span>
                {agentCard ? ` · last seen in this project` : ' · has not checked in here yet'}
              </div>
            </div>
            {isTauri ? (
              connected ? (
                <>
                  <span className="chip done"><DrawCheck size={11} /> Connected to Claude Code</span>
                  <button type="button" className="btn ghost" onClick={connect} disabled={busy} title="Re-apply the connection"><PlugZap size={14} /></button>
                  <button type="button" className="btn ghost danger" onClick={disconnect} disabled={busy}><Unplug size={14} /> Disconnect</button>
                </>
              ) : (
                <button type="button" className="btn primary" onClick={connect} disabled={busy || status.isLoading}>
                  <Plug size={14} /> Connect to Claude Code
                </button>
              )
            ) : null}
          </div>
          {isTauri && status.data && !status.data.claudeFound && (
            <p className="error-text">Claude Code isn't installed on this PC (the <span className="mono">claude</span> command wasn't found). Install it, then connect.</p>
          )}
          {isTauri ? (
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>
              Connecting adds the Baton tools to Claude Code and four small hooks: the brief at session start, new messages at each prompt, edits to the live feed, and its last reply for handoffs. Your settings file is backed up first.
            </p>
          ) : (
            <>
              <p className="muted">In the desktop app this is one button. From a terminal:</p>
              <div className="codeblock">node connector/cli.mjs use {slug}{'\n'}node connector/cli.mjs connect</div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Skills() {
  const { cfg, slug } = useProject();
  const toast = useToast();
  const tree = useProjectQuery<TreeItem[]>(['tree'], `/api/projects/${slug}/tree`);
  const skills = (tree.data ?? []).filter((t) => t.kind === 'skill');
  const [busy, setBusy] = useState(false);

  async function install() {
    setBusy(true);
    try {
      const bundle = await call<unknown[]>(cfg, 'GET', `/api/projects/${slug}/skills`);
      const msg = await tauriInvoke<string>('install_skills', { project: slug, bundle: JSON.stringify(bundle) });
      toast(msg);
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <div className="row">
        <h2 className="section-title grow" style={{ margin: 0 }}>Shared skills</h2>
        {isTauri && skills.length > 0 && (
          <button type="button" className="btn" onClick={install} disabled={busy}><Download size={14} /> Install on this PC</button>
        )}
      </div>
      {skills.length ? (
        <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none' }}>
          {skills.map((s) => (
            <li key={s.path} className="row" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <span className="mono" style={{ width: 180 }}>{s.title}</span>
              <span className="muted grow truncate">{s.summary}</span>
              <span className="faint">v{s.version}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint" style={{ marginBottom: 0 }}>None yet. Share one with <span className="mono">baton skills push &lt;folder&gt;</span>, so every Claude here gets the same know-how.</p>
      )}
    </section>
  );
}
