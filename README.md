# StatusMon v5.6

Monitor de uptime, rendimiento y análisis de respuesta self-hosted. Sin base de datos, sin dependencias externas, sin registro, sin telemetría.

![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker) ![PWA](https://img.shields.io/badge/PWA-instalable-5A0FC8) ![License](https://img.shields.io/badge/licencia-MIT-green)

---

## Qué hace

- **Monitoriza** HTTP/HTTPS, TCP, DNS y heartbeats con intervalo configurable
- **Mide** tiempo de respuesta total, TTFB y tamaño de respuesta por separado
- **Detecta** el stack tecnológico desde las cabeceras HTTP (nginx, Apache, PHP, Node, Cloudflare…)
- **Analiza** certificados SSL: días hasta caducidad, emisor, CN
- **Estadísticas** por sitio: P50/P75/P95/P99, media, desv. típica, uptime 24h/7d/total, MTBF, tendencia
- **Historial de 7 días** a 1 check/min (10 080 entradas por sitio) con gráfica SVG interactiva
- **Selector de rango temporal** en el detalle: 1h / 6h / 24h / 7d / personalizado (desde/hasta)
- **Alertas** por correo (SMTP manual, presets Gmail/Outlook, o envío directo sin relay) y Web Push
- **Notificaciones push** nativas en navegador y móvil (VAPID, sin servicio de terceros)
- **Stats del servidor**: RAM, CPU%, disco, load average, temperatura — leídas de `/proc` sin dependencias
- **Backups automáticos** de la configuración antes de cada actualización
- **Actualización in-app**: sube un ZIP desde el panel y se aplica sin SSH
- **PWA instalable** en móvil y escritorio, funciona offline
- **Sin base de datos**: todo en ficheros JSON en un directorio bind-mounted

---

## Requisitos

- Docker y Docker Compose v2+ (`docker compose version` debe funcionar)
- Linux: NAS QNAP/Synology, Raspberry Pi, VPS, servidor casero
- Proxy inverso recomendado para HTTPS: Nginx Proxy Manager, Traefik, Caddy, Cosmos Cloud

---

## Instalación rápida

### 1. Copia el ZIP al servidor y descomprime

```bash
# En el servidor de destino
mkdir -p /opt/statusmon
cd /opt/statusmon
unzip statusmon-v5.6.6.zip
cd statusmon-v5.6.6
```

### 2. Elige dónde guardar los datos

Los datos (configuración, historial, credenciales) se guardan en un directorio **bind-mounted** para que persistan fuera del contenedor y sobrevivan a las actualizaciones.

Edita `docker-compose.yml` y ajusta la ruta del volumen de datos:

```yaml
# Opción A — ruta explícita en el host (recomendado)
volumes:
  - /opt/statusmon/data:/data

# Opción B — volumen Docker gestionado (más simple, sin ruta visible)
volumes:
  - statusmon_data:/data
```

### 3. Configura el acceso

**Sin proxy inverso (acceso directo por IP):** descomenta `ports` en `docker-compose.yml`:

```yaml
ports:
  - "3000:3000"
```

**Con Nginx Proxy Manager / Traefik / Caddy:** deja `ports` comentado y apunta tu proxy al contenedor en el puerto 3000. El contenedor y el proxy deben estar en la misma red Docker.

**Con Cosmos Cloud:**
```yaml
labels:
  cosmos-name: statusmon
  cosmos-port: "3000"
  cosmos-host: status.tudominio.com
  cosmos-ssl: "true"
```

### 4. Arranca

```bash
docker compose up -d --build
```

La primera vez tarda 1-2 minutos en construir la imagen. Después arranca en segundos.

### 5. Primera configuración

Abre `http://IP-DEL-SERVIDOR:3000/admin` (o tu dominio con proxy).

- La **primera visita** te pedirá crear una contraseña de administrador.
- Desde el panel añade tus sitios a monitorizar.
- Configura alertas por correo y/o Web Push en la pestaña **Alertas** de ajustes.

---

## Variables de entorno

Solo se necesitan para cambiar valores de arranque. El resto de la configuración vive en el panel de admin y se guarda en `/data/config.json`.

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto interno del contenedor |
| `DATA_DIR` | `/data` | Directorio donde se guardan todos los datos |

Los parámetros de monitorización (intervalo, timeout, historial máximo, etc.) se configuran desde **Ajustes → General** en el panel de admin, no mediante variables de entorno.

---

## Estructura de datos en `/data`

```
/data/
├── config.json          # Configuración de la app (intervalo, alertas, etc.)
├── sites.json           # Lista de sitios monitorizados
├── history.json         # Historial de checks (hasta 10 080 entradas por sitio)
├── metrics.json         # Métricas del servidor (RAM, CPU, disco)
├── .secret              # Clave de cifrado AES-256 (generada automáticamente)
├── .jwtsecret           # Clave JWT (generada automáticamente)
├── .vapid.json          # Claves VAPID para Web Push (generadas automáticamente)
├── .push-subs.json      # Suscripciones Web Push activas
├── backups/             # Backups automáticos pre-actualización
├── favicons/            # Caché de favicons de los sitios
└── releases/            # ZIPs de versiones aplicadas (para descarga desde el panel)
```

> **Nunca borres `.secret`** — se usa para descifrar las contraseñas SMTP guardadas. Si se pierde tendrás que reconfigurar el correo.

---

## Actualizar

### Desde el panel de admin (recomendado)

1. Descarga el ZIP de la nueva versión.
2. En **Admin → Ajustes → Actualización**: sube el ZIP y pulsa **Aplicar**.
3. El servidor reinicia automáticamente (el panel cuenta atrás 12 segundos y recarga).

### Desde el servidor (SSH)

```bash
cd /opt/statusmon
unzip statusmon-v5.6.x.zip
cd statusmon-v5.6.6     # ajusta la versión

# Copia src/ y public/ sobre la instalación actual
cp -r src/*    /opt/statusmon/statusmon-v5.6.5/src/
cp -r public/* /opt/statusmon/statusmon-v5.6.5/public/

# Reinicia el contenedor
docker restart statusmon
```

> Los datos en `/data` nunca se tocan durante la actualización.

---

## Backup y restauración

```bash
# Backup del directorio de datos
tar czf statusmon-backup-$(date +%Y%m%d).tar.gz -C /opt/statusmon/data .

# Restaurar en una instalación nueva
tar xzf statusmon-backup-20240101.tar.gz -C /opt/statusmon/data
```

Si usas volumen Docker nombrado en vez de bind mount:

```bash
# Backup
docker run --rm -v statusmon_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/statusmon-backup.tar.gz -C /data .

# Restaurar
docker run --rm -v statusmon_data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/statusmon-backup.tar.gz -C /data
```

---

## API REST

Todos los endpoints con `*` requieren token JWT (header `Authorization: Bearer <token>`).
El token se obtiene con `POST /api/auth/login`.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{"password":"…"}` → devuelve `token` |
| GET | `/api/status` | * | Estado actual de todos los sitios |
| GET | `/api/status/public` | — | Estado público (sin datos sensibles) |
| GET | `/api/sites` | * | Lista de sitios |
| POST | `/api/sites` | * | Añadir sitio |
| PUT | `/api/sites/:id` | * | Editar sitio |
| DELETE | `/api/sites/:id` | * | Eliminar sitio |
| GET | `/api/history/:id` | * | Historial de checks. Params: `?since=<ms>&until=<ms>` |
| GET | `/api/history/:id/csv` | — | Exportar historial como CSV |
| GET | `/api/stats/:id` | * | Estadísticas calculadas. Params: `?since=<ms>&until=<ms>` |
| POST | `/api/check/:id` | * | Forzar comprobación inmediata |
| GET | `/api/health` | — | `{"ok":true,"version":"…","uptime":…}` — healthcheck público |
| GET | `/api/nas` | * | Stats del servidor (RAM, CPU, disco, temperatura) |
| GET | `/api/releases` | — | Lista de versiones disponibles |
| POST | `/api/update/upload` | * | Subir ZIP de actualización |
| POST | `/api/update/apply` | * | Aplicar actualización pendiente |

Ejemplo de uso:

```bash
# Login y guardar token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"tu-contraseña"}' | jq -r .token)

# Ver estado de todos los sitios
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/status | jq

# Historial de las últimas 6 horas de un sitio
SINCE=$(date -d '6 hours ago' +%s%3N 2>/dev/null || date -v-6H +%s%3N)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/history/SITE_ID?since=$SINCE" | jq
```

---

## Stats del servidor — notas

Las métricas se leen directamente de `/proc` del host (montado como `/host/proc:ro` en el contenedor). Sin agentes, sin instalar nada extra.

- **RAM**: `/proc/meminfo` — usa `MemAvailable` para el cálculo real de libre
- **CPU**: dos lecturas de `/proc/stat` separadas 200ms
- **Disco**: `df -B1 /` — volumen raíz del contenedor
- **Temperatura**: `/sys/class/thermal/thermal_zone*` con fallback a `/sys/class/hwmon`

Para exponer temperatura en Docker añade al `docker-compose.yml`:

```yaml
volumes:
  - /sys/class/thermal:/sys/class/thermal:ro
  - /sys/class/hwmon:/sys/class/hwmon:ro
```

---

## Estructura del proyecto

```
statusmon/
├── src/
│   ├── server.js          # Backend Node.js + Express
│   ├── push.js            # Web Push VAPID (RFC 8291, sin npm extra)
│   ├── metrics/           # Lectura de métricas del host
│   └── network/           # Peering entre instancias StatusMon
├── public/
│   ├── admin.html         # Panel de administración completo
│   ├── status.html        # Página de estado pública
│   ├── about.html         # Página de información
│   ├── manifest.json      # PWA manifest
│   ├── sw.js              # Service worker (cache + push handler)
│   └── *.svg / *.png      # Iconos
├── Dockerfile
├── docker-compose.yml
├── install.sh
└── README.md
```

---

## Licencia

MIT — úsalo, modifícalo y distribúyelo libremente.
