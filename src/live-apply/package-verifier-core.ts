import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { checkArtifactStructure, canonicalFilename } from "../artifacts/handoff-specialist.js";
import { canonicalJson, sha256Bytes } from "../kernel/canonical-json.js";
import { normalizeContractPath } from "../kernel/contract-path.js";
import { verifyReviewDecision } from "../lyric-source/approval.js";
import type { LyricSourceApplyHandoff, LyricSourceDesignationProposal, LyricSourceDryRunReport, LyricSourceOperatorPackage } from "../lyric-source/contracts.js";
import { parseAndVerifyLyricSourceProposal } from "../lyric-source/proposal-specialist.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import type { GuardedArtifactIdentity, GuardedLiveApplyCounts, GuardedPackageVerification } from "./contracts.js";
import { assertSafeExistingFile } from "./path-policy.js";

const ROLES = ["proposal", "decision", "dry-run-report", "script", "handoff"] as const;
const CONTRACTS = {
  proposal: "lyric-source-designation-proposal.v1",
  decision: "asos-authority-decision.v1",
  "dry-run-report": "lyric-source-apply-dry-run-report.v1",
  script: "lyric-source-windows-apply-script.v1",
  handoff: "lyric-source-apply-handoff.v1"
} as const;

const BOUNDED_CONTROL_FILENAMES = new Set(["migration-manifest.md", "README.md", "tracklist.md"]);

export type GuardedPackagePolicy = "ground-wire-gospel-pilot" | "bounded-lyric-source-batch";

export async function verifyGuardedOperatorPackage(
  manifestInput: string,
  policy: GuardedPackagePolicy = "ground-wire-gospel-pilot"
): Promise<GuardedPackageVerification> {
  const manifestPath = await assertSafeExistingFile(manifestInput, "operator package manifest");
  if (path.basename(manifestPath).toLowerCase() !== canonicalFilename("lyric-source-operator-package.v1").toLowerCase()) throw new Error("Operator package manifest filename is not canonical.");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const manifest = parseObject<LyricSourceOperatorPackage>(manifestBytes, "operator package");
  if (
    manifest.contract !== "lyric-source-operator-package.v1" || manifest.artifacts.length !== 5 ||
    manifest.executionCommands.length !== 1 || manifest.safety?.liveApplyExecuted !== false ||
    manifest.safety?.governanceVerified !== true || manifest.safety?.artifactsOutsideVaultRequired !== true
  ) throw new Error("Operator package contract or safety state is invalid.");

  const packageRoot = path.dirname(manifestPath);
  const artifacts: GuardedArtifactIdentity[] = [];
  const contents = new Map<(typeof ROLES)[number], Buffer>();
  for (const role of ROLES) {
    const matches = manifest.artifacts.filter((item) => item.role === role);
    if (matches.length !== 1) throw new Error(`Operator package must contain exactly one ${role} artifact.`);
    const declared = matches[0]!;
    const expectedContract = CONTRACTS[role];
    if (declared.contract !== expectedContract || path.basename(declared.canonicalPath) !== declared.canonicalPath || declared.canonicalPath.includes(":")) throw new Error(`${role} artifact identity is invalid.`);
    if (declared.canonicalPath.toLowerCase() !== canonicalFilename(expectedContract).toLowerCase()) throw new Error(`${role} artifact filename is not canonical.`);
    const artifactPath = await assertSafeExistingFile(path.join(packageRoot, declared.canonicalPath), `${role} artifact`);
    if (path.dirname(artifactPath).toLowerCase() !== packageRoot.toLowerCase()) throw new Error(`${role} artifact escapes the package directory.`);
    const bytes = await readFile(artifactPath);
    const fileStat = await stat(artifactPath);
    const sha256 = sha256Bytes(bytes);
    if (sha256 !== declared.sha256 || fileStat.size !== declared.byteSize) throw new Error(`${role} artifact persisted identity mismatch.`);
    contents.set(role, bytes);
    artifacts.push({ role, contract: expectedContract, path: artifactPath, sha256, byteSize: fileStat.size });
  }

  const proposalPath = artifact(artifacts, "proposal").path;
  const proposal = parseAndVerifyLyricSourceProposal(contents.get("proposal")!.toString("utf8"), proposalPath);
  if (proposal.proposalId !== manifest.proposalId || proposal.proposalSha256 !== manifest.proposalSha256) throw new Error("Package proposal identity mismatch.");
  if (policy === "ground-wire-gospel-pilot") {
    if (proposal.operations.length !== 7) throw new Error(`Guarded Ground Wire Gospel package must contain seven operations; found ${proposal.operations.length}.`);
  } else {
    validateBoundedLyricSourceProposal(proposal);
  }
  validateProposalPaths(proposal.operations.map((item) => item.path), proposal.evidence.flatMap((item) => [item.sourcePath, item.managedPath]), proposal.guardFiles.map((item) => item.path));

  const decision = parseObject<AuthorityTransitionDecision>(contents.get("decision")!, "decision");
  if (!verifyReviewDecision(decision) || decision.decisionState !== "approved" || decision.proposalId !== proposal.proposalId || decision.proposalSha256 !== proposal.proposalSha256) {
    throw new Error("Decision does not validly approve the exact proposal.");
  }
  const proposalArtifact = artifact(artifacts, "proposal");
  const scriptArtifact = artifact(artifacts, "script");
  const dryRunArtifact = artifact(artifacts, "dry-run-report");
  const scriptStructure = checkArtifactStructure(scriptArtifact.path, contents.get("script")!.toString("utf8"), scriptArtifact.contract, { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256 });
  if (!scriptStructure.passed) throw new Error("Generated script structural identity is invalid.");

  const dryRun = parseObject<LyricSourceDryRunReport>(contents.get("dry-run-report")!, "dry-run report");
  if (
    dryRun.contract !== "lyric-source-apply-dry-run-report.v1" || dryRun.status !== "passed" || dryRun.liveVaultAccess !== false ||
    dryRun.mutationTarget !== "temporary-mirror-only" || !dryRun.powerShellVersion.startsWith("5.1.") || dryRun.failures.length !== 0 ||
    dryRun.proposalIdentity.proposalId !== proposal.proposalId || dryRun.proposalIdentity.proposalSha256 !== proposal.proposalSha256 ||
    dryRun.proposalIdentity.artifactSha256 !== proposalArtifact.sha256 || dryRun.scriptIdentity.scriptSha256 !== scriptArtifact.sha256 ||
    dryRun.parsedCollectionCounts.operations !== proposal.operations.length || dryRun.parsedCollectionCounts.evidence !== proposal.evidence.length ||
    dryRun.parsedCollectionCounts.guards !== proposal.guardFiles.length ||
    !Array.isArray(dryRun.scenarios) || dryRun.scenarios.length === 0 || dryRun.scenarios.some((item) => item.observed !== item.expected)
  ) throw new Error("Dry-run report does not prove the exact package passed the temporary-mirror suite.");

  const handoff = parseObject<LyricSourceApplyHandoff>(contents.get("handoff")!, "handoff");
  if (
    handoff.contract !== "lyric-source-apply-handoff.v1" || handoff.state !== "eligible-for-guarded-apply" || handoff.applyExecuted !== false ||
    handoff.proposalId !== proposal.proposalId || handoff.proposalSha256 !== proposal.proposalSha256 || handoff.proposalArtifactSha256 !== proposalArtifact.sha256 ||
    handoff.decisionArtifactSha256 !== decision.decisionArtifactSha256 || handoff.scriptSha256 !== scriptArtifact.sha256 || handoff.dryRunReportSha256 !== dryRunArtifact.sha256 ||
    handoff.operations.length !== proposal.operations.length || canonicalJson(handoff.operations) !== canonicalJson(proposal.operations) ||
    handoff.rollbackRequirements.length === 0 || handoff.independentValidatorCriteria.length === 0
  ) throw new Error("Handoff lineage or eligibility envelope is invalid.");

  const expectedPostApplyCounts: GuardedLiveApplyCounts = {
    catalogFindings: proposal.expectedCounts.catalogFindings,
    assetFindings: proposal.expectedCounts.assetFindings,
    routedFindings: orderedRecord(proposal.expectedCounts.routedFindings),
    pendingApply: 0
  };
  const expectedBaselineCounts: GuardedLiveApplyCounts = {
    catalogFindings: proposal.expectedCounts.catalogFindings - proposal.expectedFindingDeltas.catalogFindings,
    assetFindings: proposal.expectedCounts.assetFindings - proposal.expectedFindingDeltas.assetFindings,
    routedFindings: orderedRecord(Object.fromEntries(Object.entries(proposal.expectedCounts.routedFindings).map(([route, count]) => [route, count - (proposal.expectedFindingDeltas.routedFindings[route] ?? 0)]))),
    pendingApply: 0
  };
  const allCounts = [
    expectedBaselineCounts.catalogFindings,
    expectedBaselineCounts.assetFindings,
    expectedPostApplyCounts.catalogFindings,
    expectedPostApplyCounts.assetFindings,
    ...Object.values(expectedBaselineCounts.routedFindings),
    ...Object.values(expectedPostApplyCounts.routedFindings)
  ];
  if (allCounts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Proposal expected baseline or post-APPLY counts are invalid.");
  }
  return {
    manifestPath,
    manifestSha256,
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    artifacts,
    operations: proposal.operations,
    evidencePaths: proposal.evidence.flatMap((item) => [item.sourcePath, item.managedPath]).sort(),
    guardPaths: proposal.guardFiles.map((item) => item.path).sort(),
    expectedBaselineCounts,
    expectedPostApplyCounts
  };
}

function validateBoundedLyricSourceProposal(proposal: LyricSourceDesignationProposal): void {
  const projectCount = proposal.includedProjects.length;
  if (projectCount < 2 || projectCount > 4) throw new Error(`Bounded lyric-source batches require 2-4 included projects; found ${projectCount}.`);
  if (new Set(proposal.includedProjects.map((item) => item.toLowerCase())).size !== projectCount) throw new Error("Bounded lyric-source batch contains duplicate included projects.");
  if (proposal.evidence.length !== projectCount || proposal.resolverExpectedProjects.length !== projectCount) throw new Error("Bounded lyric-source evidence and resolver project counts must match the included project count.");
  assertSameStringSet(proposal.includedProjects, proposal.evidence.map((item) => item.projectPath), "evidence projects");
  assertSameStringSet(proposal.includedProjects, proposal.resolverExpectedProjects, "resolver projects");
  if (proposal.evidence.some((item) => item.verificationMethod !== "sha256-byte-match" || item.verificationState !== "verified")) throw new Error("Bounded lyric-source evidence must be byte-identical and verified.");

  const albumRoots = proposal.includedProjects.map((projectPath) => path.posix.dirname(projectPath));
  if (new Set(albumRoots.map((item) => item.toLowerCase())).size !== 1) throw new Error("A bounded lyric-source batch must remain inside one release container.");
  const albumRoot = albumRoots[0]!;
  const operationPaths = new Set(proposal.operations.map((item) => item.path.toLowerCase()));
  for (const projectPath of proposal.includedProjects) {
    const expectedProjectControl = `${projectPath}/project.md`.toLowerCase();
    if (!operationPaths.has(expectedProjectControl)) throw new Error(`Bounded lyric-source batch is missing the project control operation for ${projectPath}.`);
  }
  if (proposal.operations.length < projectCount || proposal.operations.length > projectCount + BOUNDED_CONTROL_FILENAMES.size) {
    throw new Error(`Bounded lyric-source batch operation count must be ${projectCount}-${projectCount + BOUNDED_CONTROL_FILENAMES.size}; found ${proposal.operations.length}.`);
  }
  for (const operation of proposal.operations) {
    const projectControl = proposal.includedProjects.some((projectPath) => operation.path.toLowerCase() === `${projectPath}/project.md`.toLowerCase());
    const releaseControl = path.posix.dirname(operation.path).toLowerCase() === albumRoot.toLowerCase() && BOUNDED_CONTROL_FILENAMES.has(path.posix.basename(operation.path));
    if (!projectControl && !releaseControl) throw new Error(`Bounded lyric-source operation escapes the approved project/release control surface: ${operation.path}`);
  }

  if (
    proposal.expectedFindingDeltas.catalogFindings !== -projectCount ||
    proposal.expectedFindingDeltas.assetFindings !== -(projectCount * 2) ||
    proposal.expectedFindingDeltas.routedFindings["blocks-existing-proposal"] !== -(projectCount * 2)
  ) throw new Error("Bounded lyric-source finding deltas do not match the included project count.");
  for (const [route, delta] of Object.entries(proposal.expectedFindingDeltas.routedFindings)) {
    if (route !== "blocks-existing-proposal" && delta !== 0) throw new Error(`Bounded lyric-source batch cannot change routed finding class ${route}.`);
  }
}

function assertSameStringSet(expected: string[], actual: string[], label: string): void {
  const left = [...expected].map((item) => item.toLowerCase()).sort();
  const right = [...actual].map((item) => item.toLowerCase()).sort();
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`Bounded lyric-source ${label} do not exactly match included projects.`);
}

function validateProposalPaths(operationPaths: string[], evidencePaths: string[], guardPaths: string[]): void {
  const operationSet = new Set<string>();
  for (const [label, paths] of [["operation", operationPaths], ["evidence", evidencePaths], ["guard", guardPaths]] as const) {
    for (const candidate of paths) {
      if (candidate.includes(":") || candidate.includes("\\") || normalizeContractPath(candidate) !== candidate) throw new Error(`${label} path is not canonical: ${candidate}`);
      const key = candidate.toLowerCase();
      if (label === "operation" && operationSet.has(key)) throw new Error(`Duplicate operation path: ${candidate}`);
      if (label === "operation") operationSet.add(key);
    }
  }
}

function artifact(artifacts: GuardedArtifactIdentity[], role: GuardedArtifactIdentity["role"]): GuardedArtifactIdentity {
  const result = artifacts.find((item) => item.role === role);
  if (!result) throw new Error(`Missing ${role} artifact.`);
  return result;
}

function parseObject<T>(bytes: Buffer, label: string): T {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must contain exactly one JSON object.`);
  return parsed as T;
}

function orderedRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}
