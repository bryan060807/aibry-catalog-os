import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { scanProjectDirectories } from "../src/catalog/project-reader.js";

test("discovery rejects a missing vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  try {
    await assert.rejects(
      () => main([
        "catalog",
        "discover",
        "--vault",
        path.join(workspace, "missing-vault"),
        "--output",
        path.join(workspace, "report.md")
      ]),
      /Vault path does not exist/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects output inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  try {
    await createFixtureVault(vault);
    await assert.rejects(
      () => main([
        "catalog",
        "discover",
        "--vault",
        vault,
        "--output",
        path.join(vault, "reports", "discovery.md")
      ]),
      /Refusing to write discovery output inside the vault/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects output routed into the vault through a directory link", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const vaultLink = path.join(workspace, "vault-link");
  try {
    await createFixtureVault(vault);
    try {
      await symlink(vault, vaultLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("Directory links are not permitted in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => main([
        "catalog",
        "discover",
        "--vault",
        vault,
        "--output",
        path.join(vaultLink, "reports", "discovery.md")
      ]),
      /Refusing to write discovery output inside the vault/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery skips directory links that would leave the scan scope", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const externalProject = path.join(workspace, "external-project");
  const linkedProject = path.join(vault, "project-memory", "music", "singles", "Linked Song");
  const output = path.join(workspace, "discovery.md");
  try {
    await createFixtureVault(vault);
    await mkdir(externalProject, { recursive: true });
    await writeFile(path.join(externalProject, "project.md"), "# Must Not Be Scanned\n", "utf8");
    try {
      await symlink(externalProject, linkedProject, process.platform === "win32" ? "junction" : "dir");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("Directory links are not permitted in this environment.");
        return;
      }
      throw error;
    }

    await main(["catalog", "discover", "--vault", vault, "--output", output]);

    const report = await readFile(output, "utf8");
    assert.match(report, /Skipped directory link or junction: project-memory[\\/]music[\\/]singles[\\/]Linked Song/);
    assert.doesNotMatch(report, /Must Not Be Scanned/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects a canonical instruction reached through a directory link", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const instructions = path.join(vault, "instructions");
  const externalInstructions = path.join(workspace, "external-instructions");
  try {
    await createFixtureVault(vault);
    await rm(instructions, { recursive: true });
    await mkdir(externalInstructions, { recursive: true });
    await writeFile(path.join(externalInstructions, "catalog-structure.md"), "# External\n", "utf8");
    try {
      await symlink(externalInstructions, instructions, process.platform === "win32" ? "junction" : "dir");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("Directory links are not permitted in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => main(["catalog", "discover", "--vault", vault, "--output", path.join(workspace, "report.md")]),
      /Canonical instruction must not use a symbolic link, junction, mount point, or reparse-point alias/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects a canonical instruction file link", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const instruction = path.join(vault, "instructions", "catalog-structure.md");
  const externalInstruction = path.join(workspace, "external-catalog-structure.md");
  try {
    await createFixtureVault(vault);
    await writeFile(externalInstruction, "# External\n", "utf8");
    await rm(instruction);
    try {
      await symlink(externalInstruction, instruction, "file");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("File links are not permitted in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => main(["catalog", "discover", "--vault", vault, "--output", path.join(workspace, "report.md")]),
      /Canonical instruction must not use a symbolic link, junction, mount point, or reparse-point alias/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects a pre-existing output hard link to a vault file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const vaultFile = path.join(vault, "instructions", "catalog-structure.md");
  const output = path.join(workspace, "report.md");
  try {
    await createFixtureVault(vault);
    await link(vaultFile, output);

    await assert.rejects(
      () => main(["catalog", "discover", "--vault", vault, "--output", output]),
      /Refusing to write discovery output because it aliases a vault file/
    );
    assert.equal(await readFile(vaultFile, "utf8"), "# Catalog Structure\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects a dangling output symbolic link into the vault", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "report.md");
  const missingVaultTarget = path.join(vault, "reports", "discovery.md");
  try {
    await createFixtureVault(vault);
    try {
      await symlink(missingVaultTarget, output, "file");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("File links are not permitted in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => main(["catalog", "discover", "--vault", vault, "--output", output]),
      /Refusing to write discovery output through a symbolic link/
    );
    await assert.rejects(() => stat(missingVaultTarget), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery generates a Markdown report from a temporary vault without modifying it", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "reports", "discovery.md");

  try {
    await createFixtureVault(vault);
    const before = await snapshotFiles(vault);

    await main(["catalog", "discover", "--vault", vault, "--output", output]);

    const after = await snapshotFiles(vault);
    const report = await readFile(output, "utf8");
    assert.deepEqual(after, before);
    assert.match(report, /^# AIBRY Catalog Discovery Report/m);
    assert.match(report, /## Managed Songs \(Admitted by project\.md\)/);
    assert.match(report, /## Provisional \/ Unadmitted Song Candidates/);
    assert.match(report, /## Album Release Containers \(Not Managed Projects\)/);
    assert.match(report, /## Copy\/Paste Placeholders Excluded From Managed Projects/);
    assert.match(report, /## Legacy Corpus \/ Migration Inventory/);
    assert.match(report, /project-memory[\\/]music[\\/]singles[\\/]The Kid in the Machine/);
    assert.match(report, /project-memory[\\/]music[\\/]albums[\\/]the-architecture-is-failing[\\/]04-termination-code/);
    assert.match(report, /project\.md missing/);
    assert.match(report, /do not count as managed songs, discovered projects, or release completeness/);
    assert.match(report, /lyrics[\\/]albums[\\/]The Violence of Spring[\\/]08-cobalt-infrastructure\.md/);
    assert.match(report, /No Music Vault files were changed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery rejects a vault without the canonical instruction", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  try {
    await mkdir(vault, { recursive: true });
    await assert.rejects(
      () => main([
        "catalog",
        "discover",
        "--vault",
        vault,
        "--output",
        path.join(workspace, "report.md")
      ]),
      /Canonical instruction does not exist/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery classifies the current managed songs, placeholders, and legacy corpus inventory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  try {
    await createFixtureVault(vault);

    const scan = await scanProjectDirectories(vault);
    const managedSongPaths = scan.managedSongs.map((candidate) => candidate.relativePath);
    const managedAlbumTrackPaths = scan.managedSongs
      .filter((candidate) => candidate.releaseContext.type === "album-track")
      .map((candidate) => candidate.relativePath);
    const provisionalCandidatePaths = scan.provisionalSongCandidates.map((candidate) => candidate.relativePath);
    const placeholderPaths = scan.placeholders.map((placeholder) => placeholder.relativePath);
    const legacyCorpusPaths = scan.legacyCorpusEntries.map((entry) => entry.relativePath);

    for (const title of ["The Kid in the Machine", "Pressure Flower", "Came Out Wrong"]) {
      const relativePath = path.join("project-memory", "music", "singles", title);
      assert.ok(managedSongPaths.includes(relativePath), `${title} should be a managed song`);
      assert.equal(provisionalCandidatePaths.includes(relativePath), false, `${title} should have its own project.md`);
    }
    const releaseRelativePath = path.join("project-memory", "music", "albums", "Ground Wire Gospel");
    const expectedTrackPaths = [
      "01-rust-on-the-ignition",
      "02-oxidation-at-the-joints",
      "03-voltage-bleed",
      "04-scrap-iron-sermon",
      "05-hemlock-and-concrete",
      "06-tectonic-deficit",
      "07-seismic-debt",
      "08-ground-wire-autopsy",
      "09-wiretap-eviction"
    ].map((track) => path.join(releaseRelativePath, track));
    assert.equal(managedSongPaths.length, 12);
    assert.deepEqual(managedAlbumTrackPaths, expectedTrackPaths);
    assert.ok(scan.albumReleaseContainers.some((container) => container.relativePath === releaseRelativePath));
    assert.equal(scan.managedSongs.some((song) => song.relativePath === releaseRelativePath), false);
    assert.equal(scan.managedSongs.some((song) => song.relativePath === path.join(releaseRelativePath, "artwork")), false);
    assert.equal(scan.projectFiles.length, 12);
    const provisionalTrackPath = path.join("project-memory", "music", "albums", "the-architecture-is-failing", "04-termination-code");
    assert.deepEqual(provisionalCandidatePaths, [provisionalTrackPath]);
    assert.equal(scan.managedSongs.some((song) => song.relativePath === provisionalTrackPath), false);
    assert.equal(scan.projectFiles.some((project) => project.directoryRelativePath === provisionalTrackPath), false);
    for (const trackPath of expectedTrackPaths) {
      const track = scan.managedSongs.find((song) => song.relativePath === trackPath);
      assert.ok(track, `${trackPath} should be a managed album track`);
      assert.deepEqual(track.releaseContext, {
        type: "album-track",
        albumTitle: "Ground Wire Gospel",
        releaseContainerRelativePath: releaseRelativePath
      });
    }
    assert.ok(placeholderPaths.includes(path.join("project-memory", "music", "singles", "song-name")));
    assert.ok(placeholderPaths.includes(path.join("project-memory", "music", "albums", "album-name")));
    assert.equal(managedSongPaths.some((candidate) => candidate.includes("song-name")), false);
    assert.equal(managedSongPaths.some((candidate) => candidate.includes("album-name")), false);
    assert.equal(managedSongPaths.some((candidate) => candidate.includes(".backups")), false);
    assert.equal(scan.managedSongs.some((candidate) => candidate.relativePath.includes("Cobalt Infrastructure")), false);
    assert.equal(scan.projectFiles.some((project) => project.relativePath.includes("Cobalt Infrastructure")), false);
    assert.ok(legacyCorpusPaths.includes(path.join("lyrics", "albums", "The Violence of Spring")));
    assert.ok(legacyCorpusPaths.includes(path.join("lyrics", "albums", "The Violence of Spring", "08-cobalt-infrastructure.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery treats an album release as a container and each child as a managed song", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  try {
    await createFixtureVault(vault);
    const release = path.join(vault, "project-memory", "music", "albums", "Test Album");
    const track = path.join(release, "01-test-track");
    await mkdir(track, { recursive: true });
    await mkdir(path.join(release, "song-name"), { recursive: true });
    await writeFile(path.join(release, "project.md"), "# Not A Song Project\n", "utf8");
    await writeFile(path.join(track, "project.md"), "# Test Track\n", "utf8");

    const scan = await scanProjectDirectories(vault);
    const trackRelativePath = path.join("project-memory", "music", "albums", "Test Album", "01-test-track");
    const releaseRelativePath = path.join("project-memory", "music", "albums", "Test Album");
    const trackSong = scan.managedSongs.find((song) => song.relativePath === trackRelativePath);

    assert.ok(trackSong);
    assert.deepEqual(trackSong.releaseContext, {
      type: "album-track",
      albumTitle: "Test Album",
      releaseContainerRelativePath: releaseRelativePath
    });
    assert.equal(scan.managedSongs.some((song) => song.relativePath === releaseRelativePath), false);
    assert.ok(scan.albumReleaseContainers.some((container) => container.relativePath === releaseRelativePath));
    assert.equal(scan.projectFiles.some((project) => project.directoryRelativePath === releaseRelativePath), false);
    assert.ok(scan.projectFiles.some((project) => project.directoryRelativePath === trackRelativePath));
    assert.equal(scan.provisionalSongCandidates.some((song) => song.relativePath === trackRelativePath), false);
    assert.ok(scan.placeholders.some((placeholder) => placeholder.relativePath === path.join(releaseRelativePath, "song-name")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovery does not admit song candidates with linked project.md files", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-os-"));
  const vault = path.join(workspace, "vault");
  try {
    await createFixtureVault(vault);
    const song = path.join(vault, "project-memory", "music", "singles", "Unsafe Link");
    const hardLinkedSong = path.join(vault, "project-memory", "music", "singles", "Unsafe Hard Link");
    const externalProject = path.join(workspace, "external-project.md");
    await mkdir(song, { recursive: true });
    await mkdir(hardLinkedSong, { recursive: true });
    await writeFile(externalProject, "# External\n", "utf8");
    try {
      await symlink(externalProject, path.join(song, "project.md"), "file");
    } catch (error: unknown) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) {
        context.skip("File links are not permitted in this environment.");
        return;
      }
      throw error;
    }
    await link(externalProject, path.join(hardLinkedSong, "project.md"));

    const scan = await scanProjectDirectories(vault);
    const relativePath = path.join("project-memory", "music", "singles", "Unsafe Link");
    const hardLinkedRelativePath = path.join("project-memory", "music", "singles", "Unsafe Hard Link");
    assert.equal(scan.managedSongs.some((song) => song.relativePath === relativePath), false);
    assert.equal(scan.managedSongs.some((song) => song.relativePath === hardLinkedRelativePath), false);
    assert.equal(scan.projectFiles.some((project) => project.directoryRelativePath === relativePath), false);
    assert.equal(scan.projectFiles.some((project) => project.directoryRelativePath === hardLinkedRelativePath), false);
    assert.deepEqual(scan.provisionalSongCandidates.find((candidate) => candidate.relativePath === relativePath)?.admissionReason, "unsafe-project-file");
    assert.deepEqual(scan.provisionalSongCandidates.find((candidate) => candidate.relativePath === hardLinkedRelativePath)?.admissionReason, "unsafe-project-file");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createFixtureVault(vault: string): Promise<void> {
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  const singles = path.join(vault, "project-memory", "music", "singles");
  const albumReleaseContainers = path.join(vault, "project-memory", "music", "albums");
  const albums = path.join(vault, "lyrics", "albums");
  await mkdir(path.join(singles, "The Kid in the Machine"), { recursive: true });
  await mkdir(path.join(singles, "Pressure Flower"), { recursive: true });
  await mkdir(path.join(singles, "Came Out Wrong"), { recursive: true });
  await mkdir(path.join(singles, "song-name"), { recursive: true });
  await mkdir(path.join(albumReleaseContainers, "album-name"), { recursive: true });
  const groundWireGospel = path.join(albumReleaseContainers, "Ground Wire Gospel");
  const provisionalRelease = path.join(albumReleaseContainers, "the-architecture-is-failing");
  await mkdir(path.join(groundWireGospel, "artwork"), { recursive: true });
  await mkdir(path.join(groundWireGospel, "song-name"), { recursive: true });
  await mkdir(path.join(provisionalRelease, "04-termination-code"), { recursive: true });
  await mkdir(path.join(albums, "The Violence of Spring"), { recursive: true });
  await mkdir(path.join(albums, "album-name"), { recursive: true });
  await mkdir(path.join(vault, ".backups", "project-memory", "music", "singles", "Backup Song"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Catalog Structure\n", "utf8");
  for (const title of ["The Kid in the Machine", "Pressure Flower", "Came Out Wrong"]) {
    await writeFile(path.join(singles, title, "project.md"), `# ${title}\n`, "utf8");
  }
  for (const track of [
    "01-rust-on-the-ignition",
    "02-oxidation-at-the-joints",
    "03-voltage-bleed",
    "04-scrap-iron-sermon",
    "05-hemlock-and-concrete",
    "06-tectonic-deficit",
    "07-seismic-debt",
    "08-ground-wire-autopsy",
    "09-wiretap-eviction"
  ]) {
    await mkdir(path.join(groundWireGospel, track), { recursive: true });
    await writeFile(path.join(groundWireGospel, track, "project.md"), `# ${track}\n`, "utf8");
  }
  await writeFile(path.join(albums, "The Violence of Spring", "08-cobalt-infrastructure.md"), "# Cobalt Infrastructure\n", "utf8");
  await writeFile(path.join(vault, ".backups", "project-memory", "music", "singles", "Backup Song", "project.md"), "# Backup Song\n", "utf8");
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        await visit(entryPath);
      } else if (entry.isFile()) {
        const content = await readFile(entryPath);
        const fileStat = await stat(entryPath);
        snapshot[relativePath] = `${fileStat.size}:${createHash("sha256").update(content).digest("hex")}`;
      }
    }
  }

  await visit(root);
  return snapshot;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
