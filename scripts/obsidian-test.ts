import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(join(tmpdir(), 'baton-obs-'));
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
function scan(root: string, d = root, out: any[] = []) {
  for (const n of readdirSync(d)) { const p = join(d, n); if (n.startsWith('.')) continue; if (statSync(p).isDirectory()) scan(root, p, out); else if (n.endsWith('.md')) out.push({ rel: relative(root, p).split(String.fromCharCode(92)).join("/"), content: readFileSync(p, 'utf8') }); }
  return out;
}
(globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, a: any) => {
  if (cmd === 'vault_scan') return scan(a.folder);
  if (cmd === 'vault_write') { const p = join(a.folder, a.rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, a.content); return null; }
  throw new Error('unexpected ' + cmd);
}, transformCallback: () => 0 } };
const { syncObsidian } = await import('./.local/obsidian.bundle.mjs');
const ceo = JSON.parse(readFileSync('D:/Apps/baton/scripts/.local/ceo.json', 'utf8'));
const boe = JSON.parse(readFileSync('D:/Apps/baton/scripts/.local/boe.json', 'utf8'));
const cfg = { server: ceo.server, userKey: ceo.userKey, user: ceo.user };
const slug = 'obs' + Math.random().toString(36).slice(2, 7);
const api = async (m: string, p: string, b?: any, key = ceo.userKey) => { const r = await fetch(new URL(p, ceo.server), { method: m, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
let fails = 0; const check = (n: string, ok: boolean, d: any = '') => { console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(d)); if (!ok) fails++; };
await api('POST', '/api/projects', { slug, name: 'Obsidian test' });
const P = `/api/projects/${slug}`;
await api('PUT', `${P}/page`, { path: 'Systems/Alpha', body: 'Alpha body. See [[Beta]].', summary: 'Alpha summary' });
await api('PUT', `${P}/page`, { path: 'Beta', body: 'Beta body', summary: 'Beta summary', kind: 'decision' });

let r = await syncObsidian(cfg, slug, 'owner', dir);
check('first sync pulls every note', r.pulled === 2 && existsSync(join(dir, 'Systems/Alpha.md')), r);
check('summary in frontmatter', readFileSync(join(dir, 'Beta.md'), 'utf8').includes('summary: "Beta summary"') && readFileSync(join(dir, 'Beta.md'), 'utf8').includes('baton-kind: decision'));
r = await syncObsidian(cfg, slug, 'owner', dir);
check('nothing to do the second time', r.pulled + r.pushed + r.conflicts === 0, r);

writeFileSync(join(dir, 'Systems/Alpha.md'), readFileSync(join(dir, 'Systems/Alpha.md'), 'utf8').replace('Alpha body.', 'Alpha body, edited in Obsidian.'));
writeFileSync(join(dir, 'Gamma.md'), '# Gamma\nMade in Obsidian.');
r = await syncObsidian(cfg, slug, 'owner', dir);
const alpha = await api('GET', `${P}/page?path=Systems/Alpha`);
const gamma = await api('GET', `${P}/page?path=Gamma`);
check('local edits and new notes go up', r.pushed === 2 && alpha.body.includes('edited in Obsidian') && gamma.summary === 'Gamma', { r, alpha: alpha.body, gamma });
r = await syncObsidian(cfg, slug, 'owner', dir);
check('no echo after pushing', r.pulled + r.pushed + r.conflicts === 0, r);

await api('PUT', `${P}/page`, { path: 'Beta', body: 'Beta body, changed in Baton', summary: 'Beta summary' });
r = await syncObsidian(cfg, slug, 'owner', dir);
check('server edits come down', r.pulled === 1 && readFileSync(join(dir, 'Beta.md'), 'utf8').includes('changed in Baton'), r);

await api('PUT', `${P}/page`, { path: 'Beta', body: 'Beta from Baton again', summary: 'Beta summary' });
writeFileSync(join(dir, 'Beta.md'), readFileSync(join(dir, 'Beta.md'), 'utf8') + '\nMy local line');
r = await syncObsidian(cfg, slug, 'owner', dir);
const copies = readdirSync(dir).filter((n) => n.includes('(conflict'));
check('both changed: Baton wins, a conflict copy keeps yours', r.conflicts === 1 && copies.length === 1 && readFileSync(join(dir, copies[0]), 'utf8').includes('My local line') && readFileSync(join(dir, 'Beta.md'), 'utf8').includes('Baton again'), { r, copies });
r = await syncObsidian(cfg, slug, 'owner', dir);
check('conflict copies are not uploaded', r.pushed === 0 && r.localOnly === 0, r);

// A member gets a read-only copy.
await api('POST', `${P}/members`, { user: boe.user, role: 'member' });
const dir2 = mkdtempSync(join(tmpdir(), 'baton-obs-m-'));
const cfg2 = { server: boe.server, userKey: boe.userKey, user: boe.user };
store.clear();
r = await syncObsidian(cfg2, slug, 'member', dir2);
writeFileSync(join(dir2, 'Gamma.md'), 'member edit');
writeFileSync(join(dir2, 'Delta.md'), 'member note');
r = await syncObsidian(cfg2, slug, 'member', dir2);
const g2 = await api('GET', `${P}/page?path=Gamma`);
check("a member's edits stay local", r.pushed === 0 && r.localOnly === 2 && !g2.body.includes('member edit'), r);
console.log(fails ? `${fails} FAILED` : 'All obsidian checks passed', dir);
