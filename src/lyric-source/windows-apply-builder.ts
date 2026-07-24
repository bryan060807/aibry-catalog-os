import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalFilename, stageArtifact } from "../artifacts/handoff-specialist.js";
import { sha256Bytes } from "../kernel/canonical-json.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import { verifyReviewDecision } from "./approval.js";
import type { LyricSourceDesignationProposal, LyricSourceDryRunReport } from "./contracts.js";
import { verifyProposalCanonicalHash } from "./proposal-specialist.js";
import { renderHardenedWindowsApplyScript } from "./windows-apply-script-template.js";

export type WindowsApplyCandidate = {
  contract: "lyric-source-windows-apply-script.v1";
  content: string;
  sha256: string;
  proposalId: string;
  proposalSha256: string;
  released: false;
};

export async function releaseWindowsApplyScript(
  outputPath: string,
  proposal: LyricSourceDesignationProposal,
  decision: AuthorityTransitionDecision,
  dryRun: LyricSourceDryRunReport
): Promise<{ contract: "lyric-source-windows-apply-script.v1"; path: string; sha256: string; released: true }> {
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  if (
    dryRun.status !== "passed" ||
    dryRun.proposalIdentity.proposalId !== proposal.proposalId ||
    dryRun.proposalIdentity.proposalSha256 !== proposal.proposalSha256 ||
    dryRun.scriptIdentity.contract !== candidate.contract ||
    dryRun.scriptIdentity.scriptSha256 !== candidate.sha256
  ) {
    throw new Error("Windows APPLY artifact release refused: matching successful compatibility dry-run is required.");
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-apply-release-"));
  try {
    const candidatePath = path.join(temporaryRoot, canonicalFilename(candidate.contract));
    await writeFile(candidatePath, candidate.content, { encoding: "utf8", flag: "wx" });
    const staged = await stageArtifact(candidatePath, outputPath, candidate.contract, candidate.sha256, {
      proposalId: proposal.proposalId,
      proposalSha256: proposal.proposalSha256
    });
    return { contract: candidate.contract, path: staged.destination, sha256: staged.staged.actualSha256, released: true };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function compileWindowsApplyCandidate(
  proposal: LyricSourceDesignationProposal,
  decision: AuthorityTransitionDecision
): WindowsApplyCandidate {
  assertApprovedExactProposal(proposal, decision);
  const proposalJsonBase64 = Buffer.from(`${JSON.stringify(proposal)}\n`, "utf8").toString("base64");
  const content = renderHardenedWindowsApplyScript({
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    decisionArtifactSha256: decision.decisionArtifactSha256,
    proposalJsonBase64,
    operationCount: proposal.operations.length,
    evidenceCount: proposal.evidence.length,
    guardCount: proposal.guardFiles.length
  });
  return {
    contract: "lyric-source-windows-apply-script.v1",
    content,
    sha256: sha256Bytes(Buffer.from(content, "utf8")),
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    released: false
  };
}

function assertApprovedExactProposal(proposal: LyricSourceDesignationProposal, decision: AuthorityTransitionDecision): void {
  if (!verifyProposalCanonicalHash(proposal)) throw new Error("Proposal canonical SHA-256 is invalid.");
  if (!verifyReviewDecision(decision) || decision.decisionState !== "approved") throw new Error("An exact approved decision artifact is required.");
  if (decision.proposalId !== proposal.proposalId || decision.proposalSha256 !== proposal.proposalSha256) throw new Error("Approval is stale or binds to a different proposal.");
  if (proposal.operations.length === 0 || proposal.rollbackRequirements.length === 0 || proposal.independentValidatorCriteria.length === 0) {
    throw new Error("Proposal operation envelope, rollback requirements, and validator criteria must be complete.");
  }
}
