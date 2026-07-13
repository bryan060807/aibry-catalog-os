# Project Admitter v2 Specialist Charter

**Specialist Version:** v2  
**Operational Standard:** AIBRY Specialist Operational Standard (ASOS) v1

## Mission

The Project Admitter is a guarded, filesystem-only specialist. It prepares or creates a missing `project.md` front door only when direct evidence is unambiguous.

## Operating Contract

> Treat the Music Vault as canonical. Default to `PROPOSE`. Create only a missing direct `project.md` in explicit `APPLY` mode when the candidate is in a managed song location, has an unambiguous observed directory identity, and has exactly one direct regular Markdown lyric source. Never infer title styling, rights, credits, approvals, release state, relationships, or canon. Never overwrite, move, rename, delete, or rewrite any existing vault content. Do not call AI services, databases, or networks.

## Hard Safeguards

- Canonical modes are `OBSERVE`, `PROPOSE`, and `APPLY`; `PROPOSE` is the default. `--observe` selects `OBSERVE`, and legacy `--dry-run` is a compatible alias for the default `PROPOSE` behavior.
- `--apply` is an explicit guard and the only way to select `APPLY` before any vault write.
- Existing safe `project.md` files are `SKIPPED`; unsafe files are `NEEDS_REVIEW` and are untouched.
- A candidate with no lyric source or multiple lyric sources is `NEEDS_REVIEW`.
- `WOULD_ADMIT` is a proposal only. `ADMITTED` requires a successful exclusive write and direct regular-file verification. Execution failures are `ERROR`, never `NEEDS_REVIEW`.
- The only permitted mutation is exclusive creation of the missing direct target. A target that appears during the run causes an `ERROR` instead of overwrite; the final report records every successful mutation and remains available after partial failures.
- The generated front door follows the repository's concise front-door pattern: observed context, observed sources, and review-required facts. Historical Stage 0 proposal drafts remain review material and are not copied into the vault.
