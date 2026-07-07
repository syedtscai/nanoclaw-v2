/**
 * Host-side lifecycle for the mnemon single-writer daemon container.
 *
 * When MNEMON_DAEMON=true (and MNEMON_DATA_DIR is set), the shared mnemon
 * data dir is mounted into exactly ONE dedicated container running
 * container/mnemon-daemon/server.ts, and agent containers stop mounting it —
 * their mnemon_* MCP tools talk HTTP to the daemon instead (they receive
 * MNEMON_DAEMON_URL at spawn; see container-runner.ts). This removes the
 * multi-writer WAL-over-virtiofs corruption vector.
 *
 * The daemon container:
 *   - reuses the agent image (ships bun + the mnemon binary),
 *   - bind-mounts the server script read-only (no image rebuild to iterate),
 *   - publishes 8377 to HOST LOOPBACK ONLY; agents reach it via
 *     host.docker.internal:8377,
 *   - runs with --restart unless-stopped so it survives host restarts; we
 *     still recreate it on every host start so it always runs the current
 *     image + script.
 *
 * Rollback: set MNEMON_DAEMON=false in .env and restart the host — agent
 * containers go back to mounting the data dir directly.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, INSTALL_SLUG, MNEMON_DAEMON, MNEMON_DATA_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export const MNEMON_DAEMON_PORT = 8377;
/** URL agent containers use to reach the daemon (via the Docker host gateway). */
export const MNEMON_DAEMON_CONTAINER_URL = `http://host.docker.internal:${MNEMON_DAEMON_PORT}`;

export function mnemonDaemonEnabled(): boolean {
  return MNEMON_DAEMON && Boolean(MNEMON_DATA_DIR);
}

function daemonContainerName(): string {
  return `nanoclaw-mnemon-daemon-${INSTALL_SLUG}`;
}

/**
 * Recreate the daemon container. Returns true when the daemon is up and
 * answering /health; logs and returns false on failure (callers decide
 * whether that is fatal — container spawns fall back to direct mounts only
 * when the flag is off, so a dead daemon means mnemon tools error loudly
 * rather than silently splitting the write path again).
 */
export async function ensureMnemonDaemon(): Promise<boolean> {
  if (!mnemonDaemonEnabled()) return false;

  const name = daemonContainerName();
  const dataDir = (MNEMON_DATA_DIR as string).replace(/^~/, process.env.HOME || '');
  const serverDir = path.join(process.cwd(), 'container', 'mnemon-daemon');

  // Recreate fresh each host start: picks up current image + server script.
  await execFileAsync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name]).catch(() => {});

  const args = [
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    name,
    '--label',
    CONTAINER_INSTALL_LABEL,
    '-p',
    `127.0.0.1:${MNEMON_DAEMON_PORT}:${MNEMON_DAEMON_PORT}`,
    '-v',
    `${dataDir}:/home/node/.mnemon`,
    '-v',
    `${serverDir}:/daemon:ro`,
  ];
  // Match agent-container user mapping so DB file ownership stays consistent.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`, '-e', 'HOME=/home/node');
  }
  args.push('--entrypoint', 'bun', CONTAINER_IMAGE, '/daemon/server.ts');

  try {
    await execFileAsync(CONTAINER_RUNTIME_BIN, args);
  } catch (e) {
    log.error('Failed to start mnemon daemon container', { error: String(e) });
    return false;
  }

  // Wait for /health (the container needs a moment to boot bun).
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${MNEMON_DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        log.info('mnemon single-writer daemon up', { name, port: MNEMON_DAEMON_PORT });
        return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.error('mnemon daemon container started but /health never came up', { name });
  return false;
}
