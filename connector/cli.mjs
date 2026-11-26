#!/usr/bin/env node
// baton: connect this PC's Claude to a Baton server and manage projects from the terminal.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, configPath, loadConfig, saveConfig } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'hook.mjs');
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

// --config is read by lib.mjs from process.argv; drop it from our positional args.
const cfgFile = configPath();
flag('config');
const cfg = loadConfig(cfgFile);
const save = () => saveConfig(cfg, cfgFile);
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

const HELP = `baton — shared workspace for people and their Claudes

Setup
  baton init --server <url> --admin-token <t> --user <name>   create a person (server admin)
  baton login --server <url> --key <bt_u_…>                    save your user key
  baton agent create [name]                                    create a key for this PC's Claude
  baton use <project>                                          set this Claude's default project
  baton connect [--no-mcp] [--settings <file>]                 add the MCP server + hooks to Claude Code
  baton disconnect [--settings <file>]                         remove them

Projects
  baton project create <slug> [name]
  baton member <project> <user> <admin|member|viewer|none>
  baton whoami | brief [project] | feed [project]

Knowledge
  baton import <folder> --project <p> [--prefix Imported] [--match <regex>]   import markdown notes
  baton skills pull [--project p] [--dest ~/.claude/skills]    install the project's shared skills
  baton skills push <skill folder> [--project p]               share a local skill

All commands take --config <file> (default ~/.baton/config.json or $BATON_CONFIG).`;

async function main() {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const server = flag('server');
      const token = flag('admin-token');
      const user = flag('user');
      if (!server || !token || !user) throw new Error('Usage: baton init --server <url> --admin-token <t> --user <name>');
      cfg.server = String(server).replace(/\/+$/, '');
      const r = await api(cfg, 'POST', '/api/admin/users', { key: `admin:${token}`, body: { name: user } });
      cfg.user = r.name;
      cfg.userKey = r.key;
      save();
      return out(`Created ${r.name}. Their user key is saved in ${cfgFile}.\nTo give it to them instead, send this key privately: ${r.key}`);
    }
    case 'login': {
      const server = flag('server');
      const key = flag('key');
      if (!server || !key) throw new Error('Usage: baton login --server <url> --key <bt_u_…>');
      cfg.server = String(server).replace(/\/+$/, '');
      cfg.userKey = String(key);
      const me = await api(cfg, 'GET', '/api/me', { key: 'user' });
      cfg.user = me.user;
      save();
      return out(`Logged in as ${me.user}. Projects: ${me.projects.map((p) => p.slug).join(', ') || 'none yet'}.`);
    }
    case 'whoami':
      return out(await api(cfg, 'GET', '/api/me', { key: cfg.agentKey ? 'agent' : 'user' }));
    case 'agent': {
      if (sub !== 'create' && sub !== 'rotate') throw new Error('Usage: baton agent create [name] | baton agent rotate [name]');
      const name = rest[0] ?? cfg.agentName ?? 'Claude';
      const r = await api(cfg, 'POST', sub === 'create' ? '/api/agents' : '/api/agents/rotate', { key: 'user', body: { name } });
      cfg.agentName = name;
      cfg.agentKey = r.key;
      save();
      return out(`${sub === 'create' ? 'Created' : 'Rotated'} agent "${name}" (${cfg.user}'s ${name}). Key saved. Next: baton use <project>, then baton connect.`);
    }
    case 'use': {
      if (!sub) throw new Error('Usage: baton use <project>');
      await api(cfg, 'POST', '/api/agents/default', { body: { project: sub } });
      cfg.project = sub;
      save();
      return out(`This Claude now works in "${sub}" by default.`);
    }
    case 'project': {
      if (sub !== 'create' || !rest[0]) throw new Error('Usage: baton project create <slug> [name]');
      const r = await api(cfg, 'POST', '/api/projects', { key: 'user', body: { slug: rest[0], name: rest.slice(1).join(' ') || rest[0] } });
      return out(`Created project ${r.slug} ("${r.name}"). You are its owner.`);
    }
    case 'member': {
      const [user, role] = rest;
      if (!sub || !user || !role) throw new Error('Usage: baton member <project> <user> <admin|member|viewer|none>');
      const r = await api(cfg, 'POST', `/api/projects/${sub}/members`, { key: 'user', body: { user, role } });
      return out(r.message);
    }
    case 'picture': {
      // baton picture <file> [--project <slug>]: prints markdown that shows the picture in Baton.
      if (!sub) throw new Error('Usage: baton picture <file> [--project <slug>]');
      const bytes = readFileSync(sub);
      const mime = bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'GIF8' ? 'image/gif' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
      if (!mime) throw new Error('That file is not a PNG, JPEG, WebP or GIF picture.');
      if (bytes.length > 1_800_000) throw new Error('That picture is too big (1.8 MB at most). Shrink it first.');
      const r = await api(cfg, 'POST', '/api/images', { key: cfg.agentKey ? 'agent' : 'user', timeoutMs: 60000, body: { project: flag('project') ?? undefined, mime, name: basename(sub).replace(/\.[^.]+$/, ''), data: bytes.toString('base64') } });
      return out(r.markdown);
    }
    case 'brief': {
      const q = sub ? `?project=${encodeURIComponent(sub)}` : '';
      return out(await api(cfg, 'GET', `/api/brief${q}`, { key: cfg.agentKey ? 'agent' : 'user', raw: true }));
    }
    case 'feed': {
      const p = sub ?? cfg.project;
      if (!p) throw new Error('Usage: baton feed <project>');
      const rows = await api(cfg, 'GET', `/api/projects/${p}/feed?limit=30`, { key: cfg.agentKey ? 'agent' : 'user' });
      return out(rows.reverse().map((r) => `${new Date(r.at).toLocaleString()}  ${r.label}: ${r.text}`).join('\n'));
    }
    case 'mcp-json':
      return out({ mcpServers: { baton: { type: 'http', url: `${cfg.server}/mcp`, headers: { Authorization: `Bearer ${cfg.agentKey}` } } } });
    case 'connect':
      return connect();
    case 'disconnect':
      return disconnect();
    case 'import':
      return importNotes(sub);
    case 'skills':
      if (sub === 'pull') return skillsPull();
      if (sub === 'push') return skillsPush(rest[0]);
      throw new Error('Usage: baton skills pull | baton skills push <folder>');
    default:
      return out(HELP);
  }
}

// ------------------------------------------------------------------ Claude Code wiring

function settingsFile() {
  return resolve(String(flag('settings') ?? join(homedir(), '.claude', 'settings.json')));
}

function hookCommand(evt) {
  const extra = cfgFile !== join(homedir(), '.baton', 'config.json') ? ` --config "${cfgFile}"` : '';
  return `node "${HOOK}" ${evt}${extra}`;
}

// Our hooks: the CLI's node hook.mjs, or the desktop app's 'Baton.exe --hook <Event> --baton'.
const isBatonHook = (h) => typeof h?.command === 'string' && ((h.command.includes('hook.mjs') && /baton/i.test(h.command)) || h.command.includes('--baton'));

function stripBaton(hooks) {
  for (const evt of Object.keys(hooks)) {
    hooks[evt] = (hooks[evt] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isBatonHook(h)) }))
      .filter((group) => group.hooks.length);
    if (!hooks[evt].length) delete hooks[evt];
  }
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  return text.trim() ? JSON.parse(text) : {};
}

function writeSettings(file, data) {
  if (existsSync(file)) {
    const backup = `${file}.baton-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(file, backup);
    console.log(`Backed up ${file} → ${basename(backup)}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function connect() {
  if (!cfg.server || !cfg.agentKey) throw new Error('Run baton login and baton agent create first.');
  const noMcp = flag('no-mcp');
  const file = settingsFile();
  const settings = readSettings(file);
  settings.hooks ??= {};
  stripBaton(settings.hooks);
  const add = (evt, matcher) => {
    settings.hooks[evt] ??= [];
    settings.hooks[evt].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand(evt), timeout: 5 }] });
  };
  add('SessionStart');
  add('UserPromptSubmit');
  add('PostToolUse'); // every tool: the hook checks for new messages at most every 15 s
  add('Stop');
  writeSettings(file, settings);
  console.log(`Hooks added to ${file}.`);
  if (noMcp) return;
  spawnSync('claude', ['mcp', 'remove', 'baton', '-s', 'user'], { stdio: 'ignore' });
  const r = spawnSync(
    'claude',
    ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'baton', `${cfg.server}/mcp`, '--header', `Authorization: Bearer ${cfg.agentKey}`],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`claude mcp add failed: ${r.stderr || r.stdout || r.error?.message}`);
  console.log('MCP server "baton" added to Claude Code (user scope). New sessions get the brief and the baton_* tools.');
}

function disconnect() {
  const file = settingsFile();
  const settings = readSettings(file);
  if (settings.hooks) {
    stripBaton(settings.hooks);
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeSettings(file, settings);
  }
  if (!flag('no-mcp')) spawnSync('claude', ['mcp', 'remove', 'baton', '-s', 'user'], { stdio: 'ignore' });
  console.log('Baton hooks and MCP server removed.');
}

// ------------------------------------------------------------------ knowledge

function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (/^".*"$/s.test(v)) {
      try {
        v = JSON.parse(v); // YAML double quotes escape like JSON (\" \\)
      } catch {
        v = v.slice(1, -1);
      }
    } else v = v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (name.toLowerCase().endsWith('.md')) files.push(p);
  }
  return files;
}

async function importNotes(folder) {
  const project = flag('project') ?? cfg.project;
  const prefix = String(flag('prefix') ?? 'Imported').replace(/\/+$/, '');
  const match = flag('match');
  if (!folder || !project) throw new Error('Usage: baton import <folder> --project <p> [--prefix Imported] [--match <regex>]');
  const re = match ? new RegExp(String(match), 'i') : null;
  const root = resolve(folder);
  const pages = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    if (re && !re.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    const { meta, body } = frontmatter(text);
    const first = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? '';
    const summary = String(meta.description || first || rel).slice(0, 240);
    const tags = [...(Array.isArray(meta.tags) ? meta.tags : []), 'imported'];
    pages.push({ path: `${prefix}/${rel.replace(/\.md$/i, '')}`, title: String(meta.name ?? basename(rel, '.md')), summary, body: body.trim() || summary, tags });
  }
  if (!pages.length) return out('No matching .md files.');
  let ok = 0;
  for (let i = 0; i < pages.length; i += 50) {
    const r = await api(cfg, 'POST', `/api/projects/${project}/import`, { key: 'user', body: { pages: pages.slice(i, i + 50) }, timeoutMs: 60000 });
    for (const x of r.results) {
      if (x.ok) ok++;
      else console.log(`  skipped ${x.path}: ${x.message}`);
    }
  }
  out(`Imported ${ok} of ${pages.length} notes into ${project}/${prefix}.`);
}

async function skillsPull() {
  const project = flag('project') ?? cfg.project;
  const dest = resolve(String(flag('dest') ?? join(homedir(), '.claude', 'skills')));
  const force = flag('force');
  if (!project) throw new Error('Usage: baton skills pull --project <p>');
  const skills = await api(cfg, 'GET', `/api/projects/${project}/skills`, { key: cfg.agentKey ? 'agent' : 'user' });
  for (const s of skills) {
    const dir = join(dest, s.name);
    const marker = join(dir, '.baton-skill.json');
    if (existsSync(dir) && !existsSync(marker) && !force) {
      console.log(`  skipped ${s.name}: a local skill with that name exists (not from Baton). Use --force to overwrite.`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), s.body);
    for (const [rel, content] of Object.entries(s.files)) {
      const target = resolve(dir, rel);
      if (!target.startsWith(dir)) continue; // no writing outside the skill folder
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(marker, JSON.stringify({ project, version: s.version, pulledAt: new Date().toISOString() }));
    console.log(`  ${s.name} v${s.version}`);
  }
  out(`${skills.length} shared skill${skills.length === 1 ? '' : 's'} from ${project} → ${dest}`);
}

const TEXT_EXT = /\.(md|txt|lua|luau|json|ya?ml|toml|js|mjs|ts|tsx|py|css|html|csv)$/i;

async function skillsPush(folder) {
  const project = flag('project') ?? cfg.project;
  if (!folder || !project) throw new Error('Usage: baton skills push <skill folder> --project <p>');
  const dir = resolve(folder);
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) throw new Error(`${skillMd} not found.`);
  const body = readFileSync(skillMd, 'utf8');
  const { meta } = frontmatter(body);
  const files = {};
  let total = 0;
  const skipped = [];
  for (const file of walkAll(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/');
    if (rel === 'SKILL.md' || rel === '.baton-skill.json') continue;
    const size = statSync(file).size;
    if (!TEXT_EXT.test(rel) || size > 200_000 || total + size > 850_000) {
      skipped.push(rel);
      continue;
    }
    files[rel] = readFileSync(file, 'utf8');
    total += size;
  }
  const name = String(meta.name ?? basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const summary = String(meta.description ?? `Shared skill ${name}`).slice(0, 240);
  const r = await api(cfg, 'POST', `/api/projects/${project}/skills`, { key: 'user', body: { name, body, summary, files }, timeoutMs: 60000 });
  out(`${r.message} ${Object.keys(files).length} extra files.${skipped.length ? ` Not shared (binary or too big): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '…' : ''}` : ''}`);
}

function walkAll(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walkAll(p));
    else files.push(p);
  }
  return files;
}

main().catch((e) => {
  console.error(`baton: ${e.message}`);
  process.exit(1);
});
