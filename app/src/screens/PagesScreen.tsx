import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { ChevronRight, FilePlus2, FileText, Folder, Gavel, Pencil, Sparkles, Star } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { call, canEdit, isTauri, type Page, type TreeItem } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Avatar, EASE_IN, EASE_OUT, Empty, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  items: TreeItem[];
}

function buildTree(items: TreeItem[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), items: [] };
  for (const it of items) {
    const parts = it.path.split('/');
    let f = root;
    for (const part of parts.slice(0, -1)) {
      const key = part.toLowerCase();
      if (!f.folders.has(key)) f.folders.set(key, { name: part, path: f.path ? `${f.path}/${part}` : part, folders: new Map(), items: [] });
      f = f.folders.get(key)!;
    }
    f.items.push(it);
  }
  return root;
}

const KIND_ICON = { page: FileText, decision: Gavel, skill: Sparkles } as const;

export function PagesScreen() {
  const { slug, route, go, overview } = useProject();
  const tree = useProjectQuery<TreeItem[]>(['tree'], `/api/projects/${slug}/tree`);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [newPath, setNewPath] = useState<string | null>(null);
  const editable = canEdit(overview?.role);
  const root = useMemo(() => buildTree(tree.data ?? []), [tree.data]);
  const selected = draftPath ?? route.page;

  useEffect(() => {
    if (!route.page && tree.data?.length) {
      const pinned = tree.data.find((t) => t.pinned) ?? tree.data.find((t) => t.kind !== 'skill');
      if (pinned) go({ view: 'notes', page: pinned.path });
    }
  }, [route.page, tree.data, go]);

  function startNew(e: FormEvent) {
    e.preventDefault();
    const p = (newPath ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!p) return;
    setNewPath(null);
    setDraftPath(p);
  }

  return (
    <>
      <header className="topbar">
        <h1>Notes</h1>
        <span className="faint">What every Claude reads before it starts</span>
        <div className="grow" />
        {editable && (
          <button type="button" className="btn" onClick={() => setNewPath(route.page?.split('/').slice(0, -1).join('/').concat('/') ?? '')}>
            <FilePlus2 size={15} /> New note
          </button>
        )}
      </header>
      <div className="content">
        <div className="split">
          <nav className="tree scroll" aria-label="Pages">
            {newPath !== null && (
              <form onSubmit={startNew} style={{ padding: '0 4px 8px' }}>
                <input
                  className="input mono"
                  autoFocus
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onBlur={() => !newPath && setNewPath(null)}
                  onKeyDown={(e) => e.key === 'Escape' && setNewPath(null)}
                  placeholder="Systems/FishService"
                />
                <div className="hint">Folder/Name, then Enter</div>
              </form>
            )}
            {tree.isLoading ? (
              <div style={{ padding: 8 }}>
                {[70, 50, 85, 60, 40, 75].map((w, i) => (
                  <Skel key={i} w={`${w}%`} h={10} style={{ margin: '10px 4px' }} />
                ))}
              </div>
            ) : tree.data?.length ? (
              <FolderView folder={root} depth={0} selected={selected} onOpen={(p) => { setDraftPath(null); go({ view: 'notes', page: p }); }} />
            ) : (
              <Empty title="No pages yet">{editable ? 'Create one, or import notes with the CLI.' : 'An admin can add some.'}</Empty>
            )}
          </nav>
          <div className="scroll">
            {draftPath ? (
              <PageEditor key={`new-${draftPath}`} path={draftPath} onDone={(p) => { setDraftPath(null); if (p) go({ view: 'notes', page: p }); }} />
            ) : route.page ? (
              <PageView key={route.page} path={route.page} items={tree.data ?? []} />
            ) : (
              !tree.isLoading && <Empty title="Pick a page on the left" />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function FolderView({ folder, depth, selected, onOpen }: { folder: Folder; depth: number; selected?: string; onOpen: (p: string) => void }) {
  return (
    <>
      {[...folder.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => (
          <FolderRow key={f.path} folder={f} depth={depth} selected={selected} onOpen={onOpen} />
        ))}
      {folder.items
        .sort((a, b) => b.pinned - a.pinned || a.title.localeCompare(b.title))
        .map((it) => {
          const Icon = KIND_ICON[it.kind] ?? FileText;
          return (
            <button
              type="button"
              key={it.path}
              className={`tree-row ${selected?.toLowerCase() === it.path.toLowerCase() ? 'active' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 + 16 }}
              onClick={() => onOpen(it.path)}
              title={it.summary}
            >
              <Icon size={14} style={{ flex: 'none' }} />
              <span className="truncate grow">{it.title}</span>
              {it.pinned ? <Star size={11} fill="currentColor" className="faint" /> : null}
            </button>
          );
        })}
    </>
  );
}

function FolderRow({ folder, depth, selected, onOpen }: { folder: Folder; depth: number; selected?: string; onOpen: (p: string) => void }) {
  const holdsSelected = !!selected && selected.toLowerCase().startsWith(`${folder.path.toLowerCase()}/`);
  const [open, setOpen] = useState(depth === 0 || holdsSelected);
  useEffect(() => {
    if (holdsSelected) setOpen(true);
  }, [holdsSelected]);
  return (
    <>
      <button type="button" className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
        <Folder size={14} style={{ flex: 'none' }} />
        <span className="truncate">{folder.name}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: { duration: 0.18, ease: EASE_OUT } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.1, ease: EASE_IN } }}
            style={{ overflow: 'hidden' }}
          >
            <FolderView folder={folder} depth={depth + 1} selected={selected} onOpen={onOpen} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** [[Target]] and [[Target|Text]] become links resolved against the vault. */
function withWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => `[${(alias ?? target).trim()}](wiki:${encodeURIComponent(target.trim())})`);
}

function resolveWiki(target: string, items: TreeItem[]): TreeItem | undefined {
  const t = target.toLowerCase();
  return (
    items.find((i) => i.path.toLowerCase() === t) ??
    items.find((i) => i.path.toLowerCase().split('/').pop() === t) ??
    items.find((i) => i.title.toLowerCase() === t)
  );
}

/** Summaries are one line of text; drop markdown emphasis that notes sometimes carry. */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a);
}

function safeUrl(url: string): string {
  return /^(https?:|mailto:|wiki:|#)/i.test(url) ? url : '';
}

async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

function PageView({ path, items }: { path: string; items: TreeItem[] }) {
  const { slug, go, overview, cfg } = useProject();
  const page = useProjectQuery<Page>(['page', path.toLowerCase()], `/api/projects/${slug}/page?path=${encodeURIComponent(path)}`);
  const [editing, setEditing] = useState(false);
  const editable = canEdit(overview?.role) && page.data?.kind !== 'skill';

  useEffect(() => {
    if (!editable) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'e' && !editing && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement).isContentEditable) {
        e.preventDefault();
        setEditing(true);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [editable, editing]);

  if (page.isLoading) {
    return (
      <div className="doc">
        <Skel w={180} h={9} style={{ marginBottom: 12 }} />
        <Skel w="55%" h={22} style={{ marginBottom: 12 }} />
        <Skel w="80%" h={12} style={{ marginBottom: 28 }} />
        {[100, 92, 96, 70, 88, 60].map((w, i) => (
          <Skel key={i} w={`${w}%`} h={11} style={{ marginBottom: 10 }} />
        ))}
      </div>
    );
  }
  if (page.isError || !page.data) return <Empty title="This page doesn't exist (any more)." />;
  const p = page.data;
  if (editing) return <PageEditor path={p.path} page={p} onDone={() => setEditing(false)} />;

  return (
    <motion.article className="doc" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16 } }}>
      <div className="doc-path">{p.path}</div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <h1 className="title grow">{p.title}</h1>
        {editable && (
          <button type="button" className="btn" onClick={() => setEditing(true)} title="Edit (E)">
            <Pencil size={14} /> Edit
          </button>
        )}
      </div>
      <p className="summary">{plain(p.summary)}</p>
      <div className="doc-meta">
        {p.kind !== 'page' && <span className="chip role">{p.kind}</span>}
        {p.pinned && <span className="chip role"><Star size={10} fill="currentColor" /> pinned in every brief</span>}
        <span className="row" style={{ gap: 6 }}>
          <Avatar label={p.updatedBy} bot={p.updatedBy.includes("'s ")} size="sm" /> {p.updatedBy}
        </span>
        <span>{ago(p.updatedAt)}</span>
        <span>v{p.version}</span>
        {p.tags.map((t) => (
          <span key={t} className="mono">#{t}</span>
        ))}
      </div>
      {p.kind === 'skill' && (
        <p className="muted" style={{ marginTop: -6 }}>
          Shared skill{p.files.length ? ` with ${p.files.length} extra file${p.files.length === 1 ? '' : 's'}` : ''}. Members install it with <span className="mono">baton skills pull</span>.
        </p>
      )}
      <div className="prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={safeUrl}
          components={{
            a({ href, children }) {
              if (href?.startsWith('wiki:')) {
                const target = decodeURIComponent(href.slice(5));
                const hit = resolveWiki(target, items);
                return (
                  <a className={`wikilink ${hit ? '' : 'missing'}`} onClick={() => hit && go({ view: 'notes', page: hit.path })} title={hit ? hit.path : 'No page with that name yet'}>
                    {children}
                  </a>
                );
              }
              return (
                <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href); }}>
                  {children}
                </a>
              );
            },
          }}
        >
          {withWikilinks(p.body)}
        </ReactMarkdown>
      </div>
      <Comments target={p.path} comments={p.comments} canComment={overview?.role !== 'viewer'} cfgKey={cfg.userKey} />
    </motion.article>
  );
}

export function Comments({ target, comments, canComment }: { target: string; comments: Page['comments']; canComment: boolean; cfgKey?: string }) {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/comment`, { target, text });
      setText('');
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  return (
    <section className="comments">
      <h2 className="section-title">Comments {comments.length ? <span className="faint">{comments.length}</span> : null}</h2>
      {comments.map((c, i) => (
        <div key={`${c.at}-${i}`} className="comment">
          <Avatar label={c.by_name} bot={c.by_name.includes("'s ")} />
          <div>
            <div className="row" style={{ gap: 6 }}>
              <b style={{ fontWeight: 500 }}>{c.by_name}</b>
              <span className="faint" style={{ fontSize: 12 }}>{ago(c.at)}</span>
            </div>
            <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
          </div>
        </div>
      ))}
      {canComment && (
        <form onSubmit={send} className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
          <textarea
            className="input grow"
            rows={2}
            placeholder="Add a comment or advice for the team and their Claudes…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send(e)}
          />
          <button className="btn" disabled={!text.trim()}>Comment</button>
        </form>
      )}
    </section>
  );
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-content': { padding: '14px 4px', caretColor: 'var(--accent)' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(43,89,195,0.04)' },
});

function PageEditor({ path, page, onDone }: { path: string; page?: Page; onDone: (savedPath?: string) => void }) {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(page?.title ?? path.split('/').pop() ?? '');
  const [summary, setSummary] = useState(page?.summary ?? '');
  const [body, setBody] = useState(page?.body ?? '');
  const [tags, setTags] = useState(page?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(page?.pinned ?? false);
  const [kind, setKind] = useState<'page' | 'decision'>(page?.kind === 'decision' ? 'decision' : 'page');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setError('');
    if (!summary.trim()) return setError('Add a one-line summary: it is what Claudes read first.');
    if (!body.trim()) return setError('The page is empty.');
    setSaving(true);
    try {
      const r = await call<{ message: string }>(cfg, 'PUT', `/api/projects/${slug}/page`, {
        path, title, summary, body, kind, pinned, tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      await qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(r.message);
      onDone(path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <motion.div className="doc" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16 } }}>
      <div className="doc-path">{path}{page ? ` · editing v${page.version}` : ' · new page'}</div>
      <input className="input" style={{ fontSize: 20, fontWeight: 600, height: 40, marginBottom: 10 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
      <Field label="Summary (one line, what other Claudes read first)">
        <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={240} placeholder="How selling works: prices, sell-all, the Finn NPC prompt" />
      </Field>
      <div className="row" style={{ gap: 12, marginBottom: 14, alignItems: 'flex-end' }}>
        <Field label="Tags" grow>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="economy, server" />
        </Field>
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'page' | 'decision')}>
            <option value="page">Page</option>
            <option value="decision">Decision (locked)</option>
          </select>
        </Field>
        <label className="row" style={{ height: 32, marginBottom: 14, gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin in every brief
        </label>
      </div>
      <div className="editor-wrap">
        <CodeMirror value={body} onChange={setBody} extensions={[markdown(), EditorView.lineWrapping, editorTheme]} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: true }} minHeight="360px" autoFocus={!!page} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'} <span className="kbd" style={{ background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,0.4)' }}>Ctrl S</span>
        </button>
        <button type="button" className="btn ghost" onClick={() => onDone()}>Cancel</button>
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>Markdown · [[links]] to other pages · secrets are refused</span>
      </div>
    </motion.div>
  );
}

function Field({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={`field ${grow ? 'grow' : ''}`}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}
