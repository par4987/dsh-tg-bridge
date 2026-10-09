# Manual — dsh-tg-bridge

> **Español** | Read this in [English](MANUAL.en.md)

## El foro

Cada sesión del harness es un hilo. Lo que escribís en el hilo es un prompt para esa sesión; la respuesta llega al mismo hilo, renderizada en vivo. Si el bot tiene topics habilitados, una sesión nueva (creada desde la PC o con `/new`) obtiene su hilo con el título aprendido del primer mensaje; sin topics, todo vive en un único chat y cada mensaje lleva el título como encabezado.

Mensajes que llegan mientras el agente trabaja no se pierden: entran como steering al próximo paso del turno en curso, con un aviso en el hilo.

Responder con reply a un mensaje de Telegram agrega la cita al prompt — útil para retomar un punto de una respuesta larga sin copiar y pegar.

## Comandos

Escribilos en cualquier hilo (actúan sobre esa sesión) o en la raíz del chat (actúan sobre la sesión apuntada por `/use`).

### `/help`
La lista de comandos con una línea por uno.

### `/new [ruta]`
Crea una sesión nueva. La ruta es el directorio de trabajo (absoluta o relativa al `workspace` configurado); sin argumento usa el `workspace`. El hilo se crea con el primer mensaje.

### `/ls`
Las sesiones mapeadas: id corto, título, punto verde si está activa en este proceso, 📦 si está archivada. Ordenadas por último uso.

### `/use <id|prefijo>`
Apunta la raíz del chat a una sesión: lo que escribas sin hilo va a esa sesión. `/detach` desacopla la raíz.

### `/models`
Las rutas de modelo registradas (proveedor/modelo) y la actual de la sesión — la que quedó registrada en el último request del log.

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
Cierra (`close` de Telegram: visible, lectura) o reabre el hilo de la sesión. Si el hilo fue borrado desde el teléfono, `/unarchive` lo recrea. Con `archiveAfterDays > 0`, el cierre es automático tras esa inactividad.

### `/kill`
Cancela el turno en curso de la sesión.

### `/tasks`
Los recordatorios durables de la sesión (subsistema Schedule del harness). Si el perfil no compone Schedule, lo dice honestamente.

### `/newtask`
El asistente de recordatorios, paso a paso y persistido (un reinicio no se lo come): nombre → prompt → tipo (una vez / diario / semanal / cada N minutos) → detalle (`2026-12-01 09:00`, `09:00`, `lun 09:00`, o un número) → confirmación. `… cancelar` aborta. El recordatorio se crea con el mismo dominio durable que usa el modelo, así que también lo ve la Web y sobrevive reinicios; cuando dispara, llega como un turno más de la sesión con un aviso `⏰` en el hilo.

### `/locale es|en`
Cambia el idioma del bot y lo persiste.

## Preguntas y permisos

Cuando el agente pide una decisión — la tool `ask_user_question`, o un permiso que la política del perfil marca `ask` — el hilo recibe una tarjeta con botones:

- **Preguntas**: una tarjeta por pregunta; un toque elige, en las de multi-selección tocás varias y confirmás; "✍️ Otra" arma la respuesta libre: el próximo mensaje del hilo se convierte en la respuesta (nada más se envía al agente).
- **Permisos**: ✅ una vez / ✖ rechazar. "Siempre" es política del harness (permission presets), no de un botón de chat — por diseño, un toque en el teléfono nunca institucionaliza un permiso.

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

## Voz — activación

1. **Local**: `stt: { provider: local }` + bajar `whisper-cli` y un modelo ggml a `<stateDir>/stt/` (ver el README) + `ffmpeg` en el PATH.
2. **Cloud**: `stt: { provider: openai-compatible, baseUrl: …, model: … }` y la clave en la variable de entorno `STT_API_KEY` (o la que nombre `apiKeyEnv`).

## Estado y privacidad

- Todo el estado del bridge vive en `<stateDir>` (default `~/.dsh-tg-bridge`): mapeos, lock, offset del poll, descargas y binarios de STT. Nada sale de tu máquina salvo lo que envía el propio bot de Telegram.
- El token del bot nunca se escribe en archivos de configuración versionados: va por `token` en tu `cordis.patch.yml` local o por `TELEGRAM_BOT_TOKEN`.
- `allowedUsers` es obligatorio: un bot sin lista responde a cualquiera que lo encuentre, y el bridge se niega a cargar así.
