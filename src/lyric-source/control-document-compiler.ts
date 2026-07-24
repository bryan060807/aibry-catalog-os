import { parseDocument, stringify } from "yaml";

export type ControlDocumentTrack = {
  projectPath: string;
  projectSlug: string;
  trackNumber: number;
  sourcePath: string;
  managedPath: string;
  sourceByteSize: number;
  managedByteSize: number;
  sourceSha256: string;
  managedSha256: string;
};

export type CompiledAlbumControlDocuments = {
  migrationManifest: string;
  readme: string;
  tracklist: string;
};

export type MigrationManifestClassification = {
  state: "current-contract" | "legacy-no-contract" | "conflicting" | "malformed";
  metadata: Record<string, unknown>;
  entries: unknown[];
  body: string;
  reason: string | null;
};

export type LegacyLyricMappingEvidenceCategory =
  | "contract-marker"
  | "yaml-mapping-field"
  | "generated-designation-section"
  | "explicit-mapping-table"
  | "explicit-path-arrow";

export type PreservationOptions = {
  targetSectionHeadings: string[];
  allowRecognizedStaleLyricLines?: boolean;
  allowRootPromotionLines?: boolean;
};

const PROJECT_STATUS_HEADING = "Resolved Provenance / Remaining Decisions";
const MANIFEST_DESIGNATIONS_HEADING = "Verified Lyric-Source Designations";
const MANIFEST_BOUNDARY_HEADING = "Lyric-Source Verification Boundary";
const ALBUM_STATUS_HEADING = "Lyric-Source Designation Status";

const STALE_PHRASES = [
  /^Lyric source unresolved\.?$/i,
  /^The canonical lyric source is unresolved\.?$/i,
  /^Canonical lyric source is unresolved\.?$/i,
  /^Verify whether the local lyric file or legacy lyric source is canonical\.?$/i,
  /^Verify the canonical lyric source\.?$/i,
  /^Confirm canonical lyrics\.?$/i,
  /^Verify lyric copy against canonical source\.?$/i,
  /^Confirm lyric copy against canonical source\.?$/i,
  /^Verify release-package lyric copy against canonical source\.?$/i
];

const PROJECT_METADATA_KEYS = [
  "source_path",
  "canonical_lyric_source",
  "managed_lyric_copy",
  "source_sha256",
  "managed_sha256",
  "verification_method",
  "verification_state",
  "designation_state"
] as const;

export function classifyMigrationManifest(currentInput: string): MigrationManifestClassification {
  const current = normalizeText(currentInput);
  if (current.charCodeAt(0) === 0xfeff) {
    return manifestClassification("malformed", {}, [], current, "migration-manifest.md must not contain a UTF-8 BOM.");
  }
  if (!current.startsWith("---")) {
    const mappingEvidence = detectLegacyLyricMappingEvidence(current);
    if (mappingEvidence.length > 0) {
      return manifestClassification(
        "conflicting",
        {},
        [],
        current,
        `Legacy manifest contains mapping-like lyric-source fields without a parseable current contract. Evidence: ${mappingEvidence.join(", ")}.`
      );
    }
    return manifestClassification("legacy-no-contract", {}, [], current, null);
  }
  let parsed: ReturnType<typeof splitFrontMatter>;
  try {
    parsed = splitFrontMatter(current, "migration-manifest.md");
  } catch (error: unknown) {
    return manifestClassification("malformed", {}, [], current, errorMessage(error));
  }
  if (parsed.frontMatter === null) {
    return manifestClassification("malformed", {}, [], current, "migration-manifest.md begins with an invalid front-matter delimiter.");
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = parseFrontMatter(parsed.frontMatter, "migration-manifest.md");
  } catch (error: unknown) {
    return manifestClassification("malformed", {}, [], parsed.body, errorMessage(error));
  }
  if (metadata.contract !== "lyric-source-migration-manifest.v1") {
    return manifestClassification("conflicting", metadata, [], parsed.body, "migration-manifest.md front matter does not declare lyric-source-migration-manifest.v1.");
  }
  if (!Array.isArray(metadata.entries) || !metadata.entries.every(isRecord)) {
    return manifestClassification("malformed", metadata, [], parsed.body, "migration-manifest.md entries must be an array of mappings.");
  }
  return manifestClassification("current-contract", metadata, metadata.entries, parsed.body, null);
}

export function compileProjectControlDocument(
  currentInput: string,
  track: ControlDocumentTrack,
  migrationManifestPath: string
): string {
  const current = normalizeText(currentInput);
  if (current.charCodeAt(0) === 0xfeff) throw new Error("project.md must not contain a UTF-8 BOM.");
  const parsed = splitFrontMatter(current, "project.md");
  const metadata = parsed.frontMatter ? parseFrontMatter(parsed.frontMatter, "project.md") : {};
  assertCompatibleProjectDesignation(metadata, track, migrationManifestPath);
  assertCanonicalSourceDeclarations(metadata, parsed.body, track.sourcePath);

  const removed = removeRecognizedProjectLines(parsed.body);
  const existingStatusCount = countNamedSections(removed.body, PROJECT_STATUS_HEADING);
  if (removed.staleLyricLineCount === 0 && existingStatusCount === 0) {
    throw new Error("project.md does not contain a supported lyric-source edit location.");
  }
  const resolvedSection = [
    "Lyric provenance is resolved by byte-identical legacy and managed evidence.",
    "",
    `- Canonical source: \`${track.sourcePath}\``,
    `- Managed copy: \`${track.managedPath}\``,
    `- Verified SHA-256: \`${track.sourceSha256}\``,
    "- Production, mix, mastering, sequencing, artwork, licensing, and release-readiness decisions remain governed by their preserved project sections."
  ].join("\n");
  const nextBody = upsertNamedSection(removed.body, PROJECT_STATUS_HEADING, resolvedSection);
  if (containsStaleLyricSourceLanguage(nextBody)) throw new Error("Compiled project.md retains stale lyric-source uncertainty.");

  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    provenance: {
      contract: "lyric-source-designation.v1",
      status: "verified",
      migration_record: migrationManifestPath
    },
    source_path: track.sourcePath,
    canonical_lyric_source: track.sourcePath,
    managed_lyric_copy: track.managedPath,
    source_sha256: track.sourceSha256,
    managed_sha256: track.managedSha256,
    verification_method: "sha256-byte-match",
    verification_state: "verified",
    designation_state: "human-approved"
  };
  assertMetadataPreserved(metadata, nextMetadata, new Set(["provenance", ...PROJECT_METADATA_KEYS]));
  const compiled = `---\n${stringify(nextMetadata, { lineWidth: 0 }).trimEnd()}\n---\n${ensureLf(nextBody)}`;
  assertNonTargetContentPreserved(current, compiled, {
    targetSectionHeadings: [PROJECT_STATUS_HEADING],
    allowRecognizedStaleLyricLines: true,
    allowRootPromotionLines: true
  });
  return compiled;
}

export function compileAlbumControlDocuments(input: {
  albumSlug: string;
  generatedAt: string;
  selectedTracks: ControlDocumentTrack[];
  unresolvedTracks: Array<{ projectPath: string; trackNumber: number | null; reason: string }>;
  currentMigrationManifest: string;
  currentReadme: string;
  currentTracklist: string;
}): CompiledAlbumControlDocuments {
  const selected = [...input.selectedTracks].sort(compareTracks);
  const unresolved = [...input.unresolvedTracks].sort((left, right) =>
    (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || left.projectPath.localeCompare(right.projectPath)
  );
  const classification = classifyMigrationManifest(input.currentMigrationManifest);
  if (classification.state === "malformed" || classification.state === "conflicting") {
    throw new Error(classification.reason ?? `migration-manifest.md is ${classification.state}.`);
  }
  const selectedEntries = selected.map((track) => ({
    project_path: track.projectPath,
    source_path: track.sourcePath,
    managed_lyric_copy: track.managedPath,
    source_size_bytes: track.sourceByteSize,
    managed_size_bytes: track.managedByteSize,
    source_sha256: track.sourceSha256,
    managed_sha256: track.managedSha256,
    verification_method: "sha256-byte-match",
    verification_state: "verified",
    designation_state: "human-approved",
    verified_at: input.generatedAt
  }));
  const selectedPaths = new Set(selected.map((track) => track.projectPath));
  const preservedEntries = classification.entries.filter((entry) =>
    isRecord(entry) && (typeof entry.project_path !== "string" || !selectedPaths.has(normalizeLoosePath(entry.project_path)))
  );
  const entries = [...preservedEntries, ...selectedEntries].sort(compareManifestEntries);
  const nextManifestMetadata: Record<string, unknown> = {
    ...classification.metadata,
    contract: "lyric-source-migration-manifest.v1",
    entries
  };
  assertMetadataPreserved(classification.metadata, nextManifestMetadata, new Set(["contract", "entries"]));

  const selectedLines = selected.length > 0
    ? selected.map((track) => `- ${track.projectPath}: prospectively designated from \`${track.sourcePath}\``)
    : ["- None."];
  const unresolvedLines = unresolved.length > 0
    ? unresolved.map((track) => `- ${track.projectPath}: unresolved — ${track.reason}`)
    : ["- None."];
  let manifestBody = upsertNamedSection(
    classification.body,
    MANIFEST_DESIGNATIONS_HEADING,
    [...selectedLines, "", "Remaining unresolved tracks:", ...unresolvedLines].join("\n")
  );
  manifestBody = upsertNamedSection(
    manifestBody,
    MANIFEST_BOUNDARY_HEADING,
    "These mappings are prospective until the exact proposal SHA-256 receives human authorization and guarded APPLY completes. Existing migration history outside these bounded sections is unchanged."
  );
  const migrationManifest = `---\n${stringify(nextManifestMetadata, { lineWidth: 0 }).trimEnd()}\n---\n${ensureLf(manifestBody)}`;
  assertNonTargetContentPreserved(input.currentMigrationManifest, migrationManifest, {
    targetSectionHeadings: [MANIFEST_DESIGNATIONS_HEADING, MANIFEST_BOUNDARY_HEADING]
  });

  const statusBody = ["Prospective designations:", ...selectedLines, "", "Remaining unresolved tracks:", ...unresolvedLines].join("\n");
  const readme = ensureLf(upsertNamedSection(normalizeDocument(input.currentReadme, "README.md"), ALBUM_STATUS_HEADING, statusBody));
  const tracklist = ensureLf(upsertNamedSection(normalizeDocument(input.currentTracklist, "tracklist.md"), ALBUM_STATUS_HEADING, statusBody));
  assertNonTargetContentPreserved(input.currentReadme, readme, { targetSectionHeadings: [ALBUM_STATUS_HEADING] });
  assertNonTargetContentPreserved(input.currentTracklist, tracklist, { targetSectionHeadings: [ALBUM_STATUS_HEADING] });
  return { migrationManifest, readme, tracklist };
}

export function assertNonTargetContentPreserved(currentInput: string, compiledInput: string, options: PreservationOptions): void {
  const current = normalizeText(currentInput);
  const compiled = normalizeText(compiledInput);
  const currentBody = splitFrontMatterForPreservation(current).body;
  const compiledBody = splitFrontMatterForPreservation(compiled).body;
  const currentLines = preservationLines(currentBody, options);
  const compiledLines = preservationLines(compiledBody, options);
  if (currentLines.length !== compiledLines.length || currentLines.some((line, index) => line !== compiledLines[index])) {
    throw new Error("Control-document preservation check failed: unrelated content changed or disappeared.");
  }
}

export function containsStaleLyricSourceLanguage(content: string): boolean {
  return normalizeText(content).split("\n").some((line) => isRecognizedStaleLyricLine(line) || isRootPromotionLine(line));
}

export function detectLegacyLyricMappingEvidence(contentInput: string): LegacyLyricMappingEvidenceCategory[] {
  const content = normalizeText(contentInput);
  const evidence = new Set<LegacyLyricMappingEvidenceCategory>();
  if (/lyric-source-(?:migration-manifest|designation)\.v1/i.test(content)) evidence.add("contract-marker");
  if (/^\s*(?:project_path|source_path|managed_lyric_copy|source_sha256|managed_sha256|designation_state)\s*:/mi.test(content)) {
    evidence.add("yaml-mapping-field");
  }
  if (/^##\s+(?:Verified Lyric-Source Designations|Lyric-Source Verification Boundary)\s*$/mi.test(content)) {
    evidence.add("generated-designation-section");
  }
  if (containsExplicitMappingTable(content)) evidence.add("explicit-mapping-table");
  if (containsExplicitLyricPathArrow(content)) evidence.add("explicit-path-arrow");
  return [...evidence];
}

function manifestClassification(
  state: MigrationManifestClassification["state"],
  metadata: Record<string, unknown>,
  entries: unknown[],
  body: string,
  reason: string | null
): MigrationManifestClassification {
  return { state, metadata, entries, body, reason };
}

function containsExplicitMappingTable(content: string): boolean {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = parseMarkdownTableCells(lines[index] ?? "");
    const separator = parseMarkdownTableCells(lines[index + 1] ?? "");
    if (headers !== null && separator !== null && isMarkdownTableSeparator(separator) && hasExplicitMappingHeaders(headers)) return true;
  }
  return lines.some((line) => line.includes("|") && containsProjectSourceManagedPaths(line));
}

function parseMarkdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.startsWith("|")) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function hasExplicitMappingHeaders(headers: string[]): boolean {
  const normalized = headers.map((header) => header.toLowerCase().replace(/[`_*]/g, "").replace(/\s+/g, " ").trim());
  const hasProject = normalized.some((header) => /^(?:project|track)(?: path)?$/.test(header));
  const hasSource = normalized.some((header) => /^(?:(?:canonical|lyric) )?source(?: path)?$/.test(header));
  const hasManaged = normalized.some((header) => /^(?:managed(?: lyric)? copy|managed path|destination(?: path)?)$/.test(header));
  return hasProject && hasSource && hasManaged;
}

function containsProjectSourceManagedPaths(line: string): boolean {
  const paths = extractPathCandidates(line);
  const projectPaths = paths.filter(isProjectPath);
  for (const projectPath of projectPaths) {
    const projectPrefix = `${projectPath.replace(/\/$/, "")}/`;
    const managedPaths = paths.filter((candidate) => candidate.startsWith(projectPrefix) && isLyricPath(candidate));
    const sourcePaths = paths.filter((candidate) => !candidate.startsWith(projectPrefix) && isLyricPath(candidate));
    if (managedPaths.some((managed) => sourcePaths.some((source) => source !== managed))) return true;
  }
  return false;
}

function containsExplicitLyricPathArrow(content: string): boolean {
  return content.split("\n").some((line) => {
    const parts = line.split(/\s*(?:->|=>|→)\s*/);
    if (parts.length < 2) return false;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const left = extractPathCandidates(parts[index] ?? "").filter(isLyricPath);
      const right = extractPathCandidates(parts[index + 1] ?? "").filter(isLyricPath);
      if (left.some((source) => right.some((managed) => source !== managed))) return true;
    }
    return false;
  });
}

function extractPathCandidates(value: string): string[] {
  const normalized = value.replace(/\\/g, "/").replace(/`/g, "");
  const matches = normalized.match(/(?:\/?[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)?/g) ?? [];
  return [...new Set(matches.map((candidate) => candidate.replace(/^\/+/, "").replace(/\/{2,}/g, "/")))];
}

function isProjectPath(value: string): boolean {
  return /^(?:project-memory\/)?music\/albums\/[^/]+\/[^/]+\/?$/i.test(value)
    || /^project-memory\/music\/albums\/[^/]+\/[^/]+(?:\/.*)?$/i.test(value);
}

function isLyricPath(value: string): boolean {
  const normalized = value.replace(/^\/+/, "");
  return /^lyrics(?:\/|$)/i.test(normalized) || /\/lyrics(?:\/|$)/i.test(normalized);
}

function assertCompatibleProjectDesignation(metadata: Record<string, unknown>, track: ControlDocumentTrack, migrationManifestPath: string): void {
  const provenance = metadata.provenance;
  const hasTargetFields = PROJECT_METADATA_KEYS.some((key) => Object.hasOwn(metadata, key));
  if (provenance === undefined && !hasTargetFields) return;
  if (!isRecord(provenance) || provenance.contract !== "lyric-source-designation.v1") {
    throw new Error("project.md contains an unfamiliar structured lyric-source designation.");
  }
  const expected: Record<string, unknown> = {
    source_path: track.sourcePath,
    canonical_lyric_source: track.sourcePath,
    managed_lyric_copy: track.managedPath,
    source_sha256: track.sourceSha256,
    managed_sha256: track.managedSha256,
    verification_method: "sha256-byte-match",
    verification_state: "verified",
    designation_state: "human-approved"
  };
  if (provenance.migration_record !== migrationManifestPath || provenance.status !== "verified") {
    throw new Error("project.md contains a contradictory structured lyric-source designation.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) throw new Error("project.md contains a contradictory structured lyric-source designation.");
  }
}

function assertCanonicalSourceDeclarations(metadata: Record<string, unknown>, body: string, expectedSource: string): void {
  const declared = new Set<string>();
  for (const key of ["source_path", "canonical_lyric_source"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) declared.add(normalizeLoosePath(value.trim()));
  }
  for (const line of normalizeText(body).split("\n")) {
    const match = line.match(/^\s*[-*]?\s*Canonical (?:lyric )?source:\s*(?:`([^`]+)`|(\S+))\s*$/i);
    const value = match?.[1] ?? match?.[2];
    if (value) declared.add(normalizeLoosePath(value));
  }
  if (declared.size > 1 || (declared.size === 1 && !declared.has(expectedSource))) {
    throw new Error("project.md declares multiple or contradictory canonical lyric sources.");
  }
}

function removeRecognizedProjectLines(body: string): { body: string; staleLyricLineCount: number; rootPromotionLineCount: number } {
  let staleLyricLineCount = 0;
  let rootPromotionLineCount = 0;
  const lines = normalizeText(body).split("\n").filter((line) => {
    if (isRecognizedStaleLyricLine(line)) {
      staleLyricLineCount += 1;
      return false;
    }
    if (isRootPromotionLine(line)) {
      rootPromotionLineCount += 1;
      return false;
    }
    return true;
  });
  return { body: lines.join("\n"), staleLyricLineCount, rootPromotionLineCount };
}

function isRecognizedStaleLyricLine(line: string): boolean {
  const normalized = line.trim().replace(/^(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, "").trim();
  return STALE_PHRASES.some((pattern) => pattern.test(normalized));
}

function isRootPromotionLine(line: string): boolean {
  const normalized = line.trim().replace(/^(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, "").trim();
  return /^Promote this draft to the track root as project\.md\.?$/i.test(normalized);
}

function upsertNamedSection(bodyInput: string, heading: string, sectionBody: string): string {
  const body = normalizeText(bodyInput);
  const ranges = namedSectionRanges(body, heading);
  if (ranges.length > 1) throw new Error(`Document contains duplicate generated section: ${heading}.`);
  const section = `## ${heading}\n\n${sectionBody.trimEnd()}\n`;
  const range = ranges[0];
  if (!range) {
    if (!body) return section;
    const separator = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return `${body}${separator}${section}`;
  }
  const suffix = body.slice(range.end);
  return `${body.slice(0, range.start)}${section}${suffix ? `\n${suffix}` : ""}`;
}

function namedSectionRanges(body: string, heading: string): Array<{ start: number; end: number }> {
  const sections = markdownSections(body);
  return sections.filter((section) => section.heading === heading).map(({ start, end }) => ({ start, end }));
}

function countNamedSections(body: string, heading: string): number {
  return namedSectionRanges(body, heading).length;
}

function preservationLines(body: string, options: PreservationOptions): string[] {
  const targets = new Set(options.targetSectionHeadings);
  const output: string[] = [];
  let skipTarget = false;
  for (const line of normalizeText(body).split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1] ?? null;
    if (heading !== null) {
      skipTarget = targets.has(heading);
      if (skipTarget) continue;
    }
    if (skipTarget) continue;
    if (options.allowRecognizedStaleLyricLines && isRecognizedStaleLyricLine(line)) continue;
    if (options.allowRootPromotionLines && isRootPromotionLine(line)) continue;
    if (line.trim().length > 0) output.push(line);
  }
  return output;
}

function splitFrontMatterForPreservation(content: string): { body: string } {
  if (!content.startsWith("---")) return { body: content };
  try {
    return { body: splitFrontMatter(content, "control document").body };
  } catch {
    return { body: content };
  }
}

function splitFrontMatter(content: string, label: string): { frontMatter: string | null; body: string } {
  if (!content.startsWith("---")) return { frontMatter: null, body: content };
  if (!content.startsWith("---\n")) throw new Error(`${label} front matter is malformed.`);
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error(`${label} front matter is malformed.`);
  return { frontMatter: match[1] ?? "", body: content.slice(match[0].length) };
}

function parseFrontMatter(content: string, label: string): Record<string, unknown> {
  const document = parseDocument(content);
  const value = document.toJSON() as unknown;
  if (document.errors.length > 0 || !isRecord(value)) throw new Error(`${label} front matter must be a YAML mapping.`);
  return value;
}

function assertMetadataPreserved(current: Record<string, unknown>, next: Record<string, unknown>, permittedKeys: Set<string>): void {
  for (const [key, value] of Object.entries(current)) {
    if (!permittedKeys.has(key) && JSON.stringify(next[key]) !== JSON.stringify(value)) {
      throw new Error(`Control-document preservation check failed for front-matter key: ${key}.`);
    }
  }
}

function markdownSections(body: string): Array<{ heading: string; start: number; end: number }> {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => ({
    heading: match[1] ?? "",
    start: match.index ?? 0,
    end: matches[index + 1]?.index ?? body.length
  }));
}

function compareManifestEntries(left: unknown, right: unknown): number {
  const leftPath = isRecord(left) && typeof left.project_path === "string" ? normalizeLoosePath(left.project_path) : JSON.stringify(left);
  const rightPath = isRecord(right) && typeof right.project_path === "string" ? normalizeLoosePath(right.project_path) : JSON.stringify(right);
  return leftPath.localeCompare(rightPath);
}

function normalizeDocument(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (normalized.charCodeAt(0) === 0xfeff) throw new Error(`${label} must not contain a UTF-8 BOM.`);
  return normalized;
}

function normalizeLoosePath(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/"); }
function normalizeText(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function ensureLf(value: string): string { return `${value.replace(/\r\n?/g, "\n").trimEnd()}\n`; }
function compareTracks(left: ControlDocumentTrack, right: ControlDocumentTrack): number { return left.trackNumber - right.trackNumber || left.projectPath.localeCompare(right.projectPath); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
