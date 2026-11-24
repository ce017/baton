#!/usr/bin/env node
// Claude Code hook for Baton. Does the bookkeeping outside the model, so it costs no tokens:
//   SessionStart      → injects the project brief (who's doing what, locks, messages, tasks)
//   UserPromptSubmit  → injects new messages for this Claude, only when there are some
//   PostToolUse       → reports edited files / Studio edits to the live feed
//   Stop              → stores the first lines of the last reply (part of the living handoff)
// It never blocks Claude: every failure is silent and it always exits 0.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { api, loadConfig, projectFor } from './lib.mjs';

const event = process.argv[2];
const TIMEOUT = 2500;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 1500);
  });
}

function inject(text) {
  if (!text?.trim()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** What a tool call changed, as a short label, or undefined for read-only calls. */
function editTarget(input, cwd) {
  const name = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (EDIT_TOOLS.has(name)) {
    const p = ti.file_path ?? ti.notebook_path;
    if (!p) return undefined;
    const rel = cwd ? relative(cwd, p) : p;
    return (rel && !rel.startsWith('..') ? rel : p).replace(/\\/g, '/');
  }
  if (name.startsWith('mcp__') && !name.startsWith('mcp__baton__')) {
    const short = name.replace(/^mcp__/, '').replace(/__/g, ':');
    const where = Object.entries(ti).find(
      ([k, v]) => typeof v === 'string' && v.length < 160 && /path|instance|script|target|file|name/i.test(k),
    )?.[1];
    return where ? `${short} ${where}` : short;
  }
  return undefined;
}

/** Last assistant text in the transcript (reads only the file's tail). */
function lastReply(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const size = statSync(transcriptPath).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message ?? entry;
        if (msg.role !== 'assistant' && entry.type !== 'assistant') continue;
        const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
        const txt = parts
          .filter((p) => p?.type === 'text' && p.text)
          .map((p) => p.text)
          .join(' ')
          .trim();
        if (txt) return txt.slice(0, 600);
      } catch {}
    }
  } catch {}
  return '';
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {}
  const cfg = loadConfig();
  if (!cfg.server || !cfg.agentKey) return;
  const project = projectFor(cfg, input.cwd);
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  // The session id lets each Claude chat carry its own job ("ceo's Scripting Claude").
  const headers = {};
  if (input.session_id) headers['x-baton-session'] = String(input.session_id);
  if (input.cwd) headers['x-baton-cwd'] = encodeURIComponent(String(input.cwd).slice(0, 200));
  if (event === 'UserPromptSubmit' && input.prompt) headers['x-baton-title'] = encodeURIComponent(String(input.prompt).replace(/\s+/g, ' ').trim().slice(0, 80));
  const opts = { timeoutMs: TIMEOUT, headers };

  if (event === 'SessionStart') {
    const brief = await api(cfg, 'GET', `/api/brief${q}`, { ...opts, raw: true });
    inject(`${brief}\n\n(Baton brief, injected at session start. Keep your handoff current with baton_status.)`);
  } else if (event === 'UserPromptSubmit') {
    // "baton job Scripting" (or "baton job none") gives this chat a job.
    const pick = /^\s*\/?baton\s+job\b[\s:]*(.*?)\s*$/i.exec(input.prompt ?? '');
    if (pick && input.session_id) {
      const name = pick[1] ?? '';
      try {
        const r = await api(cfg, 'POST', '/api/chat-job', { ...opts, body: { project, session: input.session_id, job: /^(|none|off|clear)$/i.test(name) ? null : name } });
        inject(
          r.job
            ? [`(Baton) This chat is now ${cfg.user}'s ${r.job} Claude. Tell the user in one line.`, r.instructions && `Job instructions: ${r.instructions}`, r.labels?.length && `Take to-dos labelled: ${r.labels.join(', ')}.`, `Pass job: "${r.job}" in every baton_* tool call.`].filter(Boolean).join('\n')
            : '(Baton) This chat has no job now. Tell the user in one line.',
        );
      } catch (e) {
        inject(`(Baton) Could not set the job: ${e.message} Tell the user.`);
      }
      return;
    }
    inject(await api(cfg, 'GET', `/api/hook/inbox${q}`, { ...opts, raw: true }));
  } else if (event === 'PostToolUse') {
    const target = editTarget(input, input.cwd);
    if (target) await api(cfg, 'POST', '/api/events', { ...opts, body: { project, kind: 'edit', text: target } });
  } else if (event === 'Stop' || event === 'SubagentStop') {
    if (event === 'SubagentStop') return;
    const text = lastReply(input.transcript_path);
    if (text) await api(cfg, 'POST', '/api/events', { ...opts, body: { project, kind: 'reply', text } });
  }
}

main()
  .catch((e) => {
    if (process.env.BATON_DEBUG) process.stderr.write(`baton hook: ${e.message}\n`);
  })
  .finally(() => process.exit(0));
