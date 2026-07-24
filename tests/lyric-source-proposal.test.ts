import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../src/kernel/canonical-json.js";
import type { LyricSourceDesignationProposal } from "../src/lyric-source/contracts.js";
import { assertProposalIntegrity, compileLyricSourceProposal, reconstructProposalCanonicalHashPayload, SpecialistRefusalError } from "../src/lyric-source/proposal-specialist.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";

test("golden proposals are deterministic and retain proven operation counts", async () => {
  const blackRoot = await mkdtemp(path.join(os.tmpdir(), "black-box-proposal-"));
  const violenceRoot = await mkdtemp(path.join(os.tmpdir(), "violence-proposal-"));
  const black = await materializeGoldenLyricFixture("black-box-psalms", blackRoot);
  const violence = await materializeGoldenLyricFixture("the-violence-of-spring", violenceRoot);
  const blackFirst = compileLyricSourceProposal(black.input);
  const blackSecond = compileLyricSourceProposal(structuredClone(black.input));
  const violenceProposal = compileLyricSourceProposal(violence.input);
  assert.deepEqual(blackFirst, blackSecond);
  assert.equal(blackFirst.proposalSha256, blackSecond.proposalSha256);
  assert.equal(blackFirst.operations.length, 8);
  assert.equal(violenceProposal.operations.length, 7);
  assert.deepEqual(blackFirst.operations.map((operation) => operation.path), [...blackFirst.operations.map((operation) => operation.path)].sort((left, right) => left.localeCompare(right)));
  assert.equal(violenceProposal.excludedProjects.length, 1);
  assert.match(violenceProposal.excludedProjects[0]?.reason ?? "", /Track 05 evidence changed/);
  assert.equal(violenceProposal.approvalState, "pending");
  assert.equal(violenceProposal.applyEnabled, false);
  assert.equal(violenceProposal.vaultMutation, "none");
});

test("proposal compiler verifies exact current and lyric hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proposal-stale-hash-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const currentChanged = structuredClone(fixture.input);
  const control = currentChanged.projects[0]?.controlFile;
  assert.ok(control);
  control.currentSha256 = "0".repeat(64);
  assert.throws(() => compileLyricSourceProposal(currentChanged), (error: unknown) => error instanceof SpecialistRefusalError && error.refusal.code === "sha256-mismatch");
  const lyricChanged = structuredClone(fixture.input);
  const source = lyricChanged.projects[0]?.source;
  assert.ok(source);
  source.sha256 = "0".repeat(64);
  assert.throws(() => compileLyricSourceProposal(lyricChanged), (error: unknown) => error instanceof SpecialistRefusalError && error.refusal.code === "sha256-mismatch");
});

test("proposal compiler rejects ambiguous candidates and conflicting manifest mappings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proposal-conflicts-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const ambiguous = structuredClone(fixture.input);
  const project = ambiguous.projects[0];
  assert.ok(project?.managed);
  project.candidates.push({ ...project.managed, path: project.managed.path.replace(".md", "-alternate.md"), accepted: true, exactNameMatch: false });
  assert.throws(() => compileLyricSourceProposal(ambiguous), (error: unknown) => error instanceof SpecialistRefusalError && error.refusal.code === "ambiguous-managed-candidate");

  const conflicting = structuredClone(fixture.input);
  const manifest = conflicting.albumControlFiles.find((file) => file.path.endsWith("migration-manifest.md"));
  assert.ok(manifest);
  const firstProject = conflicting.projects.find((item) => item.include);
  assert.ok(firstProject);
  const current = `---\ncontract: lyric-source-migration-manifest.v1\nentries:\n  - project_path: ${firstProject.projectPath}\n    source_path: lyrics/albums/wrong.md\n---\n`;
  const bytes = Buffer.from(current, "utf8");
  manifest.currentContentBase64 = bytes.toString("base64");
  manifest.currentByteSize = bytes.byteLength;
  manifest.currentSha256 = sha256Bytes(bytes);
  assert.throws(() => compileLyricSourceProposal(conflicting), (error: unknown) => error instanceof SpecialistRefusalError && error.refusal.code === "conflicting-manifest-mapping");
});

test("prospective contents are UTF-8 LF bytes matching their hashes and contain no stale contradiction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proposal-bytes-"));
  const fixture = await materializeGoldenLyricFixture("black-box-psalms", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  for (const operation of proposal.operations) {
    const bytes = Buffer.from(operation.contentBase64, "base64");
    assert.equal(bytes.byteLength, operation.proposedByteCount);
    assert.equal(sha256Bytes(bytes), operation.proposedSha256);
    assert.doesNotMatch(bytes.toString("utf8"), /Lyric source unresolved|canonical lyric source is unresolved/i);
    assert.equal(bytes.includes(13), false);
  }
});

test("tampered live proposal fields are refused when the old canonical payload and SHA-256 are preserved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proposal-live-field-tampering-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const mutations: Array<[string, (value: LyricSourceDesignationProposal) => void]> = [
    ["operation path", (value) => { value.operations[0]!.path = "changed/project.md"; }],
    ["current SHA-256", (value) => { value.operations[0]!.currentSha256 = "0".repeat(64); }],
    ["proposed SHA-256", (value) => { value.operations[0]!.proposedSha256 = "0".repeat(64); }],
    ["contentBase64", (value) => { value.operations[0]!.contentBase64 = Buffer.from("tampered\n").toString("base64"); }],
    ["evidence path", (value) => { value.evidence[0]!.sourcePath = "lyrics/tampered.md"; }],
    ["guard hash", (value) => { value.guardFiles[0]!.sha256 = "0".repeat(64); }],
    ["expected count", (value) => { value.expectedCounts.catalogFindings += 1; }],
    ["rollback requirement", (value) => { value.rollbackRequirements[0] = "tampered rollback"; }],
    ["validator criterion", (value) => { value.independentValidatorCriteria[0] = "tampered validator"; }],
    ["resolver expected project", (value) => { value.resolverExpectedProjects[0] = "tampered/project"; }]
  ];
  for (const [label, mutate] of mutations) {
    const tampered = structuredClone(proposal);
    mutate(tampered);
    assert.throws(() => assertProposalIntegrity(tampered), /canonicalHashPayload/, label);
  }
});

test("re-signed operations still reject decoded byte-count, SHA-256, and encoding violations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proposal-operation-bytes-"));
  const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", root);
  const proposal = compileLyricSourceProposal(fixture.input);
  const tampered = structuredClone(proposal);
  tampered.operations[0]!.contentBase64 = Buffer.from("wrong\r\n", "utf8").toString("base64");
  tampered.canonicalHashPayload = reconstructProposalCanonicalHashPayload(tampered);
  tampered.proposalSha256 = sha256Bytes(Buffer.from(tampered.canonicalHashPayload, "utf8"));
  assert.throws(() => assertProposalIntegrity(tampered), /byte count|SHA-256|LF line endings/);
});
