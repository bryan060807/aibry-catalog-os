import { canonicalJson, canonicalJsonSha256, sha256Bytes } from "../kernel/canonical-json.js";
import { normalizeContractPath } from "../kernel/contract-path.js";
import { assertSpecialistOutputContract } from "../kernel/authority-policy.js";
import { specialistId, type SpecialistRefusal } from "../specialists/contracts.js";
import type {
  LyricControlFileInput,
  LyricFileState,
  LyricSourceDesignationProposal,
  LyricSourcePlanningInput,
  LyricSourcePlanningProject,
  LyricSourceProposalOperation
} from "./contracts.js";

export class SpecialistRefusalError extends Error {
  public readonly refusal: SpecialistRefusal;

  public constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "SpecialistRefusalError";
    this.refusal = {
      contract: "specialist-refusal.v1",
      code,
      message,
      specialistId: specialistId("lyric-source-proposal"),
      authorityMode: "PROPOSE",
      details
    };
  }
}

export function compileLyricSourceProposal(input: LyricSourcePlanningInput): LyricSourceDesignationProposal {
  assertPlanningInput(input);
  const included = input.projects.filter((project) => project.include).sort((left, right) => left.projectPath.localeCompare(right.projectPath));
  const excluded = input.projects.filter((project) => !project.include).sort((left, right) => left.projectPath.localeCompare(right.projectPath));
  if (included.length === 0) {
    refuse("empty-batch", "At least one project must be included in a migration proposal.");
  }
  const evidence = included.map(validateIncludedProject);
  const operationInputs = [
    ...included.map((project) => requireControlFile(project)),
    ...input.albumControlFiles
  ];
  const operations = operationInputs
    .map(validateAndBuildOperation)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((operation, index) => ({ ...operation, order: index + 1 }));
  ensureUniquePaths(operations.map((operation) => operation.path), "operation");
  const guards = input.guardFiles.map(validateFileState).sort((left, right) => left.path.localeCompare(right.path));
  ensureUniquePaths(guards.map((guard) => guard.path), "guard");
  const selectedPaths = [...input.selectedBatch.projectPaths].map(normalizeContractPath).sort();
  const projectPaths = input.projects.map((project) => normalizeContractPath(project.projectPath)).sort();
  if (canonicalJson(selectedPaths) !== canonicalJson(projectPaths)) {
    refuse("selected-batch-mismatch", "Selected batch paths must exactly match included and excluded project inputs.");
  }
  const expectedFindingDeltas = {
    catalogFindings: input.expectedCounts.catalogFindings - input.baselineCounts.catalogFindings,
    assetFindings: input.expectedCounts.assetFindings - input.baselineCounts.assetFindings,
    routedFindings: deltaRecord(input.baselineCounts.routedFindings, input.expectedCounts.routedFindings)
  };
  const proposalSeed = canonicalJsonSha256({
    contract: input.contract,
    selectedBatch: input.selectedBatch,
    currentCatalogIndex: input.currentCatalogIndex,
    assetInspectorEvidence: input.assetInspectorEvidence,
    lyricSourceResolverEvidence: input.lyricSourceResolverEvidence,
    operations,
    evidence,
    guards,
    expectedFindingDeltas
  });
  const proposalId = `lyric-source:${input.selectedBatch.batchId}:${proposalSeed.slice(0, 16)}`;
  const payload = {
    contract: "lyric-source-designation-proposal.v1" as const,
    proposalId,
    authority: "PROPOSE" as const,
    approvalState: "pending" as const,
    applyEnabled: false as const,
    vaultMutation: "none" as const,
    selectedBatch: { ...input.selectedBatch, projectPaths: selectedPaths },
    includedProjects: included.map((project) => normalizeContractPath(project.projectPath)),
    excludedProjects: excluded.map((project) => ({
      projectPath: normalizeContractPath(project.projectPath),
      reason: requireExclusionReason(project)
    })),
    evidenceArtifacts: [
      { contract: input.currentCatalogIndex.contract, sha256: input.currentCatalogIndex.sha256 },
      { contract: input.assetInspectorEvidence.contract, sha256: input.assetInspectorEvidence.sha256 },
      { contract: input.lyricSourceResolverEvidence.contract, sha256: input.lyricSourceResolverEvidence.sha256 }
    ],
    evidence,
    operations,
    guardFiles: guards.map(({ path, byteSize, sha256 }) => ({ path, byteSize, sha256 })),
    preconditions: requireNonEmptyStrings(input.preconditions, "preconditions"),
    rollbackRequirements: requireNonEmptyStrings(input.rollbackRequirements, "rollback requirements"),
    independentValidatorCriteria: requireNonEmptyStrings(input.independentValidatorCriteria, "Independent Validator criteria"),
    expectedFindingDeltas,
    expectedCounts: input.expectedCounts,
    resolverExpectedProjects: included.map((project) => normalizeContractPath(project.projectPath)),
    humanAuthorizationBoundary: `Prospective bytes are not authoritative until Bryan approves proposal ${proposalId} at its exact proposal SHA-256.`
  };
  const canonicalHashPayload = canonicalJson(payload);
  const proposalSha256 = sha256Bytes(Buffer.from(canonicalHashPayload, "utf8"));
  assertSpecialistOutputContract("lyric-source-proposal", payload.contract);
  return {
    ...payload,
    proposalSha256,
    generatedAt: input.generatedAt,
    canonicalHashPayload
  };
}

export function verifyProposalCanonicalHash(proposal: LyricSourceDesignationProposal): boolean {
  try {
    assertProposalIntegrity(proposal);
    return true;
  } catch {
    return false;
  }
}

export function reconstructProposalCanonicalHashPayload(proposal: LyricSourceDesignationProposal): string {
  const {
    proposalSha256: _proposalSha256,
    generatedAt: _generatedAt,
    canonicalHashPayload: _canonicalHashPayload,
    ...authoritativeFields
  } = proposal;
  return canonicalJson(authoritativeFields);
}

export function assertProposalIntegrity(proposal: LyricSourceDesignationProposal): void {
  if (proposal.contract !== "lyric-source-designation-proposal.v1") {
    refuse("proposal-contract-mismatch", "Expected lyric-source-designation-proposal.v1.");
  }
  const reconstructed = reconstructProposalCanonicalHashPayload(proposal);
  if (reconstructed !== proposal.canonicalHashPayload) {
    refuse("proposal-payload-mismatch", "Proposal live fields do not match canonicalHashPayload.");
  }
  const reconstructedSha256 = sha256Bytes(Buffer.from(reconstructed, "utf8"));
  if (reconstructedSha256 !== proposal.proposalSha256) {
    refuse("proposal-sha256-mismatch", "Proposal live fields do not match proposalSha256.");
  }
  if (!Array.isArray(proposal.operations) || proposal.operations.length === 0) {
    refuse("invalid-operation-envelope", "Proposal operations must be a non-empty array.");
  }
  if (!Array.isArray(proposal.evidence) || !Array.isArray(proposal.guardFiles) || !Array.isArray(proposal.resolverExpectedProjects)) {
    refuse("invalid-proposal-collections", "Proposal evidence, guards, and resolver projects must be arrays.");
  }
  ensureUniquePaths(proposal.operations.map((operation) => normalizeContractPath(operation.path)), "operation");
  for (const [index, operation] of proposal.operations.entries()) {
    if (operation.order !== index + 1 || operation.operationType !== "replace-control-file") {
      refuse("invalid-operation-order", `Operation ${index + 1} has invalid order or type.`);
    }
    const normalizedPath = normalizeContractPath(operation.path);
    if (normalizedPath !== operation.path) {
      refuse("noncanonical-operation-path", `Operation path is not canonical: ${operation.path}`);
    }
    if (!Number.isInteger(operation.currentByteCount) || operation.currentByteCount < 0 || !Number.isInteger(operation.proposedByteCount) || operation.proposedByteCount < 0) {
      refuse("invalid-operation-byte-count", `Operation byte counts are invalid: ${operation.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(operation.currentSha256) || !/^[a-f0-9]{64}$/.test(operation.proposedSha256)) {
      refuse("invalid-operation-sha256", `Operation hashes are invalid: ${operation.path}`);
    }
    const bytes = decodeCanonicalBase64(operation.contentBase64, operation.path);
    if (bytes.byteLength !== operation.proposedByteCount) {
      refuse("proposed-byte-size-mismatch", `Decoded proposed byte count is stale: ${operation.path}`);
    }
    if (sha256Bytes(bytes) !== operation.proposedSha256) {
      refuse("proposed-sha256-mismatch", `Decoded proposed bytes do not match proposedSha256: ${operation.path}`);
    }
    assertUtf8LfWithoutBom(bytes, operation.path);
  }
  for (const row of proposal.evidence) {
    if (normalizeContractPath(row.projectPath) !== row.projectPath || normalizeContractPath(row.sourcePath) !== row.sourcePath || normalizeContractPath(row.managedPath) !== row.managedPath) {
      refuse("noncanonical-evidence-path", `Evidence paths are not canonical: ${row.projectPath}`);
    }
    if (!Number.isInteger(row.byteSize) || row.byteSize < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      refuse("invalid-evidence-state", `Evidence state is invalid: ${row.projectPath}`);
    }
  }
  ensureUniquePaths(proposal.guardFiles.map((guard) => normalizeContractPath(guard.path)), "guard");
  for (const guard of proposal.guardFiles) {
    if (normalizeContractPath(guard.path) !== guard.path || !Number.isInteger(guard.byteSize) || guard.byteSize < 0 || !/^[a-f0-9]{64}$/.test(guard.sha256)) {
      refuse("invalid-guard-state", `Guard state is invalid: ${guard.path}`);
    }
  }
  for (const resolverProject of proposal.resolverExpectedProjects) {
    if (normalizeContractPath(resolverProject) !== resolverProject) {
      refuse("noncanonical-resolver-path", `Resolver project path is not canonical: ${resolverProject}`);
    }
  }
}

export function parseAndVerifyLyricSourceProposal(text: string, label: string): LyricSourceDesignationProposal {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    refuse("invalid-proposal-json", `Expected one proposal object: ${label}`);
  }
  const proposal = parsed as LyricSourceDesignationProposal;
  assertProposalIntegrity(proposal);
  return proposal;
}

function validateIncludedProject(project: LyricSourcePlanningProject) {
  const projectPath = normalizeContractPath(project.projectPath);
  if (!project.source || !project.managed || !project.controlFile) {
    refuse("missing-project-evidence", `Included project ${projectPath} lacks source, managed, or control-file evidence.`);
  }
  const source = validateFileState(project.source);
  const managed = validateFileState(project.managed);
  const accepted = project.candidates.filter((candidate) => candidate.accepted);
  if (project.candidates.length !== 1 || accepted.length !== 1) {
    refuse("ambiguous-managed-candidate", `Project ${projectPath} must have exactly one accepted managed lyric candidate.`);
  }
  const acceptedCandidate = validateFileState(accepted[0] as LyricFileState);
  if (!accepted[0]?.exactNameMatch || pathName(source.path) !== pathName(managed.path) || acceptedCandidate.path !== managed.path) {
    refuse("lyric-exact-name-mismatch", `Project ${projectPath} does not have one exact-name managed candidate.`);
  }
  if (source.byteSize !== managed.byteSize || source.sha256 !== managed.sha256 || source.contentBase64 !== managed.contentBase64) {
    refuse("lyric-byte-mismatch", `Source and managed lyrics differ for ${projectPath}.`);
  }
  const currentContent = decodeAndValidate(project.controlFile.currentContentBase64, project.controlFile.currentByteSize, project.controlFile.currentSha256, project.controlFile.path);
  if (/designation_state:\s*human-approved/i.test(currentContent)) {
    refuse("conflicting-existing-designation", `Project ${projectPath} already declares a human-approved designation.`);
  }
  const existingSource = currentContent.match(/canonical_lyric_source:\s*([^\r\n]+)/i)?.[1]?.trim();
  if (existingSource && normalizeContractPath(existingSource) !== source.path) {
    refuse("conflicting-existing-designation", `Project ${projectPath} declares a different canonical lyric source.`);
  }
  return {
    projectPath,
    sourcePath: source.path,
    managedPath: managed.path,
    byteSize: source.byteSize,
    sha256: source.sha256,
    verificationMethod: "sha256-byte-match" as const,
    verificationState: "verified" as const
  };
}

function validateAndBuildOperation(input: LyricControlFileInput): Omit<LyricSourceProposalOperation, "order"> {
  const path = normalizeContractPath(input.path);
  const currentBytes = decodeAndValidate(input.currentContentBase64, input.currentByteSize, input.currentSha256, path);
  if (/\r/.test(input.proposedContent)) {
    refuse("non-lf-proposed-content", `Proposed content must use LF line endings: ${path}`);
  }
  if (/Lyric source unresolved|canonical lyric source is unresolved/i.test(input.proposedContent)) {
    refuse("stale-contradictory-language", `Proposed content retains contradictory unresolved lyric-source language: ${path}`);
  }
  if (path.endsWith("migration-manifest.md")) {
    assertNoConflictingManifestMappings(currentBytes, input.proposedContent, path);
  }
  const proposedBytes = Buffer.from(input.proposedContent, "utf8");
  return {
    operationType: "replace-control-file",
    path,
    currentByteCount: input.currentByteSize,
    currentSha256: input.currentSha256.toLowerCase(),
    proposedByteCount: proposedBytes.byteLength,
    proposedSha256: sha256Bytes(proposedBytes),
    contentBase64: proposedBytes.toString("base64")
  };
}

function validateFileState(file: LyricFileState): LyricFileState {
  const path = normalizeContractPath(file.path);
  decodeAndValidate(file.contentBase64, file.byteSize, file.sha256, path);
  return { ...file, path, sha256: file.sha256.toLowerCase() };
}

function decodeAndValidate(contentBase64: string, byteSize: number, expectedSha256: string, label: string): string {
  const bytes = decodeCanonicalBase64(contentBase64, label);
  if (bytes.byteLength !== byteSize) {
    refuse("byte-size-mismatch", `Declared byte size is stale for ${label}.`);
  }
  if (sha256Bytes(bytes) !== expectedSha256.toLowerCase()) {
    refuse("sha256-mismatch", `Declared SHA-256 is stale for ${label}.`);
  }
  return bytes.toString("utf8");
}

function decodeCanonicalBase64(contentBase64: string, label: string): Buffer {
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    refuse("invalid-base64", `Base64 content is missing: ${label}`);
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    refuse("noncanonical-base64", `Base64 content is malformed or noncanonical: ${label}`);
  }
  return bytes;
}

function assertUtf8LfWithoutBom(bytes: Buffer, label: string): void {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    refuse("utf8-bom-forbidden", `Proposed content contains a UTF-8 BOM: ${label}`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("invalid-utf8", `Proposed content is not valid UTF-8: ${label}`);
  }
  if (decoded.includes("\r")) {
    refuse("non-lf-proposed-content", `Proposed content must use LF line endings: ${label}`);
  }
}

function assertPlanningInput(input: LyricSourcePlanningInput): void {
  if (input.contract !== "lyric-source-planning-input.v1") {
    refuse("unknown-input-contract", `Expected lyric-source-planning-input.v1, got ${String(input.contract)}.`);
  }
  if (!Array.isArray(input.projects) || !Array.isArray(input.albumControlFiles) || !Array.isArray(input.guardFiles)) {
    refuse("invalid-operation-envelope", "Projects, album control files, and guards must be arrays.");
  }
}

function assertNoConflictingManifestMappings(current: string, proposed: string, label: string): void {
  const mappingPattern = /project_path:\s*([^\r\n]+)[\s\S]*?source_path:\s*([^\r\n]+)/g;
  const existing = new Map<string, string>();
  for (const match of current.matchAll(mappingPattern)) {
    if (match[1] && match[2]) {
      existing.set(match[1].trim(), match[2].trim());
    }
  }
  for (const match of proposed.matchAll(mappingPattern)) {
    const projectPath = match[1]?.trim();
    const sourcePath = match[2]?.trim();
    if (projectPath && sourcePath && existing.has(projectPath) && existing.get(projectPath) !== sourcePath) {
      refuse("conflicting-manifest-mapping", `Conflicting migration-manifest mapping in ${label} for ${projectPath}.`);
    }
  }
}

function requireControlFile(project: LyricSourcePlanningProject): LyricControlFileInput {
  if (!project.controlFile) {
    refuse("missing-control-file", `Project ${project.projectPath} is missing its control file.`);
  }
  return project.controlFile;
}

function requireExclusionReason(project: LyricSourcePlanningProject): string {
  if (!project.exclusionReason || project.exclusionReason.trim().length === 0) {
    refuse("missing-exclusion-reason", `Excluded project ${project.projectPath} requires an explicit reason.`);
  }
  return project.exclusionReason;
}

function requireNonEmptyStrings(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    refuse("incomplete-criteria", `Proposal ${label} must be complete.`);
  }
  return [...values];
}

function deltaRecord(baseline: Record<string, number>, expected: Record<string, number>): Record<string, number> {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(expected)])].sort();
  return Object.fromEntries(keys.map((key) => [key, (expected[key] ?? 0) - (baseline[key] ?? 0)]));
}

function ensureUniquePaths(paths: string[], role: string): void {
  if (new Set(paths).size !== paths.length) {
    refuse("duplicate-artifact-path", `Duplicate ${role} path detected.`);
  }
}

function pathName(value: string): string {
  return value.split("/").at(-1)?.toLowerCase() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(code: string, message: string): never {
  throw new SpecialistRefusalError(code, message);
}
