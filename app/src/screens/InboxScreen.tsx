import { useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useEffect, useState } from 'react';
import { call, type Message } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Avatar, EASE_OUT, Empty, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const KINDS = ['question', 'handoff', 'blocker', 'answer', 'fyi'] as const;
const KIND_CLASS: Record<string, string> = { blocker: 'blocked', question: 'doing', handoff: 'todo', answer: 'done', fyi: 'todo' };

export function InboxScreen() {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const msgs = useProjectQuery<Message[]>(['messages'], `/api/projects/${slug}/messages`);
  const [to, setTo] = useState('everyone');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('question');
  const [text, setText] = useState('');
  const others = (overview?.members ?? []).filter((m) => m.name !== cfg.user);
  // Opening the inbox marks messages read on the server; refresh the sidebar badge.
  useEffect(() => {
    if (msgs.data?.some((m) => m.unread)) qc.invalidateQueries({ queryKey: ['p', slug, 'overview'] });
  }, [msgs.data, qc, slug]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      const r = await call<{ message: string }>(cfg, 'POST', `/api/projects/${slug}/post`, { to, kind, text });
      setText('');
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(r.message);
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>Inbox</h1>
        <span className="faint">Messages for you and to everyone. Claudes get theirs at their next prompt.</span>
      </header>
      <div className="content scroll">
        <div className="page-pad" style={{ maxWidth: 760 }}>
          {overview?.role !== 'viewer' && (
            <form className="card card-pad" onSubmit={send} style={{ marginBottom: 20 }}>
              <div className="row" style={{ gap: 10, marginBottom: 10 }}>
                <label className="row" style={{ gap: 6 }}>
                  <span className="muted">To</span>
                  <select className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="everyone">Everyone</option>
                    {others.map((m) => (
                      <option key={m.name} value={m.name}>{m.name} and their Claudes</option>
                    ))}
                  </select>
                </label>
                <div className="row" style={{ gap: 4 }}>
                  {KINDS.map((k) => (
                    <button key={k} type="button" className={`chip ${kind === k ? KIND_CLASS[k] : ''}`} style={{ border: kind === k ? 0 : '1px solid var(--line)', background: kind === k ? undefined : 'transparent', cursor: 'pointer', height: 24 }} onClick={() => setKind(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <textarea className="input grow" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Can your Claude take T-3 while I'm at training?" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send(e)} />
                <button className="btn primary" disabled={!text.trim()}>
                  <Send size={14} /> Send
                </button>
              </div>
            </form>
          )}
          {msgs.isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="card card-pad" style={{ marginBottom: 8 }}>
                <Skel w={160} h={10} style={{ marginBottom: 10 }} />
                <Skel w="85%" h={11} />
              </div>
            ))
          ) : msgs.data?.length ? (
            [...msgs.data].reverse().map((m, i) => (
              <motion.div
                key={m.seq}
                className="card card-pad"
                style={{ marginBottom: 8, borderLeft: m.unread ? '3px solid var(--accent)' : undefined }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT, delay: i < 8 ? i * 0.04 : 0 } }}
              >
                <div className="row" style={{ marginBottom: 6 }}>
                  <Avatar label={m.from_label} bot={m.from_label.includes("'s ")} size="sm" />
                  <b style={{ fontWeight: 500 }}>{m.from_label}</b>
                  <span className={`chip ${KIND_CLASS[m.kind] ?? ''}`}>{m.kind}</span>
                  <span className="faint">to {m.to_label}</span>
                  <span className="grow" />
                  <span className="faint" style={{ fontSize: 12 }}>{ago(m.at)}</span>
                </div>
                <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                {m.ref && <div className="mono faint" style={{ marginTop: 4 }}>re {m.ref}</div>}
              </motion.div>
            ))
          ) : (
            <div className="card"><Empty title="No messages yet">Questions and handoffs between people and Claudes land here.</Empty></div>
          )}
        </div>
      </div>
    </>
  );
}
