import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalFilename } from "../../src/artifacts/handoff-specialist.js";
import { sha256Bytes } from "../../src/kernel/canonical-json.js";
import { contractPathToNative } from "../../src/kernel/contract-path.js";
import { buildReviewDecision, createLyricSourceHandoff } from "../../src/lyric-source/approval.js";
import type { LyricSourceDesignationProposal, LyricSourceDryRunReport, LyricSourceOperatorPackage } from "../../src/lyric-source/contracts.js";
import { parseAndVerifyLyricSourceProposal } from "../../src/lyric-source/proposal-specialist.js";
import { compileWindowsApplyCandidate } from "../../src/lyric-source/windows-apply-builder.js";
import { planLyricSourceMigrationWorkflow, scoutLyricSourceBatchWorkflow } from "../../src/lyric-source/workflows.js";
import { runRefreshAdapter } from "../../src/live-apply/workflow-adapter.js";
import { runValidatorAdapter } from "../../src/live-apply/validator-adapter.js";
import type { GuardedExecuteTestDependencies, GuardedProcessOutcome, GuardedScriptInvocation } from "../../src/live-apply/execute.js";
import type { GuardedLiveApplyPlan, GuardedPackageVerification, RefreshAdapterConfig, ValidatorAdapterConfig } from "../../src/live-apply/contracts.js";
import { materializeGroundWireGospelFixture } from "./lyric-source-scout-fixture.js";

export type GuardedFixture = {
  root: string;
  vault: string;
  reportsRoot: string;
  packageManifest: string;
  proposalPath: string;
  decisionPath: string;
  proposal: LyricSourceDesignationProposal;
};

let fixtureTemplate: Map<string, Buffer> | null = null;

export async function createGuardedFixture(): Promise<GuardedFixture> {
  if (fixtureTemplate) return materializeGuardedFixtureTemplate(fixtureTemplate);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), "catalog-guarded-live-apply-"));
    try {
      const fixture = await createGuardedFixtureAt(root);
      fixtureTemplate = await captureFixtureTemplate(root);
      return fixture;
    }
    catch (error: unknown) { lastError = error; await rm(root, { recursive: true, force: true }); }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to create deterministic seven-operation guarded fixture.");
}

async function materializeGuardedFixtureTemplate(template: Map<string, Buffer>): Promise<GuardedFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-guarded-live-apply-"));
  for (const [relativePath, bytes] of template) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }
  const reportsRoot = path.join(root, "source", "reports");
  const packageRoot = path.join(reportsRoot, "operator-package");
  const proposalPath = path.join(packageRoot, canonicalFilename("lyric-source-designation-proposal.v1"));
  const decisionPath = path.join(packageRoot, canonicalFilename("asos-authority-decision.v1"));
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  return { root, vault: path.join(root, "source", "fixture-vault"), reportsRoot, packageManifest: path.join(packageRoot, canonicalFilename("lyric-source-operator-package.v1")), proposalPath, decisionPath, proposal };
}

async function captureFixtureTemplate(root: string): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();
  await visit(root, "", output);
  return output;
}

async function visit(root: string, relative: string, output: Map<string, Buffer>): Promise<void> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await visit(root, child, output);
    else if (entry.isFile()) output.set(child, await readFile(path.join(root, ...child.split("/"))));
  }
}

async function createGuardedFixtureAt(root: string): Promise<GuardedFixture> {
  const source = await materializeGroundWireGospelFixture(path.join(root, "source"));
  const scout = await scoutLyricSourceBatchWorkflow({ vaultRoot: source.vault, refreshReportPath: source.refreshReportPath, outputDirectory: path.join(source.reportsRoot, "scout"), minTracks: 2, maxTracks: 4 });
  if (!scout.planningInputPath) throw new Error("Guarded fixture scout did not produce planning input.");
  const proposalPath = path.join(source.reportsRoot, "package-source", canonicalFilename("lyric-source-designation-proposal.v1"));
  const proposal = await planLyricSourceMigrationWorkflow(scout.planningInputPath, proposalPath);
  if (proposal.operations.length !== 7) throw new Error(`Temporary Ground Wire fixture did not seal seven operations; found ${proposal.operations.length}.`);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const decisionPath = path.join(path.dirname(proposalPath), canonicalFilename("asos-authority-decision.v1"));
  await writeJson(decisionPath, decision);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const packageRoot = path.join(source.reportsRoot, "operator-package");
  await mkdir(packageRoot, { recursive: true });
  const paths = {
    proposal: path.join(packageRoot, canonicalFilename(proposal.contract)),
    decision: path.join(packageRoot, canonicalFilename(decision.contract)),
    script: path.join(packageRoot, canonicalFilename(candidate.contract)),
    dryRun: path.join(packageRoot, canonicalFilename("lyric-source-apply-dry-run-report.v1")),
    handoff: path.join(packageRoot, canonicalFilename("lyric-source-apply-handoff.v1"))
  };
  await cp(proposalPath, paths.proposal);
  await cp(decisionPath, paths.decision);
  await writeFile(paths.script, candidate.content, "utf8");
  const proposalArtifactSha256 = sha256Bytes(await readFile(paths.proposal));
  const scriptSha256 = sha256Bytes(await readFile(paths.script));
  const dryRun: LyricSourceDryRunReport = {
    contract: "lyric-source-apply-dry-run-report.v1", generatedAt: proposal.generatedAt, powerShellVersion: "5.1.19041.5608",
    proposalIdentity: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, artifactSha256: proposalArtifactSha256 },
    scriptIdentity: { contract: "lyric-source-windows-apply-script.v1", scriptSha256 },
    parsedCollectionCounts: { operations: 7, evidence: proposal.evidence.length, guards: proposal.guardFiles.length },
    normalizedPathChecks: proposal.operations.map((item) => ({ path: item.path, normalized: item.path, passed: true })),
    rollbackChecks: { targetCount: 7, originalsRehashed: true, pathsInsideRollbackRoot: true },
    reportChecks: { preReportLoadedFromDisk: true, postReportLoadedFromDisk: true, sameLoader: true, wrappedObjectsNormalized: true },
    resolverLookupChecks: { expected: proposal.resolverExpectedProjects.length, foundExactlyOnce: proposal.resolverExpectedProjects.length },
    expectedDeltas: proposal.expectedFindingDeltas, forcedFailureRollback: { attempted: true, restoredAllTargets: true },
    independentValidation: { ranFromPersistedArtifacts: true, status: "passed" }, unrelatedFileDiffDetected: true,
    scenarios: [{ name: "complete-temporary-mirror-suite", expected: "passed", observed: "passed", restoredAllTargets: true, resultContract: "lyric-source-apply-simulation-result.v1" }],
    liveVaultAccess: false, mutationTarget: "temporary-mirror-only", status: "passed", failures: []
  };
  await writeJson(paths.dryRun, dryRun);
  const dryRunSha256 = sha256Bytes(await readFile(paths.dryRun));
  const handoff = createLyricSourceHandoff(proposal, decision, scriptSha256, dryRun, dryRunSha256, proposalArtifactSha256);
  await writeJson(paths.handoff, handoff);
  const definitions = [
    ["proposal", proposal.contract, paths.proposal], ["decision", decision.contract, paths.decision],
    ["dry-run-report", dryRun.contract, paths.dryRun], ["script", candidate.contract, paths.script], ["handoff", handoff.contract, paths.handoff]
  ] as const;
  const artifacts: LyricSourceOperatorPackage["artifacts"] = [];
  for (const [role, contract, filePath] of definitions) {
    const bytes = await readFile(filePath);
    artifacts.push({ role, contract, canonicalPath: path.basename(filePath), sha256: sha256Bytes(bytes), byteSize: bytes.byteLength });
  }
  const packageManifest = path.join(packageRoot, canonicalFilename("lyric-source-operator-package.v1"));
  await writeJson(packageManifest, {
    contract: "lyric-source-operator-package.v1", proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256,
    artifacts, executionCommands: ["terminal-only guarded launcher"], safety: { liveApplyExecuted: false, governanceVerified: true, artifactsOutsideVaultRequired: true }
  } satisfies LyricSourceOperatorPackage);
  return { root, vault: source.vault, reportsRoot: source.reportsRoot, packageManifest, proposalPath: paths.proposal, decisionPath: paths.decision, proposal };
}

export async function disposeGuardedFixture(fixture: GuardedFixture): Promise<void> { await rm(fixture.root, { recursive: true, force: true }); }

export function fixtureExecutionDependencies(mode: { failAtWriteIndex?: number; failStage?: "before-write" | "post-refresh" | "validator" | "unrelated"; corruptRollback?: boolean } = {}): GuardedExecuteTestDependencies {
  return {
    testOnly: true,
    confirmProposalId: async (proposalId) => proposalId,
    runScript: async (invocation, context) => runFixtureScript(invocation, context.plan, context.package, mode)
  };
}

async function runFixtureScript(invocation: GuardedScriptInvocation, plan: GuardedLiveApplyPlan, verified: GuardedPackageVerification, mode: { failAtWriteIndex?: number; failStage?: "before-write" | "post-refresh" | "validator" | "unrelated"; corruptRollback?: boolean }): Promise<GuardedProcessOutcome> {
  const proposalPath = plan.artifacts.find((item) => item.role === "proposal")!.path;
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  const workflowConfigPath = plan.expectedResultPaths.workflowAdapterConfig;
  const validatorConfigPath = plan.expectedResultPaths.validatorAdapterConfig;
  const workflowConfig = JSON.parse(await readFile(workflowConfigPath, "utf8")) as RefreshAdapterConfig;
  const validatorConfig = JSON.parse(await readFile(validatorConfigPath, "utf8")) as ValidatorAdapterConfig;
  await runRefreshAdapter(workflowConfigPath, "pre", plan.expectedResultPaths.preRefresh);
  const packageRoot = path.join(plan.intendedRollbackRoot, "lyric-source-fixture-package");
  await mkdir(packageRoot, { recursive: true });
  const targets: Array<{ path: string; byteSize: number; originalSha256: string }> = [];
  for (const operation of verified.operations) {
    const source = contractPathToNative(plan.intendedVaultRoot, operation.path);
    const destination = contractPathToNative(packageRoot, operation.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    const bytes = await readFile(destination);
    targets.push({ path: operation.path, byteSize: bytes.byteLength, originalSha256: sha256Bytes(bytes) });
  }
  await writeJson(path.join(packageRoot, "rollback-manifest.json"), { contract: "lyric-source-rollback-manifest.v1", targetCount: 7, targets });
  if (mode.failStage === "before-write") {
    await writeJson(plan.expectedResultPaths.applyResult, { contract: "lyric-source-apply-result.v1", proposalId: plan.proposalId, proposalSha256: plan.proposalSha256, status: "failed-before-write", operationCount: 7 });
    return outcome(1);
  }
  let writes = 0;
  try {
    for (const operation of proposal.operations) {
      await writeFile(contractPathToNative(plan.intendedVaultRoot, operation.path), Buffer.from(operation.contentBase64, "base64"));
      writes += 1;
      if (mode.failAtWriteIndex === writes) throw new Error(`forced write failure ${writes}`);
    }
    await runRefreshAdapter(workflowConfigPath, "post", plan.expectedResultPaths.postRefresh);
    if (mode.failStage === "post-refresh") throw new Error("forced post-refresh failure");
    await runValidatorAdapter(validatorConfigPath, plan.expectedResultPaths.validator, plan.proposalId, plan.proposalSha256);
    if (mode.failStage === "validator") throw new Error("forced validator failure");
    if (mode.failStage === "unrelated") {
      await writeFile(path.join(plan.intendedVaultRoot, "forced-unrelated-file.txt"), "forced unrelated mutation\n", "utf8");
      throw new Error("forced unrelated-file failure");
    }
    const post = JSON.parse(await readFile(plan.expectedResultPaths.postRefresh, "utf8")) as { counts: Record<string, number> };
    const roleSha = (role: GuardedLiveApplyPlan["artifacts"][number]["role"]) => plan.artifacts.find((item) => item.role === role)!.sha256;
    await writeJson(plan.expectedResultPaths.applyResult, {
      contract: "lyric-source-apply-result.v1", proposalId: plan.proposalId, proposalCanonicalSha256: plan.proposalSha256,
      proposalArtifactSha256: roleSha("proposal"), decisionArtifactSha256: roleSha("decision"), dryRunReportSha256: roleSha("dry-run-report"),
      actualScriptSha256: roleSha("script"), handoffArtifactSha256: roleSha("handoff"),
      preWorkflowReportSha256: sha256Bytes(await readFile(plan.expectedResultPaths.preRefresh)),
      postWorkflowReportSha256: sha256Bytes(await readFile(plan.expectedResultPaths.postRefresh)), validatorReportSha256: sha256Bytes(await readFile(plan.expectedResultPaths.validator)),
      status: "applied-and-validated", rollbackPackage: packageRoot, operationCount: 7, changedPaths: plan.operationPaths,
      expectedCounts: plan.expectedPostApplyCounts, actualCounts: post.counts, unrelatedFileComparisonPassed: true
    });
    return outcome(0);
  } catch (error: unknown) {
    await rm(path.join(plan.intendedVaultRoot, "forced-unrelated-file.txt"), { force: true });
    for (const operation of verified.operations) await cp(contractPathToNative(packageRoot, operation.path), contractPathToNative(plan.intendedVaultRoot, operation.path), { force: true });
    if (mode.corruptRollback) await writeFile(contractPathToNative(packageRoot, verified.operations[0]!.path), "corrupted rollback evidence\n", "utf8");
    await rm(plan.expectedResultPaths.postRefresh, { force: true });
    await rm(plan.expectedResultPaths.validator, { force: true });
    await writeJson(plan.expectedResultPaths.applyResult, { ...failureResult(plan, packageRoot, true), error: error instanceof Error ? error.message : String(error) });
    return outcome(1);
  }
}

function failureResult(plan: GuardedLiveApplyPlan, rollbackPackage: string | null, rollbackRestored: boolean) {
  return { contract: "lyric-source-apply-result.v1", proposalId: plan.proposalId, proposalSha256: plan.proposalSha256, status: "failed-rolled-back", rollbackPackage, rollbackRestored, operationCount: 7 };
}
function outcome(exitCode: number): GuardedProcessOutcome { return { exitCode, signal: null, stdout: "fixture harness\n", stderr: "", childDispositionKnown: true }; }
async function writeJson(filePath: string, value: unknown): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
