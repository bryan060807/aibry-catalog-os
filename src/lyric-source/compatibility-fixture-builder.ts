import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyArtifact } from "../artifacts/handoff-specialist.js";
import { assertSpecialistOutputContract } from "../kernel/authority-policy.js";
import { canonicalJsonSha256, sha256Bytes } from "../kernel/canonical-json.js";
import { assertPathHasNoLinkedSegments, assertPathInsideRoot, isLiveMusicVaultPath, normalizeContractPath } from "../kernel/contract-path.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import { describeSpecialist } from "../specialists/registry.js";
import { verifyReviewDecision } from "./approval.js";
import { validatePlanningInput } from "./batch-scout-specialist.js";
import type {
  LyricSourceBatchScoutReport,
  LyricSourceCompatibilityFixtureFileRole,
  LyricSourceCompatibilityFixtureManifest,
  LyricSourceDesignationProposal,
  LyricSourcePlanningInput
} from "./contracts.js";
import { compileLyricSourceProposal, parseAndVerifyLyricSourceProposal } from "./proposal-specialist.js";

const FIXTURE_MARKER_PATH = ".asos-fixture-vault" as const;
const FIXTURE_MARKER_BYTES = Buffer.from([
  "contract: lyric-source-compatibility-fixture.v1",
  "scope: reports-local-temporary-mirror",
  "live-vault-access: false",
  "live-vault-mutation: none",
  "apply-executed: false",
  ""
].join("\n"), "utf8");

type PersistedArtifact<T> = { value: T; bytes: Buffer; sha256: string; path: string };

type PlannedFixtureFile = {
  path: string;
  role: LyricSourceCompatibilityFixtureFileRole;
  byteSize: number;
  sha256: string;
  bytes: Buffer;
  sourceArtifact: "lyric-source-planning-input.v1" | "fixture-builder";
};

export type CompatibilityFixtureBuilderOptions = {
  reportsRoot: string;
  scoutReportPath: string;
  planningInputPath: string;
  proposalPath: string;
  decisionPath: string;
  outputDirectory: string;
  failAfterMaterializedFileCount?: number;
};

export type CompatibilityFixtureBuilderResult = {
  manifest: LyricSourceCompatibilityFixtureManifest;
  manifestPath: string;
  fixtureRoot: string;
  inputArtifacts: Array<{ contract: string; path: string; sha256: string }>;
};

export async function materializeLyricSourceCompatibilityFixture(
  options: CompatibilityFixtureBuilderOptions
): Promise<CompatibilityFixtureBuilderResult> {
  const reportsRoot = path.resolve(options.reportsRoot);
  const outputDirectory = path.resolve(options.outputDirectory);
  const inputPaths = [options.scoutReportPath, options.planningInputPath, options.proposalPath, options.decisionPath].map((candidate) => path.resolve(candidate));
  for (const candidate of [reportsRoot, outputDirectory, ...inputPaths]) rejectLiveVaultPath(candidate);
  await assertReportsPath(reportsRoot, outputDirectory, true);
  for (const inputPath of inputPaths) await assertReportsPath(reportsRoot, inputPath, false);
  await assertPathAbsent(outputDirectory);

  const scoutArtifact = await loadArtifact<LyricSourceBatchScoutReport>(inputPaths[0] as string, "lyric-source-batch-scout-report.v1");
  const planningArtifact = await loadArtifact<LyricSourcePlanningInput>(inputPaths[1] as string, "lyric-source-planning-input.v1");
  const proposalArtifact = await loadProposal(inputPaths[2] as string);
  const decisionArtifact = await loadArtifact<AuthorityTransitionDecision>(inputPaths[3] as string, "asos-authority-decision.v1", {
    proposalId: proposalArtifact.value.proposalId,
    proposalSha256: proposalArtifact.value.proposalSha256
  });
  validateLineage(scoutArtifact, planningArtifact, proposalArtifact, decisionArtifact);
  const planned = buildFixturePlan(planningArtifact.value, proposalArtifact.value);

  const parent = path.dirname(outputDirectory);
  await assertPathHasNoLinkedSegments(parent, true);
  await mkdir(parent, { recursive: true });
  await assertPathHasNoLinkedSegments(parent, false);
  await assertPathAbsent(outputDirectory);
  let stageRoot: string | null = null;
  let repeatRoot: string | null = null;
  let finalCreated = false;
  try {
    stageRoot = await mkdtemp(path.join(parent, ".compatibility-fixture-stage-"));
    repeatRoot = await mkdtemp(path.join(parent, ".compatibility-fixture-repeat-"));
    const stagedFixtureRoot = path.join(stageRoot, "fixture-vault");
    const repeatedFixtureRoot = path.join(repeatRoot, "fixture-vault");
    await materializePlan(stagedFixtureRoot, planned.files, options.failAfterMaterializedFileCount);
    await materializePlan(repeatedFixtureRoot, planned.files);
    const stagedSnapshot = await captureFixtureSnapshot(stagedFixtureRoot);
    const repeatedSnapshot = await captureFixtureSnapshot(repeatedFixtureRoot);
    if (stagedSnapshot.sha256 !== repeatedSnapshot.sha256) {
      throw new Error("Compatibility fixture repeatability check produced a different snapshot SHA-256.");
    }
    const finalFixtureRoot = path.join(outputDirectory, "fixture-vault");
    const marker = planned.files.find((file) => file.path === FIXTURE_MARKER_PATH);
    if (!marker) throw new Error("Compatibility fixture marker was not planned.");
    const specialist = describeSpecialist("lyric-source-compatibility-fixture-builder");
    if (!specialist) throw new Error("Compatibility fixture specialist is not registered.");
    const manifest: LyricSourceCompatibilityFixtureManifest = {
      contract: "lyric-source-compatibility-fixture-manifest.v1",
      generatedAt: planningArtifact.value.generatedAt,
      specialist: { id: "lyric-source-compatibility-fixture-builder", version: specialist.version },
      authority: "OBSERVE",
      fixtureRoot: finalFixtureRoot,
      fixtureMarker: { path: FIXTURE_MARKER_PATH, byteSize: marker.byteSize, sha256: marker.sha256 },
      scoutReport: { path: scoutArtifact.path, sha256: scoutArtifact.sha256 },
      planningInput: { path: planningArtifact.path, sha256: planningArtifact.sha256 },
      proposal: {
        path: proposalArtifact.path,
        proposalId: proposalArtifact.value.proposalId,
        proposalSha256: proposalArtifact.value.proposalSha256,
        artifactSha256: proposalArtifact.sha256
      },
      decision: {
        path: decisionArtifact.path,
        proposalId: decisionArtifact.value.proposalId,
        proposalSha256: decisionArtifact.value.proposalSha256,
        decisionState: "approved",
        decisionArtifactSha256: decisionArtifact.value.decisionArtifactSha256,
        artifactSha256: decisionArtifact.sha256
      },
      materializedFiles: planned.files.map(({ bytes: _bytes, ...file }) => file),
      operationTargets: planned.operationTargets,
      evidenceFiles: planned.evidenceFiles,
      guardFiles: planned.guardFiles,
      duplicatePathChecks: planned.duplicatePathChecks,
      decodedPayloadChecks: { checkedPayloadCount: planned.decodedPayloadCount, passed: true },
      proposalRecompileCheck: {
        proposalId: proposalArtifact.value.proposalId,
        proposalSha256: proposalArtifact.value.proposalSha256,
        passed: true
      },
      fixtureSnapshotSha256: stagedSnapshot.sha256,
      safety: { liveVaultAccess: false, liveVaultMutation: "none", fixtureMutationOnly: true, applyExecuted: false }
    };
    assertSpecialistOutputContract("lyric-source-compatibility-fixture-builder", manifest.contract);
    const manifestPath = path.join(stageRoot, "lyric-source-compatibility-fixture-manifest.v1.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const sealedManifest = parseManifest(await readFile(manifestPath, "utf8"));
    if (sealedManifest.fixtureSnapshotSha256 !== manifest.fixtureSnapshotSha256) throw new Error("Sealed fixture manifest changed identity.");
    await rm(repeatRoot, { recursive: true, force: true });
    repeatRoot = null;
    await rename(stageRoot, outputDirectory);
    stageRoot = null;
    finalCreated = true;
    const finalManifestPath = path.join(outputDirectory, "lyric-source-compatibility-fixture-manifest.v1.json");
    const finalSnapshot = await captureFixtureSnapshot(finalFixtureRoot);
    if (finalSnapshot.sha256 !== manifest.fixtureSnapshotSha256) throw new Error("Final fixture snapshot changed after staging.");
    await verifyCompatibilityFixtureManifest(finalManifestPath);
    return {
      manifest,
      manifestPath: finalManifestPath,
      fixtureRoot: finalFixtureRoot,
      inputArtifacts: [
        { contract: scoutArtifact.value.contract, path: scoutArtifact.path, sha256: scoutArtifact.sha256 },
        { contract: planningArtifact.value.contract, path: planningArtifact.path, sha256: planningArtifact.sha256 },
        { contract: proposalArtifact.value.contract, path: proposalArtifact.path, sha256: proposalArtifact.sha256 },
        { contract: decisionArtifact.value.contract, path: decisionArtifact.path, sha256: decisionArtifact.sha256 }
      ]
    };
  } catch (error: unknown) {
    if (stageRoot) await rm(stageRoot, { recursive: true, force: true });
    if (repeatRoot) await rm(repeatRoot, { recursive: true, force: true });
    if (finalCreated) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyCompatibilityFixtureManifest(manifestPathInput: string): Promise<LyricSourceCompatibilityFixtureManifest> {
  const manifestPath = path.resolve(manifestPathInput);
  rejectLiveVaultPath(manifestPath);
  await assertPathHasNoLinkedSegments(manifestPath, false);
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  if (
    manifest.authority !== "OBSERVE" ||
    manifest.safety.liveVaultAccess !== false ||
    manifest.safety.liveVaultMutation !== "none" ||
    manifest.safety.fixtureMutationOnly !== true ||
    manifest.safety.applyExecuted !== false
  ) throw new Error("Compatibility fixture manifest failed its OBSERVE-only safety contract.");
  if (
    manifest.decision.decisionState !== "approved" || manifest.decision.proposalId !== manifest.proposal.proposalId ||
    manifest.decision.proposalSha256 !== manifest.proposal.proposalSha256 ||
    manifest.proposalRecompileCheck.passed !== true || manifest.decodedPayloadChecks.passed !== true ||
    manifest.duplicatePathChecks.passed !== true || manifest.duplicatePathChecks.contradictoryDuplicates !== 0 ||
    manifest.duplicatePathChecks.caseCollisions !== 0
  ) throw new Error("Compatibility fixture manifest lineage or correlation checks are incomplete.");
  for (const artifactPath of [manifest.scoutReport.path, manifest.planningInput.path, manifest.proposal.path, manifest.decision.path]) {
    rejectLiveVaultPath(artifactPath);
  }
  const fixtureRoot = path.resolve(manifest.fixtureRoot);
  rejectLiveVaultPath(fixtureRoot);
  if (!sameNativePath(fixtureRoot, path.join(path.dirname(manifestPath), "fixture-vault"))) {
    throw new Error("Compatibility fixture manifest does not bind its canonical fixture-vault directory.");
  }
  await assertPathHasNoLinkedSegments(fixtureRoot, false);
  const allowedRoles = new Set<LyricSourceCompatibilityFixtureFileRole>(["operation-current", "evidence-source", "evidence-managed", "guard", "fixture-marker"]);
  const expectedPaths = manifest.materializedFiles.map((file) => {
    if (!allowedRoles.has(file.role) || !Number.isInteger(file.byteSize) || file.byteSize < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Compatibility fixture manifest contains an invalid file identity: ${String(file.path)}`);
    }
    return validateContractPath(file.path);
  });
  if (new Set(expectedPaths).size !== expectedPaths.length) throw new Error("Compatibility fixture manifest contains duplicate materialized paths.");
  for (const collection of [manifest.operationTargets, manifest.evidenceFiles, manifest.guardFiles]) {
    const normalized = collection.map(validateContractPath);
    if (JSON.stringify(normalized) !== JSON.stringify(sortedUnique(normalized)) || normalized.some((item) => !expectedPaths.includes(item))) {
      throw new Error("Compatibility fixture manifest path collections are not canonical, unique, ordered, and materialized.");
    }
  }
  const marker = manifest.materializedFiles.find((file) => file.path === FIXTURE_MARKER_PATH);
  if (
    !marker || marker.role !== "fixture-marker" || manifest.fixtureMarker.path !== FIXTURE_MARKER_PATH ||
    marker.byteSize !== manifest.fixtureMarker.byteSize || marker.sha256 !== manifest.fixtureMarker.sha256
  ) throw new Error("Compatibility fixture marker identity is incomplete.");
  const snapshot = await captureFixtureSnapshot(fixtureRoot);
  const expectedRows = [...manifest.materializedFiles]
    .map((file) => ({ path: validateContractPath(file.path), byteSize: file.byteSize, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(snapshot.rows) !== JSON.stringify(expectedRows) || snapshot.sha256 !== manifest.fixtureSnapshotSha256) {
    throw new Error("Compatibility fixture files do not match the persisted manifest snapshot.");
  }
  return manifest;
}

function validateLineage(
  scout: PersistedArtifact<LyricSourceBatchScoutReport>,
  planning: PersistedArtifact<LyricSourcePlanningInput>,
  proposal: PersistedArtifact<LyricSourceDesignationProposal>,
  decision: PersistedArtifact<AuthorityTransitionDecision>
): void {
  if (
    scout.value.refusal !== null || scout.value.safety.applyEnabled !== false || scout.value.safety.vaultMutation !== "none" ||
    scout.value.planningInputPath === null || scout.value.planningInputSha256 === null
  ) throw new Error("Scout report does not declare a successful sealed planning input.");
  if (!sameNativePath(scout.value.planningInputPath, planning.path) || scout.value.planningInputSha256 !== planning.sha256) {
    throw new Error("Scout report does not bind the exact persisted planning input path and SHA-256.");
  }
  validatePlanningInput(planning.value, scout.value.expectedOperationCount);
  const recompiled = compileLyricSourceProposal(planning.value);
  if (
    recompiled.proposalId !== proposal.value.proposalId ||
    recompiled.proposalSha256 !== proposal.value.proposalSha256 ||
    recompiled.canonicalHashPayload !== proposal.value.canonicalHashPayload
  ) throw new Error("Planning input recompilation does not match the persisted proposal identity.");
  const selected = [...scout.value.selectedIncludedProjects].sort();
  if (JSON.stringify(selected) !== JSON.stringify([...proposal.value.includedProjects].sort())) {
    throw new Error("Scout selected projects do not match the proposal included projects.");
  }
  if (
    !verifyReviewDecision(decision.value) || decision.value.decisionState !== "approved" ||
    decision.value.proposalId !== proposal.value.proposalId || decision.value.proposalSha256 !== proposal.value.proposalSha256
  ) throw new Error("Decision artifact is not an approved exact-proposal binding.");
}

function buildFixturePlan(planning: LyricSourcePlanningInput, proposal: LyricSourceDesignationProposal): {
  files: PlannedFixtureFile[];
  operationTargets: string[];
  evidenceFiles: string[];
  guardFiles: string[];
  decodedPayloadCount: number;
  duplicatePathChecks: LyricSourceCompatibilityFixtureManifest["duplicatePathChecks"];
} {
  const payloads: PlannedFixtureFile[] = [];
  const operationPayloads: PlannedFixtureFile[] = [];
  const evidencePayloads: PlannedFixtureFile[] = [];
  const guardPayloads: PlannedFixtureFile[] = [];
  const included = planning.projects.filter((project) => project.include).sort((left, right) => left.projectPath.localeCompare(right.projectPath));
  for (const project of included) {
    if (!project.source || !project.managed || !project.controlFile) throw new Error(`Included project lacks fixture payloads: ${project.projectPath}`);
    operationPayloads.push(payloadFromBase64(project.controlFile.path, "operation-current", project.controlFile.currentByteSize, project.controlFile.currentSha256, project.controlFile.currentContentBase64));
    evidencePayloads.push(payloadFromBase64(project.source.path, "evidence-source", project.source.byteSize, project.source.sha256, project.source.contentBase64));
    evidencePayloads.push(payloadFromBase64(project.managed.path, "evidence-managed", project.managed.byteSize, project.managed.sha256, project.managed.contentBase64));
  }
  for (const control of planning.albumControlFiles) {
    operationPayloads.push(payloadFromBase64(control.path, "operation-current", control.currentByteSize, control.currentSha256, control.currentContentBase64));
  }
  for (const guard of planning.guardFiles) {
    guardPayloads.push(payloadFromBase64(guard.path, "guard", guard.byteSize, guard.sha256, guard.contentBase64));
  }
  assertOperationCorrelation(operationPayloads, proposal);
  assertEvidenceCorrelation(included, evidencePayloads, proposal);
  assertGuardCorrelation(guardPayloads, proposal);
  payloads.push(...operationPayloads, ...evidencePayloads, ...guardPayloads, {
    path: FIXTURE_MARKER_PATH,
    role: "fixture-marker",
    byteSize: FIXTURE_MARKER_BYTES.byteLength,
    sha256: sha256Bytes(FIXTURE_MARKER_BYTES),
    bytes: FIXTURE_MARKER_BYTES,
    sourceArtifact: "fixture-builder"
  });
  const unique = new Map<string, PlannedFixtureFile>();
  const casePaths = new Map<string, string>();
  let identicalDuplicatesDeduplicated = 0;
  for (const payload of payloads) {
    const caseKey = payload.path.toLowerCase();
    const existingCase = casePaths.get(caseKey);
    if (existingCase && existingCase !== payload.path) throw new Error(`Case-colliding compatibility fixture paths are forbidden: ${existingCase} and ${payload.path}`);
    casePaths.set(caseKey, payload.path);
    const existing = unique.get(payload.path);
    if (!existing) {
      unique.set(payload.path, payload);
      continue;
    }
    if (existing.byteSize !== payload.byteSize || existing.sha256 !== payload.sha256 || !existing.bytes.equals(payload.bytes)) {
      throw new Error(`Contradictory duplicate compatibility fixture path: ${payload.path}`);
    }
    identicalDuplicatesDeduplicated += 1;
  }
  const files = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    operationTargets: sortedUnique(operationPayloads.map((file) => file.path)),
    evidenceFiles: sortedUnique(evidencePayloads.map((file) => file.path)),
    guardFiles: sortedUnique(guardPayloads.map((file) => file.path)),
    decodedPayloadCount: operationPayloads.length + evidencePayloads.length + guardPayloads.length,
    duplicatePathChecks: {
      inputPathCount: payloads.length,
      uniquePathCount: files.length,
      identicalDuplicatesDeduplicated,
      contradictoryDuplicates: 0,
      caseCollisions: 0,
      passed: true
    }
  };
}

function assertOperationCorrelation(payloads: PlannedFixtureFile[], proposal: LyricSourceDesignationProposal): void {
  const byPath = uniqueRoleMap(payloads, "operation-current");
  if (byPath.size !== proposal.operations.length) throw new Error("Proposal operations do not exactly match planning-input current payloads.");
  for (const operation of proposal.operations) {
    const payload = byPath.get(validateContractPath(operation.path));
    if (!payload || payload.byteSize !== operation.currentByteCount || payload.sha256 !== operation.currentSha256) {
      throw new Error(`Proposal current operation identity does not match planning input: ${operation.path}`);
    }
  }
}

function assertEvidenceCorrelation(
  included: LyricSourcePlanningInput["projects"],
  payloads: PlannedFixtureFile[],
  proposal: LyricSourceDesignationProposal
): void {
  if (proposal.evidence.length !== included.length || payloads.length !== included.length * 2) {
    throw new Error("Proposal evidence does not exactly match included planning projects.");
  }
  for (const project of included) {
    if (!project.source || !project.managed) throw new Error(`Included project evidence is incomplete: ${project.projectPath}`);
    const rows = proposal.evidence.filter((row) => row.projectPath === project.projectPath);
    if (rows.length !== 1) throw new Error(`Expected exactly one proposal evidence row: ${project.projectPath}`);
    const row = rows[0];
    if (
      !row || row.sourcePath !== project.source.path || row.managedPath !== project.managed.path ||
      row.byteSize !== project.source.byteSize || row.sha256 !== project.source.sha256 ||
      project.source.byteSize !== project.managed.byteSize || project.source.sha256 !== project.managed.sha256
    ) throw new Error(`Proposal lyric evidence identity is stale: ${project.projectPath}`);
  }
}

function assertGuardCorrelation(payloads: PlannedFixtureFile[], proposal: LyricSourceDesignationProposal): void {
  const byPath = uniqueRoleMap(payloads, "guard");
  if (byPath.size !== proposal.guardFiles.length) throw new Error("Proposal guards do not exactly match planning-input guard payloads.");
  for (const guard of proposal.guardFiles) {
    const payload = byPath.get(validateContractPath(guard.path));
    if (!payload || payload.byteSize !== guard.byteSize || payload.sha256 !== guard.sha256) {
      throw new Error(`Proposal guard identity does not match planning input: ${guard.path}`);
    }
  }
}

function uniqueRoleMap(payloads: PlannedFixtureFile[], role: LyricSourceCompatibilityFixtureFileRole): Map<string, PlannedFixtureFile> {
  const result = new Map<string, PlannedFixtureFile>();
  for (const payload of payloads) {
    if (result.has(payload.path)) throw new Error(`Duplicate ${role} path is ambiguous: ${payload.path}`);
    result.set(payload.path, payload);
  }
  return result;
}

function payloadFromBase64(pathInput: string, role: LyricSourceCompatibilityFixtureFileRole, byteSize: number, expectedSha256: string, contentBase64: string): PlannedFixtureFile {
  const contractPath = validateContractPath(pathInput);
  if (!Number.isInteger(byteSize) || byteSize < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`Invalid payload identity: ${contractPath}`);
  if (typeof contentBase64 !== "string") throw new Error(`Missing Base64 payload: ${contractPath}`);
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64 || bytes.byteLength !== byteSize || sha256Bytes(bytes) !== expectedSha256) {
    throw new Error(`Decoded payload does not match byte count and SHA-256: ${contractPath}`);
  }
  return { path: contractPath, role, byteSize, sha256: expectedSha256, bytes, sourceArtifact: "lyric-source-planning-input.v1" };
}

async function materializePlan(root: string, files: PlannedFixtureFile[], failAfter?: number): Promise<void> {
  await mkdir(root, { recursive: true });
  await assertPathHasNoLinkedSegments(root, false);
  let written = 0;
  for (const file of files) {
    const target = fixtureNativePath(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await assertPathHasNoLinkedSegments(path.dirname(target), false);
    await assertPathInsideRoot(root, target);
    await writeFile(target, file.bytes, { flag: "wx" });
    written += 1;
    const sealed = await readFile(target);
    if (!sealed.equals(file.bytes) || sealed.byteLength !== file.byteSize || sha256Bytes(sealed) !== file.sha256) {
      throw new Error(`Materialized compatibility fixture bytes failed verification: ${file.path}`);
    }
    if (failAfter !== undefined && written >= failAfter) throw new Error(`Forced compatibility fixture failure after ${written} files.`);
  }
}

async function captureFixtureSnapshot(root: string): Promise<{ rows: Array<{ path: string; byteSize: number; sha256: string }>; sha256: string }> {
  const rows: Array<{ path: string; byteSize: number; sha256: string }> = [];
  await walkFixture(root, root, rows);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return { rows, sha256: canonicalJsonSha256(rows) };
}

async function walkFixture(root: string, directory: string, rows: Array<{ path: string; byteSize: number; sha256: string }>): Promise<void> {
  await assertPathHasNoLinkedSegments(directory, false);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    const item = await lstat(target);
    if (item.isSymbolicLink()) throw new Error(`Linked compatibility fixture path is forbidden: ${target}`);
    if (item.isDirectory()) {
      await walkFixture(root, target, rows);
      continue;
    }
    if (!item.isFile()) throw new Error(`Unsupported compatibility fixture filesystem entry: ${target}`);
    const contractPath = path.relative(root, target).split(path.sep).join("/");
    validateContractPath(contractPath);
    const bytes = await readFile(target);
    rows.push({ path: contractPath, byteSize: bytes.byteLength, sha256: sha256Bytes(bytes) });
  }
}

async function loadArtifact<T>(filePath: string, contract: string, expectations: { proposalId?: string; proposalSha256?: string } = {}): Promise<PersistedArtifact<T>> {
  const bytes = await readFile(filePath);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.contract !== contract) throw new Error(`Expected persisted ${contract} artifact: ${filePath}`);
  const sha256 = sha256Bytes(bytes);
  const verification = await verifyArtifact(filePath, contract, sha256, filePath, expectations);
  if (!verification.verified || verification.supersessionState !== "active") throw new Error(`Persisted ${contract} artifact failed structural or supersession verification.`);
  return { value: parsed as T, bytes, sha256, path: path.resolve(filePath) };
}

async function loadProposal(filePath: string): Promise<PersistedArtifact<LyricSourceDesignationProposal>> {
  const bytes = await readFile(filePath);
  const proposal = parseAndVerifyLyricSourceProposal(bytes.toString("utf8"), filePath);
  const sha256 = sha256Bytes(bytes);
  const verification = await verifyArtifact(filePath, proposal.contract, sha256, filePath, {
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256
  });
  if (!verification.verified || verification.supersessionState !== "active") throw new Error("Persisted proposal failed canonical, structural, or supersession verification.");
  return { value: proposal, bytes, sha256, path: path.resolve(filePath) };
}

function parseManifest(text: string): LyricSourceCompatibilityFixtureManifest {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.contract !== "lyric-source-compatibility-fixture-manifest.v1" || !Array.isArray(parsed.materializedFiles)) {
    throw new Error("Expected lyric-source-compatibility-fixture-manifest.v1 artifact.");
  }
  return parsed as LyricSourceCompatibilityFixtureManifest;
}

async function assertReportsPath(reportsRoot: string, candidate: string, allowMissing: boolean): Promise<void> {
  await assertPathHasNoLinkedSegments(reportsRoot, false);
  await assertPathInsideRoot(reportsRoot, candidate);
  const relative = path.relative(reportsRoot, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Compatibility fixture paths must remain beneath the reports root.");
  }
  await assertPathHasNoLinkedSegments(candidate, allowMissing);
}

async function assertPathAbsent(candidate: string): Promise<void> {
  try {
    await access(candidate);
    throw new Error(`Compatibility fixture output already exists: ${candidate}`);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") throw error;
  }
}

function fixtureNativePath(root: string, contractPath: string): string {
  return path.join(root, ...validateContractPath(contractPath).split("/"));
}

function validateContractPath(input: string): string {
  if (input.includes(":") || input.includes("\0") || input.includes("\\")) throw new Error(`Unsafe compatibility fixture contract path: ${input}`);
  const normalized = normalizeContractPath(input);
  if (normalized !== input) throw new Error(`Compatibility fixture contract path is not canonical: ${input}`);
  return normalized;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function rejectLiveVaultPath(candidate: string): void {
  if (isLiveMusicVaultPath(candidate)) throw new Error("Compatibility fixture builder refuses every live Music Vault path.");
}

function sameNativePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
