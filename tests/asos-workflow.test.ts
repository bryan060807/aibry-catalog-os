import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { routeAssetInspectionFinding, runReadOnlyRefreshWorkflow } from "../src/asos-workflow.js";
import type { ReadOnlyRefreshWorkflowSummary } from "../src/asos-workflow.js";

test("ASOS workflow read-only-refresh orchestrates specialists and writes lineage artifacts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-"));
  const vault = path.join(workspace, "vault");
  const summaryPath = path.join(workspace, "read-only-refresh.json");
  try {
    await setupVault(vault);
    const summary = await runReadOnlyRefreshWorkflow(vault, summaryPath);
    assert.equal(summary.contract, "asos-workflow-read-only-refresh.v1");
    assert.equal(summary.workflow, "read-only-refresh");
    assert.equal(summary.authority.specialist, "ASOS Kernel / Workflow Orchestrator");
    assert.equal(summary.authority.authorityMode, "ORCHESTRATE");
    assert.equal(summary.authority.vaultMutation, "none");
    assert.equal(summary.reviewStateMode, "fresh-unreviewed-snapshot");
    assert.equal(summary.safety.applyEnabled, false);
    assert.equal(summary.safety.reviewInboxIntegration, "catalog-findings-only");
    assert.equal(summary.safety.assetFindingPolicy, "routed-for-kernel-context-not-direct-inbox");
    assert.equal(summary.counts.managedSongs, 1);
    assert.equal(summary.counts.assetProjects, 1);
    assert.ok(summary.counts.assetRecords >= 6);
    assert.equal(summary.counts.reviewApproved, 0);
    assert.equal(summary.counts.pendingApply, 0);
    assert.equal(summary.artifacts.length, 5);
    assert.ok(summary.artifacts.every((artifact) => artifact.sha256.length === 64));
    assert.deepEqual(summary.steps.map((step) => step.name), ["contract", "catalog-index", "asset-inspection", "finding-router", "review-inbox", "operation-journal"]);
    assert.ok(summary.findingRoutes.some((route) => route.route === "evidence-only" && route.count > 0));
    assert.ok(summary.findingRoutes.some((route) => route.route === "blocks-existing-proposal" && route.count > 0));
    assert.ok(summary.findingRoutes.some((route) => route.route === "reviewable" && route.count > 0));

    const persisted = JSON.parse(await readFile(summaryPath, "utf8")) as ReadOnlyRefreshWorkflowSummary;
    assert.equal(persisted.contract, "asos-workflow-read-only-refresh.v1");
    for (const artifact of persisted.artifacts) {
      assert.ok(await fileExists(artifact.path), `Expected artifact to exist: ${artifact.path}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog workflow read-only-refresh writes the kernel summary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-"));
  const vault = path.join(workspace, "vault");
  const summaryPath = path.join(workspace, "workflow-summary.json");
  try {
    await setupVault(vault);
    await main(["catalog", "workflow", "read-only-refresh", "--vault", vault, "--output", summaryPath]);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as ReadOnlyRefreshWorkflowSummary;
    assert.equal(summary.contract, "asos-workflow-read-only-refresh.v1");
    assert.equal(summary.counts.managedSongs, 1);
    assert.equal(summary.counts.pendingApply, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog workflow read-only-refresh refuses to write inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-"));
  const vault = path.join(workspace, "vault");
  const outputInsideVault = path.join(vault, "workflow-summary.json");
  try {
    await setupVault(vault);
    await assert.rejects(
      () => main(["catalog", "workflow", "read-only-refresh", "--vault", vault, "--output", outputInsideVault]),
      /Refusing to write discovery output inside the vault/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ASOS workflow routes Asset Inspector findings without direct inbox promotion", () => {
  assert.equal(routeAssetInspectionFinding({ type: "media-info-audio-evidence", severity: "info", status: "observed", evidencePaths: [], requiredEvidence: [], summary: "" }), "evidence-only");
  assert.equal(routeAssetInspectionFinding({ type: "release-admin-empty", severity: "info", status: "observed", evidencePaths: [], requiredEvidence: [], summary: "" }), "evidence-only");
  assert.equal(routeAssetInspectionFinding({ type: "canonical-lyric-unresolved", severity: "low", status: "blocked-insufficient-evidence", evidencePaths: [], requiredEvidence: [], summary: "" }), "blocks-existing-proposal");
  assert.equal(routeAssetInspectionFinding({ type: "provenance-insufficient", severity: "low", status: "blocked-insufficient-evidence", evidencePaths: [], requiredEvidence: [], summary: "" }), "blocks-existing-proposal");
  assert.equal(routeAssetInspectionFinding({ type: "multiple-audio-variants", severity: "info", status: "observed", evidencePaths: [], requiredEvidence: [], summary: "" }), "reviewable");
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function setupVault(vault: string): Promise<void> {
  const project = path.join(vault, "project-memory", "music", "singles", "kernel-song");
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(path.join(project, "lyrics"), { recursive: true });
  await mkdir(path.join(project, "audio"), { recursive: true });
  await mkdir(path.join(project, "metadata"), { recursive: true });
  await mkdir(path.join(project, "artwork"), { recursive: true });
  await mkdir(path.join(project, "licensing"), { recursive: true });
  await mkdir(path.join(project, "release-admin"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
  await writeFile(path.join(project, "project.md"), "# Kernel Song\n\nKnown source lyric path: Not yet established.\n", "utf8");
  await writeFile(path.join(project, "lyrics", "kernel-song.txt"), "lyric candidate\n", "utf8");
  await writeFile(path.join(project, "audio", "kernel-song-mastered.wav"), "mastered audio bytes\n", "utf8");
  await writeFile(path.join(project, "audio", "kernel-song-alt-version-1.wav"), "alt audio bytes\n", "utf8");
  await writeFile(path.join(project, "metadata", "kernel-song-mastered-media-info.txt"), "media info mastered\n", "utf8");
  await writeFile(path.join(project, "metadata", "kernel-song-alt-version-1-media-info.txt"), "media info alt\n", "utf8");
  await writeFile(path.join(project, "artwork", "cover.png"), "png bytes\n", "utf8");
  await writeFile(path.join(project, "licensing", "rights-note.md"), "rights note\n", "utf8");
}
