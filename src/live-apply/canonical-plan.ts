import { canonicalJson, sha256Bytes } from "../kernel/canonical-json.js";
import type { GuardedLiveApplyPlan } from "./contracts.js";

export function reconstructGuardedPlanCanonicalPayload(plan: GuardedLiveApplyPlan): string {
  const { generatedAt: _generatedAt, planSha256: _planSha256, canonicalHashPayload: _canonicalHashPayload, ...authoritative } = plan;
  return canonicalJson(authoritative);
}

export function sealGuardedLiveApplyPlan(input: Omit<GuardedLiveApplyPlan, "canonicalHashPayload" | "planSha256">): GuardedLiveApplyPlan {
  const provisional = { ...input, canonicalHashPayload: "", planSha256: "" } as GuardedLiveApplyPlan;
  const canonicalHashPayload = reconstructGuardedPlanCanonicalPayload(provisional);
  return { ...input, canonicalHashPayload, planSha256: sha256Bytes(Buffer.from(canonicalHashPayload, "utf8")) };
}

export function assertGuardedPlanIntegrity(plan: GuardedLiveApplyPlan, expectedSha256?: string): void {
  if (plan.contract !== "lyric-source-guarded-live-apply-plan.v1" || plan.state !== "prepared" || plan.operatorControlled !== true || plan.specialistAuthority !== "none") {
    throw new Error("Guarded live APPLY plan contract or state is invalid.");
  }
  const reconstructed = reconstructGuardedPlanCanonicalPayload(plan);
  const hash = sha256Bytes(Buffer.from(reconstructed, "utf8"));
  if (reconstructed !== plan.canonicalHashPayload || hash !== plan.planSha256 || (expectedSha256 && hash !== expectedSha256.toLowerCase())) {
    throw new Error("Guarded live APPLY plan canonical integrity check failed.");
  }
  if (plan.safety.applyExecuted !== false || plan.safety.vaultMutation !== "none" || plan.safety.interactiveAuthorizationRequired !== true || plan.safety.browserApplyAvailable !== false) {
    throw new Error("Guarded live APPLY plan safety state is invalid.");
  }
}
