FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk fonts-noto-color-emoji \
      xvfb x11vnc fluxbox \
      novnc websockify python3 \
      ca-certificates dumb-init procps \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NOVNC_DIR=/usr/share/novnc \
    NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 \
 && npx tsc -p tsconfig.json \
 && node -e "require('fs').cpSync('src/console/static','dist/src/console/static',{recursive:true})" \
 && rm -rf src node_modules/typescript

RUN useradd -m -s /bin/bash app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

VOLUME ["/app/data"]
EXPOSE 7860
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/src/cli.js","serve"]
