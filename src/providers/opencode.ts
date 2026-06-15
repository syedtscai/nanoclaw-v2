/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 *
 * Local deviation (nanoclaw-v2 launchd install): the upstream version reads
 * config from process.env only. This host runs under launchd, which does not
 * load .env into process.env (see env.ts — readEnvFile deliberately keeps
 * secrets out of the process env). So we read OPENCODE_* from .env via
 * readEnvFile, with process.env as a fallback for `pnpm run dev`. We also
 * forward a DEDICATED `OPENCODE_BASE_URL` (not the shared `ANTHROPIC_BASE_URL`,
 * which the claude provider injects into every claude container and would
 * redirect Zora) into the opencode container as ANTHROPIC_BASE_URL — the
 * upstream baseURL the container-side opencode provider reads.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const dotenv = readEnvFile(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'OPENCODE_BASE_URL']);
  const get = (key: string): string | undefined => ctx.hostEnv[key] || dotenv[key];

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  const provider = get('OPENCODE_PROVIDER');
  if (provider) env.OPENCODE_PROVIDER = provider;
  // Per-group model override: if the group's container config sets a model, use
  // it (for both main + small model — one model per group) so multiple opencode
  // groups can run different models (e.g. Iris on flash, another group on pro)
  // instead of all sharing the single global OPENCODE_MODEL. Falls back to the
  // global .env value when the group has no model set.
  const model = ctx.model || get('OPENCODE_MODEL');
  if (model) env.OPENCODE_MODEL = model;
  const smallModel = ctx.model || get('OPENCODE_SMALL_MODEL');
  if (smallModel) env.OPENCODE_SMALL_MODEL = smallModel;
  // Zora-safe upstream baseURL: a dedicated OPENCODE_BASE_URL (never the shared
  // ANTHROPIC_BASE_URL) is forwarded into the opencode container only, where the
  // container-side provider reads it as ANTHROPIC_BASE_URL.
  const baseUrl = get('OPENCODE_BASE_URL');
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
