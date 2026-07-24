import { readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "../kernel/canonical-json.js";
import { assertNoLinkedPathSegment, contractPathToNative, normalizeContractPath } from "../kernel/contract-path.js";
import type { LyricSourceDesignationProposal, LyricSourceIndependentValidationReport } from "./contracts.js";
import { parseAndVerifyLyricSourceProposal, verifyProposalCanonicalHash } from "./proposal-specialist.js";

export type VaultSnapshotArtifact = {
  contract: "lyric-source-vault-snapshot.v1";
  files: Array<{ path: string; byteSize: number; sha256: string }>;
};

type WorkflowEvidence = {
  contract: "asos-workflow-read-only-refresh.v1.1";
  counts: Record<string, number>;
  findingRoutes: Array<{ route: string; count: number }>;
  resolverRecords: Array<{ projectPath: string; state: string }>;
  safety: { applyEnabled: boolean; vaultMutation: string };
};

export async function validateLyricSourceApplyFromPaths(
  proposalPath: string,
  vaultRoot: string,
  preSnapshotPath: string,
  workflowReportPath: string,
  generatedAt: string
): Promise<LyricSourceIndependentValidationReport> {
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  const before = parseSnapshot(await readFile(preSnapshotPath, "utf8"), preSnapshotPath);
  const workflow = parseWorkflow(await readFile(workflowReportPath, "utf8"), workflowReportPath);
  const after = await captureVaultSnapshot(vaultRoot);
  const checks: LyricSourceIndependentValidationReport["checks"] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add("proposal-canonical-sha256", verifyProposalCanonicalHash(proposal), "Proposal canonical payload matches its declared SHA-256.");
  for (const operation of proposal.operations) {
    const contractPath = normalizeContractPath(operation.path);
    await assertNoLinkedPathSegment(vaultRoot, contractPath);
    const target = contractPathToNative(vaultRoot, contractPath);
    const liveHash = sha256Bytes(await readFile(target));
    add(`proposed-hash:${contractPath}`, liveHash === operation.proposedSha256, `Live target hash is ${liveHash}.`);
    add(`old-hash-retired:${contractPath}`, liveHash !== operation.currentSha256, "Old target hash is no longer live.");
  }
  for (const evidence of proposal.evidence) {
    const source = await inspectFile(vaultRoot, evidence.sourcePath);
    const managed = await inspectFile(vaultRoot, evidence.managedPath);
    add(`lyric-evidence:${evidence.projectPath}`, source.sha256 === evidence.sha256 && managed.sha256 === evidence.sha256 && source.byteSize === evidence.byteSize && managed.byteSize === evidence.byteSize, "Source and managed lyric evidence hashes and sizes remain unchanged.");
  }
  for (const guard of proposal.guardFiles) {
    const live = await inspectFile(vaultRoot, guard.path);
    add(`guard:${guard.path}`, live.sha256 === guard.sha256 && live.byteSize === guard.byteSize, "Guard hash and size remain unchanged.");
  }
  const resolver = workflow.resolverRecords.map((record) => ({ ...record, projectPath: normalizeContractPath(record.projectPath) }));
  for (const expectedProject of proposal.resolverExpectedProjects) {
    const normalized = normalizeContractPath(expectedProject);
    const matches = resolver.filter((record) => record.projectPath === normalized && record.state === "verified");
    add(`resolver:${normalized}`, matches.length === 1, `Expected one verified resolver record; found ${matches.length}.`);
  }
  add("catalog-counts", workflow.counts.catalogFindings === proposal.expectedCounts.catalogFindings, "Catalog finding count matches the proposal expectation.");
  add("asset-counts", workflow.counts.assetFindings === proposal.expectedCounts.assetFindings, "Asset Inspector finding count matches the proposal expectation.");
  for (const [route, expected] of Object.entries(proposal.expectedCounts.routedFindings).sort(([left], [right]) => left.localeCompare(right))) {
    const actual = workflow.findingRoutes.find((record) => record.route === route)?.count;
    add(`routed-count:${route}`, actual === expected, `Expected ${expected}; found ${String(actual)}.`);
  }
  const unrelated = compareUnrelatedFiles(before, after, new Set(proposal.operations.map((operation) => normalizeContractPath(operation.path))));
  add("unrelated-vault-files", unrelated.length === 0, unrelated.length === 0 ? "No unrelated file changed." : `Changed: ${unrelated.join(", ")}`);
  add("pending-apply-zero", workflow.counts.pendingApply === 0, `pendingApply is ${String(workflow.counts.pendingApply)}.`);
  add("kernel-apply-disabled", workflow.safety.applyEnabled === false, "ASOS Kernel reports applyEnabled false.");
  add("kernel-vault-mutation-none", workflow.safety.vaultMutation === "none", "ASOS Kernel reports vaultMutation none.");
  const failed = checks.filter((check) => !check.passed).length;
  return {
    contract: "lyric-source-independent-validation-report.v1",
    generatedAt,
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    authority: "OBSERVE",
    persistedArtifactsOnly: true,
    checks,
    counts: { passed: checks.length - failed, failed, total: checks.length },
    status: failed === 0 ? "passed" : "failed",
    refusal: null,
    safety: { applyEnabled: false, vaultMutation: "none", pendingApply: 0 }
  };
}

export async function captureVaultSnapshot(vaultRoot: string): Promise<VaultSnapshotArtifact> {
  const files: VaultSnapshotArtifact["files"] = [];
  await visit(vaultRoot, "", files);
  return { contract: "lyric-source-vault-snapshot.v1", files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function visit(root: string, relative: string, output: VaultSnapshotArtifact["files"]): Promise<void> {
  const absolute = relative ? contractPathToNative(root, relative) : root;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left: Dirent, right: Dirent) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Linked path is forbidden in validation snapshot: ${childRelative}`);
    }
    if (entry.isDirectory()) {
      await visit(root, childRelative, output);
    } else if (entry.isFile()) {
      const bytes = await readFile(contractPathToNative(root, childRelative));
      output.push({ path: normalizeContractPath(childRelative), byteSize: bytes.byteLength, sha256: sha256Bytes(bytes) });
    }
  }
}

async function inspectFile(root: string, contractPath: string): Promise<{ byteSize: number; sha256: string }> {
  const normalized = normalizeContractPath(contractPath);
  await assertNoLinkedPathSegment(root, normalized);
  const filePath = contractPathToNative(root, normalized);
  const [bytes, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  return { byteSize: fileStat.size, sha256: sha256Bytes(bytes) };
}

function compareUnrelatedFiles(before: VaultSnapshotArtifact, after: VaultSnapshotArtifact, allowed: Set<string>): string[] {
  const beforeMap = new Map(before.files.map((file) => [file.path, file.sha256]));
  const afterMap = new Map(after.files.map((file) => [file.path, file.sha256]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys.filter((key) => !allowed.has(key) && beforeMap.get(key) !== afterMap.get(key));
}

function parseSnapshot(text: string, label: string): VaultSnapshotArtifact {
  const parsed = parseSingleJsonObject(text, "lyric-source-vault-snapshot.v1", label);
  if (!Array.isArray(parsed.files)) {
    throw new Error(`Snapshot is incomplete: ${label}`);
  }
  return { contract: "lyric-source-vault-snapshot.v1", files: flattenCollection(parsed.files, "snapshot files") as VaultSnapshotArtifact["files"] };
}

function parseWorkflow(text: string, label: string): WorkflowEvidence {
  const parsed = parseSingleJsonObject(text, "asos-workflow-read-only-refresh.v1.1", label);
  if (!isRecord(parsed.counts) || !Array.isArray(parsed.findingRoutes) || !Array.isArray(parsed.resolverRecords) || !isRecord(parsed.safety)) {
    throw new Error(`Workflow report is incomplete: ${label}`);
  }
  return {
    contract: "asos-workflow-read-only-refresh.v1.1",
    counts: parsed.counts as Record<string, number>,
    findingRoutes: flattenCollection(parsed.findingRoutes, "findingRoutes") as WorkflowEvidence["findingRoutes"],
    resolverRecords: flattenCollection(parsed.resolverRecords, "resolverRecords") as WorkflowEvidence["resolverRecords"],
    safety: parsed.safety as WorkflowEvidence["safety"]
  };
}

function parseSingleJsonObject(text: string, expectedContract: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  const flat = flattenCollection(Array.isArray(parsed) ? parsed : [parsed], `${label} envelope`);
  const matches = flat.filter((value): value is Record<string, unknown> => isRecord(value) && (value.contract === expectedContract || value.schemaVersion === expectedContract));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${expectedContract} object in ${label}; found ${matches.length}.`);
  }
  return matches[0] as Record<string, unknown>;
}

function flattenCollection(value: unknown[], label: string, depth = 0): unknown[] {
  if (depth > 4) {
    throw new Error(`${label} exceeds the supported nesting depth.`);
  }
  const output: unknown[] = [];
  for (const item of value) {
    if (Array.isArray(item)) output.push(...flattenCollection(item, label, depth + 1));
    else output.push(item);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
