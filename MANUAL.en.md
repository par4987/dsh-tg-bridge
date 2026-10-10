# Manual — dsh-tg-bridge

[Read this in **Español**](MANUAL.md)

> English

## The forum

Every harness session is a thread. What you write in the thread is a prompt for that session; the answer arrives in the same thread, rendered live. With topics enabled, a new session (opened on the PC or created with `/new`) gets its own thread titled after its first message; without topics, everything lives in a single chat and every message carries the title as a header.

Messages arriving while the agent works are not lost: they enter as steering at the next step of the running turn, with a notice in the thread.

Replying to a Telegram message attaches the quote to the prompt — useful to revisit a point of a long answer without copying and pasting.

## Commands

Write them in any thread (they act on that session) or at the chat root (they act on the session `/use` points to).

### `/help`
The command list, one line each.

### `/new [path]`
Creates a new session. The path is the working directory (absolute, or relative to the configured `workspace`); without an argument it uses `workspace`. The thread is created with the first message.

### `/ls`
The mapped sessions: short id, title, a green dot when live in this process, 📦 when archived. Sorted by last use.

### `/use <id|prefix>`
Points the chat root at a session: what you write without a thread goes to that session. `/detach` unpoints the root.

### `/models`
The registered model routes as **buttons**: one tap pins the route for that session's next request (afterwards the logged header rules again — one tap switches, it does not fight the log).

### `/usagestats`
The session's tokens: last turn and accumulated, plus context occupancy (`used / window`) when the token-meter is composed.

### `/queue`
The session's inbox: messages waiting for their own turn and steering waiting for the next step.

### `/flush`
Sends the coalescing buffers now — the messages you were assembling with quick consecutive sends.

### `/history [n]`
The session's last `n` exchanges (default 8), read from the durable log. Only sessions live in this process or resumable.

### `/find <text>`
Finds sessions by title or id.

### `/archive` / `/unarchive`
Deletes the session's thread (clearing the thread mapping, keeping title/usage/archived) and `/unarchive` recreates a fresh one — the same semantics as your opencode-tg in private chats, where closing topics does not apply.

With `archiveAfterDays > 0` deletion is **automatic**: the poll owner sweeps every mapping on each election tick and deletes the threads of sessions idle longer than that many days. The sweep runs only in the leading process (one owner for the deletion) and honors a grace period — a mapping younger than the window is left alone, so `/rebuild` may import old sessions without the next tick deleting their fresh thread.

Writing to an archived session — through the chat root or `/sh` — **revives** it: the flag drops and the thread is recreated. Silence lasts only until someone talks to it again.

### `/kill`
Cancels the session's running turn.

### `/tasks`
The session's durable reminders (the harness's Schedule subsystem). If the profile does not compose Schedule, it says so honestly.

### `/newtask`
The reminder wizard, step by step and persisted (a restart cannot eat it): name → prompt → type (once / daily / weekly / every N minutes) → detail (`2026-12-01 09:00`, `09:00`, `mon 09:00`, or a number) → confirmation. `… cancel` aborts. The reminder is created with the same durable domain the model uses, so the Web sees it too and it survives restarts; when it fires, it arrives as one more turn of the session with a `⏰` notice in the thread.

### `/locale es|en`
Switches the bot's language and persists it.

### `/rebuild [days]`
Brings persisted sessions with real activity inside the window (default 7 days, configurable via `rebuildDays`) to Telegram: title from the log (`sessionQuery.readTitle`), fresh thread, mapping. It never duplicates already-mapped sessions and creates at most 12 threads per run, newest first. This is the command for populating the forum with the harness's existing history.

### `/running`
Sessions with a turn in flight in this process.

### `/export`
The session's durable log as a `.jsonl` document (raw events, exported through `sessionQuery.readSession`).

### `/rename <title>`
Pins the title through the official `session/title` event with a `user` source — the Web sees it too, and automatic title generation stops rescheduling. The Telegram thread renames with it.

### `/note <text>`
A silent note into the transcript (`agent.inject()`): the agent sees it on its next turn, without waking now.

### `/sh <command>`
Asks the agent to run exactly that command with its shell tool. Deliberately different from opencode-tg: the harness requires everything the model sees to be in the log, and running shell outside it would break that — this way it also goes through the profile's sandbox and permissions.

### `/compact`
Manual history compaction through the official seam (`ctx.compaction.compactNow`). The summary lands in the transcript; the Web sees it.

### `/txt <text>`
Answers with free text the question waiting for it (same as tapping "✍️ Other" and typing).

## Questions and permissions

When the agent asks for a decision — the `ask_user_question` tool, or a permission the profile's policy marks `ask` — the thread gets a card with buttons:

- **Questions**: one card per question; a tap chooses, in multi-select you tap several and confirm; "✍️ Other" arms a free answer: the thread's next message becomes the answer (nothing else reaches the agent).
- **Permissions**: ✅ allow once / ✖ reject. "Always" is harness policy (permission presets), not a chat button — by design, one tap on the phone never institutionalizes a permission.

If the question was already answered on the PC, the tap gets "no longer pending" and sends nothing.

## Media

- **Photo**: downloads the largest size, admits it through the harness attachment store, and the model sees it. When the model does not accept images (or there is no store), it stays on disk with its path in the prompt.
- **Document**: text ones (code, config, markdown) ride inline in the prompt up to 100k characters, with a 📄 receipt in the thread; binaries go to the attachment store as a file block, or to disk with their path when the store refuses files.
- **Voice note**: transcribed (when you configured `stt`) and the text becomes the prompt; without `stt`, the bot explains how to enable it. An empty transcription gets a notice and never bothers the agent.
- **Video**: to disk with its path.

## Generated files

When a turn ends, the bridge scans the file paths that appeared in tool calls and results, and delivers the ones the agent created or touched: images as photos, small `.md`/`.txt` as readable messages, the rest as documents. Only from the current turn, only paths that exist.

## Deleted threads and restarts

- Deleting a thread from the phone no longer breaks the bridge: the first send to the dead thread gets "message thread not found", the bridge drops the mapping and retries at the root; the next event rebuilds the thread.
- Restarting the profile loses no sessions: mappings persist in `<stateDir>/state.json` and a persisted session resumes on its first message. A session closed on the PC and not persisted answers with the honest notice from `/ls`.
- Two processes with the bundle (the web and a headless): the `<stateDir>` lock elects one poll owner; the other stays inactive and takes the seat when the owner dies or freezes.

## Voice — setup

1. **Local**: `stt: { provider: local }` + drop `whisper-cli` and a ggml model into `<stateDir>/stt/` (see the README) + `ffmpeg` on the PATH.
2. **Cloud**: `stt: { provider: openai-compatible, baseUrl: …, model: … }` and the key in the `STT_API_KEY` environment variable (or whichever `apiKeyEnv` names).

## State and privacy

- All bridge state lives in `<stateDir>` (default `~/.dsh-tg-bridge`): mappings, the lock, the poll offset, downloads, and STT binaries. Nothing leaves your machine except what the Telegram bot itself sends.
- The bot token never lands in versioned configuration files: it goes through `token` in your local `cordis.patch.yml` or through `TELEGRAM_BOT_TOKEN`.
- `allowedUsers` is mandatory: a bot without a list answers anyone who finds it, and the bridge refuses to load that way.
