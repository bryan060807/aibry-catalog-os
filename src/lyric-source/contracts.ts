import type { AuthorityTransitionDecision, SpecialistRefusal } from "../specialists/contracts.js";

export type LyricFileState = {
  path: string;
  byteSize: number;
  sha256: string;
  contentBase64: string;
};

export type LyricCandidateEvidence = LyricFileState & {
  accepted: boolean;
  exactNameMatch: boolean;
};

export type LyricSourcePlanningProject = {
  projectPath: string;
  include: boolean;
  exclusionReason: string | null;
  source: LyricFileState | null;
  managed: LyricFileState | null;
  candidates: LyricCandidateEvidence[];
  controlFile: {
    path: string;
    currentByteSize: number;
    currentSha256: string;
    currentContentBase64: string;
    proposedContent: string;
  } | null;
};

export type LyricControlFileInput = {
  path: string;
  currentByteSize: number;
  currentSha256: string;
  currentContentBase64: string;
  proposedContent: string;
};

export type LyricSourcePlanningInput = {
  contract: "lyric-source-planning-input.v1";
  generatedAt: string;
  selectedBatch: { batchId: string; name: string; projectPaths: string[] };
  projects: LyricSourcePlanningProject[];
  albumControlFiles: LyricControlFileInput[];
  currentCatalogIndex: { contract: string; sha256: string; counts: Record<string, number> };
  assetInspectorEvidence: { contract: string; sha256: string; counts: Record<string, number> };
  lyricSourceResolverEvidence: { contract: string; sha256: string; projectPaths: string[] };
  baselineCounts: {
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  };
  expectedCounts: {
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  };
  guardFiles: LyricFileState[];
  preconditions: string[];
  rollbackRequirements: string[];
  independentValidatorCriteria: string[];
};

export type LyricSourceBatchScoutCandidate = {
  projectPath: string;
  albumSlug: string;
  trackNumber: number | null;
  titleOrProjectSlug: string;
  legacySourcePath: string | null;
  managedCopyPath: string | null;
  sourceByteSize: number | null;
  managedByteSize: number | null;
  sourceSha256: string | null;
  managedSha256: string | null;
  exactNameMatch: boolean;
  sourceExists: boolean;
  managedExists: boolean;
  competingCandidateCount: number;
  currentDesignationState: "none" | "unresolved-contract" | "human-approved" | "conflicting";
  currentManifestMappingState: "none" | "matching" | "conflicting" | "duplicate" | "invalid";
  currentProjectControlHash: string | null;
  catalogFindingCount: number;
  assetFindingCount: number;
  blockingRouteCount: number;
  eligibilityState: "eligible" | "excluded";
  exclusionReason: string | null;
};

export type LyricSourceBatchScoutReport = {
  contract: "lyric-source-batch-scout-report.v1";
  generatedAt: string;
  specialist: { id: "lyric-source-batch-scout"; version: string };
  authority: "OBSERVE";
  vaultRead: true;
  vaultMutation: "none";
  refreshReport: { path: string; byteSize: number; sha256: string };
  refreshRunId: string;
  baselineCounts: {
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  };
  expectedCounts: {
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  } | null;
  perProjectFindingRemovals: Array<{
    projectPath: string;
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  }>;
  inspectedReleaseContainers: Array<{
    albumSlug: string;
    projectCount: number;
    eligiblePrefixCount: number;
    excludedCount: number;
    defaultExcluded: boolean;
  }>;
  candidateProjects: LyricSourceBatchScoutCandidate[];
  excludedProjects: Array<{ projectPath: string; reason: string }>;
  selectedReleaseContainer: string | null;
  selectedIncludedProjects: string[];
  naturalBatchBoundary: string | null;
  expectedOperationCount: number;
  planningInputPath: string | null;
  planningInputSha256: string | null;
  evidenceRehashStatus: "passed" | "failed" | "not-run";
  refusal: SpecialistRefusal | null;
  safety: {
    applyEnabled: false;
    approvalCreated: false;
    applyScriptCreated: false;
    vaultMutation: "none";
  };
};

export type LyricSourceEvidenceRow = {
  projectPath: string;
  sourcePath: string;
  managedPath: string;
  byteSize: number;
  sha256: string;
  verificationMethod: "sha256-byte-match";
  verificationState: "verified";
};

export type LyricSourceProposalOperation = {
  order: number;
  operationType: "replace-control-file";
  path: string;
  currentByteCount: number;
  currentSha256: string;
  proposedByteCount: number;
  proposedSha256: string;
  contentBase64: string;
};

export type LyricSourceDesignationProposal = {
  contract: "lyric-source-designation-proposal.v1";
  proposalId: string;
  proposalSha256: string;
  generatedAt: string;
  authority: "PROPOSE";
  approvalState: "pending";
  applyEnabled: false;
  vaultMutation: "none";
  selectedBatch: LyricSourcePlanningInput["selectedBatch"];
  includedProjects: string[];
  excludedProjects: Array<{ projectPath: string; reason: string }>;
  evidenceArtifacts: Array<{ contract: string; sha256: string }>;
  evidence: LyricSourceEvidenceRow[];
  operations: LyricSourceProposalOperation[];
  guardFiles: Array<{ path: string; byteSize: number; sha256: string }>;
  preconditions: string[];
  rollbackRequirements: string[];
  independentValidatorCriteria: string[];
  expectedFindingDeltas: {
    catalogFindings: number;
    assetFindings: number;
    routedFindings: Record<string, number>;
  };
  expectedCounts: LyricSourcePlanningInput["expectedCounts"];
  resolverExpectedProjects: string[];
  humanAuthorizationBoundary: string;
  canonicalHashPayload: string;
};

export type LyricSourceReviewDecision = AuthorityTransitionDecision & {
  contract: "asos-authority-decision.v1";
};

export type LyricSourceDryRunReport = {
  contract: "lyric-source-apply-dry-run-report.v1";
  generatedAt: string;
  powerShellVersion: string;
  proposalIdentity: { proposalId: string; proposalSha256: string; artifactSha256: string };
  scriptIdentity: { contract: "lyric-source-windows-apply-script.v1"; scriptSha256: string };
  parsedCollectionCounts: { operations: number; evidence: number; guards: number };
  normalizedPathChecks: Array<{ path: string; normalized: string; passed: boolean }>;
  rollbackChecks: { targetCount: number; originalsRehashed: boolean; pathsInsideRollbackRoot: boolean };
  reportChecks: { preReportLoadedFromDisk: boolean; postReportLoadedFromDisk: boolean; sameLoader: boolean; wrappedObjectsNormalized: boolean };
  resolverLookupChecks: { expected: number; foundExactlyOnce: number };
  expectedDeltas: LyricSourceDesignationProposal["expectedFindingDeltas"];
  forcedFailureRollback: { attempted: boolean; restoredAllTargets: boolean };
  independentValidation: { ranFromPersistedArtifacts: boolean; status: "passed" | "failed" };
  unrelatedFileDiffDetected: boolean;
  scenarios?: Array<{ name: string; expected: "passed" | "failed"; observed: "passed" | "failed"; restoredAllTargets: boolean; resultContract: string | null }>;
  liveVaultAccess: false;
  mutationTarget: "temporary-mirror-only";
  status: "passed" | "failed";
  failures: string[];
};

export type LyricSourceApplyHandoff = {
  contract: "lyric-source-apply-handoff.v1";
  proposalId: string;
  proposalSha256: string;
  proposalArtifactSha256: string;
  decisionArtifactSha256: string;
  scriptSha256: string;
  dryRunReportSha256: string;
  state: "eligible-for-guarded-apply";
  applyExecuted: false;
  operations: LyricSourceProposalOperation[];
  rollbackRequirements: string[];
  independentValidatorCriteria: string[];
};

export type LyricSourceCompatibilityFixtureFileRole =
  | "operation-current"
  | "evidence-source"
  | "evidence-managed"
  | "guard"
  | "fixture-marker";

export type LyricSourceCompatibilityFixtureManifest = {
  contract: "lyric-source-compatibility-fixture-manifest.v1";
  generatedAt: string;
  specialist: { id: "lyric-source-compatibility-fixture-builder"; version: string };
  authority: "OBSERVE";
  fixtureRoot: string;
  fixtureMarker: { path: ".asos-fixture-vault"; byteSize: number; sha256: string };
  scoutReport: { path: string; sha256: string };
  planningInput: { path: string; sha256: string };
  proposal: { path: string; proposalId: string; proposalSha256: string; artifactSha256: string };
  decision: {
    path: string;
    proposalId: string;
    proposalSha256: string;
    decisionState: "approved";
    decisionArtifactSha256: string;
    artifactSha256: string;
  };
  materializedFiles: Array<{
    path: string;
    role: LyricSourceCompatibilityFixtureFileRole;
    byteSize: number;
    sha256: string;
    sourceArtifact: "lyric-source-planning-input.v1" | "fixture-builder";
  }>;
  operationTargets: string[];
  evidenceFiles: string[];
  guardFiles: string[];
  duplicatePathChecks: {
    inputPathCount: number;
    uniquePathCount: number;
    identicalDuplicatesDeduplicated: number;
    contradictoryDuplicates: 0;
    caseCollisions: 0;
    passed: true;
  };
  decodedPayloadChecks: { checkedPayloadCount: number; passed: true };
  proposalRecompileCheck: { proposalId: string; proposalSha256: string; passed: true };
  fixtureSnapshotSha256: string;
  safety: {
    liveVaultAccess: false;
    liveVaultMutation: "none";
    fixtureMutationOnly: true;
    applyExecuted: false;
  };
};

export type LyricSourceOperatorPackage = {
  contract: "lyric-source-operator-package.v1";
  proposalId: string;
  proposalSha256: string;
  artifacts: Array<{ role: "proposal" | "decision" | "dry-run-report" | "script" | "handoff"; contract: string; canonicalPath: string; sha256: string; byteSize: number }>;
  executionCommands: [string];
  safety: { liveApplyExecuted: false; governanceVerified: true; artifactsOutsideVaultRequired: true };
};

export type LyricSourceIndependentValidationReport = {
  contract: "lyric-source-independent-validation-report.v1";
  generatedAt: string;
  proposalId: string;
  proposalSha256: string;
  authority: "OBSERVE";
  persistedArtifactsOnly: true;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  counts: { passed: number; failed: number; total: number };
  status: "passed" | "failed";
  refusal: SpecialistRefusal | null;
  safety: { applyEnabled: false; vaultMutation: "none"; pendingApply: 0 };
};

export type AsosLyricWorkflowRun = {
  contract: "asos-workflow-run.v1";
  workflow: "scout-lyric-source-batch" | "plan-lyric-source-migration" | "materialize-lyric-source-compatibility-fixture" | "build-windows-lyric-source-apply" | "dry-run-lyric-source-apply" | "validate-lyric-source-apply";
  runId: string;
  generatedAt: string;
  specialist: { id: string; version: string; authorityMode: string };
  orderedSteps: Array<{ order: number; name: string; status: "completed" | "refused" }>;
  inputArtifacts: Array<{ contract: string; path: string; sha256: string }>;
  outputArtifacts: Array<{ contract: string; path: string; sha256: string }>;
  evidenceLineage: Array<{ contract: string; sha256: string }>;
  decisionBinding: { proposalId: string; proposalSha256: string; decisionArtifactSha256: string } | null;
  refusal: SpecialistRefusal | null;
  safety: { applyEnabled: false; vaultMutation: "none" };
  runtimeRequirements: string[];
};
