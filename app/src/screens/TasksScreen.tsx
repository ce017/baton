import { DndContext, type DragEndEvent, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useEffect, useState } from 'react';
import { call, canEdit, type Task, type TaskStatus } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Avatar, Drawer, EASE_OUT, Skel, STATUS_LABEL, StatusChip, useToast } from '../ui.tsx';
import { Comments } from './PagesScreen.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const COLUMNS: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

export function TasksScreen() {
  const { cfg, slug, overview, route, go } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const tasks = useProjectQuery<Task[]>(['tasks'], `/api/projects/${slug}/tasks`);
  const editable = canEdit(overview?.role);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const key = ['p', slug, 'tasks'];
  const open = tasks.data?.find((t) => t.id === route.task);

  async function move(id: string, status: TaskStatus) {
    const before = qc.getQueryData<Task[]>(key);
    const t = before?.find((x) => x.id === id);
    if (!t || t.status === status) return;
    // Doherty: the card lands in its new column now; the server confirms after.
    qc.setQueryData<Task[]>(key, (old) => old?.map((x) => (x.id === id ? { ...x, status } : x)));
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'update', id, status });
    } catch (err) {
      qc.setQueryData(key, before);
      toast((err as Error).message, false);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const to = e.over?.id as TaskStatus | undefined;
    if (to) move(String(e.active.id), to);
  }

  return (
    <>
      <header className="topbar">
        <h1>Tasks</h1>
        <span className="faint">{editable ? 'Drag cards between columns. Claudes see this board in their brief.' : 'Read-only for your role.'}</span>
        <div className="grow" />
        {editable && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> New task
          </button>
        )}
      </header>
      <div className="content scroll">
        <DndContext sensors={sensors} onDragStart={(e) => setDragging(tasks.data?.find((t) => t.id === e.active.id) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="board">
            {COLUMNS.map((status) => (
              <Column key={status} status={status} tasks={(tasks.data ?? []).filter((t) => t.status === status)} loading={tasks.isLoading} editable={editable} onOpen={(id) => go({ view: 'tasks', task: id })} adding={status === 'todo' && adding} onAdded={() => setAdding(false)} />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {dragging && (
              <motion.div initial={{ rotate: 0, scale: 1 }} animate={{ rotate: 1.5, scale: 1.03 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <TaskCard task={dragging} overlay />
              </motion.div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
      <Drawer open={!!open} onClose={() => go({ view: 'tasks' })} title={open ? <span className="row"><span className="task-id">{open.id}</span><StatusChip status={open.status} /></span> : null}>
        {open && <TaskDetail key={open.id} task={open} editable={editable} />}
      </Drawer>
    </>
  );
}

function Column({ status, tasks, loading, editable, onOpen, adding, onAdded }: { status: TaskStatus; tasks: Task[]; loading: boolean; editable: boolean; onOpen: (id: string) => void; adding: boolean; onAdded: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !editable });
  return (
    <section ref={setNodeRef} className={`column ${isOver ? 'over' : ''}`} aria-label={STATUS_LABEL[status]}>
      <div className="column-head">
        <StatusChip status={status} />
        <span className="faint" style={{ fontWeight: 500 }}>{tasks.length}</span>
      </div>
      <div className="column-body scroll">
        {adding && <AddTask onDone={onAdded} />}
        {loading
          ? [0, 1].map((i) => (
              <div key={i} className="task">
                <Skel w={36} h={9} style={{ marginBottom: 8 }} />
                <Skel h={11} style={{ marginBottom: 6 }} />
                <Skel w="60%" h={9} />
              </div>
            ))
          : tasks.map((t, i) => <DraggableTask key={t.id} task={t} editable={editable} onOpen={onOpen} index={i} />)}
      </div>
    </section>
  );
}

function DraggableTask({ task, editable, onOpen, index }: { task: Task; editable: boolean; onOpen: (id: string) => void; index: number }) {
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
      <TaskCard task={task} />
    </motion.div>
  );
}

function TaskCard({ task: t, overlay }: { task: Task; overlay?: boolean }) {
  return (
    <div className={`task ${overlay ? 'dragging' : ''}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="task-id">{t.id}</span>
        <span className="grow" />
        {t.comments.length > 0 && <span className="faint" style={{ fontSize: 11 }}>{t.comments.length} comment{t.comments.length === 1 ? '' : 's'}</span>}
      </div>
      <div className="task-title">{t.title}</div>
      <div className="task-meta">
        {t.assignee && (
          <span className="row" style={{ gap: 4 }}>
            <Avatar label={t.assignee} bot={/claude/i.test(t.assignee)} size="sm" /> {t.assignee}
          </span>
        )}
        {t.area && <span className="mono truncate" style={{ fontSize: 11 }}>{t.area}</span>}
        <span className="grow" />
        <span>{ago(t.updated_at)}</span>
      </div>
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
    <motion.form onSubmit={submit} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_OUT } }}>
      <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} onBlur={() => !title && onDone()} placeholder="What needs doing? Enter to add" />
    </motion.form>
  );
}

function TaskDetail({ task, editable }: { task: Task; editable: boolean }) {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState({ title: task.title, assignee: task.assignee, area: task.area, notes: task.notes, status: task.status });
  useEffect(() => setDraft({ title: task.title, assignee: task.assignee, area: task.area, notes: task.notes, status: task.status }), [task]);
  const dirty = draft.title !== task.title || draft.assignee !== task.assignee || draft.area !== task.area || draft.notes !== task.notes || draft.status !== task.status;
  const people = overview ? [...overview.members.map((m) => m.name), ...overview.live.filter((c) => c.isAgent).map((c) => c.label)] : [];

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await call<{ message: string }>(cfg, 'POST', `/api/projects/${slug}/tasks`, { action: 'update', id: task.id, ...draft });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(r.message);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  return (
    <div>
    <form onSubmit={save}>
      <textarea className="input" rows={2} style={{ fontSize: 15, fontWeight: 600 }} value={draft.title} disabled={!editable} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <div className="row" style={{ gap: 10, margin: '12px 0' }}>
        <div className="grow">
          <span className="label">Status</span>
          <select className="input" value={draft.status} disabled={!editable} onChange={(e) => setDraft({ ...draft, status: e.target.value as TaskStatus })}>
            {COLUMNS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="grow">
          <span className="label">Assignee</span>
          <input className="input" list="people" value={draft.assignee} disabled={!editable} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} placeholder="boe or boe's Claude" />
          <datalist id="people">{people.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
      </div>
      <div className="field">
        <span className="label">Area</span>
        <input className="input mono" value={draft.area} disabled={!editable} onChange={(e) => setDraft({ ...draft, area: e.target.value })} placeholder="ServerScriptService.FishSellerService" />
      </div>
      <div className="field">
        <span className="label">Notes</span>
        <textarea className="input" rows={5} value={draft.notes} disabled={!editable} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Details, acceptance checks, links to pages…" />
      </div>
      {editable && (
        <button className="btn primary" disabled={!dirty}>Save changes</button>
      )}
      <p className="faint" style={{ fontSize: 12 }}>Created by {task.created_by_name} · last change by {task.updated_by_name}, {ago(task.updated_at)}</p>
    </form>
    <Comments target={task.id} comments={task.comments} canComment={overview?.role !== 'viewer'} />
    </div>
  );
}
