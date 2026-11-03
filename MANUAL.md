# Manual — dsh-tg-bridge

> **Español** | Read this in [English](MANUAL.en.md)

## El foro

Cada sesión del harness es un hilo. Lo que escribís en el hilo es un prompt para esa sesión; la respuesta llega al mismo hilo, renderizada en vivo. Si el bot tiene topics habilitados, una sesión nueva (creada desde la PC o con `/new`) obtiene su hilo con el título aprendido del primer mensaje; sin topics, todo vive en un único chat y cada mensaje lleva el título como encabezado.

Mensajes que llegan mientras el agente trabaja no se pierden: entran como steering al próximo paso del turno en curso, con un aviso en el hilo.

Responder con reply a un mensaje de Telegram agrega la cita al prompt — útil para retomar un punto de una respuesta larga sin copiar y pegar.

## Comandos

Escribilos en cualquier hilo (actúan sobre esa sesión) o en la raíz del chat (actúan sobre la sesión apuntada por `/use`).

### `/help`
Un botón por comando; cada uno abre la sección de ese comando en este mismo manual (la que estás leyendo, embarcada con el paquete), renderizada para Telegram, con "⬅️" para volver a la lista.

### `/new [ruta|título]`
Crea una sesión nueva:

- **`/new <ruta absoluta>`** — la crea en esa carpeta directamente.
- **`/new <título>`** — abre el picker de carpetas (los workspaces más recientes y el configurado); un toque crea la sesión ahí, y **nace con su título** — el hilo se abre ya nombrado.
- **`/new`** — pide el título en el hilo (10 min para contestarlo) y sigue con el picker. Cuando solo hay una carpeta posible (sin registry), crea en el workspace sin preguntar.

### `/ls`
Las sesiones mapeadas: id corto, título, punto verde si está activa en este proceso, 📦 si está archivada. Ordenadas por último uso.

### `/use <id|prefijo>`
Apunta la raíz del chat a una sesión: lo que escribas sin hilo va a esa sesión. `/detach` desacopla la raíz.

### `/models`
Las rutas de modelo registradas como **botones**: un toque fija la ruta para el próximo request de esa sesión (después vuelve a mandar el header registrado — un toque cambia, no pelea con el log).

### `/usagestats`
Tokens de la sesión: el último turno y el acumulado, más la ocupación de contexto (`usados / ventana`) cuando el token-meter está compuesto.

### `/queue`
El inbox de la sesión: mensajes esperando su propio turno y steering esperando el próximo paso.

### `/flush`
Envía ahora los buffers de coalescing — los mensajes que estás armando con envíos rápidos seguidos.

### `/history [n]`
Los últimos `n` intercambios (default 8) de la sesión, leídos del log durable. Solo sesiones activas en el proceso o retomables.

### `/find <texto>`
Busca sesiones por título o id.

### `/archive` / `/unarchive`
Borra el hilo de la sesión (y limpia el mapeo de thread, conservando título/uso/archivada) y `/unarchive` lo recrea nuevo — misma semántica que tu opencode-tg en chats privados, donde cerrar tópicos no aplica.

**`/unarchive` sin id abre el picker**: las sesiones archivadas, las más activas primero, hasta 8 por página con flechas; un toque despierta esa sesión y le recrea el hilo. Con un texto (título o id) el picker filtra; con un id o prefijo, despierta esa directo.

Con `archiveAfterDays > 0` el borrado es **automático**: el dueño del poll barre todos los mapeos en cada tick de elección y borra los hilos de sesiones idle más de esa cantidad de días. El sweep corre solo en el proceso líder (un solo dueño de la eliminación) y respeta una graza: un mapeo más joven que la ventana no se toca, de modo que `/rebuild` pueda importar sesiones viejas sin que el próximo tick les borre el hilo nuevo.

Escribirle a una sesión archivada — por la raíz del chat o por `/sh` — **la revive**: cae el flag y se recrear el hilo. El silencio dura mientras nadie le hable.

### `/kill`
Cancela el turno en curso de la sesión.

### `/tasks`
Los recordatorios durables de la sesión, del **almacenamiento Host** del subsistema Schedule (`ctx.schedule.list` — sin activar la sesión) más los viejos que este bot (o la tool antigua) escribieron como eventos del log, deduplicados por id. Si el perfil no compone Schedule, lo dice honestamente.

### `/newtask`
El asistente de recordatorios, paso a paso y persistido (un reinicio no se lo come): nombre → prompt → tipo (una vez / diario / semanal / cada N minutos) → detalle (`2026-12-01 09:00`, `09:00`, `lun 09:00`, o un número) → confirmación. `… cancelar` aborta. El draft vive en el `state.json` del bridge, así que retomás el asistente donde quedó después de un reinicio. Los pasos de **proyecto** y **modelo** del asistente de opencode no existen acá: el Schedule del harness es por sesión — el recordatorio dispara en la sesión donde lo creaste, con el modelo que ella ya tiene. El recordatorio se crea con el **servicio Host de Schedule** — el mismo que usa la tool model-facing (`ctx.schedule.create`) — así que también lo ve la Web, sobrevive reinicios y no despierta la sesión; cuando dispara, llega como un turno más de la sesión con un aviso `⏰` en el hilo.

### `/locale es|en`
Cambia el idioma del bot y lo persiste.

### `/rebuild [días]`
Trae a Telegram las sesiones persistidas con actividad real en esa ventana (default 7 días, configurable en `rebuildDays`): título del log (`sessionQuery.readTitle`), hilo nuevo, mapeo. Nunca duplica las ya mapeadas y crea máximo 12 hilos por invocación, las más recientes primero. Es el comando para poblar el foro con el historial existente del harness.

### `/running`
Las sesiones con un turno en curso en este proceso.

### `/export`
El log durable de la sesión como documento `.jsonl` (los eventos crudos, exportados por `sessionQuery.readSession`).

### `/rename [título]`
Con título, fija el título vía el evento oficial `session/title` con origen `user` — lo ve la Web también, y la generación automática deja de re-programarse. El hilo de Telegram se renombra igual. **Sin argumento, regenera**: llama al `sessionTitle.refresh` del harness, que despina el título actual y deriva uno nuevo (el análogo honesto de las tres sugerencias del opencode — acá el servicio da una, la buena).

### `/instructions [add <texto> | clear]`
Las notas de la carpeta: lee, agrega o vacía `AGENTS.local.md` en el cwd de la sesión — el archivo que el harness re-inyecta como instrucción local en cada sesión de esa carpeta. Cambio semántico frente al opencode (que era un store por sesión con claves): acá es un archivo markdown compartido por todo el proyecto, y el bot lo avisa en cada `add`.

### `/config [model …]`
Sin argumentos, el resumen que importa en el teléfono: modelo default de las sesiones nuevas (con su reasoning effort) y los hechos del bridge (modo, espejo, reparto de decisiones, idioma, ventana de archivado). `/config model` manda el picker de rutas — un toque fija el default para las sesiones nuevas (`agentDefaultModel.saveSelection`); `/config model <proveedor>/<modelo>` lo hace directo. El default de una sesión que ya corre no cambia: para eso está `/models`.

### `/fork [id]`
Forkea la sesión en su último turno completado — el mismo corte que hace la Web: la hija hereda los eventos balanceados hasta ese `turn/end` (`seed` + `inheritedEventCount`), registra el linaje (`isSeeded`, `parentSession`, mismo cwd) y su hilo nace con el primer mensaje. Sin argumento, forkea la sesión del hilo; con id o prefijo, esa. Una sesión sin turnos completados se rechaza con honestidad.

### `/note <texto>`
Nota silenciosa al transcript (`agent.inject()`): el agente la ve en su próximo turno, sin despertarse ahora.

### `/sh <comando>`
Corre el comando **directamente en la carpeta de la sesión**, por el servicio de shell del harness (`ctx.shell`), sin despertar al agente: la salida llega al hilo y el modelo no la ve (no hace falta: nada de eso entra al log del turno). El shell del harness en Windows es PowerShell — `&&` no funciona, usá `;`.

**El guardia** clasifica cada comando antes de correrlo (parsea, no regex: separa `;` `|` `&&` respetando comillas y resuelve alias):

- **Pasa derecho**: lectura pura (`Get-*`, `Test-*`, `ls`, `cat`) y la toolchain de desarrollo (`git`, `node`, `pnpm`, `cargo`, `python`...).
- **Pide confirmación**: lo recuperable pero que puede cortar el servicio o salir de la máquina — matar procesos, instalar software, llamadas a la red, ejecución remota, tareas programadas. La tarjeta **explica qué hace cada comando** (qué va a pasar, no solo el texto) y hay que tocar "Confirmar y ejecutar".
- **Bloqueado, sin excepción**: lo que no tiene vuelta atrás — formateo y borrado de discos, arranque y recuperación del sistema, registro, usuarios y credenciales, secretos (`.env`, `.ssh`, perfiles de navegador), defensas (antivirus, firewall, BitLocker), borrado de logs, y todos los vectores de evasión (`iex`, `Invoke-Command`, `powershell`/`cmd` anidados, `-EncodedCommand`, `Add-Type`, acceso directo a .NET/COM). Ni confirmándolo se ejecuta.

El borrado está **acotado por ruta**: `Remove-Item` se permite dentro de la carpeta del proyecto y se bloquea afuera; borrar el proyecto entero (`.`) o el `.git` pide confirmación. Si el perfil no compone el servicio de shell, el comando lo dice y te sugiere escribirle al agente.

### `/git`
Qué tocó el agente en el proyecto de la sesión: corre `git status --porcelain` + `git diff --numstat` por el servicio de shell en la carpeta de la sesión y arma la lista de cambios con `+/−` por archivo. El botón **"Ver el diff"** manda el working diff como un `.patch` descargable, con una preview inline. Es el diff del proyecto, no de la sesión — varios agentes pueden compartirlo.

### `/worktree [new <nombre>]`
Los worktrees git del proyecto de la sesión. Sin argumento los lista con un botón por worktree que **abre una sesión nueva en esa carpeta** (el thread nace con el primer mensaje, como `/projects`); `/worktree new <nombre>` carvea uno nuevo (una rama nueva basada en HEAD) y avisa dónde quedó — el nombre es un nombre de rama: letras, números, punto, guión y barra, sin espacios ni símbolos.

### `/compact`
Compresión manual del historial vía el seam oficial (`ctx.compaction.compactNow`). El resumen queda en el transcript; la Web lo ve.

### `/txt <texto>`
Responde con texto libre la pregunta que espera texto (lo mismo que tocar "✍️ Otra" y escribir).

### `/menu`
Tablero de botones: correr sesiones, proyectos, modelos, uso, contexto, skills, tareas, cola y ayuda con un toque. El menú queda; la respuesta llega como mensaje nuevo.

### `/sessions`
El corpus completo de sesiones raíz del perfil — no solo las mapeadas: primero las que el bot ya espeja (ordenadas por actividad), después las que viven solo en disco, con su título. `/use` o `/rebuild` traen cualquiera.

### `/projects`
Los workspaces registrados del harness, el más reciente primero. Cada uno tiene un botón "＋" que crea una sesión ahí — la manera de telefoneo de "empezar a trabajar en tal carpeta".

### `/send <id|prefijo> <texto>`
Le habla a otra sesión sin mover la raíz del chat: resuelve el id (o prefijo) y entrega el texto como prompt, con followup o steering según esté corriendo o no.

### `/context`
Ocupación de la ventana: tokens usados contra el contexto del modelo, porcentaje, cuántas compactaciones hizo la sesión y el último resumen. Pasada la mitad, sugiere `/compact`.

### `/usage`
La foto del momento de la sesión: ruta de modelo, estado (corriendo/en pausa), tokens del último turno y acumulados, ocupación del contexto.

### `/clearqueue`
Vacia el inbox de la sesión (`agent.inbox.clear()`): todo mensaje en espera de próximo turno y todo steering en espera de próximo paso se cancela, en forma durable.

### `/commands [run <nombre> [args]]`
Los comandos que el harness registró para la sesión (los del perfil, sin pasar por el modelo). La lista trae un botón por comando; con argumentos, `/commands run <nombre> …`. El ciclo `command/run` → `command/done` queda en el log, como en la Web.

### `/perms`
El estado de permisos de la sesión: preset actual (permission presets), política de aprobación, modo de sandbox — con un botón por preset para cambiar todo junto. Es "qué pedirá el agente", no "qué pre-aprobé" (el harness decide cada llamado; no hay lista de reglas guardadas).

### `/skills` · `/skill <nombre> [texto]`
`/skills` lista las skills visibles para la carpeta de la sesión, con botón para leer una completa. `/skill <nombre> <texto>` le entrega al agente el contenido de la skill enmarcado como instrucción, con tu pedido.

### `/agents`
Los presets de agente del perfil. Un toque recompone la sesión con ese preset (reusa el `agentPresets.select` del harness; rechaza sesiones que ya produjeron salida, igual que la Web).

### `/files [ruta]`
Explorador de archivos de la carpeta de la sesión: carpetas primero, con botones para navegar (y "⬆" para subir); tocar un archivo lo manda como documento (hasta 256 KB). Sin argumento, abre la carpeta de la sesión.

### `/ffind <texto>`
Busca archivos por nombre desde la carpeta de la sesión — insensible a mayúsculas, hasta 4 niveles, saltándose `node_modules`, `.git` y build output; muestra la ruta completa de cada hallazgo.

### `/taskcancel [id|texto]`
Borra un recordatorio por id, prefijo, o un trozo de su prompt; sin argumento, el último. Borra primero del **almacenamiento Host** (`ctx.schedule.delete`, sin activar la sesión); los recordatorios viejos que viven como eventos del log se borran con el `schedule/change` delete, como siempre.

### `/delthread`
Borra el hilo de Telegram pero deja el mapeo: la sesión sigue viva y su hilo renace con el próximo evento (distinto de `/archive`, que además la silencia hasta que le escribas).

### `/watch <id|all|off>`
Qué sesiones se miran en el chat. El default es `all`: todas las mapeadas. `/watch <id|prefijo>` mira solo esa (el resto queda silencioso — los eventos no llegan al teléfono), `/watch off` no mira nada, `/watch all` vuelve al default. Sin argumento, muestra la selección. La elección persiste en el `state.json` — un reinicio no la pierde. El archivado siempre gana: una sesión archivada no se mira en ningún modo.

### `/macro save|run|list|del`
Prompts con nombre, para reenviarlos a cualquier sesión con un toque del teclado:

- `/macro save deploy despliega a produccion` — guarda el prompt bajo el nombre `deploy`
- `/macro run deploy` — lo envía a la sesión del hilo (o la que apunte `/use`)
- `/macro list` — todas las guardadas
- `/macro del deploy` — la borra

El nombre es caso-sensible y no puede tener espacios. Quedan en `<stateDir>/macros.json`.

### `/recent`
Los últimos prompts que enviaste desde este teléfono (hasta 200, persistentes en `<stateDir>/recent.json`), cada uno con un botón **↪️** que lo reenvía a la sesión que lo recibió — la misma sesión, aunque ya no sea la raíz del chat. Se registra cada prompt que llega al agente por el bridge: los tipeados a mano, los de `/macro run` y los reenvíos de acá mismo.

### `/queue`
El inbox de la sesión como tarjeta interactiva: el steering pendiente (entra en el próximo paso) y los turnos pendientes (su propio turno), cada ítem con cinco botones:

- **↑ / ↓** — reordena dentro de su lista
- **▶** — adelanta el ítem al frente de su lista
- **✖** — lo cancela (durable: no se entrega)
- **✏️** — arma el reemplazo: el próximo mensaje de este hilo **reemplaza** ese ítem en la cola (no agrega uno nuevo)
- **✅ Ordenar así** — aplica el orden que armaste a las listas pendientes (un splice durable por lista)

Entre el render y el toque el inbox puede cambiar (un turno arranca, algo se cancela): el toque que ya no encuentra su ítem lo dice, en vez de actuar sobre otro.

### `/dashboard on|off|refresh`
Ancla en el hilo de la sesión un panel con su estado (título, 🔴 corriendo / ⚪ en pausa, ruta cuando corre en este proceso, tokens del último turno y acumulados) y lo mantiene actualizado con cada evento — la edición solo viaja cuando el texto realmente cambia. `off` lo quita, `refresh` lo redibuja. El panel persiste en `<stateDir>/dashboard.json`: sobrevive reinicios. Solo vive en un hilo de sesión (no en la raíz).

### `/log`
Los últimos 10 eventos del log durable de la sesión (vía `sessionQuery.readSession`): cada línea es su `seq` y su tipo. Una ventana de lectura — no es el transcript (para eso está `/export`).

### `/ci [n|workflow]`
Las últimas runs de GitHub Actions del repo configurado (`ci.repo`, default: el de este plugin), una línea por run: estado (🟢/🔴/🟡…), workflow, commit y edad, con el sha corto como link a la run. `/ci 12` trae 12; `/ci deploy` filtra por workflow. Anónimo para repos públicos (60/hora por IP); un `GITHUB_TOKEN` en el entorno levanta el límite y alcanza repos privados — el token nunca entra a la configuración.

### `/status`
Auto-reporte del bot: modo, perfil, si lidera el poll, sesiones mapeadas y corriendo, raíz del chat. En modo `parallel` agrega el estado del cliente remoto: conectado/esperando el gateway/reconectando, y sus contadores (tarjetas renderizadas, resueltos, delegados, cancelados) — el diagnóstico de un permiso que no llegó al teléfono, en un solo comando.

## Preguntas y permisos

Cuando el agente pide una decisión — la tool `ask_user_question`, o un permiso que la política del perfil marca `ask` — el hilo recibe una tarjeta con botones:

- **Preguntas**: una tarjeta por pregunta; un toque elige, en las de multi-selección tocás varias y confirmás; "✍️ Otra" arma la respuesta libre: el próximo mensaje del hilo se convierte en la respuesta (nada más se envía al agente).
- **Permisos**: ✅ una vez / ✖ rechazar. "Siempre" es política del harness (permission presets), no de un botón de chat — por diseño, un toque en el teléfono nunca institucionaliza un permiso.

**Quién contesta primero** (`decisions` en la configuración): ambas decisiones viajan en cascada, y el reenviador remoto del perfil (conectado a la app Desktop o Web) se registra antes que el plugin. Con `app-first` (default) la app reclama y contesta primero — el teléfono solo ve lo que la app delega. Con `phone-first` el bridge salta adelante (`prepend`) y las sesiones espejadas preguntan al teléfono primero; si no hay toque en `decisionTimeoutMs` (default 2 minutos), la tarjeta avisa "se venció la espera" y el pedido pasa a la app. Con **`parallel`** el bridge se suma al stream de eventos reenviados (`$events`) como **un cliente remoto más del Gateway** — igual que la app: permisos y preguntas llegan a las dos superficies a la vez, gana el primer toque, y la superficie perdedora recibe el aviso "se respondió en otra parte" cuando la otra contesta. Sin app conectada, el teléfono responde solo; sin bot, la app responde sola.

Si la pregunta ya fue respondida en la PC, el toque recibe "ya no está pendiente" y no manda nada.

## Multimedia

- **Foto**: baja el tamaño mayor, lo ingresa por el attachment store del harness y el modelo la ve. Si el modelo no acepta imágenes (o no hay store), queda en disco con su ruta en el prompt.
- **Documento**: los de texto (código, config, markdown) viajan inline en el prompt hasta 100k caracteres, con un recibo 📄 en el hilo; los binarios van al attachment store como file block, o a disco con su ruta si el store no acepta archivos.
- **Nota de voz**: se transcribe (si configuraste `stt`) y el texto es el prompt; sin `stt`, el bot explica cómo activarlo. Con transcripción vacía, avisa y no molesta al agente.
- **Video**: a disco con su ruta.

## Archivos generados

Al terminar un turno, el bridge revisa las rutas de archivo que aparecieron en las llamadas y resultados de tools, y entrega las que el agente creó o tocó: imágenes como fotos, `.md`/`.txt` chicos como mensajes legibles, el resto como documentos. Solo del turno actual, solo rutas que existen.

## Hilos borrados y reinicios

- Borrar un hilo desde el teléfono deja de romper el bridge: el primer envío al hilo muerto recibe "message thread not found", el bridge suelta el mapeo y reintenta en la raíz; el próximo evento reconstruye el hilo.
- Reiniciar el perfil no pierde sesiones: los mapeos persisten en `<stateDir>/state.json` y una sesión persistida se retoma al primer mensaje. Una sesión cerrada en la PC y no persistida responde con el aviso honesto de `/ls`.
- Dos procesos con el bundle (la web y un headless): el lock de `<stateDir>` elige un dueño del poll; el otro queda inactivo y toma el asiento si el dueño muere o se congela.

## Lo que no se portó del bot de opencode (y por qué)

- **`/revert`**: el log de sesión del harness es estrictamente append-only; no existe seam de truncado ni rollback. La única sombra es la compactación, que reemplaza el resumen, no deshace un turno.
- **`/mcp`**: los clientes MCP son entradas de composición por servidor, con ciclo de vida de plugin; no hay servicio runtime compartido que listar/conectar/desconectar.
- **`/turns`**: no hay agregación de diff por turno; solo los diffs por escritura que adjunta la tool de archivos.
- **`/move`**: el `cwd` de una sesión queda fijado al crearla; el registro de workspaces puede mover la contabilidad, nunca el `cwd` de la sesión.
- **`/bots`, `/release`**: el bridge es una instancia de plugin por perfil; no hay pool de bots entre perfiles al que devolver nada.

## Voz — activación

1. **Local**: `stt: { provider: local }` + bajar `whisper-cli` y un modelo ggml a `<stateDir>/stt/` (ver el README) + `ffmpeg` en el PATH.
2. **Cloud**: `stt: { provider: openai-compatible, baseUrl: …, model: … }` y la clave en la variable de entorno `STT_API_KEY` (o la que nombre `apiKeyEnv`).

## Estado y privacidad

- Todo el estado del bridge vive en `<stateDir>` (default `~/.dsh-tg-bridge`): mapeos, lock, offset del poll, descargas y binarios de STT. Nada sale de tu máquina salvo lo que envía el propio bot de Telegram.
- El token del bot nunca se escribe en archivos de configuración versionados: va por `token` en tu `cordis.patch.yml` local o por `TELEGRAM_BOT_TOKEN`.
- `allowedUsers` es obligatorio: un bot sin lista responde a cualquiera que lo encuentre, y el bridge se niega a cargar así.
