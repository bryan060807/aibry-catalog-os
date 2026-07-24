import {
  assertProductionInvocation,
  executeGuardedLiveApply as executeGuardedLiveApplyCore
} from "./execute-core.js";
import type {
  GuardedExecuteTestDependencies,
  GuardedProcessOutcome,
  GuardedScriptInvocation
} from "./execute-core.js";
import type { GuardedLiveApplyLaunchReport } from "./contracts.js";
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
  return executeGuardedLiveApplyCore(planPathInput, expectedPlanSha256, testDependencies);
}
