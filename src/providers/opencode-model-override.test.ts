/**
 * Unit test for the opencode provider's PER-GROUP model override.
 *
 * The host opencode provider historically forwarded a single global
 * OPENCODE_MODEL (.env) to every opencode container, so two opencode groups
 * could not run different models. It now prefers the per-group container-config
 * model (ctx.model) for both OPENCODE_MODEL and OPENCODE_SMALL_MODEL, falling
 * back to the global env value when the group has no model set. This guards
 * that behavior (e.g. Iris on flash while another group runs pro).
 */
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import './opencode.js'; // self-registers the opencode provider container-config
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('opencode per-group model override', () => {
  const fn = getProviderContainerConfig('opencode')!;
  const base = {
    sessionDir: path.join(os.tmpdir(), `oc-model-test-${process.pid}`),
    agentGroupId: 'g1',
    groupDir: path.join(os.tmpdir(), `oc-model-test-group-${process.pid}`),
    selectedSkills: [],
    hostEnv: {
      OPENCODE_PROVIDER: 'openrouter',
      OPENCODE_MODEL: 'env-model',
      OPENCODE_SMALL_MODEL: 'env-small',
    } as NodeJS.ProcessEnv,
  };

  it('uses the per-group model for both main + small model when ctx.model is set', () => {
    const { env } = fn({ ...base, model: 'group-model' });
    expect(env?.OPENCODE_MODEL).toBe('group-model');
    expect(env?.OPENCODE_SMALL_MODEL).toBe('group-model');
    expect(env?.OPENCODE_PROVIDER).toBe('openrouter'); // provider still from env
  });

  it('falls back to the global env model when ctx.model is unset', () => {
    const { env } = fn({ ...base, model: undefined });
    expect(env?.OPENCODE_MODEL).toBe('env-model');
    expect(env?.OPENCODE_SMALL_MODEL).toBe('env-small');
  });
});
