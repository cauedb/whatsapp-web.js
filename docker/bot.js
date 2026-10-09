'use strict';

/**
 * Minimal, env-configured bot used as the container's default CMD.
 * Mount your own script over this file (or override the container command)
 * to run different logic without rebuilding the image. See docker/README.md.
 */

const { Client, LocalAuth, MessageMedia } = require('../index');

let qrcodeTerminal;
try {
    qrcodeTerminal = require('qrcode-terminal');
} catch {
    qrcodeTerminal = null;
}

const dataPath = process.env.WWEBJS_DATA_PATH || './.wwebjs_auth';
const clientId = process.env.WWEBJS_CLIENT_ID || undefined;
const browserWSEndpoint = process.env.BROWSER_WS_ENDPOINT || undefined;
const extraArgs = (process.env.PUPPETEER_ARGS || '')
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean);

const apiPort = process.env.API_PORT
    ? parseInt(process.env.API_PORT, 10)
    : null;
const apiKey = process.env.API_KEY || null;
const webhookUrl = process.env.WEBHOOK_URL || null;
const webhookChatIds = (process.env.WEBHOOK_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

// The API controls a real WhatsApp account, so refuse to start it
// unauthenticated rather than silently exposing it. See docker/README.md#http-api.
if (apiPort && !apiKey) {
    console.error(
        'API_PORT is set but API_KEY is missing. Refusing to start an ' +
            'unauthenticated HTTP API. Set API_KEY in .env.',
    );
    process.exit(1);
}

// Setting BROWSER_WS_ENDPOINT (e.g. to an Obscura/CDP server's address)
// connects to that already-running browser instead of launching the
// bundled Chrome. See docker/README.md#obscura for details and caveats.
//
// --no-sandbox is required here because Chrome's own sandbox needs
// unprivileged user namespaces, which most container hosts don't allow by
// default; the container's own isolation (plus running as non-root) is the
// trade-off for that.
const puppeteer = browserWSEndpoint
    ? { browserWSEndpoint }
    : {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
      };

const client = new Client({
    authStrategy: new LocalAuth({ dataPath, clientId }),
    puppeteer,
});

let lastQr = null;
let isReady = false;

client.on('qr', (qr) => {
    lastQr = qr;
    if (qrcodeTerminal) {
        qrcodeTerminal.generate(qr, { small: true });
    } else {
        console.log(
            'QR RECEIVED (install qrcode-terminal for an ASCII code):',
            qr,
        );
    }
});

client.on('loading_screen', (percent, message) => {
    console.log(`Loading: ${percent}% - ${message}`);
});

client.on('authenticated', () => console.log('Authenticated.'));
client.on('auth_failure', (msg) =>
    console.error('Authentication failure:', msg),
);
client.on('ready', () => {
    isReady = true;
    lastQr = null;
    console.log('Client is ready.');
});
client.on('disconnected', (reason) => {
    isReady = false;
    console.log('Client disconnected:', reason);
});

function forwardToWebhook(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
    })
        .catch((err) => console.warn('Webhook delivery failed:', err.message))
        .finally(() => clearTimeout(timeout));
}

client.on('message', async (msg) => {
    const shouldForward =
        webhookUrl &&
        (!webhookChatIds.length || webhookChatIds.includes(msg.from));
    if (shouldForward) {
        forwardToWebhook({
            event: 'message',
            id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            hasMedia: msg.hasMedia,
            type: msg.type,
            timestamp: msg.timestamp,
            fromMe: msg.fromMe,
        });
    }

    if (msg.body === '!ping') {
        await msg.reply('pong');
    }
});

function startApiServer() {
    let express, QRCode;
    try {
        express = require('express');
        QRCode = require('qrcode');
    } catch (err) {
        console.error(
            'API_PORT is set but the "express"/"qrcode" optional ' +
                'dependencies are not installed:',
            err.message,
        );
        process.exit(1);
    }

    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => res.json({ status: 'ok' }));

    app.use((req, res, next) => {
        const header = req.get('authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (token !== apiKey) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    });

    app.get('/status', async (req, res) => {
        let state = null;
        try {
            state = await client.getState();
        } catch {
            // Not authenticated yet, or Puppeteer not ready; leave state null.
        }
        res.json({ ready: isReady, state });
    });

    app.get('/chats', async (req, res) => {
        if (!isReady) {
            return res.status(503).json({ error: 'client not ready' });
        }
        try {
            const chats = await client.getChats();
            res.json(
                chats.map((chat) => ({
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                })),
            );
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    app.get('/contacts/lookup', async (req, res) => {
        const { number } = req.query;
        if (!number) {
            return res
                .status(400)
                .json({ error: '"number" query param is required' });
        }
        if (!isReady) {
            return res.status(503).json({ error: 'client not ready' });
        }
        try {
            const numberId = await client.getNumberId(number);
            if (!numberId) {
                return res
                    .status(404)
                    .json({ error: 'number is not registered on WhatsApp' });
            }
            res.json({ id: numberId._serialized });
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    app.get('/qr', async (req, res) => {
        if (!lastQr) {
            return res.status(404).json({ error: 'no QR code pending' });
        }
        if (req.query.format === 'json') {
            return res.json({ qr: lastQr });
        }
        try {
            const buffer = await QRCode.toBuffer(lastQr);
            res.set('Content-Type', 'image/png');
            res.send(buffer);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/messages', async (req, res) => {
        const { to, body, mediaUrl } = req.body || {};
        if (!to || (!body && !mediaUrl)) {
            return res.status(400).json({
                error: '"to" and one of "body"/"mediaUrl" are required',
            });
        }
        if (!isReady) {
            return res.status(503).json({ error: 'client not ready' });
        }

        const chatId = to.includes('@') ? to : `${to}@c.us`;

        try {
            let message;
            if (mediaUrl) {
                const media = await MessageMedia.fromUrl(mediaUrl, {
                    unsafeMime: true,
                });
                message = await client.sendMessage(
                    chatId,
                    media,
                    body ? { caption: body } : {},
                );
            } else {
                message = await client.sendMessage(chatId, body);
            }
            res.json({
                id: message.id._serialized,
                to: message.to,
                timestamp: message.timestamp,
            });
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    app.listen(apiPort, () => {
        console.log(`API listening on port ${apiPort}`);
    });
}

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await client.destroy();
    process.exit(0);
});

if (apiPort) {
    startApiServer();
}

console.log(
    browserWSEndpoint
        ? `Connecting to external browser at ${browserWSEndpoint}...`
        : 'Launching bundled Chrome...',
);
client.initialize();
