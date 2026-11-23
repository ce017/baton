// End-to-end check against a running server (default: local `wrangler dev`).
//   node scripts/smoke.mjs [http://localhost:8787]
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const SERVER = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = /ADMIN_TOKEN=(\S+)/.exec(readFileSync(new URL('../server/.dev.vars', import.meta.url), 'utf8'))?.[1];
const tag = Math.random().toString(36).slice(2, 7);
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failed++;
}

async function rest(method, path, key, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

async function mcp(key, modern) {
  const client = new Client(
    { name: 'smoke', version: '0' },
    { capabilities: {}, ...(modern ? { versionNegotiation: { mode: 'auto' } } : {}) },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content[0]?.text ?? '', isError: r.isError === true };
    },
  };
}

// ---- people, project, roles
const mk = async (n) => (await rest('POST', '/api/admin/users', ADMIN, { name: `${n}${tag}` })).data;
const ceo = await mk('ceo');
const boe = await mk('boe');
const lucas = await mk('lucas');
const vic = await mk('vic');
check('admin creates users', ceo.key?.startsWith('bt_u_') && boe.key, JSON.stringify(ceo));

const slug = `raf${tag}`;
const proj = await rest('POST', '/api/projects', ceo.key, { slug, name: 'Roll a Fish' });
check('owner creates project', proj.status === 200, JSON.stringify(proj.data));

const addBoe = await rest('POST', `/api/projects/${slug}/members`, ceo.key, { user: boe.name, role: 'admin' });
check('owner adds an admin', addBoe.status === 200, JSON.stringify(addBoe.data));
const boeAddsAdmin = await rest('POST', `/api/projects/${slug}/members`, boe.key, { user: lucas.name, role: 'admin' });
check('admin cannot add admins', boeAddsAdmin.status === 403, JSON.stringify(boeAddsAdmin.data));
const boeAddsMember = await rest('POST', `/api/projects/${slug}/members`, boe.key, { user: lucas.name, role: 'member' });
check('admin adds a member', boeAddsMember.status === 200, JSON.stringify(boeAddsMember.data));
await rest('POST', `/api/projects/${slug}/members`, boe.key, { user: vic.name, role: 'viewer' });
const boeRemovesCeo = await rest('POST', `/api/projects/${slug}/members`, boe.key, { user: ceo.name, role: 'none' });
check("nobody changes the owner's role", boeRemovesCeo.status === 403, JSON.stringify(boeRemovesCeo.data));

const agent = async (u) => (await rest('POST', '/api/agents', u.key, { name: 'Claude' })).data.key;
const ceoA = await agent(ceo);
const boeA = await agent(boe);
const lucasA = await agent(lucas);
const vicA = await agent(vic);
check('agent keys', ceoA?.startsWith('bt_a_') && boeA, ceoA);

// ---- MCP, both protocol eras
const c = await mcp(ceoA, false);
const b = await mcp(boeA, true);
const l = await mcp(lucasA, false);
const v = await mcp(vicA, true);
const tools = (await c.client.listTools()).tools.map((t) => t.name);
check('12 baton_ tools (legacy era)', tools.length === 12 && tools.every((t) => t.startsWith('baton_')), tools.join(','));
check('modern era works too', (await b.client.listTools()).tools.length === 12);

let r = await c.call('baton_brief');
check('brief for a single-project agent', r.text.includes('Roll a Fish') && r.text.includes('(owner)'), r.text);

r = await c.call('baton_status', { doing: 'Refactoring the fish sell flow', where: 'ServerScriptService.FishSellerService', next: 'Wire SellAll to the new price table' });
check('status set', !r.isError, r.text);
r = await c.call('baton_lock', { area: 'ServerScriptService.FishSellerService', note: 'sell refactor' });
check('lock taken', !r.isError, r.text);
r = await b.call('baton_lock', { area: 'serverscriptservice.fishsellerservice' });
check('lock conflict for another Claude (case-insensitive)', r.isError && r.text.includes('locked by'), r.text);

r = await c.call('baton_write', {
  path: 'Systems/FishSeller',
  summary: 'How selling works: FishSellerService prices, sell-all, Finn NPC prompt',
  body: '# Fish seller\nFinn has one "Talk & Sell" prompt. Prices come from [[Defs/FishDex]].',
  tags: ['economy'],
});
check('owner writes a page', !r.isError && r.text.includes('v1'), r.text);
r = await c.call('baton_write', { path: 'Notes/keys', summary: 'x', body: 'ROBLOX key: _|WARNING:-DO-NOT-SHARE-THIS.--abc' });
check('secrets refused', r.isError && r.text.includes('Refused'), r.text);
r = await l.call('baton_write', { path: 'Notes/x', summary: 'x', body: 'y' });
check('member cannot write pages', r.isError && r.text.includes('Not allowed'), r.text);
r = await l.call('baton_board', { action: 'comment', target: 'Systems/FishSeller', text: 'Does sell-all skip favourites?' });
check('member can comment', !r.isError, r.text);
r = await v.call('baton_brief');
check("viewer's Claude is refused", r.isError, r.text);

r = await c.call('baton_write', { path: 'Decisions/Odds', kind: 'decision', summary: 'Legendary 0.5%, Mythic 0.06%, Secret 0.02%; pity 200/800', body: 'Locked 2026-11-04.' });
check('decision recorded', !r.isError, r.text);
r = await c.call('baton_task', { action: 'add', title: 'Sell-all skips favourited fish', area: 'FishSellerService', assignee: "ceo's Claude", status: 'doing' });
check('task added', r.text.startsWith('Added T-1'), r.text);
r = await c.call('baton_board', { action: 'pin', kind: 'important', text: 'Back up a script to ServerStorage before editing it', ref: 'Systems/FishSeller' });
check('pin added', r.text.includes('P-1'), r.text);
r = await c.call('baton_skill', { action: 'put', name: 'stud-building', summary: 'How we build stud-style models', body: '---\nname: stud-building\n---\nUse rib chains for curves.', files: { 'lessons.md': '1. Flat tilted slabs read as awnings.' } });
check('skill shared', !r.isError, r.text);
r = await b.call('baton_skill', { action: 'get', name: 'stud-building', file: 'lessons.md' });
check("another Claude reads the skill's file", r.text.includes('awnings'), r.text);

r = await c.call('baton_post', { to: boe.name, kind: 'question', text: 'Can you take T-1 while I train?' });
check('post to a member', !r.isError, r.text);
const hook = await rest('GET', '/api/hook/inbox', boeA);
check('hook inbox delivers it once', String(hook.data).includes('Can you take T-1'), JSON.stringify(hook.data));
const hook2 = await rest('GET', '/api/hook/inbox', boeA);
check('hook inbox is empty after delivery (no tokens)', hook2.data === '', JSON.stringify(hook2.data));

for (const f of ['src/a.lua', 'src/b.lua', 'src/a.lua']) await rest('POST', '/api/events', ceoA, { kind: 'edit', text: f });
await rest('POST', '/api/events', ceoA, { kind: 'reply', text: 'Finished SellAll wiring; next is the favourites check.' });

r = await b.call('baton_brief');
check('brief shows the other handoff', r.text.includes('Refactoring the fish sell flow') && r.text.includes("ceo" + tag + "'s Claude"), r.text);
check('brief shows the lock', r.text.includes('LOCKS') && r.text.includes('FishSellerService'), r.text);
check('brief shows decisions and tasks', r.text.includes('DECISIONS') && r.text.includes('T-1'), r.text);
check('brief shows the last reply', r.text.includes('Finished SellAll wiring'), r.text);
const tokens = Math.round(r.text.length / 4);
check(`brief stays small (~${tokens} tokens)`, tokens < 1200, String(tokens));

r = await b.call('baton_changes');
check('changes lists others\' work, edits merged', r.text.includes('edited src/a.lua, src/b.lua') && !r.text.includes('src/a.lua, src/b.lua, src/a.lua'), r.text);
r = await b.call('baton_changes');
check('changes cursor advances', r.text.startsWith('Nothing changed'), r.text);

r = await b.call('baton_search', { query: 'sell favourites' });
check('search finds the page and task', r.text.includes('Systems/FishSeller') && r.text.includes('T-1'), r.text);
r = await b.call('baton_read', { path: 'systems/fishseller' });
check('read shows body, author and comments', r.text.includes('Talk & Sell') && r.text.includes('Does sell-all skip'), r.text);

r = await b.call('baton_lock', { area: 'ServerScriptService.FishSellerService', force: true });
check('admin can force a lock', !r.isError, r.text);
r = await b.call('baton_task', { action: 'update', id: 'T-1', status: 'done' });
check('task moved', r.text.includes('Moved T-1 to done'), r.text);

// ---- desktop app endpoints
const P = `/api/projects/${slug}`;
const ov = await rest('GET', `${P}/overview`, ceo.key);
check('app: overview', ov.status === 200 && ov.data.role === 'owner' && ov.data.live.some((c) => c.isAgent && c.doing), JSON.stringify(ov.data).slice(0, 300));
const tree = await rest('GET', `${P}/tree`, lucas.key);
check('app: tree has no bodies', tree.status === 200 && tree.data.some((t) => t.path === 'Systems/FishSeller') && !('body' in tree.data[0]), JSON.stringify(tree.data).slice(0, 200));
const pg = await rest('GET', `${P}/page?path=${encodeURIComponent('Systems/FishSeller')}`, vic.key);
check('app: a viewer can read a page in the app', pg.status === 200 && pg.data.comments.length === 1, JSON.stringify(pg.data).slice(0, 200));
const vw = await rest('PUT', `${P}/page`, vic.key, { path: 'X/y', body: 'b', summary: 's' });
check('app: a viewer cannot write', vw.status === 403, JSON.stringify(vw.data));
const tk = await rest('POST', `${P}/tasks`, boe.key, { action: 'add', title: 'From the app' });
check('app: admin adds a task', tk.status === 200 && tk.data.message.startsWith('Added'), JSON.stringify(tk.data));
const ticket = (await rest('POST', `${P}/ticket`, lucas.key)).data.ticket;
const got = await new Promise((resolve) => {
  const ws = new WebSocket(`${SERVER.replace('http', 'ws')}${P}/live?ticket=${ticket}`);
  ws.onopen = () => rest('POST', `${P}/comment`, lucas.key, { target: 'T-1', text: 'live?' });
  ws.onmessage = (e) => { ws.close(); resolve(String(e.data)); };
  ws.onerror = () => resolve('error');
  setTimeout(() => resolve('timeout'), 4000);
});
check('app: live socket hears changes', got.includes('"changed"'), got);
const reuse = await new Promise((resolve) => {
  const ws = new WebSocket(`${SERVER.replace('http', 'ws')}${P}/live?ticket=${ticket}`);
  ws.onopen = () => { ws.close(); resolve('opened'); };
  ws.onerror = () => resolve('refused');
  setTimeout(() => resolve('timeout'), 4000);
});
check('app: tickets work once', reuse === 'refused', reuse);
const cors = await fetch(`${SERVER}${P}/overview`, { headers: { authorization: `Bearer ${ceo.key}`, origin: 'https://evil.example' } });
check('app: other sites are refused', cors.status === 403, String(cors.status));

// ---- chat view
const convs = (await rest('GET', `${P}/conversations`, boe.key)).data;
const withCeo = convs.find((c) => c.key === ceo.name);
check('chat: conversation list has Everyone and a direct chat with unread', convs[0]?.key === 'everyone' && withCeo?.unread >= 1, JSON.stringify(convs));
const thread = (await rest('GET', `${P}/chat?with=${ceo.name}`, boe.key)).data;
check('chat: direct thread holds the question', thread.some((m) => m.text.includes('Can you take T-1') && m.fromAgent), JSON.stringify(thread).slice(0, 300));
const convs2 = (await rest('GET', `${P}/conversations`, boe.key)).data;
check('chat: opening it marks it read', convs2.find((c) => c.key === ceo.name)?.unread === 0, JSON.stringify(convs2));
const mineThread = (await rest('GET', `${P}/chat?with=${boe.name}`, ceo.key)).data;
check("chat: the sender sees their own (their Claude's) message as theirs", mineThread.some((m) => m.mine && m.text.includes('Can you take T-1')), JSON.stringify(mineThread).slice(0, 300));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
