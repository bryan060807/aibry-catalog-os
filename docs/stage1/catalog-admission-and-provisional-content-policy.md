# Catalog Admission and Provisional Content Policy

## Purpose

This policy separates approved managed catalog entries from song-shaped material that is still exploratory, incomplete, derivative, or awaiting review.

A directory location or naming pattern does not grant catalog status by itself.

## Admission rule

A song directory is structurally admitted by discovery when it has a direct, regular, non-link `project.md` front door.

Structural admission and governance approval are related but distinct states. A front door may establish the observed managed-catalog state without proving that the owner explicitly approved the song's admission, rights, release intent, or derivative relationship.

The front door must identify the song, its release context, its current sources, and any unresolved decisions without inventing approvals. When explicit approval is absent or disputed, documentation must preserve an `approval unconfirmed` flag until the owner confirms or rejects admission.

Album release containers are grouping directories and are never admitted as song projects.

## Provisional candidate

A provisional candidate is a song-shaped directory under a managed root that does not have a safe direct `project.md`.

Examples include:

- exploratory songs;
- generated covers or derivatives;
- incomplete album tracks;
- abandoned or uncertain drafts;
- material created by automation without explicit catalog approval; and
- directories whose rights, origin, or destination are unresolved.

Provisional candidates remain discoverable for review but do not count as managed songs, discovered projects, or complete release content.

## Termination Code status

`project-memory/music/albums/the-architecture-is-failing/04-termination-code/` now has a safe direct `project.md` and is structurally admitted. Its governance approval remains unconfirmed pending review of:

- the original source song and relationship;
- whether the result is a cover, derivative, adaptation, alternate, or separate composition;
- rights and licensing implications;
- whether the material should be retained;
- intended release context and album membership; and
- whether its current location is appropriate.

## Allowed transitions

### Admit

Create or approve a direct `project.md` after the song's identity, origin, rights, release context, and retained assets have been reviewed.

Admission must be deliberate. It must not be triggered solely by directory discovery.

### Retain as provisional

Keep the directory in place without `project.md` when active work continues but catalog approval is premature. Record the reason and next review condition.

### Relocate to a draft area

Move the directory only through an approved guarded operation when it is useful working material but should not remain under a managed release container.

The destination and rollback plan must be documented before the move.

### Retire or remove

Delete or archive only after explicit approval, an inventory or backup appropriate to the material, and a documented reason. Discovery must never perform this transition automatically.

## Automation rules

Automation may:

- discover and report provisional candidates;
- compare their structure with managed songs;
- identify missing admission information; and
- draft review notes or proposed front doors outside the vault.

Automation must not:

- create `project.md` for provisional material without explicit authorization;
- infer rights or approval from filenames or directory placement;
- promote a cover or derivative into the catalog automatically;
- move or delete provisional material without a guarded operation; or
- include provisional candidates in managed-song completeness counts.

## Review checklist

Before admitting provisional content, confirm:

- song title and identity;
- original-versus-derived relationship;
- artist and writer credits;
- rights and licensing status;
- intended release context;
- final or retained audio candidates;
- lyric source and approval state;
- metadata conflicts;
- destination and naming;
- front-door content; and
- rollback or retirement plan for superseded material.
