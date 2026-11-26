import { DndContext, type DragEndEvent, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { Select } from '../Select.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckSquare, Lock, MessageSquare, Pause, Plus, X, Image as ImageIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useEffect, useState, useMemo, useRef } from 'react';
import { useApp } from '../main.tsx';
import { call, canEdit, type FeedRow, type LiveCard, type Task, type TaskStatus } from '../lib/api.ts';
import { ago, ownerName, yourLabel, presence } from '../lib/format.ts';
import { Avatar, EASE_IN, EASE_OUT, Skel, useToast, PersonName } from '../ui.tsx';
import { Comments } from './PagesScreen.tsx';
import { WakeButton } from './Waker.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const COLS: { status: TaskStatus; label: string; dot: string }[] = [
  { status: 'todo', label: 'To do', dot: 'var(--todo)' },
  { status: 'doing', label: 'In progress', dot: 'var(--done)' },
  { status: 'blocked', label: 'Waiting on someone', dot: 'var(--doing)' },
  { status: 'done', label: 'Done', dot: 'var(--ink-3)' },
];

/** Colours people picked for tags in this project (set by BoardScreen from the overview). */
let PICKED: Record<string, number> = {};
const TAG_COLORS = ['Green', 'Yellow', 'Orange', 'Red', 'Purple', 'Blue', 'Sky', 'Lime', 'Pink', 'Grey'];

/** A tag's colour: the one picked for it, or a steady one from its name (10 Trello-like colours). */
const tone = (s: string) => {
  const picked = PICKED[s.trim().toLowerCase()];
  if (picked !== undefined) return `tone-${picked}`;
  let h = 2166136261;
  for (const ch of s.trim().toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return `tone-${(h >>> 0) % 10}`;
};

/** Board backgrounds anyone can pick; owners and admins can also upload an image. */
const BG_PRESETS: Record<string, string> = {
  dusk: 'linear-gradient(135deg, #2b1f4a 0%, #6b3a6e 45%, #d4795a 100%)',
  ocean: 'linear-gradient(135deg, #0b2a4a 0%, #13618a 55%, #2fb3c4 100%)',
  forest: 'linear-gradient(135deg, #102a1e 0%, #1f5a3c 55%, #6fa35a 100%)',
  ember: 'linear-gradient(135deg, #2a0f0a 0%, #8a2b16 50%, #e0a63a 100%)',
  slate: 'linear-gradient(135deg, #1c2230 0%, #39445a 60%, #6b7a94 100%)',
  aurora: 'linear-gradient(135deg, #0d1b2a 0%, #1b4d5c 40%, #4b9f7a 70%, #b3d36b 100%)',
  blush: 'linear-gradient(135deg, #f5d0c5 0%, #e7a6b8 50%, #b48cc8 100%)',
  sky: 'linear-gradient(180deg, #8ec5fc 0%, #e0c3fc 100%)',
};

/** The board background as CSS, with the image fetched only when it changed. */
function useBoardBackground(): string {
  const { slug, overview } = useProject();
  const bg = overview?.background;
  const img = useProjectQuery<{ data: string }>(['background', String(bg?.at ?? 0)], `/api/projects/${slug}/background`, bg?.kind === 'image');
  if (bg?.kind === 'preset') return BG_PRESETS[bg.preset] ?? '';
  if (bg?.kind === 'image' && img.data?.data) return `center / cover no-repeat url("${img.data.data}")`;
  return '';
}

/** Shrinks an image to at most 1920 px wide JPEG so it stays light for everyone. */
async function shrinkBackground(file: File): Promise<string> {
  if (file.size > 25_000_000) throw new Error('That file is too big.');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 1_350_000) return url;
  }
  throw new Error("Couldn't make that image small enough.");
}

function BackgroundPicker() {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const cur = overview?.background;
  async function set(body: { preset?: string; data?: string }) {
    setBusy(true);
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/background`, body);
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="btn ghost" onClick={() => setOpen((v) => !v)}><ImageIcon size={14} /> Background</button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="bgpop">
            <div className="faint" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Board background · everyone sees it</div>
            <div className="bgswatches">
              <button type="button" className={`bgsw none ${!cur?.kind ? 'on' : ''}`} onClick={() => set({ preset: 'none' })} aria-label="No background">None</button>
              {Object.entries(BG_PRESETS).map(([id, css]) => (
                <button key={id} type="button" className={`bgsw ${cur?.kind === 'preset' && cur.preset === id ? 'on' : ''}`} style={{ background: css }} onClick={() => set({ preset: id })} aria-label={`${id} background`} title={id} />
              ))}
            </div>
            <button type="button" className="btn sm" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} disabled={busy} onClick={() => file.current?.click()}>
              {busy ? 'Uploading…' : cur?.kind === 'image' ? 'Change image' : 'Upload an image'}
            </button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                await set({ data: await shrinkBackground(f) });
              } catch (err) {
                toast((err as Error).message, false);
              }
            }} />
          </div>
        </>
      )}
    </span>
  );
}

/** A to-do's tags live in its area, comma separated ("UI, World"). */
export const tagsOf = (area: string) => area.split(',').map((t) => t.trim()).filter(Boolean);
const joinTags = (tags: string[]) => tags.join(', ').slice(0, 120);

/** Every tag used in the project, most used first: the saved list you pick from. */
function useAllTags(tasks?: Task[]) {
  return useMemo(() => {
    const count = new Map<string, { name: string; n: number }>();
    for (const t of tasks ?? []) for (const tag of tagsOf(t.area)) {
      const k = tag.toLowerCase();
      const cur = count.get(k);
      count.set(k, { name: cur?.name ?? tag, n: (cur?.n ?? 0) + 1 });
    }
    return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [tasks]);
}

/** Trello-style tags: chips you can remove, and a list of the project's tags to add (or a new one). */
function TagPicker({ value, all, disabled, onChange }: { value: string[]; all: { name: string; n: number }[]; disabled?: boolean; onChange: (tags: string[]) => void }) {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [paint, setPaint] = useState<string | null>(null);
  async function setColor(tag: string, color: number) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tag-color`, { tag, color });
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    }
    setPaint(null);
  }
  const [q, setQ] = useState('');
  const has = (t: string) => value.some((v) => v.toLowerCase() === t.toLowerCase());
  const shown = all.filter((t) => !has(t.name) && t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const canCreate = !!q.trim() && !all.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) && !has(q.trim());
  const add = (t: string) => {
    onChange([...value, t.trim().slice(0, 30)]);
    setQ('');
  };
  return (
    <span className="tagpick">
      {value.map((t) => (
        <span key={t} className="tagchip">
          <span className={`lbl ${tone(t)}`}>
            {disabled ? t : <button type="button" className="lbl-name" title="Change colour" onClick={() => setPaint(paint === t ? null : t)}>{t}</button>}
            {!disabled && <button type="button" className="lbl-x" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((v) => v !== t))}>×</button>}
          </span>
          {paint === t && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setPaint(null)} />
              <div className="tagpaint" role="dialog" aria-label={`Colour for ${t}`}>
                <div className="faint" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>Colour for "{t}" · everywhere</div>
                <div className="tagpaint-grid">
                  {TAG_COLORS.map((name, i) => (
                    <button key={name} type="button" className={`tagpaint-sw tone-${i} ${tone(t) === `tone-${i}` ? 'on' : ''}`} title={name} aria-label={name} onClick={() => setColor(t, i)} />
                  ))}
                </div>
                <button type="button" className="btn ghost sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setColor(t, -1)}>Automatic</button>
              </div>
            </>
          )}
        </span>
      ))}
      {!disabled && (
        <span className="tagpick-add">
          <button type="button" className="btn ghost sm" onClick={() => setOpen((v) => !v)}><Plus size={12} /> Tag</button>
          {open && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => { setOpen(false); setQ(''); }} />
              <div className="tagpop">
                <input
                  className="input"
                  autoFocus
                  value={q}
                  maxLength={30}
                  placeholder="Find or make a tag"
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const first = shown[0]?.name ?? (canCreate ? q.trim() : '');
                      if (first) add(first);
                    }
                    if (e.key === 'Escape') setOpen(false);
                  }}
                />
                <div className="tagpop-list">
                  {shown.slice(0, 30).map((t) => (
                    <button key={t.name} type="button" className="tagpop-opt" onClick={() => add(t.name)}>
                      <span className={`lbl ${tone(t.name)}`}>{t.name}</span>
                      <span className="faint">{t.n}</span>
                    </button>
                  ))}
                  {canCreate && (
                    <button type="button" className="tagpop-opt" onClick={() => add(q)}>
                      <span className="row" style={{ gap: 6 }}><Plus size={12} /> Make <span className={`lbl ${tone(q.trim())}`}>{q.trim()}</span></span>
                    </button>
                  )}
                  {!shown.length && !canCreate && <div className="faint" style={{ padding: '6px 8px', fontSize: 12 }}>{all.length ? 'No other tags' : 'Type to make the first tag'}</div>}
                </div>
              </div>
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** "- [ ] item" lines in a to-do's notes are its checklist. */
function checklist(notes: string) {
  const items: { text: string; done: boolean; line: number }[] = [];
  notes.split('\n').forEach((l, i) => {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(l);
    if (m?.[2] !== undefined) items.push({ text: m[2], done: m[1] !== ' ', line: i });
  });
  return items;
}

/** A Claude counts as stopped when it has a task but hasn't been heard from for 10 minutes. */
const isStopped = (c: LiveCard, now: number) => !!c.doing && now - c.lastSeen > 10 * 60_000;

export function BoardScreen() {
  const { cfg } = useApp();
  const { slug, overview, route, go } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const tasks = useProjectQuery<Task[]>(['tasks'], `/api/projects/${slug}/tasks`);
  const editable = canEdit(overview?.role);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  PICKED = overview?.tagColors ?? {};
  const boardBg = useBoardBackground();
  const allTags = useAllTags(tasks.data);
  const inGroup = (t: Task) => !tagFilter || tagsOf(t.area).some((x) => x.toLowerCase() === tagFilter.toLowerCase());
  const [activity, setActivity] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const key = ['p', slug, 'tasks'];
  const open = tasks.data?.find((t) => t.id === route.task);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setMenu((e as CustomEvent<{ id: string; x: number; y: number }>).detail);
    window.addEventListener('baton:taskmenu', on);
    return () => window.removeEventListener('baton:taskmenu', on);
  }, []);
  const menuTask = menu ? tasks.data?.find((t) => t.id === menu.id) : undefined;
  const sideOpen = !!open || activity;
  const now = overview?.now ?? Date.now();
  const me = cfg.user ?? '';
  const nameOf = (label: string) => (label === me ? 'You' : ownerName(label) === me && label.includes("'s ") ? yourLabel(label) : label);
  const live = (overview?.live ?? []).filter((c) => c.isAgent || c.doing).sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || b.lastSeen - a.lastSeen);
  const agentFor = (assignee: string) => overview?.live.find((c) => c.isAgent && c.label.toLowerCase() === assignee.trim().toLowerCase());
  const helpers = (overview?.live ?? []).filter((c) => c.isAgent && ownerName(c.label) !== me);

  async function move(id: string, status: TaskStatus) {
    const before = qc.getQueryData<Task[]>(key);
    const t = before?.find((x) => x.id === id);
    if (!t || t.status === status) return;
    qc.setQueryData<Task[]>(key, (old) => old?.map((x) => (x.id === id ? { ...x, status } : x))); // shows at once; server confirms after
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'update', id, status });
    } catch (err) {
      qc.setQueryData(key, before);
      toast((err as Error).message, false);
    }
  }

  async function handOver(task: Task, from: LiveCard | undefined, to: LiveCard) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'update', id: task.id, assignee: to.label, status: 'doing' });
      const where = from?.lastReply ? ` Where it stopped: "${from.lastReply.slice(0, 300)}"` : from?.next ? ` Next step: ${from.next}` : '';
      await call(cfg, 'POST', `/api/projects/${slug}/post`, { to: ownerName(to.label), kind: 'handoff', text: `Please take over "${task.title}".${where}`, ref: task.id });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(`Handed over to ${to.label}`);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  const stoppedMine = live.find((c) => c.isAgent && isStopped(c, now));
  const stoppedTask = stoppedMine ? tasks.data?.find((t) => t.assignee.toLowerCase() === stoppedMine.label.toLowerCase() && t.status !== 'done') : undefined;

  return (
    <div className={`bwrap ${boardBg ? 'has-bg' : ''}`} style={boardBg ? { background: boardBg } : undefined}>
      {menu && menuTask && <TaskMenu at={menu} task={menuTask} onClose={() => setMenu(null)} onOpen={(id) => { setActivity(false); go({ view: 'board', task: id }); }} />}
      <div className="strip">
        <span className="k">Right now</span>
        {!overview ? (
          <Skel w={260} h={28} r={8} />
        ) : live.length ? (
          live.map((c) => {
            const stopped = c.isAgent && isStopped(c, now);
            const p = presence(c.lastSeen, now);
            return (
              <div key={c.id} className={`now ${stopped ? 'stopped' : ''}`}>
                <span className={`dot ${stopped ? 'idle' : p === 'live' ? 'live' : 'away'}`} />
                <Avatar label={c.label} bot={c.isAgent} size="sm" card />
                <b>{nameOf(c.label) === c.label ? <PersonName label={c.label} /> : nameOf(c.label)}</b>
                <span className="s">{stopped ? `Stopped ${ago(c.lastSeen, now)}` : c.doing || (c.lastReply ? 'Idle' : 'No task yet')}</span>
                {stopped && stoppedTask && helpers[0] && c.id === stoppedMine?.id && (
                  <button type="button" className="linkbtn" onClick={() => go({ view: 'board', task: stoppedTask.id })}>Hand over</button>
                )}
              </div>
            );
          })
        ) : (
          <span className="faint">No Claude has checked in yet. Connect yours in Settings (account menu, top right).</span>
        )}
      </div>
      {(overview?.locks ?? []).slice(0, 2).map((l) => (
        <div key={l.area} className="lockbar">
          <Lock size={14} />
          <span>
            <b>{nameOf(l.label)}</b> {nameOf(l.label) === 'You' ? 'are' : 'is'} editing <b>{l.area}</b>. Please don't change it until it's done.
          </span>
        </div>
      ))}
      <div className="bhead">
        {allTags.length > 0 && (
          <div className="tagfilter">
            <button type="button" className={`tf ${!tagFilter ? 'on' : ''}`} onClick={() => setTagFilter('')}>All</button>
            {allTags.slice(0, 12).map((t) => (
              <button key={t.name} type="button" className={`tf ${tagFilter.toLowerCase() === t.name.toLowerCase() ? 'on' : ''}`} onClick={() => setTagFilter(tagFilter.toLowerCase() === t.name.toLowerCase() ? '' : t.name)}>
                <span className={`tfdot lbl ${tone(t.name)}`} />{t.name}<span className="faint">{t.n}</span>
              </button>
            ))}
          </div>
        )}
        <span className="grow" />
        {(overview?.role === 'owner' || overview?.role === 'admin') && <BackgroundPicker />}
        <button type="button" className={`btn ${activity && !open ? '' : 'ghost'}`} onClick={() => { go({ view: 'board' }); setActivity((v) => !v); }}>
          <Activity size={14} /> Activity
        </button>
        {editable && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> New to-do</button>
        )}
      </div>

      <DndContext sensors={sensors} onDragStart={(e) => setDragging(tasks.data?.find((t) => t.id === e.active.id) ?? null)} onDragEnd={(e: DragEndEvent) => { setDragging(null); if (e.over) move(String(e.active.id), e.over.id as TaskStatus); }} onDragCancel={() => setDragging(null)}>
        <div className={`cols ${sideOpen ? 'side-open' : ''}`}>
          {COLS.map((c) => (
            <Column key={c.status} col={c} tasks={(tasks.data ?? []).filter((t) => t.status === c.status && inGroup(t))} loading={tasks.isLoading} editable={editable} selected={route.task} onOpen={(id) => { setActivity(false); go({ view: 'board', task: id }); }} adding={c.status === 'todo' && adding} onAdded={() => setAdding(false)} agentFor={agentFor} now={now} nameOf={nameOf} />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
          {dragging && (
            <motion.div initial={{ rotate: 0 }} animate={{ rotate: 1.5, scale: 1.02 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
              <Card task={dragging} agent={agentFor(dragging.assignee)} now={now} nameOf={nameOf} dragging />
            </motion.div>
          )}
        </DragOverlay>
      </DndContext>

      <AnimatePresence>
        {sideOpen && (
          <motion.aside
            className="side"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1, transition: { duration: 0.24, ease: EASE_OUT } }}
            exit={{ x: 24, opacity: 0, transition: { duration: 0.12, ease: EASE_IN } }}
          >
            <div className="side-h">
              {open ? <><span className="dot" style={{ background: COLS.find((c) => c.status === open.status)?.dot }} />{COLS.find((c) => c.status === open.status)?.label}</> : 'Activity'}
              <button type="button" className="btn ghost icon" style={{ marginLeft: 'auto' }} onClick={() => { setActivity(false); go({ view: 'board' }); }} aria-label="Close"><X size={15} /></button>
            </div>
            <div className="side-b">
              {open ? <TaskPanel key={open.id} task={open} agent={agentFor(open.assignee)} helpers={helpers} onHandOver={handOver} nameOf={nameOf} /> : <ActivityList />}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

interface ColProps {
  col: (typeof COLS)[number];
  tasks: Task[];
  loading: boolean;
  editable: boolean;
  selected?: string;
  onOpen: (id: string) => void;
  adding: boolean;
  onAdded: () => void;
  agentFor: (a: string) => LiveCard | undefined;
  now: number;
  nameOf: (l: string) => string;
}

function Column({ col, tasks, loading, editable, selected, onOpen, adding, onAdded, agentFor, now, nameOf }: ColProps) {
  const { setNodeRef, isOver } = useDroppable({ id: col.status, disabled: !editable });
  return (
    <section ref={setNodeRef} className={`col2 ${isOver ? 'over' : ''}`} aria-label={col.label}>
      <div className="col2-h"><span className="dot" style={{ background: col.dot }} />{col.label}<span className="n">{tasks.length}</span></div>
      <div className="col2-body">
        {adding && <AddTask onDone={onAdded} />}
        {loading
          ? [0, 1].map((i) => <div key={i} className="tcard2"><Skel h={11} style={{ marginBottom: 8 }} /><Skel w="55%" h={9} /></div>)
          : tasks.map((t, i) => <DragCard key={t.id} task={t} editable={editable} selected={selected === t.id} onOpen={onOpen} index={i} agent={agentFor(t.assignee)} now={now} nameOf={nameOf} />)}
      </div>
    </section>
  );
}

function DragCard({ task, editable, selected, onOpen, index, agent, now, nameOf }: { task: Task; editable: boolean; selected: boolean; onOpen: (id: string) => void; index: number; agent?: LiveCard; now: number; nameOf: (l: string) => string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: !editable });
  return (
    <motion.div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: isDragging ? 0.35 : 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT, delay: index < 8 ? index * 0.03 : 0 } }}
      onClick={() => onOpen(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('baton:taskmenu', { detail: { id: task.id, x: e.clientX, y: e.clientY } }));
      }}
    >
      <Card task={task} agent={agent} now={now} nameOf={nameOf} selected={selected} />
    </motion.div>
  );
}

function Card({ task: t, agent, now, nameOf, selected, dragging }: { task: Task; agent?: LiveCard; now: number; nameOf: (l: string) => string; selected?: boolean; dragging?: boolean }) {
  const list = checklist(t.notes);
  const done = list.filter((i) => i.done).length;
  const working = agent && t.status === 'doing' && presence(agent.lastSeen, now) === 'live';
  const stopped = agent && t.status === 'doing' && isStopped(agent, now);
  return (
    <div className={`tcard2 ${selected ? 'sel' : ''} ${dragging ? 'dragging' : ''} ${t.status === 'done' ? 'isdone' : ''}`}>
      <div className="t">{t.title}</div>
      <div className="meta2">
        {tagsOf(t.area).slice(0, 3).map((tag) => <span key={tag} className={`lbl ${tone(tag)}`}>{tag.length > 18 ? `${tag.slice(0, 17)}…` : tag}</span>)}
        {tagsOf(t.area).length > 3 && <span className="faint" style={{ fontSize: 11.5 }}>+{tagsOf(t.area).length - 3}</span>}
        {list.length > 0 && <span className="row" style={{ gap: 4 }}><CheckSquare size={12} />{done}/{list.length}</span>}
        {t.comments.length > 0 && <span className="row" style={{ gap: 4 }}><MessageSquare size={12} />{t.comments.length}</span>}
        <span className="r">{t.assignee ? <Avatar label={t.assignee} bot={/claude/i.test(t.assignee)} size="sm" /> : null}</span>
      </div>
      {working && <div className="cstat ok"><span className="dot live" />{nameOf(agent.label) === agent.label ? <PersonName label={agent.label} card={false} /> : nameOf(agent.label)} is working on this</div>}
      {stopped && <div className="cstat warn"><Pause size={12} />Stopped {ago(agent.lastSeen, now)}</div>}
    </div>
  );
}

function AddTask({ onDone }: { onDone: () => void }) {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return onDone();
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'add', title });
      setTitle('');
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  return (
    <form onSubmit={submit}>
      <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} onBlur={() => !title && onDone()} placeholder="What needs doing? Enter to add" />
    </form>
  );
}

function TaskPanel({ task, agent, helpers, onHandOver, nameOf }: { task: Task; agent?: LiveCard; helpers: LiveCard[]; onHandOver: (t: Task, from: LiveCard | undefined, to: LiveCard) => void; nameOf: (l: string) => string }) {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = canEdit(overview?.role);
  const [title, setTitle] = useState(task.title);
  const [assignee, setAssignee] = useState(task.assignee);
  useEffect(() => { setTitle(task.title); setAssignee(task.assignee); }, [task]);
  const allTasks = useProjectQuery<Task[]>(['tasks'], `/api/projects/${slug}/tasks`);
  const allTags = useAllTags(allTasks.data);
  const now = overview?.now ?? Date.now();
  const list = checklist(task.notes);
  const description = task.notes.split('\n').filter((l) => !/^\s*[-*]\s+\[( |x|X)\]/.test(l)).join('\n').trim();
  const people = overview ? [...overview.members.map((m) => m.name), ...overview.live.filter((c) => c.isAgent).map((c) => c.label)] : [];

  async function save(patch: Partial<Pick<Task, 'title' | 'assignee' | 'area' | 'notes' | 'status'>>) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'update', id: task.id, ...patch });
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  function toggle(line: number) {
    if (!editable) return;
    const lines = task.notes.split('\n');
    const l = lines[line] ?? '';
    lines[line] = /\[( )\]/.test(l) ? l.replace('[ ]', '[x]') : l.replace(/\[(x|X)\]/, '[ ]');
    save({ notes: lines.join('\n') });
  }

  const stopped = agent && isStopped(agent, now);
  const working = agent && presence(agent.lastSeen, now) === 'live';
  const done = list.filter((i) => i.done).length;

  return (
    <>
      <textarea className="input" rows={2} style={{ fontSize: 17, fontWeight: 600, marginBottom: 14, resize: 'none' }} value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== task.title && save({ title })} />
      <div className="kv">
        <span className="k">Status</span>
        <Select style={{ width: 'auto', height: 30 }} value={task.status} disabled={!editable} onChange={(e) => save({ status: e.target.value as TaskStatus })}>
          {COLS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
        </Select>
        <span className="k">Assigned to</span>
        <span>
          <input className="input" style={{ height: 30 }} list="bt-people" value={assignee} disabled={!editable} onChange={(e) => setAssignee(e.target.value)} onBlur={() => assignee !== task.assignee && save({ assignee })} placeholder="Nobody yet" />
          <datalist id="bt-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
        </span>
        <span className="k">Tags</span>
        <TagPicker value={tagsOf(task.area)} all={allTags} disabled={!editable} onChange={(tags) => save({ area: joinTags(tags) })} />
      </div>

      {agent && (agent.doing || agent.lastReply) && task.status !== 'done' && (
        <div className={`leftoff ${stopped ? '' : 'ok'}`}>
          <div className="h">{stopped ? <><Pause size={14} />Stopped {ago(agent.lastSeen, now)}</> : working ? <><span className="dot live" />{nameOf(agent.label)} is working on it</> : <>Last seen {ago(agent.lastSeen, now)}</>}</div>
          {agent.lastReply && <p>Its last words: "{agent.lastReply.length > 260 ? `${agent.lastReply.slice(0, 259)}…` : agent.lastReply}"</p>}
          {agent.next && <p style={{ marginTop: -4 }}>Next step: {agent.next}</p>}
          {editable && stopped && helpers.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {helpers.slice(0, 2).map((h) => <button key={h.id} type="button" className="btn primary" onClick={() => onHandOver(task, agent, h)}>Hand over to {h.label}</button>)}
            </div>
          )}
          {editable && stopped && <WakeButton owner={ownerName(agent.label)} task={task} />}
        </div>
      )}

      {list.length > 0 && (
        <>
          <div className="seck">Checklist · {done} of {list.length}</div>
          <div className="prog"><i style={{ width: `${(done / list.length) * 100}%` }} /></div>
          {list.map((i) => (
            <div key={i.line} className={`chk ${i.done ? 'on' : ''}`} onClick={() => toggle(i.line)}><span className="b" /><span>{i.text}</span></div>
          ))}
        </>
      )}
      {description && (
        <>
          <div className="seck">Details</div>
          <div className="muted selectable" style={{ whiteSpace: 'pre-wrap' }}>{description}</div>
        </>
      )}
      <Comments target={task.id} comments={task.comments} canComment={overview?.role !== 'viewer'} />
      {(overview?.role === 'owner' || overview?.role === 'admin') && <DeleteTask task={task} />}
      <p className="faint" style={{ fontSize: 12, marginTop: 14 }}>Added by <PersonName label={task.created_by_name} /> · last change by <PersonName label={task.updated_by_name} />, {ago(task.updated_at)}</p>
    </>
  );
}

function ActivityList() {
  const { slug, overview } = useProject();
  const feed = useProjectQuery<FeedRow[]>(['feed'], `/api/projects/${slug}/feed?limit=60`);
  const now = overview?.now ?? Date.now();
  if (feed.isLoading) return <><Skel h={10} style={{ marginBottom: 12 }} /><Skel w="70%" h={10} /></>;
  return (
    <div>
      <AnimatePresence initial={false}>
        {(feed.data ?? []).slice(0, 50).map((r) => (
          <motion.div key={r.seq} layout="position" className="row" style={{ alignItems: 'flex-start', gap: 10, padding: '7px 0' }} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } }}>
            <Avatar label={r.label} bot={r.label.includes("'s ")} size="sm" card />
            <div style={{ minWidth: 0 }}>
              <div style={{ lineHeight: 1.4 }}><b style={{ fontWeight: 600 }}><PersonName label={r.label} /></b> <span className="muted">{r.text}</span></div>
              <div className="faint" style={{ fontSize: 11.5 }}>{ago(r.at, now)}</div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {feed.data && !feed.data.length && <div className="empty">Nothing has happened yet.</div>}
    </div>
  );
}

/** Right-click on a to-do: open, move, take it, delete. */
function TaskMenu({ at, task, onClose, onOpen }: { at: { x: number; y: number }; task: Task; onClose: () => void; onOpen: (id: string) => void }) {
  const { cfg } = useApp();
  const { slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [sure, setSure] = useState(false);
  const role = overview?.role;
  const admin = role === 'owner' || role === 'admin';
  const me = cfg.user ?? '';
  const mineLabel = `${me}'s ${cfg.agentName ?? 'Claude'}`;
  const act = async (body: Record<string, unknown>, done: string) => {
    onClose();
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { id: task.id, ...body });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(done);
    } catch (err) {
      toast((err as Error).message, false);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const x = Math.min(at.x, window.innerWidth - 220);
  const y = Math.min(at.y, window.innerHeight - 330);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 69 }} onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <motion.div className="ctxmenu" style={{ left: x, top: y }} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1, transition: { duration: 0.12, ease: EASE_OUT } }}>
        <button type="button" className="menu-item" onClick={() => { onClose(); onOpen(task.id); }}>Open</button>
        <div className="lbl2">Move to</div>
        {COLS.map((c) => (
          <button key={c.status} type="button" className="menu-item" disabled={c.status === task.status} onClick={() => act({ action: 'update', status: c.status }, `Moved to ${c.label}`)}>
            {c.label}
          </button>
        ))}
        <div className="sep" />
        <button type="button" className="menu-item" onClick={() => act({ action: 'update', assignee: me }, 'Assigned to you')}>Assign to me</button>
        {cfg.agentKey && <button type="button" className="menu-item" onClick={() => act({ action: 'update', assignee: mineLabel }, 'Given to your Claude')}>Give to my Claude</button>}
        <button type="button" className="menu-item" onClick={() => { onClose(); navigator.clipboard.writeText(task.id).catch(() => {}); toast(`Copied ${task.id}`); }}>Copy id ({task.id})</button>
        {admin && (
          <>
            <div className="sep" />
            <button type="button" className="menu-item danger" onClick={() => (sure ? act({ action: 'delete' }, `Deleted ${task.id}`) : setSure(true))}>
              {sure ? 'Click again to delete' : 'Delete'}
            </button>
          </>
        )}
      </motion.div>
    </>
  );
}

function DeleteTask({ task }: { task: Task }) {
  const { cfg } = useApp();
  const { slug, go } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [sure, setSure] = useState(false);
  async function del() {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'delete', id: task.id });
      go({ view: 'board' });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(`Deleted ${task.id}`);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }
  return (
    <div className="row" style={{ marginTop: 18 }}>
      {sure ? (
        <>
          <span className="muted grow" style={{ fontSize: 12.5 }}>Delete {task.id} and its comments for everyone?</span>
          <button type="button" className="btn ghost sm" onClick={() => setSure(false)}>Cancel</button>
          <button type="button" className="btn sm danger-solid" onClick={del}>Delete</button>
        </>
      ) : (
        <button type="button" className="btn ghost sm danger" onClick={() => setSure(true)}>Delete to-do</button>
      )}
    </div>
  );
}
