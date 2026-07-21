# Project Admitter v2 Report Format

Every report contains `SPECIALIST`, Specialist Version, Operational Standard version, a unique Run ID, Mode, Started, Completed, Duration, vault root, all status counts (including `ERROR: 0`), and one finding per considered path.

Each finding includes:

- `Status`;
- `Subject`;
- one or more `Evidence` lines, including the target path;
- `Recommendation` when no action completed or recovery is required; and
- `Result` for an applied action or execution error.

`WOULD_ADMIT` means eligible but not written. `ADMITTED` means the exclusive new `project.md` creation succeeded and was verified; it records the result and does not retain the proposal-only recommendation. `NEEDS_REVIEW` is a policy/evidence rejection and never triggers a mutation. `ERROR` is an execution failure and is distinct from policy review. The mutation record lists every successful vault mutation, and the report is finalized after partial failures.
