# Project Admitter v2 Report Format

Every report contains `SPECIALIST`, Specialist Version, Operational Standard version, a unique Run ID, Mode, Started, Completed, Duration, vault root, all status counts (including `ERROR: 0`), and one finding per considered path.

Each finding includes:

- `Status`;
- `Subject`;
- one or more `Evidence` lines, including the target path;
- `Recommendation` only in `OBSERVE` and `PROPOSE` reports;
- `Attempted` and `Result` in `APPLY` reports; and
- `Recovery` when an attempted mutation failed.

`WOULD_ADMIT` means eligible but not written. `ADMITTED` means the exclusive new `project.md` creation was attempted, succeeded, and was verified. In `APPLY`, `SKIPPED` explicitly records that no mutation was attempted, while `NEEDS_REVIEW` records that eligibility remained unverified and no mutation was attempted. `ERROR` records an attempted mutation that failed and is distinct from policy review. APPLY findings do not retain proposal recommendations. The execution summary distinguishes attempted, succeeded, failed, skipped, and unverified entries; the mutation record lists every successful vault mutation, and the report is finalized after partial failures.
