#!/bin/sh
# StatusMon — script de instalación rápida v5.6
#
# Uso:
#   sh install.sh                            → acceso directo en puerto 3000
#   sh install.sh --port 8080                → puerto personalizado
#   sh install.sh --data /ruta/a/datos       → ruta de datos personalizada
#   sh install.sh --port 3000 --data /ruta   → ambas opciones
#
# Ejemplos:
#   sh install.sh --data /share/statusmon/data
#   sh install.sh --port 8080 --data /opt/statusmon/data

set -e

PORT="3000"
DATA_DIR="/opt/statusmon/data"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Parsear argumentos
while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2";     shift 2 ;;
    --data)   DATA_DIR="$2"; shift 2 ;;
    *)        echo "${RED}Argumento desconocido: $1${NC}"; exit 1 ;;
  esac
done

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║   StatusMon v5.6 — Monitor de uptime  ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── Comprobaciones previas ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "${RED}✗ Docker no encontrado.${NC}"
  echo "  Instálalo en: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "${RED}✗ Docker Compose v2 no encontrado.${NC}"
  echo "  Asegúrate de tener Docker 20.10+ con el plugin compose."
  exit 1
fi

echo "${GREEN}✓ Docker $(docker --version | cut -d' ' -f3 | tr -d ',') encontrado${NC}"

# ── Crear directorio de datos ─────────────────────────────────────────
echo "  Directorio de datos: ${CYAN}${DATA_DIR}${NC}"
mkdir -p "$DATA_DIR" || {
  echo "${RED}✗ No se pudo crear ${DATA_DIR}. Comprueba permisos.${NC}"
  exit 1
}
echo "${GREEN}✓ Directorio de datos listo${NC}"

# ── Configurar docker-compose.yml ────────────────────────────────────
# Reemplazar la ruta de datos y descomentar ports
sed -i "s|/opt/statusmon/data:/data|${DATA_DIR}:/data|g" docker-compose.yml

# Descomentar la sección ports
sed -i "s|# ports:|ports:|g" docker-compose.yml
sed -i "s|#   - \"3000:3000\"|  - \"${PORT}:3000\"|g" docker-compose.yml

echo "${GREEN}✓ docker-compose.yml configurado (puerto ${PORT})${NC}"
echo "${YELLOW}  ⚠ Si usas proxy inverso, comenta manualmente la sección ports: en docker-compose.yml${NC}"

# ── Descargar imagen y arrancar ──────────────────────────────────────
echo ""
echo "Descargando imagen Docker Hub (primera vez ~30s según conexión)..."
docker compose up -d

echo ""
echo "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo "${GREEN}║           StatusMon instalado y corriendo         ║${NC}"
echo "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Detectar IP local
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "IP-DEL-SERVIDOR")

echo "  Panel de admin:  ${CYAN}http://${IP}:${PORT}/admin${NC}"
echo "  Estado público:  ${CYAN}http://${IP}:${PORT}${NC}"
echo "  Healthcheck:     ${CYAN}http://${IP}:${PORT}/api/health${NC}"
echo ""
echo "  La primera vez que accedas al panel te pedirá crear una contraseña."
echo ""
echo "  Datos guardados en:  ${DATA_DIR}"
echo "  Ver logs:            docker compose logs -f statusmon"
echo "  Parar:               docker compose down"
echo "  Reiniciar:           docker restart statusmon"
echo ""
