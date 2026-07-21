import { readFile } from "node:fs/promises";
import type { ReviewInbox, ReviewProposal } from "./review-inbox.js";

type JournalAuthority = {
  system: "AIBRY Catalog OS";
  specialist: "Operation Journal";
  authorityMode: "HANDOFF";
  operationalStandard: "ASOS v1";
  sourceOfTruth: "Music Vault";
  vaultMutation: "none";
};

type JournalSource = {
  reviewInboxGeneratedAt: string;
  sourcePath: string;
  findingSeverity: ReviewProposal["source"]["findingSeverity"];
  findingCategory: ReviewProposal["source"]["findingCategory"];
};

export type OperationJournalEntry = {
  operationId: string;
  proposalId: string;
  findingId: string;
  state: "pending-apply";
  authority: JournalAuthority;
  source: JournalSource;
  proposedAction: string;
  evidence: string[];
  applyRequirement: "A guarded APPLY specialist or deterministic service must execute exactly the approved operation and record its result separately.";
  validationRequirement: "Independent Validator must reinspect the result before the finding can be closed.";
  executablePlan: {
    targetPath: string;
    operationType: string;
    exactPatch: string;
    preconditions: string[];
    expectedPostState: string[];
    rollbackInstructions: string[];
    validatorAcceptanceCriteria: string[];
  };
};

export type BlockedOperationRecord = {
  operationId: string;
  proposalId: string;
  findingId: string;
  state: "blocked-insufficient-evidence";
  authority: JournalAuthority;
  source: JournalSource;
  proposedAction: string;
  evidence: string[];
  blockedReason: string;
  missingRequirements: Array<
    | "exact-target-path"
    | "operation-type"
    | "exact-field-value-or-patch"
    | "evidence-supporting-value"
    | "preconditions"
    | "expected-post-state"
    | "rollback-instructions"
    | "validator-acceptance-criteria"
  >;
};

export type OperationJournal = {
  schemaVersion: "operation-journal.v1";
  generatedAt: string;
  authority: JournalAuthority;
  source: {
    reviewInboxSchemaVersion: ReviewInbox["schemaVersion"];
    reviewInboxGeneratedAt: string;
    proposalCount: number;
  };
  counts: {
    pendingApply: number;
    blockedInsufficientEvidence: number;
    skippedNotApproved: number;
    total: number;
  };
  entries: OperationJournalEntry[];
  blocked: BlockedOperationRecord[];
};

export async function buildOperationJournalFromInboxPath(inboxPath: string): Promise<OperationJournal> {
  const inbox = await loadReviewInbox(inboxPath);
  return buildOperationJournal(inbox);
}

export function buildOperationJournal(inbox: ReviewInbox): OperationJournal {
  const actionReviewed = inbox.proposals.filter((proposal) => proposal.state === "approved" || proposal.state === "deferred");
  const evaluated = actionReviewed.map((proposal) => evaluateReviewedProposal(inbox, proposal));
  const entries = evaluated.filter((record): record is OperationJournalEntry => record.state === "pending-apply");
  const blocked = evaluated.filter((record): record is BlockedOperationRecord => record.state === "blocked-insufficient-evidence");
  return {
    schemaVersion: "operation-journal.v1",
    generatedAt: new Date().toISOString(),
    authority: journalAuthority(),
    source: {
      reviewInboxSchemaVersion: inbox.schemaVersion,
      reviewInboxGeneratedAt: inbox.generatedAt,
      proposalCount: inbox.proposals.length
    },
    counts: {
      pendingApply: entries.length,
      blockedInsufficientEvidence: blocked.length,
      skippedNotApproved: inbox.proposals.length - actionReviewed.length,
      total: entries.length
    },
    entries,
    blocked
  };
}

function evaluateReviewedProposal(inbox: ReviewInbox, proposal: ReviewProposal): OperationJournalEntry | BlockedOperationRecord {
  if (proposal.state === "deferred") {
    return blockedRecord(inbox, proposal);
  }
  const executablePlan = parseExecutablePlan(proposal);
  if (!executablePlan) {
    return blockedRecord(inbox, proposal);
  }
  return journalEntry(inbox, proposal, executablePlan);
}

function journalEntry(inbox: ReviewInbox, proposal: ReviewProposal, executablePlan: OperationJournalEntry["executablePlan"]): OperationJournalEntry {
  return {
    operationId: operationIdForProposal(proposal.proposalId),
    proposalId: proposal.proposalId,
    findingId: proposal.findingId,
    state: "pending-apply",
    authority: journalAuthority(),
    source: journalSource(inbox, proposal),
    proposedAction: proposal.proposedAction,
    evidence: proposal.evidence,
    applyRequirement: "A guarded APPLY specialist or deterministic service must execute exactly the approved operation and record its result separately.",
    validationRequirement: "Independent Validator must reinspect the result before the finding can be closed.",
    executablePlan
  };
}

function blockedRecord(inbox: ReviewInbox, proposal: ReviewProposal): BlockedOperationRecord {
  return {
    operationId: operationIdForProposal(proposal.proposalId),
    proposalId: proposal.proposalId,
    findingId: proposal.findingId,
    state: "blocked-insufficient-evidence",
    authority: journalAuthority(),
    source: journalSource(inbox, proposal),
    proposedAction: proposal.proposedAction,
    evidence: proposal.evidence,
    blockedReason: proposal.state === "deferred"
      ? "Deferred proposal is blocked from APPLY until sufficient evidence and an explicit approval are recorded."
      : "Approved proposal does not contain a deterministic mutation plan. Approval alone is not sufficient for APPLY.",
    missingRequirements: [
      "exact-target-path",
      "operation-type",
      "exact-field-value-or-patch",
      "evidence-supporting-value",
      "preconditions",
      "expected-post-state",
      "rollback-instructions",
      "validator-acceptance-criteria"
    ]
  };
}

function journalSource(inbox: ReviewInbox, proposal: ReviewProposal): JournalSource {
  return {
    reviewInboxGeneratedAt: inbox.generatedAt,
    sourcePath: proposal.source.sourcePath,
    findingSeverity: proposal.source.findingSeverity,
    findingCategory: proposal.source.findingCategory
  };
}

function parseExecutablePlan(proposal: ReviewProposal): OperationJournalEntry["executablePlan"] | null {
  const plan = extractJsonPlan(proposal.proposedAction);
  if (!plan) {
    return null;
  }
  if (
    typeof plan.targetPath !== "string" ||
    plan.targetPath !== proposal.source.sourcePath ||
    typeof plan.operationType !== "string" ||
    typeof plan.exactPatch !== "string" ||
    !nonEmptyStringArray(plan.preconditions) ||
    !nonEmptyStringArray(plan.expectedPostState) ||
    !nonEmptyStringArray(plan.rollbackInstructions) ||
    !nonEmptyStringArray(plan.validatorAcceptanceCriteria) ||
    !planReferencesEvidence(plan, proposal.evidence)
  ) {
    return null;
  }
  return {
    targetPath: plan.targetPath,
    operationType: plan.operationType,
    exactPatch: plan.exactPatch,
    preconditions: plan.preconditions,
    expectedPostState: plan.expectedPostState,
    rollbackInstructions: plan.rollbackInstructions,
    validatorAcceptanceCriteria: plan.validatorAcceptanceCriteria
  };
}

function extractJsonPlan(proposedAction: string): Record<string, unknown> | null {
  const marker = "EXECUTABLE_APPLY_PLAN:";
  const markerIndex = proposedAction.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const jsonText = proposedAction.slice(markerIndex + marker.length).trim();
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function planReferencesEvidence(plan: Record<string, unknown>, evidence: string[]): boolean {
  const serializedPlan = JSON.stringify(plan);
  return evidence.some((line) => serializedPlan.includes(line) || line.includes(String(plan.targetPath ?? "")));
}

function operationIdForProposal(proposalId: string): string {
  return `operation:${proposalId.replace(/^proposal:/, "")}`;
}

function journalAuthority(): JournalAuthority {
  return {
    system: "AIBRY Catalog OS",
    specialist: "Operation Journal",
    authorityMode: "HANDOFF",
    operationalStandard: "ASOS v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}

async function loadReviewInbox(inboxPath: string): Promise<ReviewInbox> {
  const parsed = JSON.parse(await readFile(inboxPath, "utf8")) as unknown;
  assertReviewInbox(parsed, inboxPath);
  return parsed;
}

function assertReviewInbox(value: unknown, inboxPath: string): asserts value is ReviewInbox {
  if (!isRecord(value) || value.schemaVersion !== "review-inbox.v1") {
    throw new Error(`Expected ${inboxPath} to contain a review-inbox.v1 document.`);
  }
  if (!Array.isArray(value.proposals)) {
    throw new Error(`Review inbox ${inboxPath} is missing proposals.`);
  }
  if (!isRecord(value.authority) || value.authority.vaultMutation !== "none") {
    throw new Error(`Review inbox ${inboxPath} does not declare the required non-mutating authority boundary.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
