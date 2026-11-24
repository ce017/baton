import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plug, Plus, Unplug } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { call, isTauri, type Role, tauriInvoke, type TreeItem } from '../lib/api.ts';
import { Avatar, DrawCheck, Skel, useToast } from '../ui.tsx';
import { JobsSection } from './JobsSection.tsx';
import { NotifySettings } from './Notifier.tsx';
import { CreateProject, useProject, useProjectQuery } from './Shell.tsx';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including choosing admins',
  admin: 'Change everything, add and remove people',
  member: 'Use everything, comment and chat, but not change it',
  viewer: "Look only. Their Claude can't use the project",
};
const ROLE_NAME: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

export function PeopleScreen(_: { onCreateProject: () => void }) {
  const { cfg, overview } = useProject();
  const [newProject, setNewProject] = useState(false);
  return (
    <div className="pagewrap">
      <div className="setpage">
        <div className="sethead">
          <div className="grow">
            <h1>Team</h1>
            <p>Who's in this project, what they can do, and your Claude on this PC.</p>
          </div>
          <button type="button" className="btn ghost" onClick={() => setNewProject((v) => !v)}>
            <Plus size={15} /> New project
          </button>
        </div>
        {newProject && <div style={{ marginTop: 16 }}><CreateProject onDone={() => setNewProject(false)} /></div>}
        <ThisClaude />
        {cfg.agentKey && <JobsSection />}
        {overview ? <Members /> : <Skel h={180} r={10} style={{ marginTop: 30 }} />}
        <Skills />
        <NotifySettings />
      </div>
    </div>
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
    <>
      <h2 className="setsec">People in {overview!.project.name}</h2>
      <div className="setgroup">
        {overview!.members.map((m) => {
          const editable = canManage && m.role !== 'owner' && (mine === 'owner' || m.role !== 'admin') && m.name !== cfg.user;
          return (
            <div key={m.name} className="setrow">
              <Avatar label={m.name} />
              <div className="tx">
                <div className="t">{m.name}{m.name === cfg.user && <span className="faint" style={{ fontWeight: 400 }}>you</span>}</div>
                <div className="d">{ROLE_HELP[m.role]}</div>
              </div>
              <div className="ctl">
                {editable ? (
                  <>
                    <select className="selectlike" value={m.role} onChange={(e) => setMember(m.name, e.target.value as Role)} aria-label={`Role for ${m.name}`}>
                      {assignable.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
                    </select>
                    <button type="button" className="btn ghost sm danger" onClick={() => setMember(m.name, 'none')}>Remove</button>
                  </>
                ) : (
                  <span className="muted" style={{ fontWeight: 550 }}>{ROLE_NAME[m.role]}</span>
                )}
              </div>
            </div>
          );
        })}
        {canManage && (
          <form onSubmit={add} className="setrow">
            <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add someone by their Baton name, e.g. boe" />
            <select className="selectlike" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role for the new person">
              {assignable.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
            </select>
            <button className="btn" disabled={!name.trim()}>Add</button>
          </form>
        )}
      </div>
    </>
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

  async function run(cmd: 'connect_claude' | 'disconnect_claude') {
    setBusy(true);
    try {
      if (cmd === 'connect_claude') await call(cfg, 'POST', '/api/agents/default', { project: slug }, 'agent');
      const msg = await tauriInvoke<string>(cmd);
      await status.refetch();
      toast(msg);
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="setsec">Your Claude on this PC</h2>
      <div className="setgroup">
        {!cfg.agentKey ? (
          <form onSubmit={createKey} className="setrow">
            <div className="tx">
              <div className="t">Give your Claude a key</div>
              <div className="d">It works as you, with your role. You can revoke it any time.</div>
            </div>
            <div className="ctl">
              <input className="input" style={{ width: 150 }} value={agentName} onChange={(e) => setAgentName(e.target.value)} aria-label="Claude name" />
              <button className="btn primary" disabled={busy || !agentName.trim()}>Create key</button>
            </div>
          </form>
        ) : (
          <>
            <div className="setrow">
              <Avatar label={cfg.user ?? '?'} bot />
              <div className="tx">
                <div className="t">{cfg.user}'s {cfg.agentName ?? 'Claude'}</div>
                <div className="d">{agentCard ? 'Has worked in this project' : "Hasn't checked in here yet"}</div>
              </div>
              <div className="ctl">
                {isTauri && connected && <span className="chip done"><DrawCheck size={11} /> Connected</span>}
              </div>
            </div>
            <div className="setrow">
              <div className="tx">
                <div className="t">Claude Code</div>
                <div className="d">
                  {isTauri
                    ? 'Adds the Baton tools and four small hooks: the brief at start, new messages, edits to the feed, and its last reply for hand-overs. Your settings are backed up first.'
                    : <>In the desktop app this is one button. From a terminal: <span className="mono">node connector/cli.mjs connect</span></>}
                </div>
                {isTauri && status.data && !status.data.claudeFound && (
                  <div className="error-text" style={{ marginTop: 6 }}>Claude Code isn't installed on this PC. Install it, then connect.</div>
                )}
              </div>
              {isTauri && (
                <div className="ctl">
                  {connected ? (
                    <button type="button" className="btn ghost danger" onClick={() => run('disconnect_claude')} disabled={busy}><Unplug size={14} /> Disconnect</button>
                  ) : (
                    <button type="button" className="btn primary" onClick={() => run('connect_claude')} disabled={busy || status.isLoading}><Plug size={14} /> Connect</button>
                  )}
                </div>
              )}
            </div>
            <div className="setrow">
              <div className="tx">
                <div className="t">Default project</div>
                <div className="d">Where your Claude reports when a chat doesn't say otherwise.</div>
              </div>
              <div className="ctl"><span style={{ fontWeight: 550 }}>{overview?.project.name ?? cfg.project ?? slug}</span></div>
            </div>
          </>
        )}
      </div>
    </>
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
      toast(await tauriInvoke<string>('install_skills', { project: slug, bundle: JSON.stringify(bundle) }));
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="setsec">
        Shared skills
        {isTauri && skills.length > 0 && (
          <button type="button" className="btn ghost sm act" onClick={install} disabled={busy}><Download size={14} /> Install on this PC</button>
        )}
      </h2>
      <div className="setgroup">
        {skills.length ? skills.map((s) => (
          <div key={s.path} className="setrow">
            <div className="tx">
              <div className="t">{s.title}</div>
              <div className="d truncate">{s.summary}</div>
            </div>
            <div className="ctl faint">v{s.version}</div>
          </div>
        )) : (
          <div className="setrow">
            <div className="tx">
              <div className="t">No shared skills yet</div>
              <div className="d">Share one with <span className="mono">baton skills push &lt;folder&gt;</span> so every Claude here gets the same know-how.</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
