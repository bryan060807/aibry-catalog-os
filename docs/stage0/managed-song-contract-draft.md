# Managed-song Contract Draft

## Status

**Draft.** This is the current minimum contract while the song structure is still being refined. It records the present direction; it does not require cosmetic renames, destructive cleanup, or retroactive completion without review.

The authoritative vault root is `C:\AIBRY\music-vault`. Vault-relative paths below use `/`.

## Minimum song-centric unit

A song-shaped directory is only a candidate until its direct `project.md` front door is a regular non-link file. A managed song is an admitted candidate:

- standalone single: `project-memory/music/singles/<song-slug>/`
- album track: `project-memory/music/albums/<album-release>/<track-slug>/`

Candidates without that safe `project.md` remain provisional/unadmitted: they may be reported for adoption work, but do not count as managed songs, discovered projects, or release completeness. An album-release directory is a grouping container, not a managed song. A legacy lyric path is source material until a reviewed migration associates it with a managed song.

## Front-door expectation

`project.md` is the first file to read. It should identify, without inventing facts:

- title and artist;
- release context: `standalone-single` or `album-track`, and parent album when applicable;
- status, concept, themes, sonic identity, and visual identity where known;
- known source lyric path and links to material project assets; and
- unresolved decisions and missing information.

Existing assets may remain at their present paths. A front door should link to them; it is not a reason to move or rename them.

## Standard areas

The current standard areas are `lyrics/`, `artwork/`, `ai-prompts/`, `release-admin/`, `metadata/`, `production/`, `visuals/`, `audio/`, `licensing/`, and `archive/`.

| Area | Contract state | Purpose |
| --- | --- | --- |
| `project.md` | required | Read-first project context. |
| `lyrics/` | required when lyrics exist | Final, alternate, and revision source material. |
| `audio/` | required when audio exists | Mastered, unmastered, and alternate audio. |
| `artwork/` | required when visual assets exist | Covers, visual direction, prompts, and iterations. |
| `metadata/` | required when known metadata exists | Release and technical facts; unknown facts stay unknown. |
| `release-admin/` | required when release work exists | Checklist, pitch, descriptions, tags, links, and social material. |
| `licensing/` | required when licensing evidence exists | Licenses and an index or clear reference. |
| `ai-prompts/` | optional/provisional | Preserved generation prompts and prompt variants. |
| `production/` | optional/provisional | Production, arrangement, mix, and master notes. |
| `visuals/` | optional/provisional | Visualizer, canvas, or music-video planning. |
| `lyric-video/` | optional/provisional legacy-compatible area | Existing lyric-video assets may remain here and be linked from `project.md`. |
| `archive/` | optional/provisional | Superseded material retained for history, never silently discarded. |

Empty folders are not required merely to satisfy the draft. The required condition is a usable `project.md` plus preservation and linkage of the material that already exists.

## Release-context rule

A standalone single remains under `project-memory/music/singles/`. An album track remains under its parent release under `project-memory/music/albums/`; being later released as a single requires an explicit review decision, not a duplicate folder by default. Release context belongs in `project.md` even when schedule or identifiers are not yet known.

## Current reference, not a template copy

The nine managed tracks under `project-memory/music/albums/ground-wire-gospel/` currently provide the strongest in-vault structural reference: each has `project.md` and observed `lyrics/`, `artwork/`, `audio/`, `licensing/`, `lyric-video/`, `metadata/`, and `release-admin/` areas. This draft does not claim all projects must have identical contents.

## Non-destructive adoption sequence

1. Confirm destination and release context.
2. Add a factual `project.md` that links existing files.
3. Preserve source lyric paths and alternates.
4. Add missing standard areas only when there is material or a reviewed need.
5. Propose, review, back up, and journal any later move, rename, replacement, or deletion.
