#!/usr/bin/env node
// Writes latest.json for the in-app updater, next to the signed installer.
// Build first with the signing key set (it never goes in the repo):
//   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/baton-updater.key -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
//   npm run tauri build -w app
// Then: node scripts/release-json.mjs "Short notes for the update bar"
// Upload the installer, its .sig and latest.json to the GitHub release v<version>.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'app/src-tauri/tauri.conf.json'), 'utf8')).version;
const dir = join(root, 'app/src-tauri/target/release/bundle/nsis');
const exe = `Baton_${version}_x64-setup.exe`;
const sig = join(dir, `${exe}.sig`);
if (!existsSync(sig)) throw new Error(`${sig} not found: build with TAURI_SIGNING_PRIVATE_KEY set first.`);

const latest = {
  version,
  notes: process.argv[2] ?? `Baton ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/ce017/baton/releases/download/v${version}/${exe}`,
    },
  },
};
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Wrote ${join(dir, 'latest.json')} for v${version}. Upload ${exe}, ${exe}.sig and latest.json to the release.`);
