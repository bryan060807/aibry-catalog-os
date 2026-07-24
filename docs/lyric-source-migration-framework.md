# Lyric-Source Migration Framework v1

The ASOS Kernel governs lyric-source migration as separate proposal, execution-artifact, compatibility, handoff, and independent-validation products.

Authority flow:

`OBSERVE -> PROPOSE -> exact proposal SHA-256 approval -> HANDOFF -> guarded external APPLY -> independent OBSERVE -> ASOS refresh`

This repository does not expose a CLI command that executes live APPLY.

## Commands

```text
catalog specialist list
catalog specialist describe <specialist-id>

catalog artifact verify --file <path> --expected-contract <contract> --expected-sha256 <hash>
catalog artifact stage --file <path> --destination <path> --expected-contract <contract> --expected-sha256 <hash>

catalog workflow plan-lyric-source-migration --input <planning-input.json> --output <proposal.json>
catalog workflow build-windows-lyric-source-apply --proposal <proposal.json> --approval <decision.json> --fixture-vault <fixture> --dry-run-report <report.json> --output <apply.ps1>
catalog workflow dry-run-lyric-source-apply --proposal <proposal.json> --script <apply.ps1> --fixture-vault <fixture> --output <report.json>
catalog workflow validate-lyric-source-apply --proposal <proposal.json> --vault <observed-root> --snapshot <pre-snapshot.json> --workflow-report <refresh.json> --output <validator.json> --generated-at <ISO-8601>
```

The build workflow compiles a candidate only in a temporary directory, runs the Windows PowerShell 5.1 compatibility specialist against a copied fixture mirror, and releases the requested `.ps1` only after a successful identity-matched report. The released script still requires exact operator authorization and an external Independent Validator process.

## Contracts

- `lyric-source-planning-input.v1`
- `lyric-source-designation-proposal.v1`
- `asos-authority-decision.v1`
- `lyric-source-windows-apply-script.v1`
- `lyric-source-apply-dry-run-report.v1`
- `lyric-source-apply-handoff.v1`
- `lyric-source-vault-snapshot.v1`
- `lyric-source-independent-validation-report.v1`
- `asos-workflow-run.v1`

Golden fixtures model the proven Black Box Psalms eight-operation run and The Violence of Spring seven-operation run. The latter preserves Track 05 as excluded because its evidence changed.

Run the Windows compatibility suite explicitly with:

```text
npm run test:powershell51
```
