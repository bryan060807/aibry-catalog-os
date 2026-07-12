# AIBRY Catalog OS Agent Instructions

## Operating Boundary

- Treat the Music Vault as source of truth.
- Do not mutate vault contents during discovery, audit, or reporting.
- Do not invent catalog facts.
- Do not perform AI calls, database access, or network access in Sprint 1 tooling.
- Keep generated outputs outside the vault unless a future approved workflow explicitly allows otherwise.

## Development Rules

- Inspect existing patterns before editing.
- Prefer narrow patches and small modules.
- Preserve current contracts and routes.
- Validate backend changes with syntax checks and targeted tests.
- Clearly distinguish verified facts, assumptions, and unknowns.

## Runtime Safety

- Never expose secrets.
- Never write tokens, passwords, auth headers, or private connection strings to logs, reports, fixtures, or docs.
- Any future destructive operation requires a reviewable proposal, backup plan, and explicit approval.

## Sprint 1 Validation

- Use temporary fixture vaults for discovery tests.
- Do not run discovery against `C:\AIBRY\music-vault` without explicit approval.
- Run type checking, the build, and targeted tests after code changes.
