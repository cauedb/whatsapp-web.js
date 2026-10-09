# Builds a runnable whatsapp-web.js bot container.
#
# Based on the official Puppeteer image, which already ships a Chrome build
# that matches the `puppeteer` version pinned in package.json and runs it
# as the non-root `pptruser` user. Chrome's own sandbox still needs
# --no-sandbox (set as a default launch arg in docker/bot.js) since most
# container hosts don't allow the unprivileged user namespaces it requires;
# running as non-root here is the isolation trade-off for that.
FROM ghcr.io/puppeteer/puppeteer:24.38.0

# Chrome is already installed in this base image; skip puppeteer's own
# download so `npm ci` below doesn't fetch a second copy.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production

USER root
WORKDIR /home/pptruser/app

COPY --chown=pptruser:pptruser package.json package-lock.json ./
# --ignore-scripts: this package's own "prepare" script (husky, for git
# hooks) needs devDependencies we're intentionally omitting here; skipping
# lifecycle scripts is safe since puppeteer's postinstall (the only
# dependency that has one) only downloads Chrome, which PUPPETEER_SKIP_DOWNLOAD
# already disables.
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=pptruser:pptruser . .

# Session data (LocalAuth) lives here so it can be mounted as a volume.
RUN mkdir -p /home/pptruser/app/.wwebjs_auth && chown -R pptruser:pptruser /home/pptruser/app/.wwebjs_auth
VOLUME ["/home/pptruser/app/.wwebjs_auth"]

USER pptruser

# Only relevant if API_PORT is set (see docker/README.md#http-api); EXPOSE is
# documentation-only and doesn't publish the port by itself — the actual
# port comes from API_PORT and is mapped via docker-compose.yml or `-p`.
EXPOSE 3000

# Bundled example bot; mount your own script over docker/bot.js (or override
# the command) to run different logic without rebuilding the image.
CMD ["node", "docker/bot.js"]
