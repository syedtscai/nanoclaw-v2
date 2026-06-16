/**
 * mnemon memory MCP tools — `mnemon_remember`, `mnemon_recall`,
 * `mnemon_forget`, `mnemon_run`.
 *
 * WHY THIS EXISTS (security): mnemon was previously driven by the model
 * hand-assembling a shell command line for the Bash tool, e.g.
 * `mnemon remember "<claim>" --entities "..."`. Fact content comes from
 * UNTRUSTED ingested sources (email / Slack / Jira / HubSpot / files). In a
 * double-quoted shell string the shell still expands `$(…)`, backticks, and
 * `$VAR`, so a crafted source string could both corrupt data (the observed
 * `$300,000`→`00000` mangling) and execute arbitrary commands in the
 * container. These tools take structured arguments and exec the mnemon
 * binary via `execFile` with an argv ARRAY — no shell is involved, so fact
 * content is passed verbatim to mnemon and can never be parsed as shell.
 *
 * Self-gating: registers only when `MNEMON_DATA_DIR` is set in the
 * environment. That env var is added to the image by the add-mnemon skill's
 * Dockerfile block, so on installs without mnemon these tools never appear
 * (and the `mnemon` binary wouldn't exist anyway).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8 * 1024 * 1024; // 8MB — recall can return a lot
const MAX_CONTENT = 8000;
const MAX_ARGS = 40;

const CAT_ENUM = ['preference', 'decision', 'fact', 'insight', 'context', 'general'];
const SUBCOMMAND_RE = /^[a-z][a-z-]*$/; // first token of mnemon_run, no leading dash

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text: text || '(no output)' }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Run the mnemon binary with a literal argv array — never via a shell. */
async function runMnemon(argv: string[]) {
  try {
    const bin = process.env.MNEMON_BIN || 'mnemon';
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      // No `shell` option => execFile passes argv straight to execve. Fact
      // content with $(), backticks, etc. is inert here.
    });
    const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');
    return ok(combined);
  } catch (e: unknown) {
    const x = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (x?.killed) return err(`mnemon timed out after ${EXEC_TIMEOUT_MS}ms`);
    const detail = (x?.stderr || x?.stdout || x?.message || String(e)).trim();
    return err(`mnemon ${argv[0] ?? ''} failed: ${detail}`);
  }
}

/** Accept either an array of strings or a comma-joined string; return a clean comma list. */
function normList(v: unknown): string {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).join(',');
  if (typeof v === 'string') return v.trim();
  return '';
}

export const mnemonRemember: McpToolDefinition = {
  tool: {
    name: 'mnemon_remember',
    description:
      'Write a fact to mnemon memory. Pass each field as a structured argument — do NOT shell-quote anything. Content is passed verbatim (no shell), so amounts, apostrophes, and any punctuation are safe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'One atomic, self-contained claim.' },
        cat: { type: 'string', enum: CAT_ENUM, description: 'Category.' },
        imp: { type: 'integer', minimum: 1, maximum: 5, description: 'Importance 1-5 (4-5 only for critical signals).' },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical proper-noun entity names (people, accounts, named products/projects/issue-keys). Resolve to existing mnemon spellings first.',
        },
        source: { type: 'string', description: 'Provenance, e.g. "extraction" (default) or "user".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'key:value tags, e.g. src:gmail, date:2026-06-16, sensitivity:high.' },
        noDiff: { type: 'boolean', description: 'Pass --no-diff (default true; keep true for appends).' },
      },
      required: ['content', 'cat', 'imp', 'entities'],
    },
  },
  async handler(args) {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) return err('content is required');
    if (content.length > MAX_CONTENT) return err(`content too long (max ${MAX_CONTENT} chars)`);

    const cat = String(args.cat ?? '');
    if (!CAT_ENUM.includes(cat)) return err(`cat must be one of: ${CAT_ENUM.join(', ')}`);

    const imp = Number(args.imp);
    if (!Number.isInteger(imp) || imp < 1 || imp > 5) return err('imp must be an integer 1-5');

    const entities = normList(args.entities);
    if (!entities) return err('entities is required (≥1 canonical name)');

    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'extraction';
    const tags = normList(args.tags);
    const noDiff = args.noDiff !== false; // default true

    const argv = ['remember', content, '--cat', cat, '--imp', String(imp), '--entities', entities, '--source', source];
    if (tags) argv.push('--tags', tags);
    if (noDiff) argv.push('--no-diff');

    log(`mnemon_remember: cat=${cat} imp=${imp} entities=[${entities}] source=${source}`);
    return runMnemon(argv);
  },
};

export const mnemonRecall: McpToolDefinition = {
  tool: {
    name: 'mnemon_recall',
    description: 'Recall facts from mnemon by entity or topic. Run before writing to dedup, resolve canonical names, and find conflicts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Entity or topic to recall.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (optional).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return err('query is required');
    if (query.length > MAX_CONTENT) return err(`query too long (max ${MAX_CONTENT} chars)`);

    const argv = ['recall', query];
    if (args.limit !== undefined) {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return err('limit must be an integer 1-50');
      argv.push('--limit', String(limit));
    }
    return runMnemon(argv);
  },
};

export const mnemonForget: McpToolDefinition = {
  tool: {
    name: 'mnemon_forget',
    description: 'Forget (retire) a mnemon fact by its id — used when superseding an attribute (forget old, then remember new).',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'The mnemon fact id to forget.' } },
      required: ['id'],
    },
  },
  async handler(args) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return err('id must be a mnemon fact id (letters, digits, _ or -)');
    return runMnemon(['forget', id]);
  },
};

export const mnemonRun: McpToolDefinition = {
  tool: {
    name: 'mnemon_run',
    description:
      'Escape hatch for other mnemon subcommands (e.g. status, link). Pass argv as an ARRAY of tokens — each becomes one argument verbatim, no shell. Prefer mnemon_remember/recall/forget for those operations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'mnemon argv tokens, e.g. ["status"] or ["link", "<from-id>", "<to-id>"].' },
      },
      required: ['args'],
    },
  },
  async handler(args) {
    const argv = Array.isArray(args.args) ? args.args.map((a) => String(a)) : [];
    if (argv.length === 0) return err('args must be a non-empty array of tokens');
    if (argv.length > MAX_ARGS) return err(`too many args (max ${MAX_ARGS})`);
    if (!SUBCOMMAND_RE.test(argv[0])) return err('first arg must be a mnemon subcommand (lowercase, no leading dash)');
    return runMnemon(argv);
  },
};

if (process.env.MNEMON_DATA_DIR) {
  registerTools([mnemonRemember, mnemonRecall, mnemonForget, mnemonRun]);
} else {
  log('mnemon tools not registered (MNEMON_DATA_DIR unset — mnemon not installed)');
}
