/**
 * Structural guard for the Google Drive MCP package-install integration point (container image).
 *
 * `@piotr-agier/google-drive-mcp` is a CLI binary installed into the image via the
 * Dockerfile — it is not importable or typed from this tree, so the build leg can't catch
 * its removal and there's no runtime seam to behavior-test. This asserts the Dockerfile
 * still carries the ARG and the pinned pnpm global-install line. Drop either and this goes
 * red, signalling the agent would boot without the `google-drive-mcp` binary on PATH.
 *
 * (Unlike gmail-mcp, this package pins zod@^3.25 directly and has no zod-to-json-schema
 * dep, so there is no transitive-pin to guard here.)
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

function dockerfile(): string {
  // container/agent-runner/src/providers/ -> ../../../Dockerfile == container/Dockerfile
  const p = path.join(import.meta.dir, '..', '..', '..', 'Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs the Google Drive MCP server', () => {
  const text = dockerfile();

  it('declares the GDRIVE_MCP_VERSION ARG', () => {
    expect(/ARG\s+GDRIVE_MCP_VERSION=/.test(text)).toBe(true);
  });

  it('pnpm-installs @piotr-agier/google-drive-mcp pinned to the ARG', () => {
    expect(text).toContain('pnpm install -g');
    expect(/@piotr-agier\/google-drive-mcp@\$\{GDRIVE_MCP_VERSION\}/.test(text)).toBe(true);
  });
});
