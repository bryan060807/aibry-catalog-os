import { rm, writeFile } from "node:fs/promises";
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
  const packagePolicy = options.packagePolicy ?? "ground-wire-gospel-pilot";
  const prepared = await prepareGuardedLiveApplyCore(options, testDependencies);
  if (packagePolicy === "bounded-lyric-source-batch" && prepared.operationPaths.length !== 7) {
    await rm(options.outputPath, { force: true });
    throw new Error(`Bounded live execution currently requires a seven-operation plan; found ${prepared.operationPaths.length}. The package remains valid for review, but live authorization is refused until the execution core is generalized.`);
  }
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
