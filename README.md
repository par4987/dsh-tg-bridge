# dsh-tg-bridge

> **Español** | Read this in [English](README.en.md)

Puente bidireccional entre [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) y Telegram: cada sesión del harness obtiene su propio hilo en un foro de Telegram, y el hilo es una consola completa del agente — prompts, respuestas en vivo, preguntas con botones, permisos, archivos generados y recordatorios.

Corre **dentro** del proceso del perfil de dsh como bundle Cordis, sobre los puntos de extensión documentados (`session/event`, `agent/assistant-stream`, `Agent.followup()`, los waterfalls `approval/request` y `user-questions/request`) — sin un proceso aparte, sin duplicar estado, y coexiste con la Web UI: lo que escribís en la PC aparece en el hilo y al revés.

## Qué hace

- **Un hilo por sesión**: escribir en el hilo es un prompt; la respuesta se renderiza en vivo (texto, razonamiento, tarjetas de tools, diffs).
- **Señales de vida**: "escribiendo…" mientras el turno corre; los mensajes que mandás mientras trabaja entran como steering en el próximo paso.
- **Reply-context**: responder con reply a un mensaje inyecta la cita en el prompt.
- **Multimedia**: fotos → el agente las ve (attachments del harness); documentos de texto → inline al prompt; binarios → disco con ruta; **notas de voz → transcripción** (whisper.cpp local o cualquier API compatible con OpenAI — opt-in).
- **Archivos generados**: el agente produce un archivo durante un turno y el bot lo entrega solo — foto si es imagen, texto legible si es `.md`/`.txt` chico, documento adjunto en el resto.
- **Preguntas y permisos con botones inline** — respondibles desde el teléfono; el bridge solo reclama las sesiones que espeja, el resto queda para la Web y ACP.
- **Recordatorios** (`/newtask`, `/tasks`, `/taskcancel`) sobre el subsistema Schedule del harness — los crea y borra con el mismo dominio durable que las herramientas model-facing.
- **Navegación desde el teléfono**: `/menu` (tablero), `/sessions` (corpus completo), `/projects` (workspaces con un toque para abrir sesión), `/send` (hablarle a otra sesión), `/files`/`/ffind` (explorar y buscar archivos de la carpeta de la sesión).
- **Inspección**: `/usage` (foto del momento), `/context` (ocupación, compactaciones y último resumen), `/commands` (los del harness, sin modelo), `/perms` (presets con un toque), `/skills`·`/skill`, `/agents`, `/status`, `/delthread`.
- **`/models`**, **`/usagestats`** con tokens por turno y acumulados, **`/ls`**, **`/use`**, **`/history`**, **`/queue`**, **`/clearqueue`**, **`/archive`**, **`/kill`**, **`/find`**.

El manual completo está en [`MANUAL.md`](MANUAL.md) (Español) / [`MANUAL.en.md`](MANUAL.en.md) (English).

## Requisitos

- `dsh` (DeepSeek Harness CLI) con un perfil base-backed: `web`, `headless`, `sdk` o `acp`. El perfil `sdk-minimal` no compone `dsh-base` y el bundle no activa ahí.
- Node `^22.19 || >=24`.
- Un bot de Telegram con **topics habilitados** ([BotFather](https://t.me/BotFather) → `/setinline`? No: `/mybots` → Bot Settings → **Topics in private chats** → Enable). Sin topics el bridge degrada a un chat único.

## Instalación

Desde GitHub (recomendado, con el commit pineado):

```sh
dsh plugin --profile web add github:par4987/dsh-tg-bridge#<sha>
```

La primera vez pnpm rechaza el build del paquete git con un aviso que incluye la **clave exacta** (larga, con la URL de codeload y el sha); copiala en el `pnpm-workspace.yaml` del perfil (`$DSH_HOME/profiles/web/`, por default `~/.dsh/profiles/web/`):

```yaml
allowBuilds:
  "dsh-tg-bridge@https://codeload.github.com/par4987/dsh-tg-bridge/tar.gz/<sha>": true
```

y repetí el `add`. Ese permiso ejecuta el `prepare` del paquete (tsdown) — solo permitilo si confiás en el código, y pineá el commit para que un push posterior no cambie lo que corre.

Alternativa sin permiso de build: clonar, `pnpm install && pnpm run build`, y `dsh plugin --profile web add ./dsh-tg-bridge` (o el tarball de `pnpm pack`).

Verificá la capa y arrancá:

```sh
dsh --profile web --dump-config   # muestra la capa "# == dsh-tg-bridge"
dsh --profile web
```

## Configuración

Todo va en el `cordis.patch.yml` del perfil (o del home), sobre el id `tg-bridge`:

```yaml
- id: tg-bridge
  config:
    mode: live
    allowedUsers: [123456789]   # tu user id de Telegram
    # token: 123456:ABC...       # o la variable de entorno TELEGRAM_BOT_TOKEN
    # workspace: C:/ruta/al/repo # cwd de las sesiones creadas con /new
```

| Campo | Default | Qué hace |
|---|---|---|
| `mode` | `off` | `off` monta el bundle inerte (instalación limpia sin configurar); `dry` registra qué enviaría sin tocar Telegram; `live` enciende el poll |
| `token` | — | Token del bot; si falta, lee `TELEGRAM_BOT_TOKEN` |
| `allowedUsers` | `[]` | Ids de usuario habilitados; vacío es configuración inválida (falla al cargar) |
| `chatId` | primer usuario | Chat del foro (en bots privados con topics, tu propio chat) |
| `stateDir` | `~/.dsh-tg-bridge` | Mapeos, lock del poll, offset, descargas, binarios de STT |
| `workspace` | cwd del proceso | Directorio de las sesiones creadas con `/new` |
| `mirror` | `all` | `all` crea hilo para cada sesión nueva; `watched` solo para las mapeadas |
| `coalesceMs` / `coalesceBusyMs` | `2000` / `8000` | Ventana que une mensajes seguidos en un prompt (idle / busy) |
| `archiveAfterDays` | `0` | Cierra el hilo tras N días sin uso |
| `render.*` | ver `src/config.ts` | `editIntervalMs`, `showDiffs`, `diffMaxLines`, `showReasoning`, `reasoningChars` |
| `locale` | `es` | Idioma del bot (`en` disponible, `/locale` lo cambia en runtime) |
| `debugEvents` | `false` | Loguea cada evento de sesión que ve el renderer |

Arrancá en `dry` para validar sin tocar Telegram; pasá a `live` cuando el log muestre lo que esperás.

## Voz (opcional)

````yaml
# local — whisper.cpp, sin nube ni claves
- id: tg-bridge
  config:
    stt: { provider: local }
````

Bajá `whisper-blas-bin-x64.zip` de las [releases de whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) a `<stateDir>/stt/Release/` y un modelo ggml (p. ej. [ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin)) a `<stateDir>/stt/models/`. Requiere `ffmpeg` en el PATH (decodifica el OGG/Opus de Telegram).

Cloud — cualquier API compatible con OpenAI (Groq, OpenAI, self-hosted); la clave va en la variable de entorno que nombre `stt.apiKeyEnv` (default `STT_API_KEY`):

```yaml
    stt:
      provider: openai-compatible
      baseUrl: https://api.groq.com/openai/v1
      model: whisper-large-v3-turbo
```

Sin `stt`, el bot responde a una nota de voz con las instrucciones para activarla — la feature es opt-in por diseño.

## Perfiles

- **web / desktop**: la combinación natural — el foro espeja las sesiones que abrís en la PC.
- **headless**: el bundle carga y se descarga antes de salir (el poll se aborta en el dispose del árbol); útil para ver en el hilo lo que corrió un one-shot.
- **sdk / acp**: el bridge responde permisos y preguntas solo de las sesiones espejadas; ACP conserva su answerer para sus propios agentes.
- **sdk-minimal**: no compone `dsh-base`; la fila queda inactiva.
- Varios procesos a la vez (web + un headless): un lock en `<stateDir>` elige un único dueño del poll; el resto queda inactivo. Tres 409 seguidos de Telegram entregan el token al otro proceso.

## Desarrollo

```sh
pnpm install
pnpm test        # 50 checks — lógica pura, sin red ni harness
pnpm typecheck   # contra las declaraciones construidas de un checkout del harness
pnpm run build   # tsdown → lib/index.js
```

El typecheck consume el **plano artefacto** del harness: `pnpm exec tsc -b` sobre los paquetes involucrados en el checkout (vendor/cordis, dsh-session, dsh-agent, …) y los `paths` de `tsconfig.json` apuntan a sus `lib/types/*.d.ts`. Editá la ruta del `extends`/`paths` a tu propio clon. El smoke de composición real está en `dev/smoke.patch.yml`.

## Idioma

Español por defecto, inglés con `locale: en` o `/locale en`. Los catálogos están en `src/locale.ts`: un idioma nuevo es un objeto nuevo.

## Licencia

[MIT](LICENSE) © 2026 par4987
