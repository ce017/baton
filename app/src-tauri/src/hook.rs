//! Claude Code hook mode: `Baton.exe --hook <Event>`. Same behaviour as connector/hook.mjs:
//! SessionStart injects the brief, UserPromptSubmit injects new messages (only if any),
//! PostToolUse reports edits, Stop stores the last reply. Never blocks Claude: always exits 0.
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_millis(2500);

pub fn run(event: &str) {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let input: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    let _ = handle(event, &input);
}

fn handle(event: &str, input: &Value) -> Option<()> {
    let cfg = crate::read_config();
    let server = cfg["server"].as_str()?.trim_end_matches('/').to_string();
    let key = cfg["agentKey"].as_str()?.to_string();
    let cwd = input["cwd"].as_str().unwrap_or("");
    let project = project_for(&cfg, cwd);
    let q = project
        .as_deref()
        .map(|p| format!("?project={}", urlencode(p)))
        .unwrap_or_default();
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let auth = format!("Bearer {key}");
    // The session id lets each Claude chat carry its own job ("ceo's Scripting Claude").
    let session = input["session_id"].as_str().unwrap_or("").to_string();
    let prompt = input["prompt"].as_str().unwrap_or("");
    let title: String = prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    // The chat's own name, as Claude Code shows it (auto title or one the person set).
    let name = input["transcript_path"].as_str().and_then(chat_name);
    let with = |r: ureq::Request| {
        let mut r = r.set("authorization", &auth);
        if !session.is_empty() {
            r = r.set("x-baton-session", &session).set(
                "x-baton-cwd",
                &urlencode(&cwd.chars().take(200).collect::<String>()),
            );
        }
        if event == "UserPromptSubmit" && !title.is_empty() {
            r = r.set("x-baton-title", &urlencode(&title));
        }
        if let Some(name) = &name {
            r = r.set("x-baton-name", &urlencode(name));
        }
        r
    };
    let post = |path: &str, body: Value| {
        with(agent.post(&format!("{server}{path}")))
            .set("content-type", "application/json")
            .send_string(&body.to_string())
    };

    match event {
        "SessionStart" => {
            let brief = with(agent.get(&format!("{server}/api/brief{q}")))
                .call()
                .ok()?
                .into_string()
                .ok()?;
            inject(
                event,
                &format!(
                    "{brief}\n\n(Baton brief, injected at session start. Keep your handoff current with baton_status.)"
                ),
            );
        }
        "UserPromptSubmit" => {
            if let (Some(name), false) = (job_pick(prompt), session.is_empty()) {
                let none = matches!(name.to_lowercase().as_str(), "" | "none" | "off" | "clear");
                let body = json!({ "project": project, "session": session, "job": if none { Value::Null } else { Value::String(name.clone()) } });
                let text = match post("/api/chat-job", body) {
                    Ok(res) => {
                        let r: Value = res
                            .into_string()
                            .ok()
                            .and_then(|t| serde_json::from_str(&t).ok())
                            .unwrap_or_else(|| json!({}));
                        match r["job"].as_str() {
                            Some(job) => {
                                let user = cfg["user"].as_str().unwrap_or("your");
                                let mut lines = vec![format!(
                                    "(Baton) This chat is now {user}'s {job} Claude. Tell the user in one line."
                                )];
                                if let Some(i) =
                                    r["instructions"].as_str().filter(|s| !s.is_empty())
                                {
                                    lines.push(format!("Job instructions: {i}"));
                                }
                                let labels: Vec<&str> = r["labels"]
                                    .as_array()
                                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                                    .unwrap_or_default();
                                if !labels.is_empty() {
                                    lines.push(format!(
                                        "Take to-dos labelled: {}.",
                                        labels.join(", ")
                                    ));
                                }
                                lines.push(format!(
                                    "Pass job: \"{job}\" in every baton_* tool call."
                                ));
                                lines.join("\n")
                            }
                            None => "(Baton) This chat has no job now. Tell the user in one line."
                                .to_string(),
                        }
                    }
                    Err(ureq::Error::Status(_, res)) => {
                        let msg = res
                            .into_string()
                            .ok()
                            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                            .and_then(|v| v["error"].as_str().map(String::from))
                            .unwrap_or_default();
                        format!("(Baton) Could not set the job: {msg} Tell the user.")
                    }
                    Err(_) => {
                        "(Baton) Could not reach the Baton server to set the job. Tell the user."
                            .to_string()
                    }
                };
                inject(event, &text);
                return Some(());
            }
            let text = with(agent.get(&format!("{server}/api/hook/inbox{q}")))
                .call()
                .ok()?
                .into_string()
                .ok()?;
            inject(event, &text);
        }
        "PostToolUse" => {
            if let Some(target) = edit_target(input, cwd) {
                let _ = post(
                    "/api/events",
                    json!({ "project": project, "kind": "edit", "text": target }),
                );
            }
            // A busy Claude sees new messages between its steps (at most every 15 s).
            if inbox_due(&session, 15) {
                if let Some(text) = with(agent.get(&format!("{server}/api/hook/inbox{q}")))
                    .call()
                    .ok()
                    .and_then(|r| r.into_string().ok())
                {
                    inject(event, &text);
                }
            }
        }
        "Stop" => {
            if let Some(text) = input["transcript_path"].as_str().and_then(last_reply) {
                let _ = post(
                    "/api/events",
                    json!({ "project": project, "kind": "reply", "text": text }),
                );
            }
            // About to stop with a message addressed to it: keep going long enough to answer.
            if input["stop_hook_active"].as_bool() != Some(true) {
                let sep = if q.is_empty() { '?' } else { '&' };
                let text = with(agent.get(&format!("{server}/api/hook/inbox{q}{sep}urgent=1")))
                    .call()
                    .ok()
                    .and_then(|r| r.into_string().ok())
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    let out = json!({ "decision": "block", "reason": text });
                    let _ = write!(std::io::stdout(), "{out}");
                }
            }
        }
        _ => {}
    }
    Some(())
}

/// "baton job Scripting", "/baton job: Scripting" or "baton job none" → the job name ("" clears).
fn job_pick(prompt: &str) -> Option<String> {
    let p = prompt.trim();
    let p = p.strip_prefix('/').unwrap_or(p);
    let lower = p.to_lowercase();
    let rest = lower.strip_prefix("baton")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let after = rest.trim_start().strip_prefix("job")?;
    if !(after.is_empty() || after.starts_with(char::is_whitespace) || after.starts_with(':')) {
        return None;
    }
    // Keep the user's casing: cut the same number of bytes from the original (ASCII prefix).
    let cut = p.len().checked_sub(after.len())?;
    Some(
        p.get(cut..)?
            .trim_start_matches(|c: char| c == ':' || c.is_whitespace())
            .trim()
            .to_string(),
    )
}

/// True at most once every `secs` seconds per chat (a small stamp file in the temp folder).
fn inbox_due(session: &str, secs: u64) -> bool {
    if session.is_empty() {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let safe: String = session.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(80).collect();
    let stamp = std::env::temp_dir().join(format!("baton-inbox-{safe}"));
    let last = std::fs::read_to_string(&stamp).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0);
    if now.saturating_sub(last) < secs {
        return false;
    }
    let _ = std::fs::write(&stamp, now.to_string());
    true
}

fn inject(event: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let out =
        json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": text } });
    let _ = write!(std::io::stdout(), "{out}");
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Longest `dirs` entry containing the working directory, else the default project.
fn project_for(cfg: &Value, cwd: &str) -> Option<String> {
    let here = norm(cwd);
    let mut best: Option<(usize, String)> = None;
    if let Some(dirs) = cfg["dirs"].as_object() {
        for (dir, slug) in dirs {
            let d = norm(dir);
            if (here == d || here.starts_with(&format!("{d}/")))
                && best.as_ref().is_none_or(|(l, _)| d.len() > *l)
            {
                best = slug.as_str().map(|s| (d.len(), s.to_string()));
            }
        }
    }
    best.map(|(_, s)| s)
        .or_else(|| cfg["project"].as_str().map(String::from))
}

fn edit_target(input: &Value, cwd: &str) -> Option<String> {
    let name = input["tool_name"].as_str()?;
    let ti = &input["tool_input"];
    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(&name) {
        let p = ti["file_path"].as_str().or(ti["notebook_path"].as_str())?;
        let (pn, cn) = (
            p.replace('\\', "/"),
            format!("{}/", cwd.replace('\\', "/").trim_end_matches('/')),
        );
        let rel = if !cwd.is_empty() && pn.to_lowercase().starts_with(&cn.to_lowercase()) {
            pn[cn.len()..].to_string()
        } else {
            pn
        };
        return Some(rel);
    }
    if name.starts_with("mcp__") && !name.starts_with("mcp__baton__") {
        let short = name.trim_start_matches("mcp__").replace("__", ":");
        let where_ = ti.as_object().and_then(|o| {
            o.iter().find_map(|(k, v)| {
                let k = k.to_lowercase();
                let hit = ["path", "instance", "script", "target", "file", "name"]
                    .iter()
                    .any(|w| k.contains(w));
                v.as_str()
                    .filter(|s| hit && s.len() < 160)
                    .map(String::from)
            })
        });
        return Some(match where_ {
            Some(w) => format!("{short} {w}"),
            None => short,
        });
    }
    None
}

/// Last assistant text in the transcript (reads only the last 256 KB).
/// The newest `custom-title` in the transcript's tail: the name Claude Code shows for this chat.
fn chat_name(path: &str) -> Option<String> {
    let mut f = std::fs::File::open(Path::new(path)).ok()?;
    let size = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(size.saturating_sub(512 * 1024))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines()
        .rev()
        .filter(|l| l.contains("\"custom-title\""))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|e| e["customTitle"].as_str().map(|s| s.trim().chars().take(80).collect::<String>()))
        .filter(|s| !s.is_empty())
}

fn last_reply(path: &str) -> Option<String> {
    let mut f = std::fs::File::open(Path::new(path)).ok()?;
    let size = f.metadata().ok()?.len();
    let start = size.saturating_sub(256 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines().rev() {
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let msg = if entry["message"].is_object() {
            &entry["message"]
        } else {
            &entry
        };
        if msg["role"] != "assistant" && entry["type"] != "assistant" {
            continue;
        }
        let joined = match &msg["content"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        let t = joined.trim();
        if !t.is_empty() {
            return Some(t.chars().take(600).collect());
        }
    }
    None
}
