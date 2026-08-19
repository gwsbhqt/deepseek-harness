# Agent Note: Self-evolution identity is independent of the model route

Status: implemented

English | [中文](2026-08-19-self-evolution-identity.zh.md)

## Problem

The experimental evolving-agent composition used a provider-specific bootstrap name as its directory, session, terminal, and documentation identity. That name mixed the configured model provider with an early startup milestone. Neither identifies the capability the example preserves across model changes and restarts.

Renaming only the visible title would leave the old concept in durable session ids, runtime asset names, operator commands, prompt text, and self-authored documentation. The model would continue reading conflicting identities from its own replayed history and current composition.

## Decision

The example is `examples/self-evolution`, its stable root session is `self-evolution-main`, and its operator-facing rmux session is `self-evolution`. Its prompt and documentation define self-evolution as a repeated cycle: inspect current behavior, make one reversible change, validate observable behavior, persist successful changes, and inspect again.

The model route remains ordinary configuration. The current standalone composition still names `kimi-coding` and `k3-256k` where the LLM provider and model are selected, but neither name appears as the Agent's identity. A different provider can replace them without renaming the example, its session, or its operating instructions.

The [self-evolution Web runtime](2026-08-19-self-evolution-web-runtime.md) mounts browser transport in the same standalone composition. It reuses the stable Agent and does not duplicate its identity through a shipped or user preset.

## Alternatives considered

**Keep the provider-specific bootstrap identity and add a self-evolution display name.** Rejected because paths, session ids, terminal labels, replayed prompts, and persistence filenames would continue teaching the old identity.

**Remove every Kimi reference.** Rejected because `kimi-coding`, `k3-256k`, and `KIMI_API_KEY` are accurate provider configuration. Hiding them would make the composition harder to operate without making the Agent more model-independent.

**Represent the Web runtime as a shipped or user preset.** Rejected because a preset would assemble another Agent instead of exposing the live standalone runtime that owns the experiment's state.

## Consequences

The identity survives provider changes and describes the behavior users are selecting. Operators have one name across the repository path, root session, rmux session, and terminal and browser entry points. Existing session logs and persisted dynamic-plugin filenames migrate with the stable session id so the accumulated evolution history remains available.

The terminal and browser entry points share live IPython state, dynamic plugins, and session history because they address the same Agent in one process. The standalone persistence plugin waits for the matching `agent/created` event before replaying an active dynamic plugin, so composition order does not discard persisted behavior during restart. A failed replay retains its active marker for a later retry instead of converting a temporary runtime or code failure into permanent retirement. Root-level example plugins are part of the host TypeScript program, keeping the runnable composition and its regression tests on the same compiler face.
