# Guarded Live Apply Launcher

## Purpose and boundary

The guarded launcher is a terminal-only operator boundary for an already-approved lyric-source package. It is not an ASOS specialist, does not grant authority, and does not write proposal bytes into the Music Vault. The governed Windows PowerShell 5.1 script remains the only component that writes approved operation bytes.

There is no browser APPLY route, button, generic command runner, compatibility switch, or noninteractive authorization input.

## Phase 1: prepare

Run prepare from the repository after `npm run build`:

```powershell
npm run guarded-live-apply -- prepare `
  --package-manifest "C:\Users\bryan\aibry\projects\aibry-catalog-os\reports\operator\lyric-source\pilot\windows-build-live-01\lyric-source-windows-apply.v1.ps1.operator-package\lyric-source-operator-package.v1.json" `
  --vault "C:\AIBRY\music-vault" `
  --rollback-root "C:\Users\bryan\aibry\rollback\catalog-os\ground-wire-gospel-tracks-01-04-live-01" `
  --result-directory "C:\Users\bryan\aibry\projects\aibry-catalog-os\reports\operator\lyric-source\pilot\live-apply-ground-wire-gospel-01" `
  --output "C:\Users\bryan\aibry\projects\aibry-catalog-os\reports\operator\lyric-source\pilot\ground-wire-gospel-live-apply-plan.v1.json"
```

Prepare reopens and verifies the package and its five artifacts, checks the approved decision, passing dry run, eligible handoff, script identity, output boundaries, PowerShell 5.1, Node, and adapter identities. It emits a canonical `lyric-source-guarded-live-apply-plan.v1` and does not invoke APPLY.

Review the complete plan and record its full `planSha256`. Do not edit the plan or governed package.

## Phase 2: execute

Execute must run from an attached interactive Windows console. It refuses redirected input and CI environments.

```powershell
npm run guarded-live-apply -- execute `
  --plan "C:\Users\bryan\aibry\projects\aibry-catalog-os\reports\operator\lyric-source\pilot\ground-wire-gospel-live-apply-plan.v1.json" `
  --expected-plan-sha256 "<EXACT_PLAN_SHA256>"
```

The launcher first requires the exact proposal ID. The governed PowerShell script then independently asks `Type APPLY exactly to continue`. Neither prompt can be bypassed or prepopulated.

## Evidence and rollback

The result directory contains the plan copy, pre-APPLY Vault snapshot, pre/post refreshes, Independent Validator report, generated APPLY result, launcher report, bounded logs, and sealed adapter configuration. Rollback evidence is created beneath the separately selected rollback root before the PowerShell authorization prompt.

`applied-and-validated` is valid only when the script, post-refresh counts, validator, unrelated-file comparison, rollback package, and every persisted hash pass.

Failure states are:

- `refused-before-write`
- `failed-before-write`
- `failed-rolled-back-and-verified`
- `failed-rollback-unverified`
- `interrupted-state-unknown`

Never retry APPLY automatically. For `failed-rollback-unverified` or `interrupted-state-unknown`, preserve the result and rollback directories, stop, and inspect the exact rollback package before any further operator action. Do not delete or overwrite evidence.

Ctrl+C and normal termination are forwarded to the generated process and the launcher waits for child disposition where possible. Abrupt power loss or forced termination cannot be made risk-free; the generated script mitigates this by creating and verifying all rollback originals before it asks for APPLY.

Do not bypass PowerShell policy, artifact verification, plan-hash verification, either interactive confirmation, or the Independent Validator.
