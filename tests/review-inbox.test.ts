import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { MANAGED_SONG_CONTRACT_V1 } from "../src/catalog/contract.js";
import type { CatalogIndex } from "../src/catalog/publish.js";
import { buildReviewInbox } from "../src/review-inbox.js";
import type { ReviewInbox } from "../src/review-inbox.js";

test("Review Inbox turns index findings into pending proposals", () => {
  const inbox = buildReviewInbox(sampleCatalogIndex());
  assert.equal(inbox.schemaVersion, "review-inbox.v1");
  assert.equal(inbox.authority.specialist, "Review Inbox");
  assert.equal(inbox.authority.authorityMode, "PROPOSE");
  assert.equal(inbox.authority.vaultMutation, "none");
  assert.equal(inbox.source.indexSchemaVersion, "catalog-index.v1");
  assert.equal(inbox.source.managedSongContractVersion, "managed-song-contract.v1");
  assert.equal(inbox.counts.total, 2);
  assert.equal(inbox.counts.pending, 2);
  assert.equal(inbox.counts.approved, 0);
  assert.equal(inbox.proposals[0]?.proposalId, "proposal:provenance-signal-fire");
  assert.equal(inbox.proposals[0]?.requiredApproval, true);
  assert.ok(inbox.proposals[0]?.applyBoundary.includes("No vault mutation"));
});

test("Review Inbox applies existing decision states without mutating proposals", () => {
  const decisions = new Map([
    ["proposal:provenance-signal-fire", "approved" as const],
    ["proposal:front-door-open-door", "deferred" as const]
  ]);
  const inbox = buildReviewInbox(sampleCatalogIndex(), decisions);
  assert.equal(inbox.counts.pending, 0);
  assert.equal(inbox.counts.approved, 1);
  assert.equal(inbox.counts.deferred, 1);
  assert.equal(inbox.proposals.find((proposal) => proposal.proposalId === "proposal:provenance-signal-fire")?.state, "approved");
});

test("catalog review-inbox writes proposals from an index and decision file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "review-inbox-"));
  const indexPath = path.join(workspace, "catalog-index.json");
  const decisionsPath = path.join(workspace, "decisions.json");
  const outputPath = path.join(workspace, "review-inbox.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(indexPath, `${JSON.stringify(sampleCatalogIndex(), null, 2)}\n`, "utf8");
    await writeFile(decisionsPath, `${JSON.stringify([{ proposalId: "proposal:provenance-signal-fire", state: "approved" }], null, 2)}\n`, "utf8");
    await main(["catalog", "review-inbox", "--index", indexPath, "--output", outputPath, "--decisions", decisionsPath]);
    const inbox = JSON.parse(await readFile(outputPath, "utf8")) as ReviewInbox;
    assert.equal(inbox.schemaVersion, "review-inbox.v1");
    assert.equal(inbox.counts.total, 2);
    assert.equal(inbox.counts.approved, 1);
    assert.equal(inbox.counts.pending, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function sampleCatalogIndex(): CatalogIndex {
  return {
    schemaVersion: "catalog-index.v1",
    generatedAt: "2026-07-21T00:00:00.000Z",
    authority: {
      system: "AIBRY Catalog OS",
      specialist: "Catalog Publisher",
      authorityMode: "APPLY_OUTSIDE_VAULT",
      operationalStandard: "ASOS v1",
      sourceOfTruth: "Music Vault",
      vaultMutation: "none"
    },
    contract: MANAGED_SONG_CONTRACT_V1,
    source: {
      vaultPath: "C:\\AIBRY\\music-vault",
      discoveredAt: "2026-07-21T00:00:00.000Z",
      auditedAt: "2026-07-21T00:00:00.000Z",
      instructionPath: "instructions/catalog-structure.md"
    },
    counts: {
      managedSongs: 2,
      albumReleaseContainers: 1,
      provisionalSongCandidates: 0,
      findings: 2,
      warnings: 0
    },
    songs: [],
    albumReleases: [],
    findings: [
      {
        findingId: "provenance-signal-fire",
        severity: "info",
        category: "provenance",
        sourcePath: "project-memory/music/singles/Signal Fire/project.md",
        summary: "No structured migration provenance declared",
        evidence: ["No recognized provenance field was found in YAML front matter."],
        recommendedAction: "Record verified source paths."
      },
      {
        findingId: "front-door-open-door",
        severity: "warning",
        category: "front-door",
        sourcePath: "project-memory/music/albums/Black Box Psalms/01 Open Door/project.md",
        summary: "Front door is incomplete",
        evidence: ["project.md is missing required managed-song fields."],
        recommendedAction: "Prepare a managed-song contract repair proposal."
      }
    ],
    provisionalSongCandidates: [],
    warnings: [],
    scopeNotes: ["Catalog Publisher writes a disposable index outside the vault and never mutates canonical vault files."]
  };
}
