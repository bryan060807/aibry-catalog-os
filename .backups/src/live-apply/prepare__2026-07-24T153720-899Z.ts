import { writeFile } from "node:fs/promises";
import {
  loadAndVerifyGuardedPlan as loadAndVerifyGuardedPlanCore,
  prepareGuardedLiveApply as prepareGuardedLiveApplyCore
} from "./prepare-core.js";
import type {
  PrepareGuardedLiveApplyOptions,
  PrepareGuardedLiveApplyTestDependencies
} from "./prepare-core.js";
import { sealGuardedLiveApplyPlan } from "./canonical-plan.js";
import type { GuardedLiveApplyPlan } from "./contracts.js";

export type {
  PrepareGuardedLiveApplyOptions,
  PrepareGuardedLiveApplyTestDependencies
} from "./prepare-core.js";

export async function prepareGuardedLiveApply(
  options: PrepareGuardedLiveApplyOptions,
  testDependencies?: PrepareGuardedLiveApplyTestDependencies
): Promise<GuardedLiveApplyPlan> {
  const prepared = await prepareGuardedLiveApplyCore(options, testDependencies);
  const packagePolicy = options.packagePolicy ?? "ground-wire-gospel-pilot";
  const {
    canonicalHashPayload: _canonicalHashPayload,
    planSha256: _planSha256,
    ...authoritative
  } = prepared;
  const sealed = sealGuardedLiveApplyPlan({ ...authoritative, packagePolicy });
  await writeFile(options.outputPath, `${JSON.stringify(sealed, null, 2)}\n`, "utf8");
  return (await loadAndVerifyGuardedPlanCore(options.outputPath, sealed.planSha256)).plan;
}

export async function loadAndVerifyGuardedPlan(planPathInput: string, expectedSha256?: string) {
  return loadAndVerifyGuardedPlanCore(planPathInput, expectedSha256);
}
