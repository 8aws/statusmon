#!/bin/sh
# StatusMon — script de actualización
# Uso: sh update.sh
# Ejecutar desde la carpeta nueva descomprimida, apuntando a la instalación existente
# Ejemplo: sh statusmon-v3/update.sh (desde el directorio padre)

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$(pwd)}"

echo ""
echo "StatusMon — Actualización"
echo "Origen:  $SCRIPT_DIR"
echo "Destino: $TARGET"
echo ""

# Verificar que el destino parece una instalación de StatusMon
if [ ! -f "$TARGET/docker-compose.yml" ] || [ ! -f "$TARGET/src/server.js" ]; then
  echo "${RED}✗ No parece una instalación de StatusMon en: $TARGET${NC}"
  echo "  Uso: sh update.sh /ruta/a/statusmon"
  exit 1
fi

# Backup del docker-compose.yml personalizado
echo "${YELLOW}→ Guardando tu docker-compose.yml actual como docker-compose.yml.bak${NC}"
cp "$TARGET/docker-compose.yml" "$TARGET/docker-compose.yml.bak"

# Copiar ficheros actualizables (nunca docker-compose.yml)
echo "→ Actualizando src/..."
cp -r "$SCRIPT_DIR/src/"* "$TARGET/src/"

echo "→ Actualizando public/..."
cp -r "$SCRIPT_DIR/public/"* "$TARGET/public/"

echo "→ Actualizando Dockerfile y package.json..."
cp "$SCRIPT_DIR/Dockerfile" "$TARGET/Dockerfile"
cp "$SCRIPT_DIR/package.json" "$TARGET/package.json"
cp "$SCRIPT_DIR/package-lock.json" "$TARGET/package-lock.json"

# Reconstruir y reiniciar
echo "→ Reconstruyendo contenedor (los datos se conservan)..."
cd "$TARGET"
docker compose down
docker compose up -d --build

echo ""
echo "${GREEN}✓ Actualización completada${NC}"
echo "  Tu docker-compose.yml personalizado se ha conservado"
echo "  Backup guardado en docker-compose.yml.bak"
echo "  Datos históricos intactos en el volumen statusmon_data"
echo ""
echo "  Logs: docker compose logs -f statusmon"
echo ""
