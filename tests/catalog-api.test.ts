import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCatalogApiHandler } from "../src/catalog-api.js";
import { loadCatalogIndex } from "../src/catalog-index-store.js";
import { MANAGED_SONG_CONTRACT_V1 } from "../src/catalog/contract.js";
import type { CatalogIndex } from "../src/catalog/publish.js";

test("Catalog API exposes summary, contract, songs, albums, findings, and health", async () => {
  const index = sampleCatalogIndex();
  const server = createServer(createCatalogApiHandler(index));
  await listen(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await getJson(`${baseUrl}/health`) as { status: string; service: string };
    assert.equal(health.status, "ok");
    assert.equal(health.service, "aibry-catalog-api");

    const summary = await getJson(`${baseUrl}/api/catalog`) as { contractSchemaVersion: string; counts: { managedSongs: number } };
    assert.equal(summary.contractSchemaVersion, "managed-song-contract.v1");
    assert.equal(summary.counts.managedSongs, 2);

    const contract = await getJson(`${baseUrl}/api/contract`) as { schemaVersion: string };
    assert.equal(contract.schemaVersion, "managed-song-contract.v1");

    const songs = await getJson(`${baseUrl}/api/songs?q=signal`) as Array<{ catalogId: string; title: string }>;
    assert.equal(songs.length, 1);
    assert.equal(songs[0]?.catalogId, "song:project-memory/music/singles/Signal Fire");

    const song = await getJson(`${baseUrl}/api/songs/${encodeURIComponent("song:project-memory/music/albums/Black Box Psalms/01 Open Door")}`) as { title: string };
    assert.equal(song.title, "Open Door");

    const releases = await getJson(`${baseUrl}/api/album-releases`) as Array<{ relativePath: string; managedSongCount: number }>;
    assert.equal(releases[0]?.relativePath, "project-memory/music/albums/Black Box Psalms");
    assert.equal(releases[0]?.managedSongCount, 1);

    const findings = await getJson(`${baseUrl}/api/findings?category=provenance`) as Array<{ category: string; sourcePath: string }>;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.sourcePath, "project-memory/music/singles/Signal Fire/project.md");
  } finally {
    await close(server);
  }
});

test("Catalog API returns JSON errors for missing records and unsupported methods", async () => {
  const server = createServer(createCatalogApiHandler(sampleCatalogIndex()));
  await listen(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const missing = await fetch(`${baseUrl}/api/songs/${encodeURIComponent("song:missing")}`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, "song_not_found");

    const post = await fetch(`${baseUrl}/api/songs`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal((await post.json() as { error: string }).error, "method_not_allowed");
  } finally {
    await close(server);
  }
});

test("loadCatalogIndex requires the active non-mutating catalog index contract", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-api-"));
  const valid = path.join(workspace, "catalog-index.json");
  const invalid = path.join(workspace, "bad-index.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(valid, `${JSON.stringify(sampleCatalogIndex(), null, 2)}\n`, "utf8");
    await writeFile(invalid, `${JSON.stringify({ schemaVersion: "catalog-index.v1", songs: [], albumReleases: [], findings: [], authority: { vaultMutation: "unknown" } }, null, 2)}\n`, "utf8");

    const loaded = await loadCatalogIndex(valid);
    assert.equal(loaded.schemaVersion, "catalog-index.v1");
    await assert.rejects(() => loadCatalogIndex(invalid), /non-mutating authority boundary/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json() as Promise<unknown>;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

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
      findings: 1,
      warnings: 0
    },
    songs: [
      {
        catalogId: "song:project-memory/music/singles/Signal Fire",
        title: "Signal Fire",
        lifecycleState: "managed",
        directoryRelativePath: "project-memory/music/singles/Signal Fire",
        projectFileRelativePath: "project-memory/music/singles/Signal Fire/project.md",
        releaseContext: { type: "standalone-single", albumTitle: null, releaseContainerRelativePath: null },
        frontDoor: { relativePath: "project-memory/music/singles/Signal Fire/project.md", lineCount: 4 },
        findings: [{ findingId: "provenance-signal-fire", severity: "info", category: "provenance", summary: "No structured migration provenance declared", recommendedAction: "Record verified source paths." }]
      },
      {
        catalogId: "song:project-memory/music/albums/Black Box Psalms/01 Open Door",
        title: "Open Door",
        lifecycleState: "managed",
        directoryRelativePath: "project-memory/music/albums/Black Box Psalms/01 Open Door",
        projectFileRelativePath: "project-memory/music/albums/Black Box Psalms/01 Open Door/project.md",
        releaseContext: { type: "album-track", albumTitle: "Black Box Psalms", releaseContainerRelativePath: "project-memory/music/albums/Black Box Psalms" },
        frontDoor: { relativePath: "project-memory/music/albums/Black Box Psalms/01 Open Door/project.md", lineCount: 1 },
        findings: []
      }
    ],
    albumReleases: [
      {
        relativePath: "project-memory/music/albums/Black Box Psalms",
        title: "Black Box Psalms",
        managedSongCount: 1,
        findings: []
      }
    ],
    findings: [
      {
        findingId: "provenance-signal-fire",
        severity: "info",
        category: "provenance",
        sourcePath: "project-memory/music/singles/Signal Fire/project.md",
        summary: "No structured migration provenance declared",
        evidence: ["No recognized provenance field was found in YAML front matter."],
        recommendedAction: "Record verified source paths."
      }
    ],
    provisionalSongCandidates: [],
    warnings: [],
    scopeNotes: ["Catalog Publisher writes a disposable index outside the vault and never mutates canonical vault files."]
  };
}
