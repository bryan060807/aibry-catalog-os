import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetInspection, AssetInspectionReport, AssetRecord } from "../asset-inspector.js";
import type { AssetFindingRoutesArtifact, ReadOnlyRefreshWorkflowSummary, RoutedAssetFinding } from "../asos-workflow.js";
import type { AuditFinding } from "../catalog/audit.js";
import type { CatalogIndex, CatalogIndexSongRecord } from "../catalog/publish.js";
import { canonicalJsonSha256, sha256Bytes } from "../kernel/canonical-json.js";
import {
  assertOutputOutsideRoot,
  assertPathHasNoLinkedSegments,
  contractPathToNative,
  normalizeContractPath
} from "../kernel/contract-path.js";
import { specialistId, type SpecialistRefusal } from "../specialists/contracts.js";
import { describeSpecialist } from "../specialists/registry.js";
import {
  classifyMigrationManifest,
  compileAlbumControlDocuments,
  compileProjectControlDocument,
  type ControlDocumentTrack
} from "./control-document-compiler.js";
import type {
  LyricControlFileInput,
  LyricFileState,
  LyricSourceBatchScoutCandidate,
  LyricSourceBatchScoutReport,
  LyricSourcePlanningInput,
  LyricSourcePlanningProject
} from "./contracts.js";
import { compileLyricSourceProposal } from "./proposal-specialist.js";

export const DEFAULT_SCOUT_EXCLUDED_RELEASES = ["black-box-psalms", "the-violence-of-spring"] as const;

export type LyricSourceBatchScoutOptions = {
  vaultRoot: string;
  refreshReportPath: string;
  planningInputPath: string;
  minTracks?: number;
  maxTracks?: number;
  excludedReleases?: string[];
  beforeFinalEvidenceRehash?: () => Promise<void>;
};

export type LyricSourceBatchScoutResult = {
  report: LyricSourceBatchScoutReport;
  planningInput: LyricSourcePlanningInput | null;
  planningInputBytes: Buffer | null;
};

type VerifiedRefreshLineage = {
  refresh: ReadOnlyRefreshWorkflowSummary;
  refreshPath: string;
  refreshBytes: Buffer;
  refreshSha256: string;
  catalogIndex: CatalogIndex;
  assetInspection: AssetInspectionReport;
  findingRoutes: AssetFindingRoutesArtifact;
  artifacts: Array<{ name: string; path: string; sha256: string; contract: string; byteSize: number }>;
};

type CandidateInternal = {
  row: LyricSourceBatchScoutCandidate;
  song: CatalogIndexSongRecord;
  inspection: AssetInspection | null;
  projectSlug: string;
  trackNumber: number | null;
  projectControl: LyricFileState | null;
  projectCurrentContent: string | null;
  source: LyricFileState | null;
  managed: LyricFileState | null;
};

type ReleaseControls = {
  releasePath: string;
  migrationManifest: LyricFileState;
  readme: LyricFileState;
  tracklist: LyricFileState;
  albumProjectGuard: LyricFileState;
  releasePackageGuard: LyricFileState;
  manifestEntries: unknown[];
};

export async function scoutLyricSourceBatch(options: LyricSourceBatchScoutOptions): Promise<LyricSourceBatchScoutResult> {
  const minTracks = options.minTracks ?? 2;
  const maxTracks = options.maxTracks ?? 4;
  assertTrackLimits(minTracks, maxTracks);
  const vaultRoot = await realpath(path.resolve(options.vaultRoot));
  await assertPathHasNoLinkedSegments(vaultRoot, false);
  await assertOutputOutsideRoot(vaultRoot, options.planningInputPath);
  const lineage = await verifyRefreshArtifactLineage(vaultRoot, options.refreshReportPath);
  const specialist = describeSpecialist("lyric-source-batch-scout");
  if (!specialist) throw new Error("Lyric Source Batch Scout is not registered.");
  const excludedReleases = new Set([
    ...DEFAULT_SCOUT_EXCLUDED_RELEASES,
    ...(options.excludedReleases ?? [])
  ].map((value) => value.toLowerCase()));
  const albumSongs = lineage.catalogIndex.songs
    .filter((song) => song.releaseContext.type === "album-track")
    .sort((left, right) => normalizeArtifactPath(left.directoryRelativePath).localeCompare(normalizeArtifactPath(right.directoryRelativePath)));
  const duplicateProjects = duplicates(albumSongs.map((song) => normalizeArtifactPath(song.directoryRelativePath)));
  if (duplicateProjects.length > 0) {
    return refusalResult(lineage, specialist.version, options.planningInputPath, "duplicate-project-mapping", "Catalog index contains duplicate album project mappings.", duplicateProjects);
  }
  const inspections = new Map(lineage.assetInspection.inspections.map((inspection) => [normalizeArtifactPath(inspection.projectPath), inspection]));
  const routesByProject = groupRoutes(lineage.findingRoutes.routes);
  const findingsByProject = groupCatalogFindings(lineage.catalogIndex.findings);
  const candidates: CandidateInternal[] = [];
  const releaseControls = new Map<string, ReleaseControls | Error>();
  for (const song of albumSongs) {
    const projectPath = normalizeArtifactPath(song.directoryRelativePath);
    const albumSlug = albumSlugForSong(song);
    if (!releaseControls.has(albumSlug)) {
      releaseControls.set(albumSlug, await loadReleaseControls(vaultRoot, song).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error))
      ));
    }
    candidates.push(await inspectCandidate({
      vaultRoot,
      song,
      inspection: inspections.get(projectPath) ?? null,
      routes: routesByProject.get(projectPath) ?? [],
      findings: findingsByProject.get(normalizeArtifactPath(song.projectFileRelativePath)) ?? [],
      releaseControls: releaseControls.get(albumSlug),
      releaseExcluded: excludedReleases.has(albumSlug)
    }));
  }
  excludeDuplicateSources(candidates);
  const selected = selectBatch(candidates, minTracks, maxTracks, excludedReleases);
  const baselineCounts = baselineFromRefresh(lineage.refresh);
  const inspectedReleaseContainers = summarizeReleases(candidates, excludedReleases);
  if (!selected) {
    const report = baseReport(lineage, specialist.version, options.planningInputPath, baselineCounts, inspectedReleaseContainers, candidates);
    report.planningInputPath = null;
    report.refusal = refusal(
      "no-safe-batch",
      `No coherent ${minTracks}-to-${maxTracks}-track batch passed every evidence and compiler check.`,
      summarizeCandidateRefusalDetails(candidates)
    );
    return { report, planningInput: null, planningInputBytes: null };
  }
  const controls = releaseControls.get(selected.albumSlug);
  if (!controls || controls instanceof Error) {
    return refusalResult(lineage, specialist.version, options.planningInputPath, "release-controls-unavailable", "Selected release controls are unavailable.", [controls?.message ?? selected.albumSlug], candidates);
  }
  const planningInput = buildPlanningInput(lineage, selected, controls, candidates, baselineCounts);
  await options.beforeFinalEvidenceRehash?.();
  const evidencePaths = planningEvidenceStates(planningInput);
  const drift = await rehashPlanningEvidence(vaultRoot, evidencePaths);
  if (drift.length > 0) {
    for (const candidate of candidates) {
      if (candidate.row.projectPath && drift.some((item) => item.startsWith(`${candidate.row.projectPath}:`) || item.includes(candidate.row.projectPath))) {
        excludeCandidate(candidate, "Evidence changed during final rehash.");
      }
    }
    const report = baseReport(lineage, specialist.version, options.planningInputPath, baselineCounts, inspectedReleaseContainers, candidates);
    report.planningInputPath = null;
    report.evidenceRehashStatus = "failed";
    report.refusal = refusal("evidence-drift", "Evidence changed while scouting; planning input was not sealed.", drift);
    return { report, planningInput: null, planningInputBytes: null };
  }
  await rehashRefreshLineage(lineage);
  validatePlanningInput(planningInput, selected.included.length + 3);
  const planningInputBytes = serializePlanningInput(planningInput);
  const planningInputSha256 = sha256Bytes(planningInputBytes);
  const report = baseReport(lineage, specialist.version, options.planningInputPath, baselineCounts, inspectedReleaseContainers, candidates);
  report.expectedCounts = planningInput.expectedCounts;
  report.perProjectFindingRemovals = selected.included.map((candidate) => ({
    projectPath: candidate.row.projectPath,
    catalogFindings: candidate.row.catalogFindingCount,
    assetFindings: candidate.row.assetFindingCount,
    routedFindings: { "blocks-existing-proposal": candidate.row.blockingRouteCount }
  }));
  report.selectedReleaseContainer = selected.albumSlug;
  report.selectedIncludedProjects = selected.included.map((candidate) => candidate.row.projectPath);
  report.naturalBatchBoundary = selected.boundary;
  report.expectedOperationCount = selected.included.length + 3;
  report.planningInputSha256 = planningInputSha256;
  report.evidenceRehashStatus = "passed";
  report.excludedProjects = selectionExclusions(candidates, selected);
  return { report, planningInput, planningInputBytes };
}

export async function verifyRefreshArtifactLineage(vaultRootInput: string, refreshReportInput: string): Promise<VerifiedRefreshLineage> {
  const vaultRoot = await realpath(path.resolve(vaultRootInput));
  const refreshPath = path.resolve(refreshReportInput);
  await assertOutputOutsideRoot(vaultRoot, refreshPath);
  await assertPathHasNoLinkedSegments(refreshPath, false);
  const refreshBytes = await readFile(refreshPath);
  const refresh = parseJson<ReadOnlyRefreshWorkflowSummary>(refreshBytes, "read-only refresh report");
  if (
    refresh.contract !== "asos-workflow-read-only-refresh.v1.1"
    || refresh.safety?.applyEnabled !== false
    || refresh.safety?.vaultMutation !== "none"
    || refresh.counts?.pendingApply !== 0
  ) {
    throw new Error("Refresh report contract or kernel safety state is invalid.");
  }
  const reportedVault = await realpath(path.resolve(refresh.source.vaultPath));
  if (!samePath(vaultRoot, reportedVault)) throw new Error("Refresh report Vault root does not match the supplied Vault root.");
  const required = [
    { name: "catalog-index", contract: "catalog-index.v1" },
    { name: "asset-inspection", contract: "asset-inspection-report.v1" },
    { name: "asset-finding-routes", contract: "asset-finding-routes.v1" }
  ];
  const artifacts: VerifiedRefreshLineage["artifacts"] = [];
  const parsed = new Map<string, unknown>();
  for (const definition of required) {
    const matches = refresh.artifacts.filter((artifact) => artifact.name === definition.name && artifact.role === "output");
    if (matches.length !== 1 || matches[0]?.contract !== definition.contract) {
      throw new Error(`Refresh lineage must contain exactly one ${definition.contract} artifact.`);
    }
    const artifact = matches[0];
    if (!artifact) throw new Error(`Missing ${definition.name} artifact.`);
    const artifactPath = path.resolve(artifact.path);
    await assertOutputOutsideRoot(vaultRoot, artifactPath);
    await assertPathHasNoLinkedSegments(artifactPath, false);
    const bytes = await readFile(artifactPath);
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== artifact.sha256) throw new Error(`Refresh lineage SHA-256 mismatch for ${definition.name}.`);
    const value = parseJson<unknown>(bytes, definition.name);
    if (!declaresContract(value, definition.contract)) throw new Error(`Refresh lineage contract mismatch for ${definition.name}.`);
    artifacts.push({ name: definition.name, path: artifactPath, sha256: actualSha256, contract: definition.contract, byteSize: bytes.byteLength });
    parsed.set(definition.name, value);
  }
  if (new Set(artifacts.map((artifact) => artifact.path.toLowerCase())).size !== artifacts.length) {
    throw new Error("Refresh lineage reuses one path for multiple artifact roles.");
  }
  return {
    refresh,
    refreshPath,
    refreshBytes,
    refreshSha256: sha256Bytes(refreshBytes),
    catalogIndex: parsed.get("catalog-index") as CatalogIndex,
    assetInspection: parsed.get("asset-inspection") as AssetInspectionReport,
    findingRoutes: parsed.get("asset-finding-routes") as AssetFindingRoutesArtifact,
    artifacts
  };
}

export function serializePlanningInput(input: LyricSourcePlanningInput): Buffer {
  return Buffer.from(`${JSON.stringify(input, null, 2)}\n`, "utf8");
}

export function validatePlanningInput(input: LyricSourcePlanningInput, expectedOperationCount: number): void {
  const parsed = JSON.parse(serializePlanningInput(input).toString("utf8")) as LyricSourcePlanningInput;
  if (parsed.contract !== "lyric-source-planning-input.v1") throw new Error("Planning input contract is invalid.");
  const projectPaths = parsed.projects.map((project) => project.projectPath);
  if (!isSorted(projectPaths) || new Set(projectPaths).size !== projectPaths.length) throw new Error("Planning projects are not uniquely sorted.");
  for (const project of parsed.projects) {
    for (const state of [project.source, project.managed].filter((value): value is LyricFileState => value !== null)) validateFileState(state);
    if (project.controlFile) validateBase64(project.controlFile.currentContentBase64, project.controlFile.currentByteSize, project.controlFile.currentSha256, project.controlFile.path);
    for (const candidate of project.candidates) validateFileState(candidate);
  }
  parsed.albumControlFiles.forEach((control) => validateBase64(control.currentContentBase64, control.currentByteSize, control.currentSha256, control.path));
  parsed.guardFiles.forEach(validateFileState);
  const proposal = compileLyricSourceProposal(parsed);
  if (proposal.operations.length !== expectedOperationCount) throw new Error("Planning input produced an unexpected operation count.");
}

async function inspectCandidate(input: {
  vaultRoot: string;
  song: CatalogIndexSongRecord;
  inspection: AssetInspection | null;
  routes: RoutedAssetFinding[];
  findings: AuditFinding[];
  releaseControls: ReleaseControls | Error | undefined;
  releaseExcluded: boolean;
}): Promise<CandidateInternal> {
  const projectPath = normalizeArtifactPath(input.song.directoryRelativePath);
  const projectSlug = path.posix.basename(projectPath);
  const albumSlug = albumSlugForSong(input.song);
  const trackNumber = parseTrackNumber(projectSlug);
  const row: LyricSourceBatchScoutCandidate = {
    projectPath,
    albumSlug,
    trackNumber,
    titleOrProjectSlug: input.song.title ?? projectSlug,
    legacySourcePath: null,
    managedCopyPath: null,
    sourceByteSize: null,
    managedByteSize: null,
    sourceSha256: null,
    managedSha256: null,
    exactNameMatch: false,
    sourceExists: false,
    managedExists: false,
    competingCandidateCount: 0,
    currentDesignationState: "none",
    currentManifestMappingState: "none",
    currentProjectControlHash: null,
    catalogFindingCount: 0,
    assetFindingCount: 0,
    blockingRouteCount: 0,
    eligibilityState: "eligible",
    exclusionReason: null
  };
  const candidate: CandidateInternal = {
    row,
    song: input.song,
    inspection: input.inspection,
    projectSlug,
    trackNumber,
    projectControl: null,
    projectCurrentContent: null,
    source: null,
    managed: null
  };
  if (input.releaseExcluded) excludeCandidate(candidate, "Release is excluded by the scout policy.");
  if (trackNumber === null) excludeCandidate(candidate, "Project slug does not begin with a supported numeric track prefix.");
  try {
    const projectFilePath = normalizeArtifactPath(input.song.projectFileRelativePath);
    const projectBytes = await readVaultFile(input.vaultRoot, projectFilePath);
    candidate.projectControl = fileState(projectFilePath, projectBytes);
    candidate.projectCurrentContent = projectBytes.toString("utf8");
    row.currentProjectControlHash = candidate.projectControl.sha256;
    row.currentDesignationState = designationState(candidate.projectCurrentContent);
    if (row.currentDesignationState === "human-approved") excludeCandidate(candidate, "A human-approved lyric-source designation already exists.");
    else if (row.currentDesignationState !== "none") excludeCandidate(candidate, "Project contains a conflicting or incomplete lyric-source designation.");
  } catch (error: unknown) {
    excludeCandidate(candidate, `Project control file is unsafe or unreadable: ${errorMessage(error)}`);
  }
  if (!input.inspection) {
    excludeCandidate(candidate, "Fresh Asset Inspector record is missing.");
  } else {
    if (input.inspection.lyricSourceResolution.state === "verified") excludeCandidate(candidate, "Lyric Source Resolver already reports verified provenance.");
    const managedRecords = input.inspection.assets.filter(isManagedLyricCandidate);
    const exactManaged = managedRecords.filter((asset) => fileStem(normalizeArtifactPath(asset.path)) === projectSlug);
    row.competingCandidateCount = exactManaged.length > 0 ? Math.max(0, managedRecords.length - 1) : managedRecords.length;
    if (managedRecords.length !== 1 || exactManaged.length !== 1) {
      excludeCandidate(candidate, managedRecords.length === 0 ? "Exactly one managed lyric candidate was not found." : "Managed lyric candidates are ambiguous.");
    } else {
      const managedPath = normalizeArtifactPath(exactManaged[0]?.path ?? "");
      row.managedCopyPath = managedPath;
      try {
        const bytes = await readVaultFile(input.vaultRoot, managedPath);
        candidate.managed = fileState(managedPath, bytes);
        row.managedExists = true;
        row.managedByteSize = bytes.byteLength;
        row.managedSha256 = candidate.managed.sha256;
      } catch (error: unknown) {
        excludeCandidate(candidate, `Managed lyric candidate is unsafe or unreadable: ${errorMessage(error)}`);
      }
    }
    const blockers = input.inspection.findings.filter((finding) => finding.type === "canonical-lyric-unresolved" || finding.type === "provenance-insufficient");
    row.assetFindingCount = blockers.length;
  }
  try {
    const sourceCandidates = await findLegacySourceCandidates(input.vaultRoot, albumSlug, projectSlug);
    if (sourceCandidates.length !== 1) {
      excludeCandidate(candidate, sourceCandidates.length === 0 ? "Exactly one legacy source candidate was not found." : "Legacy source candidates are ambiguous.");
    } else {
      const sourcePath = sourceCandidates[0];
      if (!sourcePath) throw new Error("Legacy source candidate path is missing.");
      row.legacySourcePath = sourcePath;
      const bytes = await readVaultFile(input.vaultRoot, sourcePath);
      candidate.source = fileState(sourcePath, bytes);
      row.sourceExists = true;
      row.sourceByteSize = bytes.byteLength;
      row.sourceSha256 = candidate.source.sha256;
    }
  } catch (error: unknown) {
    excludeCandidate(candidate, `Legacy source candidate is unsafe or unreadable: ${errorMessage(error)}`);
  }
  row.catalogFindingCount = input.findings.filter((finding) =>
    finding.category === "provenance" && finding.summary === "No structured migration provenance declared"
  ).length;
  row.blockingRouteCount = input.routes.filter((route) =>
    route.route === "blocks-existing-proposal"
    && (route.findingType === "canonical-lyric-unresolved" || route.findingType === "provenance-insufficient")
  ).length;
  if (row.catalogFindingCount !== 1 || row.assetFindingCount !== 2 || row.blockingRouteCount !== 2) {
    excludeCandidate(candidate, "Persisted catalog, Asset Inspector, and routed findings do not correlate exactly.");
  }
  if (input.releaseControls instanceof Error || !input.releaseControls) {
    excludeCandidate(candidate, `Release control documents are unsupported: ${input.releaseControls?.message ?? "missing controls"}`);
  } else {
    row.currentManifestMappingState = manifestMappingState(input.releaseControls.manifestEntries, projectPath, row.legacySourcePath, row.managedCopyPath);
    if (row.currentManifestMappingState === "conflicting" || row.currentManifestMappingState === "duplicate" || row.currentManifestMappingState === "invalid") {
      excludeCandidate(candidate, "Migration manifest contains a conflicting, duplicate, or invalid project mapping.");
    }
  }
  if (candidate.source && candidate.managed) {
    row.exactNameMatch = fileStem(candidate.source.path) === projectSlug
      && fileStem(candidate.managed.path) === projectSlug
      && path.posix.basename(candidate.source.path).toLowerCase() === path.posix.basename(candidate.managed.path).toLowerCase();
    if (!row.exactNameMatch) excludeCandidate(candidate, "Legacy and managed lyric basenames do not exactly match the project slug.");
    if (candidate.source.byteSize !== candidate.managed.byteSize || candidate.source.sha256 !== candidate.managed.sha256 || candidate.source.contentBase64 !== candidate.managed.contentBase64) {
      excludeCandidate(candidate, "Legacy and managed lyric bytes or SHA-256 values differ.");
    }
    try {
      await assertDistinctPhysicalFiles(input.vaultRoot, candidate.source.path, candidate.managed.path);
    } catch (error: unknown) {
      excludeCandidate(candidate, errorMessage(error));
    }
  }
  if (
    candidate.row.eligibilityState === "eligible"
    && candidate.source
    && candidate.managed
    && candidate.projectCurrentContent
    && candidate.trackNumber !== null
    && input.releaseControls
    && !(input.releaseControls instanceof Error)
  ) {
    try {
      compileProjectControlDocument(
        candidate.projectCurrentContent,
        toControlTrack(candidate),
        `${input.releaseControls.releasePath}/migration-manifest.md`
      );
    } catch (error: unknown) {
      excludeCandidate(candidate, `Project control compiler refused the document: ${errorMessage(error)}`);
    }
  }
  return candidate;
}

function buildPlanningInput(
  lineage: VerifiedRefreshLineage,
  selected: ReturnType<typeof selectBatch> & {},
  controls: ReleaseControls,
  allCandidates: CandidateInternal[],
  baseline: LyricSourceBatchScoutReport["baselineCounts"]
): LyricSourcePlanningInput {
  if (!selected) throw new Error("Selected batch is required.");
  const releaseCandidates = allCandidates
    .filter((candidate) => candidate.row.albumSlug === selected.albumSlug)
    .sort(compareCandidate);
  const includedPaths = new Set(selected.included.map((candidate) => candidate.row.projectPath));
  const unresolved = releaseCandidates.filter((candidate) => !includedPaths.has(candidate.row.projectPath)).map((candidate) => ({
    projectPath: candidate.row.projectPath,
    trackNumber: candidate.trackNumber,
    reason: candidate.row.exclusionReason ?? "Outside the selected deterministic batch boundary."
  }));
  const tracks = selected.included.map(toControlTrack);
  const albumCompiled = compileAlbumControlDocuments({
    albumSlug: selected.albumSlug,
    generatedAt: lineage.refresh.generatedAt,
    selectedTracks: tracks,
    unresolvedTracks: unresolved,
    currentMigrationManifest: Buffer.from(controls.migrationManifest.contentBase64, "base64").toString("utf8"),
    currentReadme: Buffer.from(controls.readme.contentBase64, "base64").toString("utf8"),
    currentTracklist: Buffer.from(controls.tracklist.contentBase64, "base64").toString("utf8")
  });
  const migrationPath = `${controls.releasePath}/migration-manifest.md`;
  const projects: LyricSourcePlanningProject[] = releaseCandidates.map((candidate) => {
    if (!includedPaths.has(candidate.row.projectPath)) {
      return {
        projectPath: candidate.row.projectPath,
        include: false,
        exclusionReason: candidate.row.exclusionReason ?? "Outside the selected deterministic batch boundary.",
        source: null,
        managed: null,
        candidates: [],
        controlFile: null
      };
    }
    if (!candidate.source || !candidate.managed || !candidate.projectControl || !candidate.projectCurrentContent) throw new Error("Selected candidate lost required evidence.");
    return {
      projectPath: candidate.row.projectPath,
      include: true,
      exclusionReason: null,
      source: candidate.source,
      managed: candidate.managed,
      candidates: [{ ...candidate.managed, accepted: true, exactNameMatch: true }],
      controlFile: controlFileInput(
        candidate.projectControl,
        compileProjectControlDocument(candidate.projectCurrentContent, toControlTrack(candidate), migrationPath)
      )
    };
  });
  const expectedRouted = { ...baseline.routedFindings };
  expectedRouted["blocks-existing-proposal"] = (expectedRouted["blocks-existing-proposal"] ?? 0)
    - selected.included.reduce((total, candidate) => total + candidate.row.blockingRouteCount, 0);
  const expectedCounts = {
    catalogFindings: baseline.catalogFindings - selected.included.reduce((total, candidate) => total + candidate.row.catalogFindingCount, 0),
    assetFindings: baseline.assetFindings - selected.included.reduce((total, candidate) => total + candidate.row.assetFindingCount, 0),
    routedFindings: expectedRouted
  };
  const resolverEvidence = selected.included.map((candidate) => candidate.inspection?.lyricSourceResolution ?? null);
  return {
    contract: "lyric-source-planning-input.v1",
    generatedAt: lineage.refresh.generatedAt,
    selectedBatch: {
      batchId: `scout-${selected.albumSlug}-${canonicalJsonSha256(selected.included.map((candidate) => candidate.row.projectPath)).slice(0, 12)}`,
      name: `${selected.albumSlug} lyric-source pilot`,
      projectPaths: releaseCandidates.map((candidate) => candidate.row.projectPath)
    },
    projects,
    albumControlFiles: [
      controlFileInput(controls.migrationManifest, albumCompiled.migrationManifest),
      controlFileInput(controls.readme, albumCompiled.readme),
      controlFileInput(controls.tracklist, albumCompiled.tracklist)
    ],
    currentCatalogIndex: {
      contract: "catalog-index.v1",
      sha256: artifactSha(lineage, "catalog-index"),
      counts: numericRecord(lineage.catalogIndex.counts)
    },
    assetInspectorEvidence: {
      contract: "asset-inspection-report.v1",
      sha256: artifactSha(lineage, "asset-inspection"),
      counts: numericRecord(lineage.assetInspection.counts)
    },
    lyricSourceResolverEvidence: {
      contract: "lyric-source-resolution-batch.v1",
      sha256: canonicalJsonSha256(resolverEvidence),
      projectPaths: selected.included.map((candidate) => candidate.row.projectPath)
    },
    baselineCounts: baseline,
    expectedCounts,
    guardFiles: [controls.albumProjectGuard, controls.releasePackageGuard].sort((left, right) => left.path.localeCompare(right.path)),
    preconditions: [
      "The refresh artifact and every referenced lineage artifact must retain its verified SHA-256.",
      "Every current control-file hash must match the planning input.",
      "Legacy and managed lyric evidence must remain byte-identical and must retain size and SHA-256.",
      "No path may cross a linked or reparse segment."
    ],
    rollbackRequirements: [
      "Copy and rehash every approved target outside the Music Vault before authorization.",
      "The rollback target count must exactly match the approved operation count.",
      "Restore every target and verify every original SHA-256 after any post-write failure."
    ],
    independentValidatorCriteria: [
      "All proposed control-file hashes are live and old target hashes are absent.",
      "Every selected resolver record exists exactly once and is verified.",
      "Lyric evidence sizes and SHA-256 values remain unchanged.",
      "Catalog, Asset Inspector, routed-finding, guard, pendingApply, and unrelated-file checks pass."
    ]
  };
}

function selectBatch(candidates: CandidateInternal[], minTracks: number, maxTracks: number, exclusions: Set<string>) {
  const grouped = groupBy(candidates, (candidate) => candidate.row.albumSlug);
  const ranked = [...grouped.entries()].map(([albumSlug, rows]) => {
    const ordered = [...rows].sort(compareCandidate);
    const prefix: CandidateInternal[] = [];
    for (const candidate of ordered) {
      const previous = prefix.at(-1);
      const contiguous = !previous || (previous.trackNumber !== null && candidate.trackNumber === previous.trackNumber + 1);
      if (!contiguous || candidate.row.eligibilityState !== "eligible") break;
      prefix.push(candidate);
    }
    return {
      albumSlug,
      ordered,
      prefix,
      included: prefix.slice(0, maxTracks),
      anomalyCount: ordered.filter((candidate) => candidate.row.eligibilityState === "excluded").length,
      lowestTrack: prefix[0]?.trackNumber ?? Number.MAX_SAFE_INTEGER
    };
  }).filter((release) => !exclusions.has(release.albumSlug) && release.included.length >= minTracks)
    .sort((left, right) =>
      right.included.length - left.included.length
      || left.anomalyCount - right.anomalyCount
      || left.lowestTrack - right.lowestTrack
      || left.albumSlug.localeCompare(right.albumSlug)
    );
  const selected = ranked[0];
  if (!selected) return null;
  const boundaryCandidate = selected.ordered[selected.included.length];
  const boundary = boundaryCandidate
    ? boundaryCandidate.row.eligibilityState === "excluded"
      ? `${boundaryCandidate.row.projectPath} is the first unsafe neighboring track: ${boundaryCandidate.row.exclusionReason}`
      : `The ${maxTracks}-track maximum creates the boundary before ${boundaryCandidate.row.projectPath}.`
    : `The selected release ends after ${selected.included.at(-1)?.row.projectPath ?? selected.albumSlug}.`;
  return { albumSlug: selected.albumSlug, included: selected.included, boundary };
}

async function loadReleaseControls(vaultRoot: string, song: CatalogIndexSongRecord): Promise<ReleaseControls> {
  const releasePath = normalizeArtifactPath(song.releaseContext.type === "album-track" ? song.releaseContext.releaseContainerRelativePath : "");
  const migrationManifest = await readFileState(vaultRoot, `${releasePath}/migration-manifest.md`);
  const readme = await readFileState(vaultRoot, `${releasePath}/README.md`);
  const tracklist = await readFileState(vaultRoot, `${releasePath}/tracklist.md`);
  const albumProjectGuard = await readFileState(vaultRoot, `${releasePath}/project.md`);
  const releasePackageGuard = await readFileState(vaultRoot, `${releasePath}/album-release-package.md`);
  const classification = classifyMigrationManifest(Buffer.from(migrationManifest.contentBase64, "base64").toString("utf8"));
  if (classification.state === "conflicting" || classification.state === "malformed") {
    throw new Error(classification.reason ?? `migration-manifest.md is ${classification.state}.`);
  }
  const manifestEntries = classification.entries;
  return { releasePath, migrationManifest, readme, tracklist, albumProjectGuard, releasePackageGuard, manifestEntries };
}

async function findLegacySourceCandidates(vaultRoot: string, albumSlug: string, projectSlug: string): Promise<string[]> {
  const directoryPath = `lyrics/albums/${albumSlug}`;
  const nativeDirectory = contractPathToNative(vaultRoot, directoryPath);
  await assertPathHasNoLinkedSegments(nativeDirectory, false);
  const directoryStat = await lstat(nativeDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Legacy release directory is not a normal directory.");
  const entries = await readdir(nativeDirectory, { withFileTypes: true });
  return entries.filter((entry) =>
    entry.isFile()
    && !entry.isSymbolicLink()
    && [".md", ".markdown", ".txt"].includes(path.extname(entry.name).toLowerCase())
    && fileStem(entry.name) === projectSlug
  ).map((entry) => normalizeContractPath(`${directoryPath}/${entry.name}`)).sort();
}

async function readFileState(vaultRoot: string, contractPath: string): Promise<LyricFileState> {
  return fileState(normalizeContractPath(contractPath), await readVaultFile(vaultRoot, contractPath));
}

async function readVaultFile(vaultRoot: string, contractPathInput: string): Promise<Buffer> {
  const contractPath = normalizeContractPath(contractPathInput);
  if (contractPath.includes(":") || contractPath.startsWith("//")) throw new Error("Vault contract path is unsafe.");
  const nativePath = contractPathToNative(vaultRoot, contractPath);
  await assertPathHasNoLinkedSegments(nativePath, false);
  const item = await lstat(nativePath);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`Vault evidence is not a normal file: ${contractPath}`);
  const canonical = await realpath(nativePath);
  const relative = path.relative(vaultRoot, canonical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Vault evidence resolves outside VaultRoot: ${contractPath}`);
  }
  return readFile(nativePath);
}

async function assertDistinctPhysicalFiles(vaultRoot: string, leftPath: string, rightPath: string): Promise<void> {
  if (leftPath === rightPath) throw new Error("Source and managed paths are identical.");
  const leftNative = contractPathToNative(vaultRoot, leftPath);
  const rightNative = contractPathToNative(vaultRoot, rightPath);
  const [leftReal, rightReal, leftStat, rightStat] = await Promise.all([
    realpath(leftNative), realpath(rightNative), lstat(leftNative), lstat(rightNative)
  ]);
  if (samePath(leftReal, rightReal) || (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino)) {
    throw new Error("Source and managed paths resolve to the same physical file.");
  }
}

async function rehashPlanningEvidence(vaultRoot: string, states: LyricFileState[]): Promise<string[]> {
  const failures: string[] = [];
  for (const state of states) {
    try {
      const bytes = await readVaultFile(vaultRoot, state.path);
      if (bytes.byteLength !== state.byteSize || sha256Bytes(bytes) !== state.sha256) failures.push(`${state.path}: size or SHA-256 changed`);
    } catch (error: unknown) {
      failures.push(`${state.path}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function rehashRefreshLineage(lineage: VerifiedRefreshLineage): Promise<void> {
  const refreshBytes = await readFile(lineage.refreshPath);
  if (sha256Bytes(refreshBytes) !== lineage.refreshSha256) throw new Error("Refresh report changed during scouting.");
  for (const artifact of lineage.artifacts) {
    if (sha256Bytes(await readFile(artifact.path)) !== artifact.sha256) throw new Error(`${artifact.name} changed during scouting.`);
  }
}

function planningEvidenceStates(input: LyricSourcePlanningInput): LyricFileState[] {
  const states: LyricFileState[] = [];
  for (const project of input.projects) {
    if (project.source) states.push(project.source);
    if (project.managed) states.push(project.managed);
    if (project.controlFile) states.push({
      path: project.controlFile.path,
      byteSize: project.controlFile.currentByteSize,
      sha256: project.controlFile.currentSha256,
      contentBase64: project.controlFile.currentContentBase64
    });
  }
  for (const control of input.albumControlFiles) states.push({
    path: control.path,
    byteSize: control.currentByteSize,
    sha256: control.currentSha256,
    contentBase64: control.currentContentBase64
  });
  states.push(...input.guardFiles);
  return [...new Map(states.map((state) => [state.path, state])).values()].sort((left, right) => left.path.localeCompare(right.path));
}

function baseReport(
  lineage: VerifiedRefreshLineage,
  version: string,
  planningInputPath: string,
  baselineCounts: LyricSourceBatchScoutReport["baselineCounts"],
  inspectedReleaseContainers: LyricSourceBatchScoutReport["inspectedReleaseContainers"],
  candidates: CandidateInternal[] = []
): LyricSourceBatchScoutReport {
  return {
    contract: "lyric-source-batch-scout-report.v1",
    generatedAt: lineage.refresh.generatedAt,
    specialist: { id: "lyric-source-batch-scout", version },
    authority: "OBSERVE",
    vaultRead: true,
    vaultMutation: "none",
    refreshReport: { path: lineage.refreshPath, byteSize: lineage.refreshBytes.byteLength, sha256: lineage.refreshSha256 },
    refreshRunId: lineage.refresh.runId,
    baselineCounts,
    expectedCounts: null,
    perProjectFindingRemovals: [],
    inspectedReleaseContainers,
    candidateProjects: candidates.map((candidate) => candidate.row).sort(compareRows),
    excludedProjects: candidates.filter((candidate) => candidate.row.eligibilityState === "excluded").map((candidate) => ({
      projectPath: candidate.row.projectPath,
      reason: candidate.row.exclusionReason ?? "Excluded."
    })),
    selectedReleaseContainer: null,
    selectedIncludedProjects: [],
    naturalBatchBoundary: null,
    expectedOperationCount: 0,
    planningInputPath,
    planningInputSha256: null,
    evidenceRehashStatus: "not-run",
    refusal: null,
    safety: { applyEnabled: false, approvalCreated: false, applyScriptCreated: false, vaultMutation: "none" }
  };
}

function refusalResult(
  lineage: VerifiedRefreshLineage,
  version: string,
  planningInputPath: string,
  code: string,
  message: string,
  details: string[],
  candidates: CandidateInternal[] = []
): LyricSourceBatchScoutResult {
  const baseline = baselineFromRefresh(lineage.refresh);
  const report = baseReport(lineage, version, planningInputPath, baseline, summarizeReleases(candidates, new Set()), candidates);
  report.planningInputPath = null;
  report.refusal = refusal(code, message, details);
  return { report, planningInput: null, planningInputBytes: null };
}

function refusal(code: string, message: string, details: string[] = []): SpecialistRefusal {
  return {
    contract: "specialist-refusal.v1",
    code,
    message,
    specialistId: specialistId("lyric-source-batch-scout"),
    authorityMode: "OBSERVE",
    details
  };
}

function summarizeCandidateRefusalDetails(candidates: CandidateInternal[]): string[] {
  return [...groupBy(candidates, (candidate) => candidate.row.albumSlug).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 10)
    .map(([albumSlug, rows]) => {
      const eligibleEvidenceCount = rows.filter((candidate) => candidate.row.eligibilityState === "eligible").length;
      const reasons = new Map<string, number>();
      for (const candidate of rows) {
        if (candidate.row.eligibilityState !== "excluded") continue;
        const reason = candidate.row.exclusionReason ?? "Excluded without a reason.";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      const leading = [...reasons.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
      const reason = leading?.[0] ?? "Eligible evidence does not form a safe two-to-four-track batch.";
      const reasonCount = leading?.[1] ?? eligibleEvidenceCount;
      return `release=${albumSlug}; eligibleEvidence=${eligibleEvidenceCount}; leadingReason=${reason}; count=${reasonCount}`.slice(0, 500);
    });
}

function baselineFromRefresh(refresh: ReadOnlyRefreshWorkflowSummary): LyricSourceBatchScoutReport["baselineCounts"] {
  return {
    catalogFindings: refresh.counts.catalogFindings,
    assetFindings: refresh.counts.assetFindings,
    routedFindings: Object.fromEntries(refresh.findingRoutes.map((item) => [item.route, item.count]))
  };
}

function summarizeReleases(candidates: CandidateInternal[], exclusions: Set<string>): LyricSourceBatchScoutReport["inspectedReleaseContainers"] {
  return [...groupBy(candidates, (candidate) => candidate.row.albumSlug).entries()].map(([albumSlug, rows]) => {
    const ordered = [...rows].sort(compareCandidate);
    let prefix = 0;
    for (const row of ordered) {
      if (row.row.eligibilityState !== "eligible") break;
      const previous = ordered[prefix - 1];
      if (previous?.trackNumber !== null && prefix > 0 && row.trackNumber !== (previous?.trackNumber ?? 0) + 1) break;
      prefix += 1;
    }
    return {
      albumSlug,
      projectCount: rows.length,
      eligiblePrefixCount: prefix,
      excludedCount: rows.filter((row) => row.row.eligibilityState === "excluded").length,
      defaultExcluded: exclusions.has(albumSlug)
    };
  }).sort((left, right) => left.albumSlug.localeCompare(right.albumSlug));
}

function selectionExclusions(candidates: CandidateInternal[], selected: NonNullable<ReturnType<typeof selectBatch>>): Array<{ projectPath: string; reason: string }> {
  const included = new Set(selected.included.map((candidate) => candidate.row.projectPath));
  return candidates.filter((candidate) => !included.has(candidate.row.projectPath)).map((candidate) => ({
    projectPath: candidate.row.projectPath,
    reason: candidate.row.exclusionReason
      ?? (candidate.row.albumSlug === selected.albumSlug ? "Outside the selected deterministic batch boundary." : "Another release ranked higher deterministically.")
  })).sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

function manifestMappingState(entries: unknown[], projectPath: string, sourcePath: string | null, managedPath: string | null): LyricSourceBatchScoutCandidate["currentManifestMappingState"] {
  if (!Array.isArray(entries)) return "invalid";
  const matches = entries.filter((entry) => isRecord(entry) && normalizeLoosePath(String(entry.project_path ?? "")) === projectPath);
  if (matches.length === 0) return "none";
  if (matches.length > 1) return "duplicate";
  const entry = matches[0];
  if (!isRecord(entry) || !sourcePath || !managedPath) return "conflicting";
  return normalizeLoosePath(String(entry.source_path ?? "")) === sourcePath
    && normalizeLoosePath(String(entry.managed_lyric_copy ?? "")) === managedPath
    ? "matching"
    : "conflicting";
}

function designationState(content: string): LyricSourceBatchScoutCandidate["currentDesignationState"] {
  const hasContract = /contract:\s*lyric-source-designation\.v1/i.test(content);
  const human = /designation_state:\s*human-approved/i.test(content);
  if (hasContract && human) return "human-approved";
  if (hasContract) return "unresolved-contract";
  if (/canonical_lyric_source:\s*\S+/i.test(content)) return "conflicting";
  return "none";
}

function controlFileInput(current: LyricFileState, proposedContent: string): LyricControlFileInput {
  return {
    path: current.path,
    currentByteSize: current.byteSize,
    currentSha256: current.sha256,
    currentContentBase64: current.contentBase64,
    proposedContent
  };
}

function toControlTrack(candidate: CandidateInternal): ControlDocumentTrack {
  if (!candidate.source || !candidate.managed || candidate.trackNumber === null) throw new Error("Candidate does not have complete control-document evidence.");
  return {
    projectPath: candidate.row.projectPath,
    projectSlug: candidate.projectSlug,
    trackNumber: candidate.trackNumber,
    sourcePath: candidate.source.path,
    managedPath: candidate.managed.path,
    sourceByteSize: candidate.source.byteSize,
    managedByteSize: candidate.managed.byteSize,
    sourceSha256: candidate.source.sha256,
    managedSha256: candidate.managed.sha256
  };
}

function fileState(contractPath: string, bytes: Buffer): LyricFileState {
  return { path: normalizeContractPath(contractPath), byteSize: bytes.byteLength, sha256: sha256Bytes(bytes), contentBase64: bytes.toString("base64") };
}

function validateFileState(state: LyricFileState): void {
  validateBase64(state.contentBase64, state.byteSize, state.sha256, state.path);
  if (normalizeContractPath(state.path) !== state.path) throw new Error(`Noncanonical planning path: ${state.path}`);
}

function validateBase64(base64: string, byteSize: number, sha256: string, label: string): void {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.byteLength !== byteSize || sha256Bytes(bytes) !== sha256) {
    throw new Error(`Planning evidence identity is invalid: ${label}`);
  }
}

function excludeCandidate(candidate: CandidateInternal, reason: string): void {
  candidate.row.eligibilityState = "excluded";
  candidate.row.exclusionReason = candidate.row.exclusionReason ?? reason;
}

function excludeDuplicateSources(candidates: CandidateInternal[]): void {
  const grouped = groupBy(candidates.filter((candidate) => candidate.row.legacySourcePath !== null), (candidate) => candidate.row.legacySourcePath ?? "");
  for (const rows of grouped.values()) if (rows.length > 1) rows.forEach((candidate) => excludeCandidate(candidate, "Legacy source path maps to more than one project."));
}

function groupCatalogFindings(findings: AuditFinding[]): Map<string, AuditFinding[]> {
  return groupBy(findings, (finding) => normalizeLoosePath(finding.sourcePath));
}

function groupRoutes(routes: RoutedAssetFinding[]): Map<string, RoutedAssetFinding[]> {
  return groupBy(routes, (route) => normalizeLoosePath(route.projectPath));
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(key(value), [...(grouped.get(key(value)) ?? []), value]);
  return grouped;
}

function isManagedLyricCandidate(asset: AssetRecord): boolean {
  return asset.category === "lyrics" && [".md", ".markdown", ".txt"].includes(asset.extension.toLowerCase());
}

function albumSlugForSong(song: CatalogIndexSongRecord): string {
  if (song.releaseContext.type !== "album-track") throw new Error("Scout supports album tracks only.");
  return path.posix.basename(normalizeArtifactPath(song.releaseContext.releaseContainerRelativePath)).toLowerCase();
}

function parseTrackNumber(slug: string): number | null {
  const match = slug.match(/^(\d{1,3})-/);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function fileStem(value: string): string {
  const base = path.posix.basename(normalizeLoosePath(value));
  return base.slice(0, base.length - path.posix.extname(base).length);
}

function normalizeArtifactPath(value: string): string {
  return normalizeContractPath(value.replace(/\\/g, "/"));
}

function normalizeLoosePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function artifactSha(lineage: VerifiedRefreshLineage, name: string): string {
  const artifact = lineage.artifacts.find((candidate) => candidate.name === name);
  if (!artifact) throw new Error(`Missing lineage artifact: ${name}`);
  return artifact.sha256;
}

function numericRecord(value: object): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error(`${label} is not valid JSON.`); }
}

function declaresContract(value: unknown, contract: string): boolean {
  return isRecord(value) && (value.contract === contract || value.schemaVersion === contract);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate].sort();
}

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "").localeCompare(value) <= 0);
}

function compareCandidate(left: CandidateInternal, right: CandidateInternal): number {
  return (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || left.row.projectPath.localeCompare(right.row.projectPath);
}

function compareRows(left: LyricSourceBatchScoutCandidate, right: LyricSourceBatchScoutCandidate): number {
  return left.albumSlug.localeCompare(right.albumSlug)
    || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || left.projectPath.localeCompare(right.projectPath);
}

function assertTrackLimits(minTracks: number, maxTracks: number): void {
  if (!Number.isInteger(minTracks) || !Number.isInteger(maxTracks) || minTracks < 2 || maxTracks > 4 || minTracks > maxTracks) {
    throw new Error("Scout track limits must satisfy 2 <= minTracks <= maxTracks <= 4.");
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
