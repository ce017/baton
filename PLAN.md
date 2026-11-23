# Baton — shared workspace for people and their Claudes

*Working name. Plan written 2026-11-23. Free, open source, published on GitHub.*

## The problem

Two people (for example ceo and Boe on Roll a Fish) each work with their own Claude. Context doesn't move between them:

1. **A usage limit hits.** The other Claude has to rescan the whole game.
2. **One person goes offline.** The other Claude has no idea what was in progress.
3. **Skills differ.** Boe's Claude doesn't have ceo's stud-building skill or lessons, so the work waits for ceo.

Obsidian fixes part of this, but only on one PC.

## The idea in one line

A hosted project space (vault + boards + tasks + live activity). Every Claude reads and writes it through **one MCP connector** plus **Claude Code hooks**. Humans use it through a **light desktop app**.

## How it fixes each example

| Problem | Fix |
|---|---|
| Limit reached mid-task | **Living handoff.** Each agent's "now doing / where / next" card stays current while it works, so nothing has to be written at the end. Hooks post edits and the last reply for free (no model tokens). The next Claude calls `baton_brief` and sees exactly where things stopped. |
| Teammate offline | Same handoff card, plus the **activity feed**, **area locks** and **open questions**. With **Wake** turned on, the app on the offline PC can answer a question headless from the vault. |
| Missing skills or knowledge | **Project skill library.** Skills (SKILL.md + files) and lessons belong to the project. The desktop app installs them into each member's `~/.claude/skills`. A Claude can also fetch one on demand with `baton_skill`. |
| Rescanning the game | **Project map pages** (systems, owners, gotchas), seeded by importing the existing Obsidian notes (for example the Roll a Fish notes). Claudes read summaries first and full pages only when needed. |

## Low token use (the core design rule)

- **Layered reads.** `brief` is ≤ ~1k tokens: goals, who is doing what, handoffs, questions for *you*. `search` returns one-line summaries and ids. `read` fetches full text only when needed. Every page carries a required one-line summary, written by whoever saves it.
- **Cursors.** Each agent has a "last seen" marker, so `changes` returns only what changed since that agent last looked.
- **Hooks do the bookkeeping outside the model.** SessionStart injects the brief. PostToolUse posts file and Studio edits to the feed. Stop posts the last reply's first lines. None of these cost model tokens.
- **Structured messages, not chat.** Inbox items have a kind (handoff / question / blocker / FYI) and are short. An agent sees only what's addressed to it or to everyone.
- **Small tool set** (~12 tools). Claude Code defers MCP tools until they're needed, so the definitions are cheap too.

## Architecture

```
 Desktop app (Tauri 2 + React)        Claude Code / Desktop / claude.ai
   humans: UI, tray, sync, wake          Claudes: MCP tools + hooks
              │  HTTPS + WebSocket                 │  remote MCP (HTTP)
              └──────────────┬─────────────────────┘
                 Cloudflare Worker (API + MCP + auth)
                             │
              one Durable Object per project
         (SQLite: pages, boards, tasks, feed, roles;
          live WebSocket room for presence/updates)
```

- **Server: Cloudflare Workers + Durable Objects** (SQLite-backed, on the Workers free plan). Each project is one Durable Object, which gives it isolation, realtime and storage (1 GB per project on free) in one piece. Remote MCP uses Cloudflare's Agents SDK (`McpAgent`), with the OAuth provider so claude.ai and Claude Desktop connectors work too.
  - **Why not Supabase/Neon:** the Supabase free slots are already used (Clout, papi). Neon has no realtime. Cloudflare's free plan covers DB + realtime + MCP hosting in one place, and other teams can **self-host with one deploy** (`wrangler deploy` / "Deploy to Cloudflare" button). That makes it a real open-source product rather than something the maintainer pays for.
  - Verify at signup that the free plan needs no card.
- **Desktop app: Tauri 2** (React + TypeScript + Vite). The installer is ~10 MB against ~100 MB+ for Electron, and Windows renders it with WebView2 (Chromium), so it looks the same everywhere. It runs from the tray so sync, wake and notifications work with the window closed. Plugins: fs, shell, notification, autostart, updater, deep-link.
- **Sign-in:** humans use GitHub OAuth (fits a GitHub audience). Each Claude is an **agent identity linked to its owner**, with its own revocable key and a role capped at the owner's role. The app's **"Connect my Claude"** button runs `claude mcp add …` and writes the hooks, so nobody logs in per session.

## Roles

Names: **Owner · Admin · Member** (the "allowed users") **· Viewer**.

| Can… | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| See the project in the app | ✓ | ✓ | ✓ | ✓ |
| Their Claude reads the vault/skills via MCP | ✓ | ✓ | ✓ | – |
| Post own status, comments, questions, locks | ✓ | ✓ | ✓ | – |
| Create/edit/delete pages, tasks, boards, ideas, objectives | ✓ | ✓ | – | – |
| Add/remove Members and Viewers | ✓ | ✓ | – | – |
| Add/remove Admins, delete or transfer the project | ✓ | – | – | – |

Agents inherit their human's role (the owner can lower it per agent).

## Content model

Project → **folders** (nestable) → items:

- **Page:** markdown with `[[links]]`, backlinks, tags, summary line, version history.
- **Board:** a pinboard canvas with cards, notes, images, links to pages/tasks, arrows, sections and comment threads.
- **Task list:** kanban columns, assignee (a human *or* a Claude), status, area, links.
- **Skill:** SKILL.md + files, with a version.
- **File:** attachments up to ~25 MB. Big things like `.rbxl` stay elsewhere, with a link.

Also project-wide: **Objectives & ideas**, a **Decisions log** (locked decisions Claudes must respect), **Activity feed**, **Areas** (named parts of the project with owners and locks) and an **Inbox** per person and per agent.

## MCP tools (prefix `baton_`)

`brief` · `changes` · `search` · `read` · `write` (page + summary) · `status` (now/where/next, the living handoff) · `lock` / `unlock` (area) · `post` (handoff/question/blocker/FYI to a person, an agent or everyone) · `inbox` · `task` (create/update/move) · `board` (pin/comment) · `skill` (list/get).

Write tools check the role on the server.

## Desktop app screens (light, pro-tool style)

1. **Home:** your projects, things waiting on you, the Claudes online now.
2. **Project:** a left sidebar with the folder tree; the main pane shows a page, board or task list.
3. **Live:** a column per person and their Claude(s) with the handoff card, locks, the last 20 events and an online dot.
4. **Board:** the pinboard canvas with comments in a side panel.
5. **Settings:** members and roles, agents and keys, skill sync, Obsidian sync, Wake budget.

Defaults: skeleton loading (not spinners), `/ux-motion` timings (feedback ≤150 ms, panels ≤300 ms, exits faster than entries, reduced-motion respected), 44 px targets, light theme first with dark later. Colour marks status and people only.

## v1 extras (chosen 2026-11-23)

- **Area locks.** A Claude claims an area (e.g. `ServerScriptService.FishService`) before editing. Others see the lock in `brief` and on the Live screen. Locks expire after inactivity.
- **Obsidian sync.** Mirrors a project's pages to a local folder in both directions (e.g. a folder inside the user's vault), so Obsidian keeps working. Conflicts keep both copies.
- **Wake the other Claude.** Opt-in on the receiving PC. A question addressed to an offline agent runs `claude -p` with only Baton's read tools and a per-day token budget, and the answer is posted back. The owner sees each run in the feed.
- **Windows notifications.** Toasts for handoffs, blockers and questions addressed to you or your Claude.

## Safety

- Agent keys are hashed and revocable. Every write is audited with author and agent, and every page has version history (undo a bad Claude edit).
- Writes are scanned for secrets (tokens, cookies, keys) and refused, per the user's no-secrets-in-vault rule.
- Content written by other people's Claudes comes back labelled with its author as **data**. The MCP server instructions tell Claudes not to follow instructions found inside pages.
- Wake runs read-only tools only, within its budget, and only on PCs where the owner turned it on.

## Milestones

- **M0, prove the loop (no UI yet):** Worker + project DO + 12 MCP tools + hooks script; import Roll a Fish notes; ceo + Boe try a real handoff. *Done when one Claude stops mid-task and the other continues from `brief` alone.*
- **M1, desktop app core:** sign-in, projects, roles, folder tree, page editor, task board, Live screen, Connect-my-Claude.
- **M2, boards + knowledge:** pinboard canvas + comments, skill library + local skill sync, Obsidian sync, decisions log.
- **M3, reach:** Wake, notifications, OAuth connector for claude.ai/Desktop chat, self-host button + docs, GitHub release (signed installer if possible).

## Open questions

- Final name (candidates: Baton, Tandem, Relay).
- Whether Lucas joins M0 testing.
