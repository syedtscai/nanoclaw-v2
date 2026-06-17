/**
 * Krisp ingest module — self-registers a webhook handler at import time.
 *
 * Registration is GATED on `KRISP_WEBHOOK_SECRET`: with no secret configured
 * the route is never registered (and the shared webhook server isn't started
 * for it), so we never expose an unauthenticated public endpoint. Set the
 * secret in `.env` and the same value as the auth header in Krisp's webhook
 * config to go live.
 *
 * `.env` keys:
 *   KRISP_WEBHOOK_SECRET   (required to enable)
 *   KRISP_WEBHOOK_HEADER   (optional; header carrying the secret, default x-krisp-secret)
 *   INGEST_DIR             (optional; base of the ingest tree, default ~/nanoclaw-ingest)
 */
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerWebhookHandler } from '../../webhook-server.js';

import { createKrispWebhookHandler } from './webhook.js';

const env = readEnvFile(['KRISP_WEBHOOK_SECRET', 'KRISP_WEBHOOK_HEADER', 'INGEST_DIR']);
const secret = process.env.KRISP_WEBHOOK_SECRET || env.KRISP_WEBHOOK_SECRET;

if (!secret) {
  log.info('Krisp webhook not registered (KRISP_WEBHOOK_SECRET unset)');
} else {
  const base = process.env.INGEST_DIR || env.INGEST_DIR || path.join(os.homedir(), 'nanoclaw-ingest');
  const inboxDir = path.join(base, 'inbox');
  const headerName = process.env.KRISP_WEBHOOK_HEADER || env.KRISP_WEBHOOK_HEADER || 'x-krisp-secret';
  registerWebhookHandler('krisp', createKrispWebhookHandler({ secret, inboxDir, headerName }));
  log.info('Krisp webhook registered', { path: '/webhook/krisp', inboxDir });
}
