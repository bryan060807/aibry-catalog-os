# AIBRY Catalog OS Vision

AIBRY Catalog OS exists to help humans and tools understand, audit, and maintain the Music Vault without weakening the vault as the durable source of truth.

## Principles

- The Music Vault is canonical.
- `instructions/catalog-structure.md` and each song's `project.md` are the front door.
- Generated reports and indexes are disposable.
- Missing facts stay missing until evidence is found.
- Preservation beats cleanup when history has creative or operational value.
- Any future mutation workflow must be reviewable, reversible, and explicitly approved.

## Sprint 1 Goal

Create a local, read-only foundation that can discover catalog structure and emit an external Markdown report without changing vault contents.

Sprint 1 deliberately excludes catalog mutation, databases, network services, AI calls, audio processing, migrations, and automatic content generation.
