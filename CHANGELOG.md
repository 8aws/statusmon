# Changelog

Todos los cambios relevantes de StatusMon se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).

---

## [5.6.9] — 2026-06-09

### Fixed
- **ZimaOS: ruta de datos corregida** — volumen usa `/root/AppData/statusMon` (ruta absoluta) en lugar de `$HOME/AppData/statusMon` que docker-compose no expande en Custom Install.
- **ZimaOS: puerto fijo `3000`** — eliminada la sintaxis `${WEBUI_PORT:-3000}` que el parser de ZimaOS no soporta; se usa `3000` directamente.
- **ZimaOS: `index: /admin`** — el icono de la app abre directamente el panel de administración.
- **Status page: botón "Administrar" sin contraseña** — si no hay contraseña configurada, el botón redirige directamente a `/admin` sin mostrar el modal de login.

---

## [5.6.8] — 2026-06-09

### Added
- **Imagen Docker Hub** — `espiralvex/statusmon:latest` (multi-arch: amd64, arm64, arm/v7). Instalación sin código fuente ni build local.
- **GitHub Actions** — `.github/workflows/docker-publish.yml` construye y publica en Docker Hub automáticamente al hacer push de un tag `v*`. También crea la GitHub Release y adjunta el ZIP.
- **`docker-compose.yml` usa `image:`** en lugar de `build:` — `docker compose up -d` descarga la imagen directamente, sin compilar.
- **ZimaOS App Store funciona al 100%** — `docker-compose.zima.yml` ya no necesita `build:`. Custom Install → pegar YAML → done.
- **`install.sh` e `install-zima.sh` sin `--build`** — arrancan en ~30s (pull de imagen) en lugar de 1-2 min.
- **URLs de releases migradas a GitHub** — `releases.json`, `about.html` y todos los enlaces de changelog apuntan a `github.com/8aws/statusmon/releases`.

---

## [5.6.7] — 2026-06-09

### Fixed
- **Rutas ZimaOS corregidas** — `docker-compose.zima.yml` e `install-zima.sh` ahora usan `~/AppData/statusMon/` (`$HOME/AppData/statusMon`) en lugar de `/DATA/AppData/statusmon`. Coincide con la ruta real que crea ZimaOS 1.6.x para los datos de apps.
- **Instrucciones ZimaOS actualizadas** — `about.html` refleja la ruta correcta y los pasos apuntan a `~/statusmon-v5.6.7/` en lugar de `/DATA/`.
- **`install-zima.sh` expande `$HOME` a ruta absoluta** antes de pasarla a docker-compose para evitar problemas de expansión de variables en distintas versiones del engine.

---

## [5.6.6] — 2026-05-30

### Added
- **Historial de 7 días** — `maxHistory` sube de 500 a 10 080 entradas (7 días a checks de 1 min). Las instalaciones existentes empiezan a acumular historia desde la actualización.
- **Selector de rango temporal** en el detalle de cada sitio — botones 1h / 6h / 24h / 7d / Todo que filtran el gráfico y la tabla por ventana de tiempo en lugar de por conteo de entradas.
- **Rango personalizado** (⊞ Personalizado) — selector desde/hasta con fecha y hora para ver exactamente una ventana de interés, por ejemplo la hora posterior a un despliegue.
- **Resumen del rango** — línea bajo el gráfico que muestra N checks · duración del tramo · % uptime · media · P95 para los datos visibles.
- **Tabla sin paginación fija** — muestra hasta 100 checks del rango activo, con botón "Ver todas (N) ↓" para expandir.
- **CSV filtrado por rango** — el botón ↓ CSV exporta exactamente el tramo seleccionado.
- **`/api/history/:id?since=&until=`** y **`/api/stats/:id?since=&until=`** — filtros de timestamp en los endpoints de historial y estadísticas.

---

## [5.6.5] — 2026-05-26

### Fixed
- **Versión en ejecución siempre aparece como disponible** — `/api/releases` ahora incluye siempre la versión actualmente corriendo y la marca como `available: true` y `current: true`, independientemente de si existe el ZIP en disco. Resuelve el problema de "bootstrap gap" donde la primera versión con el nuevo sistema de almacenamiento no encontraba su propio ZIP.
- **Migración automática de ZIPs antiguos** — al arrancar, si existen ZIPs en la antigua ubicación `public/releases/` se copian automáticamente a `DATA_DIR/releases/` (una sola vez). Facilita la transición desde v5.6.3 o anteriores sin intervención manual.

---

## [5.6.4] — 2026-05-26

### Fixed
- **Releases no persistían tras actualizar** — los ZIPs de release ahora se almacenan en `DATA_DIR/releases/` (carpeta bind-mounted) en lugar de `public/releases/`. Esto evita que las actualizaciones sobrescriban el directorio y los archivos desaparezcan del volumen externo.
- **Versión disponible incorrecta** — el panel de administración ahora escanea `DATA_DIR/releases/` para determinar qué ZIPs están disponibles localmente, por lo que la versión "Disponible para descarga" refleja la realidad del bind mount, no de un directorio interno del contenedor.
- **Guardado automático del ZIP al actualizar** — al aplicar una actualización, el ZIP se copia automáticamente a `DATA_DIR/releases/` con el nombre versionado (`statusmon-vX.Y.Z.zip`) antes de limpiar el directorio temporal, acumulando el historial de versiones en el bind mount.
- **`/releases/latest`** — ahora resuelve dinámicamente el ZIP más reciente desde `DATA_DIR/releases/` en lugar de depender de un `index.json` estático.

---

## [5.6.3] — 2026-05-26

### Added
- **`/api/health`** — endpoint público sin auth que devuelve `{ok,version,uptime}`. Ideal para healthchecks de balanceadores o monitores externos.
- **Salt aleatoria en scrypt** — el cifrado AES-256-GCM para contraseñas SMTP ahora usa salt aleatoria almacenada en `.secret`. Migración automática para instalaciones existentes.
- **Reintento inmediato ante fallo** — antes de sumar un check fallido al contador de alertas, se reintenta una vez tras 2 segundos para descartar microcortes de red.
- **Timeout configurable globalmente** — nuevo campo `defaultTimeout` (segundos) en ajustes General que aplica a todos los sitios sin timeout propio.
- **Toast de confirmación** al guardar ajustes — notificación visual no intrusiva.
- **Indicador "Guardando…"** en el botón de ajustes mientras el PUT está en vuelo.
- **Contador de reinicio visible** — overlay con cuenta atrás de 12 segundos al aplicar una actualización, con recarga automática de página.
- **Botón "Limpiar suscripciones" push** — en pestaña Alertas, resetea todas las suscripciones Web Push sin SSH.
- **Botón "Copiar URL de ping"** en el modal de edición de sitios tipo heartbeat.

### Fixed
- **Push loop**: `_saveSubs` ahora loguea el error si no puede escribir el fichero. Suscripciones expiradas (404/410) ya se eliminan correctamente y no generan el loop de "0/1 delivered".
- Mensajes de log push más descriptivos: distingue entrega OK, expiradas eliminadas y fallos reales.

---

## [5.6.2] — 2026-05-25

### Added
- **Pestaña Correo** — nueva sección en ajustes dedicada exclusivamente al correo de alertas.
- **Presets de proveedor** — selector visual con Gmail, Outlook/Hotmail, Yahoo e iCloud. Solo requiere usuario y contraseña de aplicación; host/puerto/TLS se configuran automáticamente.
- **Modo Directo** — envío sin relay SMTP usando resolución de MX. No requiere ninguna credencial. Incluye aviso de riesgo de spam para uso consciente.
- **SMTP manual en acordeón** — la configuración manual queda oculta bajo un slide-down dentro de la opción "Manual", limpiando la vista por defecto.
- **Botón "Enviar email de prueba"** — endpoint `POST /api/mail/test` para verificar la configuración sin esperar una alerta real.
- **Hints contextuales** — instrucciones para generar contraseña de aplicación en cada proveedor, visibles al seleccionar el preset.

### Changed
- La sección Email (SMTP) se ha eliminado de la pestaña Alertas y movida a la nueva pestaña Correo.

### Fixed
- Heredado de v5.6.1: fix botón ajustes, fetch releases server-side, negative cache favicons.

---

## [5.6.1] — 2026-05-25

### Fixed
- **Botón de ajustes roto**: eliminado bloque de parcheo `openSettings` que causaba recursión infinita por hoisting de funciones declaradas. `setTimeout(initPush, 100)` movido directamente al cuerpo original de `openSettings`.
- **Error SSL en consola**: fetch a `releases.json` remoto movido del navegador al servidor. `/api/releases` ahora consulta `remoteUrl` server-side (sin CORS ni problemas de certificado en el cliente).
- **Cache de SW**: bump de nombre de caché a `statusmon-v5.6.1` para forzar refresco tras actualización.
- **Favicon spam**: añadido negative cache de 24 h — si un sitio no tiene favicon, no se vuelve a intentar hasta el día siguiente en lugar de en cada carga del admin.

---

## [5.6.0] — 2026-05-25

### Añadido — Nuevos tipos de monitor
- **DNS check** — tipo `dns://hostname`, verifica que el dominio resuelve correctamente; opción `expectedIp` para validar la IP concreta.
- **Heartbeat / cron monitor** — tipo `heartbeat://job-name`; endpoint público `POST /api/heartbeat/:id/ping` para señales externas; alerta si no llega ping en el intervalo esperado (×1.5 de gracia).

### Añadido — Dashboard / UX
- **Timeline de incidencias** — botón 📅 en detalle abre línea de tiempo de caídas calculada desde el historial. Rango configurable: 7, 30 o 90 días.
- **Acciones en lote** — activar con tecla `X`; checkboxes en cada fila; barra flotante con Pausar, Reanudar, Comprobar, Pub/Priv y Eliminar sobre todos los seleccionados.
- **Atajos de teclado** — `R` refrescar, `N` nuevo sitio, `/` enfocar búsqueda, `S` ajustes, `Esc` cerrar/volver, `↑↓` navegar lista, `Enter` abrir detalle, `X` modo selección. Indicador flotante ⌨ con referencia rápida.
- **Exportar SLA** — botón 📊 en detalle exporta CSV con uptime, downtime y listado de caídas del mes actual. Endpoint `GET /api/sla/:id?period=monthly&year=&month=&format=csv`.

### Añadido — Notificaciones push (Web Push VAPID)
- Implementación nativa sin dependencias npm: generación de clave P-256, VAPID JWT (ES256), cifrado RFC 8291 (aes128gcm).
- Endpoints: `GET /api/push/vapid-key` (público), `POST /api/push/subscribe` (autenticado), `DELETE /api/push/subscribe`.
- Las alertas de caída/recuperación se envían automáticamente a todos los suscriptores.
- SW.js: handler `push` para mostrar notificación + `notificationclick` para abrir el panel.
- UI de suscripción en Ajustes → Alertas → Push del navegador.

### Añadido — Operaciones
- **Backup automático** — `cfg.autoBackupInterval` en días (0 = desactivado); configurable en Ajustes → Sistema.
- **Informe SLA** — endpoint `GET /api/sla/:id` con periodos `monthly`, `7d`, `30d`; responde JSON o CSV.

### Añadido — status.html
- **Banner de mantenimiento programado** — muestra ventanas próximas (< 48 h) o en curso de cualquier sitio público.

### Técnico
- `src/push.js` — módulo VAPID/WebPush autónomo (~200 líneas, sin npm).
- `scheduleAutoBackup()` — scheduler con intervalo configurable.
- Cache del SW bumpeada a `statusmon-v5.6`.

---

## [5.5.0] — 2026-05-24

### Añadido — Admin dashboard
- **Mejoras visuales en la lista de sitios** — fondo gris para sitios ocultos del estado público, favicon del sitio (cacheado 7 días en `/data/favicons/`), health score 0-100 (combina uptime 24h, tendencia y estado actual), flecha de tendencia con color, barra mini de uptime de las últimas 32 comprobaciones, indicador ▲ en TTFB cuando supera el 50 % de la media histórica, arrastrar y soltar para reordenar.
- **Barra de búsqueda/filtro rápido** por nombre, URL o etiqueta.
- **Modal de edición de sitio** (tres pestañas): General (nombre, URL, tipo, timeout, etiquetas, visibilidad pública), Avanzado (intervalo de check propio, webhook por sitio con soporte Discord/Slack/Telegram/Genérico), Mantenimiento (ventanas programadas por días y horas).
- **Pestaña "Estado público" en ajustes** — colores con selector visual + hex, presets (Claro, Oscuro, Alto contraste, Dracula), selector de fuente (7 opciones), cuatro estilos de tarjeta (Plano, Borde, Acento izq., Pill), título personalizado, toggles para TTFB y uptime.
- **Exportar / Importar configuración** — JSON con todos los sitios y ajustes (sin contraseñas SMTP).

### Añadido — Servidor
- **Intervalo de check por sitio** — `checkInterval` por site; scheduler de 5 s con `_lastCheckedAt`.
- **Webhook por sitio** — `site.webhook.{enabled,type,url,chatId}`, mezclado con el webhook global.
- **Ventanas de mantenimiento por sitio** — `site.maintenanceWindows[]` con `{days,start,end}`; silencia alertas durante el periodo.
- **Endpoint favicon** — `GET /api/sites/:id/favicon`, cachea en `/data/favicons/`, TTL 7 días.
- **Reordenar sitios** — `PUT /api/sites/reorder`.
- **Exportar/Importar** — `GET /api/export` y `POST /api/import`.
- **Endpoint de tema público** — `GET /api/status-theme` (sin auth) expone solo `cfg.statusPage`.

### Añadido — status.html y sw.js
- **Soporte de tema** — `applyStatusTheme()` aplica CSS vars, fuente y `data-card-style` desde `/api/status-theme`.
- **Cuatro estilos de tarjeta** — `default`, `bordered`, `accent-left`, `pill`.
- **Caché de fuentes offline** — sw.js intercepta Google Fonts con cache-first en `statusmon-fonts-v1`. Sin dependencia externa en runtime.

---

## [5.4.2] — 2026-05-24

### Añadido
- **Acordeón de métricas en el dashboard principal** — la sección de métricas se ha trasladado del panel de ajustes a un acordeón deslizable situado entre la barra de datos del servidor (nasBar) y el resumen de monitores. Colapsado muestra el nombre y, cuando hay datos disponibles, un resumen rápido (CPU %, RAM %, Load). Expandido muestra las tarjetas de valores actuales, los detalles de disco/red por dispositivo y la gráfica Canvas con todos sus controles. El estado abierto/cerrado se persiste en `localStorage`.
- **Log de progreso en el gestor de actualizaciones** — sustituye el texto de una sola línea por un panel de pasos con indicadores visuales (·/▶/✓/✗). Cubre todo el ciclo: subida con porcentaje real (usando XHR), validación del ZIP, creación de backup, copia de archivos, detención del proceso y reconexión con contador de intentos (N/30).
- **Peek en la cabecera del acordeón** — mientras los datos están disponibles, la cabecera cerrada muestra "CPU X% · RAM Y% · Load Z" sin necesidad de abrir el panel.

### Cambiado
- Tab "Métricas" eliminado del panel de ajustes; la configuración del intervalo permanece en la pestaña Sistema (ya que afecta también a la barra compacta de datos del servidor).
- `closeSettings()` simplificado: ya no gestiona el temporizador de métricas (ahora lo gestiona el propio acordeón).
- Función `uploadUpdate` usa `XMLHttpRequest` en lugar de `fetch` para obtener progreso real de subida.

---

## [5.4.1+1] — 2026-05-23

### Añadido
- **Monitor de métricas del sistema** (`src/metrics/reader.js`) — lee `/host/proc` (bind mount read-only) sin dependencias npm. Mide CPU global y por núcleo (%), uso y swap de RAM (%), load average 1/5/15m, I/O de disco por dispositivo (lecturas/escrituras en kB/s), y tráfico de red por interfaz (rx/tx en kB/s). Diseñado para el Celeron J4005 con BusyBox `/proc` del QNAP.
- **Historial de métricas en memoria** — configurable con `metricsInterval` (segundos, default 60) y `metricsMaxHistory` (puntos, default 1440 = 24h a 1 muestra/min). Se vuelca a `metrics.json` en `/data` al recibir SIGTERM (mismo patrón que el historial de sites).
- **API REST de métricas** (solo autenticados):
  - `GET /api/metrics/current` — última muestra calculada.
  - `GET /api/metrics/history?limit=N&from=ts&to=ts` — subconjunto del historial filtrado por rango de timestamps.
- **Tab "Métricas" en admin.html** — tarjetas de valores actuales (CPU, RAM, Swap, Load ×3, disco por dispositivo, red por interfaz) y gráfico histórico con lienzo Canvas nativo. Configuración del gráfico: selector de métrica, selector de tipo (Área/Línea/Barras), presets de rango (1h/6h/24h/7d) y entrada libre desde/hasta con datetime-local. Se actualiza cada 30 s mientras el tab está abierto; el temporizador se para al cerrar el panel.
- **Bind mount `/proc:/host/proc:ro`** en `docker-compose.yml` para acceso a las métricas del host desde dentro del contenedor.

### Cambiado
- `PUT /api/config` recalcula el temporizador de métricas si cambia `metricsInterval` sin reiniciar el proceso.
- `SIGTERM` flush ahora guarda también `metrics.json` junto a `sites.json`.

---

## [5.4.0+1] — 2026-05-22

### Añadido
- **Gestor de actualizaciones** en el panel admin (tab Sistema). Permite subir un ZIP o introducir una URL para descargarlo. Antes de aplicar, crea un backup automático de `/data`. Tras copiar `src/` y `public/`, llama a `process.exit(0)` y Docker (con `restart: unless-stopped`) relanza el contenedor. La UI hace polling hasta detectar el servidor de nuevo y recarga la página.
- **Visibilidad pública/privada por site** — nuevo campo `public: true/false` en `sites.json`. Los sites marcados como privados (`🔒`) quedan excluidos de `/api/status/public` y por tanto de la página `/status`, los badges SVG y el widget. Sólo visibles en el panel de admin. El toggle es el icono `👁/🔒` en cada fila de la lista.
- **Endpoints de update** — `GET /api/update/pending`, `POST /api/update/fetch`, `POST /api/update/upload` (raw ZIP, límite 100 MB), `POST /api/update/apply`, `DELETE /api/update/pending`.

### Cambiado
- `docker-compose.yml` — volúmenes `src/` y `public/` cambiados de `:ro` a lectura/escritura para permitir actualizaciones in-container.
- `Dockerfile` — añadido `apk add --no-cache unzip` (necesario para extracción del ZIP de actualización en Alpine).
- `POST /api/sites` y `PUT /api/sites/:id` aceptan el campo `public` (boolean, default `true` para retrocompatibilidad).

---

## [5.3.0+1] — 2026-05-22

### Añadido
- **Checks TCP de puertos** — monitoriza cualquier servicio TCP directamente (bases de datos, SMTP, Redis, SSH…). Formato de URL: `tcp://host:puerto`. Mide latencia de conexión y detecta caídas del socket sin necesidad de HTTP.
- **Monitor SSL independiente** — nuevo tipo de check `ssl://host` que conecta via TLS y reporta días restantes del certificado, sujeto e issuer, sin realizar petición HTTP. Útil para monitorizar certs de servicios que no exponen web.
- **Alertas por caducidad SSL** — umbrales configurables `sslWarnDays` (30 días por defecto) y `sslCriticalDays` (7 días) que disparan webhook y/o email antes de que expire cualquier certificado, tanto en checks HTTP/HTTPS como en el nuevo tipo SSL. Los flags de alerta se reinician automáticamente tras renovación.
- **Selector de tipo en modal "Nuevo servicio"** — el panel de administración permite elegir HTTP/HTTPS, TCP Port o Monitor SSL con placeholders y hints descriptivos para cada tipo.
- **Rate limiting en endpoints de red P2P** — `/api/peer/verify` y `/api/peer/trace` limitan a 20 peticiones/minuto por IP para evitar abuso como proxy.

### Corregido
- **Bug crítico `ipToContinent` no definida** — `ReferenceError` al acceder a `/api/network/map` cuando el servidor tenía IP pública pero sin continente en config; se resuelve usando el continente ya autodetectado en `cfg.network.continent`.
- **SSRF en `/api/peer/verify`** — `checkUrlReachable()` ahora valida que la URL sea `http://` o `https://` y que el host no sea una IP privada/loopback (10.x, 172.16-31.x, 192.168.x, 127.x, ::1). URLs bloqueadas devuelven error sin realizar petición.
- **Posible shell injection en `/api/peer/trace`** — el hostname extraído de la URL del traceroute ahora se valida contra `/^[a-zA-Z0-9.\-]{1,253}$/` antes de pasarlo a `execSync`.
- **Mensajes de alerta inconsistentes** — `sendWebhook` y `sendEmail` ahora formatean correctamente todos los tipos de alerta (down, up, ssl_warn, ssl_critical) con emojis y textos apropiados.

### Cambiado
- Versión de red P2P `APP_VERSION` en `routes.js` actualizada a `5.3.0`.
- `checkSite()` refactorizado en `checkHttp()`, `checkTcp()`, `checkSslSite()` con dispatcher por protocolo URL (`tcp:`, `ssl:`, o HTTP por defecto).
- Todas las respuestas de check incluyen campo `checkType` (`'http'`/`'tcp'`/`'ssl'`).

---

## [4.2.1] — 2025-05-05

### Arreglado
- Versión no se mostraba en ajustes → ahora se carga al abrir el panel y al cambiar al tab Sistema.
- Backups se quedaba en 'Cargando…' → `loadSistemaTab()` se llama al abrir ajustes y al cambiar al tab Sistema.
- Limpieza Docker eliminada — no es accesible desde dentro del contenedor sin montar el socket. Reemplazada por herramientas de limpieza del propio contenedor.

### Cambiado
- Tab Sistema rediseñado con foco en `/data`:
  - **Uso de /data** — barras de uso por archivo (config, sites, history, backups) con total y número de registros de historial.
  - **Compactar historial** — fuerza el recorte al maxHistory configurado, mostrando cuántos registros se eliminaron.
  - **Borrar historial** — por sitio o todos, con backup previo automático.
  - **Gestión de backups** — lista con tamaño y fecha, borrado individual o de todos.
- Eliminados: endpoints `/api/docker/prune` y `/api/docker/stats` (no funcionales desde dentro del contenedor).
- Añadidos: endpoints `GET /api/data/stats`, `POST /api/data/compact`, `DELETE /api/backups`, `DELETE /api/backups/:name`.

---

## [4.2] — 2025-05-05

### Añadido
- **Versión visible** en ajustes → tab Sistema — muestra la versión exacta del servidor en ejecución.
- **Borrar historial** por sitio o global desde ajustes → Sistema, con backup automático completo de `/data` antes de borrar.
- **Backups automáticos** en `/data/backups/` — se conservan los últimos 10. Visibles en ajustes → Sistema.
- **Limpieza Docker** — elimina contenedores parados, imágenes huérfanas (dangling), volúmenes y redes no usados.
  - Botón manual en ajustes → Sistema.
  - Tarea programada configurable (días, 0 = desactivada).
- **Panel Docker en ajustes** — muestra número de imágenes huérfanas, contenedores parados y fecha de última limpieza.
- Endpoint `GET /api/version` — devuelve la versión del servidor.
- Endpoint `GET /api/backups` — lista backups disponibles.
- Endpoint `POST /api/backups` — crea backup manual.
- Endpoint `DELETE /api/history/:id` — borra historial de un sitio (`all` para todos) con backup previo.
- Endpoint `POST /api/docker/prune` — ejecuta limpieza Docker.
- Endpoint `GET /api/docker/stats` — devuelve estado de contenedores e imágenes.

### Cambiado
- Constante `APP_VERSION` en servidor — el número de versión se gestiona en un único lugar.
- Tab de ajustes añadido: **Sistema** (4 tabs en total: General, Servidor, Alertas, Sistema).

---

## [4.1] — 2025-05-05

### Añadido
- **Cifrado AES-256-GCM** para la contraseña SMTP — se guarda cifrada en `config.json`, nunca en texto plano. Clave derivada de `/data/.secret` generado al primer arranque.
- **nodemailer** como cliente SMTP — reemplaza la implementación manual. Soporta STARTTLS, TLS directo y envío de emails en HTML.
- Email de alerta en HTML con tabla de datos (código HTTP, tiempo de respuesta, error) y colores por estado.
- `GET /api/config` enmascara la contraseña con `••••••••` — nunca se expone al frontend.
- `PUT /api/config` detecta el placeholder y preserva la contraseña existente sin sobreescribirla.

### Cambiado
- El cálculo de CPU ya no usa un bucle bloqueante `while()` — ahora usa `setTimeout` asíncrono (500ms) que no bloquea el event loop.
- Las métricas del servidor (RAM, CPU, disco, temp) se calculan en background y se sirven desde caché. Ya no se recalculan en cada petición.
- Intervalo de refresco del servidor configurable desde ajustes UI (por defecto 30s, recomendado ≥30s para NAS con CPU limitada).
- El frontend usa el intervalo de refresco del servidor en vez del hardcodeado de 10s.

### Dependencias
- Añadido: `nodemailer`

---

## [4.0] — 2025-05-04

### Añadido
- **Config dinámica** — intervalo, historial, alertas, SMTP y webhook se guardan en `/data/config.json` y se aplican vía API sin reiniciar el contenedor.
- **Notificaciones webhook** — Discord, Slack, Telegram y genérico. Configurable globalmente con opción de sobreescribir por sitio.
- **Notificaciones SMTP** (sustituido en v4.1 por nodemailer).
- **Umbral de alertas** — notifica solo tras X checks fallidos consecutivos (evita falsos positivos). Notifica también la recuperación.
- **Pausa por sitio** — desactiva la monitorización sin eliminar el sitio ni su historial.
- **Etiquetas (tags)** por sitio con agrupación visual en la lista.
- **Export CSV** del historial por sitio (`/api/history/:id/csv`).
- **Forzar refresco** global desde el botón junto al contador.
- **Contador inteligente** — muestra segundos, minutos u horas según el intervalo configurado.
- **Vista pública** `/status` — página minimalista verde/rojo para compartir con clientes, sin datos sensibles de rendimiento.
- **Modo mantenimiento** — silencia todas las alertas temporalmente. Banner visible en el panel.
- **Panel de ajustes con tabs** — General, Servidor, Alertas.
- **Consejos de seguridad** en el detalle — cada cabecera HTTP faltante incluye snippet de configuración para nginx, Apache y Caddy.
- **Logo SVG inline** clickable que navega al inicio.
- Endpoint `POST /api/check` para forzar comprobación de todos los sitios.
- Endpoint `GET /api/status/public` sin datos sensibles.
- Endpoint `PUT /api/sites/:id` para editar sitios.
- Endpoint `POST /api/sites/:id/pause` para pausar/reanudar.

### Cambiado
- Tema claro como base por defecto (configurable a oscuro desde ajustes).
- `sites.json` separado de `config.json` para mejor organización de datos.
- Config del servidor ya no requiere variables de entorno para intervalo e historial — se gestionan desde la UI.
- Barra NAS con métricas individuales activables/desactivables.

### Arreglado
- `display:''` en `showDetail()` causaba `height:0` — corregido a `display:'block'`.
- Bug en dots del gráfico SVG — `indexOf` sobre array filtrado daba posiciones incorrectas.
- `res.clone()` en Service Worker se llamaba después de consumir el body — corregido.
- Cache del Service Worker actualizada a `statusmon-v4`.

---

## [3.0] — 2025-05-03

### Añadido
- **PWA instalable** — manifest, service worker con cache-first para assets y network-first para API, iconos SVG.
- **Stats del servidor NAS** vía `/proc` — RAM, CPU, disco, load average, temperatura. Sin dependencias externas.
- **TTFB** (tiempo hasta primer byte) medido y mostrado por separado del tiempo total.
- **Detección de stack** desde cabeceras HTTP — nginx, Apache, Caddy, PHP, Node, Python, Java, Ruby, WordPress, Cloudflare, Vercel, AWS, Varnish, Brotli/gzip.
- **SSL** — expiración, días restantes, emisor, CN. Tag visual en la lista.
- **Cabeceras de seguridad** — HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy con puntuación 0-5.
- **Tamaño de respuesta** por check.
- **Cache-Control** parseado a formato legible.
- Gráfica SVG de detalle con línea de TTFB y media móvil.
- Percentiles p50/p75/p95/p99 para tiempo total y TTFB por separado.
- Panel de ajustes con persistencia en `localStorage` — tema, NAS, timeout, intervalo.
- Barra de instalación PWA automática.
- Banner offline.
- `public/` montado como volumen `:ro` en docker-compose — actualizaciones sin rebuild.

### Cambiado
- Historial máximo por defecto aumentado a 500 checks.
- Backend guarda más datos por check: `ttfb`, `stack`, `ssl`, `bodySize`.
- Endpoint `/api/stats/:id` calcula estadísticas en el servidor.
- NAS se refresca cada 10s independientemente del ciclo de checks.

### Arreglado
- Meta `apple-mobile-web-app-capable` deprecado — añadido `mobile-web-app-capable`.
- Atributo `version` obsoleto eliminado de `docker-compose.yml`.

---

## [2.0] — 2025-05-02

### Añadido
- **Vista de detalle por sitio** — gráfica SVG de historial de tiempos con área rellena, dots coloreados por velocidad y marcadores de caídas.
- **Selector de rango** en la gráfica — 50, 100 o todos los datos.
- **Estadísticas por sitio** — p50/p75/p95/p99, media, desviación estándar, uptime 24h/7d/total, MTBF, mejor/peor tiempo.
- **Tendencia** — compara media de últimos 10 checks vs 10 anteriores.
- **Gestión de incidencias** — racha actual, mayor caída, tiempo total caído, número de caídas, MTBF.
- **Distribución de códigos HTTP** con barras proporcionales.
- **Tabla de historial** — últimas 25 comprobaciones con hora, código, tiempo y error.
- **Endpoint** `GET /api/stats/:id` y `GET /api/history/:id`.

### Cambiado
- Sparkline en cada fila de la lista.
- Columna de uptime 24h en la lista.

---

## [1.0] — 2025-05-01

### Añadido
- Monitor HTTP/HTTPS con comprobación periódica configurable.
- Dashboard con estado en tiempo real — operativo/caído por sitio.
- Código de estado HTTP y tiempo de respuesta.
- Historial de últimas 50 comprobaciones con barras visuales por fila.
- Añadir y eliminar sitios desde la UI.
- Comprobación manual inmediata por sitio.
- Aceptación de certificados autofirmados (apps internas).
- Datos persistidos en JSON — sin base de datos.
- Contenedor Docker único con volumen para datos.
- Compatible con Cosmos Cloud, Traefik y acceso directo por puerto.
- Intervalo configurable via variable de entorno `CHECK_INTERVAL`.

## [4.3.0] — 2025-05-05

### Añadido
- **Login con protección de fuerza bruta** — panel protegido con contraseña opcional.
  - JWT con expiración de 24h.
  - Máximo 5 intentos fallidos, bloqueo 15 minutos con contador regresivo.
  - Contraseña hasheada con bcrypt en `config.json`.
  - Primera vez: página de setup con opción de saltar.
  - Cambiar o eliminar contraseña desde ajustes → Sistema.
  - Botón de cierre de sesión en el header cuando hay contraseña activa.
- **Diagnóstico de caída automático + manual**
  - Banner en vista detalle cuando el sitio está caído.
  - DNS: tiempo de resolución, IPs, nameservers.
  - Ping HTTP HEAD: latencia, código HTTP.
  - Traceroute: hops con IP y latencia coloreada por velocidad.
  - Resultado cacheado, se refresca cada 5 minutos máximo.
- Página `/login.html` con diseño consistente.
- Nuevos endpoints: `/api/auth/*`, `/api/diagnose/:id`.
- Middleware de auth en todas las rutas `/api/*` excepto públicas.

### Dependencias
- Añadido: `bcryptjs`, `jsonwebtoken`


## [5.0.0] — 2025-05-05

### Añadido — Red colaborativa distribuida
- **Identidad de nodo** — keypair ED25519 generado al arrancar en `/data/.nodekey`. Node ID = hash SHA-256 del public key (primeros 16 chars).
- **Gossip protocol** — los nodos intercambian listas de peers entre sí. Descubrimiento automático sin servidor central obligatorio.
- **Bootstrap federado** — cualquier nodo puede activar modo bootstrap. Lista hardcodeada inicial con nodos semilla. Si el bootstrap primario cae, los nodos usan los alternativos descubiertos por gossip.
- **Heartbeat entre nodos** — cada 5 minutos. Detección de nodo offline tras 3 heartbeats perdidos con consenso de mayoría (>50% de peers confirman).
- **Alerta de nodo offline** — webhook de emergencia (ntfy.sh, Discord, Telegram, genérico) cifrado con la clave pública del dueño. Los peers pueden ejecutarlo pero no leerlo.
- **Verificación cruzada de caídas** — al detectar caída, consulta a N peers aleatorios. Consenso ponderado por reputación. Resultado: "caído desde X/Y nodos externos" o "solo local".
- **Reputación de peers** — score 0-1, crece con respuestas correctas, decae con fallos. Solo peers con reputación ≥0.3 votan en el consenso.
- **Modo pasivo** — nodos detrás de NAT participan en la red sin aceptar conexiones entrantes.
- **Tab "Red" en ajustes** — activar/desactivar, configurar URL pública, modo bootstrap, webhook de emergencia, estado de la red y lista de peers con reputación.
- **Verificación externa en diagnóstico** — al ver un sitio caído, muestra resultado de la verificación de la red (consenso + confianza + votos).

### API nueva
- `GET /api/peer/info` — metadata pública del nodo
- `GET /api/peer/peers` — lista de peers para gossip
- `GET /api/peer/verify?url=X` — verificar URL desde este nodo
- `POST /api/peer/trace` — traceroute desde este nodo
- `POST /api/peer/heartbeat` — recibir heartbeat de peer
- `GET /api/network/status` — estado de la red (requiere auth)
- `POST /api/network/verify/:id` — verificación cruzada de un sitio
- `GET /statusmon/peers` — lista pública de peers (solo en modo bootstrap)
- `POST /statusmon/peers/register` — registro de nuevo nodo (solo en modo bootstrap)
- `GET /statusmon/peers/health` — estado del bootstrap

### Dependencias
- Añadido: `tweetnacl`, `tweetnacl-util`

### Arquitectura
- Código de red extraído a módulos separados en `src/network/`:
  `crypto.js`, `peers.js`, `bootstrap.js`, `heartbeat.js`, `verify.js`, `routes.js`


## [5.1.0] — 2025-05-05

### Añadido
- **`/` como página principal** — la vista pública de estado es ahora la entrada principal de StatusMon.
- **Filtrado por tag en la URL** — `status.uverse.es/midnight` muestra solo sitios con tag "midnight". Cualquier tag configurado genera una URL compartible.
- **Login inline** — botón "⚙ Administrar" en la página pública abre un modal de login sin salir de la página. Con sesión activa, va directo a `/admin`.
- **Panel de admin en `/admin`** — el panel de gestión completo vive en su propia ruta.
- **Vista pública nivel intermedio** — estado general (banner verde/rojo), sección de incidencias activas, barra de filtro por tags, resumen de stats (servicios, operativos, caídos, tiempo medio), lista con uptime 24h y tiempo de respuesta medio.
- **Widget embebible** — `<iframe src="https://status.uverse.es/widget">` o `/widget/midnight` para filtrado. Diseñado para 300-400px, tema oscuro, auto-actualización.
- **Protección antifuerza bruta en modal de login** — contador regresivo visible directamente en el modal.
- Endpoint `/api/status/public` ahora acepta `?tag=X` para filtrar por etiqueta y devuelve `allTags` con todos los tags disponibles.

### Cambiado
- `status.html` completamente rediseñado — ahora es la página principal.
- `login.html` ya no es necesario para el flujo principal (se mantiene como fallback).
- `index.html` (panel admin) redirige a `/` en lugar de `/login.html` si no hay sesión.
- Logout redirige a `/` en lugar de `/login.html`.


## [5.1.1] — 2025-05-07

### Añadido
- **Icono PNG para Safari/macOS** — `icon-180.png` y `icon-512.png` generados del SVG. `apple-touch-icon` actualizado en todos los HTML. Safari en macOS ya muestra el icono correcto al añadir al dock.
- **Última comprobación en el header del admin** — línea de info bajo el botón de refresco mostrando "Última comprobación: hace Xmin". Se actualiza cada segundo.

### Cambiado
- `docker-compose.yml` — `src/` ahora montado como volumen `:ro` igual que `public/`. Cualquier cambio en código o frontend aplica con `docker compose restart statusmon`, sin rebuild.
- Manifest actualizado con entradas PNG además de SVG.


## [5.1.2] — 2025-05-07

### Arreglado
- `/` ahora sirve correctamente `status.html` — `express.static` ya no intercepta la ruta raíz con `index.html` (opción `index: false`).
- Panel de admin movido a `admin.html` — evita conflicto con el fichero estático `index.html`.
- Rutas explícitas `/status` y `/status/:tag` añadidas al servidor.
- Tags en la barra de filtros ahora usan `/status/tagname` en vez de `/tagname`.
- "Todos" en la barra de tags ya no redirige al admin.
- `checkAuth` y logout en el admin redirigen a `/status` en vez de `/`.
- Filtro por tag en `/api/status/public` ya no filtra cuando `tag=null` o `tag=all`.


## [5.1.3] — 2025-05-07

### Arreglado
- Export CSV daba 401 Unauthorized — la ruta `/api/history/:id/csv` requería token JWT pero los navegadores no lo mandan en navegación directa. Añadida a rutas públicas.
- `admin.html` reconstruido limpiamente — errores de template literals anidados y referencias a `timeAgo` no definida.
- Tab Red en ajustes mejorado con tabla de peers, reputación y datos de la red.

### Añadido
- Endpoint `GET /api/network/stats` (público) — estadísticas globales de la red: node ID, peers activos/totales, bootstraps, top 20 peers con reputación. Usado por el tab Red y próximamente por `/about`.


## [5.2.0] — 2025-05-07

### Añadido
- **Página `/about`** — presentación completa de StatusMon con features, instalador interactivo y releases.
- **Instalador interactivo** — generador de `docker-compose.yml` personalizado por entorno (Docker, QNAP, Synology, VPS, Cosmos). Descarga directa del archivo generado.
- **Badges SVG dinámicos** — `/badge/:nombre` genera un badge con el estado del sitio en tiempo real. Para README de GitHub o webs.
- **Releases híbridas** — las últimas 3 releases van en el paquete (`releases.json`). Fetch automático a `statusmon.uverse.es` para versiones anteriores.
- **Badge de actualización** en el header del admin — cuando hay una versión más nueva disponible aparece un aviso naranja con enlace a `/about#releases`.
- **Banner de comunidad** en el footer de `/status` — invitación a instalar StatusMon con contador de nodos en la red.
- **Link a `/about`** en el header del admin (icono `?`).
- Endpoints nuevos: `GET /badge/:name`, `GET /api/releases`, `GET /api/about`.

### Arreglado
- **Fondo de `/status` demasiado oscuro** — cambiado de `#07080d` a `#111318` (antracita).
- **Tab Red en ajustes no guardaba** — `openSettings()` ahora hace fetch fresco de config antes de sincronizar los campos, y siempre sincroniza `network` aunque el objeto no exista en `serverCfg`.


## [5.2.0+2] — 2025-05-07

### Arreglado
- **Red no se guardaba** — `network` no estaba incluido en el payload de `saveSettings()`. Corregido.
- **Fondo demasiado oscuro** en `/status` y `/about` — aclarado a `#1a1d27` con mejora de contraste en textos (`--muted` más claro).
- **Carpeta `/releases`** añadida al paquete con el ZIP de la versión actual y endpoint `/releases/latest` que redirige al ZIP más reciente.


## [5.2.0+3] — 2025-05-07

### Arreglado
- **SW interceptaba fetch cross-origin** — el Service Worker ya no intercepta peticiones a dominios externos (statusmon.uverse.es etc). Error "Load failed" en tab Red resuelto.
- **Textos oscuros** en status y about — `--text` subido a `#eef0fa`, `--muted` a `#8b8fb8`.
- **Versión en releases.json** corregida a `5.2.0+2`.
- **Tab Red** — `network` se incluye correctamente en `saveSettings` (fix incompleto en +2).

### Mejorado
- **Releases escaneadas** — `/api/releases` escanea el directorio `public/releases/` en tiempo real. Muestra los ZIPs disponibles con tamaño real.
- **Fallback de releases a la red** — si no hay ZIPs locales, `about.html` los busca en `statusmon.uverse.es`. Las versiones de red se marcan como "desde la red".
- **Tab Sistema** — muestra el espacio ocupado por la carpeta `releases/` además de datos, historial y backups.
- SW actualizado a `statusmon-v5`.


## [5.2.1+2] — 2025-05-07

### Arreglado
- **URL pública autodetectada** en ajustes → Red. Si el campo está vacío al abrir ajustes, se rellena automáticamente usando las cabeceras del proxy (X-Forwarded-Host, X-Scheme). El texto aparece en gris para indicar que es una sugerencia editable.
- Nomenclatura de versiones actualizada al nuevo sistema `MAJOR.MINOR.PATCH+BUILD`.

### Añadido
- Endpoint `GET /api/detect-url` — detecta la URL pública del nodo desde cabeceras del proxy inverso.


## [5.2.1+3] — 2025-05-07

### Arreglado
- `.overall-sub` y `.url` en `/status` — color cambiado a `var(--text)` con opacidad y `#a0a4cc` respectivamente para mejor contraste.
- Link `statusmon.uverse.es` en footer de `/about` — reemplazado por "Estado de esta instalación" apuntando a `/status` local.
- **Comparación de versiones en `checkForUpdates`** — implementado parser semver real que entiende el formato `MAJOR.MINOR.PATCH+BUILD`. Compara cada componente numéricamente en vez de comparar strings.
- El aviso de actualización también consulta las releases locales además de las remotas.


## [5.2.2+1] — 2025-05-07

### Añadido
- **Página `/network`** — landing de la red colaborativa con mapa SVG mundial, contadores globales (nodos, sitios, uptime medio, continentes), barras de distribución por continente y lista de nodos públicos con URL, sitios monitorizados, uptime y versión.
- Endpoint `GET /api/network/map` — datos agregados anónimos de la red para el mapa. Incluye nodos activos, continentes, totales y stats.
- `/api/peer/info` ahora incluye `sitesMonitored` (número de sitios, sin nombres ni URLs).
- Link a `/network` en la nav de `/status` y `/about`.
- Ruta `/network` en el servidor.
- Detección de continente por IP (heurística aproximada, sin API externa).


## [5.2.2+2] — 2025-05-07

### Arreglado
- **Desbordamiento mobile en /status** — nombres largos (ej. "app midnight", "plex") se salían de su celda. Añadido `min-width:0`, `overflow:hidden` y `text-overflow:ellipsis` a `.s-info`. En mobile el layout pasa a 2 columnas con métricas apiladas.
- **Mapa de red eliminado** — reemplazado por gráfica de burbujas SVG proporcionales por continente. Sin coordenadas falsas, sin detección de IP imprecisa.
- **crypto.js** — fix de tipos `Uint8Array` en `sign()` incluido en el standalone.


## [5.2.2+3] — 2025-05-07

### Arreglado
- **Continente incorrecto en /network** — la detección por IP era completamente infiable detrás de NAT/proxy (IPs internas como 172.x daban "América del Sur"). Ahora usa el valor configurado en ajustes.
- **Selector de región** añadido en ajustes → Red — Europa, América del Norte/Sur, Asia, África, Oceanía. Se guarda en `config.json` y se propaga a la red con el heartbeat.


## [5.2.2+4] — 2025-05-07

### Arreglado
- **Detección de continente** — reemplazada la heurística inventada por geolocalización real via `ipwho.is` (gratuito, sin API key). Al arrancar, si no hay continente configurado manualmente, hace una consulta con la IP pública del servidor y guarda el resultado en `config.json`. El valor manual en ajustes → Red siempre tiene prioridad.
- Verificado con IP real 185.196.203.19 → España → Europa → `EU`.


## [5.2.3+1] — 2025-05-07

### Mejorado
- **Escrituras a disco reducidas drásticamente** — `history.json` solo se escribe cuando hay cambio real:
  - Cambio de estado (up↔down) → escritura inmediata
  - Sitio caído → siempre registra
  - Variación de tiempo de respuesta >10% → registra
  - Sin cambios significativos → no escribe
  - Las escrituras se batean en bloques de 5 minutos máximo
  - Flush garantizado en SIGTERM/SIGINT para no perder datos al parar
- **`peers.json`** — escrituras throttleadas a máximo 1 vez por minuto (antes era en cada heartbeat, cada 5 min × todos los peers)
- **Logs Docker** limitados a 10MB × 3 archivos = 30MB máximo en `docker-compose.yml`


## [5.2.3+2] — 2025-05-07

### Añadido
- **Opción de almacenamiento en ajustes → General → Almacenamiento**:
  - *Guardar historial*: Solo al apagar (por defecto) / Cada 5 min / Cada 30 min / En cada check
  - *Peers solo en memoria*: activado por defecto — `peers.json` solo se escribe al apagar, los peers se redescubren solos via bootstrap si hay pérdida de datos
- Flush garantizado de historial y peers en SIGTERM/SIGINT
- `peers.init()` recibe `configLoader` para respetar la configuración en tiempo real

