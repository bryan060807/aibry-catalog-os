import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import type { ManagedSongContract } from "../src/catalog/contract.js";

test("catalog contract writes the active managed-song contract outside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-contract-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "managed-song-contract.json");
  try {
    await setupVault(vault);
    await main(["catalog", "contract", "--vault", vault, "--output", output]);
    const contract = JSON.parse(await readFile(output, "utf8")) as ManagedSongContract;
    assert.equal(contract.schemaVersion, "managed-song-contract.v1");
    assert.equal(contract.steward.specialist, "Catalog Contract Steward");
    assert.equal(contract.steward.authorityMode, "OBSERVE_PROPOSE");
    assert.equal(contract.steward.sourceOfTruth, "Music Vault");
    assert.equal(contract.steward.vaultMutation, "none");
    assert.equal(contract.canonicalFrontDoor, "project.md");
    assert.ok(contract.lifecycleStates.includes("ready-for-release"));
    assert.ok(contract.requiredFrontMatter.some((field) => field.name === "id" && field.requirement === "required"));
    assert.ok(contract.requiredFrontMatter.some((field) => field.name === "title" && field.requirement === "required"));
    assert.ok(contract.requiredFrontMatter.some((field) => field.name === "lifecycle_state" && field.requirement === "required"));
    assert.ok(contract.safetyRules.some((rule) => rule.includes("never mutates the Music Vault")));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("catalog contract refuses to write the active contract inside the vault", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-contract-"));
  const vault = path.join(workspace, "vault");
  const outputInsideVault = path.join(vault, "contracts", "managed-song-contract.json");
  try {
    await setupVault(vault);
    await assert.rejects(
      () => main(["catalog", "contract", "--vault", vault, "--output", outputInsideVault]),
      /Refusing to write discovery output inside the vault/
    );
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function setupVault(vault: string): Promise<void> {
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
}
