# Kerosene Communion — Title Conflict Review

## Scope

Compared legacy sources:

- `lyrics/albums/black-box-psalms/01-kerosene-communion.md`
- `lyrics/albums/the-echo-integration/05-kerosene-communion-v2.md`

Related album documents were included in the read-only snapshot for context. No vault files were changed.

## Source identity

### Black Box Psalms version

- Album context: **Black Box Psalms**
- Current track label: `01-kerosene-communion`
- File title: **Kerosene Communion**
- SHA-256: `A8E14642E03E67709F004B66710BE37F2BDF7DDE2A00EEEB651F6BF91BC90E98`
- Size: 2,697 bytes
- Style context: dark outlaw country / industrial trap
- Narrative focus: destructive intimacy, fire, obsession, and volatile relationship imagery

### The Echo Integration version

- Album context: **The Echo Integration**
- Current track label: `05-kerosene-communion-v2`
- File title: **Kerosene Communion V2**
- SHA-256: `2C178305C2EC0A22E83BF749C300BA2BB8CE3B49331DD449A976AE055C8383CC`
- Size: 1,956 bytes
- Style context: industrial gospel / trap-metal / dark orchestral
- Narrative focus: machine religion, the Echo, synthetic transcendence, and ritualized system conversion

## Classification

These files are not byte duplicates, formatting variants, or minor lyric revisions.

They have substantially different:

- verses and choruses;
- narrative subjects;
- album-specific terminology;
- genre and production direction;
- arrangement notes; and
- thematic roles.

The Echo Integration file appears to be an album-specific rewrite or successor derived from the title/concept of the Black Box Psalms song. It should not overwrite, replace, or silently merge with the Black Box Psalms version.

## Recommended catalog treatment

Treat them as two distinct managed song projects with an explicit relationship:

1. **Kerosene Communion** — original Black Box Psalms song.
2. **Kerosene Communion V2** — Echo Integration rewrite/successor, linked to the original as a derivative or alternate composition.

Proposed future destinations, subject to each album's approved tracklist:

- `project-memory/music/albums/black-box-psalms/01-kerosene-communion/`
- `project-memory/music/albums/the-echo-integration/05-kerosene-communion-v2/`

Each project should retain its own lyric, metadata, release context, assets, and `project.md`. Neither project should use the other file as its canonical lyric.

## Governance decision

Owner confirmed that these are separate tracks on separate albums.

- Keep **Kerosene Communion** unchanged for Black Box Psalms.
- Keep **Kerosene Communion V2** unchanged for The Echo Integration.
- Retain the existing filenames and album-specific paths.
- Do not rename, merge, normalize, overwrite, or move either legacy source as part of this review.

## Relationship metadata

When the Echo Integration song is migrated, its front door should record:

- relationship type: rewrite, successor, derivative, or alternate composition;
- related original: Black Box Psalms — Kerosene Communion;
- whether lyrics, melody, audio, or only the concept/title are reused;
- rights and credit implications; and
- whether both versions may coexist in the active catalog.

No relationship facts beyond the observed textual and thematic connection should be invented.

## Guarded migration approach

For each version separately:

1. Confirm album membership and final track number.
2. Confirm the lyric is the intended version for that album.
3. Record source path, size, timestamp, and SHA-256.
4. Create a song-specific managed destination only after review.
5. Copy the lyric; do not move or delete the legacy source.
6. Create a factual `project.md` with album context and relationship metadata.
7. Validate discovery and front-door admission.
8. Defer legacy cleanup until both managed projects and their relationship are reviewed.

## Verdict

**Conflict classified:** two distinct album-specific songs sharing a title lineage, not duplicate files.

The migration blocker is naming and relationship approval for the Echo Integration version, not source ambiguity.
