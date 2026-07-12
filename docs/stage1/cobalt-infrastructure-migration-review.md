# Cobalt Infrastructure — Migration Review

## Scope

Legacy album directory:

`lyrics/albums/the-violence-of-spring/`

Reviewed song source:

`lyrics/albums/the-violence-of-spring/08-cobalt-infrastructure.md`

Previously proposed managed destination:

`project-memory/music/albums/the-violence-of-spring/08-cobalt-infrastructure/`

This review is planning-only. No vault files were copied, moved, renamed, edited, or deleted.

## Confirmed facts

- The legacy album directory contains `08-cobalt-infrastructure.md`.
- The lyric file identifies the song as **Cobalt Infrastructure**.
- The song content includes lyric sections, genre, mood, style, and production notes in one Markdown file.
- The file hash recorded by the read-only snapshot is:
  `F55224090B293B5F5127C674E1A786F2A51AF6853C4821C328A1E7875276D657`.
- No managed destination for Cobalt Infrastructure exists yet in the reviewed project-memory model.
- No duplicate Cobalt Infrastructure title was identified in the Stage 0 migration inventory.

## Album-order conflict

The legacy directory contains 13 numbered song files:

1. Vernal Fracture
2. The Optic Harvest
3. Chemistry of Collapse
4. Gated Silence
5. Cold Room Residue
6. Synaptic Shunt
7. Pollinated Ruin
8. Cobalt Infrastructure
9. The Violence of Spring
10. Hemorrhagic Logic
11. Perennial Error
12. Soft Reboot
13. False Spring

However, the reviewed album-notes document enumerates 11 tracks and omits both **Cold Room Residue** and **Cobalt Infrastructure**. In that document, The Violence of Spring is numbered 7, Hemorrhagic Logic 8, Perennial Error 9, Soft Reboot 10, and False Spring 11.

Therefore, the `08-` prefix is a current filesystem fact but not yet a verified final album track number.

## Additional source-quality findings

- `05-cold-room-residue.md` and `The Violence of Spring.md` had the same recorded byte length and SHA-256 hash in the snapshot. This suggests one may be a duplicate album-compendium file rather than a clean song-specific source.
- The PowerShell snapshot displayed mojibake in apostrophes and punctuation. This may be a snapshot decoding issue rather than source corruption. The original lyric file must be re-read with explicit UTF-8 handling before any copy or normalization.
- The album folder did not contain the requested `README.md` at snapshot time.

## Proposed managed-song shape

Once album membership and track order are approved, create a song-centric destination under:

`project-memory/music/albums/the-violence-of-spring/<approved-track-number>-cobalt-infrastructure/`

The song directory should follow the current managed-song contract and may include:

- `project.md`
- `lyrics/`
- `metadata/`
- `audio/`
- `artwork/`
- `licensing/`
- `lyric-video/`
- `release-admin/`

Only directories supported by actual content need to be populated during the first migration.

## Proposed first migration contents

The first guarded migration should be copy-only and limited to:

1. A UTF-8 verified copy of the approved Cobalt Infrastructure lyric.
2. Metadata extracted from the source file without deleting the original combined lyric/production document.
3. A draft `project.md` that records:
   - title;
   - album membership;
   - approved track number or unresolved track order;
   - legacy source path and hash;
   - lyric approval state;
   - known genre, mood, style, and production notes;
   - missing audio, artwork, licensing, release, identifier, and credit decisions.

No legacy source should be retired during the first migration.

## Required decisions before migration

1. Is Cobalt Infrastructure definitely part of the final **The Violence of Spring** album?
2. Are **Cold Room Residue** and **Cobalt Infrastructure** additions to the 11-track album-notes sequence, making the final album 13 tracks?
3. If Cobalt remains on the album, is track 08 final, or should tracks be renumbered against an approved tracklist?
4. Is the current lyric text approved as the canonical final lyric, or only a working draft?
5. Should the genre, mood, style, and production notes remain in the lyric file, move to metadata/production documents, or be represented in both with a declared canonical source?
6. Is there related audio, artwork, licensing, or metadata elsewhere in the vault that must be linked before admission?

## Guarded operation plan

After the decisions above are resolved:

1. Record the source file path, byte count, timestamp, and SHA-256 with explicit UTF-8 verification.
2. Confirm the approved album tracklist and destination name.
3. Confirm the destination does not already exist.
4. Create only the approved managed song directory and minimum required files.
5. Copy the source lyric; do not move or delete the legacy file.
6. Create a factual `project.md` without inventing release approvals.
7. Run catalog discovery and verify the new song is admitted only when `project.md` is intentionally approved.
8. Compare source and destination content hashes where exact copies are expected.
9. Record every created path and a rollback plan consisting of removal of only the newly created destination files.
10. Review the result before any legacy cleanup or broader album migration.

## Rollback

Because the first operation should be copy-only, rollback is limited to removing the newly created managed Cobalt Infrastructure directory after verifying that no later work depends on it. The legacy sources remain untouched throughout the operation.

## Current verdict

Cobalt Infrastructure is a clear song-level migration candidate under **The Violence of Spring**, but its final track number and the album's 11-versus-13-track sequence must be resolved before creating the managed destination.
