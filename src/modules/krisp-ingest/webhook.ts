/**
 * Krisp meeting-webhook receiver.
 *
 * Krisp's Webhook API POSTs a completed meeting's outputs (transcript,
 * summary, notes, action items) to a destination URL. This handler validates
 * a shared secret, then writes the meeting as a single Markdown file into
 * Iris's existing ingest inbox (`~/nanoclaw-ingest/inbox/krisp-<id>.md`).
 *
 * Iris's existing FILE source ingests it on her next gate run — manifest
 * dedup (by sha256) and extraction → mnemon are unchanged. There is no new
 * "source machinery"; Krisp is just a producer of inbox files.
 *
 * Krisp's exact webhook payload shape isn't publicly documented, so the
 * formatter is schema-tolerant: it surfaces the fields it recognises AND
 * always appends the full raw payload as a fenced JSON block, so nothing is
 * lost to a field-name guess. Iris reads the whole file either way.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { RawWebhookHandler } from '../../webhook-server.js';
import { log } from '../../log.js';

export interface KrispWebhookOptions {
  /** Shared secret the sender must present. */
  secret: string;
  /** Directory to drop `krisp-<id>.md` files into (Iris's ingest inbox). */
  inboxDir: string;
  /**
   * Header carrying the secret (lowercased). Defaults to `x-krisp-secret`.
   * `authorization: Bearer <secret>` is always accepted as an alternative.
   */
  headerName?: string;
}

/** Constant-time compare; false on any length/format mismatch. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const ATTR_BANNER =
  '> Speaker attribution in auto-generated transcripts is unreliable (shared meeting-room machines attribute all room speech to one device). Treat who-said-what as low-confidence; corroborate before naming a person.';

/** Render a participant/speaker object to a display name (falls back to email). */
function personName(p: Record<string, unknown>): string {
  const fn = typeof p.first_name === 'string' ? p.first_name : '';
  const ln = typeof p.last_name === 'string' ? p.last_name : '';
  const name = `${fn} ${ln}`.trim();
  if (name) return name;
  return typeof p.email === 'string' ? p.email : '';
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (item == null) return '';
        if (typeof item === 'string') return `- ${item}`;
        if (typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const text = o.text ?? o.title ?? o.name ?? o.description ?? o.content;
          const who = o.assignee ?? o.owner ?? o.speaker ?? o.name;
          const main = typeof text === 'string' ? text : JSON.stringify(item);
          return who && typeof who === 'string' ? `- ${main} (${who})` : `- ${main}`;
        }
        return `- ${String(item)}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

/** Sanitise an id for use as a filename segment. */
function safeId(raw: unknown, body: string): string {
  const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (cleaned) return cleaned;
  // No usable id in the payload — derive a stable one from the body so retries
  // of the same content land on the same filename (sha256 dedup downstream).
  return `sha-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

/**
 * Render a Krisp webhook payload into a Markdown meeting note + a stable id.
 *
 * Krisp's real shape is nested: `{ id (event id), event, data: { meeting,
 * sections?, content?, raw_content } }`. `data.raw_content` is a ready-formatted
 * Markdown note (for `note_generated`) or the full transcript (for
 * `transcript_created`), so we use it as the body and attach structured
 * metadata (meeting + sections) as JSON — deliberately omitting the large,
 * redundant `content`/`raw_content` blobs from that JSON so Iris doesn't read
 * the transcript twice. Falls back to dumping the raw payload for any
 * unrecognised shape.
 *
 * The id is `<meetingId>-<event>` so the several events Krisp fires for one
 * meeting (note_generated, transcript_created, transcript_shared) land as
 * distinct files rather than overwriting each other.
 */
export function formatMeetingMarkdown(
  payload: Record<string, unknown>,
  body: string,
): { id: string; markdown: string } {
  const event = typeof payload.event === 'string' ? payload.event : '';
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const meeting = (data.meeting ?? {}) as Record<string, unknown>;
  const rawContent = typeof data.raw_content === 'string' ? data.raw_content : '';

  // Unrecognised shape → preserve everything raw, key by payload id / body hash.
  if (!event || (data.meeting === undefined && !rawContent)) {
    const id = safeId((payload.meeting_id as unknown) ?? payload.id, body);
    const md = [
      `# Krisp delivery ${id}`,
      '',
      '- **Source:** Krisp (auto-generated meeting transcript)',
      '',
      ATTR_BANNER,
      '',
      '## Raw payload',
      '',
      '```json',
      body.trim(),
      '```',
      '',
    ].join('\n');
    return { id, markdown: md };
  }

  const meetingId = safeId(meeting.id ?? payload.id, body);
  const evt = (event || 'event').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const isTranscript = evt.toLowerCase().includes('transcript');
  const title = typeof meeting.title === 'string' && meeting.title ? meeting.title : `Krisp meeting ${meetingId}`;
  const date = asText(meeting.start_date);
  const url = asText(meeting.url);
  const participants = Array.isArray(meeting.participants)
    ? (meeting.participants as Record<string, unknown>[]).map(personName).filter(Boolean).join(', ')
    : '';
  const speakers = Array.isArray(meeting.speakers)
    ? (meeting.speakers as Record<string, unknown>[]).map(personName).filter(Boolean).join(', ')
    : '';

  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- **Source:** Krisp (auto-generated meeting ${isTranscript ? 'transcript' : 'notes'})`);
  lines.push(`- **Krisp event:** ${event}`);
  if (meeting.id) lines.push(`- **Meeting ID:** ${String(meeting.id)}`);
  if (date) lines.push(`- **Date:** ${date}`);
  if (url) lines.push(`- **Link:** ${url}`);
  if (participants) lines.push(`- **Participants:** ${participants}`);
  if (speakers) lines.push(`- **Labelled speakers:** ${speakers}`);
  lines.push('', ATTR_BANNER, '');

  if (rawContent) {
    lines.push(`## ${isTranscript ? 'Transcript' : 'Meeting notes'}`, '', rawContent.trim(), '');
  }

  // Structured metadata for precise extraction — omit the giant content/raw_content blobs.
  const meta: Record<string, unknown> = { event, meeting };
  if (data.sections !== undefined) meta.sections = data.sections;
  lines.push('## Structured metadata', '', '```json', JSON.stringify(meta, null, 2), '```', '');

  if (!rawContent) {
    // No formatted body present — keep the full raw payload so nothing is lost.
    lines.push('## Raw payload', '', '```json', body.trim(), '```', '');
  }

  return { id: `${meetingId}-${evt}`, markdown: lines.join('\n') };
}

async function readBody(req: import('http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/**
 * Build the raw webhook handler. Registered at `/webhook/krisp` via
 * `registerWebhookHandler`.
 */
export function createKrispWebhookHandler(opts: KrispWebhookOptions): RawWebhookHandler {
  const headerName = (opts.headerName || 'x-krisp-secret').toLowerCase();

  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const headerVal = req.headers[headerName];
    const headerSecret = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const authVal = req.headers['authorization'];
    const auth = Array.isArray(authVal) ? authVal[0] : authVal;
    // Krisp sends the token as a RAW `Authorization` header value (no "Bearer "
    // prefix). Accept all three shapes: the configured header, the raw
    // Authorization value, and a Bearer-prefixed Authorization value.
    const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;

    if (
      !secretMatches(headerSecret, opts.secret) &&
      !secretMatches(auth, opts.secret) &&
      !secretMatches(bearer, opts.secret)
    ) {
      log.warn('Krisp webhook rejected — bad/missing secret');
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      log.error('Krisp webhook body read failed', { err });
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      log.warn('Krisp webhook payload not JSON — storing raw');
      payload = {};
    }

    try {
      const { id, markdown } = formatMeetingMarkdown(payload, body || '{}');
      fs.mkdirSync(opts.inboxDir, { recursive: true });
      const dest = path.join(opts.inboxDir, `krisp-${id}.md`);
      writeFileAtomic(dest, markdown);
      log.info('Krisp meeting saved to inbox', { id, dest });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (err) {
      log.error('Krisp webhook write failed', { err });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  };
}
