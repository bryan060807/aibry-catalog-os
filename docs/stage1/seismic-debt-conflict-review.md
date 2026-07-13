# Seismic Debt / Fatal Design — Title Conflict Review

## Decision

The two songs are separate tracks on separate releases:

- **The Rare Friction**, track 01: **Seismic Debt** — established older release; title remains unchanged.
- **Ground Wire Gospel**, track 07: **Fatal Design** — newer track renamed from Seismic Debt.

Do not merge, overwrite, or rename the older The Rare Friction song.

## Read-only validation

A read-only audit was run on 2026-07-12 after the Music Manager GPT rename pass.

Validated successfully:

- The old managed directory `07-seismic-debt` is absent.
- The Ground Wire Gospel legacy lyric is named `07-fatal-design.md`.
- The managed lyric is named `07-fatal-design.md` and begins with the title Fatal Design.
- The managed `project.md`, tracklist, and metadata notes identify Fatal Design as the canonical title.
- The Rare Friction source still retains its Seismic Debt filename and title.
- Historical rename notes clearly distinguish the two songs.

## Structural closeout

The managed song directory is normalized to:

`project-memory/music/albums/ground-wire-gospel/07-fatal-design/`

The prior mixed-case directory `07-Fatal_Design/` is absent. The track front door and album tracklist use the normalized lowercase kebab-case path, and no mixed-case path references remain in the managed album subtree.

## Expected historical references

Occurrences of the phrase **seismic debt** inside the lyric are intentional lyric content and are not stale title references.

References such as “previous title: Seismic Debt” are valid rename history and should remain.

Existing media-info snapshots still contain the former embedded audio title and source filename. They are documented as historical technical output. They should be regenerated after the source audio is retagged rather than edited manually.

## Closeout status

The conflict and structural closeout are complete. The managed directory has been normalized to `07-fatal-design/`, managed references have been updated, and focused read-only validation has passed. No catalog rename remains pending.

Retagging audio, updating Bandcamp, and regenerating media-info remain release-maintenance tasks rather than catalog-admission blockers.
