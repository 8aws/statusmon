FROM node:20-alpine

RUN apk add --no-cache unzip zip

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/
COPY public/ ./public/

# Directorio de datos persistentes (bind-mount desde docker-compose.yml)
VOLUME ["/data"]

ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "src/server.js"]
