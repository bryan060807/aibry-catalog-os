import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import {
  classifyMigrationManifest,
  compileAlbumControlDocuments,
  compileProjectControlDocument,
  containsStaleLyricSourceLanguage,
  detectLegacyLyricMappingEvidence
} from "../src/lyric-source/control-document-compiler.js";
import { scoutLyricSourceBatch, validatePlanningInput } from "../src/lyric-source/batch-scout-specialist.js";
import { compileLyricSourceProposal } from "../src/lyric-source/proposal-specialist.js";
import { scoutLyricSourceBatchWorkflow } from "../src/lyric-source/workflows.js";
import { describeSpecialist } from "../src/specialists/registry.js";
import {
  materializeGroundWireGospelFixture,
  materializeLyricSourceScoutFixture
} from "./helpers/lyric-source-scout-fixture.js";

test("lyric-source-batch-scout is registered as an OBSERVE-only read specialist", () => {
  const manifest = describeSpecialist("lyric-source-batch-scout");
  assert.ok(manifest);
  assert.equal(manifest.name, "Lyric Source Batch Scout / Planning Input Builder");
  assert.deepEqual(manifest.authorityModes, ["OBSERVE"]);
  assert.equal(manifest.musicVaultReadAllowed, true);
  assert.equal(manifest.musicVaultWriteAllowed, false);
  assert.deepEqual(manifest.emittedOutputContracts, ["lyric-source-batch-scout-report.v1", "lyric-source-planning-input.v1"]);
});

test("scout deterministically selects the lexical four-track safe prefix and seals proposal-compatible bytes", async () => {
  await withFixture("full", async (fixture, root) => {
    const first = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "run-one", "lyric-source-planning-input.v1.json")
    });
    const second = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "run-two", "lyric-source-planning-input.v1.json")
    });
    assert.equal(first.report.refusal, null);
    assert.ok(first.planningInput && first.planningInputBytes);
    assert.equal(first.report.selectedReleaseContainer, "alpha-signal");
    assert.deepEqual(first.report.selectedIncludedProjects.map((item) => path.posix.basename(item)), [
      "01-first-light", "02-second-light", "03-third-light", "04-fourth-light"
    ]);
    assert.match(first.report.naturalBatchBoundary ?? "", /05-boundary.*first unsafe neighboring track/i);
    assert.equal(first.report.expectedOperationCount, 7);
    assert.equal(first.planningInput.projects.filter((project) => project.include).length, 4);
    assert.equal(first.planningInput.albumControlFiles.length, 3);
    assert.deepEqual(first.planningInput.guardFiles.map((guard) => path.posix.basename(guard.path)).sort(), ["album-release-package.md", "project.md"]);
    validatePlanningInput(first.planningInput, 7);
    assert.equal(compileLyricSourceProposal(first.planningInput).operations.length, 7);
    assert.equal(sha256Bytes(first.planningInputBytes), sha256Bytes(second.planningInputBytes as Buffer));
    assert.equal(first.report.planningInputSha256, second.report.planningInputSha256);
    assert.ok(first.report.inspectedReleaseContainers.find((release) => release.albumSlug === "black-box-psalms")?.defaultExcluded);
    assert.ok(first.report.inspectedReleaseContainers.find((release) => release.albumSlug === "the-violence-of-spring")?.defaultExcluded);
    assert.ok(first.report.excludedProjects.some((item) => item.projectPath.includes("black-box-psalms") && /excluded by the scout policy/i.test(item.reason)));
    const baseline = first.report.baselineCounts;
    const expected = first.report.expectedCounts;
    assert.ok(expected);
    assert.equal(expected.catalogFindings, baseline.catalogFindings - 4);
    assert.equal(expected.assetFindings, baseline.assetFindings - 8);
    assert.equal(expected.routedFindings["blocks-existing-proposal"], (baseline.routedFindings["blocks-existing-proposal"] ?? 0) - 8);
    assert.equal(first.report.perProjectFindingRemovals.length, 4);
    assert.ok(first.report.perProjectFindingRemovals.every((row) => row.catalogFindings === 1 && row.assetFindings === 2 && row.routedFindings["blocks-existing-proposal"] === 2));
  });
});

test("candidate evidence checks exclude ambiguity, conflicts, missing sources, mismatches, existing designations, and linked paths", async () => {
  await withFixture("full", async (fixture, root) => {
    const result = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "scout", "lyric-source-planning-input.v1.json")
    });
    const byAlbum = new Map(result.report.candidateProjects.map((candidate) => [candidate.albumSlug, candidate]));
    assert.match(byAlbum.get("ambiguous-release")?.exclusionReason ?? "", /ambiguous/i);
    assert.equal(byAlbum.get("ambiguous-release")?.competingCandidateCount, 1);
    assert.match(byAlbum.get("missing-source-release")?.exclusionReason ?? "", /legacy source candidate was not found/i);
    assert.match(byAlbum.get("hash-mismatch-release")?.exclusionReason ?? "", /bytes or SHA-256 values differ/i);
    assert.match(byAlbum.get("name-mismatch-release")?.exclusionReason ?? "", /managed lyric candidates are ambiguous/i);
    assert.equal(byAlbum.get("name-mismatch-release")?.exactNameMatch, false);
    assert.match(byAlbum.get("manifest-conflict-release")?.exclusionReason ?? "", /manifest contains a conflicting/i);
    assert.equal(byAlbum.get("manifest-conflict-release")?.currentManifestMappingState, "conflicting");
    assert.match(byAlbum.get("designated-release")?.exclusionReason ?? "", /human-approved/i);
    assert.match(byAlbum.get("linked-release")?.exclusionReason ?? "", /linked|reparse|legacy source/i);
    const safe = result.report.candidateProjects.find((candidate) => candidate.albumSlug === "alpha-signal" && candidate.eligibilityState === "eligible");
    assert.equal(safe?.exactNameMatch, true);
    assert.equal(safe?.sourceExists, true);
    assert.equal(safe?.managedExists, true);
    assert.equal(safe?.sourceByteSize, safe?.managedByteSize);
    assert.equal(safe?.sourceSha256, safe?.managedSha256);
  });
});

test("project and album compilers remove stale source uncertainty but preserve production and release decisions", async () => {
  await withFixture("full", async (fixture, root) => {
    const result = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "compiler", "lyric-source-planning-input.v1.json")
    });
    assert.ok(result.planningInput);
    const included = result.planningInput.projects.filter((project) => project.include);
    assert.equal(included.length, 4);
    for (const project of included) {
      const proposed = project.controlFile?.proposedContent ?? "";
      assert.equal(containsStaleLyricSourceLanguage(proposed), false);
      assert.match(proposed, /Resolved Provenance \/ Remaining Decisions/);
      assert.match(proposed, /designation_state: human-approved/);
      assert.match(proposed, /Mix approval remains unresolved/);
      assert.match(proposed, /Artwork and licensing remain unresolved/);
      assert.doesNotMatch(proposed, /Promote this draft/i);
    }
    assert.deepEqual(result.planningInput.albumControlFiles.map((control) => path.posix.basename(control.path)), ["migration-manifest.md", "README.md", "tracklist.md"]);
    const compiled = compileAlbumControlDocuments({
      albumSlug: "fixture", generatedAt: "2026-01-01T00:00:00.000Z",
      selectedTracks: [
        { projectPath: "album/02-b", projectSlug: "02-b", trackNumber: 2, sourcePath: "lyrics/02-b.md", managedPath: "album/02-b/lyrics/02-b.md", sourceByteSize: 2, managedByteSize: 2, sourceSha256: "2".repeat(64), managedSha256: "2".repeat(64) },
        { projectPath: "album/01-a", projectSlug: "01-a", trackNumber: 1, sourcePath: "lyrics/01-a.md", managedPath: "album/01-a/lyrics/01-a.md", sourceByteSize: 1, managedByteSize: 1, sourceSha256: "1".repeat(64), managedSha256: "1".repeat(64) }
      ],
      unresolvedTracks: [{ projectPath: "album/03-c", trackNumber: 3, reason: "unsafe" }],
      currentMigrationManifest: "---\ncontract: lyric-source-migration-manifest.v1\nentries: []\n---\n# fixture migration\n",
      currentReadme: "# fixture\n\n## Purpose\n\nPreserve this purpose.\n",
      currentTracklist: "# fixture Tracklist\n\n- Original tracklist content.\n"
    });
    assert.ok(compiled.migrationManifest.indexOf("album/01-a") < compiled.migrationManifest.indexOf("album/02-b"));
    assert.ok(compiled.tracklist.indexOf("album/01-a") < compiled.tracklist.indexOf("album/02-b"));
    assert.match(compiled.tracklist, /album\/03-c: unresolved — unsafe/);
  });
});

test("legacy migration manifests are classified without treating unrelated migration history as lyric mappings", () => {
  const legacy = [
    "# Ground Wire Gospel Migration Record",
    "",
    "Migration date: 2025-11-07",
    "Migration method: non-destructive project-folder normalization",
    "",
    "## Completed",
    "",
    "- Created the album release container.",
    "",
    "## Structural Mapping",
    "",
    "| Existing folder | Catalog OS meaning | Migration handling |",
    "| --- | --- | --- |",
    "| album notes | album release-container history | Keep unchanged |",
    "| `lyrics/` | release-package lyric copies | Keep; canonical lyric source remains in `/lyrics/` root |",
    "",
    "## Not Changed",
    "",
    "- Audio masters, artwork, credits, and release metadata were not changed.",
    "",
    "## Remaining Migration Work",
    "",
    "- Resolve lyric provenance track by track."
  ].join("\n");
  assert.deepEqual(detectLegacyLyricMappingEvidence(legacy), []);
  assert.equal(classifyMigrationManifest(legacy).state, "legacy-no-contract");
  const structuredFields = [
    "# Ambiguous mapping",
    "project_path: project-memory/music/albums/example/01-track",
    "source_path: lyrics/albums/example/01-track.md",
    "managed_lyric_copy: project-memory/music/albums/example/01-track/lyrics/01-track.md"
  ].join("\n");
  const explicitTable = [
    "| Project | Canonical Source | Managed Copy |",
    "| --- | --- | --- |",
    "| project-memory/music/albums/example/01-track | lyrics/albums/example/01-track.md | project-memory/music/albums/example/01-track/lyrics/01-track.md |"
  ].join("\n");
  const pathArrow = "lyrics/albums/example/01-track.md -> project-memory/music/albums/example/01-track/lyrics/01-track.md";
  const generatedSection = "# Legacy\n\n## Verified Lyric-Source Designations\n\n- project mapping\n";
  assert.deepEqual(detectLegacyLyricMappingEvidence("lyric-source-designation.v1"), ["contract-marker"]);
  assert.deepEqual(detectLegacyLyricMappingEvidence(structuredFields), ["yaml-mapping-field"]);
  assert.deepEqual(detectLegacyLyricMappingEvidence(explicitTable), ["explicit-mapping-table"]);
  assert.deepEqual(detectLegacyLyricMappingEvidence(pathArrow), ["explicit-path-arrow"]);
  assert.deepEqual(detectLegacyLyricMappingEvidence(generatedSection), ["generated-designation-section"]);
  for (const conflict of [structuredFields, explicitTable, pathArrow, generatedSection, "lyric-source-migration-manifest.v1"]) {
    assert.equal(classifyMigrationManifest(conflict).state, "conflicting");
  }
  assert.equal(classifyMigrationManifest("---\ncontract: [\n---\n# Broken\n").state, "malformed");
  assert.equal(classifyMigrationManifest("---\ncontract: other-contract.v1\nentries: []\n---\n# Wrong\n").state, "conflicting");
  const compile = (currentMigrationManifest: string) => compileAlbumControlDocuments({
    albumSlug: "fixture", generatedAt: "2026-01-01T00:00:00.000Z", selectedTracks: [], unresolvedTracks: [],
    currentMigrationManifest, currentReadme: "# README\n", currentTracklist: "# Tracklist\n"
  });
  assert.throws(() => compile("---\ncontract: [\n---\n# Broken\n"), /front matter|YAML mapping/i);
  for (const conflict of [structuredFields, explicitTable, pathArrow, generatedSection]) {
    assert.throws(() => compile(conflict), /mapping-like lyric-source fields/i);
  }
});

test("control-document compilation is non-destructive, deterministic, and idempotent", () => {
  const track = {
    projectPath: "project-memory/music/albums/ground-wire-gospel/01-ground-wire",
    projectSlug: "01-ground-wire",
    trackNumber: 1,
    sourcePath: "lyrics/albums/ground-wire-gospel/01-ground-wire.md",
    managedPath: "project-memory/music/albums/ground-wire-gospel/01-ground-wire/lyrics/01-ground-wire.md",
    sourceByteSize: 91,
    managedByteSize: 91,
    sourceSha256: "1".repeat(64),
    managedSha256: "1".repeat(64)
  };
  const currentProject = [
    "# Ground Wire",
    "",
    "## Canonical References",
    "",
    "- Legacy lyric evidence remains preserved.",
    "",
    "## Required Decisions",
    "",
    "- [ ] Verify lyric copy against canonical source.",
    "- [ ] Approve final mastering.",
    "- [ ] Complete QC review.",
    "- [ ] Confirm metadata and credits.",
    "- [ ] Approve artwork, licensing, and release sequence.",
    "",
    "## Credits",
    "",
    "Credits remain governed by the release ledger.",
    ""
  ].join("\n");
  const projectOnce = compileProjectControlDocument(currentProject, track, "project-memory/music/albums/ground-wire-gospel/migration-manifest.md");
  const projectTwice = compileProjectControlDocument(projectOnce, track, "project-memory/music/albums/ground-wire-gospel/migration-manifest.md");
  assert.equal(projectTwice, projectOnce);
  assert.doesNotMatch(projectOnce, /Verify lyric copy against canonical source/i);
  for (const preserved of [
    "## Canonical References", "Legacy lyric evidence remains preserved.", "- [ ] Approve final mastering.",
    "- [ ] Complete QC review.", "- [ ] Confirm metadata and credits.",
    "- [ ] Approve artwork, licensing, and release sequence.", "## Credits", "Credits remain governed by the release ledger."
  ]) assert.match(projectOnce, new RegExp(escapeRegex(preserved)));
  assert.equal((projectOnce.match(/^## Resolved Provenance \/ Remaining Decisions$/gm) ?? []).length, 1);

  const manifest = [
    "# Ground Wire Gospel Migration Record", "", "Migration date: 2025-11-07", "Migration method: bounded copy", "",
    "## Completed", "", "- The album container was created.", "", "## Structural Mapping", "",
    "| Existing folder | Catalog OS meaning | Migration handling |", "| --- | --- | --- |",
    "| `lyrics/` | release-package lyric copies | Keep; canonical lyric source remains in `/lyrics/` root |", "",
    "## Not Changed", "", "- Masters, artwork, and credits were not changed.", "", "## Remaining Migration Work", "",
    "- Complete mastering and release-readiness review.", ""
  ].join("\n");
  const readme = [
    "# Ground Wire Gospel", "", "## Read Order", "", "Read the album front door first.", "", "## Purpose", "",
    "Preserve the creative record.", "", "## Canonical Sources", "", "Legacy evidence remains preserved.", "",
    "## Album Folder Contract", "", "Numbered track folders are stable.", "", "## Known Album State", "",
    "Mastering remains open.", "", "## Non-Destructive Migration Rule", "", "Do not discard history.", ""
  ].join("\n");
  const tracklist = [
    "# Ground Wire Gospel Tracklist", "", "| Track | Title | Folder | Canonical Source |", "| ---: | --- | --- | --- |",
    "| 1 | Ground Wire | `01-ground-wire/` | unresolved |", "| 7 | Fatal Design | `07-fatal-design/` | unresolved |", "",
    "## Track 07 Rename Rule", "", "Track 07 retains the Fatal Design rename rule.", ""
  ].join("\n");
  const compileAlbum = (currentMigrationManifest: string, currentReadme: string, currentTracklist: string) => compileAlbumControlDocuments({
    albumSlug: "ground-wire-gospel", generatedAt: "2026-01-01T00:00:00.000Z", selectedTracks: [track],
    unresolvedTracks: [{ projectPath: "project-memory/music/albums/ground-wire-gospel/09-after-the-fire", trackNumber: 9, reason: "bytes or SHA-256 values differ" }],
    currentMigrationManifest, currentReadme, currentTracklist
  });
  const albumOnce = compileAlbum(manifest, readme, tracklist);
  const albumTwice = compileAlbum(albumOnce.migrationManifest, albumOnce.readme, albumOnce.tracklist);
  assert.deepEqual(albumTwice, albumOnce);
  for (const preserved of ["Migration date: 2025-11-07", "## Completed", "## Structural Mapping", "## Not Changed", "## Remaining Migration Work"]) {
    assert.match(albumOnce.migrationManifest, new RegExp(escapeRegex(preserved)));
  }
  assert.match(albumOnce.migrationManifest, /\| `lyrics\/` \| release-package lyric copies \| Keep; canonical lyric source remains in `\/lyrics\/` root \|/);
  for (const preserved of ["## Read Order", "## Purpose", "## Canonical Sources", "## Album Folder Contract", "## Known Album State", "## Non-Destructive Migration Rule"]) {
    assert.match(albumOnce.readme, new RegExp(escapeRegex(preserved)));
  }
  assert.match(albumOnce.tracklist, /\| 7 \| Fatal Design \|/);
  assert.match(albumOnce.tracklist, /Track 07 retains the Fatal Design rename rule/);
  assert.equal((albumOnce.migrationManifest.match(/^## Verified Lyric-Source Designations$/gm) ?? []).length, 1);
  assert.equal((albumOnce.migrationManifest.match(/^## Lyric-Source Verification Boundary$/gm) ?? []).length, 1);
  assert.equal((albumOnce.readme.match(/^## Lyric-Source Designation Status$/gm) ?? []).length, 1);
  assert.equal((albumOnce.tracklist.match(/^## Lyric-Source Designation Status$/gm) ?? []).length, 1);
});

test("Ground Wire Gospel legacy controls yield tracks 01-04, seven operations, and preserve unrelated content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-ground-wire-scout-test-"));
  try {
    const fixture = await materializeGroundWireGospelFixture(root);
    const first = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "first", "lyric-source-planning-input.v1.json"),
      minTracks: 2,
      maxTracks: 4
    });
    const second = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "second", "lyric-source-planning-input.v1.json"),
      minTracks: 2,
      maxTracks: 4
    });
    assert.equal(first.report.refusal, null);
    assert.ok(first.planningInput && first.planningInputBytes);
    assert.equal(first.report.selectedReleaseContainer, "ground-wire-gospel");
    assert.deepEqual(first.report.selectedIncludedProjects.map((item) => path.posix.basename(item)), [
      "01-rust-on-the-ignition", "02-oxidation-at-the-joints", "03-voltage-bleed", "04-scrap-iron-sermon"
    ]);
    assert.equal(first.report.expectedOperationCount, 7);
    assert.equal(compileLyricSourceProposal(first.planningInput).operations.length, 7);
    assert.equal(first.report.planningInputSha256, second.report.planningInputSha256);
    const trackNine = first.report.candidateProjects.find((candidate) => candidate.projectPath.endsWith("/09-after-the-fire"));
    assert.equal(trackNine?.eligibilityState, "excluded");
    assert.match(trackNine?.exclusionReason ?? "", /bytes or SHA-256 values differ/i);
    assert.ok(first.report.excludedProjects.some((candidate) => candidate.projectPath.endsWith("/05-broken-testimony") && /outside the selected deterministic batch boundary/i.test(candidate.reason)));
    const baseline = first.report.baselineCounts;
    const expected = first.report.expectedCounts;
    assert.ok(expected);
    assert.equal(expected.catalogFindings, baseline.catalogFindings - 4);
    assert.equal(expected.assetFindings, baseline.assetFindings - 8);
    assert.equal(expected.routedFindings["blocks-existing-proposal"], (baseline.routedFindings["blocks-existing-proposal"] ?? 0) - 8);

    const albumControls = new Map(first.planningInput.albumControlFiles.map((control) => [path.posix.basename(control.path), control.proposedContent]));
    const compiledManifest = albumControls.get("migration-manifest.md") ?? "";
    const compiledReadme = albumControls.get("README.md") ?? "";
    const compiledTracklist = albumControls.get("tracklist.md") ?? "";
    for (const preserved of ["Migration date: 2025-11-07", "Migration method: non-destructive project-folder normalization", "## Completed", "## Structural Mapping", "## Not Changed", "## Remaining Migration Work"]) {
      assert.match(compiledManifest, new RegExp(escapeRegex(preserved)));
    }
    assert.match(compiledManifest, /\| Existing folder \| Catalog OS meaning \| Migration handling \|/);
    assert.match(compiledManifest, /\| `lyrics\/` \| release-package lyric copies \| Keep; canonical lyric source remains in `\/lyrics\/` root \|/);
    for (const preserved of ["## Read Order", "## Purpose", "## Canonical Sources", "## Album Folder Contract", "## Known Album State", "## Non-Destructive Migration Rule"]) {
      assert.match(compiledReadme, new RegExp(escapeRegex(preserved)));
    }
    assert.match(compiledTracklist, /\| 9 \| After the Fire \| `09-after-the-fire\/` \| unresolved \|/);
    assert.match(compiledTracklist, /Track 07 retains the Fatal Design rename rule/);
    const projectOne = first.planningInput.projects.find((project) => project.projectPath.endsWith("/01-rust-on-the-ignition"));
    assert.ok(projectOne?.controlFile);
    const proposedProject = projectOne.controlFile.proposedContent;
    assert.doesNotMatch(proposedProject, /Verify lyric copy against canonical source/i);
    for (const preserved of ["## Canonical References", "## Existing Assets", "- [ ] Approve final mastering.", "- [ ] Complete QC review.", "- [ ] Confirm metadata and credits.", "- [ ] Approve artwork, licensing, and release sequence.", "## Release Notes"]) {
      assert.match(proposedProject, new RegExp(escapeRegex(preserved)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh artifact lineage tampering and final evidence drift are refused", async () => {
  await withFixture("full", async (fixture, root) => {
    const refresh = JSON.parse(await readFile(fixture.refreshReportPath, "utf8")) as { artifacts: Array<{ name: string; path: string }> };
    const catalog = refresh.artifacts.find((artifact) => artifact.name === "catalog-index");
    assert.ok(catalog);
    await writeFile(catalog.path, `${await readFile(catalog.path, "utf8")} `, "utf8");
    await assert.rejects(() => scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "tampered", "lyric-source-planning-input.v1.json")
    }), /lineage SHA-256 mismatch/i);
  });
  await withFixture("full", async (fixture, root) => {
    assert.ok(fixture.driftManagedPath);
    const result = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "drift", "lyric-source-planning-input.v1.json"),
      beforeFinalEvidenceRehash: async () => writeFile(fixture.driftManagedPath as string, "changed during rehash\n", "utf8")
    });
    assert.equal(result.planningInput, null);
    assert.equal(result.report.evidenceRehashStatus, "failed");
    assert.equal(result.report.refusal?.code, "evidence-drift");
    assert.equal(result.report.planningInputPath, null);
  });
});

test("track limits and structured no-batch refusal are enforced", async () => {
  await withFixture("refusal", async (fixture, root) => {
    await assert.rejects(() => scoutLyricSourceBatch({
      vaultRoot: fixture.vault, refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "bad", "input.json"), minTracks: 1, maxTracks: 4
    }), /2 <= minTracks <= maxTracks <= 4/i);
    const refused = await scoutLyricSourceBatch({
      vaultRoot: fixture.vault, refreshReportPath: fixture.refreshReportPath,
      planningInputPath: path.join(root, "refused", "input.json"), minTracks: 2, maxTracks: 4
    });
    assert.equal(refused.planningInput, null);
    assert.equal(refused.report.refusal?.code, "no-safe-batch");
    assert.ok((refused.report.refusal?.details.length ?? 0) > 0);
    assert.match(refused.report.refusal?.details[0] ?? "", /release=one-track-only; eligibleEvidence=1; leadingReason=eligible evidence does not form a safe two-to-four-track batch\.; count=1/i);
    assert.equal(refused.report.planningInputPath, null);
    assert.equal(refused.report.safety.applyEnabled, false);
    assert.equal(refused.report.safety.approvalCreated, false);
    assert.equal(refused.report.safety.applyScriptCreated, false);
  });
});

test("kernel scout workflow persists verified report, planning input, and OBSERVE-only workflow lineage", async () => {
  await withFixture("full", async (fixture, root) => {
    const outputDirectory = path.join(root, "workflow-output");
    const result = await scoutLyricSourceBatchWorkflow({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      outputDirectory,
      minTracks: 2,
      maxTracks: 4
    });
    assert.equal(result.report.refusal, null);
    assert.ok(result.planningInputPath);
    assert.equal(result.workflow.workflow, "scout-lyric-source-batch");
    assert.equal(result.workflow.specialist.id, "lyric-source-batch-scout");
    assert.equal(result.workflow.specialist.authorityMode, "OBSERVE");
    assert.equal(result.workflow.refusal, null);
    assert.equal(result.workflow.safety.applyEnabled, false);
    assert.equal(result.workflow.safety.vaultMutation, "none");
    assert.deepEqual(result.workflow.outputArtifacts.map((artifact) => artifact.contract), ["lyric-source-batch-scout-report.v1", "lyric-source-planning-input.v1"]);
    const persisted = JSON.parse(await readFile(result.planningInputPath, "utf8"));
    assert.equal(persisted.contract, "lyric-source-planning-input.v1");
    assert.equal(sha256Bytes(await readFile(result.planningInputPath)), result.report.planningInputSha256);
    await assert.rejects(() => scoutLyricSourceBatchWorkflow({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      outputDirectory,
      minTracks: 2,
      maxTracks: 4
    }), /output already exists/i);
    assert.equal(sha256Bytes(await readFile(result.planningInputPath)), result.report.planningInputSha256);
    await assert.rejects(() => readFile(path.join(outputDirectory, "lyric-source-designation-proposal.v1.json")), /ENOENT/);
  });
});

test("scout launch accepts the protected Vault as a read-only root without classifying it as an output", async () => {
  await withFixture("full", async (fixture, root) => {
    const outputDirectory = path.join(root, "protected-root-read");
    const result = await scoutLyricSourceBatchWorkflow({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      outputDirectory
    });
    assert.equal(result.report.vaultRead, true);
    assert.equal(result.report.vaultMutation, "none");
    assert.equal(result.workflow.safety.vaultMutation, "none");
    const source = await readFile(path.join(process.cwd(), "src", "lyric-source", "workflows.ts"), "utf8");
    assert.match(source, /assertOutsideLiveVault\(options\.refreshReportPath, options\.outputDirectory\)/);
    assert.doesNotMatch(source, /assertOutsideLiveVault\(options\.vaultRoot,/);
  });
});

test("scout launch still rejects refresh and all derived outputs inside the protected Vault", async () => {
  await withFixture("full", async (fixture) => {
    const refreshInsideVault = path.join(fixture.vault, "unsafe-refresh.json");
    await cp(fixture.refreshReportPath, refreshInsideVault);
    await assert.rejects(() => scoutLyricSourceBatchWorkflow({
      vaultRoot: fixture.vault,
      refreshReportPath: refreshInsideVault,
      outputDirectory: path.join(fixture.reportsRoot, "safe-output")
    }), /outside the protected root/i);

    const outputInsideVault = path.join(fixture.vault, "unsafe-scout-output");
    await assert.rejects(() => scoutLyricSourceBatchWorkflow({
      vaultRoot: fixture.vault,
      refreshReportPath: fixture.refreshReportPath,
      outputDirectory: outputInsideVault
    }), /outside the protected root/i);
    for (const fileName of [
      "lyric-source-batch-scout-report.v1.json",
      "lyric-source-planning-input.v1.json",
      "asos-workflow-run.v1.json"
    ]) {
      await assert.rejects(() => readFile(path.join(outputInsideVault, fileName)), /ENOENT/);
    }
  });
});

async function withFixture(mode: "full" | "refusal", action: (fixture: Awaited<ReturnType<typeof materializeLyricSourceScoutFixture>>, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-lyric-scout-test-"));
  try {
    const fixture = await materializeLyricSourceScoutFixture(root, mode);
    await action(fixture, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
