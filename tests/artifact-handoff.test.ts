import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageArtifact, verifyArtifact } from "../src/artifacts/handoff-specialist.js";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import { buildReviewDecision } from "../src/lyric-source/approval.js";
import { compileLyricSourceProposal } from "../src/lyric-source/proposal-specialist.js";
import { compileWindowsApplyCandidate } from "../src/lyric-source/windows-apply-builder.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

test("artifact verifier rejects role and structural mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-roles-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const proposalAsScript = path.join(root, "proposal.ps1");
  await writeFile(proposalAsScript, `${JSON.stringify(proposal)}\n`, "utf8");
  const proposalBytes = await readFile(proposalAsScript);
  const proposalReport = await verifyArtifact(proposalAsScript, proposal.contract, sha256Bytes(proposalBytes));
  assert.equal(proposalReport.verified, false);
  assert.equal(proposalReport.structuralCheck.checks.some((check) => check.check === "filename-role" && !check.passed), true);

  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const scriptAsMarkdown = path.join(root, "apply.md");
  await writeFile(scriptAsMarkdown, candidate.content, "utf8");
  const scriptReport = await verifyArtifact(scriptAsMarkdown, candidate.contract, candidate.sha256);
  assert.equal(scriptReport.verified, false);
  const incorrectHash = await verifyArtifact(scriptAsMarkdown, candidate.contract, "0".repeat(64));
  assert.equal(incorrectHash.verified, false);
});

test("staging reopens and rehashes the exact artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-stage-"));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", path.join(root, "fixture"));
  const proposal = compileLyricSourceProposal(fixture.input);
  const source = path.join(sourceRoot, "lyric-source-designation-proposal.v1.json");
  await writeFile(source, `${JSON.stringify(proposal)}\n`, "utf8");
  const sha = sha256Bytes(await readFile(source));
  const destination = path.join(destinationRoot, "lyric-source-designation-proposal.v1.json");
  const report = await stageArtifact(source, destination, proposal.contract, sha);
  assert.equal(report.staged.actualSha256, sha);
  assert.equal(report.source.byteSize, report.staged.byteSize);
  assert.equal(report.checks.exactSha256, true);
});

test("conflicting active artifacts are identified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-conflict-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", path.join(root, "fixture"));
  const proposal = compileLyricSourceProposal(fixture.input);
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  await writeFile(first, `${JSON.stringify(proposal)}\n`, "utf8");
  await writeFile(second, `${JSON.stringify(proposal)}\n`, "utf8");
  const report = await verifyArtifact(first, proposal.contract, sha256Bytes(await readFile(first)));
  assert.equal(report.supersessionState, "conflicting-active-artifact");
  assert.deepEqual(report.conflicts, [second]);
});

test("script identity rejects marker-only files and a wrong embedded proposal binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-script-identity-"));
  const markerOnly = path.join(root, "lyric-source-windows-apply.v1.ps1");
  await writeFile(markerOnly, "# contract: lyric-source-windows-apply-script.v1\n", "utf8");
  const markerBytes = await readFile(markerOnly);
  assert.equal((await verifyArtifact(markerOnly, "lyric-source-windows-apply-script.v1", sha256Bytes(markerBytes))).verified, false);

  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", path.join(root, "fixture"));
  const proposal = compileLyricSourceProposal(fixture.input);
  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const candidate = compileWindowsApplyCandidate(proposal, decision);
  const script = path.join(root, "lyric-source-windows-apply-tampered.v1.ps1");
  const wrongIdentity = candidate.content.replace(`$ExpectedProposalId = '${proposal.proposalId}'`, "$ExpectedProposalId = 'wrong-proposal'");
  await writeFile(script, wrongIdentity, "utf8");
  const report = await verifyArtifact(script, candidate.contract, sha256Bytes(await readFile(script)), script, { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256 });
  assert.equal(report.verified, false);
  assert.equal(report.structuralCheck.checks.some((check) => check.check === "embedded-proposal-id" && !check.passed), true);
});

test("workflow files that merely reference the proposal contract are not classified as proposal conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-reference-not-conflict-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", path.join(root, "fixture"));
  const proposal = compileLyricSourceProposal(fixture.input);
  const proposalPath = path.join(root, "lyric-source-designation-proposal.v1.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal)}\n`, "utf8");
  await writeFile(path.join(root, "workflow-reference.json"), `${JSON.stringify({ contract: "asos-workflow-run.v1", referencedContract: proposal.contract })}\n`, "utf8");
  const report = await verifyArtifact(proposalPath, proposal.contract, sha256Bytes(await readFile(proposalPath)));
  assert.equal(report.verified, true);
  assert.deepEqual(report.conflicts, []);
});
