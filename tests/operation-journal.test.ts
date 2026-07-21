import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { buildOperationJournal } from "../src/operation-journal.js";
import type { OperationJournal } from "../src/operation-journal.js";
import type { ReviewInbox, ReviewProposal } from "../src/review-inbox.js";

test("Operation Journal blocks approved proposals that lack deterministic APPLY plans", () => {
  const journal = buildOperationJournal(sampleReviewInbox());
  assert.equal(journal.schemaVersion, "operation-journal.v1");
  assert.equal(journal.authority.specialist, "Operation Journal");
  assert.equal(journal.authority.authorityMode, "HANDOFF");
  assert.equal(journal.authority.vaultMutation, "none");
  assert.equal(journal.source.reviewInboxSchemaVersion, "review-inbox.v1");
  assert.equal(journal.counts.pendingApply, 0);
  assert.equal(journal.counts.blockedInsufficientEvidence, 1);
  assert.equal(journal.counts.skippedNotApproved, 2);
  assert.equal(journal.counts.total, 0);
  assert.equal(journal.entries.length, 0);
  assert.equal(journal.blocked[0]?.operationId, "operation:provenance-signal-fire");
  assert.equal(journal.blocked[0]?.state, "blocked-insufficient-evidence");
  assert.ok(journal.blocked[0]?.missingRequirements.includes("exact-field-value-or-patch"));
  assert.ok(journal.blocked[0]?.blockedReason.includes("Approval alone is not sufficient"));
});

test("Operation Journal records deferred proposals as blocked insufficient evidence", () => {
  const inbox = sampleReviewInbox();
  inbox.proposals[0] = { ...inbox.proposals[0]!, state: "deferred" };
  const journal = buildOperationJournal(inbox);
  assert.equal(journal.counts.pendingApply, 0);
  assert.equal(journal.counts.blockedInsufficientEvidence, 1);
  assert.equal(journal.counts.skippedNotApproved, 2);
  assert.equal(journal.counts.total, 0);
  assert.equal(journal.blocked[0]?.proposalId, "proposal:provenance-signal-fire");
  assert.equal(journal.blocked[0]?.state, "blocked-insufficient-evidence");
});

test("Operation Journal never creates pending APPLY handoffs for deferred proposals", () => {
  const inbox = sampleReviewInbox();
  inbox.proposals[0] = { ...executableProposal(), state: "deferred" };
  const journal = buildOperationJournal(inbox);
  assert.equal(journal.counts.pendingApply, 0);
  assert.equal(journal.counts.blockedInsufficientEvidence, 1);
  assert.equal(journal.counts.total, 0);
  assert.equal(journal.entries.length, 0);
  assert.equal(journal.blocked[0]?.proposalId, "proposal:provenance-signal-fire");
});

test("Operation Journal creates pending APPLY handoffs only for executable approved plans", () => {
  const inbox = sampleReviewInbox();
  inbox.proposals[0] = executableProposal();
  const journal = buildOperationJournal(inbox);
  assert.equal(journal.counts.pendingApply, 1);
  assert.equal(journal.counts.blockedInsufficientEvidence, 0);
  assert.equal(journal.counts.skippedNotApproved, 2);
  assert.equal(journal.counts.total, 1);
  assert.equal(journal.entries[0]?.operationId, "operation:provenance-signal-fire");
  assert.equal(journal.entries[0]?.proposalId, "proposal:provenance-signal-fire");
  assert.equal(journal.entries[0]?.state, "pending-apply");
  assert.equal(journal.entries[0]?.executablePlan.targetPath, "project-memory/music/singles/Signal Fire/project.md");
  assert.ok(journal.entries[0]?.applyRequirement.includes("guarded APPLY specialist"));
  assert.ok(journal.entries[0]?.validationRequirement.includes("Independent Validator"));
});

test("catalog operation-journal writes blocked records from a review inbox", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "operation-journal-"));
  const inboxPath = path.join(workspace, "review-inbox.json");
  const outputPath = path.join(workspace, "operation-journal.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(inboxPath, `${JSON.stringify(sampleReviewInbox(), null, 2)}\n`, "utf8");
    await main(["catalog", "operation-journal", "--inbox", inboxPath, "--output", outputPath]);
    const journal = JSON.parse(await readFile(outputPath, "utf8")) as OperationJournal;
    assert.equal(journal.schemaVersion, "operation-journal.v1");
    assert.equal(journal.counts.pendingApply, 0);
    assert.equal(journal.counts.blockedInsufficientEvidence, 1);
    assert.equal(journal.blocked[0]?.findingId, "provenance-signal-fire");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog operation-journal rejects invalid inbox files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "operation-journal-"));
  const inboxPath = path.join(workspace, "bad-inbox.json");
  const outputPath = path.join(workspace, "operation-journal.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(inboxPath, `${JSON.stringify({ schemaVersion: "review-inbox.v1", proposals: [], authority: { vaultMutation: "unknown" } }, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => main(["catalog", "operation-journal", "--inbox", inboxPath, "--output", outputPath]),
      /non-mutating authority boundary/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function executableProposal(): ReviewProposal {
  const targetPath = "project-memory/music/singles/Signal Fire/project.md";
  const evidence = `Verified source path evidence references ${targetPath}`;
  return {
    ...sampleReviewInbox().proposals[0]!,
    evidence: [evidence],
    proposedAction: `EXECUTABLE_APPLY_PLAN: ${JSON.stringify({
      targetPath,
      operationType: "metadata-front-matter-patch",
      exactPatch: "Add reviewed provenance.sourcePaths entry.",
      preconditions: ["project.md still lacks reviewed provenance source paths."],
      expectedPostState: ["project.md contains reviewed provenance.sourcePaths entry."],
      rollbackInstructions: ["Restore project.md from pre-apply backup."],
      validatorAcceptanceCriteria: ["Independent Validator observes the reviewed provenance.sourcePaths entry."]
    })}`
  };
}

function sampleReviewInbox(): ReviewInbox {
  return {
    schemaVersion: "review-inbox.v1",
    generatedAt: "2026-07-21T00:00:00.000Z",
    authority: {
      system: "AIBRY Catalog OS",
      specialist: "Review Inbox",
      authorityMode: "PROPOSE",
      operationalStandard: "ASOS v1",
      sourceOfTruth: "Music Vault",
      vaultMutation: "none"
    },
    source: {
      indexSchemaVersion: "catalog-index.v1",
      indexGeneratedAt: "2026-07-21T00:00:00.000Z",
      managedSongContractVersion: "managed-song-contract.v1"
    },
    counts: {
      pending: 1,
      approved: 1,
      rejected: 1,
      deferred: 0,
      total: 3
    },
    proposals: [
      {
        proposalId: "proposal:provenance-signal-fire",
        findingId: "provenance-signal-fire",
        state: "approved",
        authority: {
          system: "AIBRY Catalog OS",
          specialist: "Review Inbox",
          authorityMode: "PROPOSE",
          operationalStandard: "ASOS v1",
          sourceOfTruth: "Music Vault",
          vaultMutation: "none"
        },
        source: {
          indexGeneratedAt: "2026-07-21T00:00:00.000Z",
          sourcePath: "project-memory/music/singles/Signal Fire/project.md",
          findingSeverity: "info",
          findingCategory: "provenance"
        },
        summary: "No structured migration provenance declared",
        evidence: ["No recognized provenance field was found in YAML front matter."],
        proposedAction: "Record verified source paths.",
        requiredApproval: true,
        applyBoundary: "No vault mutation is allowed from the inbox. Approved proposals must be handed to a guarded APPLY specialist or deterministic service."
      },
      {
        proposalId: "proposal:front-door-open-door",
        findingId: "front-door-open-door",
        state: "pending",
        authority: {
          system: "AIBRY Catalog OS",
          specialist: "Review Inbox",
          authorityMode: "PROPOSE",
          operationalStandard: "ASOS v1",
          sourceOfTruth: "Music Vault",
          vaultMutation: "none"
        },
        source: {
          indexGeneratedAt: "2026-07-21T00:00:00.000Z",
          sourcePath: "project-memory/music/albums/Black Box Psalms/01 Open Door/project.md",
          findingSeverity: "warning",
          findingCategory: "front-door"
        },
        summary: "Front door is incomplete",
        evidence: ["project.md is missing required managed-song fields."],
        proposedAction: "Prepare a managed-song contract repair proposal.",
        requiredApproval: true,
        applyBoundary: "No vault mutation is allowed from the inbox. Approved proposals must be handed to a guarded APPLY specialist or deterministic service."
      },
      {
        proposalId: "proposal:duplicate-example",
        findingId: "duplicate-example",
        state: "rejected",
        authority: {
          system: "AIBRY Catalog OS",
          specialist: "Review Inbox",
          authorityMode: "PROPOSE",
          operationalStandard: "ASOS v1",
          sourceOfTruth: "Music Vault",
          vaultMutation: "none"
        },
        source: {
          indexGeneratedAt: "2026-07-21T00:00:00.000Z",
          sourcePath: "project-memory/music/singles/Signal Fire/project.md",
          findingSeverity: "info",
          findingCategory: "duplicate"
        },
        summary: "Potential duplicate was rejected",
        evidence: ["Human review rejected this proposal."],
        proposedAction: "No action.",
        requiredApproval: true,
        applyBoundary: "No vault mutation is allowed from the inbox. Approved proposals must be handed to a guarded APPLY specialist or deterministic service."
      }
    ]
  };
}
