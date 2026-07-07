---
name: tsc-conventions
description: Not an invocable skill. TSC workspace-wide conventions (canonical entity map, mnemon write rules, CRM hygiene, injection defense) that are auto-composed into every agent's CLAUDE.md via instructions.md. Single source of truth — per-agent playbooks reference this instead of restating.
---

# TSC shared conventions

The content lives in `instructions.md` (sibling file), which the host composes
into every agent group's `CLAUDE.md` at container spawn. There is nothing to
invoke here.

To change a convention, edit `instructions.md` on the host; every agent picks
it up at its next spawn. The canonical entity mappings are additionally stored
in mnemon as `source:user` facts tagged `type:entity-mapping` so that recalling
a variant name (e.g. "BRF") surfaces the mapping.
