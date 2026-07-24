import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReviewDecision, createLyricSourceHandoff } from "../src/lyric-source/approval.js";
import type { LyricSourceDryRunReport } from "../src/lyric-source/contracts.js";
import { compileLyricSourceProposal } from "../src/lyric-source/proposal-specialist.js";
import { compileWindowsApplyCandidate } from "../src/lyric-source/windows-apply-builder.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

test("exact proposal approval and matching dry-run create one HANDOFF without APPLY", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-handoff-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const dryRun = successfulDryRun(proposal, candidate.sha256);
  const handoff = createLyricSourceHandoff(proposal, decision, candidate.sha256, dryRun, "d".repeat(64));
  assert.equal(handoff.state, "eligible-for-guarded-apply");
  assert.equal(handoff.applyExecuted, false);
  assert.equal(handoff.operations.length, 7);
});

test("stale approvals, incomplete envelopes, and mismatched dry-runs are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-refusal-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const stale = buildReviewDecision(proposal.proposalId, "0".repeat(64), "approved", proposal.generatedAt);
  assert.throws(() => compileWindowsApplyCandidate(proposal, stale), /stale/);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const incomplete = { ...proposal, rollbackRequirements: [] };
  assert.throws(() => compileWindowsApplyCandidate(incomplete, decision), /canonical SHA-256/);
  assert.throws(() => compileWindowsApplyCandidate({ ...proposal, operations: [] }, decision), /canonical SHA-256/);
  assert.throws(() => compileWindowsApplyCandidate({ ...proposal, independentValidatorCriteria: [] }, decision), /canonical SHA-256/);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const mismatched = successfulDryRun(proposal, "f".repeat(64));
  assert.throws(() => createLyricSourceHandoff(proposal, decision, candidate.sha256, mismatched, "d".repeat(64)), /does not match/);
});

function successfulDryRun(proposal: ReturnType<typeof compileLyricSourceProposal>, scriptSha256: string): LyricSourceDryRunReport {
  return {
    contract: "lyric-source-apply-dry-run-report.v1",
    generatedAt: proposal.generatedAt,
    powerShellVersion: "5.1.19041.5608",
    proposalIdentity: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, artifactSha256: "a".repeat(64) },
    scriptIdentity: { contract: "lyric-source-windows-apply-script.v1", scriptSha256 },
    parsedCollectionCounts: { operations: proposal.operations.length, evidence: proposal.evidence.length, guards: proposal.guardFiles.length },
    normalizedPathChecks: [],
    rollbackChecks: { targetCount: proposal.operations.length, originalsRehashed: true, pathsInsideRollbackRoot: true },
    reportChecks: { preReportLoadedFromDisk: true, postReportLoadedFromDisk: true, sameLoader: true, wrappedObjectsNormalized: true },
    resolverLookupChecks: { expected: proposal.evidence.length, foundExactlyOnce: proposal.evidence.length },
    expectedDeltas: proposal.expectedFindingDeltas,
    forcedFailureRollback: { attempted: true, restoredAllTargets: true },
    independentValidation: { ranFromPersistedArtifacts: true, status: "passed" },
    unrelatedFileDiffDetected: true,
    liveVaultAccess: false,
    mutationTarget: "temporary-mirror-only",
    status: "passed",
    failures: []
  };
}
