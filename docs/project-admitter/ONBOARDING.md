# Project Admitter Onboarding

## Purpose

Use the Admitter only after reviewing the external report. It is a structural front-door tool, not an approval, migration, or content-management tool.

## Usage

```powershell
npm run build
npm run catalog -- catalog admit --vault <vault-path> --output <report-path>
# Review the report, then explicitly opt in:
npm run catalog -- catalog admit --vault <vault-path> --output <report-path> --apply
```

`PROPOSE` is the default. Use `--observe` when an explicitly labeled observation report is needed; `--dry-run` remains a compatible alias for the default proposal behavior. Report output must remain outside the vault.

## Evidence Threshold

An entry is eligible only when discovery observes a song-shaped managed location, a missing direct target, its directory identity, release context, and exactly one non-empty direct regular UTF-8 `lyrics/*.md` source. This is deliberately narrower than the full governance admission checklist. The created file states that approval remains unconfirmed.

## Statuses

- `WOULD_ADMIT`: eligible in `OBSERVE` or `PROPOSE`; no write occurred.
- `ADMITTED`: an exclusive `APPLY` write succeeded and the new direct regular target was verified.
- `SKIPPED`: an existing safe front door or excluded scaffold; nothing is changed.
- `NEEDS_REVIEW`: a policy/evidence rejection (missing/ambiguous evidence or an unsafe existing target); resolve manually in a separately reviewed change.
- `ERROR`: an execution failure while applying an otherwise eligible entry; inspect the result and rerun safely after review.
