import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeGuardedLiveApply } from "../src/live-apply/execute.js";
import { prepareGuardedLiveApply } from "../src/live-apply/prepare.js";
import {
  createGuardedFiveOperationFixture,
  disposeGuardedFixture,
  fixtureExecutionDependencies
} from "./helpers/guarded-live-apply-fixture.js";

test("bounded five-operation package prepares and executes using its sealed operation count", async () => {
  const fixture = await createGuardedFiveOperationFixture();
  try {
    const planPath = path.join(fixture.root, "five-operation.plan.json");
    const plan = await prepareGuardedLiveApply({
      packageManifest: fixture.packageManifest,
      vaultRoot: fixture.vault,
      rollbackRoot: path.join(fixture.root, "five-operation-rollback"),
      resultDirectory: path.join(fixture.root, "five-operation-results"),
      outputPath: planPath,
      packagePolicy: "bounded-lyric-source-batch",
      generatedAt: "2026-07-24T00:00:00.000Z"
    }, { testOnly: true, allowFixturePackage: true });

    assert.equal(plan.packagePolicy, "bounded-lyric-source-batch");
    assert.equal(plan.operationPaths.length, 5);

    const report = await executeGuardedLiveApply(
      planPath,
      plan.planSha256,
      fixtureExecutionDependencies()
    );

    assert.equal(report.finalStatus, "applied-and-validated");
    assert.equal(report.applyExecuted, true);
    assert.equal(report.operationCount, 5);
    assert.equal(report.changedPaths.length, 5);
  } finally {
    await disposeGuardedFixture(fixture);
  }
});

test("bounded five-operation rollback verifies all five sealed targets", async () => {
  const fixture = await createGuardedFiveOperationFixture();
  try {
    const planPath = path.join(fixture.root, "five-operation-rollback.plan.json");
    const plan = await prepareGuardedLiveApply({
      packageManifest: fixture.packageManifest,
      vaultRoot: fixture.vault,
      rollbackRoot: path.join(fixture.root, "five-operation-forced-rollback"),
      resultDirectory: path.join(fixture.root, "five-operation-forced-results"),
      outputPath: planPath,
      packagePolicy: "bounded-lyric-source-batch",
      generatedAt: "2026-07-24T00:00:00.000Z"
    }, { testOnly: true, allowFixturePackage: true });

    const report = await executeGuardedLiveApply(
      planPath,
      plan.planSha256,
      fixtureExecutionDependencies({ failAtWriteIndex: 3 })
    );

    assert.equal(report.finalStatus, "failed-rolled-back-and-verified");
    assert.equal(report.rollbackStatus, "restored-and-verified");
    assert.equal(report.operationCount, 5);
    assert.equal(report.safety.automaticRetryAttempted, false);
  } finally {
    await disposeGuardedFixture(fixture);
  }
});

test("exact refused-before-write residue is archived before a safe retry", async () => {
  const fixture = await createGuardedFiveOperationFixture();
  try {
    const planPath = path.join(fixture.root, "five-operation-retry.plan.json");
    const resultDirectory = path.join(fixture.root, "five-operation-retry-results");
    const plan = await prepareGuardedLiveApply({
      packageManifest: fixture.packageManifest,
      vaultRoot: fixture.vault,
      rollbackRoot: path.join(fixture.root, "five-operation-retry-rollback"),
      resultDirectory,
      outputPath: planPath,
      packagePolicy: "bounded-lyric-source-batch",
      generatedAt: "2026-07-24T00:00:00.000Z"
    }, { testOnly: true, allowFixturePackage: true });

    const refusalDependencies = fixtureExecutionDependencies();
    refusalDependencies.confirmProposalId = async () => "wrong-proposal-id";
    const refused = await executeGuardedLiveApply(planPath, plan.planSha256, refusalDependencies);
    assert.equal(refused.finalStatus, "refused-before-write");
    assert.equal(refused.applyExecuted, false);

    const retried = await executeGuardedLiveApply(planPath, plan.planSha256, fixtureExecutionDependencies());
    assert.equal(retried.finalStatus, "applied-and-validated");
    assert.equal(retried.operationCount, 5);

    const archived = await readdir(`${resultDirectory}.refused-attempts`);
    assert.equal(archived.length, 1);
    assert.match(archived[0]!, /^refused-before-write-/);
  } finally {
    await disposeGuardedFixture(fixture);
  }
});
