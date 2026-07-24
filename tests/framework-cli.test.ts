import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { buildReviewDecision } from "../src/lyric-source/approval.js";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("specialist list and describe CLI commands emit deterministic JSON without Vault access", async () => {
  const first = await execFileAsync(process.execPath, [cliPath, "catalog", "specialist", "list"]);
  const second = await execFileAsync(process.execPath, [cliPath, "catalog", "specialist", "list"]);
  assert.equal(first.stdout, second.stdout);
  const registry = JSON.parse(first.stdout) as { contract: string; specialists: Array<{ id: string }> };
  assert.equal(registry.contract, "specialist-registry.v1");
  assert.equal(registry.specialists.some((manifest) => manifest.id === "lyric-source-proposal"), true);
  const described = await execFileAsync(process.execPath, [cliPath, "catalog", "specialist", "describe", "windows-lyric-source-apply-builder"]);
  assert.equal((JSON.parse(described.stdout) as { supportedRuntime: string }).supportedRuntime, "Windows PowerShell 5.1");
});

test("plan workflow emits one deterministic proposal and one Review Inbox item", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "framework-cli-plan-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const output = path.join(root, "lyric-source-designation-proposal.v1.json");
  await execFileAsync(process.execPath, [cliPath, "catalog", "workflow", "plan-lyric-source-migration", "--input", fixture.inputPath, "--output", output]);
  const proposal = JSON.parse(await readFile(output, "utf8")) as { contract: string; operations: unknown[]; approvalState: string; applyEnabled: boolean };
  const review = JSON.parse(await readFile(`${output}.review-inbox.json`, "utf8")) as { proposalCount: number; proposals: unknown[] };
  const workflow = JSON.parse(await readFile(`${output}.workflow.json`, "utf8")) as { contract: string; safety: { applyEnabled: boolean; vaultMutation: string } };
  assert.equal(proposal.contract, "lyric-source-designation-proposal.v1");
  assert.equal(proposal.operations.length, 7);
  assert.equal(proposal.approvalState, "pending");
  assert.equal(proposal.applyEnabled, false);
  assert.equal(review.proposalCount, 1);
  assert.equal(review.proposals.length, 1);
  assert.equal(workflow.contract, "asos-workflow-run.v1");
  assert.deepEqual(workflow.safety, { applyEnabled: false, vaultMutation: "none" });
});

test("build workflow compatibility-tests a temporary candidate before releasing one HANDOFF", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "framework-cli-build-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposalPath = path.join(root, "lyric-source-designation-proposal.v1.json");
  await execFileAsync(process.execPath, [cliPath, "catalog", "workflow", "plan-lyric-source-migration", "--input", fixture.inputPath, "--output", proposalPath]);
  const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as { proposalId: string; proposalSha256: string; generatedAt: string };
  const approvalPath = path.join(root, "asos-authority-decision.v1.json");
  await writeFile(approvalPath, `${JSON.stringify(buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt), null, 2)}\n`, "utf8");
  const dryRunPath = path.join(root, "lyric-source-apply-dry-run-report.v1.json");
  const scriptPath = path.join(root, "lyric-source-windows-apply-release.v1.ps1");
  await execFileAsync(process.execPath, [cliPath, "catalog", "workflow", "build-windows-lyric-source-apply", "--proposal", proposalPath, "--approval", approvalPath, "--fixture-vault", fixture.vault, "--dry-run-report", dryRunPath, "--output", scriptPath], { timeout: 240_000 });
  const dryRun = JSON.parse(await readFile(dryRunPath, "utf8")) as { status: string; liveVaultAccess: boolean };
  const script = await readFile(scriptPath, "utf8");
  const packageRoot = `${scriptPath}.operator-package`;
  const handoff = JSON.parse(await readFile(path.join(packageRoot, "lyric-source-apply-handoff.v1.json"), "utf8")) as { contract: string; applyExecuted: boolean; state: string };
  const operatorPackage = JSON.parse(await readFile(path.join(packageRoot, "lyric-source-operator-package.v1.json"), "utf8")) as { artifacts: Array<{ canonicalPath: string; sha256: string; byteSize: number }>; executionCommands: string[] };
  assert.equal(dryRun.status, "passed");
  assert.equal(dryRun.liveVaultAccess, false);
  assert.match(script, /^\[CmdletBinding\(\)\]/);
  assert.equal(handoff.contract, "lyric-source-apply-handoff.v1");
  assert.equal(handoff.state, "eligible-for-guarded-apply");
  assert.equal(handoff.applyExecuted, false);
  assert.equal(operatorPackage.artifacts.length, 5);
  assert.equal(operatorPackage.executionCommands.length, 1);
  assert.match(operatorPackage.executionCommands[0] ?? "", /-HandoffArtifactPath/);
  for (const artifact of operatorPackage.artifacts) {
    const bytes = await readFile(path.join(packageRoot, artifact.canonicalPath));
    assert.equal(bytes.byteLength, artifact.byteSize);
    assert.equal(sha256Bytes(bytes), artifact.sha256);
  }
});
