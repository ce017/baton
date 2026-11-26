import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '../Select.tsx';
import { AtSign, Crown, Plus, Search, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { call, isTauri, tauriInvoke } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { EASE_OUT, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

interface Job {
  id: string;
  name: string;
  instructions: string;
  labels: string[];
  kind: 'worker' | 'manager';
  auto: boolean;
  wake: boolean;
}
interface Chat {
  session: string;
  title: string;
  cwd: string;
  last_seen: number;
  job: string | null;
}
/** A Claude Code chat found on this PC (desktop app only). */
interface LocalChat {
  session: string;
  title: string;
  cwd: string;
  lastActive: number;
}

interface Dispatch {
  id: string;
  job: string;
  session: string;
  cwd: string;
  task: string;
  text: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result: string;
  createdAt: number;
}
interface JobsData {
  now: number;
  jobs: Job[];
  chats: Chat[];
  dispatches: Dispatch[];
}

/** How job chats run on this PC when Baton starts them (local only). */
interface RunPrefs {
  mayEdit: boolean;
  maxTurns: number;
}
const RUN_KEY = 'baton.jobruns';
function loadRun(): RunPrefs {
  try {
    return { mayEdit: true, maxTurns: 60, ...JSON.parse(localStorage.getItem(RUN_KEY) ?? '{}') };
  } catch {
    return { mayEdit: true, maxTurns: 60 };
  }
}

const folder = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
const useJobs = () => {
  const { slug } = useProject();
  return useProjectQuery<JobsData>(['jobs'], `/api/projects/${slug}/jobs`);
};

/**
 * Runs on the owner's PC: when Baton hands a to-do to one of their job chats that starts by itself,
 * resumes that exact Claude Code chat headless with the to-do. Desktop app only.
 */
export function Dispatcher() {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const data = useJobs();
  const busy = useRef(false);

  useEffect(() => {
    if (!isTauri || busy.current) return;
    const d = data.data?.dispatches.find((x) => x.status === 'pending');
    if (!d) return;
    busy.current = true;
    const finish = (status: 'done' | 'failed' | 'skipped', result: string) =>
      call(cfg, 'POST', `/api/projects/${slug}/dispatch-finish`, { id: d.id, status, result: result.slice(0, 600) }).catch(() => {});
    (async () => {
      try {
        await call(cfg, 'POST', `/api/projects/${slug}/dispatch-claim`, { id: d.id });
      } catch {
        return; // another PC took it
      }
      if (!d.cwd) return finish('skipped', "Baton doesn't know that chat's folder yet. Send one message in it first.");
      const p = loadRun();
      try {
        const out = await tauriInvoke<string>('resume_chat', { session: d.session, folder: d.cwd, prompt: d.text, maxTurns: p.maxTurns, mayEdit: p.mayEdit });
        await finish('done', out || 'Finished without a summary.');
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        await finish('failed', /authenticate|oauth|log ?in/i.test(msg) ? 'Claude Code on this PC needs to sign in again (run claude in a terminal, then /login).' : msg);
      }
    })().finally(() => {
      busy.current = false;
      qc.invalidateQueries({ queryKey: ['p', slug] });
    });
  }, [data.data, cfg, slug, qc]);

  return null;
}

const RUN_STATUS: Record<Dispatch['status'], string> = { pending: 'Waiting for this PC', running: 'Working now', done: 'Done', failed: 'Failed', skipped: "Didn't start" };

/** Claude jobs: each native Claude chat can have a job ("ceo's Scripting Claude") with its own instructions and labels. */
export function JobsSection() {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const data = useJobs();
  const [editing, setEditing] = useState<Job | 'new' | null>(null);
  const [run, setRun] = useState(loadRun);
  const jobs = data.data?.jobs ?? [];
  const chats = data.data?.chats ?? [];
  const runs = data.data?.dispatches ?? [];
  const now = data.data?.now ?? Date.now();
  const saveRun = (next: RunPrefs) => {
    setRun(next);
    localStorage.setItem(RUN_KEY, JSON.stringify(next));
  };

  async function send(body: object, done?: string) {
    try {
      await call<JobsData>(cfg, 'POST', `/api/projects/${slug}/jobs`, body);
      qc.invalidateQueries({ queryKey: ['p', slug] });
      if (done) toast(done);
      return true;
    } catch (err) {
      toast((err as Error).message, false);
      return false;
    }
  }

  async function bind(session: string, job: string, info: { title?: string; cwd?: string } = {}) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/chatjob`, { session, job: job || null, title: info.title ?? '', cwd: info.cwd ?? '' });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      qc.invalidateQueries({ queryKey: ['chat-projects'] });
      toast(job ? `That chat is now your ${job} Claude` : 'That chat has no job now');
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  const chatFor = (name: string) => chats.find((c) => c.job === name);

  // Every chat on this PC (newest first), with what Baton knows about it in this project.
  const local = useQuery({ queryKey: ['local-chats'], queryFn: () => tauriInvoke<LocalChat[]>('local_chats'), enabled: isTauri, staleTime: 20_000 });
  const where = useQuery({ queryKey: ['chat-projects'], queryFn: () => call<Record<string, string>>(cfg, 'GET', '/api/me/chat-projects') });
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const known = new Map(chats.map((c) => [c.session, c]));
  const merged = [
    ...(local.data ?? []).map((l) => ({ session: l.session, title: l.title || known.get(l.session)?.title || '', cwd: l.cwd || known.get(l.session)?.cwd || '', last: l.lastActive, job: known.get(l.session)?.job ?? null })),
    ...chats.filter((c) => !(local.data ?? []).some((l) => l.session === c.session)).map((c) => ({ session: c.session, title: c.title, cwd: c.cwd, last: c.last_seen, job: c.job })),
  ];
  const needle = q.trim().toLowerCase();
  const found = merged.filter((c) => !needle || `${c.title} ${c.cwd}`.toLowerCase().includes(needle));
  // Chats with a job here come first, then the newest.
  found.sort((a, b) => Number(!!b.job) - Number(!!a.job) || b.last - a.last);
  const shown = all || needle ? found.slice(0, 80) : found.slice(0, 10);

  return (
    <>
      <h2 className="setsec">
        Your Claudes' jobs
        {editing === null && (
          <button type="button" className="btn ghost sm act" onClick={() => setEditing('new')}><Plus size={14} /> New job</button>
        )}
      </h2>
      <div className="setgroup">
        {data.isLoading ? (
          <div className="setrow"><Skel h={36} r={8} /></div>
        ) : (
          <>
            <AnimatePresence initial={false}>
              {editing === 'new' && (
                <JobForm key="new" onCancel={() => setEditing(null)} onSave={async (j) => { if (await send(j, `Added ${j.name}`)) setEditing(null); }} />
              )}
            </AnimatePresence>
            {jobs.map((j) =>
              editing !== null && editing !== 'new' && editing.id === j.id ? (
                <JobForm key={j.id} job={j} onCancel={() => setEditing(null)} onSave={async (v) => { if (await send({ ...v, id: j.id }, 'Saved')) setEditing(null); }} />
              ) : (
                <div key={j.id} className="setrow">
                  <div className="tx">
                    <div className="t">
                      {cfg.user}'s {j.name} Claude
                      {j.kind === 'manager' && <span className="jobtag"><Crown size={11} /> Manager</span>}
                      {j.auto && <span className="jobtag"><Zap size={11} /> Starts by itself</span>}
                      {j.wake && <span className="jobtag"><AtSign size={11} /> Answers mentions</span>}
                    </div>
                    <div className="d truncate">
                      {chatFor(j.name) ? `Chat: ${chatFor(j.name)?.title || 'Untitled chat'}` : 'No chat picked yet'}
                      {j.kind === 'manager' ? ' · plans and hands out to-dos' : j.labels.length > 0 ? ` · takes ${j.labels.join(', ')}` : ' · no labels yet'}
                    </div>
                  </div>
                  <div className="ctl">
                    <button type="button" className="btn ghost sm" onClick={() => setEditing(j)}>Edit</button>
                    <button type="button" className="btn ghost sm danger" onClick={() => send({ delete: j.id }, `Removed ${j.name}`)}>Remove</button>
                  </div>
                </div>
              ),
            )}
            {!jobs.length && editing === null && (
              <div className="setrow">
                <div className="tx">
                  <div className="t">One chat per kind of work</div>
                  <div className="d">
                    Make a job like Scripting or Building, pick the Claude chat that does it below, and new to-dos with its labels go to that chat instead of a new one. Make one a Manager: it plans, hands out to-dos and reports to the team.
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <h2 className="setsec">
        Your Claude chats
        {merged.length > 0 && (
          <span className="act chatsearch">
            <Search size={13} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a chat" aria-label="Find a chat" />
          </span>
        )}
      </h2>
      <div className="setgroup">
        {shown.length ? (
          shown.map((c) => {
            const elsewhere = where.data?.[c.session] && where.data[c.session] !== slug ? where.data[c.session] : null;
            return (
              <div key={c.session} className="setrow">
                <div className="tx">
                  <div className="t truncate">{c.title || 'Untitled chat'}</div>
                  <div className="d">
                    {c.cwd ? `${folder(c.cwd)} · ` : ''}active {ago(c.last, now)}
                    {elsewhere && <span className="faint"> · works in {elsewhere}</span>}
                  </div>
                </div>
                <div className="ctl">
                  <Select className="ghost" value={c.job ?? ''} onChange={(e) => bind(c.session, e.target.value, { title: c.title, cwd: c.cwd })} aria-label="Job for this chat" disabled={!jobs.length}>
                    <option value="">{jobs.length ? 'No job' : 'Make a job first'}</option>
                    {jobs.map((j) => <option key={j.id} value={j.name}>{j.name}{j.kind === 'manager' ? ' (manager)' : ''}</option>)}
                  </Select>
                </div>
              </div>
            );
          })
        ) : (
          <div className="setrow">
            <div className="tx">
              <div className="t">{needle ? 'No chat matches' : 'No chats yet'}</div>
              <div className="d">{isTauri ? 'Chats from Claude Code on this PC show up here.' : 'Open the Baton desktop app to pick from the Claude Code chats on your PC.'}</div>
            </div>
          </div>
        )}
        {!needle && found.length > 10 && (
          <div className="setrow">
            <button type="button" className="btn ghost sm" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${found.length} chats`}</button>
          </div>
        )}
        <div className="setrow">
          <div className="tx">
            <div className="d">Giving a chat a job here also makes it work in this project. You can also type <span className="mono">baton job Scripting</span> in a chat, or <span className="mono">baton job none</span> to clear it.</div>
          </div>
        </div>
      </div>

      {jobs.some((j) => j.auto || j.wake) && (
        <>
          <h2 className="setsec">When Baton starts a job chat</h2>
          <div className="setgroup">
            {!isTauri ? (
              <div className="setrow">
                <div className="tx">
                  <div className="t">Only in the desktop app</div>
                  <div className="d">Job chats that start by themselves run on your PC, so keep the Baton app open (the tray is enough).</div>
                </div>
              </div>
            ) : (
              <>
                <div className="setrow">
                  <div className="tx">
                    <div className="t">May edit files</div>
                    <div className="d">Off: the chat only reads, reports and updates Baton. It never runs commands on its own.</div>
                  </div>
                  <div className="ctl">
                    <button type="button" role="switch" aria-checked={run.mayEdit} aria-label="May edit files" className={`switch ${run.mayEdit ? 'on' : ''}`} onClick={() => saveRun({ ...run, mayEdit: !run.mayEdit })}><span /></button>
                  </div>
                </div>
                <div className="setrow">
                  <div className="tx">
                    <div className="t">Steps per run</div>
                    <div className="d">How long each run may go. Runs use your Claude plan. Works best when that chat isn't open and busy.</div>
                  </div>
                  <div className="ctl">
                    <Select className="ghost" value={run.maxTurns} onChange={(e) => saveRun({ ...run, maxTurns: Number(e.target.value) })} aria-label="Steps per run">
                      {[20, 60, 120].map((n) => <option key={n} value={n}>{n} steps</option>)}
                    </Select>
                  </div>
                </div>
              </>
            )}
            {runs.map((d) => (
              <div key={d.id} className="setrow">
                <div className="tx">
                  <div className="t">{d.job} Claude · {d.task}</div>
                  <div className="d truncate">{RUN_STATUS[d.status]} · {ago(d.createdAt, now)}{d.result ? ` · ${d.result}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function JobForm({ job, onSave, onCancel }: { job?: Job; onSave: (j: { name: string; instructions: string; labels: string[]; kind: string; auto: boolean; wake: boolean }) => void; onCancel: () => void }) {
  const [name, setName] = useState(job?.name ?? '');
  const [instructions, setInstructions] = useState(job?.instructions ?? '');
  const [labels, setLabels] = useState(job?.labels.join(', ') ?? '');
  const [kind, setKind] = useState<string>(job?.kind ?? 'worker');
  const [auto, setAuto] = useState(job?.auto ?? false);
  const [wake, setWake] = useState(job?.wake ?? true);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({ name: name.trim(), instructions: instructions.trim(), labels: labels.split(',').map((l) => l.trim()).filter(Boolean), kind, auto, wake });
  };
  return (
    <motion.form
      onSubmit={submit}
      className="setrow jobform"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto', transition: { duration: 0.2, ease: EASE_OUT } }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.14 } }}
    >
      <div className="tx" style={{ display: 'grid', gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <label className="fl grow">
            <span>Name</span>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Scripting" maxLength={30} />
          </label>
          <label className="fl">
            <span>Role</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Role">
              <option value="worker">Does the work</option>
              <option value="manager">Manager</option>
            </Select>
          </label>
        </div>
        <label className="fl">
          <span>Instructions it reads at the start of every chat</span>
          <textarea
            className="input"
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={kind === 'manager' ? 'Plan each new world, split it into to-dos, and keep the team posted.' : 'You write and fix Luau scripts. Test in Studio before saying done.'}
          />
        </label>
        {kind !== 'manager' && (
          <label className="fl">
            <span>Labels whose to-dos it takes (matched against a to-do's area and title)</span>
            <input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Scripting, World, UI" />
          </label>
        )}
        <div className="row" style={{ gap: 10 }}>
          <button type="button" role="switch" aria-checked={auto} aria-label="Starts by itself" className={`switch ${auto ? 'on' : ''}`} onClick={() => setAuto(!auto)}><span /></button>
          <span className="grow" style={{ fontSize: 13 }}>
            Starts by itself
            <span className="faint">
              {kind === 'manager' ? ' · when a to-do is finished, Baton resumes this chat to check it and plan the next step' : ' · when a to-do is handed to it, Baton resumes this chat on your PC to do it'}
            </span>
          </span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button type="button" role="switch" aria-checked={wake} aria-label="Answers when mentioned" className={`switch ${wake ? 'on' : ''}`} onClick={() => setWake(!wake)}><span /></button>
          <span className="grow" style={{ fontSize: 13 }}>
            Answers when mentioned
            <span className="faint"> · when someone or another Claude mentions it and its chat is idle, Baton wakes that chat on your PC to answer</span>
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>{job ? 'Save' : 'Add job'}</button>
        </div>
      </div>
    </motion.form>
  );
}
