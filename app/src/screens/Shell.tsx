import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronsUpDown, FileText, Inbox, KanbanSquare, LogOut, Plus, Search, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { createContext, type FormEvent, useContext, useEffect, useMemo, useState } from 'react';
import { useApp } from '../main.tsx';
import { type Config, call, type Me, type Overview, type Task, type TreeItem } from '../lib/api.ts';
import { useLive } from '../lib/live.ts';
import { Avatar, EASE_MOVE, Skel, useToast } from '../ui.tsx';
import { InboxScreen } from './InboxScreen.tsx';
import { LiveScreen } from './LiveScreen.tsx';
import { PagesScreen } from './PagesScreen.tsx';
import { PeopleScreen } from './PeopleScreen.tsx';
import { TasksScreen } from './TasksScreen.tsx';

export type View = 'live' | 'pages' | 'tasks' | 'inbox' | 'people';
export interface Route {
  view: View;
  page?: string;
  task?: string;
}

interface ProjectState {
  cfg: Config;
  slug: string;
  overview?: Overview;
  route: Route;
  go(r: Route): void;
}

const ProjectCtx = createContext<ProjectState | null>(null);
export function useProject(): ProjectState {
  const v = useContext(ProjectCtx);
  if (!v) throw new Error('useProject outside a project');
  return v;
}

/** Query helper: every project query lives under ['p', slug, …] so live updates refresh them all. */
export function useProjectQuery<T>(key: string[], path: string, enabled = true) {
  const { cfg, slug } = useProject();
  return useQuery({ queryKey: ['p', slug, ...key], queryFn: () => call<T>(cfg, 'GET', path), enabled });
}

const NAV: { view: View; label: string; icon: typeof Activity }[] = [
  { view: 'live', label: 'Live', icon: Activity },
  { view: 'pages', label: 'Pages', icon: FileText },
  { view: 'tasks', label: 'Tasks', icon: KanbanSquare },
  { view: 'inbox', label: 'Inbox', icon: Inbox },
  { view: 'people', label: 'People & Claude', icon: Users },
];

export function Shell() {
  const { cfg, update, signOut } = useApp();
  const me = useQuery({ queryKey: ['me'], queryFn: () => call<Me>(cfg, 'GET', '/api/me') });
  const projects = me.data?.projects ?? [];
  const slug = cfg.project && projects.some((p) => p.slug === cfg.project) ? cfg.project : projects[0]?.slug;
  const [route, go] = useState<Route>({ view: 'live' });
  const [palette, setPalette] = useState(false);
  const live = useLive(cfg, slug);
  const overview = useQuery({
    queryKey: ['p', slug, 'overview'],
    queryFn: () => call<Overview>(cfg, 'GET', `/api/projects/${slug}/overview`),
    enabled: !!slug,
    refetchInterval: 60_000, // presence dots age even when nothing changes
  });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (me.isError) {
    return (
      <div className="signin">
        <div className="card signin-card">
          <p className="error-text">{(me.error as Error).message}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => me.refetch()}>Try again</button>
            <button type="button" className="btn ghost" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  const state: ProjectState | null = slug ? { cfg, slug, overview: overview.data, route, go } : null;
  const o = overview.data;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">bt</span>
          Baton
          <span
            className={`dot ${live === 'live' ? 'live' : live === 'connecting' ? 'idle' : 'away'}`}
            title={live === 'live' ? 'Live updates on' : live === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
            style={{ marginLeft: 'auto' }}
          />
        </div>
        {me.isLoading ? (
          <div style={{ padding: '4px 14px' }}>
            <Skel h={30} r={6} />
          </div>
        ) : (
          projects.length > 0 && (
            <label className="project-switch" style={{ position: 'relative', display: 'block' }}>
              <select
                className="input"
                style={{ appearance: 'none', fontWeight: 600, paddingRight: 28 }}
                value={slug}
                onChange={(e) => {
                  update({ project: e.target.value });
                  go({ view: 'live' });
                }}
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.name}</option>
                ))}
              </select>
              <ChevronsUpDown size={14} style={{ position: 'absolute', right: 9, top: 9, color: 'var(--ink-3)', pointerEvents: 'none' }} />
            </label>
          )
        )}
        {slug && (
          <nav className="nav">
            {NAV.map(({ view, label, icon: Icon }) => {
              const active = route.view === view;
              const extra =
                view === 'inbox' && o?.unread ? <span className="badge">{o.unread}</span>
                : view === 'pages' && o ? <span className="count">{o.counts.pages}</span>
                : view === 'tasks' && o ? <span className="count">{o.counts.openTasks}</span>
                : null;
              return (
                <button type="button" key={view} className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => go({ view })}>
                  {active && <motion.span layoutId="nav-active" className="nav-bg" transition={{ duration: 0.22, ease: EASE_MOVE }} />}
                  <Icon size={15} />
                  <span>{label}</span>
                  {extra}
                </button>
              );
            })}
            <button type="button" className="nav-item" onClick={() => setPalette(true)}>
              <Search size={15} />
              <span>Search</span>
              <span className="kbd" style={{ marginLeft: 'auto' }}>Ctrl K</span>
            </button>
          </nav>
        )}
        <div className="sidebar-foot row">
          <Avatar label={cfg.user ?? '?'} />
          <div className="grow">
            <div className="truncate" style={{ fontWeight: 500 }}>{cfg.user}</div>
            <div className="faint truncate" style={{ fontSize: 11 }}>{o ? `${o.role} · ${o.project.name}` : cfg.server}</div>
          </div>
          <button type="button" className="btn ghost icon" title="Sign out" onClick={signOut}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main">
        {!slug && !me.isLoading ? (
          <CreateProject first />
        ) : state ? (
          <ProjectCtx.Provider value={state}>
            {route.view === 'live' && <LiveScreen />}
            {route.view === 'pages' && <PagesScreen />}
            {route.view === 'tasks' && <TasksScreen />}
            {route.view === 'inbox' && <InboxScreen />}
            {route.view === 'people' && <PeopleScreen onCreateProject={() => go({ view: 'people' })} />}
            {palette && <Palette onClose={() => setPalette(false)} />}
          </ProjectCtx.Provider>
        ) : null}
      </main>
    </div>
  );
}

export function CreateProject({ first, onDone }: { first?: boolean; onDone?: () => void }) {
  const { cfg, update } = useApp();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const auto = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await call<{ slug: string }>(cfg, 'POST', '/api/projects', { slug: slug || auto, name });
      await update({ project: r.slug });
      toast(`Created ${name}`);
      onDone?.();
      location.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className={first ? 'signin' : ''} onSubmit={submit}>
      <div className="card signin-card">
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{first ? 'Create your first project' : 'New project'}</h2>
        <p className="muted" style={{ marginTop: 0 }}>A project holds the pages, tasks and handoffs your team and their Claudes share.</p>
        <div className="field">
          <label className="label" htmlFor="pname">Name</label>
          <input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Roll a Fish" autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="pslug">Short id</label>
          <input id="pslug" className="input mono" value={slug || auto} onChange={(e) => setSlug(e.target.value)} placeholder="roll-a-fish" />
          <div className="hint">Claudes use this to name the project.</div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={!name.trim()}>
          <Plus size={15} /> Create project
        </button>
      </div>
    </form>
  );
}

/** Ctrl+K: jump to any page, task or screen. Used many times a day, so it appears instantly (no animation). */
function Palette({ onClose }: { onClose: () => void }) {
  const { go, slug } = useProject();
  const tree = useProjectQuery<TreeItem[]>(['tree'], `/api/projects/${slug}/tree`);
  const tasks = useProjectQuery<Task[]>(['tasks'], `/api/projects/${slug}/tasks`);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const out: { key: string; label: string; sub: string; run: () => void }[] = [];
    for (const n of NAV) if (!words.length || hit(n.label)) out.push({ key: `v-${n.view}`, label: n.label, sub: 'Screen', run: () => go({ view: n.view }) });
    for (const t of tree.data ?? []) {
      if (words.length && hit(`${t.path} ${t.title} ${t.summary}`)) out.push({ key: t.path, label: t.title, sub: t.path, run: () => go({ view: 'pages', page: t.path }) });
    }
    for (const t of tasks.data ?? []) {
      if (words.length && hit(`${t.id} ${t.title} ${t.area}`)) out.push({ key: t.id, label: `${t.id} ${t.title}`, sub: 'Task', run: () => go({ view: 'tasks', task: t.id }) });
    }
    return out.slice(0, 12);
  }, [q, tree.data, tasks.data, go]);

  useEffect(() => setSel(0), [q]);
  return (
    <>
      <div className="scrim" onClick={onClose} style={{ background: 'rgba(29,28,26,0.12)' }} />
      <div className="palette" role="dialog" aria-label="Search">
        <input
          autoFocus
          placeholder="Search pages, tasks and screens…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter' && results[sel]) { results[sel].run(); onClose(); }
          }}
        />
        <div className="scroll" style={{ maxHeight: 380, padding: '4px 0' }}>
          {results.map((r, i) => (
            <div key={r.key} className={`palette-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => { r.run(); onClose(); }}>
              <span className="grow truncate">{r.label}</span>
              <span className="faint mono truncate" style={{ maxWidth: 220 }}>{r.sub}</span>
            </div>
          ))}
          {!results.length && <div className="empty">Nothing matches.</div>}
        </div>
      </div>
    </>
  );
}
