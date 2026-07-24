import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalFilename } from "../src/artifacts/handoff-specialist.js";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import { buildReviewDecision } from "../src/lyric-source/approval.js";
import {
  materializeLyricSourceCompatibilityFixture,
  verifyCompatibilityFixtureManifest
} from "../src/lyric-source/compatibility-fixture-builder.js";
import type { LyricSourceBatchScoutReport, LyricSourcePlanningInput } from "../src/lyric-source/contracts.js";
import { compileLyricSourceProposal } from "../src/lyric-source/proposal-specialist.js";
import {
  materializeLyricSourceCompatibilityFixtureWorkflow,
  planLyricSourceMigrationWorkflow,
  scoutLyricSourceBatchWorkflow
} from "../src/lyric-source/workflows.js";
import { describeSpecialist } from "../src/specialists/registry.js";
import { materializeGroundWireGospelFixture } from "./helpers/lyric-source-scout-fixture.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type GovernedFixture = {
  reportsRoot: string;
  scoutReportPath: string;
  planningInputPath: string;
  proposalPath: string;
  decisionPath: string;
};

test("compatibility fixture builder is registered as OBSERVE-only with no live Vault capability", () => {
  const specialist = describeSpecialist("lyric-source-compatibility-fixture-builder");
  assert.ok(specialist);
  assert.equal(specialist.name, "Lyric Source Compatibility Fixture Builder");
  assert.deepEqual(specialist.authorityModes, ["OBSERVE"]);
  assert.equal(specialist.musicVaultReadAllowed, false);
  assert.equal(specialist.musicVaultWriteAllowed, false);
  assert.equal(specialist.humanAuthorizationRequired, false);
  assert.deepEqual(specialist.emittedOutputContracts, ["lyric-source-compatibility-fixture-manifest.v1", "asos-workflow-run.v1"]);
});

test("fixture workflow materializes the exact pre-APPLY boundary and repeats the same snapshot", async () => {
  await withGovernedFixture(async (fixture, root) => {
    const first = await materializeLyricSourceCompatibilityFixtureWorkflow({
      ...fixture,
      outputDirectory: path.join(fixture.reportsRoot, "compatibility", "run-one")
    });
    const second = await materializeLyricSourceCompatibilityFixtureWorkflow({
      ...fixture,
      outputDirectory: path.join(fixture.reportsRoot, "compatibility", "run-two")
    });
    assert.equal(first.manifest.fixtureSnapshotSha256, second.manifest.fixtureSnapshotSha256);
    assert.equal(first.manifest.materializedFiles.length, 18);
    assert.equal(first.manifest.operationTargets.length, 7);
    assert.equal(first.manifest.evidenceFiles.length, 8);
    assert.equal(first.manifest.guardFiles.length, 2);
    assert.equal(first.manifest.decodedPayloadChecks.checkedPayloadCount, 17);
    assert.equal(first.manifest.duplicatePathChecks.identicalDuplicatesDeduplicated, 0);
    assert.equal(first.workflow.workflow, "materialize-lyric-source-compatibility-fixture");
    assert.equal(first.workflow.specialist.authorityMode, "OBSERVE");
    assert.equal(first.workflow.safety.vaultMutation, "none");
    assert.equal(first.manifest.safety.liveVaultAccess, false);
    assert.equal(first.manifest.safety.applyExecuted, false);
    assert.ok(first.manifest.proposal.proposalId.includes("ground-wire-gospel"));
    const proposal = compileLyricSourceProposal(JSON.parse(await readFile(fixture.planningInputPath, "utf8")) as LyricSourcePlanningInput);
    for (const operation of proposal.operations) {
      const live = await readFile(path.join(first.fixtureRoot, ...operation.path.split("/")));
      assert.equal(sha256Bytes(live), operation.currentSha256);
      if (operation.currentSha256 !== operation.proposedSha256) assert.notEqual(sha256Bytes(live), operation.proposedSha256);
    }
    await verifyCompatibilityFixtureManifest(first.manifestPath);
    await access(first.workflowPath);
    assert.equal(path.resolve(first.fixtureRoot).startsWith(path.resolve(fixture.reportsRoot)), true);
    assert.equal(path.resolve(first.fixtureRoot).startsWith(path.resolve(root, "source", "fixture-vault")), false);
  });
});

test("materialize-lyric-source-compatibility-fixture CLI emits the governed reports-local artifacts", async () => {
  await withGovernedFixture(async (fixture) => {
    const outputDirectory = path.join(fixture.reportsRoot, "compatibility", "cli-run");
    const command = await execFileAsync(process.execPath, [
      cliPath,
      "catalog", "workflow", "materialize-lyric-source-compatibility-fixture",
      "--scout-report", fixture.scoutReportPath,
      "--planning-input", fixture.planningInputPath,
      "--proposal", fixture.proposalPath,
      "--decision", fixture.decisionPath,
      "--output-directory", outputDirectory
    ], { cwd: path.dirname(fixture.reportsRoot), timeout: 120_000 });
    const summary = JSON.parse(command.stdout) as { status: string; materializedFileCount: number; fixtureSnapshotSha256: string; applyExecuted: boolean };
    assert.equal(summary.status, "passed");
    assert.equal(summary.materializedFileCount, 18);
    assert.match(summary.fixtureSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.applyExecuted, false);
    await access(path.join(outputDirectory, "fixture-vault", ".asos-fixture-vault"));
    await access(path.join(outputDirectory, canonicalFilename("lyric-source-compatibility-fixture-manifest.v1")));
    await access(path.join(outputDirectory, canonicalFilename("asos-workflow-run.v1")));
  });
});

test("scout, planning input, proposal recompilation, and approved decision lineage are exact", async () => {
  await withGovernedFixture(async (fixture) => {
    const scout = JSON.parse(await readFile(fixture.scoutReportPath, "utf8")) as LyricSourceBatchScoutReport;
    scout.planningInputSha256 = "0".repeat(64);
    await writeJson(fixture.scoutReportPath, scout);
    await assert.rejects(() => runBuilder(fixture, "bad-scout"), /does not bind the exact persisted planning input/i);
  });
  await withGovernedFixture(async (fixture) => {
    const planning = JSON.parse(await readFile(fixture.planningInputPath, "utf8")) as LyricSourcePlanningInput;
    planning.preconditions = [...planning.preconditions, "Tampered planning condition."];
    await writeJson(fixture.planningInputPath, planning);
    await rebindScoutToPlanning(fixture);
    await assert.rejects(() => runBuilder(fixture, "stale-proposal"), /recompilation does not match/i);
  });
  await withGovernedFixture(async (fixture) => {
    const proposal = JSON.parse(await readFile(fixture.proposalPath, "utf8")) as { operations: Array<{ path: string }> };
    proposal.operations[0]!.path = "tampered/project.md";
    await writeJson(fixture.proposalPath, proposal);
    await assert.rejects(() => runBuilder(fixture, "tampered-proposal"), /canonical|payload|proposal/i);
  });
  await withGovernedFixture(async (fixture) => {
    const decision = JSON.parse(await readFile(fixture.decisionPath, "utf8")) as { decisionState: string };
    decision.decisionState = "deferred";
    await writeJson(fixture.decisionPath, decision);
    await assert.rejects(() => runBuilder(fixture, "bad-decision"), /decision|structural/i);
  });
});

test("missing, contradictory, case-colliding, and traversal payloads are refused", async () => {
  await withGovernedFixture(async (fixture) => {
    await rewritePlanningLineage(fixture, (planning) => {
      const included = planning.projects.find((project) => project.include);
      if (!included) throw new Error("Fixture included project missing.");
      included.controlFile = null;
    }, false);
    await assert.rejects(() => runBuilder(fixture, "missing-current"), /lacks source, managed, or control-file evidence|missing/i);
  });
  await withGovernedFixture(async (fixture) => {
    await rewritePlanningLineage(fixture, (planning) => {
      const source = planning.projects.find((project) => project.include)?.source;
      if (!source) throw new Error("Fixture source missing.");
      planning.guardFiles[0] = { ...planning.guardFiles[0]!, path: source.path };
    });
    await assert.rejects(() => runBuilder(fixture, "contradictory-duplicate"), /contradictory duplicate/i);
  });
  await withGovernedFixture(async (fixture) => {
    await rewritePlanningLineage(fixture, (planning) => {
      const source = planning.projects.find((project) => project.include)?.source;
      if (!source) throw new Error("Fixture source missing.");
      planning.guardFiles[0] = { ...planning.guardFiles[0]!, path: source.path.toUpperCase() };
    });
    await assert.rejects(() => runBuilder(fixture, "case-collision"), /case-colliding/i);
  });
  await withGovernedFixture(async (fixture) => {
    await rewritePlanningLineage(fixture, (planning) => {
      planning.guardFiles[0] = { ...planning.guardFiles[0]!, path: "../escape.md" };
    }, false);
    await assert.rejects(() => runBuilder(fixture, "traversal"), /dot segments|contract path|escape/i);
  });
});

test("identical duplicate paths are safely deduplicated", async () => {
  await withGovernedFixture(async (fixture) => {
    await rewritePlanningLineage(fixture, (planning) => {
      const source = planning.projects.find((project) => project.include)?.source;
      if (!source) throw new Error("Fixture source missing.");
      planning.guardFiles[0] = { ...source };
    });
    const result = await runBuilder(fixture, "identical-duplicate");
    assert.equal(result.manifest.duplicatePathChecks.identicalDuplicatesDeduplicated, 1);
    assert.equal(result.manifest.materializedFiles.length, 17);
    assert.equal(result.manifest.guardFiles.length, 2);
  });
});

test("linked outputs and live Vault paths are refused before materialization", async () => {
  await withGovernedFixture(async (fixture, root) => {
    const linkedTarget = path.join(root, "linked-target");
    await mkdir(linkedTarget, { recursive: true });
    const linkedParent = path.join(fixture.reportsRoot, "linked-output");
    await symlink(linkedTarget, linkedParent, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => materializeLyricSourceCompatibilityFixture({
      ...fixture,
      outputDirectory: path.join(linkedParent, "fixture")
    }), /linked|reparse/i);
    await assert.rejects(() => materializeLyricSourceCompatibilityFixture({
      ...fixture,
      scoutReportPath: "C:\\AIBRY\\music-vault\\forbidden.json",
      outputDirectory: path.join(fixture.reportsRoot, "live-path-refusal")
    }), /refuses every live Music Vault path/i);
    assert.equal(await exists(path.join(fixture.reportsRoot, "live-path-refusal")), false);
  });
});

test("forced failures leave no output directory that Build Script could accept", async () => {
  await withGovernedFixture(async (fixture) => {
    const outputDirectory = path.join(fixture.reportsRoot, "compatibility", "forced-failure");
    await assert.rejects(() => materializeLyricSourceCompatibilityFixture({
      ...fixture,
      outputDirectory,
      failAfterMaterializedFileCount: 3
    }), /forced compatibility fixture failure/i);
    assert.equal(await exists(outputDirectory), false);
  });
});

async function withGovernedFixture(action: (fixture: GovernedFixture, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-compatibility-fixture-test-"));
  try {
    const fixture = await prepareGovernedFixture(root);
    await action(fixture, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareGovernedFixture(root: string): Promise<GovernedFixture> {
  const source = await materializeGroundWireGospelFixture(path.join(root, "source"));
  const scout = await scoutLyricSourceBatchWorkflow({
    vaultRoot: source.vault,
    refreshReportPath: source.refreshReportPath,
    outputDirectory: path.join(source.reportsRoot, "governed", "scout"),
    minTracks: 2,
    maxTracks: 4
  });
  if (!scout.planningInputPath) throw new Error("Ground Wire fixture did not produce a planning input.");
  const proposalPath = path.join(source.reportsRoot, "governed", "proposal", canonicalFilename("lyric-source-designation-proposal.v1"));
  const proposal = await planLyricSourceMigrationWorkflow(scout.planningInputPath, proposalPath);
  const decisionPath = path.join(path.dirname(proposalPath), canonicalFilename("asos-authority-decision.v1"));
  await writeJson(decisionPath, buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt));
  return {
    reportsRoot: source.reportsRoot,
    scoutReportPath: scout.reportPath,
    planningInputPath: scout.planningInputPath,
    proposalPath,
    decisionPath
  };
}

async function runBuilder(fixture: GovernedFixture, name: string) {
  return materializeLyricSourceCompatibilityFixtureWorkflow({
    ...fixture,
    outputDirectory: path.join(fixture.reportsRoot, "compatibility", name)
  });
}

async function rewritePlanningLineage(fixture: GovernedFixture, mutate: (planning: LyricSourcePlanningInput) => void, recompile = true): Promise<void> {
  const planning = JSON.parse(await readFile(fixture.planningInputPath, "utf8")) as LyricSourcePlanningInput;
  mutate(planning);
  await writeJson(fixture.planningInputPath, planning);
  await rebindScoutToPlanning(fixture);
  if (!recompile) return;
  const proposal = compileLyricSourceProposal(planning);
  await writeJson(fixture.proposalPath, proposal);
  await writeJson(fixture.decisionPath, buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt));
}

async function rebindScoutToPlanning(fixture: GovernedFixture): Promise<void> {
  const scout = JSON.parse(await readFile(fixture.scoutReportPath, "utf8")) as LyricSourceBatchScoutReport;
  scout.planningInputSha256 = sha256Bytes(await readFile(fixture.planningInputPath));
  scout.planningInputPath = fixture.planningInputPath;
  await writeJson(fixture.scoutReportPath, scout);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
