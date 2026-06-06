/**
 * Manually trigger an Iris ingestion run.
 *
 * Usage:  pnpm exec tsx scripts/iris-trigger.ts
 *
 * Drops a one-shot "ingestion run" message into Iris's (agent-shared) session;
 * the host's sweep then wakes the Iris container with full production mounts
 * (shared mnemon + the read-only ingest inbox). Iris processes any new files in
 * /workspace/extra/ingest/inbox per her playbook and sends a digest to Zora.
 *
 * (Interim manual trigger — a recurring cron schedule can replace this later.)
 */
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';

initDb(path.join(DATA_DIR, 'v2.db'));
const ag = getAgentGroupByFolder('iris');
if (!ag) {
  console.error('Iris agent group (folder "iris") not found.');
  process.exit(1);
}
const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const id = `iris-run-${Date.now()}`;
writeSessionMessage(ag.id, session.id, {
  id,
  kind: 'chat',
  timestamp: new Date().toISOString(),
  platformId: ag.id,
  channelType: 'agent',
  threadId: null,
  content: JSON.stringify({
    text:
      'Ingestion run (manual trigger). Process new inbound signals per your playbook: new files in ' +
      '/workspace/extra/ingest/inbox AND new emails under the Gmail "Iris" label. Recall the watchlist, extract facts ' +
      'into mnemon (--source extraction, --no-diff), label processed emails Iris-Processed, update your manifest + counts, ' +
      'write a run digest to /workspace/agent/runs/, and send the digest to Zora (send_message to:"zora").',
    sender: 'system',
    senderId: 'system',
  }),
});
console.log(`Triggered Iris run — session ${session.id}, msg ${id}. Host will wake the container within ~60s.`);
