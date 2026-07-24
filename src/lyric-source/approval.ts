import { canonicalJsonSha256 } from "../kernel/canonical-json.js";
import { evaluateAuthorityTransition } from "../kernel/authority-policy.js";
import { specialistId, type AuthorityTransitionDecision } from "../specialists/contracts.js";
import type { LyricSourceApplyHandoff, LyricSourceDesignationProposal, LyricSourceDryRunReport } from "./contracts.js";
import { assertProposalIntegrity } from "./proposal-specialist.js";

export function buildReviewDecision(
  proposalId: string,
  proposalSha256: string,
  decisionState: AuthorityTransitionDecision["decisionState"],
  decisionTimestamp: string
): AuthorityTransitionDecision {
  const payload = {
    contract: "asos-authority-decision.v1" as const,
    proposalId,
    proposalSha256,
    decisionState,
    decisionTimestamp
  };
  return { ...payload, decisionArtifactSha256: canonicalJsonSha256(payload) };
}

export function verifyReviewDecision(decision: AuthorityTransitionDecision): boolean {
  return decision.decisionArtifactSha256 === canonicalJsonSha256({
    contract: decision.contract,
    proposalId: decision.proposalId,
    proposalSha256: decision.proposalSha256,
    decisionState: decision.decisionState,
    decisionTimestamp: decision.decisionTimestamp
  });
}

export function createLyricSourceHandoff(
  proposal: LyricSourceDesignationProposal,
  decision: AuthorityTransitionDecision,
  scriptSha256: string,
  dryRun: LyricSourceDryRunReport,
  dryRunReportSha256: string,
  proposalArtifactSha256 = dryRun.proposalIdentity.artifactSha256
): LyricSourceApplyHandoff {
  assertProposalIntegrity(proposal);
  if (!verifyReviewDecision(decision)) {
    throw new Error("Decision artifact hash is invalid.");
  }
  const authority = evaluateAuthorityTransition({
    from: "PROPOSE",
    to: "HANDOFF",
    specialistId: specialistId("operation-journal"),
    inputContracts: ["asos-authority-decision.v1"],
    outputContracts: ["lyric-source-apply-handoff.v1"],
    proposalBinding: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256 },
    decision,
    completeOperationPlan: proposal.operations.length > 0 && proposal.operations.every((operation, index) => operation.order === index + 1),
    completeRollbackCriteria: proposal.rollbackRequirements.length > 0,
    completeValidatorCriteria: proposal.independentValidatorCriteria.length > 0,
    independentValidatorId: specialistId("lyric-source-independent-validator")
  });
  if (!authority.allowed) {
    throw new Error(authority.refusal?.message ?? "Authority transition refused.");
  }
  if (
    dryRun.status !== "passed" ||
    dryRun.proposalIdentity.proposalId !== proposal.proposalId ||
    dryRun.proposalIdentity.proposalSha256 !== proposal.proposalSha256 ||
    dryRun.scriptIdentity.scriptSha256 !== scriptSha256 ||
    dryRun.scriptIdentity.contract !== "lyric-source-windows-apply-script.v1"
  ) {
    throw new Error("Successful compatibility dry-run does not match the proposal and script identities.");
  }
  return {
    contract: "lyric-source-apply-handoff.v1",
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    proposalArtifactSha256,
    decisionArtifactSha256: decision.decisionArtifactSha256,
    scriptSha256,
    dryRunReportSha256,
    state: "eligible-for-guarded-apply",
    applyExecuted: false,
    operations: proposal.operations,
    rollbackRequirements: proposal.rollbackRequirements,
    independentValidatorCriteria: proposal.independentValidatorCriteria
  };
}
