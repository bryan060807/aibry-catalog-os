import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReadOnlyRefreshWorkflow } from "../src/asos-workflow.js";
import {
  approveCatalogAutopilot,
  catalogAutopilotCheckpointPath,
  loadCatalogAutopilotCheckpoint,
  prepareCatalogAutopilot,
  type AutopilotDependencies
} from "../src/autopilot/orchestrator.js";
import {
  planLyricSourceMigrationWorkflow,
  scoutLyricSourceBatchWorkflow
} from "../src/lyric-source/workflows.js";
import { materializeLyricSourceScoutFixture } from "./helpers/lyric-source-scout-fixture.js";

test("Autopilot prepare runs refresh, scout, and proposal then checkpoints at exact approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-autopilot-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, "full");
    const workspace = path.join(root, "autopilot-runs");
    const checkpoint = await prepareCatalogAutopilot({
      vaultRoot: fixture.vault,
      workspaceRoot: workspace,
      runId: "test-safe-batch",
      minTracks: 2,
      maxTracks: 4
    });

    assert.equal(checkpoint.state, "awaiting-approval");
    assert.equal(checkpoint.safety.liveApplyExecuted, false);
    assert.equal(checkpoint.safety.vaultMutation, "none");
    assert.ok(checkpoint.proposalBinding);
    assert.equal(checkpoint.stages.find((stage) => stage.name === "refresh")?.status, "completed");
    assert.equal(checkpoint.stages.find((stage) => stage.name === "scout")?.status, "completed");
    assert.equal(checkpoint.stages.find((stage) => stage.name === "proposal")?.status, "completed");
    assert.equal(checkpoint.stages.find((stage) => stage.name === "approval")?.status, "pending");

    const persisted = JSON.parse(await readFile(catalogAutopilotCheckpointPath(checkpoint.runDirectory), "utf8")) as { state: string };
    assert.equal(persisted.state, "awaiting-approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autopilot prepare resumes a completed pre-approval run without replacing artifact identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-autopilot-resume-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, "full");
    const options = {
      vaultRoot: fixture.vault,
      workspaceRoot: path.join(root, "autopilot-runs"),
      runId: "test-resume-batch",
      minTracks: 2,
      maxTracks: 4
    } as const;
    const first = await prepareCatalogAutopilot(options);
    const second = await prepareCatalogAutopilot(options);
    assert.equal(second.state, "awaiting-approval");
    assert.deepEqual(second.proposalBinding, first.proposalBinding);
    assert.deepEqual(second.stages, first.stages);
    const reopened = await loadCatalogAutopilotCheckpoint(second.runDirectory);
    assert.deepEqual(reopened.proposalBinding, first.proposalBinding);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autopilot approval refuses any proposal SHA-256 other than the exact checkpoint binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-autopilot-approval-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, "full");
    const checkpoint = await prepareCatalogAutopilot({
      vaultRoot: fixture.vault,
      workspaceRoot: path.join(root, "autopilot-runs"),
      runId: "test-approval-binding"
    });
    await assert.rejects(
      approveCatalogAutopilot({ runDirectory: checkpoint.runDirectory, proposalSha256: "0".repeat(64) }),
      /exact lowercase proposal SHA-256/i
    );
    const reopened = await loadCatalogAutopilotCheckpoint(checkpoint.runDirectory);
    assert.equal(reopened.state, "awaiting-approval");
    assert.equal(reopened.stages.find((stage) => stage.name === "approval")?.status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autopilot exact approval resumes through fixture, build, and sealed-plan checkpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-autopilot-approved-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, "full");
    const prepared = await prepareCatalogAutopilot({
      vaultRoot: fixture.vault,
      workspaceRoot: path.join(root, "autopilot-runs"),
      runId: "test-approved-batch"
    });
    assert.ok(prepared.proposalBinding);

    const runFixture: AutopilotDependencies["runFixture"] = async (options) => {
      const fixtureRoot = path.join(options.outputDirectory, "fixture-vault");
      const manifestPath = path.join(options.outputDirectory, "lyric-source-compatibility-fixture-manifest.v1.json");
      const workflowPath = path.join(options.outputDirectory, "asos-workflow-run.v1.json");
      await mkdir(fixtureRoot, { recursive: true });
      const manifest = {
        contract: "lyric-source-compatibility-fixture-manifest.v1",
        generatedAt: "2026-07-24T00:00:00.000Z",
        fixtureRoot
      };
      const workflow = { contract: "asos-workflow-run.v1" };
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await writeFile(workflowPath, `${JSON.stringify(workflow)}\n`, "utf8");
      return { manifest, workflow, fixtureRoot, manifestPath, workflowPath } as Awaited<ReturnType<AutopilotDependencies["runFixture"]>>;
    };

    const runBuild: AutopilotDependencies["runBuild"] = async (proposalPath, _approvalPath, _fixtureVault, dryRunPath, outputPath) => {
      const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as { proposalId: string; proposalSha256: string };
      const packageDirectory = `${outputPath}.operator-package`;
      await mkdir(path.dirname(dryRunPath), { recursive: true });
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(dryRunPath, `${JSON.stringify({ contract: "lyric-source-apply-dry-run-report.v1" })}\n`, "utf8");
      await writeFile(outputPath, "# test-only sealed PowerShell candidate\n", "utf8");
      await writeFile(
        path.join(packageDirectory, "lyric-source-operator-package.v1.json"),
        `${JSON.stringify({
          contract: "lyric-source-operator-package.v1",
          proposalId: proposal.proposalId,
          proposalSha256: proposal.proposalSha256
        })}\n`,
        "utf8"
      );
    };

    const runPreparePlan: AutopilotDependencies["runPreparePlan"] = async (options) => {
      const plan = {
        contract: "lyric-source-guarded-live-apply-plan.v1",
        planSha256: "a".repeat(64),
        packagePolicy: options.packagePolicy
      };
      await mkdir(path.dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, `${JSON.stringify(plan)}\n`, "utf8");
      return plan as Awaited<ReturnType<AutopilotDependencies["runPreparePlan"]>>;
    };

    const dependencies: AutopilotDependencies = {
      runRefresh: runReadOnlyRefreshWorkflow,
      runScout: scoutLyricSourceBatchWorkflow,
      runProposal: planLyricSourceMigrationWorkflow,
      runFixture,
      runBuild,
      runPreparePlan
    };
    const approved = await approveCatalogAutopilot({
      runDirectory: prepared.runDirectory,
      proposalSha256: prepared.proposalBinding.proposalSha256,
      decisionTimestamp: "2026-07-24T00:00:00.000Z"
    }, dependencies);

    assert.equal(approved.state, "ready-for-live-apply");
    assert.ok(approved.decisionBinding);
    assert.equal(approved.planBinding?.planSha256, "a".repeat(64));
    for (const stageName of ["approval", "fixture", "build", "plan"]) {
      assert.equal(approved.stages.find((stage) => stage.name === stageName)?.status, "completed");
    }
    const planPath = approved.stages.find((stage) => stage.name === "plan")?.artifacts[0]?.path;
    assert.ok(planPath);
    const persistedPlan = JSON.parse(await readFile(planPath, "utf8")) as { packagePolicy?: string };
    assert.equal(persistedPlan.packagePolicy, "bounded-lyric-source-batch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autopilot records a structured refusal and creates no proposal when no safe batch exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-autopilot-refusal-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, "refusal");
    const checkpoint = await prepareCatalogAutopilot({
      vaultRoot: fixture.vault,
      workspaceRoot: path.join(root, "autopilot-runs"),
      runId: "test-no-safe-batch",
      minTracks: 2,
      maxTracks: 4
    });
    assert.equal(checkpoint.state, "refused");
    assert.ok(checkpoint.refusal);
    assert.equal(checkpoint.proposalBinding, null);
    assert.equal(checkpoint.stages.find((stage) => stage.name === "proposal")?.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
