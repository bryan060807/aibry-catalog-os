import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAuthorityTransition, assertNonMutatingAuthority, assertSpecialistOutputContract } from "../src/kernel/authority-policy.js";
import { listSpecialists } from "../src/specialists/registry.js";
import { specialistId } from "../src/specialists/contracts.js";
import { buildReviewDecision } from "../src/lyric-source/approval.js";

test("specialist registry contains existing and lyric migration specialists with bounded authority", () => {
  const registry = listSpecialists();
  const ids = new Set(registry.map((manifest) => String(manifest.id)));
  for (const id of ["asos-kernel", "asset-inspector", "project-admitter", "review-inbox", "operation-journal", "lyric-source-proposal", "artifact-handoff", "windows-lyric-source-apply-builder", "lyric-source-apply-dry-run", "lyric-source-independent-validator"]) {
    assert.equal(ids.has(id), true, id);
  }
  assert.deepEqual(registry.find((manifest) => manifest.id === "lyric-source-proposal")?.authorityModes, ["PROPOSE"]);
  assert.deepEqual(registry.find((manifest) => manifest.id === "windows-lyric-source-apply-builder")?.supportedRuntime, "Windows PowerShell 5.1");
  assert.equal(registry.find((manifest) => manifest.id === "lyric-source-independent-validator")?.musicVaultWriteAllowed, false);
});

test("kernel refuses unsupported transitions and undeclared contracts", () => {
  const refused = evaluateAuthorityTransition({
    from: "OBSERVE",
    to: "APPLY",
    specialistId: specialistId("lyric-source-proposal"),
    inputContracts: ["lyric-source-planning-input.v1"],
    outputContracts: ["lyric-source-designation-proposal.v1"],
    proposalBinding: null,
    decision: null,
    completeOperationPlan: false,
    completeRollbackCriteria: false,
    completeValidatorCriteria: false,
    independentValidatorId: null
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.refusal?.code, "authority-not-declared");
  assert.throws(() => assertSpecialistOutputContract("lyric-source-proposal", "lyric-source-windows-apply-script.v1"), /undeclared contract/);
});

test("OBSERVE, PROPOSE, and APPLY_OUTSIDE_VAULT cannot mutate", () => {
  assert.throws(() => assertNonMutatingAuthority("OBSERVE", "approved-bounded"), /cannot mutate/);
  assert.throws(() => assertNonMutatingAuthority("PROPOSE", "approved-bounded"), /cannot mutate/);
  assert.throws(() => assertNonMutatingAuthority("APPLY_OUTSIDE_VAULT", "approved-bounded"), /cannot mutate/);
});

test("mutating specialist cannot independently validate itself", () => {
  const decision = buildReviewDecision("proposal:one", "a".repeat(64), "approved", "2026-07-22T00:00:00.000Z");
  const result = evaluateAuthorityTransition({
    from: "HANDOFF",
    to: "APPLY",
    specialistId: specialistId("project-admitter"),
    inputContracts: ["catalog-discovery.v1"],
    outputContracts: ["project-admission-report.v2"],
    proposalBinding: { proposalId: decision.proposalId, proposalSha256: decision.proposalSha256 },
    decision,
    completeOperationPlan: true,
    completeRollbackCriteria: true,
    completeValidatorCriteria: true,
    independentValidatorId: specialistId("project-admitter")
  });
  assert.equal(result.allowed, false);
  assert.equal(result.refusal?.code, "self-validation-forbidden");
});
