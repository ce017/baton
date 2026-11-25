import { useQueryClient } from '@tanstack/react-query';
import { Select } from '../Select.tsx';
import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { call } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { EASE_OUT, Skel, useToast } from '../ui.tsx';
import { useProject, useProjectQuery } from './Shell.tsx';

interface Job {
  id: string;
  name: string;
  instructions: string;
  labels: string[];
}
interface Chat {
  session: string;
  title: string;
  cwd: string;
  last_seen: number;
  job: string | null;
}
interface JobsData {
  now: number;
  jobs: Job[];
  chats: Chat[];
}

const folder = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;

/** Claude jobs: each native Claude chat can have a job ("ceo's Scripting Claude") with its own instructions and labels. */
export function JobsSection() {
  const { cfg, slug } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const data = useProjectQuery<JobsData>(['jobs'], `/api/projects/${slug}/jobs`);
  const [editing, setEditing] = useState<Job | 'new' | null>(null);
  const jobs = data.data?.jobs ?? [];
  const chats = data.data?.chats ?? [];
  const now = data.data?.now ?? Date.now();

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

  async function bind(session: string, job: string) {
    try {
      await call(cfg, 'POST', `/api/projects/${slug}/chatjob`, { session, job: job || null });
      qc.invalidateQueries({ queryKey: ['p', slug] });
      toast(job ? `That chat is now your ${job} Claude` : 'That chat has no job now');
    } catch (err) {
      toast((err as Error).message, false);
    }
  }

  return (
    <>
      <h2 className="setsec">
        Jobs for your Claude chats
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
                    <div className="t">{cfg.user}'s {j.name} Claude</div>
                    <div className="d truncate">
                      {j.instructions || 'No instructions yet'}
                      {j.labels.length > 0 && <span className="faint"> · takes {j.labels.join(', ')}</span>}
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
                  <div className="d">Give each Claude chat a job, like Scripting, Managing or Videos. It gets its own instructions, takes the to-dos with its labels, and shows up as its own Claude on the board.</div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <h2 className="setsec">Your Claude chats</h2>
      <div className="setgroup">
        {chats.length ? (
          chats.map((c) => (
            <div key={c.session} className="setrow">
              <div className="tx">
                <div className="t truncate">{c.title || 'Untitled chat'}</div>
                <div className="d">{c.cwd ? `${folder(c.cwd)} · ` : ''}active {ago(c.last_seen, now)}</div>
              </div>
              <div className="ctl">
                <Select className="ghost" value={c.job ?? ''} onChange={(e) => bind(c.session, e.target.value)} aria-label="Job for this chat" disabled={!jobs.length}>
                  <option value="">No job</option>
                  {jobs.map((j) => <option key={j.id} value={j.name}>{j.name}</option>)}
                </Select>
              </div>
            </div>
          ))
        ) : (
          <div className="setrow">
            <div className="tx">
              <div className="t">No chats yet</div>
              <div className="d">Chats show up here once your connected Claude Code starts working in this project.</div>
            </div>
          </div>
        )}
        <div className="setrow">
          <div className="tx">
            <div className="d">You can also type <span className="mono">baton job Scripting</span> in a chat to give it that job, or <span className="mono">baton job none</span> to clear it.</div>
          </div>
        </div>
      </div>
    </>
  );
}

function JobForm({ job, onSave, onCancel }: { job?: Job; onSave: (j: { name: string; instructions: string; labels: string[] }) => void; onCancel: () => void }) {
  const [name, setName] = useState(job?.name ?? '');
  const [instructions, setInstructions] = useState(job?.instructions ?? '');
  const [labels, setLabels] = useState(job?.labels.join(', ') ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({ name: name.trim(), instructions: instructions.trim(), labels: labels.split(',').map((l) => l.trim()).filter(Boolean) });
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
        <label className="fl">
          <span>Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Scripting" maxLength={30} />
        </label>
        <label className="fl">
          <span>Instructions it reads at the start of every chat</span>
          <textarea className="input" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="You write and fix Luau scripts. Test in Studio before saying done." />
        </label>
        <label className="fl">
          <span>Labels whose to-dos it takes (comma separated)</span>
          <input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="FishSellerService, UI" />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>{job ? 'Save' : 'Add job'}</button>
        </div>
      </div>
    </motion.form>
  );
}
