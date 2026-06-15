FROM node:20-alpine

RUN apk add --no-cache unzip zip

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/
COPY public/ ./public/

# NO declaramos VOLUME ["/data"] a propósito:
# un VOLUME sin bind-mount explícito hace que Docker cree un volumen ANÓNIMO
# nuevo en cada `docker run`/recreate, que queda huérfano y se pierde (era la
# causa del borrado total al recrear el contenedor). La persistencia se controla
# SIEMPRE con bind-mounts del host en docker-compose.yml:
#   - /opt/statusmon/data:/data
#   - /opt/statusmon/backups:/backups   (BACKUPS_DIR, fuera del volumen de datos)

ENV PORT=3000
ENV DATA_DIR=/data
ENV BACKUPS_DIR=/backups

EXPOSE 3000

CMD ["node", "src/server.js"]
