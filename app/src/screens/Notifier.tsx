import { Bell } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, isTauri, type Task, tauriInvoke } from '../lib/api.ts';
import { ownerName, yourLabel } from '../lib/format.ts';
import { EASE_IN, EASE_OUT } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

export interface NotifyPrefs {
  messages: boolean;
  stopped: boolean;
  todos: boolean;
  tray: boolean;
}
const KEY = 'baton.notify';
const DEFAULTS: NotifyPrefs = { messages: true, stopped: true, todos: true, tray: true };
const STOP_MS = 10 * 60_000; // same rule as the board: a Claude with a task and 10 min of silence

export function loadPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

function applyTray(on: boolean) {
  if (isTauri) tauriInvoke('set_close_to_tray', { on }).catch(() => {});
}

async function osNotify(title: string, body: string) {
  const n = await import('@tauri-apps/plugin-notification');
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === 'granted';
  if (ok) n.sendNotification({ title, body });
}

interface Notice {
  seq: number;
  from_label: string;
  kind: string;
  text: string;
}

/**
 * Watches the open project and tells you when something needs you: a message or question for you,
 * a Claude that stopped mid-task, or a to-do handed to you or your Claude. Windows notification when
 * Baton is in the background (or in the tray), a quiet toast when you're looking at it.
 */
export function Notifier() {
  const { cfg, slug, overview, go } = useProject();
  const tasks = useProjectQuery<Task[]>(['tasks'], `/api/projects/${slug}/tasks`);
  const [cards, setCards] = useState<{ id: number; title: string; body: string; view: 'messages' | 'board' }[]>([]);
  const seq = useRef(-1);
  const stopped = useRef<Set<string> | null>(null);
  const assigned = useRef<Map<string, string> | null>(null);
  const me = (cfg.user ?? '').toLowerCase();

  const notify = useCallback(
    (title: string, body: string, view: 'messages' | 'board' = 'board') => {
      const looking = document.visibilityState === 'visible' && document.hasFocus();
      if (isTauri && !looking) {
        osNotify(title, body).catch(() => {});
        return;
      }
      const id = Date.now() + Math.random();
      setCards((c) => [...c.slice(-2), { id, title, body, view }]);
      setTimeout(() => setCards((c) => c.filter((x) => x.id !== id)), 6000);
    },
    [],
  );

  useEffect(() => applyTray(loadPrefs().tray), []);
  useEffect(() => {
    seq.current = -1;
    stopped.current = null;
    assigned.current = null;
  }, [slug]);

  // Messages and questions for you (the server skips your own and your Claudes').
  useEffect(() => {
    if (!overview) return;
    let gone = false;
    call<{ top: number; messages: Notice[] }>(cfg, 'GET', `/api/projects/${slug}/notices?after=${seq.current}`)
      .then((r) => {
        if (gone) return;
        const first = seq.current < 0;
        seq.current = Math.max(seq.current, r.top, ...r.messages.map((m) => m.seq));
        if (first || !loadPrefs().messages) return;
        for (const m of r.messages.slice(-3)) {
          const who = ownerName(m.from_label) === me && m.from_label.includes("'s ") ? yourLabel(m.from_label) : m.from_label;
          notify(m.kind === 'question' ? `${who} asks` : m.kind === 'handoff' ? `${who} handed work over` : who, m.text, 'messages');
        }
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [overview, cfg, slug, me, notify]);

  // A Claude that went quiet in the middle of a task (usage limit, crash, PC off).
  useEffect(() => {
    if (!overview) return;
    const now = overview.now;
    const cur = new Set(overview.live.filter((c) => c.isAgent && c.doing && now - c.lastSeen > STOP_MS).map((c) => c.id));
    const prev = stopped.current;
    stopped.current = cur;
    if (!prev || !loadPrefs().stopped) return;
    for (const c of overview.live) {
      if (!cur.has(c.id) || prev.has(c.id)) continue;
      const name = ownerName(c.label) === me ? yourLabel(c.label) : c.label;
      notify(`${name} stopped`, c.doing ? `It was on: ${c.doing}` : 'It went quiet.');
    }
  }, [overview, me, notify]);

  // To-dos given to you or one of your Claudes by someone else.
  useEffect(() => {
    if (!tasks.data) return;
    const cur = new Map(tasks.data.map((t) => [t.id, t.assignee]));
    const prev = assigned.current;
    assigned.current = cur;
    if (!prev || !loadPrefs().todos) return;
    for (const t of tasks.data) {
      if (!t.assignee || ownerName(t.assignee) !== me || prev.get(t.id) === t.assignee) continue;
      if (ownerName(t.updated_by_name) === me) continue;
      notify(t.assignee.toLowerCase() === me ? 'New to-do for you' : `New to-do for ${yourLabel(t.assignee).replace(/^Your/, 'your')}`, t.title);
    }
  }, [tasks.data, me, notify]);

  return (
    <div className="notices" aria-live="polite">
      <AnimatePresence initial={false}>
        {cards.map((c) => (
          <motion.button
            type="button"
            key={c.id}
            className="notice"
            layout
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: EASE_OUT } }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.14, ease: EASE_IN } }}
            onClick={() => {
              go({ view: c.view });
              setCards((all) => all.filter((x) => x.id !== c.id));
            }}
          >
            <Bell size={15} />
            <span className="nb">
              <b>{c.title}</b>
              <span>{c.body}</span>
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Team screen rows: what this PC tells you about. */
export function NotifySettings() {
  const [p, setP] = useState(loadPrefs);
  const set = (k: keyof NotifyPrefs, v: boolean) => {
    const next = { ...p, [k]: v };
    setP(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    if (k === 'tray') applyTray(v);
  };
  const rows: { k: keyof NotifyPrefs; t: string; d: string }[] = [
    { k: 'messages', t: 'Messages and questions', d: 'When someone or their Claude writes to you or to everyone.' },
    { k: 'stopped', t: 'A Claude stops', d: 'When a Claude goes quiet in the middle of a to-do, so someone can take over.' },
    { k: 'todos', t: 'To-dos for you', d: 'When someone gives a to-do to you or one of your Claudes.' },
  ];
  if (isTauri) rows.push({ k: 'tray', t: 'Keep running in the tray', d: 'Closing the window keeps Baton in the tray, so notifications still arrive.' });
  return (
    <>
      <h2 className="setsec">Notifications on this PC</h2>
      <div className="setgroup">
        {rows.map((r) => (
          <div key={r.k} className="setrow">
            <div className="tx">
              <div className="t">{r.t}</div>
              <div className="d">{r.d}</div>
            </div>
            <div className="ctl">
              <button type="button" role="switch" aria-checked={p[r.k]} aria-label={r.t} className={`switch ${p[r.k] ? 'on' : ''}`} onClick={() => set(r.k, !p[r.k])}>
                <span />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
