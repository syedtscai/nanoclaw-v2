/**
 * mnemon single-writer daemon.
 *
 * WHY: the shared mnemon SQLite DB was previously bind-mounted RW into every
 * agent container — three concurrent writers doing WAL over a virtiofs Docker
 * mount, which corrupted the DB repeatedly (see the *.corrupt-* graveyard in
 * the data dir; an hourly watchdog auto-recovered it). This daemon restores
 * SQLite's happy path: exactly ONE process owns the file. Agent containers no
 * longer mount the data dir at all — their mnemon_* MCP tools POST here
 * instead (container/agent-runner/src/mcp-tools/mnemon.ts, gated on
 * MNEMON_DAEMON_URL).
 *
 * Runs as its own container (started by the host: src/mnemon-daemon.ts) using
 * the agent image (which ships bun + the mnemon binary), with the data dir
 * mounted only here and this file bind-mounted read-only. Listens on :8377,
 * published to the HOST LOOPBACK ONLY (127.0.0.1) — agent containers reach it
 * via host.docker.internal:8377, nothing off-box can.
 *
 * API:
 *   POST /run  {"argv": ["recall", "query", "--limit", "5"]}
 *     → {"code": 0, "stdout": "...", "stderr": "..."}   (HTTP 200 even on
 *       non-zero mnemon exit — the exit code is data, not transport failure)
 *   GET /health → {"ok": true, "queue": <pending ops>}
 *
 * Requests are SERIALIZED — one mnemon invocation at a time (that is the whole
 * point). argv is validated to the same shape the MCP tools enforce and passed
 * via execFile (argv array, no shell) so untrusted fact content is inert.
 *
 * Residual concurrency (accepted, documented): host-side maintenance jobs
 * (daily .backup(), entity scrub, recall eval) still touch the DB from the
 * macOS side on their own schedules. They are brief and mostly read; the
 * dominant corruption vector — multiple sustained container writers — is gone.
 * Prefer routing new host jobs through this daemon (curl 127.0.0.1:8377).
 *
 * Egress-lockdown note (C1): when NANOCLAW_EGRESS_LOCKDOWN is enabled later,
 * containers on the internal network cannot reach host.docker.internal —
 * attach this daemon container to the egress network and point
 * MNEMON_DAEMON_URL at http://<daemon-container-name>:8377 instead.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.MNEMON_DAEMON_PORT || 8377);
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_ARGS = 40;
const MAX_ARG_LEN = 16_000;
const SUBCOMMAND_RE = /^[a-z][a-z-]*$/;

let queueDepth = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Serialize: append the op to a single promise chain — one mnemon at a time. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  queueDepth++;
  const next = chain.then(fn, fn).finally(() => {
    queueDepth--;
  });
  chain = next.catch(() => {});
  return next;
}

async function runMnemon(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('mnemon', argv, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e: unknown) {
    const x = e as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (x?.killed) return { code: 124, stdout: x.stdout ?? '', stderr: `mnemon timed out after ${EXEC_TIMEOUT_MS}ms` };
    return {
      code: typeof x.code === 'number' ? x.code : 1,
      stdout: x.stdout ?? '',
      stderr: x.stderr || x.message || String(e),
    };
  }
}

function validateArgv(argv: unknown): string[] | string {
  if (!Array.isArray(argv) || argv.length === 0) return 'argv must be a non-empty array of strings';
  if (argv.length > MAX_ARGS) return `too many args (max ${MAX_ARGS})`;
  const out: string[] = [];
  for (const a of argv) {
    if (typeof a !== 'string') return 'argv entries must be strings';
    if (a.length > MAX_ARG_LEN) return `arg too long (max ${MAX_ARG_LEN} chars)`;
    out.push(a);
  }
  if (!SUBCOMMAND_RE.test(out[0])) return 'first arg must be a mnemon subcommand (lowercase, no leading dash)';
  return out;
}

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0', // container-internal; docker publishes to host loopback only
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, queue: queueDepth });
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      let body: { argv?: unknown };
      try {
        body = (await req.json()) as { argv?: unknown };
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
      const argv = validateArgv(body.argv);
      if (typeof argv === 'string') return Response.json({ error: argv }, { status: 400 });
      const result = await enqueue(() => runMnemon(argv));
      return Response.json(result);
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
});

console.error(`[mnemon-daemon] listening on :${server.port}, data dir ${process.env.MNEMON_DATA_DIR}`);
