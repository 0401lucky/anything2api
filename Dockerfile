# ===== Build stage =====
FROM node:20-bookworm-slim AS builder

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ===== Runtime stage =====
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      curl unzip \
      fonts-noto-cjk fonts-noto-color-emoji \
      xvfb x11vnc fluxbox \
      websockify python3 \
      ca-certificates dumb-init procps \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
      libcups2 libdbus-1-3 libdbus-glib-1-2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
      libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxrandr2 libxrender1 libxshmfence1 libxss1 libxt6 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox \
    BROWSER_ENGINE=firefox \
    NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ARG CAMOUFOX_URL
RUN set -eux; \
    arch="$(uname -m)"; \
    if [ -z "${CAMOUFOX_URL:-}" ]; then \
      if [ "$arch" = "x86_64" ]; then \
        CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip"; \
      elif [ "$arch" = "aarch64" ]; then \
        CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.arm64.zip"; \
      else \
        echo "Unsupported architecture: $arch"; \
        exit 1; \
      fi; \
    fi; \
    mkdir -p /app/camoufox-linux /tmp/camoufox; \
    curl -fsSL "$CAMOUFOX_URL" -o /tmp/camoufox.zip; \
    unzip -q /tmp/camoufox.zip -d /tmp/camoufox; \
    if [ -f /tmp/camoufox/camoufox ]; then \
      mv /tmp/camoufox/* /app/camoufox-linux/; \
    else \
      mv /tmp/camoufox/*/* /app/camoufox-linux/; \
    fi; \
    rm -rf /tmp/camoufox /tmp/camoufox.zip; \
    chmod +x /app/camoufox-linux/camoufox

RUN useradd -m -s /bin/bash app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

VOLUME ["/app/data"]
EXPOSE 7860
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/src/cli.js","serve"]
