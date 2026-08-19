# Agent Note: Self-evolution identity is independent of the model route

Status: implemented

English | [中文](2026-08-19-self-evolution-identity.zh.md)

## Problem

The experimental evolving-agent composition used a provider-specific bootstrap name as its directory, session, terminal, and documentation identity. That name mixed the configured model provider with an early startup milestone. Neither identifies the capability the example preserves across model changes and restarts.

Renaming only the visible title would leave the old concept in durable session ids, runtime asset names, operator commands, prompt text, and self-authored documentation. The model would continue reading conflicting identities from its own replayed history and current composition.

## Decision

The example is `examples/self-evolution`, its stable root session is `self-evolution-main`, and its operator-facing rmux session is `self-evolution`. Its prompt and documentation define self-evolution as a repeated cycle: inspect current behavior, make one reversible change, validate observable behavior, persist successful changes, and inspect again.

The model route remains ordinary configuration. The current standalone composition still names `kimi-coding` and `k3-256k` where the LLM provider and model are selected, but neither name appears as the Agent's identity. A different provider can replace them without renaming the example, its session, or its operating instructions.

The Web deployment authors `self-evolution` as a user preset rather than adding a shipped preset. The preset carries the same identity and evidence-driven loop while inheriting the shipped creation preset's tool composition. It does not claim the standalone process's in-memory services or live session; those remain separate runtime assemblies.

## Alternatives considered

**Keep the provider-specific bootstrap identity and add a self-evolution display name.** Rejected because paths, session ids, terminal labels, replayed prompts, and persistence filenames would continue teaching the old identity.

**Remove every Kimi reference.** Rejected because `kimi-coding`, `k3-256k`, and `KIMI_API_KEY` are accurate provider configuration. Hiding them would make the composition harder to operate without making the Agent more model-independent.

**Ship self-evolution as a fifth built-in preset.** Rejected because the experiment includes local runtime plugins and operator-owned state. A user preset can evolve independently without turning one experimental composition into a product default maintained by every installation.

## Consequences

The identity survives provider changes and describes the behavior users are selecting. Operators have one name across the repository path, root session, rmux session, terminal label, and Web preset. Existing session logs and persisted dynamic-plugin filenames migrate with the stable session id so the accumulated evolution history remains available.

The standalone example and Web preset intentionally do not share live memory. Moving IPython state, dynamic plugins, or an existing session between those processes remains an explicit migration rather than an implication of the shared name. The standalone persistence plugin waits for the matching `agent/created` event before replaying an active dynamic plugin, so composition order does not discard persisted behavior during restart. A failed replay retains its active marker for a later retry instead of converting a temporary runtime or code failure into permanent retirement. Root-level example plugins are part of the host TypeScript program, keeping the runnable composition and its regression tests on the same compiler face.
