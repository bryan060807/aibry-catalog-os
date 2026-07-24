import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertNoLinkedPathSegment, assertOutputOutsideRoot, normalizeContractPath } from "../src/kernel/contract-path.js";
import { buildReviewDecision } from "../src/lyric-source/approval.js";
import { runLyricSourceApplyDryRun } from "../src/lyric-source/dry-run-specialist.js";
import { compileLyricSourceProposal, reconstructProposalCanonicalHashPayload } from "../src/lyric-source/proposal-specialist.js";
import { compileWindowsApplyCandidate, releaseWindowsApplyScript } from "../src/lyric-source/windows-apply-builder.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

const execFileAsync = promisify(execFile);
const powerShell51 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

test("generated Windows APPLY candidate uses PowerShell 5.1-compatible shared helpers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-candidate-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  assert.match(candidate.content, /^\[CmdletBinding\(\)\]/);
  for (const helper of ["ConvertTo-FlatArray", "ConvertTo-SingleContractObject", "ConvertTo-ContractPath", "ConvertTo-NativePath", "Get-CompatibleSha256", "Read-JsonReportFromDisk", "Assert-ScalarString", "Assert-PathInsideRoot", "Assert-NoLinkedPathSegment", "Assert-ExpectedCount", "Create-RollbackPackage", "Restore-RollbackPackage", "Compare-VaultSnapshots"]) {
    assert.match(candidate.content, new RegExp(`function ${helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.doesNotMatch(candidate.content, /SHA256\.HashData|Convert\.ToHexString/);
  assert.equal((candidate.content.match(/function Invoke-AsosRefreshAndLoadReport/g) ?? []).length, 1);
  assert.equal((candidate.content.match(/Invoke-AsosRefreshAndLoadReport 'pre'/g) ?? []).length, 1);
  assert.equal((candidate.content.match(/Invoke-AsosRefreshAndLoadReport 'post'/g) ?? []).length, 1);
  assert.match(candidate.content, /\$ExpectedOperationCount = 7/);
  assert.match(candidate.content, /\$ExpectedEvidenceCount = 4/);
  assert.match(candidate.content, /Assert-ExpectedCount \$operations \$ExpectedOperationCount/);
  assert.match(candidate.content, /Assert-ExpectedCount \$evidence \$ExpectedEvidenceCount/);
  assert.match(candidate.content, /Read-Host 'Type APPLY exactly to continue'/);
  assert.match(candidate.content, /\$authorization -cne 'APPLY'/);
  for (const lineageField of ["proposalArtifactSha256", "proposalCanonicalSha256", "decisionArtifactSha256", "handoffArtifactSha256", "dryRunReportSha256", "actualScriptSha256", "preWorkflowReportSha256", "postWorkflowReportSha256", "validatorReportSha256"]) {
    assert.match(candidate.content, new RegExp(lineageField));
  }
});

test("contract paths normalize separators and reject absolute or dot-segment paths", () => {
  assert.equal(normalizeContractPath("project-memory\\music//albums/example.md"), "project-memory/music/albums/example.md");
  assert.throws(() => normalizeContractPath("C:\\AIBRY\\music-vault\\file.md"), /Absolute/);
  assert.throws(() => normalizeContractPath("project-memory/../lyrics/file.md"), /Dot segments/);
  assert.throws(() => normalizeContractPath("/absolute/file.md"), /Absolute/);
});

test("linked path segments and live Vault dry-run inputs are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linked-contract-path-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await mkdir(target);
  await symlink(target, linked, "junction");
  await assert.rejects(assertNoLinkedPathSegment(root, "linked/file.md", true), /Linked path segment/);
  await assert.rejects(runLyricSourceApplyDryRun("proposal.json", "candidate.ps1", "C:\\AIBRY\\music-vault", "2026-07-22T00:00:00.000Z"), /live Music Vault/);
});

test("real PowerShell 5.1 array normalization is bounded and never concatenates paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-array-normalization-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const start = candidate.content.indexOf("function Assert-ScalarString");
  const end = candidate.content.indexOf("$compatibilityFaultUsed =");
  assert.ok(start >= 0 && end > start);
  const harness = `${candidate.content.slice(start, end)}
$standard = @('one','two')
$nested = New-Object 'object[,]' 1,1; $nested[0,0] = $standard
$twice = New-Object 'object[,]' 1,1; $twice[0,0] = $nested
$pipeline = @('one','two') | ConvertTo-FlatArray
$mixed = @('one', @('two','three'))
$objectRejected = $false
try { ConvertTo-RequiredArray ([pscustomobject]@{ path = 'bad' }) 'object' | Out-Null } catch { $objectRejected = $true }
$excessRejected = $false
try { ConvertTo-FlatArray $twice 0 | Out-Null } catch { $excessRejected = $true }
[pscustomobject]@{
  standard = @(ConvertTo-FlatArray $standard).Count
  nested = @(ConvertTo-FlatArray $nested).Count
  twice = @(ConvertTo-FlatArray $twice).Count
  pipeline = @($pipeline).Count
  scalar = @(ConvertTo-FlatArray 'one').Count
  empty = @(ConvertTo-FlatArray @()).Count
  mixed = @(ConvertTo-FlatArray $mixed).Count
  objectRejected = $objectRejected
  excessRejected = $excessRejected
} | ConvertTo-Json -Compress
`;
  const harnessPath = path.join(root, "array-harness.ps1");
  await writeFile(harnessPath, harness, "utf8");
  const { stdout } = await execFileAsync(powerShell51, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath]);
  const result = JSON.parse(stdout.trim()) as Record<string, number | boolean>;
  assert.deepEqual(result, { standard: 2, nested: 2, twice: 2, pipeline: 2, scalar: 1, empty: 0, mixed: 3, objectRejected: true, excessRejected: true });
});

test("TypeScript and PowerShell 5.1 reconstruct identical canonical proposal payloads for both golden fixtures", async () => {
  for (const fixtureName of ["black-box-psalms", "the-violence-of-spring"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `powershell-canonical-${fixtureName}-`));
    const fixture = await materializeGoldenLyricFixture(fixtureName, root);
    const proposal = compileLyricSourceProposal(fixture.input);
    const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
    const candidate = compileWindowsApplyCandidate(proposal, decision);
    const start = candidate.content.indexOf("function Assert-ScalarString");
    const end = candidate.content.indexOf("function Write-JsonNoBom");
    const proposalBase64 = Buffer.from(JSON.stringify(proposal), "utf8").toString("base64");
    const harness = `${candidate.content.slice(start, end)}
$proposal = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${proposalBase64}')))
$canonical = Assert-ProposalCanonicalIntegrity $proposal
[pscustomobject]@{ canonicalBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($canonical)); sha256 = Get-CompatibleBytesSha256 ([System.Text.Encoding]::UTF8.GetBytes($canonical)) } | ConvertTo-Json -Compress
`;
    const harnessPath = path.join(root, "canonical-harness.ps1");
    await writeFile(harnessPath, harness, "utf8");
    const { stdout } = await execFileAsync(powerShell51, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath]);
    const result = JSON.parse(stdout.trim()) as { canonicalBase64: string; sha256: string };
    assert.equal(Buffer.from(result.canonicalBase64, "base64").toString("utf8"), reconstructProposalCanonicalHashPayload(proposal));
    assert.equal(result.sha256, proposal.proposalSha256);
  }
});

test("AuthorizationInput APPLY without CompatibilityMode is refused before Vault access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-authorization-bypass-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const scriptPath = path.join(root, "lyric-source-windows-apply.v1.ps1");
  await writeFile(scriptPath, candidate.content, "utf8");
  const missingVault = path.join(root, "must-not-be-accessed");
  await assert.rejects(execFileAsync(powerShell51, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-VaultRoot", missingVault, "-RollbackRoot", path.join(root, "rollback"), "-ResultReportPath", path.join(root, "result.json"),
    "-WorkflowCommand", "never-run", "-PreWorkflowReportPath", path.join(root, "pre.json"), "-PostWorkflowReportPath", path.join(root, "post.json"),
    "-ValidatorCommand", "never-run", "-ValidatorReportPath", path.join(root, "validator.json"), "-AuthorizationInput", "APPLY"
    ,"-ProposalArtifactPath", path.join(root, "proposal.json"), "-DecisionArtifactPath", path.join(root, "decision.json"), "-DryRunReportPath", path.join(root, "dry-run.json"), "-HandoffArtifactPath", path.join(root, "handoff.json")
  ]), /forbidden outside CompatibilityMode/);
});

test("PowerShell rejects rollback and report roots inside or linked into the fixture Vault", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-output-boundaries-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  await writeFile(path.join(fixture.vault, ".asos-fixture-vault"), "temporary mirror only\n", "utf8");
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const scriptPath = path.join(root, "lyric-source-windows-apply.v1.ps1");
  await writeFile(scriptPath, candidate.content, "utf8");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-AuthorizationInput", "APPLY", "-CompatibilityMode", "-WorkflowCommand", "never-run", "-ValidatorCommand", "never-run", "-ProposalArtifactPath", path.join(outside, "proposal.json"), "-DecisionArtifactPath", path.join(outside, "decision.json"), "-DryRunReportPath", path.join(outside, "dry-run.json"), "-HandoffArtifactPath", path.join(outside, "handoff.json")];
  const invoke = (vault: string, rollback: string, result: string, pre: string, post: string, validator: string) => execFileAsync(powerShell51, [...base,
    "-VaultRoot", vault, "-RollbackRoot", rollback, "-ResultReportPath", result,
    "-PreWorkflowReportPath", pre, "-PostWorkflowReportPath", post, "-ValidatorReportPath", validator
  ]);
  const valid = { rollback: path.join(outside, "rollback"), result: path.join(outside, "result.json"), pre: path.join(outside, "pre.json"), post: path.join(outside, "post.json"), validator: path.join(outside, "validator.json") };
  await assert.rejects(invoke(fixture.vault, path.join(fixture.vault, "rollback"), valid.result, valid.pre, valid.post, valid.validator), /RollbackRoot must remain outside VaultRoot/);
  await assert.rejects(invoke(fixture.vault, valid.rollback, path.join(fixture.vault, "result.json"), valid.pre, valid.post, valid.validator), /ResultReportPath must remain outside VaultRoot/);
  await assert.rejects(invoke(fixture.vault, valid.rollback, valid.result, path.join(fixture.vault, "pre.json"), valid.post, valid.validator), /PreWorkflowReportPath must remain outside VaultRoot/);
  const linkedOutput = path.join(root, "linked-output");
  await symlink(fixture.vault, linkedOutput, "junction");
  await assert.rejects(invoke(fixture.vault, valid.rollback, path.join(linkedOutput, "result.json"), valid.pre, valid.post, valid.validator), /reparse path segment is forbidden/);
  const linkedVault = path.join(root, "linked-vault");
  await symlink(fixture.vault, linkedVault, "junction");
  await assert.rejects(invoke(linkedVault, valid.rollback, valid.result, valid.pre, valid.post, valid.validator), /reparse path segment is forbidden/);
  const rollbackTarget = path.join(root, "rollback-target");
  await mkdir(rollbackTarget);
  const linkedRollback = path.join(root, "linked-rollback");
  await symlink(rollbackTarget, linkedRollback, "junction");
  await assert.rejects(invoke(fixture.vault, linkedRollback, valid.result, valid.pre, valid.post, valid.validator), /reparse path segment is forbidden/);
  await assert.doesNotReject(assertOutputOutsideRoot(fixture.vault, `${fixture.vault}-backup\\result.json`));
});

test("complete temporary-mirror PowerShell 5.1 dry-run passes and gates release", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-dry-run-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const proposalPath = path.join(root, "lyric-source-designation-proposal.v1.json");
  const scriptPath = path.join(root, "lyric-source-windows-apply.v1.ps1");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  await writeFile(scriptPath, candidate.content, "utf8");
  const fakeReport = {
    contract: "lyric-source-apply-dry-run-report.v1" as const,
    generatedAt: proposal.generatedAt,
    powerShellVersion: "5.1",
    proposalIdentity: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, artifactSha256: "0".repeat(64) },
    scriptIdentity: { contract: "lyric-source-windows-apply-script.v1" as const, scriptSha256: "0".repeat(64) },
    parsedCollectionCounts: { operations: 7, evidence: 4, guards: 2 },
    normalizedPathChecks: [],
    rollbackChecks: { targetCount: 7, originalsRehashed: true, pathsInsideRollbackRoot: true },
    reportChecks: { preReportLoadedFromDisk: true, postReportLoadedFromDisk: true, sameLoader: true, wrappedObjectsNormalized: true },
    resolverLookupChecks: { expected: 4, foundExactlyOnce: 4 },
    expectedDeltas: proposal.expectedFindingDeltas,
    forcedFailureRollback: { attempted: true, restoredAllTargets: true },
    independentValidation: { ranFromPersistedArtifacts: true, status: "passed" as const },
    unrelatedFileDiffDetected: true,
    liveVaultAccess: false as const,
    mutationTarget: "temporary-mirror-only" as const,
    status: "passed" as const,
    failures: []
  };
  await assert.rejects(releaseWindowsApplyScript(path.join(root, "unreleased.ps1"), proposal, decision, fakeReport), /matching successful compatibility dry-run/);
  const report = await runLyricSourceApplyDryRun(proposalPath, scriptPath, fixture.vault, proposal.generatedAt);
  assert.equal(report.status, "passed", report.failures.join("; "));
  assert.match(report.powerShellVersion, /^5\.1\./);
  assert.deepEqual(report.parsedCollectionCounts, { operations: 7, evidence: 4, guards: 2 });
  assert.equal(report.forcedFailureRollback.restoredAllTargets, true);
  assert.equal(report.unrelatedFileDiffDetected, true);
  assert.equal(report.independentValidation.status, "passed");
  assert.equal(report.liveVaultAccess, false);
  assert.equal(report.mutationTarget, "temporary-mirror-only");
  const scenarios = new Map((report.scenarios ?? []).map((scenario) => [scenario.name, scenario]));
  for (const name of [
    "failure-during-third-write", "failure-during-post-refresh", "validator-failure", "validator-exits-zero-with-invalid-report",
    "unrelated-file-mutation", "nested-operation-array", "nested-evidence-array", "nested-guard-array",
    "nested-resolver-report-array", "wrapped-workflow-report", "stale-workflow-report", "zero-matching-workflow-contracts",
    "multiple-matching-workflow-contracts", "wrong-workflow-contract", "missing-workflow-fields", "nonzero-workflow-command"
  ]) assert.equal(scenarios.get(name)?.observed, scenarios.get(name)?.expected, name);
  assert.equal(scenarios.get("lowercase-authorization-refused")?.observed, "failed");
  for (const name of [
    "missing-decision-artifact", "decision-not-approved", "wrong-decision-hash", "decision-proposal-mismatch", "missing-handoff-artifact",
    "handoff-references-another-script", "script-modified-after-dry-run", "handoff-references-another-dry-run", "dry-run-status-failed",
    "dry-run-reports-live-vault-access", "handoff-already-executed", "governance-artifact-inside-vault",
    "tampered-embedded-operation-path", "tampered-embedded-operation-hash", "tampered-embedded-content-base64", "tampered-embedded-evidence-row",
    "tampered-embedded-guard", "tampered-embedded-expected-count", "tampered-embedded-rollback-requirement",
    "tampered-embedded-validator-criterion", "tampered-embedded-resolver-project"
  ]) assert.equal(scenarios.get(name)?.observed, "failed", name);
  const releaseDirectory = path.join(root, "released");
  await mkdir(releaseDirectory);
  const releasePath = path.join(releaseDirectory, "lyric-source-windows-apply-release.v1.ps1");
  await releaseWindowsApplyScript(releasePath, proposal, decision, report);
  assert.equal(await readFile(releasePath, "utf8"), candidate.content);
});
