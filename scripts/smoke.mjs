// End-to-end check against a running server (default: local `wrangler dev`).
//   node scripts/smoke.mjs [http://localhost:8787]
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const SERVER = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = process.env.BATON_ADMIN || /ADMIN_TOKEN=(\S+)/.exec(readFileSync(new URL('../server/.dev.vars', import.meta.url), 'utf8'))?.[1];
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
check('13 baton_ tools (legacy era)', tools.length === 13 && tools.every((t) => t.startsWith('baton_')), tools.join(','));
check('modern era works too', (await b.client.listTools()).tools.length === 13);

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

// ---- Claude jobs (one job per native Claude chat)
{
const mkJob = await rest('POST', `${P}/jobs`, ceo.key, { name: 'Scripting', instructions: 'You write Luau.', labels: ['UI'] });
check('jobs: a person adds a job', mkJob.status === 200 && mkJob.data.jobs?.some((j) => j.name === 'Scripting'), JSON.stringify(mkJob.data));
const agentJob = await rest('POST', `${P}/jobs`, ceoA, { name: 'Sneaky' });
check('jobs: Claudes cannot make jobs', agentJob.status === 403, JSON.stringify(agentJob.data));
const sess = `sess-${tag}-0001`;
const chatHook = (path, init = {}) => fetch(`${SERVER}${path}`, { ...init, headers: { authorization: `Bearer ${ceoA}`, 'x-baton-session': sess, 'x-baton-title': encodeURIComponent('Fix the sell button'), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
const b0 = await (await chatHook(`/api/brief?project=${slug}`)).text();
check('jobs: a new chat has no job yet', !b0.includes('YOUR JOB'), b0.slice(0, 200));
const bad = await (await chatHook('/api/chat-job', { method: 'POST', body: JSON.stringify({ project: slug, session: sess, job: 'Videos' }) })).json();
check('jobs: an unknown job is refused with the list', String(bad.error ?? '').includes('Scripting'), JSON.stringify(bad));
const pick = await (await chatHook('/api/chat-job', { method: 'POST', body: JSON.stringify({ project: slug, session: sess, job: 'scripting' }) })).json();
check('jobs: "baton job scripting" binds the chat', pick.job === 'Scripting' && pick.labels?.[0] === 'UI', JSON.stringify(pick));
const b1 = await (await chatHook(`/api/brief?project=${slug}`)).text();
check("jobs: the chat's brief carries its job", b1.includes('YOUR JOB: Scripting') && b1.includes('Scripting Claude') && b1.includes('You write Luau.'), b1.slice(0, 300));
await chatHook('/api/events', { method: 'POST', body: JSON.stringify({ project: slug, kind: 'edit', text: 'src/Sell.lua' }) });
const ov = (await rest('GET', `${P}/overview`, ceo.key)).data;
check('jobs: the chat shows as its own Claude', ov.live?.some((l) => l.label === `${ceo.name}'s Scripting Claude`), JSON.stringify(ov.live?.map((l) => l.label)));
const viaMcp = await c.call('baton_brief', { project: slug, job: 'Scripting' });
check('jobs: MCP calls carry the job', viaMcp.text.includes('YOUR JOB: Scripting'), viaMcp.text.slice(0, 200));
const list = (await rest('GET', `${P}/jobs`, ceo.key)).data;
check('jobs: the app lists the chat with its job and title', list.chats?.some((x) => x.session === sess && x.job === 'Scripting' && x.title === 'Fix the sell button'), JSON.stringify(list.chats));
const steal = await rest('POST', `${P}/chatjob`, boe.key, { session: sess, job: null });
check("jobs: nobody else changes your chat's job", steal.status === 403, JSON.stringify(steal.data));
const boeList = (await rest('GET', `${P}/jobs`, boe.key)).data;
check('jobs: people only see their own jobs and chats', boeList.jobs?.length === 0 && boeList.chats?.length === 0, JSON.stringify(boeList));
}

// ---- desktop notifications feed
{
  const start = (await rest('GET', `${P}/notices`, ceo.key)).data;
  check('notices: first call only gives the starting point', typeof start.top === 'number' && start.messages.length === 0, JSON.stringify(start));
  await rest('POST', `${P}/post`, boe.key, { to: 'everyone', kind: 'question', text: 'Notice me?' });
  await rest('POST', `${P}/post`, ceo.key, { to: 'everyone', kind: 'fyi', text: 'My own note' });
  const next = (await rest('GET', `${P}/notices?after=${start.top}`, ceo.key)).data;
  check("notices: new messages for you arrive, your own don't", next.messages.length === 1 && next.messages[0].text === 'Notice me?', JSON.stringify(next));
  const again = (await rest('GET', `${P}/notices?after=${start.top}`, ceo.key)).data;
  check('notices: reading them marks nothing read', again.messages.length === 1, JSON.stringify(again));
}

// ---- Wake: start a teammate's Claude on their PC
{
  const off = await rest('POST', `${P}/wake`, ceo.key, { to: boe.name, text: 'Continue T-1' });
  check("wake: refused until they turn it on", off.status === 409, JSON.stringify(off.data));
  const agentOpt = await rest('POST', `${P}/wake-opt`, boeA, { enabled: true });
  check('wake: Claudes cannot turn Wake on', agentOpt.status === 403, JSON.stringify(agentOpt.data));
  await rest('POST', `${P}/wake-opt`, boe.key, { enabled: true });
  const allow = (await rest('GET', `${P}/wakes`, ceo.key)).data;
  check('wake: others see who allows it', allow.allow?.includes(boe.name), JSON.stringify(allow));
  const byAgent = await rest('POST', `${P}/wake`, ceoA, { to: boe.name, text: 'x' });
  check('wake: Claudes cannot wake others', byAgent.status === 403, JSON.stringify(byAgent.data));
  const sent = await rest('POST', `${P}/wake`, ceo.key, { to: boe.name, text: 'Continue T-1 from where you stopped', task: 'T-1' });
  check('wake: a person sends a wake', sent.status === 200 && sent.data.id?.startsWith('W-'), JSON.stringify(sent.data));
  const twice = await rest('POST', `${P}/wake`, ceo.key, { to: boe.name, text: 'again' });
  check('wake: one request at a time', twice.status === 409, JSON.stringify(twice.data));
  const inbox = (await rest('GET', `${P}/wakes`, boe.key)).data;
  check("wake: it waits for the target's PC", inbox.forMe?.[0]?.status === 'pending', JSON.stringify(inbox.forMe));
  const steal = await rest('POST', `${P}/wake-claim`, lucas.key, { id: sent.data.id });
  check('wake: only the target can take it', steal.status === 404, JSON.stringify(steal.data));
  const claim = await rest('POST', `${P}/wake-claim`, boe.key, { id: sent.data.id });
  const claim2 = await rest('POST', `${P}/wake-claim`, boe.key, { id: sent.data.id });
  check('wake: claimed once', claim.status === 200 && claim2.status === 409, JSON.stringify([claim.data, claim2.data]));
  await rest('POST', `${P}/wake-finish`, boe.key, { id: sent.data.id, status: 'done', result: 'Finished the spec for steps 1-3.' });
  const after = (await rest('GET', `${P}/wakes`, ceo.key)).data;
  check('wake: the sender sees the result', after.sent?.[0]?.status === 'done' && after.sent[0].result.includes('spec'), JSON.stringify(after.sent?.[0]));
  const dm = (await rest('GET', `${P}/chat?with=${boe.name}`, ceo.key)).data;
  check("wake: the result arrives as a message from their Claude", dm.some((m) => m.text.includes('Woke up for your request') && m.fromAgent !== undefined), JSON.stringify(dm.slice(-2)));
}

// ---- easy joining: invite links, sign-in links, email adds
{
  const memberMake = await rest('POST', `${P}/invites`, lucas.key, { role: 'member' });
  check('invites: members cannot make invite links', memberMake.status === 403, JSON.stringify(memberMake.data));
  const adminAsAdmin = await rest('POST', `${P}/invites`, boe.key, { role: 'admin' });
  check('invites: only the owner invites admins', adminAsAdmin.status === 403, JSON.stringify(adminAsAdmin.data));
  const made = await rest('POST', `${P}/invites`, ceo.key, { role: 'member', uses: 2, days: 1 });
  const token = made.data.token;
  check('invites: owner makes a 2-use link', made.status === 200 && made.data.url?.endsWith(`/join/${token}`), JSON.stringify(made.data));
  const peek = await fetch(`${SERVER}/api/invites/${token}`).then((r) => r.json());
  check('invites: anyone can see what a link is for', peek.project?.slug === slug && peek.role === 'member' && peek.usesLeft === 2, JSON.stringify(peek));
  const j1 = await fetch(`${SERVER}/api/invites/${token}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Newbie ${tag}` }) }).then((r) => r.json());
  check('invites: joining with a name makes an account', !!j1.key && j1.project === slug && j1.role === 'member', JSON.stringify(j1));
  const newbieMe = (await rest('GET', '/api/me', j1.key)).data;
  check('invites: the new person is in the project', newbieMe.projects?.some((p) => p.slug === slug), JSON.stringify(newbieMe));
  const j2 = await rest('POST', `/api/invites/${token}/join`, vic.key, {});
  check('invites: a signed-in person joins with their own account', j2.status === 200 && j2.data.key === undefined, JSON.stringify(j2.data));
  const j3 = await fetch(`${SERVER}/api/invites/${token}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"late"}' });
  check('invites: used-up links stop working', j3.status === 410, String(j3.status));
  const viaAgent = await rest('POST', `/api/invites/${token}/join`, ceoA, {});
  check('invites: Claude keys cannot join', viaAgent.status === 403 || viaAgent.status === 410, JSON.stringify(viaAgent.data));
  const made2 = await rest('POST', `${P}/invites`, ceo.key, { role: 'viewer', uses: 5 });
  await rest('POST', `${P}/invite-revoke`, ceo.key, { id: made2.data.id });
  const dead = await fetch(`${SERVER}/api/invites/${made2.data.token}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  check('invites: turned-off links stop working', dead.status === 410, String(dead.status));
  const link = await rest('POST', '/api/login-links', ceo.key, {});
  const ltoken = link.data.url?.split('/signin/')[1];
  const ses = await fetch(`${SERVER}/api/login-links/${ltoken}`, { method: 'POST' }).then((r) => r.json());
  const sesMe = (await rest('GET', '/api/me', ses.key)).data;
  check('sign-in links: a one-use link signs in on another device', sesMe.user === ceo.name, JSON.stringify(sesMe));
  const again = await fetch(`${SERVER}/api/login-links/${ltoken}`, { method: 'POST' });
  check('sign-in links: they work once', again.status === 410, String(again.status));
  const byEmail = await rest('POST', `${P}/email-invites`, ceo.key, { email: `someone.${tag}@example.com`, role: 'viewer' });
  const list = (await rest('GET', `${P}/invites`, ceo.key)).data;
  check('email: unknown emails wait for their first Google sign-in', byEmail.data.pending === true && list.emails?.some((e) => e.email === `someone.${tag}@example.com`), JSON.stringify([byEmail.data, list.emails]));
  const cfgRes = await fetch(`${SERVER}/api/config`).then((r) => r.json());
  check('config: tells the app whether Google sign-in is on', typeof cfgRes.google === 'boolean', JSON.stringify(cfgRes));
}

// ---- Claude to-dos, profiles, badges, deleting an account
{
  const added = await c.call('baton_task', { project: slug, action: 'add', title: 'Claude-made to-do', assignee: `${ceo.name}'s Claude` });
  const tid = /T-\d+/.exec(added.text)?.[0];
  check('claude tasks: a Claude adds a to-do', !!tid, added.text);
  const com = await c.call('baton_task', { project: slug, action: 'comment', id: tid, text: 'Started on the receipt part.' });
  check('claude tasks: a Claude comments on a to-do', !com.isError, com.text);
  const got = await c.call('baton_task', { project: slug, action: 'get', id: tid });
  check('claude tasks: get shows notes and comments', got.text.includes('Started on the receipt part.') && got.text.includes(tid), got.text);
  const lu = await mcp(lucasA, false);
  const luAdd = await lu.call('baton_task', { project: slug, action: 'add', title: "Lucas's own to-do", assignee: `${lucas.name}'s Claude` });
  const lid = /T-\d+/.exec(luAdd.text)?.[0];
  check("claude tasks: a member's Claude adds a to-do for itself", !!lid, luAdd.text);
  const luMove = await lu.call('baton_task', { project: slug, action: 'update', id: lid, status: 'doing' });
  check("claude tasks: and moves its own to-do", !luMove.isError, luMove.text);
  const luOther = await lu.call('baton_task', { project: slug, action: 'update', id: tid, status: 'done' });
  check("claude tasks: but not someone else's", luOther.isError, luOther.text);
  const luDel = await lu.call('baton_task', { project: slug, action: 'delete', id: lid });
  check('claude tasks: members cannot delete', luDel.isError, luDel.text);
  const del = await c.call('baton_task', { project: slug, action: 'delete', id: lid });
  check('claude tasks: owners delete to-dos', !del.isError && del.text.includes('Deleted'), del.text);

  const prof = await rest('POST', '/api/me/profile', ceo.key, { display: 'Ceo', about: 'Makes Roll a Fish', color: '#5b8def', status: 'Building' });
  check('profiles: set your own profile', prof.data.display === 'Ceo' && prof.data.color === '#5b8def', JSON.stringify(prof.data));
  const ps = (await rest('GET', `${P}/profiles`, boe.key)).data;
  check('profiles: teammates see it, with earned badges', ps[ceo.name]?.about === 'Makes Roll a Fish' && ps[ceo.name].badges.some((b) => b.id === 'founder'), JSON.stringify(ps[ceo.name]));
  const fake = await rest('POST', '/api/admin/badges', ceo.key, { user: ceo.name, badge: 'staff', label: 'Staff' });
  check('badges: people cannot give themselves badges', fake.status === 401, JSON.stringify(fake.data));
  const real = await rest('POST', '/api/admin/badges', ADMIN, { user: boe.name, badge: 'tester', label: 'Tester' });
  check("badges: the server's host can", real.data.badges?.some((b) => b.id === 'tester' && b.kind === 'host'), JSON.stringify(real.data));

  const temp = await mk('temp');
  await rest('POST', '/api/projects', temp.key, { slug: `tmp${tag}`, name: 'Temp' });
  await rest('POST', `${P}/members`, ceo.key, { user: temp.name, role: 'viewer' });
  const wrong = await rest('POST', '/api/me/delete', temp.key, { confirm: 'nope' });
  check('delete account: needs your name to confirm', wrong.status === 400, JSON.stringify(wrong.data));
  const gone = await rest('POST', '/api/me/delete', temp.key, { confirm: temp.name });
  const after = await rest('GET', '/api/me', temp.key);
  const members = (await rest('GET', `${P}/members`, ceo.key)).data;

  // ---- jobs v2: to-dos go to the job chat whose labels fit; auto jobs queue a run of that exact chat
  const sj = (await rest('GET', `${P}/jobs`, ceo.key)).data.jobs.find((j) => j.name === 'Scripting');
  await rest('POST', `${P}/jobs`, ceo.key, { id: sj.id, name: 'Scripting', instructions: 'You write Luau.', labels: ['UI', 'World'], auto: true });
  await rest('POST', `${P}/jobs`, ceo.key, { name: 'Manager', kind: 'manager', auto: true });
  const routed = await rest('POST', `${P}/tasks`, boe.key, { action: 'add', title: 'Connect the new world to the game' });
  check('jobs v2: a new to-do goes to the job whose label fits', String(routed.data.message ?? routed.data).includes(`${ceo.name}'s Scripting Claude`), JSON.stringify(routed.data));
  const rid = /T-\d+/.exec(String(routed.data.message ?? routed.data))?.[0];
  const j2 = (await rest('GET', `${P}/jobs`, ceo.key)).data;
  const run = j2.dispatches?.find((d) => d.task === rid && d.job === 'Scripting');
  check('jobs v2: an auto job queues a run of that chat', run?.status === 'pending' && run.session === `sess-${tag}-0001`, JSON.stringify(j2.dispatches));
  check('jobs v2: jobs carry role and auto', j2.jobs.some((j) => j.kind === 'manager' && j.auto), JSON.stringify(j2.jobs));
  const unrouted = await rest('POST', `${P}/tasks`, boe.key, { action: 'add', title: 'Buy coffee' });
  check('jobs v2: to-dos with no fitting label stay unassigned', !String(unrouted.data.message ?? unrouted.data).includes('handed'), JSON.stringify(unrouted.data));
  const steal2 = await rest('POST', `${P}/dispatch-claim`, boe.key, { id: run?.id });
  check("jobs v2: nobody else claims your chat's run", steal2.status === 409, JSON.stringify(steal2.data));
  const claim = await rest('POST', `${P}/dispatch-claim`, ceo.key, { id: run?.id });
  const twice = await rest('POST', `${P}/dispatch-claim`, ceo.key, { id: run?.id });
  check('jobs v2: a run is claimed once', claim.status === 200 && twice.status === 409, JSON.stringify([claim.data, twice.data]));
  await rest('POST', `${P}/dispatch-finish`, ceo.key, { id: run?.id, status: 'done', result: 'Wired it up.' });
  const mgrSess = `sess-${tag}-0002`;
  await fetch(`${SERVER}/api/chat-job`, { method: 'POST', headers: { authorization: `Bearer ${ceoA}`, 'x-baton-session': mgrSess, 'content-type': 'application/json' }, body: JSON.stringify({ project: slug, session: mgrSess, job: 'Manager' }) });
  const mb = (await rest('GET', `${P}/jobs`, ceo.key)).data;
  const mgrChat = mb.chats.find((c) => c.session === mgrSess);
  check('jobs v2: a chat can be the manager', mgrChat?.job === 'Manager', JSON.stringify(mb.chats));
  if (mgrChat) {
    await rest('POST', `${P}/tasks`, ceo.key, { action: 'update', id: rid, status: 'done' });
    const mb2 = (await rest('GET', `${P}/jobs`, ceo.key)).data;
    check('jobs v2: finishing a to-do wakes the auto manager', mb2.dispatches.some((d) => d.job === 'Manager' && d.task === rid), JSON.stringify(mb2.dispatches));
  }

  // ---- pictures in notes and messages
  const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
  const pic = await rest('POST', `${P}/images`, ceo.key, { mime: 'image/png', data: dot, name: 'dot' });
  check('pictures: upload gives a markdown link', pic.status === 200 && /^!\[dot\]\(https?:\/\/.+\/i\/[a-z0-9_-]+\/[a-f0-9]{24}\)$/.test(pic.data.markdown ?? ''), JSON.stringify(pic.data));
  const svg = await rest('POST', `${P}/images`, ceo.key, { mime: 'image/svg+xml', data: dot });
  check('pictures: only PNG, JPEG, WebP, GIF', svg.status === 400, JSON.stringify(svg.data));
  const served = await fetch(pic.data.url ?? `${SERVER}/i/x/0`);
  check('pictures: served by link without a key', served.status === 200 && served.headers.get('content-type') === 'image/png', String(served.status));
  const byClaude = await rest('POST', '/api/images', ceoA, { project: slug, mime: 'image/png', data: dot, name: 'render' });
  check('pictures: a Claude uploads from its PC', byClaude.status === 200 && byClaude.data.markdown?.includes(`/i/${slug}/`), JSON.stringify(byClaude.data));

  // ---- delete a project
  const dp = await mk('dp');
  await rest('POST', '/api/projects', dp.key, { slug: `del${tag}`, name: 'Del' });
  await rest('POST', `/api/projects/del${tag}/members`, dp.key, { user: boe.name, role: 'admin' });
  const notOwner = await rest('POST', `/api/projects/del${tag}/delete`, boe.key, { confirm: `del${tag}` });
  check('delete project: only the owner', notOwner.status === 403, JSON.stringify(notOwner.data));
  const noConfirm = await rest('POST', `/api/projects/del${tag}/delete`, dp.key, { confirm: 'x' });
  check('delete project: needs the name typed', noConfirm.status === 400, JSON.stringify(noConfirm.data));
  const delP = await rest('POST', `/api/projects/del${tag}/delete`, dp.key, { confirm: `del${tag}` });
  const boeMe = (await rest('GET', '/api/me', boe.key)).data;
  const gone2 = await rest('GET', `/api/projects/del${tag}/overview`, dp.key);
  check('delete project: gone for everyone', delP.status === 200 && !boeMe.projects.some((p) => p.slug === `del${tag}`) && gone2.status === 404, JSON.stringify([delP.data, gone2.status]));
  check('delete account: removes the person, their projects and memberships', gone.data.deletedProjects === 1 && after.status === 401 && !members.some((m) => m.name === temp.name), JSON.stringify([gone.data, after.status]));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
