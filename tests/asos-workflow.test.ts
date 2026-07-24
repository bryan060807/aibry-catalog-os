import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { routeAssetInspectionFinding, runReadOnlyRefreshWorkflow } from "../src/asos-workflow.js";
import type { AssetFindingRoutesArtifact, ReadOnlyRefreshWorkflowSummary } from "../src/asos-workflow.js";
import type { ReviewInbox } from "../src/review-inbox.js";

test("ASOS workflow read-only-refresh v1.1 writes hashed lineage and routed findings", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-"));
  const vault = path.join(workspace, "vault");
  const summaryPath = path.join(workspace, "read-only-refresh.json");
  try {
    await setupVault(vault);
    const summary = await runReadOnlyRefreshWorkflow(vault, summaryPath);
    assert.equal(summary.contract, "asos-workflow-read-only-refresh.v1.1");
    assert.equal(summary.workflow, "read-only-refresh");
    assert.equal(summary.authority.specialist, "ASOS Kernel / Workflow Orchestrator");
    assert.equal(summary.authority.authorityMode, "ORCHESTRATE");
    assert.equal(summary.authority.vaultMutation, "none");
    assert.equal(summary.reviewStateMode, "fresh-unreviewed-snapshot");
    assert.equal(summary.source.decisionsPath, null);
    assert.equal(summary.safety.applyEnabled, false);
    assert.equal(summary.safety.reviewInboxIntegration, "catalog-findings-only");
    assert.equal(summary.safety.assetFindingPolicy, "routed-outside-inbox-unless-eligible-for-proposal");
    assert.equal(summary.counts.managedSongs, 1);
    assert.equal(summary.counts.assetProjects, 1);
    assert.ok(summary.counts.assetRecords >= 6);
    assert.equal(summary.counts.reviewApproved, 0);
    assert.equal(summary.counts.reviewRejected, 0);
    assert.equal(summary.counts.reviewDeferred, 0);
    assert.equal(summary.counts.pendingApply, 0);
    assert.equal(summary.artifacts.length, 6);
    assert.ok(summary.artifacts.every((artifact) => artifact.sha256.length === 64));
    assert.ok(summary.artifacts.every((artifact) => artifact.role === "output"));
    assert.deepEqual(summary.steps.map((step) => step.name), ["contract", "catalog-index", "asset-inspection", "finding-router", "review-inbox", "operation-journal"]);
    assert.ok(summary.findingRoutes.some((route) => route.route === "evidence-only" && route.count > 0));
    assert.ok(summary.findingRoutes.some((route) => route.route === "blocks-existing-proposal" && route.count > 0));
    assert.ok(summary.findingRoutes.some((route) => route.route === "reviewable" && route.count > 0));
    assert.ok(summary.findingRoutes.some((route) => route.route === "eligible-for-proposal" && route.count === 0));

    const routesArtifact = summary.artifacts.find((artifact) => artifact.name === "asset-finding-routes");
    assert.ok(routesArtifact);
    const routes = JSON.parse(await readFile(routesArtifact.path, "utf8")) as AssetFindingRoutesArtifact;
    assert.equal(routes.contract, "asset-finding-routes.v1");
    const assetInspectionArtifact = summary.artifacts.find((artifact) => artifact.name === "asset-inspection");
    assert.ok(assetInspectionArtifact);
    assert.equal(routes.source.assetInspectionSha256, assetInspectionArtifact.sha256);
    assert.equal(routes.routes.length, summary.counts.assetFindings);
    assert.ok(routes.routes.every((finding) => finding.routingRule === "asos-finding-routing.v1"));
    assert.ok(routes.routes.every((finding) => finding.projectPath.length > 0));
    assert.ok(routes.routes.every((finding) => finding.reason.length > 0));
    assert.ok(routes.routes.every((finding) => Array.isArray(finding.evidencePaths)));

    const persisted = JSON.parse(await readFile(summaryPath, "utf8")) as ReadOnlyRefreshWorkflowSummary;
    assert.equal(persisted.contract, "asos-workflow-read-only-refresh.v1.1");
    for (const artifact of persisted.artifacts) {
      assert.ok(await fileExists(artifact.path), `Expected artifact to exist: ${artifact.path}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ASOS workflow preserves review decisions and hashes the decisions input", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-decisions-"));
  const vault = path.join(workspace, "vault");
  const initialSummaryPath = path.join(workspace, "initial.json");
  const decidedSummaryPath = path.join(workspace, "decided.json");
  const decisionsPath = path.join(workspace, "review-decisions.json");
  try {
    await setupVault(vault);
    await setupAdditionalManagedSong(vault, "decision-song-two");
    await setupAdditionalManagedSong(vault, "decision-song-three");
    const initial = await runReadOnlyRefreshWorkflow(vault, initialSummaryPath);
    const initialInboxPath = initial.artifacts.find((artifact) => artifact.name === "review-inbox")?.path;
    assert.ok(initialInboxPath);
    const initialInbox = JSON.parse(await readFile(initialInboxPath, "utf8")) as ReviewInbox;
    const [approvedProposal, rejectedProposal, deferredProposal] = initialInbox.proposals;
    assert.ok(approvedProposal, "Expected an approved-state proposal fixture");
    assert.ok(rejectedProposal, "Expected a rejected-state proposal fixture");
    assert.ok(deferredProposal, "Expected a deferred-state proposal fixture");

    const decisions = [
      { proposalId: approvedProposal.proposalId, state: "approved" },
      { proposalId: rejectedProposal.proposalId, state: "rejected" },
      { proposalId: deferredProposal.proposalId, state: "deferred" }
    ];
    await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, "utf8");

    const summary = await runReadOnlyRefreshWorkflow(vault, decidedSummaryPath, decisionsPath);
    assert.equal(summary.reviewStateMode, "preserved-decisions");
    assert.equal(summary.source.decisionsPath, path.resolve(decisionsPath));
    assert.equal(summary.counts.reviewApproved, 1);
    assert.equal(summary.counts.reviewRejected, 1);
    assert.equal(summary.counts.reviewDeferred, 1);

    const decisionsArtifact = summary.artifacts.find((artifact) => artifact.name === "review-decisions");
    assert.ok(decisionsArtifact);
    assert.equal(decisionsArtifact.role, "input");
    assert.equal(decisionsArtifact.contract, "review-decisions.v1");
    assert.equal(decisionsArtifact.path, path.resolve(decisionsPath));
    assert.equal(decisionsArtifact.sha256, createHash("sha256").update(await readFile(decisionsPath)).digest("hex"));

    const inboxPath = summary.artifacts.find((artifact) => artifact.name === "review-inbox")?.path;
    assert.ok(inboxPath);
    const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as ReviewInbox;
    assert.equal(inbox.counts.approved, 1);
    assert.equal(inbox.counts.rejected, 1);
    assert.equal(inbox.counts.deferred, 1);
    assert.equal(inbox.proposals.find((proposal) => proposal.proposalId === approvedProposal.proposalId)?.state, "approved");
    assert.equal(inbox.proposals.find((proposal) => proposal.proposalId === rejectedProposal.proposalId)?.state, "rejected");
    assert.equal(inbox.proposals.find((proposal) => proposal.proposalId === deferredProposal.proposalId)?.state, "deferred");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog workflow read-only-refresh accepts optional decisions", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-cli-"));
  const vault = path.join(workspace, "vault");
  const baselinePath = path.join(workspace, "baseline.json");
  const summaryPath = path.join(workspace, "workflow-summary.json");
  const decisionsPath = path.join(workspace, "decisions.json");
  try {
    await setupVault(vault);
    const baseline = await runReadOnlyRefreshWorkflow(vault, baselinePath);
    const inboxPath = baseline.artifacts.find((artifact) => artifact.name === "review-inbox")?.path;
    assert.ok(inboxPath);
    const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as ReviewInbox;
    const proposal = inbox.proposals[0];
    assert.ok(proposal);
    await writeFile(decisionsPath, `${JSON.stringify([{ proposalId: proposal.proposalId, state: "approved" }], null, 2)}\n`, "utf8");

    await main(["catalog", "workflow", "read-only-refresh", "--vault", vault, "--output", summaryPath, "--decisions", decisionsPath]);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as ReadOnlyRefreshWorkflowSummary;
    assert.equal(summary.contract, "asos-workflow-read-only-refresh.v1.1");
    assert.equal(summary.reviewStateMode, "preserved-decisions");
    assert.equal(summary.counts.reviewApproved, 1);
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

test("ASOS workflow rejects review decisions stored inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-vault-decisions-"));
  const vault = path.join(workspace, "vault");
  const summaryPath = path.join(workspace, "summary.json");
  const decisionsPath = path.join(vault, "review-decisions.json");
  try {
    await setupVault(vault);
    await writeFile(decisionsPath, "[]\n", "utf8");
    await assert.rejects(
      () => runReadOnlyRefreshWorkflow(vault, summaryPath, decisionsPath),
      /Refusing to use review decisions inside the vault/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ASOS workflow rejects duplicate and stale review decisions", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asos-workflow-invalid-decisions-"));
  const vault = path.join(workspace, "vault");
  const baselinePath = path.join(workspace, "baseline.json");
  const summaryPath = path.join(workspace, "summary.json");
  const decisionsPath = path.join(workspace, "review-decisions.json");
  try {
    await setupVault(vault);
    const baseline = await runReadOnlyRefreshWorkflow(vault, baselinePath);
    const inboxPath = baseline.artifacts.find((artifact) => artifact.name === "review-inbox")?.path;
    assert.ok(inboxPath);
    const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as ReviewInbox;
    const proposal = inbox.proposals[0];
    assert.ok(proposal);

    await writeFile(decisionsPath, `${JSON.stringify([
      { proposalId: proposal.proposalId, state: "approved" },
      { proposalId: proposal.proposalId, state: "deferred" },
      { proposalId: "proposal:stale-finding", state: "rejected" }
    ], null, 2)}\n`, "utf8");

    await assert.rejects(
      () => runReadOnlyRefreshWorkflow(vault, summaryPath, decisionsPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /duplicate proposal IDs/);
        assert.match(error.message, /unknown or stale proposal IDs/);
        return true;
      }
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

async function setupAdditionalManagedSong(vault: string, slug: string): Promise<void> {
  const project = path.join(vault, "project-memory", "music", "singles", slug);
  await mkdir(path.join(project, "lyrics"), { recursive: true });
  await mkdir(path.join(project, "audio"), { recursive: true });
  await mkdir(path.join(project, "metadata"), { recursive: true });
  await mkdir(path.join(project, "artwork"), { recursive: true });
  await mkdir(path.join(project, "licensing"), { recursive: true });
  await mkdir(path.join(project, "release-admin"), { recursive: true });
  await writeFile(path.join(project, "project.md"), `# ${slug}\n\nKnown source lyric path: Not yet established.\n`, "utf8");
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
