#!/bin/bash
# StatusMon — Script de publicación inicial
# Ejecutar UNA VEZ desde el directorio statusmon-github/
#
# Requisitos previos:
#   1. Tener git instalado (viene con Xcode Command Line Tools)
#   2. Crear repo vacío en https://github.com/new  (nombre: statusmon, público, sin README)
#   3. Crear repo en https://hub.docker.com/repository/create  (nombre: statusmon, público)
#   4. Tener Docker Desktop corriendo

set -e

GITHUB_USER="8aws"
DOCKERHUB_USER="espiralvex"
VERSION="5.6.8"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║   StatusMon — Publicación inicial en GitHub      ║"
echo "  ║   y Docker Hub                                   ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ── PASO 1: Limpiar .git roto del sandbox y reinicializar ─────────────
echo "${CYAN}[1/6] Inicializando repositorio git...${NC}"
rm -rf .git
git init
git config user.email "espiralvex@outlook.com"
git config user.name "espiralvex"
git branch -M main
echo "${GREEN}✓ git init completado${NC}"

# ── PASO 2: Primer commit ──────────────────────────────────────────────
echo "${CYAN}[2/6] Creando primer commit...${NC}"
git add .
git commit -m "Initial commit — StatusMon v${VERSION}

- Self-hosted uptime monitor (HTTP, TCP, DNS, Heartbeat)
- Multi-arch Docker image: ${DOCKERHUB_USER}/statusmon
- ZimaOS App Store Custom Install support
- 7-day history with time-range selector
- SMTP alerts + Web Push VAPID
- Server stats (CPU, RAM, disk, temperature)
- In-app updates via ZIP upload
- GitHub Actions: auto build+push on tag"
echo "${GREEN}✓ Commit creado${NC}"

# ── PASO 3: Push a GitHub ──────────────────────────────────────────────
echo ""
echo "${CYAN}[3/6] Conectando con GitHub...${NC}"
echo "${YELLOW}  ⚠ Asegúrate de haber creado el repo en https://github.com/new${NC}"
echo "     Nombre: statusmon | Público | SIN README ni .gitignore"
echo ""
read -p "  Pulsa ENTER cuando el repo esté creado en GitHub..."

git remote add origin "https://github.com/${GITHUB_USER}/statusmon.git"
git push -u origin main
echo "${GREEN}✓ Código subido a GitHub${NC}"

# ── PASO 4: Tag de la versión (dispara GitHub Actions) ────────────────
echo ""
echo "${CYAN}[4/6] Creando tag v${VERSION}...${NC}"
git tag "v${VERSION}"
git push origin "v${VERSION}"
echo "${GREEN}✓ Tag v${VERSION} subido — GitHub Actions construirá la imagen Docker automáticamente${NC}"
echo "  Puedes ver el progreso en: https://github.com/${GITHUB_USER}/statusmon/actions"

# ── PASO 5: Build y push manual a Docker Hub (primera vez) ────────────
echo ""
echo "${CYAN}[5/6] Build y push a Docker Hub...${NC}"
echo "${YELLOW}  ⚠ Asegúrate de haber creado el repo en https://hub.docker.com/repository/create${NC}"
echo "     Nombre: statusmon | Público"
echo ""
read -p "  Pulsa ENTER cuando el repo esté creado en Docker Hub..."

echo "  Haciendo login en Docker Hub..."
docker login

echo ""
echo "  Construyendo imagen multi-arch y subiendo (puede tardar 3-5 min)..."
docker buildx create --use --name statusmon-builder 2>/dev/null || docker buildx use statusmon-builder 2>/dev/null || true
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t "${DOCKERHUB_USER}/statusmon:${VERSION}" \
  -t "${DOCKERHUB_USER}/statusmon:latest" \
  --push \
  .
echo "${GREEN}✓ Imagen subida a Docker Hub${NC}"

# ── PASO 6: Instrucciones finales ─────────────────────────────────────
echo ""
echo "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo "${GREEN}║           StatusMon publicado con éxito ✓                ║${NC}"
echo "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  GitHub:     https://github.com/${GITHUB_USER}/statusmon"
echo "  Docker Hub: https://hub.docker.com/r/${DOCKERHUB_USER}/statusmon"
echo ""
echo "  Próximas versiones:"
echo "  1. Edita el código en statusmon-github/"
echo "  2. Bump APP_VERSION en src/server.js y version en package.json"
echo "  3. git add . && git commit -m 'v5.6.x — descripción'"
echo "  4. git tag v5.6.x && git push && git push --tags"
echo "  5. GitHub Actions construye y sube la imagen automáticamente ✓"
echo ""
echo "  ${YELLOW}Recuerda añadir los secrets de Docker Hub en GitHub:${NC}"
echo "  Settings → Secrets → Actions → New repository secret"
echo "    DOCKERHUB_USERNAME = ${DOCKERHUB_USER}"
echo "    DOCKERHUB_TOKEN    = (Access Token de hub.docker.com → Account → Security)"
echo ""
