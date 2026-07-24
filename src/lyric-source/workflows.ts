import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256Bytes } from "../kernel/canonical-json.js";
import { assertOutputOutsideRoot, assertPathHasNoLinkedSegments } from "../kernel/contract-path.js";
import { canonicalFilename, stageArtifact } from "../artifacts/handoff-specialist.js";
import { isLiveMusicVaultPath } from "../kernel/contract-path.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import { describeSpecialist } from "../specialists/registry.js";
import type { AsosLyricWorkflowRun, LyricSourceBatchScoutReport, LyricSourceCompatibilityFixtureManifest, LyricSourceDesignationProposal, LyricSourceDryRunReport, LyricSourceOperatorPackage, LyricSourcePlanningInput } from "./contracts.js";
import { scoutLyricSourceBatch, validatePlanningInput } from "./batch-scout-specialist.js";
import { createLyricSourceHandoff, verifyReviewDecision } from "./approval.js";
import { runLyricSourceApplyDryRun } from "./dry-run-specialist.js";
import { validateLyricSourceApplyFromPaths } from "./independent-validation-specialist.js";
import { compileLyricSourceProposal, parseAndVerifyLyricSourceProposal } from "./proposal-specialist.js";
import { compileWindowsApplyCandidate, releaseWindowsApplyScript } from "./windows-apply-builder.js";
import { materializeLyricSourceCompatibilityFixture } from "./compatibility-fixture-builder.js";

export type ScoutLyricSourceBatchWorkflowOptions = {
  vaultRoot: string;
  refreshReportPath: string;
  outputDirectory: string;
  minTracks?: number;
  maxTracks?: number;
  excludedReleases?: string[];
};

export type ScoutLyricSourceBatchWorkflowResult = {
  report: LyricSourceBatchScoutReport;
  workflow: AsosLyricWorkflowRun;
  reportPath: string;
  planningInputPath: string | null;
  workflowPath: string;
};

export async function scoutLyricSourceBatchWorkflow(options: ScoutLyricSourceBatchWorkflowOptions): Promise<ScoutLyricSourceBatchWorkflowResult> {
  assertOutsideLiveVault(options.refreshReportPath, options.outputDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  const reportPath = path.join(outputDirectory, canonicalFilename("lyric-source-batch-scout-report.v1"));
  const planningInputPath = path.join(outputDirectory, canonicalFilename("lyric-source-planning-input.v1"));
  const workflowPath = path.join(outputDirectory, canonicalFilename("asos-workflow-run.v1"));
  for (const outputPath of [outputDirectory, reportPath, planningInputPath, workflowPath]) {
    await assertOutputOutsideRoot(options.vaultRoot, outputPath);
  }
  await assertPathHasNoLinkedSegments(outputDirectory, true);
  await mkdir(outputDirectory, { recursive: true });
  await assertNewOutputsAbsent([reportPath, planningInputPath, workflowPath]);
  const result = await scoutLyricSourceBatch({
    vaultRoot: options.vaultRoot,
    refreshReportPath: options.refreshReportPath,
    planningInputPath,
    minTracks: options.minTracks,
    maxTracks: options.maxTracks,
    excludedReleases: options.excludedReleases
  });
  const refreshBytes = await readFile(options.refreshReportPath);
  const outputs: AsosLyricWorkflowRun["outputArtifacts"] = [];
  if (result.planningInput && result.planningInputBytes) {
    validatePlanningInput(result.planningInput, result.report.expectedOperationCount);
    await writeFile(planningInputPath, result.planningInputBytes, { flag: "wx" });
    const sealedPlanningBytes = await readFile(planningInputPath);
    const sealedPlanning = parseContract<LyricSourcePlanningInput>(sealedPlanningBytes.toString("utf8"), "lyric-source-planning-input.v1");
    validatePlanningInput(sealedPlanning, result.report.expectedOperationCount);
    const sealedSha256 = sha256Bytes(sealedPlanningBytes);
    if (sealedSha256 !== result.report.planningInputSha256) {
      throw new Error("Sealed planning input SHA-256 differs from the specialist output identity.");
    }
    outputs.push({ contract: sealedPlanning.contract, path: planningInputPath, sha256: sealedSha256 });
  }
  await writeNewJson(reportPath, result.report);
  const reportBytes = await readFile(reportPath);
  const persistedReport = parseContract<LyricSourceBatchScoutReport>(reportBytes.toString("utf8"), "lyric-source-batch-scout-report.v1");
  if (persistedReport.safety.applyEnabled !== false || persistedReport.safety.vaultMutation !== "none") {
    throw new Error("Persisted scout report failed its OBSERVE-only safety contract.");
  }
  outputs.unshift({ contract: persistedReport.contract, path: reportPath, sha256: sha256Bytes(reportBytes) });
  const workflow = workflowRun(
    "scout-lyric-source-batch",
    "lyric-source-batch-scout",
    "OBSERVE",
    result.report.generatedAt,
    [{ contract: "asos-workflow-read-only-refresh.v1.1", path: path.resolve(options.refreshReportPath), sha256: sha256Bytes(refreshBytes) }],
    outputs,
    null,
    ["verify-refresh-lineage", "inspect-unresolved-project-evidence", "select-deterministic-batch", result.planningInput ? "seal-planning-input" : "emit-structured-refusal"],
    result.report.refusal
  );
  await writeNewJson(workflowPath, workflow);
  return { report: persistedReport, workflow, reportPath, planningInputPath: result.planningInput ? planningInputPath : null, workflowPath };
}

export async function planLyricSourceMigrationWorkflow(inputPath: string, outputPath: string): Promise<LyricSourceDesignationProposal> {
  assertOutsideLiveVault(inputPath, outputPath);
  const inputBytes = await readFile(inputPath);
  const input = parseContract<LyricSourcePlanningInput>(inputBytes.toString("utf8"), "lyric-source-planning-input.v1");
  const proposal = compileLyricSourceProposal(input);
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-proposal-stage-"));
  try {
    const stagedSource = path.join(stagingRoot, canonicalFilename(proposal.contract));
    await writeJson(stagedSource, proposal);
    const stagedBytes = await readFile(stagedSource);
    await stageArtifact(stagedSource, outputPath, proposal.contract, sha256Bytes(stagedBytes), { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256 });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const proposalBytes = await readFile(outputPath);
  await writeJson(`${outputPath}.review-inbox.json`, {
    contract: "lyric-source-review-proposal.v1",
    proposalCount: 1,
    proposals: [{ proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, state: "pending", requiredApproval: true, operationCount: proposal.operations.length }],
    safety: { applyEnabled: false, vaultMutation: "none" }
  });
  await writeJson(`${outputPath}.workflow.json`, workflowRun(
    "plan-lyric-source-migration", "lyric-source-proposal", "PROPOSE", input.generatedAt,
    [{ contract: input.contract, path: path.resolve(inputPath), sha256: sha256Bytes(inputBytes) }],
    [{ contract: proposal.contract, path: path.resolve(outputPath), sha256: sha256Bytes(proposalBytes) }],
    null,
    ["load-explicit-artifacts", "verify-evidence", "compile-deterministic-operations", "emit-one-review-proposal"]
  ));
  return proposal;
}

export type MaterializeLyricSourceCompatibilityFixtureWorkflowOptions = {
  scoutReportPath: string;
  planningInputPath: string;
  proposalPath: string;
  decisionPath: string;
  outputDirectory: string;
  reportsRoot?: string;
  failAfterMaterializedFileCount?: number;
};

export type MaterializeLyricSourceCompatibilityFixtureWorkflowResult = {
  manifest: LyricSourceCompatibilityFixtureManifest;
  workflow: AsosLyricWorkflowRun;
  fixtureRoot: string;
  manifestPath: string;
  workflowPath: string;
};

export async function materializeLyricSourceCompatibilityFixtureWorkflow(
  options: MaterializeLyricSourceCompatibilityFixtureWorkflowOptions
): Promise<MaterializeLyricSourceCompatibilityFixtureWorkflowResult> {
  const reportsRoot = path.resolve(options.reportsRoot ?? path.join(process.cwd(), "reports"));
  const outputDirectory = path.resolve(options.outputDirectory);
  assertOutsideLiveVault(
    reportsRoot,
    options.scoutReportPath,
    options.planningInputPath,
    options.proposalPath,
    options.decisionPath,
    outputDirectory
  );
  let created = false;
  try {
    const result = await materializeLyricSourceCompatibilityFixture({
      reportsRoot,
      scoutReportPath: options.scoutReportPath,
      planningInputPath: options.planningInputPath,
      proposalPath: options.proposalPath,
      decisionPath: options.decisionPath,
      outputDirectory,
      failAfterMaterializedFileCount: options.failAfterMaterializedFileCount
    });
    created = true;
    const manifestBytes = await readFile(result.manifestPath);
    const workflowPath = path.join(outputDirectory, canonicalFilename("asos-workflow-run.v1"));
    const workflow = workflowRun(
      "materialize-lyric-source-compatibility-fixture",
      "lyric-source-compatibility-fixture-builder",
      "OBSERVE",
      result.manifest.generatedAt,
      result.inputArtifacts,
      [{ contract: result.manifest.contract, path: result.manifestPath, sha256: sha256Bytes(manifestBytes) }],
      {
        proposalId: result.manifest.proposal.proposalId,
        proposalSha256: result.manifest.proposal.proposalSha256,
        decisionArtifactSha256: result.manifest.decision.decisionArtifactSha256
      },
      [
        "reopen-and-verify-persisted-artifacts",
        "recompile-and-bind-proposal",
        "verify-approved-decision-lineage",
        "correlate-current-evidence-and-guard-payloads",
        "materialize-reports-local-pre-apply-fixture",
        "verify-repeatable-fixture-snapshot"
      ]
    );
    await writeNewJson(workflowPath, workflow);
    const persistedWorkflow = parseContract<AsosLyricWorkflowRun>(await readFile(workflowPath, "utf8"), "asos-workflow-run.v1");
    if (persistedWorkflow.safety.applyEnabled !== false || persistedWorkflow.safety.vaultMutation !== "none") {
      throw new Error("Compatibility fixture workflow failed its OBSERVE-only safety contract.");
    }
    return { manifest: result.manifest, workflow: persistedWorkflow, fixtureRoot: result.fixtureRoot, manifestPath: result.manifestPath, workflowPath };
  } catch (error: unknown) {
    if (created) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function dryRunLyricSourceApplyWorkflow(proposalPath: string, scriptPath: string, fixtureVault: string, outputPath: string, decisionPath?: string): Promise<LyricSourceDryRunReport> {
  assertOutsideLiveVault(proposalPath, scriptPath, fixtureVault, outputPath, ...(decisionPath ? [decisionPath] : []));
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  let decision: AuthorityTransitionDecision | undefined;
  if (decisionPath) {
    decision = parseContract<AuthorityTransitionDecision>(await readFile(decisionPath, "utf8"), "asos-authority-decision.v1");
    if (
      !verifyReviewDecision(decision) || decision.decisionState !== "approved" ||
      decision.proposalId !== proposal.proposalId || decision.proposalSha256 !== proposal.proposalSha256
    ) throw new Error("Dry-run decision does not approve the exact proposal.");
  }
  const report = await runLyricSourceApplyDryRun(proposalPath, scriptPath, fixtureVault, proposal.generatedAt, { decision });
  await ensureParent(outputPath);
  await writeJson(outputPath, report);
  const [proposalBytes, scriptBytes, reportBytes] = await Promise.all([readFile(proposalPath), readFile(scriptPath), readFile(outputPath)]);
  await writeJson(`${outputPath}.workflow.json`, workflowRun(
    "dry-run-lyric-source-apply", "lyric-source-apply-dry-run", "OBSERVE", proposal.generatedAt,
    [
      { contract: proposal.contract, path: path.resolve(proposalPath), sha256: sha256Bytes(proposalBytes) },
      { contract: "lyric-source-windows-apply-script.v1", path: path.resolve(scriptPath), sha256: sha256Bytes(scriptBytes) },
      ...(decisionPath && decision ? [{ contract: decision.contract, path: path.resolve(decisionPath), sha256: sha256Bytes(await readFile(decisionPath)) }] : [])
    ],
    [{ contract: report.contract, path: path.resolve(outputPath), sha256: sha256Bytes(reportBytes) }],
    null,
    ["verify-identities", "copy-fixture-to-temporary-mirror", "run-powershell-5.1", "force-rollback", "run-independent-validator-process"]
  ));
  return report;
}

export async function buildWindowsLyricSourceApplyWorkflow(proposalPath: string, approvalPath: string, fixtureVault: string, dryRunPath: string, outputPath: string): Promise<void> {
  assertOutsideLiveVault(proposalPath, approvalPath, fixtureVault, dryRunPath, outputPath);
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  const decision = parseContract<AuthorityTransitionDecision>(await readFile(approvalPath, "utf8"), "asos-authority-decision.v1");
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const compatibilityRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-apply-candidate-"));
  let dryRun: LyricSourceDryRunReport;
  try {
    const candidatePath = path.join(compatibilityRoot, canonicalFilename(candidate.contract));
    await writeFile(candidatePath, candidate.content, "utf8");
    dryRun = await runLyricSourceApplyDryRun(proposalPath, candidatePath, fixtureVault, proposal.generatedAt, { decision });
  } finally {
    await rm(compatibilityRoot, { recursive: true, force: true });
  }
  if (dryRun.status !== "passed") {
    throw new Error(`Windows APPLY release refused by compatibility specialist: ${dryRun.failures.join("; ")}`);
  }
  await ensureParent(dryRunPath);
  await writeJson(dryRunPath, dryRun);
  const dryRunBytes = await readFile(dryRunPath);
  await ensureParent(outputPath);
  const released = await releaseWindowsApplyScript(outputPath, proposal, decision, dryRun);
  const proposalBytes = await readFile(proposalPath);
  const handoff = createLyricSourceHandoff(proposal, decision, released.sha256, dryRun, sha256Bytes(dryRunBytes), sha256Bytes(proposalBytes));
  const operatorPackagePath = await stageOperatorPackage({ proposalPath, approvalPath, dryRunPath, scriptPath: outputPath, proposal, decision, dryRun, handoff });
  const [approvalBytes, scriptBytes, operatorPackageBytes] = await Promise.all([readFile(approvalPath), readFile(outputPath), readFile(operatorPackagePath)]);
  await writeJson(`${outputPath}.workflow.json`, workflowRun(
    "build-windows-lyric-source-apply", "windows-lyric-source-apply-builder", "PROPOSE", proposal.generatedAt,
    [
      { contract: proposal.contract, path: path.resolve(proposalPath), sha256: sha256Bytes(proposalBytes) },
      { contract: decision.contract, path: path.resolve(approvalPath), sha256: sha256Bytes(approvalBytes) },
      { contract: dryRun.contract, path: path.resolve(dryRunPath), sha256: sha256Bytes(dryRunBytes) }
    ],
    [
      { contract: released.contract, path: path.resolve(outputPath), sha256: sha256Bytes(scriptBytes) },
      { contract: "lyric-source-operator-package.v1", path: path.resolve(operatorPackagePath), sha256: sha256Bytes(operatorPackageBytes) }
    ],
    { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, decisionArtifactSha256: decision.decisionArtifactSha256 },
    ["verify-exact-approval", "verify-complete-envelope", "verify-matching-dry-run", "release-powershell-artifact", "create-handoff"]
  ));
}

async function stageOperatorPackage(input: {
  proposalPath: string;
  approvalPath: string;
  dryRunPath: string;
  scriptPath: string;
  proposal: LyricSourceDesignationProposal;
  decision: AuthorityTransitionDecision;
  dryRun: LyricSourceDryRunReport;
  handoff: ReturnType<typeof createLyricSourceHandoff>;
}): Promise<string> {
  const packageDirectory = `${input.scriptPath}.operator-package`;
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-operator-package-"));
  try {
    const proposalArtifactSha256 = sha256Bytes(await readFile(input.proposalPath));
    const dryRunReportSha256 = sha256Bytes(await readFile(input.dryRunPath));
    const scriptSha256 = sha256Bytes(await readFile(input.scriptPath));
    const expectations = {
      proposalId: input.proposal.proposalId,
      proposalSha256: input.proposal.proposalSha256,
      proposalArtifactSha256,
      decisionArtifactSha256: input.decision.decisionArtifactSha256,
      dryRunReportSha256,
      scriptSha256
    };
    const definitions = [
      { role: "proposal" as const, source: input.proposalPath, contract: input.proposal.contract },
      { role: "decision" as const, source: input.approvalPath, contract: input.decision.contract },
      { role: "dry-run-report" as const, source: input.dryRunPath, contract: input.dryRun.contract },
      { role: "script" as const, source: input.scriptPath, contract: "lyric-source-windows-apply-script.v1" }
    ];
    const artifacts: LyricSourceOperatorPackage["artifacts"] = [];
    for (const definition of definitions) {
      const bytes = await readFile(definition.source);
      const destination = path.join(packageDirectory, canonicalFilename(definition.contract));
      const staged = await stageArtifact(definition.source, destination, definition.contract, sha256Bytes(bytes), expectations);
      artifacts.push({ role: definition.role, contract: definition.contract, canonicalPath: path.basename(destination), sha256: staged.staged.actualSha256, byteSize: staged.staged.byteSize });
    }
    const handoffSource = path.join(stagingRoot, canonicalFilename(input.handoff.contract));
    await writeJson(handoffSource, input.handoff);
    const handoffBytes = await readFile(handoffSource);
    const handoffDestination = path.join(packageDirectory, canonicalFilename(input.handoff.contract));
    const stagedHandoff = await stageArtifact(handoffSource, handoffDestination, input.handoff.contract, sha256Bytes(handoffBytes), expectations);
    artifacts.push({ role: "handoff", contract: input.handoff.contract, canonicalPath: path.basename(handoffDestination), sha256: stagedHandoff.staged.actualSha256, byteSize: stagedHandoff.staged.byteSize });
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\${canonicalFilename("lyric-source-windows-apply-script.v1")}" -VaultRoot "<VAULT_ROOT>" -RollbackRoot "<ROLLBACK_ROOT>" -ResultReportPath "<OUTPUT_ROOT>\\lyric-source-apply-result.v1.json" -ProposalArtifactPath ".\\${canonicalFilename(input.proposal.contract)}" -DecisionArtifactPath ".\\${canonicalFilename(input.decision.contract)}" -DryRunReportPath ".\\${canonicalFilename(input.dryRun.contract)}" -HandoffArtifactPath ".\\${canonicalFilename(input.handoff.contract)}" -WorkflowCommand "<ASOS_WORKFLOW_COMMAND>" -PreWorkflowReportPath "<OUTPUT_ROOT>\\pre-workflow.json" -PostWorkflowReportPath "<OUTPUT_ROOT>\\post-workflow.json" -ValidatorCommand "<INDEPENDENT_VALIDATOR_COMMAND>" -ValidatorReportPath "<OUTPUT_ROOT>\\validator.json"`;
    const operatorPackage: LyricSourceOperatorPackage = {
      contract: "lyric-source-operator-package.v1",
      proposalId: input.proposal.proposalId,
      proposalSha256: input.proposal.proposalSha256,
      artifacts,
      executionCommands: [command],
      safety: { liveApplyExecuted: false, governanceVerified: true, artifactsOutsideVaultRequired: true }
    };
    const manifestSource = path.join(stagingRoot, canonicalFilename(operatorPackage.contract));
    await writeJson(manifestSource, operatorPackage);
    const manifestBytes = await readFile(manifestSource);
    const manifestDestination = path.join(packageDirectory, canonicalFilename(operatorPackage.contract));
    await stageArtifact(manifestSource, manifestDestination, operatorPackage.contract, sha256Bytes(manifestBytes), { proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256 });
    return manifestDestination;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function validateLyricSourceApplyWorkflow(proposalPath: string, vaultRoot: string, snapshotPath: string, workflowReportPath: string, outputPath: string, generatedAt: string): Promise<void> {
  const report = await validateLyricSourceApplyFromPaths(proposalPath, vaultRoot, snapshotPath, workflowReportPath, generatedAt);
  await ensureParent(outputPath);
  await writeJson(outputPath, report);
}

function workflowRun(workflow: AsosLyricWorkflowRun["workflow"], specialistId: string, authorityMode: string, generatedAt: string, inputs: AsosLyricWorkflowRun["inputArtifacts"], outputs: AsosLyricWorkflowRun["outputArtifacts"], decisionBinding: AsosLyricWorkflowRun["decisionBinding"], stepNames: string[], refusal: AsosLyricWorkflowRun["refusal"] = null): AsosLyricWorkflowRun {
  const specialist = describeSpecialist(specialistId);
  if (!specialist) {
    throw new Error(`Unknown workflow specialist: ${specialistId}`);
  }
  const runSeed = sha256Bytes(Buffer.from(JSON.stringify({ workflow, inputs, outputs, decisionBinding }), "utf8"));
  return {
    contract: "asos-workflow-run.v1",
    workflow,
    runId: `${workflow}:${runSeed.slice(0, 20)}`,
    generatedAt,
    specialist: { id: specialist.id, version: specialist.version, authorityMode },
    orderedSteps: stepNames.map((name, index) => ({ order: index + 1, name, status: refusal && index === stepNames.length - 1 ? "refused" : "completed" })),
    inputArtifacts: inputs,
    outputArtifacts: outputs,
    evidenceLineage: inputs.map((input) => ({ contract: input.contract, sha256: input.sha256 })),
    decisionBinding,
    refusal,
    safety: { applyEnabled: false, vaultMutation: "none" },
    runtimeRequirements: specialist.supportedRuntime ? [specialist.supportedRuntime] : []
  };
}

function parseContract<T>(text: string, expected: string): T {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.contract !== expected) {
    throw new Error(`Expected ${expected} artifact.`);
  }
  return parsed as T;
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeNewJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function assertNewOutputsAbsent(paths: string[]): Promise<void> {
  for (const outputPath of paths) {
    try {
      await access(outputPath);
      throw new Error(`Scout workflow output already exists: ${outputPath}`);
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
    }
  }
}

function assertOutsideLiveVault(...paths: string[]): void {
  if (paths.some(isLiveMusicVaultPath)) {
    throw new Error("This workflow refuses artifact, fixture, or output paths inside the live Music Vault.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
