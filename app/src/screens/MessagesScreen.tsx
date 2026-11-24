import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Users } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useApp } from '../main.tsx';
import { call } from '../lib/api.ts';
import { ago, ownerName, presence, yourLabel } from '../lib/format.ts';
import { Avatar, EASE_OUT, Empty, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

interface Conv {
  key: string;
  name: string;
  role: string | null;
  last: { from_label: string; text: string; at: number } | null;
  unread: number;
}

interface ChatMsg {
  seq: number;
  from_label: string;
  to_label: string;
  kind: string;
  text: string;
  ref: string;
  at: number;
  mine: boolean;
  fromAgent: boolean;
}

/** Highlights @names inside a message. */
function withMentions(text: string, names: string[]): ReactNode[] {
  if (!names.length) return [text];
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi');
  return text.split(re).map((part, i) => (re.test(part) && part.startsWith('@') ? <span key={i} className="mention">{part}</span> : part));
}

export function MessagesScreen() {
  const { cfg } = useApp();
  const { slug, route, go, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const active = route.chat ?? 'everyone';
  const convs = useProjectQuery<Conv[]>(['conversations'], `/api/projects/${slug}/conversations`);
  const thread = useProjectQuery<ChatMsg[]>(['chat', active], `/api/projects/${slug}/chat?with=${encodeURIComponent(active)}`);
  const [text, setText] = useState('');
  const [pop, setPop] = useState(false);
  const [sel, setSel] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const now = overview?.now ?? Date.now();
  const me = cfg.user ?? '';

  // Mentionable: people and their Claudes, with live status.
  const mentionables = [
    ...(overview?.live ?? []).filter((c) => c.isAgent).map((c) => ({ name: c.label, bot: true, status: presence(c.lastSeen, now) })),
    ...(overview?.members ?? []).filter((m) => m.name !== me).map((m) => ({ name: m.name, bot: false, status: presence(overview?.live.find((c) => c.label === m.name)?.lastSeen ?? 0, now) })),
  ];
  const names = [...mentionables.map((m) => m.name), me, 'everyone'];

  useEffect(() => {
    // opening a thread marks it read on the server; refresh the list and tab badge
    if (thread.data) qc.invalidateQueries({ queryKey: ['p', slug, 'conversations'] });
  }, [thread.data, qc, slug]);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.data]);

  async function send(body: string, kind = 'fyi', ref?: string) {
    const t = body.trim();
    if (!t) return;
    try {
      const k = kind !== 'fyi' ? kind : /\?\s*$/.test(t) ? 'question' : 'fyi';
      await call(cfg, 'POST', `/api/projects/${slug}/post`, { to: active === 'everyone' ? 'everyone' : active, kind: k, text: t, ref });
      setText('');
      setPop(false);
      qc.invalidateQueries({ queryKey: ['p', slug] });
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  const query = /@([\w' ]*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
  const matches = query === null ? [] : mentionables.filter((m) => m.name.toLowerCase().includes(query)).slice(0, 6);
  const pick = (name: string) => {
    setText((t) => t.replace(/@([\w' ]*)$/, `@${name} `));
    setPop(false);
  };
  const activeConv = convs.data?.find((c) => c.key === active);

  return (
    <div className="chat">
      <aside className="convs">
        {convs.isLoading ? (
          <div style={{ padding: 10 }}><Skel h={30} r={8} style={{ marginBottom: 8 }} /><Skel h={30} r={8} /></div>
        ) : (
          <>
            <div className="h">Team</div>
            {(convs.data ?? []).filter((c) => c.key === 'everyone').map((c) => (
              <ConvRow key={c.key} c={c} on={active === c.key} onClick={() => go({ view: 'messages', chat: c.key })} icon={<span className="ic"><Users size={15} /></span>} now={now} />
            ))}
            <div className="h">Direct</div>
            {(convs.data ?? []).filter((c) => c.key !== 'everyone').map((c) => (
              <ConvRow key={c.key} c={c} on={active === c.key} onClick={() => go({ view: 'messages', chat: c.key })} icon={<Avatar label={c.name} />} now={now} />
            ))}
          </>
        )}
      </aside>

      <section className="chatmain">
        <div className="chathead">
          <div className="grow">
            <h2>{active === 'everyone' ? 'Everyone' : activeConv?.name ?? active}</h2>
            <div className="sub">{active === 'everyone' ? 'The whole team and their Claudes' : `You, ${active} and ${active}'s Claudes`}</div>
          </div>
        </div>
        <div className="feed2" ref={feedRef}>
          {thread.isLoading ? (
            [0, 1, 2].map((i) => <div key={i} className="msg2"><Skel w={32} h={32} r={16} /><div><Skel w={140} h={10} style={{ marginBottom: 8 }} /><Skel w="70%" h={11} /></div></div>)
          ) : thread.data?.length ? (
            <AnimatePresence initial={false}>
              {thread.data.map((m) => (
                <motion.div key={m.seq} className={`msg2 ${m.mine && !m.fromAgent ? 'me' : ''}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } }}>
                  {!(m.mine && !m.fromAgent) && <Avatar label={m.from_label} bot={m.fromAgent} />}
                  <div style={{ minWidth: 0 }}>
                    <div className="who">
                      <b>{m.mine && !m.fromAgent ? 'You' : m.mine ? yourLabel(m.from_label) : m.from_label}</b>
                      {m.kind !== 'fyi' && <span className={`kindtag ${m.kind}`}>{m.kind === 'handoff' ? 'hand-over' : m.kind}</span>}
                      <span className="t">{ago(m.at, now)}</span>
                    </div>
                    {m.kind === 'question' && !m.mine ? (
                      <div className="askcard">
                        <div className="tx">{withMentions(m.text, names)}</div>
                        <div className="row" style={{ marginTop: 10 }}>
                          <button type="button" className="btn primary sm" onClick={() => send(`Yes. (re: "${m.text.slice(0, 60)}")`, 'answer', `M-${m.seq}`)}>Yes</button>
                          <button type="button" className="btn sm" onClick={() => send(`No. (re: "${m.text.slice(0, 60)}")`, 'answer', `M-${m.seq}`)}>No</button>
                          <span className="faint" style={{ fontSize: 12 }}>or write a reply below</span>
                        </div>
                      </div>
                    ) : (
                      <div className="tx">{withMentions(m.text, names)}</div>
                    )}
                    {m.ref && <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>About {m.ref}</div>}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          ) : (
            <Empty title="No messages here yet">Write below. Claudes read new messages the next time they work.</Empty>
          )}
        </div>
        {overview?.role !== 'viewer' && (
          <div className="composer2">
            {pop && matches.length > 0 && (
              <motion.div className="mpop" initial={{ opacity: 0, y: 4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.16, ease: EASE_OUT } }}>
                <div className="faint" style={{ fontSize: 12, fontWeight: 600, padding: '4px 8px' }}>Mention someone</div>
                {matches.map((m, i) => (
                  <div key={m.name} className={`pi ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(m.name); }}>
                    <Avatar label={m.name} bot={m.bot} size="sm" />
                    {ownerName(m.name) === me && m.bot ? yourLabel(m.name) : m.name}
                    <span className="s"><span className={`dot ${m.status === 'live' ? 'live' : m.status === 'idle' ? 'idle' : 'away'}`} style={{ display: 'inline-block', marginRight: 5 }} />{m.status === 'live' ? 'Active' : m.status === 'idle' ? 'Idle' : 'Away'}</span>
                  </div>
                ))}
              </motion.div>
            )}
            <div className="cbox">
              <textarea
                value={text}
                placeholder={active === 'everyone' ? 'Message everyone… type @ to mention someone or a Claude' : `Message ${active}…`}
                onChange={(e) => { setText(e.target.value); setPop(/@([\w' ]*)$/.test(e.target.value)); setSel(0); }}
                onKeyDown={(e) => {
                  if (pop && matches.length) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(matches.length - 1, s + 1)); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const m = matches[sel]; if (m) pick(m.name); return; }
                    if (e.key === 'Escape') { setPop(false); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); }
                }}
              />
              <div className="ctools">
                <button type="button" className="btn ghost sm" onClick={() => { setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`); setPop(true); }}><AtSign size={13} /> Mention</button>
                <button type="button" className="btn primary sm send" disabled={!text.trim()} onClick={() => send(text)}>Send</button>
              </div>
            </div>
            <div className="chint">Claudes read new messages the next time they work. Mention one with @ so it knows the message is for it.</div>
          </div>
        )}
      </section>
    </div>
  );
}

function ConvRow({ c, on, onClick, icon, now }: { c: Conv; on: boolean; onClick: () => void; icon: ReactNode; now: number }) {
  return (
    <button type="button" className={`conv ${on ? 'on' : ''}`} onClick={onClick}>
      {icon}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="nm">{c.name}</div>
        <div className="pv">{c.last ? `${c.last.from_label}: ${c.last.text}` : 'No messages yet'}</div>
      </div>
      {c.unread > 0 ? <span className="un">{c.unread}</span> : c.last ? <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{ago(c.last.at, now)}</span> : null}
    </button>
  );
}
