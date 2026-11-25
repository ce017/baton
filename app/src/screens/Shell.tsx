import { useQuery } from '@tanstack/react-query';
import { FileText, KanbanSquare, Link2, LogOut, MessageSquare, Moon, Plus, Search, Settings, Sun, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { createContext, type FormEvent, useContext, useEffect, useMemo, useState } from 'react';
import { useApp } from '../main.tsx';
import { type Config, call, type Me, type Overview, type Task, type TreeItem } from '../lib/api.ts';
import { useLive } from '../lib/live.ts';
import { Avatar, EASE_MOVE, Skel, useToast } from '../ui.tsx';
import { BoardScreen } from './BoardScreen.tsx';
import { MessagesScreen } from './MessagesScreen.tsx';
import { Notifier, UpdateNotice } from './Notifier.tsx';
import { Waker } from './Waker.tsx';
import { ObsidianSync } from './Obsidian.tsx';
import { PagesScreen } from './PagesScreen.tsx';
import { PeopleScreen } from './PeopleScreen.tsx';
import { JoinProject, NewProject, Welcome } from './Onboarding.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { Select } from '../Select.tsx';

export type View = 'board' | 'notes' | 'messages' | 'team' | 'settings';
export interface Route {
  view: View;
  page?: string;
  task?: string;
  chat?: string;
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

/** Every project query lives under ['p', slug, …] so live updates refresh them all. */
export function useProjectQuery<T>(key: string[], path: string, enabled = true) {
  const { cfg, slug } = useProject();
  return useQuery({ queryKey: ['p', slug, ...key], queryFn: () => call<T>(cfg, 'GET', path), enabled });
}

const TABS: { view: View; label: string; icon: typeof KanbanSquare }[] = [
  { view: 'board', label: 'Board', icon: KanbanSquare },
  { view: 'notes', label: 'Notes', icon: FileText },
  { view: 'messages', label: 'Messages', icon: MessageSquare },
  { view: 'team', label: 'Team', icon: Users },
];

function useTheme(): ['dark' | 'light', () => void] {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('baton.theme') === 'light' ? 'light' : 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('baton.theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function Shell() {
  const { cfg, update, signOut } = useApp();
  const me = useQuery({ queryKey: ['me'], queryFn: () => call<Me>(cfg, 'GET', '/api/me') });
  const projects = me.data?.projects ?? [];
  const slug = cfg.project && projects.some((p) => p.slug === cfg.project) ? cfg.project : projects[0]?.slug;
  const [route, go] = useState<Route>({ view: 'board' });
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [page, setPage] = useState<'new' | 'join' | null>(null);
  const openProject = async (s: string) => {
    await update({ project: s });
    setPage(null);
    go({ view: 'board' });
  };
  const [theme, toggleTheme] = useTheme();
  const live = useLive(cfg, slug);
  const overview = useQuery({
    queryKey: ['p', slug, 'overview'],
    queryFn: () => call<Overview>(cfg, 'GET', `/api/projects/${slug}/overview`),
    enabled: !!slug,
    refetchInterval: 60_000, // presence ages even when nothing changes
  });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if (e.key === 'Escape') setMenu(false);
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
    <div className="app">
      <header className="topbar2">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">bt</span>
          Baton
        </div>
        {me.isLoading ? (
          <Skel w={140} h={28} r={7} />
        ) : (
          projects.length > 0 && (
            <Select
              className="proj2"
              value={slug ?? ''}
              onChange={(e) => openProject(e.target.value)}
              aria-label="Project"
              footer={(close) => (
                <>
                  <button type="button" className="menu-item" onClick={() => { close(); setPage('new'); }}><Plus size={14} /> New project</button>
                  <button type="button" className="menu-item" onClick={() => { close(); setPage('join'); }}><Link2 size={14} /> Join with a link</button>
                </>
              )}
            >
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </Select>
          )
        )}
        {slug && (
          <nav className="tabs2">
            {TABS.map(({ view, label, icon: Icon }) => (
              <button type="button" key={view} className={`tab2 ${route.view === view && !page ? 'on' : ''}`} onClick={() => { setPage(null); go({ view }); }} aria-current={route.view === view ? 'page' : undefined}>
                <Icon size={15} />
                {label}
                {view === 'messages' && o?.unread ? <span className="cnt">{o.unread}</span> : null}
                {route.view === view && !page && <motion.span layoutId="tab-uline" className="uline" transition={{ duration: 0.22, ease: EASE_MOVE }} />}
              </button>
            ))}
          </nav>
        )}
        <div className="top-right">
          {slug && (
            <button type="button" className="searchbtn" onClick={() => setPalette(true)}>
              <Search size={14} /> Search <span className="kbd">Ctrl K</span>
            </button>
          )}
          <span
            className={`dot ${live === 'live' ? 'live' : live === 'connecting' ? 'idle' : 'away'}`}
            title={live === 'live' ? 'Live updates on' : live === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
          />
          <button type="button" className="mebtn" onClick={() => setMenu((v) => !v)} aria-label="Your menu">
            <Avatar label={cfg.user ?? '?'} />
          </button>
        </div>
        {menu && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setMenu(false)} />
            <div className="menu" style={{ right: 12, top: 48 }}>
              <div style={{ padding: '6px 10px 8px' }}>
                <div style={{ fontWeight: 600 }}>{cfg.user}</div>
                <div className="faint" style={{ fontSize: 12 }}>{o ? `${o.role} · ${o.project.name}` : cfg.server}</div>
              </div>
              <button type="button" className="menu-item" disabled={!slug} onClick={() => { setPage(null); go({ view: 'settings' }); setMenu(false); }}>
                <Settings size={14} /> Settings and profile
              </button>
              <button type="button" className="menu-item" onClick={() => { toggleTheme(); setMenu(false); }}>
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />} {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              <button type="button" className="menu-item" onClick={signOut}><LogOut size={14} /> Sign out</button>
            </div>
          </>
        )}
      </header>

      <UpdateNotice />
      <main className="view">
        {page === 'new' ? (
          <NewProject onDone={openProject} onCancel={() => setPage(null)} />
        ) : page === 'join' ? (
          <JoinProject onDone={openProject} onCancel={() => setPage(null)} />
        ) : !slug && !me.isLoading ? (
          <Welcome onCreate={() => setPage('new')} onJoin={() => setPage('join')} />
        ) : state ? (
          <ProjectCtx.Provider value={state}>
            <Notifier />
            <Waker />
            <ObsidianSync />
            {route.view === 'board' && <BoardScreen />}
            {route.view === 'notes' && <div className="pagewrap" style={{ display: 'flex', flexDirection: 'column' }}><PagesScreen /></div>}
            {route.view === 'messages' && <MessagesScreen />}
            {route.view === 'team' && <div className="pagewrap"><PeopleScreen onCreateProject={() => setPage('new')} /></div>}
            {route.view === 'settings' && <SettingsScreen />}
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
        <p className="muted" style={{ marginTop: 0 }}>A project holds the to-dos, notes and messages your team and their Claudes share.</p>
        <div className="field">
          <label className="label" htmlFor="pname">Name</label>
          <input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Roll a Fish" autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="pslug">Short name</label>
          <input id="pslug" className="input mono" value={slug || auto} onChange={(e) => setSlug(e.target.value)} placeholder="roll-a-fish" />
          <div className="hint">Claudes use this to refer to the project.</div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={!name.trim()}><Plus size={15} /> Create project</button>
      </div>
    </form>
  );
}

/** Ctrl+K: jump to any note, to-do or screen. Used many times a day, so it appears instantly. */
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
    for (const n of TABS) if (!words.length || hit(n.label)) out.push({ key: `v-${n.view}`, label: n.label, sub: 'Screen', run: () => go({ view: n.view }) });
    for (const t of tree.data ?? []) if (words.length && hit(`${t.path} ${t.title} ${t.summary}`)) out.push({ key: t.path, label: t.title, sub: 'Note', run: () => go({ view: 'notes', page: t.path }) });
    for (const t of tasks.data ?? []) if (words.length && hit(`${t.title} ${t.area}`)) out.push({ key: t.id, label: t.title, sub: 'To-do', run: () => go({ view: 'board', task: t.id }) });
    return out.slice(0, 12);
  }, [q, tree.data, tasks.data, go]);

  useEffect(() => setSel(0), [q]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Search">
        <input
          autoFocus
          placeholder="Search notes, to-dos and screens…"
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
              <span className="faint truncate" style={{ maxWidth: 220 }}>{r.sub}</span>
            </div>
          ))}
          {!results.length && <div className="empty">Nothing matches.</div>}
        </div>
      </div>
    </>
  );
}
