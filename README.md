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
