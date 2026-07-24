import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLyricSourceDesignation } from "../src/lyric-source-resolver.js";

type Fixture = {
  workspace: string;
  vault: string;
  projectDir: string;
  projectFile: string;
  sourceRelative: string;
  managedRelative: string;
  manifestRelative: string;
  sourceSha256: string;
  managedSha256: string;
  sourceSize: number;
  managedSize: number;
};

test("resolver verifies a valid human-approved designation", async () => {
  const fixture = await createFixture();
  try {
    const result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.equal(result.state, "verified");
    assert.deepEqual(result.failures, []);
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects absolute and escaping paths", async () => {
  const fixture = await createFixture();
  try {
    await writeDesignation(fixture, { source_path: path.join(fixture.workspace, "outside.txt") });
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.equal(result.state, "unresolved");
    assert.ok(result.failures.some((failure) => failure.includes("vault-relative")));

    await writeDesignation(fixture, { source_path: "../outside.txt", canonical_lyric_source: "../outside.txt" });
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("vault-relative")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects missing files and invalid or incomplete manifests", async () => {
  const fixture = await createFixture();
  try {
    await writeDesignation(fixture, { source_path: "lyrics/albums/test/missing.md", canonical_lyric_source: "lyrics/albums/test/missing.md" });
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("canonical source does not exist")));

    await resetFixture(fixture);
    await writeFile(path.join(fixture.vault, ...fixture.manifestRelative.split("/")), "---\ncontract: wrong.v1\nentries: []\n---\n", "utf8");
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("valid lyric-source-migration-manifest.v1")));

    await writeManifest(fixture, []);
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("does not contain a mapping")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects duplicate and mismatched manifest mappings", async () => {
  const fixture = await createFixture();
  try {
    const validEntry = manifestEntry(fixture);
    await writeManifest(fixture, [validEntry, validEntry]);
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("competing canonical designations")));

    await writeManifest(fixture, [{ ...validEntry, source_path: "lyrics/albums/test/other.md" }]);
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("source_path does not match")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects dot-segment role bypasses", async () => {
  const fixture = await createFixture();
  try {
    const escapedSource = "lyrics/../project-memory/music/albums/test/01-song/lyrics/01-song.md";
    await writeDesignation(fixture, {
      source_path: escapedSource,
      canonical_lyric_source: escapedSource
    });
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("source_path must resolve under lyrics/")));
    assert.ok(result.failures.some((failure) => failure.includes("canonical_lyric_source must resolve under lyrics/")));

    await resetFixture(fixture);
    const escapedManaged = "project-memory/music/albums/test/01-song/lyrics/../../other/lyrics/01-song.md";
    const escapedManagedPath = path.join(fixture.vault, ...escapedManaged.split("/"));
    await mkdir(path.dirname(escapedManagedPath), { recursive: true });
    await writeFile(escapedManagedPath, await readFile(path.join(fixture.vault, ...fixture.sourceRelative.split("/"))));
    await writeDesignation(fixture, { managed_lyric_copy: escapedManaged });
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("managed_lyric_copy must resolve under the project lyrics/ directory")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver enforces canonical and managed file roles", async () => {
  const fixture = await createFixture();
  try {
    await writeDesignation(fixture, {
      source_path: fixture.managedRelative,
      canonical_lyric_source: fixture.managedRelative,
      managed_lyric_copy: fixture.managedRelative
    });
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("source_path must resolve under lyrics/")));
    assert.ok(result.failures.some((failure) => failure.includes("canonical source and managed lyric copy resolve to the same file")));

    await resetFixture(fixture);
    const wrongManaged = "project-memory/music/albums/test/other/lyrics/song.md";
    const wrongManagedPath = path.join(fixture.vault, ...wrongManaged.split("/"));
    await mkdir(path.dirname(wrongManagedPath), { recursive: true });
    await writeFile(wrongManagedPath, await readFile(path.join(fixture.vault, ...fixture.sourceRelative.split("/"))));
    await writeDesignation(fixture, { managed_lyric_copy: wrongManaged });
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("project lyrics/ directory")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects non-human-approved designations", async () => {
  const fixture = await createFixture();
  try {
    const project = await readFile(fixture.projectFile, "utf8");
    await writeFile(fixture.projectFile, project.replace("designation_state: human-approved", "designation_state: proposed"), "utf8");
    const result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.equal(result.state, "unresolved");
    assert.ok(result.failures.some((failure) => failure.includes("complete lyric-source-designation.v1")));
  } finally {
    await cleanup(fixture);
  }
});

test("resolver rejects final-file and parent-directory symlinks", async (t) => {
  const fixture = await createFixture();
  try {
    const sourcePath = path.join(fixture.vault, ...fixture.sourceRelative.split("/"));
    const realSource = path.join(fixture.vault, "lyrics", "albums", "test", "real-song.md");
    await writeFile(realSource, "verified lyric\n", "utf8");
    await rm(sourcePath);
    try {
      await symlink(realSource, sourcePath, "file");
    } catch (error: unknown) {
      t.skip(`Symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("symbolic-link path segment")));

    await rm(sourcePath);
    await writeFile(sourcePath, "verified lyric\n", "utf8");
    const managedDir = path.dirname(path.join(fixture.vault, ...fixture.managedRelative.split("/")));
    const linkedTarget = path.join(fixture.projectDir, "real-lyrics");
    const linkedFile = path.join(linkedTarget, "song.md");
    await mkdir(linkedTarget, { recursive: true });
    await writeFile(linkedFile, "verified lyric\n", "utf8");
    await rm(managedDir, { recursive: true, force: true });
    await symlink(linkedTarget, managedDir, "junction");
    result = await resolveLyricSourceDesignation(fixture.vault, fixture.projectFile);
    assert.ok(result.failures.some((failure) => failure.includes("symbolic-link path segment")));
  } finally {
    await cleanup(fixture);
  }
});

async function createFixture(): Promise<Fixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lyric-source-resolver-"));
  const vault = path.join(workspace, "vault");
  const projectDir = path.join(vault, "project-memory", "music", "albums", "test", "01-song");
  const projectFile = path.join(projectDir, "project.md");
  const sourceRelative = "lyrics/albums/test/01-song.md";
  const managedRelative = "project-memory/music/albums/test/01-song/lyrics/01-song.md";
  const manifestRelative = "project-memory/music/albums/test/migration-manifest.md";
  const sourcePath = path.join(vault, ...sourceRelative.split("/"));
  const managedPath = path.join(vault, ...managedRelative.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(managedPath), { recursive: true });
  await writeFile(sourcePath, "verified lyric\n", "utf8");
  await writeFile(managedPath, "verified lyric\n", "utf8");
  const sourceBytes = await readFile(sourcePath);
  const managedBytes = await readFile(managedPath);
  const fixture: Fixture = {
    workspace,
    vault,
    projectDir,
    projectFile,
    sourceRelative,
    managedRelative,
    manifestRelative,
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    managedSha256: createHash("sha256").update(managedBytes).digest("hex"),
    sourceSize: sourceBytes.length,
    managedSize: managedBytes.length
  };
  await writeDesignation(fixture, {});
  await writeManifest(fixture, [manifestEntry(fixture)]);
  return fixture;
}

async function resetFixture(fixture: Fixture): Promise<void> {
  await writeDesignation(fixture, {});
  await writeManifest(fixture, [manifestEntry(fixture)]);
}

async function writeDesignation(fixture: Fixture, overrides: Record<string, string>): Promise<void> {
  const fields = {
    source_path: fixture.sourceRelative,
    canonical_lyric_source: fixture.sourceRelative,
    managed_lyric_copy: fixture.managedRelative,
    ...overrides
  };
  await writeFile(fixture.projectFile, `---
provenance:
  contract: lyric-source-designation.v1
  status: verified
  migration_record: ${fixture.manifestRelative}
source_path: ${fields.source_path}
canonical_lyric_source: ${fields.canonical_lyric_source}
managed_lyric_copy: ${fields.managed_lyric_copy}
source_sha256: ${fixture.sourceSha256}
managed_sha256: ${fixture.managedSha256}
verification_method: sha256-byte-match
verification_state: verified
designation_state: human-approved
---
# Song
`, "utf8");
}

function manifestEntry(fixture: Fixture) {
  return {
    project_path: "project-memory/music/albums/test/01-song",
    source_path: fixture.sourceRelative,
    managed_lyric_copy: fixture.managedRelative,
    source_size_bytes: fixture.sourceSize,
    managed_size_bytes: fixture.managedSize,
    source_sha256: fixture.sourceSha256,
    managed_sha256: fixture.managedSha256,
    verification_method: "sha256-byte-match",
    verification_state: "verified",
    designation_state: "human-approved",
    verified_at: "2026-07-22T00:00:00.000Z"
  };
}

async function writeManifest(fixture: Fixture, entries: unknown[]): Promise<void> {
  const yamlEntries = entries.length === 0
    ? "entries: []"
    : `entries:\n${entries.map((entry) => {
        const record = entry as Record<string, unknown>;
        return Object.entries(record).map(([key, value], index) => `${index === 0 ? "  - " : "    "}${key}: ${String(value)}`).join("\n");
      }).join("\n")}`;
  await writeFile(path.join(fixture.vault, ...fixture.manifestRelative.split("/")), `---
contract: lyric-source-migration-manifest.v1
${yamlEntries}
---
# Manifest
`, "utf8");
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.workspace, { recursive: true, force: true });
}
