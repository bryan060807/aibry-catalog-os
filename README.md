# AIBRY Specialist Platform

The **AIBRY Specialist Platform** is a governed ecosystem of focused AI-assisted specialists that collaborate through explicit authority, shared operational standards, and independently verifiable workflows.

**ASOS defines how specialists operate. AVC defines how they earn trust. Applications such as AIBRY Creative Studio orchestrate specialists into complete creative and operational workflows.**

This repository currently serves as the first reference implementation of that platform through **AIBRY Catalog OS**, **Archivist v1**, and **Project Admitter v2**.

## Why This Exists

AIBRY does not rely on one all-powerful assistant to inspect, decide, change, and verify everything at once.

Instead, each specialist has one clear responsibility and an explicit trust boundary.

- **OBSERVE** — inspect approved sources and report without changing canonical data.
- **PROPOSE** — calculate or stage recommended changes without applying them.
- **APPLY** — perform specifically authorized mutations and verify the result.

This makes every action explainable, bounded, authorized, and independently verifiable.

## Platform Architecture

```text
AIBRY Specialist Platform
│
├── ASOS v1
│   └── Defines authority, reporting, safety, mutation rules, and accountability
│
├── AVC v1
│   └── Defines how a specialist earns operational trust
│
├── Specialists
│   ├── Archivist v1
│   ├── Project Admitter v2
│   └── Future focused specialists
│
└── Applications
    ├── AIBRY Catalog OS
    └── AIBRY Creative Studio (planned orchestration layer)
```

## Core Standards

### ASOS v1

The **AIBRY Specialist Operational Standard** defines how every specialist is expected to behave.

It standardizes:

- OBSERVE, PROPOSE, and APPLY authority modes;
- `WOULD_*` for proposed actions and past-tense statuses for completed actions;
- explicit apply guards;
- deterministic reporting;
- mutation records;
- evidence preservation;
- safe reruns;
- independent verification;
- refusal to claim success before an operation is complete and verified.

See [ASOS v1](docs/standards/ASOS-v1.md).

### AVC v1

The **AIBRY Validation Cycle** defines how a specialist earns operational trust.

```text
OBSERVE
    ↓
PROPOSE
    ↓
Human Authorization
    ↓
APPLY
    ↓
Independent OBSERVE
```

A specialist is not considered trusted merely because its code runs or its tests pass. It must demonstrate bounded authority, verified execution, measurable improvement, and no regression in safety guarantees under real operating conditions.

Platform language is intentionally precise:

- **ASOS-compliant** — designed to follow the operational standard.
- **AVC Pending** — implementation may exist, but operational trust has not yet been demonstrated.
- **AVC Passed** — the evaluated capability successfully completed the full validation cycle.

**ASOS is versioned. AVC is earned.**

See [AVC v1](docs/standards/AVC-v1.md).

## Current Reference Implementation

### AIBRY Catalog OS

AIBRY Catalog OS is the read-first operating layer for the AIBRY Music Vault.

The vault remains canonical. Reports, indexes, schemas, and generated views are disposable and rebuildable from vault files.

The system never treats generated reports as a replacement for the vault itself.

### Archivist v1

The Archivist operates in **OBSERVE** mode.

It audits the catalog for:

- duplicate declared IDs or titles;
- missing `project.md` front doors;
- malformed YAML front matter;
- empty release containers;
- broken declared relationships;
- remaining legacy migration inventory;
- provenance gaps.

The Archivist never applies recommendations or mutates the vault.

See the [Archivist charter](docs/archivist/CHARTER.md), [onboarding guide](docs/archivist/ONBOARDING.md), and [audit checklist](docs/archivist/AUDIT-CHECKLIST.md).

### Project Admitter v2

Project Admitter operates in **PROPOSE** mode by default and supports guarded **APPLY** through an explicit `--apply` flag.

It only creates a missing direct `project.md` when the available evidence is unambiguous.

It never:

- overwrites an existing `project.md`;
- moves, renames, deletes, or rewrites vault content;
- chooses between ambiguous lyric sources;
- reports `ADMITTED` unless the write succeeded and the file was verified.

Status behavior:

- `WOULD_ADMIT` — eligible proposal; no mutation occurred.
- `ADMITTED` — the file was created and verified.
- `SKIPPED` — intentionally untouched or already admitted.
- `NEEDS_REVIEW` — human judgment is required.
- `ERROR` — an unexpected execution failure occurred.

See the [Project Admitter charter](docs/project-admitter/CHARTER.md), [onboarding guide](docs/project-admitter/ONBOARDING.md), and [report format](docs/project-admitter/REPORT-FORMAT.md).

## Proven Validation

Project Admitter v2 has **passed AVC** for guarded front-door admission against the live AIBRY Music Vault.

The first validated control loop produced:

- 19 proposed admissions;
- 19 verified `project.md` creations;
- 0 execution errors;
- 0 unexpected overwrites;
- catalog warnings reduced from **35 to 14**;
- unresolved items preserved as visible review work when evidence was insufficient.

See the [AIBRY Specialist Platform v1 milestone](docs/standards/AIBRY-SPECIALIST-PLATFORM-v1-MILESTONE.md).

## CLI

### Install and build

```powershell
npm install
npm run build
```

### Discover the catalog

```powershell
npm run catalog -- catalog discover --vault C:\AIBRY\music-vault --output .\reports\discovery.md
```

### Run the Archivist

```powershell
npm run catalog -- catalog audit --vault C:\AIBRY\music-vault --output .\reports\archivist-audit.md
```

### Run Project Admitter in PROPOSE mode

```powershell
npm run catalog -- catalog admit --vault C:\AIBRY\music-vault --output .\reports\project-admission-propose.md
```

### Run Project Admitter in APPLY mode

Only run this after reviewing the PROPOSE report:

```powershell
npm run catalog -- catalog admit --vault C:\AIBRY\music-vault --output .\reports\project-admission-apply.md --apply
```

### Emit the active managed-song contract

Catalog Contract Steward defines the versioned managed-song contract, required fields, lifecycle states, compatibility rules, and safety rules. It observes/proposes only and never mutates the Music Vault.

```powershell
npm run catalog -- catalog contract --vault C:\AIBRY\music-vault --output .\reports\managed-song-contract.json
```

### Publish a rebuildable catalog index

Catalog Publisher writes a disposable JSON index outside the Music Vault. The index combines the active managed-song contract, discovered managed songs, release containers, current audit findings, provisional candidates, warnings, and ASOS authority metadata for downstream API and dashboard use.

```powershell
npm run catalog -- catalog publish --vault C:\AIBRY\music-vault --output .\reports\catalog-index.json
```

### Inspect project assets without mutating the vault

Asset Inspector v1 is OBSERVE-only. It inventories managed song asset folders (`lyrics/`, `audio/`, `metadata/`, `artwork/`, `licensing/`, and `release-admin/`) and reports evidence-backed asset records, folder status, unresolved canonical lyric/provenance findings, audio variants, media-info evidence, and empty release-admin folders. It does not choose canonical lyrics, infer provenance, rewrite `project.md`, or create APPLY handoffs.

```powershell
npm run catalog -- catalog inspect-assets --vault C:\AIBRY\music-vault --output .\reports\asset-inspection.json
```

### Run the ASOS Kernel read-only refresh workflow

The ASOS Kernel / Workflow Orchestrator centralizes read-only specialist execution. The first workflow emits a managed-song contract, catalog index, asset inspection, routed finding summary, review inbox, operation journal, and consolidated run summary with artifact hashes and lineage. It has no APPLY capability.

```powershell
npm run catalog -- catalog workflow read-only-refresh --vault C:\AIBRY\music-vault --output .\reports\read-only-refresh.json
```

Asset Inspector findings are routed as kernel context (`evidence-only`, `reviewable`, `blocks-existing-proposal`, or `eligible-for-proposal`) and are not directly promoted into Review Inbox entries in v1.

### Generate a review inbox from current findings

Review Inbox turns published findings into reviewable proposals. It does not apply changes or mutate the Music Vault; approved proposals must be handed to a guarded APPLY specialist or deterministic service.

```powershell
npm run catalog -- catalog review-inbox --index .\reports\catalog-index.json --output .\reports\review-inbox.json
```

Optional decision state file format:

```json
[
  { "proposalId": "proposal:<findingId>", "state": "approved" }
]
```

Supported states are `pending`, `approved`, `rejected`, and `deferred`.

### Generate an operation journal from reviewed proposals

Operation Journal is the durable safety boundary before APPLY. It turns only executable approved proposals into pending APPLY handoff records. Approved or deferred proposals that lack a deterministic mutation plan are recorded as `blocked-insufficient-evidence`, not as executable work.

An executable APPLY handoff requires:

- exact target path;
- operation type;
- exact field/value or patch;
- evidence supporting the value;
- preconditions;
- expected post-state;
- rollback instructions;
- validator acceptance criteria.

It still does not apply changes or mutate the Music Vault.

```powershell
npm run catalog -- catalog operation-journal --inbox .\reports\review-inbox.json --output .\reports\operation-journal.json
```

### Validate operation results independently

Independent Validator observes an operation journal and a separate operation-results file. It verifies only results that provide evidence tied back to the journaled source path, marks unsupported claims, and reports missing or failed operations as not applied. It never mutates the Music Vault.

```powershell
npm run catalog -- catalog validate-operations --journal .\reports\operation-journal.json --results .\reports\operation-results.json --output .\reports\validation-report.json
```

Operation results file format:

```json
[
  {
    "operationId": "operation:<findingId>",
    "state": "applied",
    "summary": "What the APPLY specialist or service claims it did.",
    "evidence": ["Evidence that references the affected source path."],
    "mutatedPaths": ["project-memory/music/.../project.md"]
  }
]
```

Supported result states are `applied`, `failed`, and `skipped`.

### Serve the read-only Catalog API

After publishing an index, serve it locally for tool, dashboard, or operator use. The API reads only from the generated index file; it does not read from or mutate the Music Vault.

```powershell
npm run catalog -- catalog serve --index .\reports\catalog-index.json --host 127.0.0.1 --port 3873
```

Useful endpoints:

- `GET /health`
- `GET /api/catalog`
- `GET /api/contract`
- `GET /api/songs`
- `GET /api/songs?q=<search>`
- `GET /api/songs/<encoded catalogId>`
- `GET /api/album-releases`
- `GET /api/findings`
- `GET /api/findings?severity=warning&category=front-door`

### Re-audit after mutation

```powershell
npm run catalog -- catalog audit --vault C:\AIBRY\music-vault --output .\reports\archivist-audit-after-admission.md
```

## Safety Guarantees

The current implementation:

- rejects report output paths inside the Music Vault;
- skips directory links and junctions instead of following them;
- never mutates vault content during discovery or audit;
- performs no AI calls, database access, or network access;
- preserves existing front doors;
- requires explicit authorization for mutations;
- verifies completed writes;
- reports unresolved evidence instead of guessing.

## Catalog Rules

Song-shaped candidates are direct children of:

- `project-memory/music/singles`
- `project-memory/music/albums/<album-release>`

A candidate is treated as an admitted managed song only when its own direct `project.md` is a regular, non-link file.

Candidates without a safe front door remain provisional or unadmitted and do not affect managed-song, discovered-project, or release-completeness counts.

Album-release directories are grouping containers, not managed projects. Reserved scaffolds such as `song-name` and `album-name` are excluded. The legacy `lyrics` tree remains migration inventory until a song is explicitly admitted.

## Development

```powershell
npm run typecheck
npm run build
npm test
```

Tests use temporary fixture vaults. They do not inspect or mutate the live Music Vault.

## Canonical Source of Truth

The canonical vault instruction remains inside the Music Vault:

```text
instructions/catalog-structure.md
```

Repository documentation describes implementation, governance, and platform behavior. It does not replace or override canonical vault instructions without review.

## Future Direction

The next major application of the platform is **AIBRY Creative Studio**: an orchestration workflow that turns a finished song into a complete release package through focused specialists for catalog validation, artwork, merch assets, mockups, copy, SEO, social media, website assets, and release management.

The long-term platform direction also includes applying ASOS and AVC to Garage Admin hosting and server operations, including observability, deployment, backup and restore, incident response, configuration management, and guarded infrastructure changes.

## Milestone

The `asos-v1` tag marks the point where AIBRY moved from isolated automation tools to a governed specialist platform with explicit authority, shared language, and earned operational trust.

## First automated production loop

On 2026-07-24, Catalog OS completed its first automated, human-governed ASOS production loop against the canonical Music Vault.

The run completed refresh, deterministic scout, proposal, exact hash-bound approval, compatibility fixture, PowerShell 5.1 dry run, sealed guarded plan, live APPLY, and independent validation.

Production run: `live-batch-2026-07-24-02`  
Final status: `applied-and-validated`  
Operation count: `5`  
Validated catalog findings: `51 → 49`  
Validated asset findings: `226 → 222`

See `docs/standards/CATALOG-OS-FIRST-AUTOMATED-PRODUCTION-LOOP.md` for the exact proposal, plan, changed paths, safety boundary, and next implementation loop.
