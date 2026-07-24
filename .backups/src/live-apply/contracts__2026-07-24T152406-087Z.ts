import type { LyricSourceProposalOperation } from "../lyric-source/contracts.js";
import type { GuardedPackagePolicy } from "./package-verifier.js";

export type GuardedLiveApplyCounts = {
  catalogFindings: number;
  assetFindings: number;
  routedFindings: Record<string, number>;
  pendingApply: 0;
};

export type GuardedArtifactIdentity = {
  role: "proposal" | "decision" | "dry-run-report" | "script" | "handoff";
  contract: string;
  path: string;
  sha256: string;
  byteSize: number;
};

export type GuardedExecutableIdentity = {
  path: string;
  sha256: string;
  version: string;
};

export type GuardedAdapterIdentity = {
  role: "workflow" | "validator";
  path: string;
  sha256: string;
};

export type GuardedLiveApplyPlan = {
  contract: "lyric-source-guarded-live-apply-plan.v1";
  generatedAt: string;
  state: "prepared";
  operatorControlled: true;
  specialistAuthority: "none";
  packagePolicy: GuardedPackagePolicy;
  package: { path: string; artifactSha256: string };
  proposalId: string;
  proposalSha256: string;
  artifacts: GuardedArtifactIdentity[];
  operationPaths: string[];
  expectedBaselineCounts: GuardedLiveApplyCounts;
  expectedPostApplyCounts: GuardedLiveApplyCounts;
  intendedVaultRoot: string;
  intendedRollbackRoot: string;
  intendedResultDirectory: string;
  expectedResultPaths: {
    plan: string;
    snapshot: string;
    preRefresh: string;
    postRefresh: string;
    validator: string;
    applyResult: string;
    launcherReport: string;
    stdoutLog: string;
    stderrLog: string;
    workflowAdapterConfig: string;
    validatorAdapterConfig: string;
    workflowAdapterBootstrap: string;
    validatorAdapterBootstrap: string;
    recoveryRefresh: string;
    recoveryVerification: string;
  };
  powerShell: GuardedExecutableIdentity;
  node: GuardedExecutableIdentity;
  adapters: GuardedAdapterIdentity[];
  canonicalHashPayload: string;
  planSha256: string;
  safety: {
    applyExecuted: false;
    vaultMutation: "none";
    interactiveAuthorizationRequired: true;
    browserApplyAvailable: false;
  };
};

export type GuardedLiveApplyLaunchStatus =
  | "applied-and-validated"
  | "refused-before-write"
  | "failed-before-write"
  | "failed-rolled-back-and-verified"
  | "failed-rollback-unverified"
  | "interrupted-state-unknown";

export type GuardedLiveApplyLaunchReport = {
  contract: "lyric-source-guarded-live-apply-launch-report.v1";
  generatedAt: string;
  startedAt: string;
  finishedAt: string;
  package: { path: string; sha256: string };
  proposalId: string;
  proposalSha256: string;
  planSha256: string;
  lineage: {
    preSnapshotSha256: string | null;
    preRefreshSha256: string | null;
    postRefreshSha256: string | null;
    validatorSha256: string | null;
    applyResultSha256: string | null;
  };
  rollbackPackage: string | null;
  rollbackManifest: string | null;
  changedPaths: string[];
  operationCount: number;
  expectedCounts: { baseline: GuardedLiveApplyCounts; postApply: GuardedLiveApplyCounts };
  actualCounts: GuardedLiveApplyCounts | null;
  finalStatus: GuardedLiveApplyLaunchStatus;
  applyExecuted: boolean;
  rollbackStatus: "not-required" | "restored-and-verified" | "unverified" | "unknown";
  processExitCode: number | null;
  interruption: { signal: string | null; childDispositionKnown: boolean };
  safety: { browserApplyAvailable: false; automaticRetryAttempted: false; launcherVaultWrites: "snapshot-read-only" };
};

export type GuardedPackageVerification = {
  manifestPath: string;
  manifestSha256: string;
  proposalId: string;
  proposalSha256: string;
  artifacts: GuardedArtifactIdentity[];
  operations: LyricSourceProposalOperation[];
  evidencePaths: string[];
  guardPaths: string[];
  expectedBaselineCounts: GuardedLiveApplyCounts;
  expectedPostApplyCounts: GuardedLiveApplyCounts;
};

export type RefreshAdapterConfig = {
  contract: "lyric-source-live-refresh-adapter-config.v1";
  vaultRoot: string;
  proposalPath: string;
  preOutputPath: string;
  postOutputPath: string;
};

export type ValidatorAdapterConfig = {
  contract: "lyric-source-live-validator-adapter-config.v1";
  vaultRoot: string;
  proposalPath: string;
  snapshotPath: string;
  postWorkflowReportPath: string;
  outputPath: string;
};
