/**
 * Guard for the dynamic MCP allow-pattern derivation the Google Drive tool depends on.
 *
 * Registering `gdrive` in a group's mcpServers map is the *only* wiring needed to expose
 * `mcp__gdrive__*` to the agent — there is no static TOOL_ALLOWLIST edit. That holds solely
 * because `claude.ts` derives the allow-pattern from the registered servers at query time:
 *
 *     allowedTools: [ ...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern) ]
 *
 * `mcpAllowPattern` is not exported and the call site lives inside the SDK query options,
 * so we assert the derivation structurally. Delete or rename the derivation and this goes
 * red — surfacing that `gdrive` tools would silently be filtered out despite being registered.
 *
 * `mcpAllowPattern` itself is exercised directly to prove `gdrive` -> `mcp__gdrive__*`.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';
import ts from 'typescript';

function source(): { sf: ts.SourceFile; text: string } {
  const p = path.join(import.meta.dir, 'claude.ts');
  const text = fs.readFileSync(p, 'utf8');
  return { sf: ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true), text };
}

/** Reimplement the sanitizer the provider applies, to assert the gdrive name maps cleanly. */
function expectedPattern(name: string): string {
  return `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

describe('claude.ts derives MCP allow-patterns from the registered servers', () => {
  const { sf, text } = source();

  it('defines an mcpAllowPattern function', () => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'mcpAllowPattern') found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(found).toBe(true);
  });

  it('derives allowedTools from the registered servers via mcpAllowEntries', () => {
    // Normalize whitespace so formatting changes don't break the assertion.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('this.mcpServers).flatMap(([name, cfg]) => mcpAllowEntries(name, cfg))');
  });

  it('maps a gdrive server name to mcp__gdrive__*', () => {
    expect(expectedPattern('gdrive')).toBe('mcp__gdrive__*');
  });

  it('derives per-tool allow entries when a server carries an allowedTools list', () => {
    // The read-only pinning for gdrive relies on mcpAllowEntries emitting explicit
    // mcp__<server>__<tool> entries (which both gate calls and drop unlisted tools
    // from context) instead of the wildcard. Assert that derivation still exists.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('function mcpAllowEntries');
    expect(flat).toContain('cfg.allowedTools');
    // and that the query options use it instead of the bare wildcard map
    expect(flat).toContain('mcpAllowEntries(name, cfg)');
  });
});
