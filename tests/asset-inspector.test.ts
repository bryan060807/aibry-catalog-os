import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { inspectCatalogAssets } from "../src/asset-inspector.js";
import type { AssetInspectionReport } from "../src/asset-inspector.js";

test("Asset Inspector inventories Anticipation-style assets without choosing canonical provenance", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asset-inspector-"));
  const vault = path.join(workspace, "vault");
  try {
    await setupVault(vault);
    const report = await inspectCatalogAssets(vault);
    assert.equal(report.contract, "asset-inspection-report.v1");
    assert.equal(report.authority.specialist, "Asset Inspector");
    assert.equal(report.authority.authorityMode, "OBSERVE");
    assert.equal(report.authority.vaultMutation, "none");
    assert.equal(report.counts.projects, 1);

    const inspection = report.inspections[0];
    assert.ok(inspection);
    assert.equal(inspection.contract, "asset-inspection.v1");
    assert.equal(inspection.projectPath, path.join("project-memory", "music", "singles", "anticipation-of-the-crash"));
    assert.equal(inspection.folderStatus.lyrics, "present");
    assert.equal(inspection.folderStatus.audio, "present");
    assert.equal(inspection.folderStatus.metadata, "present");
    assert.equal(inspection.folderStatus.releaseAdmin, "empty");
    assert.equal(inspection.folderStatus.licensing, "present");
    assert.ok(inspection.assets.every((asset) => asset.sha256.length === 64));
    assert.ok(inspection.assets.every((asset) => asset.path.includes("project-memory")));

    const audioRoles = inspection.assets.filter((asset) => asset.category === "audio").map((asset) => asset.candidateRole).sort();
    assert.deepEqual(audioRoles, ["alternate-audio", "mastered-audio", "original-audio-candidate"]);

    const mediaInfo = inspection.assets.filter((asset) => asset.category === "metadata" && asset.candidateRole === "media-info-record");
    assert.equal(mediaInfo.length, 3);
    assert.ok(mediaInfo.some((asset) => asset.evidence.includes("filename references mastered audio")));
    assert.ok(mediaInfo.some((asset) => asset.evidence.includes("filename references alternate audio version")));

    const lyricCandidates = inspection.assets.filter((asset) => asset.category === "lyrics" && asset.candidateRole === "lyric-candidate");
    assert.equal(lyricCandidates.length, 2);

    const canonicalLyric = inspection.findings.find((finding) => finding.type === "canonical-lyric-unresolved");
    assert.equal(canonicalLyric?.status, "blocked-insufficient-evidence");
    assert.equal(canonicalLyric?.evidencePaths.length, 2);
    assert.ok(canonicalLyric?.summary.includes("does not declare a canonical lyric"));

    const provenance = inspection.findings.find((finding) => finding.type === "provenance-insufficient");
    assert.equal(provenance?.status, "blocked-insufficient-evidence");
    assert.deepEqual(provenance?.evidencePaths, []);

    assert.ok(inspection.findings.some((finding) => finding.type === "release-admin-empty"));
    assert.ok(inspection.findings.some((finding) => finding.type === "multiple-audio-variants"));
    assert.ok(inspection.findings.some((finding) => finding.type === "media-info-audio-evidence"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog inspect-assets writes an OBSERVE-only report outside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asset-inspector-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "asset-inspection.json");
  try {
    await setupVault(vault);
    await main(["catalog", "inspect-assets", "--vault", vault, "--output", output]);
    const report = JSON.parse(await readFile(output, "utf8")) as AssetInspectionReport;
    assert.equal(report.contract, "asset-inspection-report.v1");
    assert.equal(report.authority.authorityMode, "OBSERVE");
    assert.equal(report.authority.vaultMutation, "none");
    assert.equal(report.counts.projects, 1);
    assert.ok(report.counts.assets >= 8);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("catalog inspect-assets refuses to write inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "asset-inspector-"));
  const vault = path.join(workspace, "vault");
  const outputInsideVault = path.join(vault, "asset-inspection.json");
  try {
    await setupVault(vault);
    await assert.rejects(
      () => main(["catalog", "inspect-assets", "--vault", vault, "--output", outputInsideVault]),
      /Refusing to write discovery output inside the vault/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function setupVault(vault: string): Promise<void> {
  const project = path.join(vault, "project-memory", "music", "singles", "anticipation-of-the-crash");
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(path.join(project, "lyrics"), { recursive: true });
  await mkdir(path.join(project, "audio"), { recursive: true });
  await mkdir(path.join(project, "metadata"), { recursive: true });
  await mkdir(path.join(project, "artwork"), { recursive: true });
  await mkdir(path.join(project, "licensing"), { recursive: true });
  await mkdir(path.join(project, "release-admin"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
  await writeFile(path.join(project, "project.md"), "# Anticipation of the Crash\n\nKnown source lyric path: Not yet established.\n", "utf8");
  await writeFile(path.join(project, "lyrics", "anticipation-of-the-crash.txt"), "lyric candidate\n", "utf8");
  await writeFile(path.join(project, "lyrics", "anticipation-of-the-crash-alt.txt"), "alternate lyric candidate\n", "utf8");
  await writeFile(path.join(project, "audio", "anticipation-of-the-crash-mastered.wav"), "mastered audio bytes\n", "utf8");
  await writeFile(path.join(project, "audio", "anticipation-of-the-crash-alt-version-1.wav"), "alt audio bytes\n", "utf8");
  await writeFile(path.join(project, "audio", "anticipation-of-the-crash-origianl.wav"), "original typo audio bytes\n", "utf8");
  await writeFile(path.join(project, "metadata", "anticipation-of-the-crash-mastered-media-info.txt"), "media info mastered\n", "utf8");
  await writeFile(path.join(project, "metadata", "anticipation-of-the-crash-alt-version-1-media-info.txt"), "media info alt\n", "utf8");
  await writeFile(path.join(project, "metadata", "anticipation-of-the-crash-origianl-media-info.txt"), "media info original\n", "utf8");
  await writeFile(path.join(project, "artwork", "cover.png"), "png bytes\n", "utf8");
  await writeFile(path.join(project, "licensing", "rights-note.md"), "rights note\n", "utf8");
}
