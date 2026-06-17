/**
 * Krisp webhook receiver guard.
 *
 * Drives the REAL shared HTTP server on an ephemeral WEBHOOK_PORT (same
 * approach as webhook-server-raw.test.ts): a valid secret writes a meeting
 * file to the inbox, a bad/missing secret 401s, non-POST 405s, and the
 * pure formatter surfaces known fields while always preserving the raw body.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerWebhookHandler, stopWebhookServer } from '../../webhook-server.js';
import { createKrispWebhookHandler, formatMeetingMarkdown } from './webhook.js';

const PORT = 21000 + Math.floor(Math.random() * 20000);
const SECRET = 'test-krisp-secret';
let inboxDir: string;

async function post(headers: Record<string, string>, body: string, method = 'POST'): Promise<globalThis.Response> {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/krisp`, {
        method,
        headers,
        body: hasBody ? body : undefined,
      });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeAll(() => {
  inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krisp-inbox-'));
  process.env.WEBHOOK_PORT = String(PORT);
  registerWebhookHandler('krisp', createKrispWebhookHandler({ secret: SECRET, inboxDir }));
});

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  fs.rmSync(inboxDir, { recursive: true, force: true });
});

describe('formatMeetingMarkdown', () => {
  it('parses a note_generated payload (nested data.meeting/sections/raw_content)', () => {
    const payload = {
      id: 'evt-note-1',
      event: 'note_generated',
      data: {
        meeting: {
          id: 'mtg-100',
          title: 'OCP renewal sync',
          start_date: '2026-06-17T09:00:00Z',
          url: 'https://app.krisp.ai/n/mtg-100',
          participants: [{ first_name: 'Alek', last_name: 'S', email: 'alek@x.com' }],
          speakers: [{ index: 1, first_name: 'Alek' }],
        },
        sections: {
          key_points: [{ id: 'k1', description: 'OCP renewal at risk' }],
          action_items: [{ id: 'a1', title: 'Send proposal', assignee: { first_name: 'Alek' } }],
        },
        raw_content: '## Key Points\n- OCP renewal at risk\n## Action Items\n- Send proposal - Alek',
      },
    };
    const { id, markdown } = formatMeetingMarkdown(payload, JSON.stringify(payload));
    // Keyed by meeting id + event so multiple events for one meeting don't collide.
    expect(id).toBe('mtg-100-note_generated');
    expect(markdown).toContain('# OCP renewal sync');
    expect(markdown).toContain('**Krisp event:** note_generated');
    expect(markdown).toContain('**Participants:** Alek S');
    expect(markdown).toContain('## Meeting notes');
    expect(markdown).toContain('Send proposal');
    expect(markdown).toContain('attribution in auto-generated transcripts is unreliable');
    // Structured metadata carries the machine-readable sections.
    expect(markdown).toContain('## Structured metadata');
    expect(markdown).toContain('"action_items"');
  });

  it('parses a transcript_created payload and omits the huge content array from the JSON', () => {
    const payload = {
      id: 'evt-tx-1',
      event: 'transcript_created',
      data: {
        meeting: { id: 'mtg-100', title: 'OCP renewal sync' },
        content: [{ speaker: 'Alek', speakerIndex: 1, text: 'hello there' }],
        raw_content: 'Alek | 00:01\nhello there',
      },
    };
    const { id, markdown } = formatMeetingMarkdown(payload, JSON.stringify(payload));
    expect(id).toBe('mtg-100-transcript_created');
    expect(markdown).toContain('## Transcript');
    expect(markdown).toContain('Alek | 00:01');
    // The bulky structured transcript array is NOT re-dumped (kept out of the JSON meta).
    expect(markdown).not.toContain('"speakerIndex"');
  });

  it('falls back to raw payload for an unrecognised shape', () => {
    const body = JSON.stringify({ meeting_id: 'x', name: 'No event field' });
    const { id, markdown } = formatMeetingMarkdown(JSON.parse(body), body);
    expect(id).toBe('x');
    expect(markdown).toContain('## Raw payload');
    expect(markdown).toContain('No event field');
  });

  it('derives a stable sha id when an unrecognised payload has no id', () => {
    const body = JSON.stringify({ foo: 'bar' });
    const a = formatMeetingMarkdown(JSON.parse(body), body);
    const b = formatMeetingMarkdown(JSON.parse(body), body);
    expect(a.id).toMatch(/^sha-[0-9a-f]{16}$/);
    expect(a.id).toBe(b.id);
  });
});

describe('krisp webhook handler', () => {
  const note = (mtgId: string) =>
    JSON.stringify({
      id: `evt-${mtgId}`,
      event: 'note_generated',
      data: { meeting: { id: mtgId, title: 'Test meeting' }, raw_content: '## Key Points\n- hi' },
    });

  it('writes a meeting file to the inbox with a valid secret', async () => {
    const res = await post({ 'x-krisp-secret': SECRET, 'content-type': 'application/json' }, note('m1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'm1-note_generated' });
    const file = path.join(inboxDir, 'krisp-m1-note_generated.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('# Test meeting');
  });

  it('accepts the secret via Authorization: Bearer', async () => {
    const res = await post({ authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, note('m2'));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(inboxDir, 'krisp-m2-note_generated.md'))).toBe(true);
  });

  it('accepts a RAW Authorization token (Krisp default — no Bearer prefix)', async () => {
    const res = await post({ authorization: SECRET, 'content-type': 'application/json' }, note('m3'));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(inboxDir, 'krisp-m3-note_generated.md'))).toBe(true);
  });

  it('rejects a bad secret with 401 and writes nothing', async () => {
    const before = fs.readdirSync(inboxDir).length;
    const res = await post({ 'x-krisp-secret': 'wrong', 'content-type': 'application/json' }, note('should-not-exist'));
    expect(res.status).toBe(401);
    expect(fs.existsSync(path.join(inboxDir, 'krisp-should-not-exist-note_generated.md'))).toBe(false);
    expect(fs.readdirSync(inboxDir).length).toBe(before);
  });

  it('rejects a missing secret with 401', async () => {
    const res = await post({ 'content-type': 'application/json' }, JSON.stringify({ meeting_id: 'nope' }));
    expect(res.status).toBe(401);
  });

  it('405s a non-POST request', async () => {
    const res = await post({ 'x-krisp-secret': SECRET }, '', 'GET');
    expect(res.status).toBe(405);
  });
});
