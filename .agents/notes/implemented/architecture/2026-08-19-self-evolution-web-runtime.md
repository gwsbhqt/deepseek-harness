# Agent Note: Self-evolution Web attaches to the standalone runtime

Status: implemented

English | [中文](2026-08-19-self-evolution-web-runtime.zh.md)

## Problem

The self-evolution example owns live state that cannot be reconstructed by naming another composition the same way: a registered `self-evolution-main` Agent, an external IPython kernel, dynamic Cordis plugins, active goals, and a terminal fallback. A Web preset or a separate Web process would expose a second Agent or only persisted history, not this live runtime.

The operator also needs the official generic `dsh web` modes to remain available. Replacing their `ds` command or port would couple one experiment to the product-wide browser entry point.

## Decision

`examples/self-evolution/cordis.yml` mounts the Web Host API and browser client plugins directly after the standalone Agent composition. The API proxy resolves the already registered `self-evolution-main` Agent, so Web conversation, the terminal fallback, IPython, goals, and dynamic plugins use one process and one session.

The generic `ds` command continues to run official `dsh web` on `127.0.0.1:3080`. The separate `dse` command starts or reuses the `self-evolution` rmux session and exposes this composition on `127.0.0.1:3081`. Repeated `dse` calls reuse the live session. A failed startup prints recent runtime output and removes only the failed `self-evolution` rmux session.

The browser provides two inspection views. The Cordis panel shows and controls the current session's dynamic plugins. Settings → Plugins → Plugin List projects the complete Loader tree as read-only state. The model-visible `cordis_*` tools remain unchanged. `plugin-repl` remains mounted as a terminal fallback.

The browser may initially select a new draft instead of the only durable session. Selecting the existing session once is browser state and does not create another runtime. Hiding New Session or enforcing a single selectable session is outside this transport attachment.

## Alternatives considered

**Create a shipped or user Agent preset.** Rejected because it would assemble another Agent and split live IPython, goal, and dynamic-plugin state from the standalone experiment.

**Replace the generic `ds` command and port 3080.** Rejected because operators still need official modes and other presets independently of self-evolution.

**Run Web in a separate process against the persisted session log.** Rejected because a session log does not carry live services, kernel objects, dynamic fibers, or goal activation, and two processes must not present themselves as one active Agent.

**Hide New Session and force a single-instance browser.** Deferred because it changes Web product behavior rather than attaching transport to the existing runtime.

## Consequences

Browser and terminal interactions observe the same live Agent, and restart replay remains owned by one composition. Port and rmux ownership are explicit: `ds`/3080 is generic and `dse`/3081 is self-evolution. Source launches require built browser and client artifacts; a clean checkout runs `pnpm run build` before the first `dse` launch. The Web attachment does not add model-visible context because `surfaceContext` is disabled.
