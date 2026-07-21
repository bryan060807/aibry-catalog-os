# AIBRY Validation Cycle (AVC) v1

Status: Established
Established: 2026-07-13
Companion standard: ASOS v1

## Purpose

The AIBRY Validation Cycle defines how an AIBRY specialist proves that it is operationally trustworthy.

ASOS defines how specialists operate.

AVC defines how specialists demonstrate production readiness through a complete, independently verified control loop.

Unit tests prove implementation correctness. AVC proves operational behavior.

## Canonical Validation Cycle

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

The final OBSERVE step must be performed by an independent observer or audit path capable of confirming the real state after mutation.

## Production-Readiness Criteria

A specialist is not considered production-ready solely because its code runs or its tests pass.

A successful AVC requires:

- zero unexpected mutations;
- zero unverified writes;
- deterministic reporting;
- measurable improvement or confirmed intended outcome;
- no regression in safety guarantees;
- explicit human authorization before APPLY;
- independent verification after APPLY;
- unresolved work remains visible when evidence is insufficient;
- all execution failures are reported distinctly from policy rejection.

## Operational Roles

### OBSERVE

Inspects approved sources and produces evidence without modifying canonical data.

### PROPOSE

Transforms evidence into a bounded, reviewable action plan without modifying canonical data.

### Human Authorization

A human reviews the proposal, evidence, scope, and risk before granting permission to APPLY.

### APPLY

Performs only the explicitly authorized mutations, records each change, and verifies each completed action.

### Independent OBSERVE

Re-inspects canonical state after execution and confirms whether the intended result occurred without hidden regressions.

## Evidence Chain

A mature specialist workflow passes evidence forward:

```text
Observer
    ↓
Verified Evidence
    ↓
Executor
    ↓
Verified Mutation
    ↓
Observer
    ↓
Verified Improvement
```

Specialists do not merely produce reports or files. They produce trusted evidence for the next participant in the workflow.

## Finding Semantics Across the Cycle

### PROPOSE

```text
Status: WOULD_ADMIT
Evidence:
- ...
Recommendation:
- Run with explicit authorization to create project.md.
```

### APPLY

```text
Status: ADMITTED
Evidence:
- ...
Result:
- project.md created.
- Write independently verified.
```

Applied findings document what happened. They should not retain proposal-only instructions.

## First Validated AVC

The first complete AVC was performed against the AIBRY Music Vault using:

- Archivist v1 in OBSERVE mode;
- Project Admitter v2 in PROPOSE mode;
- explicit human authorization;
- Project Admitter v2 in APPLY mode;
- Archivist v1 in independent OBSERVE mode.

Results:

- 19 proposed admissions;
- 19 verified `project.md` creations;
- 0 execution errors;
- 0 unexpected overwrites;
- catalog warnings reduced from 35 to 14;
- unresolved items remained visible because the available evidence was insufficient.

This cycle validated the ASOS control loop under real catalog conditions.

## Readiness Language

AIBRY specialists should not be described as merely "finished" or "production-ready."

Use language that communicates demonstrated operational trust:

- `ASOS-compliant` means the specialist was designed to follow the AIBRY Specialist Operational Standard.
- `AVC Pending` means the specialist may exist and may pass tests, but it has not yet completed the validation cycle under real operational conditions.
- `AVC Passed` means the specialist successfully completed OBSERVE → PROPOSE → Human Authorization → APPLY → Independent OBSERVE for the capability being evaluated.

Preferred language:

- "Project Admitter v2 has passed AVC."
- "Deployment Manager is ASOS-compliant but AVC Pending."
- "This new capability requires AVC before it is trusted for production use."

AVC is earned per major capability. A material expansion in authority or behavior may require a new AVC even when an earlier version already passed.

ASOS is versioned.

AVC is earned.

## Relationship to ASOS

ASOS v1 is the operational contract.

AVC v1 is the validation contract.

Together they establish the baseline trust model for the AIBRY Specialist Platform.
