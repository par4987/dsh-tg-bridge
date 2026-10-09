# dsh-tg-bridge

[Read this in **Español**](README.md)

> English

A bidirectional bridge between [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) and Telegram: every harness session gets its own thread in a Telegram forum, and the thread is a full console for the agent — prompts, live answers, questions with buttons, permissions, generated files, and reminders.

It runs **inside** the dsh profile's process as a Cordis bundle, over the documented extension points (`session/event`, `agent/assistant-stream`, `Agent.followup()`, the `approval/request` and `user-questions/request` waterfalls) — no separate process, no duplicated state, and it coexists with the Web UI: what you type on the PC shows in the thread and back.

## What it does

- **One thread per session**: writing in the thread is a prompt; the answer renders live (text, reasoning, tool cards, diffs).
- **Liveness**: "typing…" while the turn runs; messages sent while it works enter as steering at the next step.
- **Reply context**: replying to a message injects the quote into the prompt.
- **Media**: photos → the agent sees them (harness attachments); text documents → inlined into the prompt; binaries → saved to disk with their path; **voice notes → transcription** (local whisper.cpp or any OpenAI-compatible API — opt-in).
- **Generated files**: the agent produces a file during a turn and the bot delivers it by itself — a photo when it is an image, readable text for small `.md`/`.txt`, an attached document otherwise.
- **Questions and permissions as inline keyboards** — answerable from the phone; the bridge claims only the sessions it mirrors, the rest stay with the Web UI and ACP.
- **Reminders** (`/newtask`, `/tasks`) on the harness's Schedule subsystem — created with the same durable domain the model-facing tools use.
- **`/models`**, **`/usagestats`** with per-turn and accumulated tokens, **`/ls`**, **`/use`**, **`/history`**, **`/queue`**, **`/archive`**, **`/kill`**, **`/find`**.

The complete manual lives in [`MANUAL.en.md`](MANUAL.en.md) (English) / [`MANUAL.md`](MANUAL.md) (Español).

## Requirements

- `dsh` (the DeepSeek Harness CLI) with a base-backed profile: `web`, `headless`, `sdk`, or `acp`. The `sdk-minimal` profile does not compose `dsh-base`; the row stays inactive there.
- Node `^22.19 || >=24`.
- A Telegram bot with **topics enabled** (BotFather → `/mybots` → Bot Settings → **Topics in private chats** → Enable). Without topics the bridge degrades to a single chat.

## Installation

From GitHub (recommended, commit-pinned):

```sh
dsh plugin --profile web add github:par4987/dsh-tg-bridge#<sha>
```

The first time, pnpm refuses the git package's build; copy the exact key it prints into the profile's `pnpm-workspace.yaml` (`$DSH_HOME/profiles/web/`, by default `~/.dsh/profiles/web/`):

```yaml
allowBuilds:
  dsh-tg-bridge: true
```

and repeat the `add`. That allowance runs the package's `prepare` (tsdown) — only allow it for code you trust, and pin the commit so a later push cannot silently change what runs.

Build-permission-free alternative: clone, `pnpm install && pnpm run build`, then `dsh plugin --profile web add ./dsh-tg-bridge` (or the tarball from `pnpm pack`).

Verify the layer and boot:

```sh
dsh --profile web --dump-config   # shows the "# == dsh-tg-bridge" layer
dsh --profile web
```

## Configuration

Everything goes into the profile's (or the home's) `cordis.patch.yml`, on the `tg-bridge` id:

```yaml
- id: tg-bridge
  config:
    mode: live
    allowedUsers: [123456789]   # your Telegram user id
    # token: 123456:ABC...       # or the TELEGRAM_BOT_TOKEN environment variable
    # workspace: C:/path/to/repo  # cwd for sessions created with /new
```

| Field | Default | What it does |
|---|---|---|
| `mode` | `dry` | `off` does nothing; `dry` logs what it would send without touching Telegram; `live` starts the poll |
| `token` | — | Bot token; falls back to `TELEGRAM_BOT_TOKEN` |
| `allowedUsers` | `[]` | Enabled user ids; empty is invalid configuration (fails at load) |
| `chatId` | first user | The forum chat (for private-topic bots, your own chat) |
| `stateDir` | `~/.dsh-tg-bridge` | Mappings, the poll lock, offset, downloads, STT binaries |
| `workspace` | process cwd | Directory for sessions created with `/new` |
| `mirror` | `all` | `all` gives every new session a thread; `watched` only the mapped ones |
| `coalesceMs` / `coalesceBusyMs` | `2000` / `8000` | Window merging consecutive messages into one prompt (idle / busy) |
| `archiveAfterDays` | `0` | Close the thread after N idle days |
| `render.*` | see `src/config.ts` | `editIntervalMs`, `showDiffs`, `diffMaxLines`, `showReasoning`, `reasoningChars` |
| `locale` | `es` | The bot's language (`en` available; `/locale` switches at runtime) |
| `debugEvents` | `false` | Log every session event the renderer sees |

Start in `dry` to validate without touching Telegram; switch to `live` when the log shows what you expect.

## Voice (optional)

````yaml
# local — whisper.cpp, no cloud, no keys
- id: tg-bridge
  config:
    stt: { provider: local }
````

Drop `whisper-blas-bin-x64.zip` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) into `<stateDir>/stt/Release/` and a ggml model (e.g. [ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin)) into `<stateDir>/stt/models/`. Requires `ffmpeg` on the PATH (it decodes Telegram's OGG/Opus).

Cloud — any OpenAI-compatible API (Groq, OpenAI, self-hosted); the key lives in the environment variable named by `stt.apiKeyEnv` (default `STT_API_KEY`):

```yaml
    stt:
      provider: openai-compatible
      baseUrl: https://api.groq.com/openai/v1
      model: whisper-large-v3-turbo
```

Without `stt`, a voice note gets the instructions to enable it — the feature is opt-in by construction.

## Profiles

- **web / desktop**: the natural combination — the forum mirrors the sessions you open on the PC.
- **headless**: the bundle loads and disposes before exit (the poll aborts with the tree's dispose); useful to see a one-shot's work in the thread.
- **sdk / acp**: the bridge answers permissions and questions only for mirrored sessions; ACP keeps its answerer for its own agents.
- **sdk-minimal**: does not compose `dsh-base`; the row stays inactive.
- Several processes at once (web + a headless): a lock in `<stateDir>` elects a single poll owner; the rest stay inactive. Three consecutive 409s hand the token to the other process.

## Development

```sh
pnpm install
pnpm test        # 50 checks — pure logic, no network, no harness
pnpm typecheck   # against a harness checkout's built declarations
pnpm run build   # tsdown → lib/index.js
```

Typecheck consumes the harness's **artifact plane**: run `pnpm exec tsc -b` over the involved packages in a checkout (vendor/cordis, dsh-session, dsh-agent, …) and point `tsconfig.json`'s `paths` at their `lib/types/*.d.ts`. Edit the paths to your own clone. The real-composition smoke lives in `dev/smoke.patch.yml`.

## Language

Spanish by default, English with `locale: en` or `/locale en`. Catalogs live in `src/locale.ts`: a new language is a new object.

## License

[MIT](LICENSE) © 2026 par4987
