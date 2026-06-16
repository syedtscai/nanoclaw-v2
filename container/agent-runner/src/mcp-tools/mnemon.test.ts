/**
 * Verifies the mnemon MCP tools exec the binary with a literal argv array and
 * never go through a shell — so untrusted fact content containing `$(…)`,
 * backticks, or quotes is passed verbatim and cannot be expanded/executed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mnemonRemember, mnemonRecall, mnemonForget, mnemonRun } from './mnemon.js';

let dir: string;
let fakeBin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mnemon-test-'));
  fakeBin = join(dir, 'fake-mnemon');
  // Prints each received argv element on its own line, prefixed, so the test
  // can assert exactly what mnemon would have received. `"$@"` does not
  // re-expand its arguments, so any shell metachars survive literally.
  writeFileSync(fakeBin, '#!/bin/bash\nfor a in "$@"; do printf "ARG:%s\\n" "$a"; done\n');
  chmodSync(fakeBin, 0o755);
  process.env.MNEMON_BIN = fakeBin;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MNEMON_BIN;
});

function text(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('mnemon_remember argv safety', () => {
  it('passes content with shell metacharacters verbatim as one argument', async () => {
    const payload = 'Deal value $(echo PWNED) and `whoami` for O\'Brien & Co; rm -rf /';
    const res = await mnemonRemember.handler({
      content: payload,
      cat: 'fact',
      imp: 3,
      entities: ['DP World', 'Elena Dodevska'],
      source: 'extraction',
      tags: ['src:gmail', 'date:2026-06-16'],
    });
    const out = text(res);
    // The exact payload arrives as a single argv element — not expanded, not split.
    expect(out).toContain(`ARG:${payload}`);
    // If a shell had run, $(echo PWNED) would have collapsed to bare "PWNED".
    expect(out).not.toContain('ARG:Deal value PWNED');
    // Structured flags are present.
    expect(out).toContain('ARG:remember');
    expect(out).toContain('ARG:--cat');
    expect(out).toContain('ARG:fact');
    expect(out).toContain('ARG:--entities');
    expect(out).toContain('ARG:DP World,Elena Dodevska');
    expect(out).toContain('ARG:--no-diff');
  });

  it('rejects an invalid category', async () => {
    const res = await mnemonRemember.handler({ content: 'x', cat: 'bogus', imp: 2, entities: ['A'] });
    expect(res.isError).toBe(true);
  });

  it('rejects out-of-range importance', async () => {
    const res = await mnemonRemember.handler({ content: 'x', cat: 'fact', imp: 9, entities: ['A'] });
    expect(res.isError).toBe(true);
  });

  it('rejects empty content and missing entities', async () => {
    expect((await mnemonRemember.handler({ content: '  ', cat: 'fact', imp: 2, entities: ['A'] })).isError).toBe(true);
    expect((await mnemonRemember.handler({ content: 'x', cat: 'fact', imp: 2, entities: [] })).isError).toBe(true);
  });
});

describe('mnemon_recall / forget / run', () => {
  it('recall passes the query verbatim and honors limit', async () => {
    const res = await mnemonRecall.handler({ query: 'OCP `id` Global', limit: 5 });
    const out = text(res);
    expect(out).toContain('ARG:recall');
    expect(out).toContain('ARG:OCP `id` Global');
    expect(out).toContain('ARG:--limit');
    expect(out).toContain('ARG:5');
  });

  it('forget rejects ids with shell-active characters', async () => {
    expect((await mnemonForget.handler({ id: '$(rm -rf /)' })).isError).toBe(true);
    const valid = await mnemonForget.handler({ id: 'abc-123_DEF' });
    expect(valid.isError).not.toBe(true); // success path: isError is absent
    expect(text(valid)).toContain('ARG:forget');
  });

  it('mnemon_run requires a subcommand first token, no leading dash', async () => {
    expect((await mnemonRun.handler({ args: ['--evil'] })).isError).toBe(true);
    expect((await mnemonRun.handler({ args: [] })).isError).toBe(true);
    const okRes = await mnemonRun.handler({ args: ['status'] });
    expect(text(okRes)).toContain('ARG:status');
  });
});
