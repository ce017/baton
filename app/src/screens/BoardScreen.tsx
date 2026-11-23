import { DndContext, type DragEndEvent, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckSquare, Lock, MessageSquare, Pause, Plus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useEffect, useState } from 'react';
import { useApp } from '../main.tsx';
import { call, canEdit, type FeedRow, type LiveCard, type Task, type TaskStatus } from '../lib/api.ts';
import { ago, ownerName, presence } from '../lib/format.ts';
import { Avatar, EASE_IN, EASE_OUT, Skel, useToast } from '../ui.tsx';
import { Comments } from './PagesScreen.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const COLS: { status: TaskStatus; label: string; dot: string }[] = [
  { status: 'todo', label: 'To do', dot: 'var(--todo)' },
  { status: 'doing', label: 'In progress', dot: 'var(--done)' },
  { status: 'blocked', label: 'Waiting on someone', dot: 'var(--doing)' },
  { status: 'done', label: 'Done', dot: 'var(--ink-3)' },
];

const tone = (s: string) => {
  let h = 0;
  for (const ch of s.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `tone-${h % 6}`;
};

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
  const [activity, setActivity] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const key = ['p', slug, 'tasks'];
  const open = tasks.data?.find((t) => t.id === route.task);
  const sideOpen = !!open || activity;
  const now = overview?.now ?? Date.now();
  const me = cfg.user ?? '';
  const nameOf = (label: string) => (label === me ? 'You' : ownerName(label) === me && label.includes("'s ") ? 'Your Claude' : label);
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
    <div className="bwrap">
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
                <Avatar label={c.label} bot={c.isAgent} size="sm" />
                <b>{nameOf(c.label)}</b>
                <span className="s">{stopped ? `Stopped ${ago(c.lastSeen, now)}` : c.doing || (c.lastReply ? 'Idle' : 'No task yet')}</span>
                {stopped && stoppedTask && helpers[0] && c.id === stoppedMine?.id && (
                  <button type="button" className="linkbtn" onClick={() => go({ view: 'board', task: stoppedTask.id })}>Hand over</button>
                )}
              </div>
            );
          })
        ) : (
          <span className="faint">No Claude has checked in yet. Connect one under Team.</span>
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
        <span className="grow" />
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
            <Column key={c.status} col={c} tasks={(tasks.data ?? []).filter((t) => t.status === c.status)} loading={tasks.isLoading} editable={editable} selected={route.task} onOpen={(id) => { setActivity(false); go({ view: 'board', task: id }); }} adding={c.status === 'todo' && adding} onAdded={() => setAdding(false)} agentFor={agentFor} now={now} nameOf={nameOf} />
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
        {t.area && <span className={`lbl ${tone(t.area)}`}>{t.area.length > 22 ? `${t.area.slice(0, 21)}…` : t.area}</span>}
        {list.length > 0 && <span className="row" style={{ gap: 4 }}><CheckSquare size={12} />{done}/{list.length}</span>}
        {t.comments.length > 0 && <span className="row" style={{ gap: 4 }}><MessageSquare size={12} />{t.comments.length}</span>}
        <span className="r">{t.assignee ? <Avatar label={t.assignee} bot={/claude/i.test(t.assignee)} size="sm" /> : null}</span>
      </div>
      {working && <div className="cstat ok"><span className="dot live" />{nameOf(agent.label)} is working on this</div>}
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
  const [area, setArea] = useState(task.area);
  useEffect(() => { setTitle(task.title); setAssignee(task.assignee); setArea(task.area); }, [task]);
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
        <select className="input" style={{ width: 'auto', height: 30 }} value={task.status} disabled={!editable} onChange={(e) => save({ status: e.target.value as TaskStatus })}>
          {COLS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
        </select>
        <span className="k">Assigned to</span>
        <span>
          <input className="input" style={{ height: 30 }} list="bt-people" value={assignee} disabled={!editable} onChange={(e) => setAssignee(e.target.value)} onBlur={() => assignee !== task.assignee && save({ assignee })} placeholder="Nobody yet" />
          <datalist id="bt-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
        </span>
        <span className="k">Label</span>
        <input className="input" style={{ height: 30 }} value={area} disabled={!editable} onChange={(e) => setArea(e.target.value)} onBlur={() => area !== task.area && save({ area })} placeholder="e.g. Selling" />
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
      <p className="faint" style={{ fontSize: 12, marginTop: 14 }}>Added by {task.created_by_name} · last change by {task.updated_by_name}, {ago(task.updated_at)}</p>
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
            <Avatar label={r.label} bot={r.label.includes("'s ")} size="sm" />
            <div style={{ minWidth: 0 }}>
              <div style={{ lineHeight: 1.4 }}><b style={{ fontWeight: 600 }}>{r.label}</b> <span className="muted">{r.text}</span></div>
              <div className="faint" style={{ fontSize: 11.5 }}>{ago(r.at, now)}</div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {feed.data && !feed.data.length && <div className="empty">Nothing has happened yet.</div>}
    </div>
  );
}
