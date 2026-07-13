# Stage 1 — Catalog Governance and Migration Preparation

## Purpose

Stage 1 turns the read-only discovery model into a controlled operating workflow. It does not bulk-migrate the legacy corpus. It defines how songs are admitted, how provisional material is handled, and how one reviewed song at a time can move toward the managed structure.

The authoritative vault remains `C:\AIBRY\music-vault`. All proposed operations must remain reversible, reviewable, and scoped to exact paths.

## Current baseline

Read-only catalog refresh completed on 2026-07-12:

- 30 admitted managed songs with direct `project.md` front doors.
- 3 standalone managed songs.
- 27 managed album tracks across 3 release containers:
  - Ground Wire Gospel: 9 tracks.
  - The Architecture Is Failing: 5 tracks.
  - The Violence of Spring: 13 tracks.
- 0 provisional candidates reported by discovery.
- 30 managed `project.md` files.
- 251 legacy inventory entries: 24 directories and 227 files.
- 2 placeholders excluded from catalog admission.
- 0 discovery warnings.

The refresh found that `the-architecture-is-failing/04-termination-code` now has a direct `project.md` and is technically admitted by the current catalog rule. This is an observed state change from the earlier provisional decision and still requires owner confirmation that the admission was intentional.

## Stage 1 workstreams

### 1. Provisional-content governance

Use [Catalog Admission and Provisional Content Policy](catalog-admission-and-provisional-content-policy.md) for directories that look like song projects but are not yet approved catalog entries.

Initial case: `the-architecture-is-failing/04-termination-code` is structurally admitted because a direct `project.md` exists, but explicit governance approval remains unconfirmed pending owner confirmation.

### 2. Contract stabilization

Review `../stage0/managed-song-contract-draft.md` against active work. Version only decisions that are stable enough to guide new entries. Keep optional or unsettled areas explicitly provisional.

Priority questions:

- Which `project.md` fields are required for admission versus completion?
- Which standard directories are required only when content exists?
- How should covers, derivatives, remixes, alternates, and revisions declare their relationship to an original song?
- Which album-level files belong to the release container rather than each song?

### 3. Legacy migration review queue

Do not bulk-copy the 251-entry legacy inventory. Review one destination at a time in this order:

1. [Ground Wire Gospel track 09 lyric variant selection](ground-wire-gospel-track-09-lyric-review.md) — decision recorded: `v2` is final; original is obsolete.
2. [The Violence of Spring album closeout](the-violence-of-spring-closeout.md) — complete; 13 tracks admitted, Cobalt Infrastructure confirmed at track 08.
3. [Kerosene Communion title conflict](kerosene-communion-conflict-review.md) — complete; separate album tracks retained unchanged.
4. [Seismic Debt / Fatal Design title conflict](seismic-debt-conflict-review.md) — complete; The Rare Friction retains Seismic Debt and Ground Wire Gospel track 07 is normalized as Fatal Design.
5. Remaining standalone legacy lyrics.
6. Remaining album collections.

Each reviewed item should produce a proposed destination, source list, conflict notes, front-door plan, copy plan, validation plan, and rollback plan before any write.

### 4. Operation records

Every future vault-changing operation should record:

- exact source and destination paths;
- reason and approval scope;
- pre-operation hashes or inventory where applicable;
- files created, copied, moved, renamed, or retired;
- validation result;
- rollback instructions; and
- whether catalog admission changed.

## Definition of done

Stage 1 is complete when:

- provisional-content states and transitions are documented and represented consistently;
- the managed-song contract has a reviewed versioned baseline;
- conflict-resolution rules exist for duplicate titles and lyric variants;
- at least one legacy song migration has been planned, executed, validated, and documented through the guarded workflow; and
- no bulk or destructive migration is required to demonstrate the process.
