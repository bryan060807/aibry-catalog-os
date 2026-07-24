# Catalog Operator Console

> Guarded live APPLY is deliberately terminal-only. The Operator Console has no APPLY route, button, browser authorization input, or generic command surface. Use the separately documented guarded launcher only after a package has completed approval, compatibility, and handoff review.

## Purpose

The Catalog Operator Console is a small local UI over the existing ASOS Kernel workflows, specialist registry, approval module, and Artifact Handoff Specialist. It reduces long command entry without copying specialist logic into the browser.

The console is operator tooling, not a new authority source. A proposal remains pending until an exact governed decision artifact is created. No route executes APPLY.

## Safety boundary

- The server binds only to `127.0.0.1`.
- The default port is `4060`; `CATALOG_OPERATOR_PORT` may select another local port.
- The repository root is fixed to `C:\Users\bryan\aibry\projects\aibry-catalog-os`.
- The Music Vault root is fixed to `C:\AIBRY\music-vault` and is never caller-editable.
- Generated and selected artifacts must remain beneath the repository `reports` directory.
- Reports paths reject absolute paths, UNC paths, alternate data streams, dot segments, duplicate separators, symlinks, junctions, reparse traversal, and sibling-prefix escapes.
- POST requests require a random per-start operator token.
- The server accepts only fixed allowlisted operations and explicit argument shapes.
- Child processes use argument arrays with `shell: false`, bounded output, bounded time, and owned-process-tree termination on timeout or request cancellation.
- The activity log excludes lyric contents, encoded operation payloads, environment variables, tokens, and authorization prompt text.

## Starting and stopping

Compile and start:

```powershell
npm run build
npm run operator-ui
```

Development watch:

```powershell
npm run operator-ui:dev
```

The server prints a URL shaped like:

```text
http://127.0.0.1:4060/?token=<per-start-random-token>
```

The browser keeps the token only in memory and removes it from the visible URL. The token is not written to repository files. Stop the console with `Ctrl+C`.

## Operator stages

1. **Refresh** runs the ASOS Kernel read-only refresh with a fixed Vault root and a reports-only output.
2. **Scout / select input** runs the OBSERVE-only Lyric Source Batch Scout against a fresh persisted refresh lineage. It excludes the two golden releases by default, selects one deterministic two-to-four-track release batch, seals `lyric-source-planning-input.v1`, verifies it with the Proposal Specialist in memory, and stops. An existing reports-local planning input can still be selected explicitly.
3. **Generate proposal** runs the existing lyric-source planning workflow.
4. **Review** shows proposal identity, projects, operations, finding deltas, preconditions, rollback requirements, and validator criteria without showing encoded bytes by default.
5. **Approve** reconstructs and verifies the proposal, verifies its persisted artifact identity, then creates an exact decision artifact. Approval requires typing `APPROVE` and does not execute APPLY.
6. **Build script** invokes the governed Windows builder workflow with an approved decision and a reports-local fixture Vault.
7. **Dry run** invokes the existing compatibility workflow against a temporary mirror.
8. **Handoff** verifies the five-artifact operator package and its chain of custody.
9. **Stop before APPLY** is the terminal console stage.

## Equivalent CLI commands

The UI displays and can copy the exact validated command preview before each operation. Examples:

```powershell
node dist\src\cli.js catalog workflow read-only-refresh --vault 'C:\AIBRY\music-vault' --output '<repository>\reports\<output>.json'

node dist\src\cli.js catalog workflow scout-lyric-source-batch --vault 'C:\AIBRY\music-vault' --refresh-report '<reports>\operator\refresh\read-only-refresh.json' --output-directory '<reports>\operator\pilots\<pilot-id>' --min-tracks 2 --max-tracks 4

node dist\src\cli.js catalog workflow plan-lyric-source-migration --input '<reports>\input.json' --output '<reports>\batch\lyric-source-designation-proposal.v1.json'

node dist\src\cli.js catalog workflow build-windows-lyric-source-apply --proposal '<proposal>' --approval '<decision>' --fixture-vault '<reports-local-fixture>' --dry-run-report '<dry-run-report>' --output '<script>'

node dist\src\cli.js catalog workflow dry-run-lyric-source-apply --proposal '<proposal>' --script '<script>' --fixture-vault '<reports-local-fixture>' --output '<dry-run-report>'
```

Approval uses the existing in-process approval module because approval is an authority-bound decision operation rather than a shell command.

The scout writes `lyric-source-batch-scout-report.v1.json`, `lyric-source-planning-input.v1.json`, and `asos-workflow-run.v1.json` beneath its selected reports directory. A structured refusal writes the scout and workflow reports but no planning input. It never creates a proposal, decision, script, handoff, or APPLY result automatically.

## Reports

The constrained reports browser displays relative path, declared contract, size, modified time, SHA-256, status, and proposal or workflow identity. It supports formatted view, raw view, path copying, and governed verification.

`contentBase64` values are hidden unless **Show encoded payload** is explicitly selected. Reports cannot be edited or deleted through the console.

## Deliberately unavailable

The console does not provide:

- a terminal or arbitrary command runner;
- caller-selected executables or CLI arguments;
- filesystem browsing outside `reports`;
- report editing or deletion;
- commit, clean, reset, push, restart, or deployment actions;
- PowerShell input;
- an APPLY endpoint or APPLY button;
- public binding or public CORS;
- an account system, database, AI model, or network service.
