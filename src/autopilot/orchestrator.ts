import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalFilename } from "../artifacts/handoff-specialist.js";
import { runReadOnlyRefreshWorkflow } from "../asos-workflow.js";
import { sha256Bytes } from "../kernel/canonical-json.js";
import { assertOutputOutsideRoot, assertPathHasNoLinkedSegments } from "../kernel/contract-path.js";
import { buildReviewDecision, verifyReviewDecision } from "../lyric-source/approval.js";
import type { LyricSourceBatchScoutReport, LyricSourceCompatibilityFixtureManifest, LyricSourceDesignationProposal, LyricSourceOperatorPackage } from "../lyric-source/contracts.js";
import { parseAndVerifyLyricSourceProposal } from "../lyric-source/proposal-specialist.js";
import {
  buildWindowsLyricSourceApplyWorkflow,
  materializeLyricSourceCompatibilityFixtureWorkflow,
  planLyricSourceMigrationWorkflow,
  scoutLyricSourceBatchWorkflow
} from "../lyric-source/workflows.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import type { GuardedLiveApplyPlan } from "../live-apply/contracts.js";
import { loadAndVerifyGuardedPlan, prepareGuardedLiveApply } from "../live-apply/prepare.js";
import { assertSafeExistingDirectory } from "../live-apply/path-policy.js";

const CHECKPOINT_FILENAME = "catalog-autopilot-run.v1.json";
const STAGE_NAMES = ["refresh", "scout", "proposal", "approval", "fixture", "build", "plan"] as const;

type AutopilotStageName = (typeof STAGE_NAMES)[number];
type AutopilotStageStatus = "pending" | "completed" | "blocked";

export type AutopilotArtifact = {
  contract: string;
  path: string;
  sha256: string;
};

export type AutopilotStage = {
  name: AutopilotStageName;
  status: AutopilotStageStatus;
  completedAt: string | null;
  artifacts: AutopilotArtifact[];
};

export type CatalogAutopilotCheckpoint = {
  contract: "catalog-autopilot-run.v1";
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | "awaiting-approval" | "refused" | "ready-for-live-apply" | "failed";
  vaultRoot: string;
  workspaceRoot: string;
  runDirectory: string;
  selection: {
    minTracks: number;
    maxTracks: number;
    excludedReleases: string[];
  };
  proposalBinding: {
    proposalId: string;
    proposalSha256: string;
    artifactSha256: string;
  } | null;
  decisionBinding: {
    decisionArtifactSha256: string;
    artifactSha256: string;
  } | null;
  planBinding: {
    planSha256: string;
    artifactSha256: string;
  } | null;
  refusal: LyricSourceBatchScoutReport["refusal"];
  lastError: string | null;
  stages: AutopilotStage[];
  safety: {
    liveApplyExecuted: false;
    vaultMutation: "none";
    approvalRequired: true;
    interactiveLiveAuthorizationRequired: true;
  };
};

export type PrepareCatalogAutopilotOptions = {
  vaultRoot: string;
  workspaceRoot: string;
  runId?: string;
  minTracks?: number;
  maxTracks?: number;
  excludedReleases?: string[];
};

export type ApproveCatalogAutopilotOptions = {
  runDirectory: string;
  proposalSha256: string;
  decisionTimestamp?: string;
};

export type AutopilotDependencies = {
  runRefresh: typeof runReadOnlyRefreshWorkflow;
  runScout: typeof scoutLyricSourceBatchWorkflow;
  runProposal: typeof planLyricSourceMigrationWorkflow;
  runFixture: typeof materializeLyricSourceCompatibilityFixtureWorkflow;
  runBuild: typeof buildWindowsLyricSourceApplyWorkflow;
  runPreparePlan: typeof prepareGuardedLiveApply;
};

const DEFAULT_DEPENDENCIES: AutopilotDependencies = {
  runRefresh: runReadOnlyRefreshWorkflow,
  runScout: scoutLyricSourceBatchWorkflow,
  runProposal: planLyricSourceMigrationWorkflow,
  runFixture: materializeLyricSourceCompatibilityFixtureWorkflow,
  runBuild: buildWindowsLyricSourceApplyWorkflow,
  runPreparePlan: prepareGuardedLiveApply
};

export async function prepareCatalogAutopilot(
  options: PrepareCatalogAutopilotOptions,
  dependencies: AutopilotDependencies = DEFAULT_DEPENDENCIES
): Promise<CatalogAutopilotCheckpoint> {
  const vaultRoot = await assertSafeExistingDirectory(options.vaultRoot, "Autopilot Vault root");
  const workspaceRoot = path.resolve(options.workspaceRoot);
  await assertOutputOutsideRoot(vaultRoot, workspaceRoot);
  await assertPathHasNoLinkedSegments(workspaceRoot, true);
  await mkdir(workspaceRoot, { recursive: true });

  const runId = normalizeRunId(options.runId ?? defaultRunId());
  const runDirectory = path.join(workspaceRoot, runId);
  const checkpointPath = path.join(runDirectory, CHECKPOINT_FILENAME);
  let checkpoint: CatalogAutopilotCheckpoint;
  if (await exists(checkpointPath)) {
    checkpoint = await loadCatalogAutopilotCheckpoint(runDirectory);
    assertSamePreparationRequest(checkpoint, vaultRoot, workspaceRoot, options);
    if (checkpoint.state === "ready-for-live-apply" || checkpoint.state === "awaiting-approval" || checkpoint.state === "refused") {
      await verifyCompletedStages(checkpoint);
      return checkpoint;
    }
  } else {
    if (await exists(runDirectory)) throw new Error(`Autopilot run directory exists without a checkpoint: ${runDirectory}`);
    await mkdir(runDirectory, { recursive: false });
    checkpoint = newCheckpoint(runId, vaultRoot, workspaceRoot, runDirectory, options);
    await persistCheckpoint(checkpoint);
  }

  checkpoint.state = "running";
  checkpoint.lastError = null;
  await persistCheckpoint(checkpoint);
  try {
    const refreshDirectory = path.join(runDirectory, "01-refresh");
    const refreshPath = path.join(refreshDirectory, "read-only-refresh.json");
    if (!isStageComplete(checkpoint, "refresh")) {
      await resetIncompleteStageDirectory(refreshDirectory);
      await dependencies.runRefresh(vaultRoot, refreshPath);
      await completeStage(checkpoint, "refresh", [await artifact(refreshPath, "asos-workflow-read-only-refresh.v1.1")]);
    } else {
      await verifyStage(checkpoint, "refresh");
    }

    const scoutDirectory = path.join(runDirectory, "02-scout");
    let scoutReport: LyricSourceBatchScoutReport;
    if (!isStageComplete(checkpoint, "scout")) {
      await resetIncompleteStageDirectory(scoutDirectory);
      const scout = await dependencies.runScout({
        vaultRoot,
        refreshReportPath: refreshPath,
        outputDirectory: scoutDirectory,
        minTracks: checkpoint.selection.minTracks,
        maxTracks: checkpoint.selection.maxTracks,
        excludedReleases: checkpoint.selection.excludedReleases
      });
      scoutReport = scout.report;
      const scoutArtifacts = [
        await artifact(scout.reportPath, scout.report.contract),
        await artifact(scout.workflowPath, scout.workflow.contract),
        ...(scout.planningInputPath ? [await artifact(scout.planningInputPath, "lyric-source-planning-input.v1")] : [])
      ];
      await completeStage(checkpoint, "scout", scoutArtifacts);
      if (scout.report.refusal || !scout.planningInputPath) {
        checkpoint.state = "refused";
        checkpoint.refusal = scout.report.refusal;
        stage(checkpoint, "proposal").status = "blocked";
        await persistCheckpoint(checkpoint);
        return checkpoint;
      }
    } else {
      await verifyStage(checkpoint, "scout");
      scoutReport = parseContract<LyricSourceBatchScoutReport>(await readFile(path.join(scoutDirectory, canonicalFilename("lyric-source-batch-scout-report.v1")), "utf8"), "lyric-source-batch-scout-report.v1");
      if (scoutReport.refusal) {
        checkpoint.state = "refused";
        checkpoint.refusal = scoutReport.refusal;
        await persistCheckpoint(checkpoint);
        return checkpoint;
      }
    }

    const planningInputPath = path.join(scoutDirectory, canonicalFilename("lyric-source-planning-input.v1"));
    const proposalDirectory = path.join(runDirectory, "03-proposal");
    const proposalPath = path.join(proposalDirectory, canonicalFilename("lyric-source-designation-proposal.v1"));
    let proposal: LyricSourceDesignationProposal;
    if (!isStageComplete(checkpoint, "proposal")) {
      await resetIncompleteStageDirectory(proposalDirectory);
      await mkdir(proposalDirectory, { recursive: true });
      proposal = await dependencies.runProposal(planningInputPath, proposalPath);
      const proposalArtifact = await artifact(proposalPath, proposal.contract);
      await completeStage(checkpoint, "proposal", [
        proposalArtifact,
        await artifact(`${proposalPath}.review-inbox.json`, "lyric-source-review-proposal.v1"),
        await artifact(`${proposalPath}.workflow.json`, "asos-workflow-run.v1")
      ]);
      checkpoint.proposalBinding = {
        proposalId: proposal.proposalId,
        proposalSha256: proposal.proposalSha256,
        artifactSha256: proposalArtifact.sha256
      };
    } else {
      await verifyStage(checkpoint, "proposal");
      proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
      assertProposalBinding(checkpoint, proposal, sha256Bytes(await readFile(proposalPath)));
    }

    checkpoint.state = "awaiting-approval";
    checkpoint.refusal = null;
    await persistCheckpoint(checkpoint);
    return checkpoint;
  } catch (error: unknown) {
    checkpoint.state = "failed";
    checkpoint.lastError = boundedError(error);
    await persistCheckpoint(checkpoint);
    throw error;
  }
}

export async function approveCatalogAutopilot(
  options: ApproveCatalogAutopilotOptions,
  dependencies: AutopilotDependencies = DEFAULT_DEPENDENCIES
): Promise<CatalogAutopilotCheckpoint> {
  const checkpoint = await loadCatalogAutopilotCheckpoint(options.runDirectory);
  if (checkpoint.state === "refused") throw new Error("A refused Autopilot run cannot be approved.");
  await verifyCompletedStages(checkpoint);
  const proposalPath = artifactPath(checkpoint, "proposal", "lyric-source-designation-proposal.v1");
  const proposalBytes = await readFile(proposalPath);
  const proposal = parseAndVerifyLyricSourceProposal(proposalBytes.toString("utf8"), proposalPath);
  assertProposalBinding(checkpoint, proposal, sha256Bytes(proposalBytes));
  if (!/^[a-f0-9]{64}$/.test(options.proposalSha256) || options.proposalSha256 !== proposal.proposalSha256) {
    throw new Error("Approval requires the exact lowercase proposal SHA-256 from the checkpoint.");
  }

  checkpoint.state = "running";
  checkpoint.lastError = null;
  await persistCheckpoint(checkpoint);
  try {
    const approvalDirectory = path.join(checkpoint.runDirectory, "04-approval");
    const decisionPath = path.join(approvalDirectory, canonicalFilename("asos-authority-decision.v1"));
    if (!isStageComplete(checkpoint, "approval")) {
      await resetIncompleteStageDirectory(approvalDirectory);
      await mkdir(approvalDirectory, { recursive: true });
      const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", options.decisionTimestamp ?? new Date().toISOString());
      await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const reopened = parseContract<AuthorityTransitionDecision>(await readFile(decisionPath, "utf8"), "asos-authority-decision.v1");
      if (!verifyReviewDecision(reopened) || reopened.decisionState !== "approved") throw new Error("Persisted Autopilot decision failed verification.");
      const decisionArtifact = await artifact(decisionPath, reopened.contract);
      await completeStage(checkpoint, "approval", [decisionArtifact]);
      checkpoint.decisionBinding = {
        decisionArtifactSha256: reopened.decisionArtifactSha256,
        artifactSha256: decisionArtifact.sha256
      };
    } else {
      await verifyStage(checkpoint, "approval");
      const decision = parseContract<AuthorityTransitionDecision>(await readFile(decisionPath, "utf8"), "asos-authority-decision.v1");
      if (!verifyReviewDecision(decision) || decision.decisionState !== "approved" || decision.proposalId !== proposal.proposalId || decision.proposalSha256 !== proposal.proposalSha256) {
        throw new Error("Existing Autopilot approval no longer approves the exact proposal.");
      }
    }

    const scoutReportPath = artifactPath(checkpoint, "scout", "lyric-source-batch-scout-report.v1");
    const planningInputPath = artifactPath(checkpoint, "scout", "lyric-source-planning-input.v1");
    const fixtureDirectory = path.join(checkpoint.runDirectory, "05-fixture");
    let fixtureManifest: LyricSourceCompatibilityFixtureManifest;
    if (!isStageComplete(checkpoint, "fixture")) {
      await resetIncompleteStageDirectory(fixtureDirectory);
      const fixture = await dependencies.runFixture({
        scoutReportPath,
        planningInputPath,
        proposalPath,
        decisionPath,
        outputDirectory: fixtureDirectory,
        reportsRoot: checkpoint.workspaceRoot
      });
      fixtureManifest = fixture.manifest;
      await completeStage(checkpoint, "fixture", [
        await artifact(fixture.manifestPath, fixture.manifest.contract),
        await artifact(fixture.workflowPath, fixture.workflow.contract)
      ]);
    } else {
      await verifyStage(checkpoint, "fixture");
      fixtureManifest = parseContract<LyricSourceCompatibilityFixtureManifest>(await readFile(artifactPath(checkpoint, "fixture", "lyric-source-compatibility-fixture-manifest.v1"), "utf8"), "lyric-source-compatibility-fixture-manifest.v1");
    }

    const buildDirectory = path.join(checkpoint.runDirectory, "06-build");
    const dryRunPath = path.join(buildDirectory, canonicalFilename("lyric-source-apply-dry-run-report.v1"));
    const scriptPath = path.join(buildDirectory, canonicalFilename("lyric-source-windows-apply-script.v1"));
    const packagePath = path.join(`${scriptPath}.operator-package`, canonicalFilename("lyric-source-operator-package.v1"));
    if (!isStageComplete(checkpoint, "build")) {
      await resetIncompleteStageDirectory(buildDirectory);
      await mkdir(buildDirectory, { recursive: true });
      await dependencies.runBuild(proposalPath, decisionPath, fixtureManifest.fixtureRoot, dryRunPath, scriptPath);
      const operatorPackage = parseContract<LyricSourceOperatorPackage>(await readFile(packagePath, "utf8"), "lyric-source-operator-package.v1");
      if (operatorPackage.proposalId !== proposal.proposalId || operatorPackage.proposalSha256 !== proposal.proposalSha256) throw new Error("Built operator package does not match the approved proposal.");
      await completeStage(checkpoint, "build", [
        await artifact(dryRunPath, "lyric-source-apply-dry-run-report.v1"),
        await artifact(scriptPath, "lyric-source-windows-apply-script.v1"),
        await artifact(packagePath, operatorPackage.contract)
      ]);
    } else {
      await verifyStage(checkpoint, "build");
    }

    const planDirectory = path.join(checkpoint.runDirectory, "07-plan");
    const planPath = path.join(planDirectory, canonicalFilename("lyric-source-guarded-live-apply-plan.v1"));
    let plan: GuardedLiveApplyPlan;
    if (!isStageComplete(checkpoint, "plan")) {
      await resetIncompleteStageDirectory(planDirectory);
      await mkdir(planDirectory, { recursive: true });
      plan = await dependencies.runPreparePlan({
        packageManifest: packagePath,
        vaultRoot: checkpoint.vaultRoot,
        rollbackRoot: path.join(checkpoint.runDirectory, "08-live-rollback"),
        resultDirectory: path.join(checkpoint.runDirectory, "09-live-results"),
        outputPath: planPath,
        packagePolicy: "bounded-lyric-source-batch"
      });
      const planArtifact = await artifact(planPath, plan.contract);
      await completeStage(checkpoint, "plan", [planArtifact]);
      checkpoint.planBinding = { planSha256: plan.planSha256, artifactSha256: planArtifact.sha256 };
    } else {
      await verifyStage(checkpoint, "plan");
      const loaded = await loadAndVerifyGuardedPlan(planPath, checkpoint.planBinding?.planSha256);
      plan = loaded.plan;
      if (!checkpoint.planBinding || checkpoint.planBinding.artifactSha256 !== loaded.artifactSha256) throw new Error("Autopilot plan binding no longer matches the persisted plan.");
    }

    checkpoint.state = "ready-for-live-apply";
    checkpoint.lastError = null;
    await persistCheckpoint(checkpoint);
    return checkpoint;
  } catch (error: unknown) {
    checkpoint.state = "failed";
    checkpoint.lastError = boundedError(error);
    await persistCheckpoint(checkpoint);
    throw error;
  }
}

export async function loadCatalogAutopilotCheckpoint(runDirectoryInput: string): Promise<CatalogAutopilotCheckpoint> {
  const runDirectory = path.resolve(runDirectoryInput);
  const checkpointPath = path.join(runDirectory, CHECKPOINT_FILENAME);
  const checkpoint = parseContract<CatalogAutopilotCheckpoint>(await readFile(checkpointPath, "utf8"), "catalog-autopilot-run.v1");
  if (path.resolve(checkpoint.runDirectory) !== runDirectory) throw new Error("Autopilot checkpoint run-directory binding is invalid.");
  if (!STAGE_NAMES.every((name) => checkpoint.stages.some((item) => item.name === name))) throw new Error("Autopilot checkpoint stage set is incomplete.");
  if (checkpoint.safety.liveApplyExecuted !== false || checkpoint.safety.vaultMutation !== "none") throw new Error("Autopilot checkpoint safety state is invalid.");
  return checkpoint;
}

export function catalogAutopilotCheckpointPath(runDirectory: string): string {
  return path.join(path.resolve(runDirectory), CHECKPOINT_FILENAME);
}

function newCheckpoint(runId: string, vaultRoot: string, workspaceRoot: string, runDirectory: string, options: PrepareCatalogAutopilotOptions): CatalogAutopilotCheckpoint {
  const now = new Date().toISOString();
  const minTracks = options.minTracks ?? 2;
  const maxTracks = options.maxTracks ?? 4;
  if (!Number.isInteger(minTracks) || !Number.isInteger(maxTracks) || minTracks < 2 || maxTracks > 4 || minTracks > maxTracks) {
    throw new Error("Autopilot track bounds must be integers with 2 <= minTracks <= maxTracks <= 4.");
  }
  return {
    contract: "catalog-autopilot-run.v1",
    runId,
    createdAt: now,
    updatedAt: now,
    state: "running",
    vaultRoot,
    workspaceRoot,
    runDirectory,
    selection: { minTracks, maxTracks, excludedReleases: [...new Set(options.excludedReleases ?? [])].sort() },
    proposalBinding: null,
    decisionBinding: null,
    planBinding: null,
    refusal: null,
    lastError: null,
    stages: STAGE_NAMES.map((name) => ({ name, status: "pending", completedAt: null, artifacts: [] })),
    safety: { liveApplyExecuted: false, vaultMutation: "none", approvalRequired: true, interactiveLiveAuthorizationRequired: true }
  };
}

async function completeStage(checkpoint: CatalogAutopilotCheckpoint, name: AutopilotStageName, artifacts: AutopilotArtifact[]): Promise<void> {
  const item = stage(checkpoint, name);
  item.status = "completed";
  item.completedAt = new Date().toISOString();
  item.artifacts = artifacts;
  await persistCheckpoint(checkpoint);
}

async function verifyCompletedStages(checkpoint: CatalogAutopilotCheckpoint): Promise<void> {
  for (const item of checkpoint.stages.filter((candidate) => candidate.status === "completed")) await verifyStage(checkpoint, item.name);
}

async function verifyStage(checkpoint: CatalogAutopilotCheckpoint, name: AutopilotStageName): Promise<void> {
  const item = stage(checkpoint, name);
  if (item.status !== "completed" || item.artifacts.length === 0) throw new Error(`Autopilot stage ${name} is not complete.`);
  for (const expected of item.artifacts) {
    const bytes = await readFile(expected.path);
    if (sha256Bytes(bytes) !== expected.sha256) throw new Error(`Autopilot stage ${name} artifact changed: ${expected.path}`);
    if (expected.contract.endsWith(".json") || expected.path.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isRecord(parsed) || parsed.contract !== expected.contract) throw new Error(`Autopilot stage ${name} artifact contract changed: ${expected.path}`);
    }
  }
}

async function artifact(filePath: string, contract: string): Promise<AutopilotArtifact> {
  const resolved = path.resolve(filePath);
  return { contract, path: resolved, sha256: sha256Bytes(await readFile(resolved)) };
}

function artifactPath(checkpoint: CatalogAutopilotCheckpoint, stageName: AutopilotStageName, contract: string): string {
  const matches = stage(checkpoint, stageName).artifacts.filter((item) => item.contract === contract);
  if (matches.length !== 1) throw new Error(`Autopilot stage ${stageName} must contain exactly one ${contract} artifact.`);
  return matches[0]!.path;
}

function stage(checkpoint: CatalogAutopilotCheckpoint, name: AutopilotStageName): AutopilotStage {
  const item = checkpoint.stages.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Autopilot checkpoint lacks stage ${name}.`);
  return item;
}

function isStageComplete(checkpoint: CatalogAutopilotCheckpoint, name: AutopilotStageName): boolean {
  return stage(checkpoint, name).status === "completed";
}

async function persistCheckpoint(checkpoint: CatalogAutopilotCheckpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString();
  const checkpointPath = path.join(checkpoint.runDirectory, CHECKPOINT_FILENAME);
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  const reopened = parseContract<CatalogAutopilotCheckpoint>(await readFile(checkpointPath, "utf8"), checkpoint.contract);
  if (reopened.runId !== checkpoint.runId || reopened.state !== checkpoint.state) throw new Error("Persisted Autopilot checkpoint failed reopen verification.");
}

async function resetIncompleteStageDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

function assertProposalBinding(checkpoint: CatalogAutopilotCheckpoint, proposal: LyricSourceDesignationProposal, artifactSha256: string): void {
  const binding = checkpoint.proposalBinding;
  if (!binding || binding.proposalId !== proposal.proposalId || binding.proposalSha256 !== proposal.proposalSha256 || binding.artifactSha256 !== artifactSha256) {
    throw new Error("Autopilot proposal binding no longer matches the persisted proposal.");
  }
}

function assertSamePreparationRequest(checkpoint: CatalogAutopilotCheckpoint, vaultRoot: string, workspaceRoot: string, options: PrepareCatalogAutopilotOptions): void {
  if (path.resolve(checkpoint.vaultRoot) !== vaultRoot || path.resolve(checkpoint.workspaceRoot) !== workspaceRoot) throw new Error("Autopilot resume request does not match the checkpoint roots.");
  if (options.minTracks !== undefined && options.minTracks !== checkpoint.selection.minTracks) throw new Error("Autopilot resume minTracks differs from the checkpoint.");
  if (options.maxTracks !== undefined && options.maxTracks !== checkpoint.selection.maxTracks) throw new Error("Autopilot resume maxTracks differs from the checkpoint.");
  if (options.excludedReleases !== undefined && JSON.stringify([...new Set(options.excludedReleases)].sort()) !== JSON.stringify(checkpoint.selection.excludedReleases)) throw new Error("Autopilot resume exclusions differ from the checkpoint.");
}

function defaultRunId(): string {
  return `autopilot-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
}

function normalizeRunId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,95}$/.test(normalized)) throw new Error("Autopilot run ID must contain only lowercase letters, numbers, and hyphens.");
  return normalized;
}

function parseContract<T>(text: string, expectedContract: string): T {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.contract !== expectedContract) throw new Error(`Expected ${expectedContract} artifact.`);
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
}
