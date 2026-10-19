
FROM node:24-bookworm-slim

# Install Chrome runtime dependencies and the archive extractor.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    unzip \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Let Puppeteer install its browser explicitly in the next step.
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

RUN rm -rf /root/.cache/puppeteer \
    && npx puppeteer browsers install chrome \
    && test -x "$(find /root/.cache/puppeteer -type f -path '*/chrome-linux64/chrome' -print -quit)"

ENV NODE_ENV=production
ENV PUPPETEER_NO_SANDBOX=true
ENV NODE_OPTIONS="--max-old-space-size=160"

COPY src ./src
COPY index.js ./index.js

EXPOSE 4000

CMD ["npm", "run", "start:render"]