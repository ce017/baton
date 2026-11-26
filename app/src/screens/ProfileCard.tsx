import { Bot, MessageSquare, Pencil } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ago, personColor } from '../lib/format.ts';
import { Avatar, EASE_OUT, splitLabel, usePeople } from '../ui.tsx';
import { Badges, type Profile } from './SettingsScreen.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
const W = 300;

/** A small profile card that opens next to whoever you click: picture, names, badges, status, about, and what their Claudes are doing. */
export function ProfileCard() {
  const { cfg, slug, overview, go } = useProject();
  const people = usePeople();
  const profiles = useProjectQuery<Record<string, Profile | null>>(['profiles'], `/api/projects/${slug}/profiles`);
  const [at, setAt] = useState<{ name: string; x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = (e: Event) => setAt((e as CustomEvent<{ name: string; x: number; y: number }>).detail);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    window.addEventListener('baton:profile', open);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('baton:profile', open);
      window.removeEventListener('keydown', key);
    };
  }, []);

  // Keep the card on screen: to the right of the click, flipped left or up when there's no room.
  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const h = ref.current.offsetHeight;
    let left = at.x + 12;
    if (left + W > window.innerWidth - 8) left = Math.max(8, at.x - W - 12);
    let top = at.y - 40;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [at, profiles.data]);

  const name = at?.name ?? '';
  const p = profiles.data?.[name] ?? null;
  const member = overview?.members.find((m) => m.name === name);
  const claudes = (overview?.live ?? []).filter((l) => l.isAgent && splitLabel(l.label).owner === name);
  const now = overview?.now ?? Date.now();
  const color = people.colors[name] || personColor(name);
  const isMe = name === cfg.user;

  return (
    <AnimatePresence>
      {at && (
        <>
          <div className="pcard-veil" onClick={() => setAt(null)} />
          <motion.div
            ref={ref}
            key={name}
            className="pcard"
            role="dialog"
            aria-label={`${p?.display || name}'s profile`}
            style={{ left: pos.left, top: pos.top, width: W }}
            initial={{ opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: EASE_OUT } }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          >
            <div className="pcard-banner" style={{ background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 45%, #000))` }} />
            <div className="pcard-head">
              <div className="pcard-av">
                <Avatar label={name} size="lg" />
              </div>
              {p?.status && <div className="pcard-bubble">{p.status}</div>}
            </div>
            <div className="pcard-body">
              <div className="pcard-name">{p?.display || name}</div>
              <div className="pcard-user">
                @{name}
                {member && <span className="pcard-role">{ROLE[member.role] ?? member.role}</span>}
                <Badges list={p?.badges} max={8} />
              </div>
              {p?.about && <p className="pcard-about">{p.about}</p>}
              {!p && !profiles.isLoading && <p className="pcard-about faint">Not in this project.</p>}

              {claudes.length > 0 && (
                <div className="pcard-sec">
                  <div className="pcard-label">Their Claudes</div>
                  {claudes.slice(0, 3).map((c) => {
                    const live = now - c.lastSeen < 5 * 60_000;
                    return (
                      <div key={c.id} className="pcard-act">
                        <span className="pcard-act-ic"><Bot size={16} /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="t truncate">{splitLabel(c.label).rest ?? 'Claude'}</div>
                          <div className="d truncate">{c.doing || (c.lastReply ? 'Idle' : 'No task yet')}</div>
                          <div className={`d ${live ? 'on' : ''}`}><span className={`dot ${live ? 'live' : 'away'}`} /> {live ? 'Active now' : `Seen ${ago(c.lastSeen, now)}`}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {isMe ? (
                <button type="button" className="btn primary pcard-btn" onClick={() => { setAt(null); go({ view: 'settings' }); }}>
                  <Pencil size={14} /> Edit profile
                </button>
              ) : member ? (
                <button type="button" className="btn primary pcard-btn" onClick={() => { setAt(null); go({ view: 'messages', chat: name }); }}>
                  <MessageSquare size={14} /> Message {p?.display || name}
                </button>
              ) : null}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
