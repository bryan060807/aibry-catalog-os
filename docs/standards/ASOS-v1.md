# AIBRY Specialist Operational Standard v1

**Version:** ASOS v1

## Purpose

ASOS v1 defines the minimum operational reporting contract for focused AIBRY specialists. It does not authorize mutations beyond the specialist's own charter.

## Canonical Modes

- `OBSERVE`: collect and report direct evidence without proposing or applying a mutation.
- `PROPOSE`: present reviewable candidate actions without mutating source-of-truth content.
- `APPLY`: execute only explicitly guarded, charter-authorized mutations and verify each result.

## Required Report Contract

Every final report must include `SPECIALIST`, Specialist Version, Operational Standard version, unique Run ID, Mode, Started, Completed, Duration, a complete status summary including `ERROR` even when zero, and findings with `Status`, `Subject`, `Evidence`, `Recommendation`, plus `Result` when an action was attempted.

Policy or evidence rejection must be distinct from execution failure. A specialist must preserve evidence paths, refuse unsafe overwrite, record every mutation, and finalize its report after partial failures.
