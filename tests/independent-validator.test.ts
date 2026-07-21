import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { buildValidationReport } from "../src/independent-validator.js";
import type { OperationResult, ValidationReport } from "../src/independent-validator.js";
import type { OperationJournal } from "../src/operation-journal.js";

test("Independent Validator verifies applied results that reference the journaled source path", () => {
  const report = buildValidationReport(sampleOperationJournal(), [
    {
      operationId: "operation:provenance-signal-fire",
      state: "applied",
      summary: "Recorded provenance note.",
      evidence: ["Updated project-memory/music/singles/Signal Fire/project.md with reviewed provenance."],
      mutatedPaths: ["project-memory/music/singles/Signal Fire/project.md"]
    }
  ]);
  assert.equal(report.schemaVersion, "validation-report.v1");
  assert.equal(report.authority.specialist, "Independent Validator");
  assert.equal(report.authority.authorityMode, "OBSERVE");
  assert.equal(report.authority.vaultMutation, "none");
  assert.equal(report.counts.verified, 1);
  assert.equal(report.counts.unsupported, 0);
  assert.equal(report.counts.notApplied, 1);
  assert.equal(report.records[0]?.state, "verified");
  assert.equal(report.records[0]?.unresolvedReason, null);
  assert.equal(report.records[1]?.state, "not-applied");
  assert.equal(report.records[1]?.unresolvedReason, "missing-result");
});

test("Independent Validator marks applied results unsupported without source-path evidence", () => {
  const report = buildValidationReport(sampleOperationJournal(), [
    {
      operationId: "operation:provenance-signal-fire",
      state: "applied",
      summary: "Claimed provenance repair.",
      evidence: ["Updated some unrelated file."],
      mutatedPaths: ["project-memory/music/singles/Other Song/project.md"]
    },
    {
      operationId: "operation:front-door-open-door",
      state: "failed",
      summary: "Repair failed.",
      evidence: ["Missing required evidence."]
    }
  ]);
  assert.equal(report.counts.verified, 0);
  assert.equal(report.counts.unsupported, 1);
  assert.equal(report.counts.notApplied, 1);
  assert.equal(report.records[0]?.state, "unsupported");
  assert.equal(report.records[0]?.unresolvedReason, "applied-result-did-not-reference-journaled-source-path");
  assert.equal(report.records[1]?.state, "not-applied");
  assert.equal(report.records[1]?.unresolvedReason, "result-failed");
});

test("catalog validate-operations writes a validation report", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "independent-validator-"));
  const journalPath = path.join(workspace, "operation-journal.json");
  const resultsPath = path.join(workspace, "operation-results.json");
  const outputPath = path.join(workspace, "validation-report.json");
  const results: OperationResult[] = [
    {
      operationId: "operation:provenance-signal-fire",
      state: "applied",
      summary: "Recorded provenance note.",
      evidence: ["Updated project-memory/music/singles/Signal Fire/project.md with reviewed provenance."],
      mutatedPaths: ["project-memory/music/singles/Signal Fire/project.md"]
    }
  ];
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(journalPath, `${JSON.stringify(sampleOperationJournal(), null, 2)}\n`, "utf8");
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    await main(["catalog", "validate-operations", "--journal", journalPath, "--results", resultsPath, "--output", outputPath]);
    const report = JSON.parse(await readFile(outputPath, "utf8")) as ValidationReport;
    assert.equal(report.schemaVersion, "validation-report.v1");
    assert.equal(report.counts.verified, 1);
    assert.equal(report.counts.notApplied, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog validate-operations rejects invalid operation results", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "independent-validator-"));
  const journalPath = path.join(workspace, "operation-journal.json");
  const resultsPath = path.join(workspace, "bad-results.json");
  const outputPath = path.join(workspace, "validation-report.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(journalPath, `${JSON.stringify(sampleOperationJournal(), null, 2)}\n`, "utf8");
    await writeFile(resultsPath, `${JSON.stringify([{ operationId: "operation:bad", state: "unknown", summary: "Bad", evidence: [] }], null, 2)}\n`, "utf8");
    await assert.rejects(
      () => main(["catalog", "validate-operations", "--journal", journalPath, "--results", resultsPath, "--output", outputPath]),
      /invalid result entry/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function sampleOperationJournal(): OperationJournal {
  return {
    schemaVersion: "operation-journal.v1",
    generatedAt: "2026-07-21T00:00:00.000Z",
    authority: {
      system: "AIBRY Catalog OS",
      specialist: "Operation Journal",
      authorityMode: "HANDOFF",
      operationalStandard: "ASOS v1",
      sourceOfTruth: "Music Vault",
      vaultMutation: "none"
    },
    source: {
      reviewInboxSchemaVersion: "review-inbox.v1",
      reviewInboxGeneratedAt: "2026-07-21T00:00:00.000Z",
      proposalCount: 2
    },
    counts: {
      pendingApply: 2,
      blockedInsufficientEvidence: 0,
      skippedNotApproved: 0,
      total: 2
    },
    entries: [
      journalEntry("operation:provenance-signal-fire", "proposal:provenance-signal-fire", "provenance-signal-fire", "project-memory/music/singles/Signal Fire/project.md", "provenance"),
      journalEntry("operation:front-door-open-door", "proposal:front-door-open-door", "front-door-open-door", "project-memory/music/albums/Black Box Psalms/01 Open Door/project.md", "front-door")
    ],
    blocked: []
  };
}

function journalEntry(
  operationId: string,
  proposalId: string,
  findingId: string,
  sourcePath: string,
  findingCategory: "provenance" | "front-door"
): OperationJournal["entries"][number] {
  return {
    operationId,
    proposalId,
    findingId,
    state: "pending-apply",
    authority: {
      system: "AIBRY Catalog OS",
      specialist: "Operation Journal",
      authorityMode: "HANDOFF",
      operationalStandard: "ASOS v1",
      sourceOfTruth: "Music Vault",
      vaultMutation: "none"
    },
    source: {
      reviewInboxGeneratedAt: "2026-07-21T00:00:00.000Z",
      sourcePath,
      findingSeverity: findingCategory === "provenance" ? "info" : "warning",
      findingCategory
    },
    proposedAction: "EXECUTABLE_APPLY_PLAN",
    evidence: [`Verified source path evidence references ${sourcePath}`],
    applyRequirement: "A guarded APPLY specialist or deterministic service must execute exactly the approved operation and record its result separately.",
    validationRequirement: "Independent Validator must reinspect the result before the finding can be closed.",
    executablePlan: {
      targetPath: sourcePath,
      operationType: "metadata-front-matter-patch",
      exactPatch: "Add reviewed field/value patch.",
      preconditions: ["The target file still lacks the reviewed field."],
      expectedPostState: ["The target file contains the reviewed field."],
      rollbackInstructions: ["Restore the target file from pre-apply backup."],
      validatorAcceptanceCriteria: ["Independent Validator observes the reviewed field in the target file."]
    }
  };
}
