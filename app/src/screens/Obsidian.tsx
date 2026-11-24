import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isTauri } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { loadObsidian, type Prefs, prefsKey, type Result, syncObsidian } from '../lib/obsidian.ts';
import { useToast } from '../ui.tsx';
import { useProject } from './Shell.tsx';

// Last result per project, shared with the settings rows.
const results = new Map<string, Result>();
const listeners = new Set<() => void>();
const publish = (slug: string, r: Result) => {
  results.set(slug, r);
  for (const l of listeners) l();
};
const useResult = (slug: string) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => results.get(slug),
  );

/** Runs the sync in the background: at start, after project changes, and every minute for local edits. */
export function ObsidianSync() {
  const { cfg, slug, overview } = useProject();
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const role = overview?.role;

  useEffect(() => {
    if (!isTauri || !role) return;
    const run = async () => {
      const p = loadObsidian(slug);
      if (!p.enabled || !p.folder || running.current) return;
      running.current = true;
      try {
        publish(slug, await syncObsidian(cfg, slug, role, p.folder));
      } catch (e) {
        publish(slug, { at: Date.now(), pulled: 0, pushed: 0, conflicts: 0, localOnly: 0, error: String((e as Error).message ?? e) });
      } finally {
        running.current = false;
      }
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(run, 3000); // after a burst of live changes settles
    const every = setInterval(run, 60_000);
    return () => {
      clearTimeout(timer.current);
      clearInterval(every);
    };
  }, [overview, cfg, slug, role]);

  return null;
}

/** Team screen rows. */
export function ObsidianSettings() {
  const { cfg, slug, overview } = useProject();
  const toast = useToast();
  const [p, setP] = useState(() => loadObsidian(slug));
  const [busy, setBusy] = useState(false);
  const last = useResult(slug);
  const role = overview?.role ?? 'viewer';
  const save = (next: Prefs) => {
    setP(next);
    localStorage.setItem(prefsKey(slug), JSON.stringify(next));
  };

  async function syncNow() {
    if (!p.folder.trim()) return toast('Set the folder first', false);
    setBusy(true);
    try {
      const r = await syncObsidian(cfg, slug, role, p.folder);
      publish(slug, r);
      toast(`Synced: ${r.pulled} in, ${r.pushed} out${r.conflicts ? `, ${r.conflicts} conflict copies` : ''}`);
    } catch (e) {
      toast(String((e as Error).message ?? e), false);
    } finally {
      setBusy(false);
    }
  }

  const canEdit = role === 'owner' || role === 'admin';
  return (
    <>
      <h2 className="setsec">Obsidian on this PC</h2>
      <div className="setgroup">
        {!isTauri ? (
          <div className="setrow">
            <div className="tx">
              <div className="t">Only in the desktop app</div>
              <div className="d">Keeps this project's notes in a folder of your Obsidian vault, both ways.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="setrow">
              <div className="tx">
                <div className="t">Sync notes with Obsidian</div>
                <div className="d">
                  {canEdit
                    ? 'Notes appear as Markdown files; edits on either side flow to the other. If both change, Baton keeps a conflict copy of yours.'
                    : "You get a read-only copy: as a member, your edits in Obsidian stay on this PC."}
                </div>
              </div>
              <div className="ctl">
                <button type="button" role="switch" aria-checked={p.enabled} aria-label="Sync notes with Obsidian" className={`switch ${p.enabled ? 'on' : ''}`} onClick={() => (p.folder.trim() || p.enabled ? save({ ...p, enabled: !p.enabled }) : toast('Set the folder first', false))}><span /></button>
              </div>
            </div>
            <div className="setrow">
              <div className="tx">
                <div className="t">Folder</div>
                <div className="d">A folder inside your vault just for this project, e.g. ...\My Vault\Baton\{overview?.project.name ?? slug}.</div>
              </div>
              <div className="ctl">
                <input className="input" style={{ width: 230 }} value={p.folder} onChange={(e) => save({ ...p, folder: e.target.value })} placeholder="F:\Vault\Baton\Project" aria-label="Obsidian folder" />
              </div>
            </div>
            <div className="setrow">
              <div className="tx">
                <div className="t">Last sync</div>
                <div className="d">
                  {!last
                    ? 'Not synced yet in this session.'
                    : last.error
                      ? <span className="error-text">{last.error}</span>
                      : `${ago(last.at, Date.now())}: ${last.pulled} in, ${last.pushed} out${last.conflicts ? `, ${last.conflicts} conflict copies` : ''}${last.localOnly ? `, ${last.localOnly} kept only here` : ''}.`}
                </div>
              </div>
              <div className="ctl">
                <button type="button" className="btn" onClick={syncNow} disabled={busy || !p.folder.trim()}>
                  <RefreshCw size={14} className={busy ? 'spin' : ''} /> Sync now
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
