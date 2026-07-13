# Legacy Migration Inventory

## Status and method

This is a read-only inventory of the current `lyrics/` corpus under `C:\AIBRY\music-vault`, checked against observed `project.md` files beneath `project-memory/music/`. Sprint 1 final admission-gated discovery reports 251 legacy entries (24 directories and 227 files), 30 safe `project.md` files, 0 provisional candidates, 0 unsafe candidates, 2 excluded placeholders, and 0 warnings. No top-level legacy metadata corpus was observed; metadata directories currently observed are inside managed songs, managed Ground Wire Gospel tracks, or placeholder scaffolds. This inventory does not migrate, rename, deduplicate, or declare any lyric canonical.

## Clear destination

These paths have an observed song-directory destination. The three standalone destinations now have safe direct `project.md` front doors.

| Legacy source | Observed or proposed destination | Note |
| --- | --- | --- |
| `lyrics/singles/came-out-wrong.md` | `project-memory/music/singles/came-out-wrong/` | managed standalone song; safe direct `project.md` present |
| `lyrics/singles/pressure-flower.md` | `project-memory/music/singles/pressure-flower/` | managed standalone song; safe direct `project.md` present |
| `lyrics/singles/the-kid-in-the-machine.md` | `project-memory/music/singles/the-kid-in-the-machine/` | managed standalone song; safe direct `project.md` present |
| `lyrics/albums/ground-wire-gospel/01-rust-on-the-ignition.md` through `08-ground-wire-autopsy.md` | matching numbered directories in `project-memory/music/albums/ground-wire-gospel/` | nine-track release has managed projects; see duplicate review for track 09 |

The eight clear Ground Wire Gospel destinations are `01-rust-on-the-ignition`, `02-oxidation-at-the-joints`, `03-voltage-bleed`, `04-scrap-iron-sermon`, `05-hemlock-and-concrete`, `06-tectonic-deficit`, `07-seismic-debt`, and `08-ground-wire-autopsy`.

## Ambiguous mapping

| Source | Why review is required | Potential destination |
| --- | --- | --- |
| `lyrics/albums/the-violence-of-spring/08-cobalt-infrastructure.md` | album placement is clear, but no managed project exists | `project-memory/music/albums/the-violence-of-spring/08-cobalt-infrastructure/` concept only |
| `lyrics/albums/ground-wire-gospel/09-wiretap-eviction.md` | two legacy variants exist | `project-memory/music/albums/ground-wire-gospel/09-wiretap-eviction/` |
| `lyrics/albums/ground-wire-gospel/09-wiretap-eviction-v2.md` | same title/version family; no canonical selection made | same as above |

## Duplicate or conflicting titles

These are title-level conflicts or variant relationships, not evidence that files should be deleted or merged.

| Title family | Paths |
| --- | --- |
| Kerosene Communion | `lyrics/albums/black-box-psalms/01-kerosene-communion.md`; `lyrics/albums/the-echo-integration/05-kerosene-communion-v2.md` |
| Seismic Debt | `lyrics/albums/ground-wire-gospel/07-seismic-debt.md`; `lyrics/albums/the-rare-friction/01-seismic-debt.md` |
| Wiretap Eviction | `lyrics/albums/ground-wire-gospel/09-wiretap-eviction.md`; `lyrics/albums/ground-wire-gospel/09-wiretap-eviction-v2.md` |

Album `README.md` files repeat by design and are container documentation, not song-title conflicts. `lyrics/.backups/albums/country-line-tradition/` is backup material and should remain archival pending a separate review.

## No managed destination yet

The following legacy collections have no observed managed song project. Each listed collection includes its track lyric files plus its album/README/notes files where present; no destination is inferred.

| Legacy collection | Current files or track set |
| --- | --- |
| `lyrics/albums/black-box-psalms/` | `01-kerosene-communion.md`–`07-the-total-collapse.md`, `Black Box Psalms.md`, `liner-notes.md`, `manifesto.md` |
| `lyrics/albums/copper-mouth/` | `01-heavy-water.md`–`10-grey-scale.md`, `Copper Mouth.md`, `README.md` |
| `lyrics/albums/country-line-tradition/` | `01-picking-wildflowers.md`–`05-the-thunder-rolls.md`, `Country Line Tradition.md`, `README.md`; backup copies also under `lyrics/.backups/albums/country-line-tradition/` |
| `lyrics/albums/fault-line-bloom/` | `01-implosion-recoil.md`–`10-code-is-repeating.md`, `Fault Line Bloom.md`, `README.md` |
| `lyrics/albums/random-song-album/` | `01-blackfever-dialogue.md`–`07-serpent-in-the-ditch.md`, `Random Song Album.md`, `README.md` |
| `lyrics/albums/recovery-sessions/` | `01-did-i-die-there.md`–`06-the-ending.md`, `RECOVERY SESSIONS.md`, `README.md` |
| `lyrics/albums/resonance-frequency/` | `01-lead-lined.md`–`03-carrier-signal.md`, `Resonance Frequency.md`, `README.md` |
| `lyrics/albums/structural-failure/` | `01-metal-fatigue.md`–`04-ghost-in-the-driveway.md`, `Structural Failure.md`, `README.md` |
| `lyrics/albums/the-anti-liturgy/` | `01-slaughter-at-the-altar.md`–`11-slaughter-at-the-altar-blood-letting.md`, `The Anti-Liturgy.md`, `README.md` |
| `lyrics/albums/the-architecture-is-failing/` | `01-dogma-of-the-rot.md`–`05-catastrophic-yield.md`, `The Architecture is Failing.md`, `README.md` |
| `lyrics/albums/the-cassette-tapes/` | `01-press-play.md`–`13-outro-click.md` (including `07.ashes-to-armor.md`), `The Cassette Tapes.md`, `README.md` |
| `lyrics/albums/the-echo-integration/` | `01-post-human-startup.md`–`08-silicon-strangulation.md`, `The Echo Integration.md`, `README.md` |
| `lyrics/albums/the-precedent-ep/` | `01-intro.md`–`08-the-verdict.md`, `The Precedent EP.md`, `README.md` |
| `lyrics/albums/the-rare-friction/` | `01-seismic-debt.md`–`07-the-weight-of-the-guest.md`, `The Rare Friction.md`, `README.md` |
| `lyrics/albums/the-violence-of-spring/` | `01-vernal-fracture.md`–`13-false-spring.md`, `The Violence of Spring.md`, `README.md`; Cobalt is separately noted above |
| `lyrics/albums/urban-deconstruction/` | `asphalt-lungs.md`, `cinder-block-genesis.md`, `corrosion-kinetics.md`, `high-voltage-trespass.md`, `ozone-&-acetone.md`, `scavenger's-requiem.md`, `the-wrecking-ball-waltz.md`, `Urban Deconstruction.md` |
| `lyrics/albums/wellness-trilogy/` | `01-wellness-check.md`–`03-open-casket.md`, `Wellness Trilogy.md`, `README.md` |
| `lyrics/albums/whispers-beneath-the-ash/` | `came-back-for-me.md`, `still-here.md`, `notes.md` |
| `lyrics/singles/` excluding the three clear-destination paths | 45 remaining standalone lyric files, from `96th-hour.md` through `yield-point.md`; each needs destination review before a managed project is proposed |

## Next review sequence

1. Resolve title/variant conflicts without changing source files.
2. Confirm release context and destination one song at a time.
3. Create a `project.md` first, linking source paths and retained evidence.
4. Propose every later copy, move, rename, or retirement as a reversible reviewed operation.
