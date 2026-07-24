# Catalog OS Autopilot

Catalog OS Autopilot reduces the operator workflow to deterministic preparation plus one explicit live-mutation authorization.

## Current implemented boundary

The guarded launcher now supports a generic `bounded-lyric-source-batch` package policy instead of requiring the exact Ground Wire Gospel pilot package.

A bounded batch must:

- include 2-4 projects;
- remain inside one release container;
- use verified SHA-256 byte-match lyric evidence;
- mutate each included `project.md` and no more than the approved release control files (`migration-manifest.md`, `README.md`, `tracklist.md`);
- produce the expected catalog and asset finding deltas for the included project count;
- carry an approved decision bound to the exact proposal ID and SHA-256;
- pass the temporary-mirror dry-run suite;
- preserve exact proposal, script, report, handoff, and package lineage.

The legacy `ground-wire-gospel-pilot` package policy remains available for historical replay and tests.

## Prepare a guarded plan

```powershell
npm run catalog:autopilot:prepare -- `
  --package "C:\path\to\lyric-source-operator-package.v1.json" `
  --vault-root "C:\path\to\Music-Vault" `
  --rollback-root "C:\path\to\rollback\batch-05" `
  --result-dir "C:\path\to\results\batch-05" `
  --output "C:\path\to\plans\batch-05-plan.json"
```

This command verifies the complete package and writes a hash-sealed guarded plan. It does not mutate the Vault.

## Execute after review

```powershell
npm run catalog:autopilot:execute -- `
  --plan "C:\path\to\plans\batch-05-plan.json" `
  --plan-sha256 "<exact plan SHA-256>"
```

The launcher requires the operator to type the full plan SHA-256 before execution. `--yes` is reserved for explicitly controlled automation environments and still requires the expected plan SHA-256 argument.

## Remaining orchestration work

The package policy and guarded preparation stage are generic. The earlier stages—refresh, automatic safe-batch selection, proposal generation, decision capture, artifact build, and dry run—still need to be wrapped in a single resumable orchestration command. Until that wrapper lands, Autopilot begins from an already built operator package.
