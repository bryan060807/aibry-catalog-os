import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveCatalogAutopilot, catalogAutopilotCheckpointPath, loadCatalogAutopilotCheckpoint, prepareCatalogAutopilot } from "../src/autopilot/orchestrator.js";
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
