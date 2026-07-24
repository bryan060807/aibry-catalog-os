import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureVaultSnapshot, validateLyricSourceApplyFromPaths } from "../src/lyric-source/independent-validation-specialist.js";
import { compileLyricSourceProposal } from "../src/lyric-source/proposal-specialist.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

test("Independent Validation Specialist verifies persisted hashes, resolver records, counts, guards, and kernel safety", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lyric-independent-validator-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const proposalPath = path.join(root, "proposal.json");
  const snapshotPath = path.join(root, "snapshot.json");
  const workflowPath = path.join(root, "workflow.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal)}\n`, "utf8");
  await writeFile(snapshotPath, `${JSON.stringify(await captureVaultSnapshot(fixture.vault))}\n`, "utf8");
  for (const operation of proposal.operations) {
    await writeFile(path.join(fixture.vault, ...operation.path.split("/")), Buffer.from(operation.contentBase64, "base64"));
  }
  await writeFile(workflowPath, `${JSON.stringify(workflowEvidence(proposal))}\n`, "utf8");
  const report = await validateLyricSourceApplyFromPaths(proposalPath, fixture.vault, snapshotPath, workflowPath, proposal.generatedAt);
  assert.equal(report.status, "passed");
  assert.equal(report.counts.failed, 0);
  assert.equal(report.persistedArtifactsOnly, true);
  assert.equal(report.safety.pendingApply, 0);
  assert.equal(report.safety.applyEnabled, false);
  assert.equal(report.safety.vaultMutation, "none");
});

test("Independent Validation Specialist rejects a stale target hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lyric-independent-stale-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const proposalPath = path.join(root, "proposal.json");
  const snapshotPath = path.join(root, "snapshot.json");
  const workflowPath = path.join(root, "workflow.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal)}\n`, "utf8");
  await writeFile(snapshotPath, `${JSON.stringify(await captureVaultSnapshot(fixture.vault))}\n`, "utf8");
  for (const operation of proposal.operations) {
    await writeFile(path.join(fixture.vault, ...operation.path.split("/")), Buffer.from(operation.contentBase64, "base64"));
  }
  const stale = proposal.operations[0];
  assert.ok(stale);
  await writeFile(path.join(fixture.vault, ...stale.path.split("/")), "stale bytes\n", "utf8");
  await writeFile(workflowPath, `${JSON.stringify(workflowEvidence(proposal))}\n`, "utf8");
  const report = await validateLyricSourceApplyFromPaths(proposalPath, fixture.vault, snapshotPath, workflowPath, proposal.generatedAt);
  assert.equal(report.status, "failed");
  assert.equal(report.checks.find((check) => check.name === `proposed-hash:${stale.path}`)?.passed, false);
  assert.equal((await readFile(proposalPath, "utf8")).includes(proposal.proposalSha256), true);
});

function workflowEvidence(proposal: ReturnType<typeof compileLyricSourceProposal>) {
  return {
    contract: "asos-workflow-read-only-refresh.v1.1",
    counts: { catalogFindings: proposal.expectedCounts.catalogFindings, assetFindings: proposal.expectedCounts.assetFindings, pendingApply: 0 },
    findingRoutes: Object.entries(proposal.expectedCounts.routedFindings).map(([route, count]) => ({ route, count })),
    resolverRecords: proposal.resolverExpectedProjects.map((projectPath) => ({ projectPath: projectPath.replace(/\//g, "\\"), state: "verified" })),
    safety: { applyEnabled: false, vaultMutation: "none" }
  };
}
