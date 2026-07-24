import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import { buildReviewDecision } from "../src/lyric-source/approval.js";
import type { LyricSourceDesignationProposal, LyricSourceDryRunReport, LyricSourceOperatorPackage } from "../src/lyric-source/contracts.js";
import type { AuthorityTransitionDecision } from "../src/specialists/contracts.js";
import { assertProductionInvocation, executeGuardedLiveApply, type GuardedScriptInvocation } from "../src/live-apply/execute.js";
import { verifyGuardedOperatorPackage } from "../src/live-apply/package-verifier.js";
import { loadAndVerifyGuardedPlan, prepareGuardedLiveApply } from "../src/live-apply/prepare.js";
import { createGuardedFixture, disposeGuardedFixture, fixtureExecutionDependencies, type GuardedFixture } from "./helpers/guarded-live-apply-fixture.js";

test("prepare verifies the exact five-artifact package and persists one canonical non-executed plan", async () => withFixture(async (fixture) => {
  const before = await snapshotHashes(fixture.vault);
  const { plan } = await preparePlan(fixture, "prepare");
  assert.equal(plan.artifacts.length, 5);
  assert.equal(plan.operationPaths.length, 7);
  assert.equal(plan.safety.applyExecuted, false);
  assert.equal(plan.safety.browserApplyAvailable, false);
  assert.equal((await loadAndVerifyGuardedPlan(path.join(fixture.root, "prepare.plan.json"), plan.planSha256)).plan.planSha256, plan.planSha256);
  const tamperedPath = path.join(fixture.root, "tampered.plan.json");
  await writeFile(tamperedPath, `${JSON.stringify({ ...plan, intendedRollbackRoot: path.join(fixture.root, "different-rollback") }, null, 2)}\n`, "utf8");
  await assert.rejects(() => loadAndVerifyGuardedPlan(tamperedPath, plan.planSha256), /canonical integrity/i);
  assert.deepEqual(await snapshotHashes(fixture.vault), before);
}));

test("production prepare is pinned to the supplied Ground Wire Gospel governance hashes", async () => withFixture(async (fixture) => {
  await assert.rejects(() => prepareGuardedLiveApply({
    packageManifest: fixture.packageManifest, vaultRoot: fixture.vault,
    rollbackRoot: path.join(fixture.root, "production-binding-rollback"), resultDirectory: path.join(fixture.root, "production-binding-results"),
    outputPath: path.join(fixture.root, "production-binding.plan.json")
  }), /governed Ground Wire Gospel/i);
}));

test("package bytes, proposal canonical fields, script hashes, decisions, dry-runs, and handoffs are fail-closed", async () => {
  const cases: Array<[string, (fixture: GuardedFixture) => Promise<void>, RegExp]> = [
    ["package artifact tampering", async (fixture) => { await writeFile(rolePath(fixture, "script"), "tampered\n", "utf8"); }, /persisted identity mismatch/i],
    ["proposal canonical tampering", async (fixture) => mutateRoleJson(fixture, "proposal", (value: LyricSourceDesignationProposal) => { value.operations[0]!.path = "tampered/project.md"; }, true), /canonical|live fields/i],
    ["stale decision", async (fixture) => mutateRoleJson(fixture, "decision", (value: AuthorityTransitionDecision) => Object.assign(value, buildReviewDecision(value.proposalId, "0".repeat(64), "approved", value.decisionTimestamp)), true), /exact proposal/i],
    ["decision not approved", async (fixture) => mutateRoleJson(fixture, "decision", (value: AuthorityTransitionDecision) => Object.assign(value, buildReviewDecision(value.proposalId, value.proposalSha256, "rejected", value.decisionTimestamp)), true), /approve/i],
    ["failed dry run", async (fixture) => mutateRoleJson(fixture, "dry-run-report", (value: LyricSourceDryRunReport) => { value.status = "failed"; value.failures = ["fixture failure"]; }, true), /dry-run/i],
    ["ineligible handoff", async (fixture) => mutateRoleJson(fixture, "handoff", (value: Record<string, unknown>) => { value.state = "blocked"; }, true), /handoff/i],
    ["executed handoff", async (fixture) => mutateRoleJson(fixture, "handoff", (value: Record<string, unknown>) => { value.applyExecuted = true; }, true), /handoff/i]
  ];
  for (const [, mutate, expected] of cases) await withFixture(async (fixture) => { await mutate(fixture); await assert.rejects(() => verifyGuardedOperatorPackage(fixture.packageManifest), expected); });
});

test("prepare refuses output paths inside the Vault and pre-existing result or rollback directories", async () => withFixture(async (fixture) => {
  await assert.rejects(() => prepareGuardedLiveApply({ packageManifest: fixture.packageManifest, vaultRoot: fixture.vault, rollbackRoot: path.join(fixture.root, "rollback-one"), resultDirectory: path.join(fixture.vault, "inside"), outputPath: path.join(fixture.root, "inside.plan.json") }, { testOnly: true, allowFixturePackage: true }), /outside the protected root/i);
  const existingResult = path.join(fixture.root, "existing-result"); await mkdir(existingResult);
  await assert.rejects(() => prepareGuardedLiveApply({ packageManifest: fixture.packageManifest, vaultRoot: fixture.vault, rollbackRoot: path.join(fixture.root, "rollback-two"), resultDirectory: existingResult, outputPath: path.join(fixture.root, "existing-result.plan.json") }, { testOnly: true, allowFixturePackage: true }), /new and unused/i);
  const existingRollback = path.join(fixture.root, "existing-rollback"); await mkdir(existingRollback);
  await assert.rejects(() => prepareGuardedLiveApply({ packageManifest: fixture.packageManifest, vaultRoot: fixture.vault, rollbackRoot: existingRollback, resultDirectory: path.join(fixture.root, "result-three"), outputPath: path.join(fixture.root, "existing-rollback.plan.json") }, { testOnly: true, allowFixturePackage: true }), /new and unused/i);
}));

test("prepare refuses linked, junction, and reparse output paths", async () => withFixture(async (fixture) => {
  const target = path.join(fixture.root, "linked-target"); await mkdir(target);
  const linked = path.join(fixture.root, "linked-output"); await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => prepareGuardedLiveApply({ packageManifest: fixture.packageManifest, vaultRoot: fixture.vault, rollbackRoot: path.join(fixture.root, "rollback-linked"), resultDirectory: path.join(linked, "result"), outputPath: path.join(fixture.root, "linked.plan.json") }, { testOnly: true, allowFixturePackage: true }), /linked|reparse/i);
}));

test("execute refuses noninteractive production use and concurrent execution locks", async () => withFixture(async (fixture) => {
  const { plan, planPath } = await preparePlan(fixture, "locks");
  await assert.rejects(() => executeGuardedLiveApply(planPath, plan.planSha256), /interactive Windows console/i);
  await writeFile(`${planPath}.execute.lock`, "occupied\n", "utf8");
  await assert.rejects(() => executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies()), /concurrent guarded execution/i);
}));

test("production invocation cannot forward AuthorizationInput or compatibility switches and binds array arguments", () => {
  const valid: GuardedScriptInvocation = { executable: "powershell.exe", cwd: "C:\\fixture", stdoutLogPath: "stdout", stderrLogPath: "stderr", args: ["-NoLogo", "-NoProfile", "-File", "apply.ps1", "-WorkflowArguments", "workflow-bootstrap.mjs"] };
  assert.doesNotThrow(() => assertProductionInvocation(valid));
  assert.equal(valid.args[valid.args.indexOf("-WorkflowArguments") + 1], "workflow-bootstrap.mjs");
  assert.throws(() => assertProductionInvocation({ ...valid, args: [...valid.args, "-AuthorizationInput", "APPLY"] }), /forbidden/i);
  assert.throws(() => assertProductionInvocation({ ...valid, args: [...valid.args, "-CompatibilityMode"] }), /forbidden/i);
});

test("Windows PowerShell 5.1 binds each sealed adapter bootstrap as one string-array element", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guarded-array-binding-"));
  try {
    const script = path.join(root, "bind.ps1");
    await writeFile(script, "[CmdletBinding()] param([string[]]$WorkflowArguments,[string[]]$ValidatorArguments) if($WorkflowArguments.Count -ne 1 -or $ValidatorArguments.Count -ne 1){throw 'array binding failed'} [pscustomobject]@{workflow=$WorkflowArguments[0];validator=$ValidatorArguments[0]} | ConvertTo-Json -Compress\n", "utf8");
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-WorkflowArguments", "workflow-bootstrap.mjs", "-ValidatorArguments", "validator-bootstrap.mjs"], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    assert.deepEqual(JSON.parse(stdout.trim()), { workflow: "workflow-bootstrap.mjs", validator: "validator-bootstrap.mjs" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixture execute persists snapshot, fresh adapters, seven writes, validator, and applied-and-validated result", async () => withFixture(async (fixture) => {
  const { plan, planPath } = await preparePlan(fixture, "success");
  const report = await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies());
  assert.equal(report.finalStatus, "applied-and-validated");
  assert.equal(report.applyExecuted, true);
  assert.equal(report.operationCount, 7);
  assert.equal(report.changedPaths.length, 7);
  assert.ok(report.lineage.preSnapshotSha256);
  assert.ok(report.lineage.preRefreshSha256);
  assert.ok(report.lineage.postRefreshSha256);
  assert.ok(report.lineage.validatorSha256);
  const snapshot = JSON.parse(await readFile(plan.expectedResultPaths.snapshot, "utf8")) as { contract: string; files: Array<{ path: string }> };
  assert.equal(snapshot.contract, "lyric-source-vault-snapshot.v1");
  assert.deepEqual(snapshot.files.map((item) => item.path), [...snapshot.files.map((item) => item.path)].sort((left, right) => left.localeCompare(right)));
}));

test("forced failures during every write index restore all seven targets with no automatic retry", async () => {
  for (let index = 1; index <= 7; index += 1) await withFixture(async (fixture) => {
    const before = await snapshotHashes(fixture.vault);
    const { plan, planPath } = await preparePlan(fixture, `write-${index}`);
    const report = await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies({ failAtWriteIndex: index }));
    assert.equal(report.finalStatus, "failed-rolled-back-and-verified");
    assert.equal(report.rollbackStatus, "restored-and-verified");
    assert.equal(report.safety.automaticRetryAttempted, false);
    assert.deepEqual(await snapshotHashes(fixture.vault), before);
  });
});

test("pre-write, post-refresh, validator, and unrelated-file failures never retry and preserve or restore the fixture", async () => {
  for (const mode of ["before-write", "post-refresh", "validator", "unrelated"] as const) await withFixture(async (fixture) => {
    const before = await snapshotHashes(fixture.vault);
    const { plan, planPath } = await preparePlan(fixture, mode);
    const report = await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies({ failStage: mode }));
    assert.equal(mode === "before-write" ? report.finalStatus === "failed-before-write" : report.finalStatus === "failed-rolled-back-and-verified", true);
    assert.equal(report.safety.automaticRetryAttempted, false);
    assert.deepEqual(await snapshotHashes(fixture.vault), before);
  });
});

test("launcher reports redact encoded payloads and the Operator Console still has no APPLY route or button", async () => withFixture(async (fixture) => {
  const { plan, planPath } = await preparePlan(fixture, "redaction");
  await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies({ failAtWriteIndex: 3 }));
  const reportText = await readFile(plan.expectedResultPaths.launcherReport, "utf8");
  assert.doesNotMatch(reportText, /contentBase64|[A-Za-z0-9+/]{200,}/);
  const routes = await readFile(path.resolve("src/operator-ui/routes.ts"), "utf8");
  const html = await readFile(path.resolve("src/operator-ui/public/index.html"), "utf8");
  assert.doesNotMatch(routes, /\/api\/(?:apply|shell|command)/i);
  assert.doesNotMatch(html, />\s*APPLY\s*</i);
}));

test("rollback corruption is detected and never causes an automatic retry", async () => withFixture(async (fixture) => {
  const before = await snapshotHashes(fixture.vault);
  const { plan, planPath } = await preparePlan(fixture, "corrupt-rollback");
  const report = await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies({ failAtWriteIndex: 3, corruptRollback: true }));
  assert.equal(report.finalStatus, "failed-rollback-unverified");
  assert.equal(report.rollbackStatus, "unverified");
  assert.equal(report.safety.automaticRetryAttempted, false);
  assert.deepEqual(await snapshotHashes(fixture.vault), before);
}));

async function preparePlan(fixture: GuardedFixture, name: string) {
  const planPath = path.join(fixture.root, `${name}.plan.json`);
  const plan = await prepareGuardedLiveApply({ packageManifest: fixture.packageManifest, vaultRoot: fixture.vault, rollbackRoot: path.join(fixture.root, `${name}-rollback`), resultDirectory: path.join(fixture.root, `${name}-results`), outputPath: planPath, generatedAt: "2026-07-23T00:00:00.000Z" }, { testOnly: true, allowFixturePackage: true });
  return { plan, planPath };
}

async function mutateRoleJson<T>(fixture: GuardedFixture, role: LyricSourceOperatorPackage["artifacts"][number]["role"], mutate: (value: T) => void, rebindManifest = false): Promise<void> {
  const filePath = rolePath(fixture, role);
  const value = JSON.parse(await readFile(filePath, "utf8")) as T;
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (rebindManifest) await rebindPackageArtifact(fixture, role);
}
async function rebindPackageArtifact(fixture: GuardedFixture, role: string): Promise<void> {
  const manifest = JSON.parse(await readFile(fixture.packageManifest, "utf8")) as LyricSourceOperatorPackage;
  const item = manifest.artifacts.find((candidate) => candidate.role === role)!;
  const bytes = await readFile(path.join(path.dirname(fixture.packageManifest), item.canonicalPath));
  item.sha256 = sha256Bytes(bytes); item.byteSize = bytes.byteLength;
  await writeFile(fixture.packageManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
function rolePath(fixture: GuardedFixture, role: string): string {
  return path.join(path.dirname(fixture.packageManifest), role === "proposal" ? "lyric-source-designation-proposal.v1.json" : role === "decision" ? "asos-authority-decision.v1.json" : role === "dry-run-report" ? "lyric-source-apply-dry-run-report.v1.json" : role === "script" ? "lyric-source-windows-apply.v1.ps1" : "lyric-source-apply-handoff.v1.json");
}
async function snapshotHashes(root: string): Promise<Record<string, string>> {
  const { captureVaultSnapshot } = await import("../src/lyric-source/independent-validation-specialist.js");
  return Object.fromEntries((await captureVaultSnapshot(root)).files.map((item) => [item.path, item.sha256]));
}
async function withFixture(action: (fixture: GuardedFixture) => Promise<void>): Promise<void> { const fixture = await createGuardedFixture(); try { await action(fixture); } finally { await disposeGuardedFixture(fixture); } }
