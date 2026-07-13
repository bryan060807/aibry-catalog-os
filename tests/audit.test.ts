import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";

test("archivist audit reports evidence without mutating a temporary vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-audit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "audit.md");
  try {
    await mkdir(path.join(vault, "instructions"), { recursive: true });
    await mkdir(path.join(vault, "project-memory", "music", "singles", "One"), { recursive: true });
    await mkdir(path.join(vault, "project-memory", "music", "singles", "Two"), { recursive: true });
    await mkdir(path.join(vault, "project-memory", "music", "albums", "Empty Album"), { recursive: true });
    await mkdir(path.join(vault, "lyrics", "singles"), { recursive: true });
    await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
    await writeFile(path.join(vault, "project-memory", "music", "singles", "One", "project.md"), "---\nid: duplicate\nrelated_to: project-memory/music/singles/Missing/project.md\n---\n# Same\n", "utf8");
    await writeFile(path.join(vault, "project-memory", "music", "singles", "Two", "project.md"), "---\nid: duplicate\n---\n# Same\n", "utf8");
    await writeFile(path.join(vault, "lyrics", "singles", "legacy.md"), "# Legacy\n", "utf8");

    await main(["catalog", "audit", "--vault", vault, "--output", output]);
    const report = await readFile(output, "utf8");
    for (const expected of ["Duplicate title: same", "Duplicate ID: duplicate", "Album release container has no admitted tracks", "Broken declared relationship", "Legacy corpus remains an inventory", "This audit never moves, renames, deletes, rewrites, or auto-corrects Music Vault content."]) {
      assert.match(report, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.equal(await readFile(path.join(vault, "project-memory", "music", "singles", "One", "project.md"), "utf8"), "---\nid: duplicate\nrelated_to: project-memory/music/singles/Missing/project.md\n---\n# Same\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
