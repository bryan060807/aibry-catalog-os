import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import type { CatalogIndex } from "../src/catalog/publish.js";

test("catalog publish writes a rebuildable JSON index outside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-publish-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "catalog-index.json");
  const single = path.join(vault, "project-memory", "music", "singles", "Signal Fire");
  const albumTrack = path.join(vault, "project-memory", "music", "albums", "black-box-psalms", "01-open-door");
  try {
    await setupVault(vault);
    await mkdir(single, { recursive: true });
    await mkdir(albumTrack, { recursive: true });
    await writeFile(path.join(single, "project.md"), "---\nid: signal-fire\n---\n# Signal Fire\n", "utf8");
    await writeFile(path.join(albumTrack, "project.md"), "# Open Door\n", "utf8");

    await main(["catalog", "publish", "--vault", vault, "--output", output]);

    const index = JSON.parse(await readFile(output, "utf8")) as CatalogIndex;
    assert.equal(index.schemaVersion, "catalog-index.v1");
    assert.equal(index.authority.specialist, "Catalog Publisher");
    assert.equal(index.authority.authorityMode, "APPLY_OUTSIDE_VAULT");
    assert.equal(index.authority.sourceOfTruth, "Music Vault");
    assert.equal(index.authority.vaultMutation, "none");
    assert.equal(index.contract.schemaVersion, "managed-song-contract.v1");
    assert.equal(index.contract.steward.specialist, "Catalog Contract Steward");
    assert.equal(index.contract.steward.authorityMode, "OBSERVE_PROPOSE");
    assert.ok(index.contract.requiredFrontMatter.some((field) => field.name === "id"));
    assert.ok(index.contract.requiredFrontMatter.some((field) => field.name === "lifecycle_state"));
    assert.equal(index.counts.managedSongs, 2);
    assert.equal(index.counts.albumReleaseContainers, 1);
    assert.equal(index.counts.provisionalSongCandidates, 0);
    assert.equal(index.songs.length, 2);
    assert.deepEqual(index.songs.map((song) => song.title).sort(), ["Open Door", "Signal Fire"]);
    assert.ok(index.songs.every((song) => song.catalogId.startsWith("song:project-memory/music/")));
    assert.equal(index.albumReleases[0]?.title, "black-box-psalms");
    assert.equal(index.albumReleases[0]?.managedSongCount, 1);
    assert.ok(index.findings.some((finding) => finding.category === "provenance"));
    assert.ok(index.scopeNotes.some((note) => note.includes("never mutates canonical vault files")));
    await assert.rejects(() => stat(path.join(vault, "catalog-index.json")), { code: "ENOENT" });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("catalog publish refuses to write the generated index inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-publish-"));
  const vault = path.join(workspace, "vault");
  const outputInsideVault = path.join(vault, "generated", "catalog-index.json");
  try {
    await setupVault(vault);
    await assert.rejects(
      () => main(["catalog", "publish", "--vault", vault, "--output", outputInsideVault]),
      /Refusing to write discovery output inside the vault/
    );
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function setupVault(vault: string): Promise<void> {
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(path.join(vault, "project-memory", "music", "singles"), { recursive: true });
  await mkdir(path.join(vault, "project-memory", "music", "albums"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
}
