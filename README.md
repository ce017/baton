# Baton

A shared workspace for people **and their Claudes**. When your Claude hits a usage limit, or you log off, your teammate's Claude picks up exactly where yours stopped, without rescanning the project or asking you.

- **Living handoffs.** Every Claude keeps a "doing / where / next" card current. Hooks also record what it edited and what it last said, so even a Claude cut off mid-sentence leaves a trail.
- **Shared vault.** Markdown pages with one-line summaries. Claudes search summaries first and read full pages only when they need them.
- **Locks, tasks, pinboards, decisions and a message inbox** for people and Claudes.
- **Shared skills.** A project's skills are installed on every member's PC, so everyone's Claude has the same know-how.
- **Roles.** Owner, Admin, Member (read + post/comment/lock) and Viewer.
- **Cheap on tokens.** The session brief is ~300–1,000 tokens. The bookkeeping runs in hooks, outside the model, and messages are injected only when there are some.

## Get started

1. Download **Baton for Windows** from [Releases](https://github.com/ce017/baton/releases/latest), or just use it in the browser at https://baton.baton-server.workers.dev.
2. Open the invite link your team sent you (or sign in with Google), pick a name, and you're in.
3. In **Team**, press **Connect to Claude Code**. Your Claude now gets the brief, messages and to-dos on its own.

Want to invite people? In **Team** make an invite link (choose the role, how many uses and how long it lasts) or add them by email. Baton tells you when a new version is out.

Also in v0.2: Claude jobs (one job per Claude chat), Wake (start a teammate's Claude when they're away, opt-in), Obsidian sync, Windows notifications and a tray icon.

## Desktop app

```bash
npm run dev -w app                 # the UI in a browser at localhost:5173 (talks to the server)
cd app && npx tauri dev            # the real window
cd app && npx tauri build          # → src-tauri/target/release/Baton.exe and an NSIS installer
```

The app shares `~/.baton/config.json` with the CLI. **Connect to Claude Code** adds the MCP server and four hooks that run `Baton.exe --hook <Event>`, so Node isn't needed on the PC.

## How it fits together

```
Claude Code ──MCP (baton_* tools)──┐
   └─hooks (brief, inbox, edits)───┤
                                   ├── Cloudflare Worker ── one Durable Object per project (SQLite)
baton CLI / desktop app ──REST─────┘
```

The server runs on the **Cloudflare Workers free plan**. Each team deploys its own copy.

## Run your own server

```bash
npm install
cd server
npx wrangler login                  # once, opens the browser
npx wrangler deploy                 # prints https://baton.<you>.workers.dev
npx wrangler secret put ADMIN_TOKEN # any long random string; only used to create people
```

Local development: put `ADMIN_TOKEN=<anything>` in `server/.dev.vars`, run `npm run dev`, then `npm test` (an end-to-end check against `localhost:8787`).

## Connect people and their Claudes

The server admin creates each person once:

```bash
node connector/cli.mjs init --server https://baton.<you>.workers.dev --admin-token <ADMIN_TOKEN> --user ceo
```

`init` saves the person's user key in `~/.baton/config.json`. For someone else, send them the printed key privately; they run `baton login --server <url> --key <bt_u_…>`.

Then on each PC:

```bash
node connector/cli.mjs project create roll-a-fish "Roll a Fish"   # the owner, once
node connector/cli.mjs member roll-a-fish boe admin               # owner: admins; admins: members/viewers
node connector/cli.mjs agent create Claude                        # a key for this PC's Claude
node connector/cli.mjs use roll-a-fish
node connector/cli.mjs connect                                    # adds the MCP server + hooks to Claude Code
```

`connect` backs up `~/.claude/settings.json` before adding the hooks. `disconnect` removes them again.

## Bring your knowledge

```bash
node connector/cli.mjs import "<obsidian vault>/Notes" --project roll-a-fish --prefix Imported --match "^raf-"
node connector/cli.mjs skills push ~/.claude/skills/stud-building --project roll-a-fish
node connector/cli.mjs skills pull --project roll-a-fish          # teammates install the shared skills
```

Writes that look like secrets (tokens, cookies, keys) are refused.

## The tools Claude sees

`baton_brief` · `baton_changes` · `baton_search` · `baton_read` · `baton_write` · `baton_status` · `baton_lock` · `baton_post` · `baton_inbox` · `baton_task` · `baton_board` · `baton_skill`

## Safety notes

- Keys are stored hashed on the server. `baton agent rotate` replaces a Claude's key.
- Every page edit keeps its earlier version.
- Content written by other members is returned to Claude labelled as notes, not instructions.
- Viewers' Claudes can't use a project. Members' Claudes can read, post, comment, lock and set their status, but can't change pages, tasks, boards or skills.
