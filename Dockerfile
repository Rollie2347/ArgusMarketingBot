# Argus marketing pipeline — the approval bot, the daily batch and the renderer,
# as one always-on container. Build context is marketing/, NOT the repo root:
# the repo-root Dockerfile is the Argus backend that Cloud Run builds, and this
# must never share an image, a key or a CPU with it (bot/README.md).
#
#   docker build -t argus-marketing marketing/
#   docker run -v argus-data:/data --env-file marketing/bot/.env argus-marketing
#
# All mutable state lives on the /data volume (lib/paths.mjs): generated decks,
# images, renders, the approval queue, FEEDBACK.md. Lose the volume and you
# lose the record of what already posted — mount a persistent one.

FROM node:22-slim

# Chromium renders the slides. Liberation Sans is metric-compatible with
# Arial, which theme.css falls back to where Segoe UI (Windows) and
# -apple-system (macOS) don't exist — so container renders use a different
# face than local ones. Compare a render before trusting the first batch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ARGUS_CHROME=/usr/bin/chromium \
    ARGUS_CHROME_NO_SANDBOX=1 \
    MARKETING_DATA_DIR=/data

WORKDIR /app/marketing
COPY . .

VOLUME ["/data"]

# Seed the volume with the hand-written decks on first boot (cp -n never
# overwrites), then run the bot. No test step here: the test suite spawns
# Chrome and fake servers — run it before building.
CMD ["sh", "-c", "mkdir -p /data/decks && cp -n decks/*.json /data/decks/ 2>/dev/null; exec node bot/bot.mjs"]
