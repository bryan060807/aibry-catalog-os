# AIBRY Catalog OS

AIBRY Catalog OS is a read-first operating layer for the AIBRY Music Vault. The vault remains canonical; generated reports, indexes, schemas, and tooling are disposable views rebuilt from vault files.

## Sprint 1 Foundation

- Read-only TypeScript CLI.
- Vault discovery report generation.
- Source-of-truth and preservation policy helpers.
- JSON schemas for future catalog operations and audit findings.
- Minimal fixtures and tests around vault safety rules.

## CLI

```powershell
npm install
npm run build
npm test
npm run catalog -- catalog discover --vault C:\AIBRY\music-vault --output .\reports\discovery.md
npm run catalog -- catalog audit --vault C:\AIBRY\music-vault --output .\reports\archivist-audit.md
```

The `catalog discover` command:

- validates that `--vault` exists and is a directory
- requires and reads `instructions/catalog-structure.md` as UTF-8
- rejects any `--output` path inside the vault
- skips directory links and junctions rather than following them
- never mutates vault contents
- performs no AI calls, database access, or network access

Song-shaped candidates are direct children of `project-memory/music/singles` and track-shaped children of `project-memory/music/albums/<album-release>`. A candidate is admitted as a managed song only when its own direct `project.md` is a regular non-link file. Candidates without a safe front door are reported separately as provisional/unadmitted and do not affect managed-song, discovered-project, or release-completeness counts. Album-release directories are release/grouping containers only, never managed projects; `song-name` and `album-name` scaffolds are excluded. The `lyrics` tree remains legacy corpus and migration inventory until a song is explicitly migrated.

The report path must be supplied explicitly. Reports are generated artifacts and should remain outside the Music Vault. Sprint 1 discovery is deterministic and does not interpret or generate catalog facts.

## Archivist Audit

`catalog audit` is the read-only Archivist specialist command. It writes a structured external report covering duplicate declared IDs/titles, missing front doors, malformed YAML front matter, empty release containers, declared broken relationships, legacy migration inventory, and declared provenance gaps. It never applies a recommendation or mutates the vault. See [the Archivist charter](docs/archivist/CHARTER.md), [onboarding](docs/archivist/ONBOARDING.md), and [audit checklist](docs/archivist/AUDIT-CHECKLIST.md).

## Project Admitter

`catalog admit` is the guarded **Project Admitter v2** specialist, compliant with AIBRY Specialist Operational Standard (ASOS) v1. Its canonical report modes are `OBSERVE`, `PROPOSE`, and `APPLY`; it defaults to `PROPOSE`. A proposal reports `WOULD_ADMIT`, while `ADMITTED` is emitted only after `--apply` creates and verifies a missing direct `project.md`. Policy uncertainty is `NEEDS_REVIEW`; execution failures are `ERROR`. Only `--apply` may create a front door, and it never overwrites, moves, renames, deletes, or rewrites vault content.

```powershell
npm run catalog -- catalog admit --vault C:\AIBRY\music-vault --output .\reports\project-admission.md
# After reviewing the PROPOSE report:
npm run catalog -- catalog admit --vault C:\AIBRY\music-vault --output .\reports\project-admission-applied.md --apply
```

See the [Project Admitter charter](docs/project-admitter/CHARTER.md), [onboarding](docs/project-admitter/ONBOARDING.md), [report format](docs/project-admitter/REPORT-FORMAT.md), and [ASOS v1](docs/standards/ASOS-v1.md).

## Development

```powershell
npm run typecheck
npm run build
npm test
```

Tests build temporary fixture vaults. They do not inspect the live Music Vault.

## Canonical Instruction

The canonical vault instruction remains inside the Music Vault:

`instructions/catalog-structure.md`

Repository documents are planning and implementation references. They do not replace or override the existing canonical instruction without review.
