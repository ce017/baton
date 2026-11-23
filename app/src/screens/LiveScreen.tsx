import { useQueryClient } from '@tanstack/react-query';
import { Bot, FileText, Lock, MessageSquare, Pencil, Pin, SquareCheck, UserPlus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useRef, useState } from 'react';
import { call, type FeedRow, type LiveCard } from '../lib/api.ts';
import { ago, presence, presenceText } from '../lib/format.ts';
import { Avatar, EASE_OUT, Empty, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const FEED_ICON: Record<string, typeof Pencil> = {
  edit: Pencil,
  page: FileText,
  task: SquareCheck,
  pin: Pin,
  comment: MessageSquare,
  post: MessageSquare,
  lock: Lock,
  status: Bot,
  member: UserPlus,
  skill: FileText,
};

export function LiveScreen() {
  const { overview, slug } = useProject();
  const feed = useProjectQuery<FeedRow[]>(['feed'], `/api/projects/${slug}/feed?limit=60`);
  // Stagger the cards only on the first paint; later updates just move into place.
  const firstPaint = useRef(true);
  const stagger = firstPaint.current;
  if (overview) firstPaint.current = false;

  const now = overview?.now ?? Date.now();
  const cards = (overview?.live ?? [])
    .filter((c) => c.isAgent || c.doing)
    .sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || b.lastSeen - a.lastSeen);

  return (
    <>
      <header className="topbar">
        <h1>Live</h1>
        <span className="faint">Who is doing what, right now</span>
      </header>
      <div className="content scroll">
        <div className="page-pad live-grid">
          <div>
            <h2 className="section-title">Handoffs</h2>
            {!overview ? (
              <div className="handoffs">
                {[0, 1].map((i) => (
                  <div key={i} className="card handoff">
                    <div className="row" style={{ marginBottom: 14 }}>
                      <Skel w={24} h={24} r={12} />
                      <Skel w={140} />
                    </div>
                    <Skel h={10} style={{ marginBottom: 8 }} />
                    <Skel w="70%" h={10} style={{ marginBottom: 8 }} />
                    <Skel w="45%" h={10} />
                  </div>
                ))}
              </div>
            ) : cards.length ? (
              <motion.div className="handoffs" initial={stagger ? 'hidden' : false} animate="shown" variants={{ shown: { transition: { staggerChildren: 0.04 } } }}>
                {cards.map((c, i) => (
                  <HandoffCard key={c.id} card={c} now={now} mine={c.id === overview.me} animate={i < 8} />
                ))}
              </motion.div>
            ) : (
              <div className="card">
                <Empty title="No Claude has checked in yet">
                  Connect a Claude in <b>People &amp; Claude</b>. Its handoff shows up here as soon as it starts a session.
                </Empty>
              </div>
            )}

            <h2 className="section-title" style={{ marginTop: 24 }}>Locked areas</h2>
            <div className="card">
              {overview?.locks.length ? (
                overview.locks.map((l) => (
                  <div key={l.area} className="lock-row">
                    <Lock size={14} className="faint" />
                    <span className="mono grow truncate">{l.area}</span>
                    {l.note && <span className="faint truncate" style={{ maxWidth: 200 }}>{l.note}</span>}
                    <Avatar label={l.label} bot={l.actor_id.startsWith('a_')} size="sm" />
                    <span className="faint" style={{ fontSize: 12 }}>{ago(l.at, now)}</span>
                  </div>
                ))
              ) : (
                <div className="empty" style={{ padding: 16 }}>Nothing is locked. Claudes lock an area before they edit it.</div>
              )}
            </div>

            <MyStatus />
          </div>

          <div className="card" style={{ position: 'sticky', top: 0 }}>
            <div className="card-pad" style={{ paddingBottom: 4 }}>
              <h2 className="section-title" style={{ margin: 0 }}>Activity</h2>
            </div>
            <div className="feed">
              {feed.isLoading &&
                [0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="feed-item">
                    <Skel w={18} h={18} r={9} />
                    <div>
                      <Skel w="80%" h={10} style={{ marginBottom: 6 }} />
                      <Skel w={60} h={8} />
                    </div>
                  </div>
                ))}
              <AnimatePresence initial={false}>
                {(feed.data ?? []).slice(0, 40).map((r) => {
                  const Icon = FEED_ICON[r.kind] ?? Pencil;
                  return (
                    <motion.div
                      key={r.seq}
                      layout="position"
                      className="feed-item"
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    >
                      <Avatar label={r.label} bot={r.label.includes("'s ")} size="sm" />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ lineHeight: 1.4 }}>
                          <b style={{ fontWeight: 500 }}>{r.label}</b> <span className="muted">{r.text}</span>
                        </div>
                        <div className="when row" style={{ gap: 4 }}>
                          <Icon size={11} /> {ago(r.at, now)}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {feed.data && !feed.data.length && <div className="empty">No activity yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function HandoffCard({ card: c, now, mine, animate }: { card: LiveCard; now: number; mine: boolean; animate: boolean }) {
  const p = presence(c.lastSeen, now);
  const showSaid = c.lastReply && c.lastReplyAt >= c.updatedAt;
  return (
    <motion.article
      layout="position"
      className="card handoff"
      variants={animate ? { hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE_OUT } } } : undefined}
    >
      <div className="handoff-head">
        <Avatar label={c.label} bot={c.isAgent} />
        <div className="grow">
          <div className="handoff-name truncate">{c.label}{mine ? ' (you)' : ''}</div>
          <div className="row faint" style={{ gap: 6, fontSize: 12 }}>
            <span className={`dot ${p}`} /> {presenceText[p]} · {ago(c.lastSeen, now)}
          </div>
        </div>
      </div>
      {c.doing ? (
        <dl>
          <dt>Doing</dt>
          <dd>{c.doing}</dd>
          {c.where && (
            <>
              <dt>Where</dt>
              <dd className="mono" style={{ wordBreak: 'break-word' }}>{c.where}</dd>
            </>
          )}
          {c.next && (
            <>
              <dt>Next</dt>
              <dd>{c.next}</dd>
            </>
          )}
        </dl>
      ) : (
        <div className="faint">No task set.</div>
      )}
      {showSaid && <div className="said">“{c.lastReply.length > 240 ? `${c.lastReply.slice(0, 239)}…` : c.lastReply}”</div>}
      {c.lastEdit && (
        <div className="trail truncate" title={c.lastEdit}>
          <Pencil size={11} style={{ verticalAlign: -1 }} /> {c.lastEdit} · {ago(c.lastEditAt, now)}
        </div>
      )}
    </motion.article>
  );
}

/** People can post their own handoff too ("training until 18:00, Boe take the shop UI"). */
function MyStatus() {
  const { cfg, slug, overview } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const mine = overview?.live.find((c) => c.id === overview.me);
  const [doing, setDoing] = useState('');
  const [next, setNext] = useState('');
  const [editing, setEditing] = useState(false);
  if (!overview || overview.role === 'viewer') return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/status`, { doing, next });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(doing ? 'Your status is up' : 'Status cleared');
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 24 }}>Your status</h2>
      <div className="card card-pad">
        {editing ? (
          <form onSubmit={save}>
            <div className="field">
              <label className="label" htmlFor="sdo">What you're on (or where you are)</label>
              <input id="sdo" className="input" value={doing} onChange={(e) => setDoing(e.target.value)} placeholder="At training until 18:00" autoFocus />
            </div>
            <div className="field">
              <label className="label" htmlFor="snext">Note for the team</label>
              <input id="snext" className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Boe's Claude can take the shop UI" />
            </div>
            <div className="row">
              <button className="btn primary">Post status</button>
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="row">
            <div className="grow">
              {mine?.doing ? (
                <>
                  <div>{mine.doing}</div>
                  {mine.next && <div className="muted">{mine.next}</div>}
                </>
              ) : (
                <span className="faint">Tell your team and their Claudes what you're up to.</span>
              )}
            </div>
            <button type="button" className="btn" onClick={() => { setDoing(mine?.doing ?? ''); setNext(mine?.next ?? ''); setEditing(true); }}>
              {mine?.doing ? 'Update' : 'Set status'}
            </button>
            {mine?.doing && (
              <button type="button" className="btn ghost" onClick={async () => { await call(cfg, 'POST', `/api/projects/${slug}/status`, { doing: '' }); qc.invalidateQueries({ queryKey: ['p', slug] }); }}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
