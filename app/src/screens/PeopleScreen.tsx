import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '../Select.tsx';
import { ClipboardPaste, Download, HardDrive, Plug, Unplug } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../main.tsx';
import { call, isTauri, type Role, tauriInvoke, type TreeItem } from '../lib/api.ts';
import { Avatar, DrawCheck, Skel, useToast } from '../ui.tsx';
import { InviteSection } from './InviteSection.tsx';
import { JobsSection } from './JobsSection.tsx';
import { Badges, type Profile } from './SettingsScreen.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including choosing admins',
  admin: 'Change everything, add and remove people',
  member: 'Use everything, comment and chat, but not change it',
  viewer: "Look only. Their Claude can't use the project",
};
const ROLE_NAME: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

export function PeopleScreen(_: { onCreateProject: () => void }) {
  const { overview } = useProject();
  return (
    <div className="pagewrap">
      <div className="setpage">
        <div className="sethead">
          <div className="grow">
            <h1>Team</h1>
            <p>Who's in {overview?.project.name ?? 'this project'}, which Claude chat does what, and how to invite more people.</p>
          </div>
        </div>
        {overview ? <Members /> : <Skel h={180} r={10} style={{ marginTop: 30 }} />}
        <JobsSection />
        <InviteSection />
        <Skills />
        {overview?.role === 'owner' && <DeleteProject />}
      </div>
    </div>
  );
}

/** Owner only: deletes the project and everything in it, for everyone. */
function DeleteProject() {
  const { cfg, update } = useApp();
  const { slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  async function del() {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/delete`, { confirm });
      const me = await call<{ projects: { slug: string }[] }>(cfg, 'GET', '/api/me');
      await update({ project: me.projects.find((p) => p.slug !== slug)?.slug });
      qc.invalidateQueries();
      toast(`Deleted ${overview?.project.name ?? slug}`);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  return (
    <>
      <h2 className="setsec">Delete project</h2>
      <div className="setgroup">
        <div className="setrow">
          <div className="tx">
            <div className="t">Delete {overview?.project.name ?? slug}</div>
            <div className="d">Removes the project for everyone: to-dos, pages, chat, invites and jobs. Files on your PCs stay. This can't be undone.</div>
          </div>
          {!open && <div className="ctl"><button type="button" className="btn ghost sm danger" onClick={() => setOpen(true)}>Delete…</button></div>}
        </div>
        {open && (
          <div className="setrow">
            <input className="input grow" autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Type ${slug} to confirm`} aria-label="Confirm the project name" />
            <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn sm danger-solid" disabled={confirm.trim().toLowerCase() !== slug.toLowerCase()} onClick={del}>Delete forever</button>
          </div>
        )}
      </div>
    </>
  );
}

function Members() {
  const { cfg, slug, overview } = useProject();
  const profiles = useProjectQuery<Record<string, Profile | null>>(['profiles'], `/api/projects/${slug}/profiles`);
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
              <Avatar label={m.name} card />
              <div className="tx">
                <div className="t">{profiles.data?.[m.name]?.display || m.name}{profiles.data?.[m.name]?.display && <span className="faint" style={{ fontWeight: 400 }}>@{m.name}</span>}{m.name === cfg.user && <span className="faint" style={{ fontWeight: 400 }}>you</span>}<Badges list={profiles.data?.[m.name]?.badges} max={3} /></div>
                {profiles.data?.[m.name]?.status && <div className="d" style={{ color: 'var(--ink)' }}>{profiles.data[m.name]?.status}</div>}
                <div className="d">{ROLE_HELP[m.role]}</div>
              </div>
              <div className="ctl">
                {editable ? (
                  <>
                    <Select className="ghost" value={m.role} onChange={(e) => setMember(m.name, e.target.value as Role)} aria-label={`Role for ${m.name}`}>
                      {assignable.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
                    </Select>
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
            <Select className="ghost" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role for the new person">
              {assignable.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
            </Select>
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

export function ThisClaude() {
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

interface LocalSkill {
  folder: string;
  body: string;
  files: Record<string, string>;
  skipped: string[];
  fromBaton: boolean;
}

/** name and description from a SKILL.md's frontmatter. */
function skillMeta(body: string): { name: string; description: string } {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(body.replace(/\r\n/g, '\n'))?.[1] ?? '';
  const get = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  return { name: get('name'), description: get('description') };
}

function Skills() {
  const { cfg, slug } = useProject();
  const toast = useToast();
  const tree = useProjectQuery<TreeItem[]>(['tree'], `/api/projects/${slug}/tree`);
  const skills = (tree.data ?? []).filter((t) => t.kind === 'skill');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'pc' | 'paste' | null>(null);
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const [pasted, setPasted] = useState('');
  const qc = useQueryClient();

  async function share(body: string, folder: string, files: Record<string, string> = {}) {
    const meta = skillMeta(body);
    const name = (meta.name || folder).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('Give the skill a name: add "name: my-skill" at the top.');
    const r = await call<{ message: string }>(cfg, 'POST', `/api/projects/${slug}/skills`, { name, body, summary: (meta.description || `Shared skill ${name}`).slice(0, 240), files });
    qc.invalidateQueries({ queryKey: ['p', slug] });
    return r.message;
  }

  async function openPc() {
    setMode('pc');
    try {
      setLocal(await tauriInvoke<LocalSkill[]>('local_skills'));
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    }
  }

  async function sharePc(k: LocalSkill) {
    setBusy(true);
    try {
      toast(`${await share(k.body, k.folder, k.files)}${k.skipped.length ? ` Left out ${k.skipped.length} binary or big file${k.skipped.length === 1 ? '' : 's'}.` : ''}`);
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

  async function sharePasted(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      toast(await share(pasted, ''));
      setPasted('');
      setMode(null);
    } catch (err) {
      toast(String((err as Error).message ?? err), false);
    } finally {
      setBusy(false);
    }
  }

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
        <span className="act row" style={{ gap: 4 }}>
          {isTauri && <button type="button" className="btn ghost sm" onClick={() => (mode === 'pc' ? setMode(null) : openPc())}><HardDrive size={14} /> Share from this PC</button>}
          <button type="button" className="btn ghost sm" onClick={() => setMode(mode === 'paste' ? null : 'paste')}><ClipboardPaste size={14} /> Paste a skill</button>
          {isTauri && skills.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={install} disabled={busy}><Download size={14} /> Install on this PC</button>
          )}
        </span>
      </h2>
      {mode === 'pc' && (
        <div className="setgroup" style={{ marginBottom: 10 }}>
          {local === null ? (
            <div className="setrow"><Skel h={36} r={8} /></div>
          ) : local.filter((k) => !k.fromBaton).length ? (
            local.filter((k) => !k.fromBaton).map((k) => {
              const meta = skillMeta(k.body);
              const name = meta.name || k.folder;
              const have = skills.some((s) => s.title.toLowerCase() === name.toLowerCase() || s.path.toLowerCase().endsWith(`/${name.toLowerCase()}`));
              return (
                <div key={k.folder} className="setrow">
                  <div className="tx">
                    <div className="t">{name}</div>
                    <div className="d truncate">{meta.description || 'No description'} · {Object.keys(k.files).length + 1} file{Object.keys(k.files).length ? 's' : ''}</div>
                  </div>
                  <div className="ctl">
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={() => sharePc(k)}>{have ? 'Update' : 'Share'}</button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="setrow">
              <div className="tx">
                <div className="t">No skills on this PC</div>
                <div className="d">Claude Code keeps skills in .claude/skills in your user folder. Skills you installed from Baton aren't listed.</div>
              </div>
            </div>
          )}
        </div>
      )}
      {mode === 'paste' && (
        <form className="setgroup" style={{ marginBottom: 10 }} onSubmit={sharePasted}>
          <div className="setrow">
            <div className="tx" style={{ display: 'grid', gap: 8 }}>
              <label className="fl">
                <span>Paste the whole SKILL.md (it starts with name: and description:)</span>
                <textarea className="input mono" rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'---\nname: luau-style\ndescription: How we write Luau in Roll a Fish\n---\n\n# Luau style\n…'} />
              </label>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
                <button className="btn primary" disabled={busy || !pasted.trim()}>Share skill</button>
              </div>
            </div>
          </div>
        </form>
      )}
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
              <div className="d">Share one from this PC or paste its SKILL.md, so every Claude here gets the same know-how.</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
