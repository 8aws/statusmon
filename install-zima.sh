#!/bin/sh
# StatusMon — instalador para ZimaOS / ZimaBlade / ZimaBoard v5.6
# Versión 5.6.7 — rutas ajustadas para ZimaOS 1.6.x
#
# Uso:
#   sh install-zima.sh                    → datos en ~/AppData/statusMon, puerto auto
#   sh install-zima.sh --port 3000        → puerto fijo (normalmente no necesario)
#   sh install-zima.sh --data ~/otro/dir  → ruta de datos personalizada
#
# Pasos previos en ZimaOS:
#   1. Descarga statusmon-v5.6.7.zip a tu ordenador
#   2. En ZimaOS Files sube el ZIP (p.ej. a ~/ o ~/DATA/)
#   3. Clic derecho → Extract Here
#   4. Abre el Terminal de ZimaOS y ejecuta:
#        cd ~/statusmon-v5.6.7
#        sh install-zima.sh

set -e

# ZimaOS 1.6.x almacena los datos de apps bajo ~/AppData/<AppName>/
# (equivale a /root/AppData/statusMon en disco)
DATA_DIR="${HOME}/AppData/statusMon"
PORT=""          # vacío = usar WEBUI_PORT de ZimaOS (auto-asignado)
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Argumentos opcionales ─────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2";     shift 2 ;;
    --data)   DATA_DIR="$2"; shift 2 ;;
    *)        echo "${RED}Argumento desconocido: $1${NC}"; exit 1 ;;
  esac
done

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║   StatusMon v5.6 — Instalador para ZimaOS   ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# ── Verificar que estamos en el directorio correcto ───────────────────
if [ ! -f "package.json" ] || [ ! -f "docker-compose.zima.yml" ]; then
  echo "${RED}✗ Ejecuta este script desde el directorio de StatusMon.${NC}"
  echo "  Ejemplo: cd ~/statusmon-v5.6.7 && sh install-zima.sh"
  exit 1
fi

# ── Docker disponible ─────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "${RED}✗ Docker no encontrado.${NC}"
  echo "  ZimaOS incluye Docker. Si lo acabas de instalar, reinicia ZimaOS."
  exit 1
fi

echo "${GREEN}✓ Docker $(docker --version | cut -d' ' -f3 | tr -d ',') disponible${NC}"

# ── Crear directorio de datos ─────────────────────────────────────────
echo "  Directorio de datos: ${CYAN}${DATA_DIR}${NC}"
mkdir -p "$DATA_DIR" || {
  echo "${RED}✗ No se pudo crear ${DATA_DIR}. Comprueba permisos.${NC}"
  exit 1
}
echo "${GREEN}✓ Directorio de datos listo${NC}"

# ── Preparar docker-compose local ────────────────────────────────────
cp docker-compose.zima.yml docker-compose.zima.local.yml

# Sustituir $HOME por la ruta absoluta real (docker compose no expande $HOME en todos los sistemas)
REAL_HOME="${HOME}"
sed -i "s|\\\$HOME/AppData/statusMon|${REAL_HOME}/AppData/statusMon|g" docker-compose.zima.local.yml

# Si se especificó --data con ruta diferente, sobreescribir
if [ "$DATA_DIR" != "${REAL_HOME}/AppData/statusMon" ]; then
  sed -i "s|${REAL_HOME}/AppData/statusMon:/data|${DATA_DIR}:/data|g" docker-compose.zima.local.yml
  echo "${GREEN}✓ Ruta de datos configurada: ${DATA_DIR}${NC}"
fi

# Puerto
if [ -n "$PORT" ]; then
  sed -i "s|\${WEBUI_PORT:-3000}|${PORT}|g" docker-compose.zima.local.yml
  echo "${GREEN}✓ Puerto configurado: ${PORT}${NC}"
else
  sed -i 's|"${WEBUI_PORT:-3000}"|"3000"|g' docker-compose.zima.local.yml
  PORT="3000"
fi

# ── Descargar imagen y arrancar ──────────────────────────────────────
echo ""
echo "Descargando imagen Docker Hub (primera vez ~30s según conexión)..."
docker compose -f docker-compose.zima.local.yml up -d

echo ""
echo "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo "${GREEN}║        StatusMon instalado en ZimaOS ✓               ║${NC}"
echo "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "IP-DE-ZIMA")

echo "  Panel admin:  ${CYAN}http://${IP}:${PORT}/admin${NC}"
echo "  Estado:       ${CYAN}http://${IP}:${PORT}${NC}"
echo ""
echo "  La primera vez que abras el panel te pedirá crear una contraseña."
echo ""
echo "  Datos en:     ${DATA_DIR}"
echo "  Ver logs:     docker logs statusmon -f"
echo "  Parar:        docker stop statusmon"
echo "  Reiniciar:    docker restart statusmon"
echo ""
echo "${YELLOW}  💡 El contenedor aparecerá en ZimaOS bajo Apps → My Apps${NC}"
echo ""
