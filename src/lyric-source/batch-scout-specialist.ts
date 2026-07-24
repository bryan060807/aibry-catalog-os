import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "../kernel/canonical-json.js";
import {
  DEFAULT_SCOUT_EXCLUDED_RELEASES,
  scoutLyricSourceBatch as scoutCore,
  serializePlanningInput,
  validatePlanningInput,
  verifyRefreshArtifactLineage,
  type LyricSourceBatchScoutOptions,
  type LyricSourceBatchScoutResult
} from "./batch-scout-specialist-core.js";
import type { LyricSourceBatchScoutCandidate } from "./contracts.js";

export {
  DEFAULT_SCOUT_EXCLUDED_RELEASES,
  serializePlanningInput,
  validatePlanningInput,
  verifyRefreshArtifactLineage
};
export type {
  LyricSourceBatchScoutOptions,
  LyricSourceBatchScoutResult
};

/**
 * Runs the proven scout unchanged first. When the only reason a release cannot
 * form a batch is a contiguous, already-human-approved leading track prefix,
 * reruns against a reports-local catalog-index view with that completed prefix
 * omitted. The Music Vault and original refresh lineage remain read-only.
 */
export async function scoutLyricSourceBatch(options: LyricSourceBatchScoutOptions): Promise<LyricSourceBatchScoutResult> {
  const first = await scoutCore(options);
  if (!first.report.refusal || first.report.refusal.code !== "no-safe-batch") return first;

  const completedPrefixPaths = findCompletedReleasePrefixes(first.report.candidateProjects, options.minTracks ?? 2);
  if (completedPrefixPaths.size === 0) return first;

  const shadowDirectory = path.join(path.dirname(path.resolve(options.planningInputPath)), ".completed-prefix-normalized");
  await rm(shadowDirectory, { recursive: true, force: true });
  await mkdir(shadowDirectory, { recursive: true });
  const shadowRefreshPath = await materializeCompletedPrefixView(
    options.refreshReportPath,
    shadowDirectory,
    completedPrefixPaths
  );

  const second = await scoutCore({ ...options, refreshReportPath: shadowRefreshPath });
  if (!second.report.refusal) {
    second.report.naturalBatchBoundary = [
      `Verified completed human-approved prefix omitted from batch selection: ${[...completedPrefixPaths].sort().join(", ")}.`,
      second.report.naturalBatchBoundary
    ].filter(Boolean).join(" ");
  }
  return second;
}

function findCompletedReleasePrefixes(candidates: LyricSourceBatchScoutCandidate[], minTracks: number): Set<string> {
  const grouped = new Map<string, LyricSourceBatchScoutCandidate[]>();
  for (const candidate of candidates) {
    grouped.set(candidate.albumSlug, [...(grouped.get(candidate.albumSlug) ?? []), candidate]);
  }
  const omitted = new Set<string>();
  for (const rows of grouped.values()) {
    const ordered = [...rows].sort((left, right) =>
      (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
      || left.projectPath.localeCompare(right.projectPath)
    );
    const prefix: LyricSourceBatchScoutCandidate[] = [];
    for (const candidate of ordered) {
      const previous = prefix.at(-1);
      const contiguous = !previous
        || (previous.trackNumber !== null && candidate.trackNumber === previous.trackNumber + 1);
      if (!contiguous || candidate.currentDesignationState !== "human-approved") break;
      prefix.push(candidate);
    }
    if (prefix.length === 0) continue;
    const remaining = ordered.slice(prefix.length);
    const eligibleRun: LyricSourceBatchScoutCandidate[] = [];
    for (const candidate of remaining) {
      const previous = eligibleRun.at(-1);
      const contiguous = !previous
        || (previous.trackNumber !== null && candidate.trackNumber === previous.trackNumber + 1);
      if (!contiguous || candidate.eligibilityState !== "eligible") break;
      eligibleRun.push(candidate);
    }
    if (eligibleRun.length >= minTracks) prefix.forEach((candidate) => omitted.add(candidate.projectPath));
  }
  return omitted;
}

async function materializeCompletedPrefixView(
  refreshReportInput: string,
  outputDirectory: string,
  omittedProjects: Set<string>
): Promise<string> {
  const refreshPath = path.resolve(refreshReportInput);
  const refresh = parseObject(await readFile(refreshPath, "utf8"), "read-only refresh report");
  const artifacts = requireArray(refresh.artifacts, "refresh artifacts");
  const catalogArtifact = artifacts.find((value) =>
    isRecord(value) && value.name === "catalog-index" && value.role === "output" && typeof value.path === "string"
  );
  if (!isRecord(catalogArtifact) || typeof catalogArtifact.path !== "string") {
    throw new Error("Refresh report lacks one catalog-index output artifact.");
  }

  const catalog = parseObject(await readFile(path.resolve(catalogArtifact.path), "utf8"), "catalog index");
  const songs = requireArray(catalog.songs, "catalog songs");
  const normalizedOmissions = new Set([...omittedProjects].map(normalizeLoosePath));
  catalog.songs = songs.filter((song) => {
    if (!isRecord(song) || typeof song.directoryRelativePath !== "string") return true;
    return !normalizedOmissions.has(normalizeLoosePath(song.directoryRelativePath));
  });

  const shadowCatalogPath = path.join(outputDirectory, "completed-prefix.catalog-index.json");
  const shadowCatalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await writeFile(shadowCatalogPath, shadowCatalogBytes, { encoding: "utf8", flag: "wx" });
  catalogArtifact.path = shadowCatalogPath;
  catalogArtifact.sha256 = sha256Bytes(shadowCatalogBytes);

  const shadowRefreshPath = path.join(outputDirectory, "completed-prefix.read-only-refresh.json");
  await writeFile(shadowRefreshPath, `${JSON.stringify(refresh, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return shadowRefreshPath;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must contain one JSON object.`);
  return parsed;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function normalizeLoosePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
