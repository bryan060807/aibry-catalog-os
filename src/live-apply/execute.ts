import { lstat, mkdir, readFile, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  assertProductionInvocation,
  executeGuardedLiveApply as executeGuardedLiveApplyCore
} from "./execute-core.js";
import type {
  GuardedExecuteTestDependencies,
  GuardedProcessOutcome,
  GuardedScriptInvocation
} from "./execute-core.js";
import type { GuardedLiveApplyLaunchReport, GuardedLiveApplyPlan } from "./contracts.js";
import { loadAndVerifyGuardedPlan } from "./prepare.js";
import { verifyGuardedOperatorPackage } from "./package-verifier.js";

export type {
  GuardedExecuteTestDependencies,
  GuardedProcessOutcome,
  GuardedScriptInvocation
} from "./execute-core.js";
export { assertProductionInvocation };

export async function executeGuardedLiveApply(
  planPathInput: string,
  expectedPlanSha256: string,
  testDependencies?: GuardedExecuteTestDependencies
): Promise<GuardedLiveApplyLaunchReport> {
  const loaded = await loadAndVerifyGuardedPlan(planPathInput, expectedPlanSha256);
  const policy = loaded.plan.packagePolicy ?? "ground-wire-gospel-pilot";
  await verifyGuardedOperatorPackage(loaded.plan.package.path, policy);
  await archiveExactRefusedBeforeWriteResidue(loaded.plan);
  return executeGuardedLiveApplyCore(planPathInput, expectedPlanSha256, testDependencies);
}

async function archiveExactRefusedBeforeWriteResidue(plan: GuardedLiveApplyPlan): Promise<void> {
  const resultDirectory = path.resolve(plan.intendedResultDirectory);
  try {
    const item = await lstat(resultDirectory);
    if (item.isSymbolicLink() || !item.isDirectory()) return;
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") return;
    throw error;
  }

  const entries = await readdir(resultDirectory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isFile()) return;
  const reportPath = path.resolve(plan.expectedResultPaths.launcherReport);
  const actualPath = path.join(resultDirectory, entries[0]!.name);
  if (actualPath.toLowerCase() !== reportPath.toLowerCase()) return;

  const report = JSON.parse(await readFile(reportPath, "utf8")) as GuardedLiveApplyLaunchReport;
  const exactNoWriteRefusal =
    report.contract === "lyric-source-guarded-live-apply-launch-report.v1" &&
    report.planSha256 === plan.planSha256 &&
    report.proposalId === plan.proposalId &&
    report.proposalSha256 === plan.proposalSha256 &&
    report.package.path === plan.package.path &&
    report.package.sha256 === plan.package.artifactSha256 &&
    report.finalStatus === "refused-before-write" &&
    report.applyExecuted === false &&
    report.changedPaths.length === 0 &&
    report.rollbackPackage === null &&
    report.rollbackManifest === null &&
    report.actualCounts === null &&
    report.processExitCode === null &&
    report.lineage.preSnapshotSha256 === null &&
    report.lineage.preRefreshSha256 === null &&
    report.lineage.postRefreshSha256 === null &&
    report.lineage.validatorSha256 === null &&
    report.lineage.applyResultSha256 === null;
  if (!exactNoWriteRefusal) return;

  const archiveDirectory = `${resultDirectory}.refused-attempts`;
  await mkdir(archiveDirectory, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const archivedPath = path.join(archiveDirectory, `refused-before-write-${safeTimestamp}-${report.planSha256.slice(0, 12)}.json`);
  await rename(reportPath, archivedPath);
  await rmdir(resultDirectory);
}
