import { readFile } from "node:fs/promises";
import type { AuditFinding } from "./catalog/audit.js";
import { loadCatalogIndex } from "./catalog-index-store.js";
import type { CatalogIndex } from "./catalog/publish.js";

export type ReviewDecisionState = "pending" | "approved" | "rejected" | "deferred";

export type ReviewProposal = {
  proposalId: string;
  findingId: string;
  state: ReviewDecisionState;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "Review Inbox";
    authorityMode: "PROPOSE";
    operationalStandard: "ASOS v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  source: {
    indexGeneratedAt: string;
    sourcePath: string;
    findingSeverity: AuditFinding["severity"];
    findingCategory: AuditFinding["category"];
  };
  summary: string;
  evidence: string[];
  proposedAction: string;
  requiredApproval: true;
  applyBoundary: "No vault mutation is allowed from the inbox. Approved proposals must be handed to a guarded APPLY specialist or deterministic service.";
};

export type ReviewInbox = {
  schemaVersion: "review-inbox.v1";
  generatedAt: string;
  authority: ReviewProposal["authority"];
  source: {
    indexSchemaVersion: CatalogIndex["schemaVersion"];
    indexGeneratedAt: string;
    managedSongContractVersion: string;
  };
  counts: {
    pending: number;
    approved: number;
    rejected: number;
    deferred: number;
    total: number;
  };
  proposals: ReviewProposal[];
};

export async function buildReviewInboxFromIndexPath(indexPath: string, decisionsPath?: string): Promise<ReviewInbox> {
  const index = await loadCatalogIndex(indexPath);
  const decisions = decisionsPath ? await loadReviewDecisions(decisionsPath) : new Map<string, ReviewDecisionState>();
  return buildReviewInbox(index, decisions);
}

export function buildReviewInbox(index: CatalogIndex, decisions = new Map<string, ReviewDecisionState>()): ReviewInbox {
  const proposals = index.findings.map((finding) => reviewProposal(index, finding, decisions.get(proposalIdForFinding(finding.findingId)) ?? "pending"));
  const counts = countStates(proposals);
  return {
    schemaVersion: "review-inbox.v1",
    generatedAt: new Date().toISOString(),
    authority: reviewAuthority(),
    source: {
      indexSchemaVersion: index.schemaVersion,
      indexGeneratedAt: index.generatedAt,
      managedSongContractVersion: index.contract.schemaVersion
    },
    counts: { ...counts, total: proposals.length },
    proposals
  };
}

function reviewProposal(index: CatalogIndex, finding: AuditFinding, state: ReviewDecisionState): ReviewProposal {
  return {
    proposalId: proposalIdForFinding(finding.findingId),
    findingId: finding.findingId,
    state,
    authority: reviewAuthority(),
    source: {
      indexGeneratedAt: index.generatedAt,
      sourcePath: finding.sourcePath,
      findingSeverity: finding.severity,
      findingCategory: finding.category
    },
    summary: finding.summary,
    evidence: finding.evidence,
    proposedAction: finding.recommendedAction,
    requiredApproval: true,
    applyBoundary: "No vault mutation is allowed from the inbox. Approved proposals must be handed to a guarded APPLY specialist or deterministic service."
  };
}

function proposalIdForFinding(findingId: string): string {
  return `proposal:${findingId}`;
}

function reviewAuthority(): ReviewProposal["authority"] {
  return {
    system: "AIBRY Catalog OS",
    specialist: "Review Inbox",
    authorityMode: "PROPOSE",
    operationalStandard: "ASOS v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}

function countStates(proposals: ReviewProposal[]): Omit<ReviewInbox["counts"], "total"> {
  return proposals.reduce<Omit<ReviewInbox["counts"], "total">>((counts, proposal) => {
    counts[proposal.state] += 1;
    return counts;
  }, { pending: 0, approved: 0, rejected: 0, deferred: 0 });
}

async function loadReviewDecisions(decisionsPath: string): Promise<Map<string, ReviewDecisionState>> {
  const parsed = JSON.parse(await readFile(decisionsPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Review decisions file must be a JSON array: ${decisionsPath}`);
  }
  const decisions = new Map<string, ReviewDecisionState>();
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.proposalId !== "string" || !isReviewDecisionState(entry.state)) {
      throw new Error(`Review decisions file contains an invalid decision entry: ${decisionsPath}`);
    }
    decisions.set(entry.proposalId, entry.state);
  }
  return decisions;
}

function isReviewDecisionState(value: unknown): value is ReviewDecisionState {
  return value === "pending" || value === "approved" || value === "rejected" || value === "deferred";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
