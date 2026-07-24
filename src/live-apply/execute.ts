import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runReadOnlyRefreshWorkflow, type ReadOnlyRefreshWorkflowSummary } from "../asos-workflow.js";
import { canonicalJson, sha256Bytes } from "../kernel/canonical-json.js";
import { contractPathToNative, normalizeContractPath } from "../kernel/contract-path.js";
import type { LyricSourceIndependentValidationReport } from "../lyric-source/contracts.js";
import { captureVaultSnapshot } from "../lyric-source/independent-validation-specialist.js";
import type { GuardedLiveApplyCounts, GuardedLiveApplyLaunchReport, GuardedLiveApplyPlan, GuardedPackageVerification, RefreshAdapterConfig, ValidatorAdapterConfig } from "./contracts.js";
import { verifyGuardedOperatorPackage } from "./package-verifier.js";
import { assertChildPath, assertOutsideVault, assertSafeExistingDirectory, assertSafeExistingFile, assertSafeNewPath } from "./path-policy.js";
import { loadAndVerifyGuardedPlan } from "./prepare.js";

export type GuardedScriptInvocation = {
  executable: string;
  args: string[];
  cwd: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export type GuardedProcessOutcome = { exitCode: number | null; signal: string | null; stdout: string; stderr: string; childDispositionKnown: boolean };

export type GuardedExecuteTestDependencies = {
  testOnly: true;
  confirmProposalId: (proposalId: string) => Promise<string>;
  runScript: (invocation: GuardedScriptInvocation, context: { plan: GuardedLiveApplyPlan; package: GuardedPackageVerification }) => Promise<GuardedProcessOutcome>;
};

export async function executeGuardedLiveApply(planPathInput: string, expectedPlanSha256: string, testDependencies?: GuardedExecuteTestDependencies): Promise<GuardedLiveApplyLaunchReport> {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256)) throw new Error("--expected-plan-sha256 must be one lowercase SHA-256 value.");
  if (!testDependencies) assertInteractiveProductionEnvironment();
  const loaded = await loadAndVerifyGuardedPlan(planPathInput, expectedPlanSha256);
  const plan = loaded.plan;
  const verifiedPackage = await verifyGuardedOperatorPackage(plan.package.path);
  assertPlanStillMatches(plan, verifiedPackage);
  await reverifyRuntimeIdentities(plan);
  await assertSafeExistingDirectory(plan.intendedVaultRoot, "planned Vault root");
  await assertSafeNewPath(plan.intendedRollbackRoot, "planned rollback root");
  await assertSafeNewPath(plan.intendedResultDirectory, "planned result directory");
  await assertOutsideVault(plan.intendedVaultRoot, plan.intendedRollbackRoot, "planned rollback root");
  await assertOutsideVault(plan.intendedVaultRoot, plan.intendedResultDirectory, "planned result directory");

  const lockPath = `${loaded.path}.execute.lock`;
  await assertOutsideVault(plan.intendedVaultRoot, lockPath, "operator execution lock");
  const lock = await open(lockPath, "wx").catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "EEXIST") throw new Error(`Concurrent guarded execution is refused; lock exists: ${lockPath}`);
    throw error;
  });
  let childDispositionKnown = true;
  try {
    const confirmation = testDependencies
      ? await testDependencies.confirmProposalId(plan.proposalId)
      : await readExactProposalConfirmation(plan.proposalId);
    if (confirmation !== plan.proposalId) {
      await mkdir(plan.intendedResultDirectory, { recursive: false });
      const refused = baseLaunchReport(plan, verifiedPackage, new Date().toISOString(), "refused-before-write");
      await persistLaunchReport(plan, refused);
      return refused;
    }

    await mkdir(plan.intendedResultDirectory, { recursive: false });
    await copyFile(loaded.path, plan.expectedResultPaths.plan);
    const copiedPlan = await loadAndVerifyGuardedPlan(plan.expectedResultPaths.plan, plan.planSha256);
    if (copiedPlan.artifactSha256 !== loaded.artifactSha256) throw new Error("Persisted result-directory plan copy differs from the prepared plan artifact.");
    const proposal = roleArtifact(plan, "proposal");
    const decision = roleArtifact(plan, "decision");
    const dryRun = roleArtifact(plan, "dry-run-report");
    const script = roleArtifact(plan, "script");
    const handoff = roleArtifact(plan, "handoff");
    const workflowAdapter = adapter(plan, "workflow");
    const validatorAdapter = adapter(plan, "validator");
    const workflowConfig: RefreshAdapterConfig = {
      contract: "lyric-source-live-refresh-adapter-config.v1",
      vaultRoot: plan.intendedVaultRoot,
      proposalPath: proposal.path,
      preOutputPath: plan.expectedResultPaths.preRefresh,
      postOutputPath: plan.expectedResultPaths.postRefresh
    };
    const validatorConfig: ValidatorAdapterConfig = {
      contract: "lyric-source-live-validator-adapter-config.v1",
      vaultRoot: plan.intendedVaultRoot,
      proposalPath: proposal.path,
      snapshotPath: plan.expectedResultPaths.snapshot,
      postWorkflowReportPath: plan.expectedResultPaths.postRefresh,
      outputPath: plan.expectedResultPaths.validator
    };
    await writeJsonNew(plan.expectedResultPaths.workflowAdapterConfig, workflowConfig);
    await writeJsonNew(plan.expectedResultPaths.validatorAdapterConfig, validatorConfig);
    await writeFile(plan.expectedResultPaths.workflowAdapterBootstrap, workflowBootstrap(workflowAdapter.path, plan.expectedResultPaths.workflowAdapterConfig), { encoding: "utf8", flag: "wx" });
    await writeFile(plan.expectedResultPaths.validatorAdapterBootstrap, validatorBootstrap(validatorAdapter.path, plan.expectedResultPaths.validatorAdapterConfig), { encoding: "utf8", flag: "wx" });

    const snapshot = await captureVaultSnapshot(plan.intendedVaultRoot);
    const sorted = [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path));
    if (canonicalJson(sorted) !== canonicalJson(snapshot.files)) throw new Error("Pre-APPLY snapshot ordering is not deterministic.");
    await writeJsonNew(plan.expectedResultPaths.snapshot, snapshot);
    const snapshotSha256 = sha256Bytes(await readFile(plan.expectedResultPaths.snapshot));
    const persistedSnapshot = JSON.parse(await readFile(plan.expectedResultPaths.snapshot, "utf8")) as typeof snapshot;
    if (persistedSnapshot.contract !== "lyric-source-vault-snapshot.v1" || canonicalJson(persistedSnapshot.files) !== canonicalJson(snapshot.files)) throw new Error("Persisted pre-APPLY snapshot failed reopen verification.");

    const invocation: GuardedScriptInvocation = {
      executable: plan.powerShell.path,
      cwd: path.dirname(script.path),
      stdoutLogPath: plan.expectedResultPaths.stdoutLog,
      stderrLogPath: plan.expectedResultPaths.stderrLog,
      args: [
        "-NoLogo", "-NoProfile", "-File", script.path,
        "-VaultRoot", plan.intendedVaultRoot,
        "-RollbackRoot", plan.intendedRollbackRoot,
        "-ResultReportPath", plan.expectedResultPaths.applyResult,
        "-ProposalArtifactPath", proposal.path,
        "-DecisionArtifactPath", decision.path,
        "-DryRunReportPath", dryRun.path,
        "-HandoffArtifactPath", handoff.path,
        "-WorkflowCommand", plan.node.path,
        "-WorkflowArguments", plan.expectedResultPaths.workflowAdapterBootstrap,
        "-PreWorkflowReportPath", plan.expectedResultPaths.preRefresh,
        "-PostWorkflowReportPath", plan.expectedResultPaths.postRefresh,
        "-ValidatorCommand", plan.node.path,
        "-ValidatorArguments", plan.expectedResultPaths.validatorAdapterBootstrap,
        "-ValidatorReportPath", plan.expectedResultPaths.validator
      ]
    };
    assertProductionInvocation(invocation);
    const startedAt = new Date().toISOString();
    const outcome = testDependencies
      ? await testDependencies.runScript(invocation, { plan, package: verifiedPackage })
      : await runInteractivePowerShell(invocation);
    childDispositionKnown = outcome.childDispositionKnown;
    await writeFile(plan.expectedResultPaths.stdoutLog, sanitizeLog(outcome.stdout), { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => { if (await exists(plan.expectedResultPaths.stdoutLog)) return; throw error; });
    await writeFile(plan.expectedResultPaths.stderrLog, sanitizeLog(outcome.stderr), { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => { if (await exists(plan.expectedResultPaths.stderrLog)) return; throw error; });

    const report = await evaluateExecution(plan, verifiedPackage, snapshotSha256, startedAt, outcome);
    await persistLaunchReport(plan, report);
    if (report.finalStatus === "failed-rollback-unverified" || report.finalStatus === "interrupted-state-unknown") {
      process.stderr.write(`\n*** HIGH VISIBILITY WARNING: ${report.finalStatus}. Do not rerun APPLY. Rollback package: ${report.rollbackPackage ?? "unknown"} ***\n`);
    }
    return report;
  } finally {
    if (childDispositionKnown) {
      await lock.close();
      await rm(lockPath, { force: true });
    } else {
      await lock.close();
    }
  }
}

export function assertProductionInvocation(invocation: GuardedScriptInvocation): void {
  const forbidden = invocation.args.filter((item) => /^(?:-?AuthorizationInput|-?Compatibility)/i.test(item));
  if (forbidden.length > 0) throw new Error(`Production invocation contains forbidden compatibility or authorization arguments: ${forbidden.join(", ")}`);
  if (invocation.args[0] !== "-NoLogo" || invocation.args[1] !== "-NoProfile" || !invocation.args.includes("-File")) throw new Error("Production PowerShell invocation identity is invalid.");
}

async function evaluateExecution(plan: GuardedLiveApplyPlan, verifiedPackage: GuardedPackageVerification, snapshotSha256: string, startedAt: string, outcome: GuardedProcessOutcome): Promise<GuardedLiveApplyLaunchReport> {
  const base = baseLaunchReport(plan, verifiedPackage, startedAt, "failed-before-write");
  base.lineage.preSnapshotSha256 = snapshotSha256;
  base.processExitCode = outcome.exitCode;
  base.interruption = { signal: outcome.signal, childDispositionKnown: outcome.childDispositionKnown };
  let applyResult: Record<string, unknown> | null = null;
  try { applyResult = JSON.parse(await readFile(plan.expectedResultPaths.applyResult, "utf8")) as Record<string, unknown>; } catch { /* classified below */ }
  if (!applyResult) {
    base.finalStatus = outcome.signal || !outcome.childDispositionKnown || outcome.exitCode === null ? "interrupted-state-unknown" : "failed-before-write";
    base.rollbackStatus = base.finalStatus === "interrupted-state-unknown" ? "unknown" : "not-required";
    return base;
  }
  base.lineage.applyResultSha256 = sha256Bytes(await readFile(plan.expectedResultPaths.applyResult));
  base.rollbackPackage = typeof applyResult.rollbackPackage === "string" ? applyResult.rollbackPackage : null;
  base.rollbackManifest = base.rollbackPackage ? path.join(base.rollbackPackage, "rollback-manifest.json") : null;
  base.changedPaths = Array.isArray(applyResult.changedPaths) ? applyResult.changedPaths.filter((item): item is string => typeof item === "string") : [];
  if (outcome.exitCode === 0) {
    try {
      await assertSuccessfulResult(plan, verifiedPackage, applyResult, base);
      base.finalStatus = "applied-and-validated";
      base.applyExecuted = true;
      base.rollbackStatus = "not-required";
    } catch (error: unknown) {
      base.finalStatus = "failed-rollback-unverified";
      base.applyExecuted = true;
      base.rollbackStatus = "unverified";
      base.interruption = { signal: null, childDispositionKnown: true };
      base.processExitCode = 0;
      await writeFile(plan.expectedResultPaths.stderrLog, `Launcher postcondition failure: ${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8", flag: "a" });
    }
    return base;
  }
  const writesStarted = base.rollbackPackage !== null || applyResult.rollbackRestored !== undefined;
  if (!writesStarted) {
    base.finalStatus = "failed-before-write";
    return base;
  }
  const rollbackVerified = applyResult.rollbackRestored === true && base.rollbackPackage
    ? await verifyRollback(base.rollbackPackage, verifiedPackage, plan.intendedVaultRoot, plan.intendedRollbackRoot)
    : false;
  if (rollbackVerified) {
    const recovery = await runReadOnlyRefreshWorkflow(plan.intendedVaultRoot, plan.expectedResultPaths.recoveryRefresh);
    const actual = countsFromWorkflow(recovery);
    const countsRestored = canonicalJson(actual) === canonicalJson(plan.expectedBaselineCounts);
    await writeJsonNew(plan.expectedResultPaths.recoveryVerification, {
      contract: "lyric-source-recovery-verification.v1", generatedAt: new Date().toISOString(), rollbackPackage: base.rollbackPackage,
      restoredTargetHashes: true, baselineCountsRestored: countsRestored, expectedCounts: plan.expectedBaselineCounts, actualCounts: actual,
      status: countsRestored ? "passed" : "failed", automaticRetryAttempted: false
    });
    base.finalStatus = countsRestored ? "failed-rolled-back-and-verified" : "failed-rollback-unverified";
    base.rollbackStatus = countsRestored ? "restored-and-verified" : "unverified";
    base.actualCounts = actual;
  } else {
    base.finalStatus = "failed-rollback-unverified";
    base.rollbackStatus = "unverified";
  }
  return base;
}

async function assertSuccessfulResult(plan: GuardedLiveApplyPlan, verifiedPackage: GuardedPackageVerification, result: Record<string, unknown>, report: GuardedLiveApplyLaunchReport): Promise<void> {
  if (result.contract !== "lyric-source-apply-result.v1" || result.status !== "applied-and-validated" || result.proposalId !== plan.proposalId || result.proposalCanonicalSha256 !== plan.proposalSha256 || result.operationCount !== 7) throw new Error("Generated APPLY result contract, status, proposal, or operation count is invalid.");
  const proposal = roleArtifact(plan, "proposal"); const decision = roleArtifact(plan, "decision"); const dryRun = roleArtifact(plan, "dry-run-report"); const script = roleArtifact(plan, "script"); const handoff = roleArtifact(plan, "handoff");
  if (
    result.proposalArtifactSha256 !== proposal.sha256 || result.decisionArtifactSha256 !== decision.sha256 ||
    result.dryRunReportSha256 !== dryRun.sha256 || result.actualScriptSha256 !== script.sha256 || result.handoffArtifactSha256 !== handoff.sha256
  ) throw new Error("Generated APPLY result package lineage does not match the sealed plan.");
  const changed = Array.isArray(result.changedPaths) ? result.changedPaths : [];
  if (canonicalJson(changed) !== canonicalJson(plan.operationPaths)) throw new Error("Generated APPLY result changed paths do not exactly match the proposal operations.");
  if (result.unrelatedFileComparisonPassed !== true) throw new Error("Generated APPLY result did not pass unrelated-file comparison.");
  const post = JSON.parse(await readFile(plan.expectedResultPaths.postRefresh, "utf8")) as ReadOnlyRefreshWorkflowSummary;
  const pre = JSON.parse(await readFile(plan.expectedResultPaths.preRefresh, "utf8")) as ReadOnlyRefreshWorkflowSummary;
  assertWorkflowSafety(pre, "pre"); assertWorkflowSafety(post, "post");
  if (canonicalJson(countsFromWorkflow(pre)) !== canonicalJson(plan.expectedBaselineCounts)) throw new Error("Pre-APPLY counts do not match the exact proposal baseline.");
  const actual = countsFromWorkflow(post);
  if (canonicalJson(actual) !== canonicalJson(plan.expectedPostApplyCounts)) throw new Error("Post-APPLY counts do not match the exact proposal expectation.");
  const validator = JSON.parse(await readFile(plan.expectedResultPaths.validator, "utf8")) as LyricSourceIndependentValidationReport;
  if (validator.status !== "passed" || validator.counts.failed !== 0 || validator.authority !== "OBSERVE" || validator.persistedArtifactsOnly !== true || validator.safety.pendingApply !== 0) throw new Error("Independent Validator report did not pass its persisted boundary.");
  const rollbackPackage = typeof result.rollbackPackage === "string" ? result.rollbackPackage : "";
  if (!rollbackPackage || !await verifyRollback(rollbackPackage, verifiedPackage, undefined, plan.intendedRollbackRoot)) throw new Error("Rollback package or manifest failed success-path verification.");
  report.rollbackPackage = rollbackPackage;
  report.rollbackManifest = path.join(rollbackPackage, "rollback-manifest.json");
  report.changedPaths = changed as string[];
  report.actualCounts = actual;
  report.lineage.preRefreshSha256 = sha256Bytes(await readFile(plan.expectedResultPaths.preRefresh));
  report.lineage.postRefreshSha256 = sha256Bytes(await readFile(plan.expectedResultPaths.postRefresh));
  report.lineage.validatorSha256 = sha256Bytes(await readFile(plan.expectedResultPaths.validator));
  if (
    result.preWorkflowReportSha256 !== report.lineage.preRefreshSha256 || result.postWorkflowReportSha256 !== report.lineage.postRefreshSha256 ||
    result.validatorReportSha256 !== report.lineage.validatorSha256
  ) throw new Error("Generated APPLY result report hashes do not match persisted reports.");
  for (const filePath of [plan.expectedResultPaths.preRefresh, plan.expectedResultPaths.postRefresh, plan.expectedResultPaths.validator, plan.expectedResultPaths.applyResult, report.rollbackManifest]) await assertSafeExistingFile(filePath, "persisted execution artifact");
}

async function verifyRollback(packageRoot: string, verifiedPackage: GuardedPackageVerification, restoredVaultRoot?: string, expectedRollbackRoot?: string): Promise<boolean> {
  try {
    await assertSafeExistingDirectory(packageRoot, "rollback package");
    if (expectedRollbackRoot) assertChildPath(expectedRollbackRoot, packageRoot, "rollback package");
    const manifestPath = await assertSafeExistingFile(path.join(packageRoot, "rollback-manifest.json"), "rollback manifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contract: string; targetCount: number; targets: Array<{ path: string; byteSize: number; originalSha256: string }> };
    if (manifest.contract !== "lyric-source-rollback-manifest.v1" || manifest.targetCount !== 7 || manifest.targets.length !== 7) return false;
    for (const operation of verifiedPackage.operations) {
      const target = manifest.targets.filter((item) => normalizeContractPath(item.path) === operation.path);
      if (target.length !== 1 || target[0]!.originalSha256 !== operation.currentSha256) return false;
      const backup = contractPathToNative(packageRoot, operation.path);
      const backupBytes = await readFile(backup);
      if (backupBytes.byteLength !== target[0]!.byteSize || sha256Bytes(backupBytes) !== operation.currentSha256) return false;
      if (restoredVaultRoot && sha256Bytes(await readFile(contractPathToNative(restoredVaultRoot, operation.path))) !== operation.currentSha256) return false;
    }
    return true;
  } catch { return false; }
}

function countsFromWorkflow(report: ReadOnlyRefreshWorkflowSummary): GuardedLiveApplyCounts {
  const routedEntries: Array<[string, number]> = report.findingRoutes.map((item) => [item.route, item.count]);
  return {
    catalogFindings: report.counts.catalogFindings,
    assetFindings: report.counts.assetFindings,
    routedFindings: Object.fromEntries(routedEntries.sort(([left], [right]) => left.localeCompare(right))),
    pendingApply: report.counts.pendingApply as 0
  };
}

function baseLaunchReport(plan: GuardedLiveApplyPlan, verifiedPackage: GuardedPackageVerification, startedAt: string, status: GuardedLiveApplyLaunchReport["finalStatus"]): GuardedLiveApplyLaunchReport {
  return {
    contract: "lyric-source-guarded-live-apply-launch-report.v1", generatedAt: new Date().toISOString(), startedAt, finishedAt: new Date().toISOString(),
    package: { path: verifiedPackage.manifestPath, sha256: verifiedPackage.manifestSha256 }, proposalId: plan.proposalId, proposalSha256: plan.proposalSha256, planSha256: plan.planSha256,
    lineage: { preSnapshotSha256: null, preRefreshSha256: null, postRefreshSha256: null, validatorSha256: null, applyResultSha256: null },
    rollbackPackage: null, rollbackManifest: null, changedPaths: [], operationCount: verifiedPackage.operations.length,
    expectedCounts: { baseline: plan.expectedBaselineCounts, postApply: plan.expectedPostApplyCounts }, actualCounts: null,
    finalStatus: status, applyExecuted: false, rollbackStatus: "not-required", processExitCode: null,
    interruption: { signal: null, childDispositionKnown: true }, safety: { browserApplyAvailable: false, automaticRetryAttempted: false, launcherVaultWrites: "snapshot-read-only" }
  };
}

async function persistLaunchReport(plan: GuardedLiveApplyPlan, report: GuardedLiveApplyLaunchReport): Promise<void> {
  report.finishedAt = new Date().toISOString();
  await writeJsonNew(plan.expectedResultPaths.launcherReport, report);
  const reopened = JSON.parse(await readFile(plan.expectedResultPaths.launcherReport, "utf8")) as GuardedLiveApplyLaunchReport;
  if (reopened.contract !== report.contract || reopened.finalStatus !== report.finalStatus) throw new Error("Persisted launcher report failed reopen verification.");
}

async function reverifyRuntimeIdentities(plan: GuardedLiveApplyPlan): Promise<void> {
  for (const executable of [plan.powerShell, plan.node]) {
    const filePath = await assertSafeExistingFile(executable.path, "sealed executable");
    if (sha256Bytes(await readFile(filePath)) !== executable.sha256) throw new Error("Sealed executable changed after prepare.");
  }
  for (const item of plan.adapters) {
    const filePath = await assertSafeExistingFile(item.path, `${item.role} adapter`);
    if (sha256Bytes(await readFile(filePath)) !== item.sha256) throw new Error(`${item.role} adapter changed after prepare.`);
  }
}

function assertPlanStillMatches(plan: GuardedLiveApplyPlan, verified: GuardedPackageVerification): void {
  if (verified.manifestSha256 !== plan.package.artifactSha256 || verified.proposalId !== plan.proposalId || verified.proposalSha256 !== plan.proposalSha256) throw new Error("Operator package changed after prepare.");
  for (const planned of plan.artifacts) {
    const actual = verified.artifacts.find((item) => item.role === planned.role);
    if (!actual || canonicalJson(actual) !== canonicalJson(planned)) throw new Error(`${planned.role} artifact changed after prepare.`);
  }
  if (canonicalJson(verified.operations.map((item) => item.path)) !== canonicalJson(plan.operationPaths)) throw new Error("Operation paths changed after prepare.");
}

function assertInteractiveProductionEnvironment(): void {
  if (process.platform !== "win32" || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Guarded live APPLY execute requires an attached interactive Windows console with unredirected stdin.");
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.TF_BUILD || process.env.BUILD_BUILDID) throw new Error("Guarded live APPLY execute is forbidden in CI environments.");
}

async function readExactProposalConfirmation(proposalId: string): Promise<string> {
  const prompt = readline.createInterface({ input, output });
  try { return await prompt.question(`Type the exact proposal ID to continue:\n${proposalId}\n> `); }
  finally { prompt.close(); }
}

async function runInteractivePowerShell(invocation: GuardedScriptInvocation): Promise<GuardedProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, shell: false, windowsHide: false, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let signal: string | null = null; let settled = false;
    const append = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (channel === "stdout") { stdout = boundedAppend(stdout, text); process.stdout.write(text); }
      else { stderr = boundedAppend(stderr, text); process.stderr.write(text); }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const forward = (received: NodeJS.Signals): void => { signal = received; try { child.kill(received); } catch { /* disposition reported below */ } };
    process.once("SIGINT", forward); process.once("SIGTERM", forward);
    const cleanup = (): void => { process.removeListener("SIGINT", forward); process.removeListener("SIGTERM", forward); };
    child.once("error", (error) => { if (settled) return; settled = true; cleanup(); resolve({ exitCode: null, signal, stdout, stderr: boundedAppend(stderr, error.message), childDispositionKnown: true }); });
    child.once("close", (code, childSignal) => { if (settled) return; settled = true; cleanup(); resolve({ exitCode: code, signal: signal ?? childSignal, stdout, stderr, childDispositionKnown: true }); });
  });
}

function boundedAppend(current: string, addition: string): string {
  const combined = current + addition;
  const bytes = Buffer.from(combined, "utf8");
  return bytes.byteLength <= 1024 * 1024 ? combined : bytes.subarray(bytes.byteLength - 1024 * 1024).toString("utf8");
}

function sanitizeLog(value: string): string {
  return `${value.replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[encoded-payload-redacted]").replace(/(contentBase64\s*[:=]\s*)\S+/gi, "$1[redacted]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-1024 * 1024)}${value.endsWith("\n") ? "" : "\n"}`;
}

function roleArtifact(plan: GuardedLiveApplyPlan, role: GuardedLiveApplyPlan["artifacts"][number]["role"]) {
  const item = plan.artifacts.find((candidate) => candidate.role === role); if (!item) throw new Error(`Plan lacks ${role} artifact.`); return item;
}
function adapter(plan: GuardedLiveApplyPlan, role: "workflow" | "validator") {
  const item = plan.adapters.find((candidate) => candidate.role === role); if (!item) throw new Error(`Plan lacks ${role} adapter.`); return item;
}
async function writeJsonNew(filePath: string, value: unknown): Promise<void> { await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); }
async function exists(filePath: string): Promise<boolean> { try { await stat(filePath); return true; } catch { return false; } }

function workflowBootstrap(adapterPath: string, configPath: string): string {
  return `import { runRefreshAdapter } from ${JSON.stringify(pathToFileURL(adapterPath).href)};\nconst args=process.argv.slice(2);\nconst value=(name)=>{const index=args.indexOf(name);if(index<0||!args[index+1])throw new Error('Missing '+name);return args[index+1];};\nawait runRefreshAdapter(${JSON.stringify(configPath)},value('--phase'),value('--output'));\n`;
}

function validatorBootstrap(adapterPath: string, configPath: string): string {
  return `import { runValidatorAdapter } from ${JSON.stringify(pathToFileURL(adapterPath).href)};\nconst args=process.argv.slice(2);\nconst value=(name)=>{const index=args.indexOf(name);if(index<0||!args[index+1])throw new Error('Missing '+name);return args[index+1];};\nawait runValidatorAdapter(${JSON.stringify(configPath)},value('--output'),value('--proposal-id'),value('--proposal-sha256'));\n`;
}

function assertWorkflowSafety(report: ReadOnlyRefreshWorkflowSummary, phase: string): void {
  if (report.contract !== "asos-workflow-read-only-refresh.v1.1" || report.safety.applyEnabled !== false || report.safety.vaultMutation !== "none" || report.counts.pendingApply !== 0) {
    throw new Error(`${phase} workflow report contract or safety state is invalid.`);
  }
}
