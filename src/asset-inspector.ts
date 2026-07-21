import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { discoverCatalog } from "./catalog/discover.js";
import type { CatalogDiscovery, ManagedSong } from "./catalog/types.js";

export type AssetCategory = "lyrics" | "audio" | "metadata" | "artwork" | "licensing" | "release-admin" | "other";
export type AssetConfidence = "low" | "medium" | "high";
export type FolderStatus = "present" | "missing" | "empty";

export type AssetRecord = {
  path: string;
  category: AssetCategory;
  candidateRole: string | null;
  confidence: AssetConfidence;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
  evidence: string[];
};

export type AssetInspectionFinding = {
  type: "canonical-lyric-unresolved" | "release-admin-empty" | "provenance-insufficient" | "multiple-audio-variants" | "media-info-audio-evidence";
  severity: "low" | "info";
  status: "observed" | "blocked-insufficient-evidence";
  evidencePaths: string[];
  requiredEvidence: string[];
  summary: string;
};

export type AssetInspection = {
  contract: "asset-inspection.v1";
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "Asset Inspector";
    authorityMode: "OBSERVE";
    operationalStandard: "ASOS v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  projectPath: string;
  inspectedAt: string;
  assets: AssetRecord[];
  folderStatus: {
    lyrics: FolderStatus;
    audio: FolderStatus;
    metadata: FolderStatus;
    artwork: FolderStatus;
    licensing: FolderStatus;
    releaseAdmin: FolderStatus;
  };
  findings: AssetInspectionFinding[];
  warnings: string[];
};

export type AssetInspectionReport = {
  contract: "asset-inspection-report.v1";
  generatedAt: string;
  authority: AssetInspection["authority"];
  source: {
    vaultPath: string;
    discoveredAt: CatalogDiscovery["discoveredAt"];
    projectCount: number;
  };
  inspections: AssetInspection[];
  counts: {
    projects: number;
    assets: number;
    findings: number;
    warnings: number;
  };
};

const ASSET_FOLDERS = ["lyrics", "audio", "metadata", "artwork", "licensing", "release-admin"] as const;
type AssetFolder = typeof ASSET_FOLDERS[number];

export async function inspectCatalogAssets(vaultInput: string): Promise<AssetInspectionReport> {
  const discovery = await discoverCatalog(vaultInput);
  const inspections = await Promise.all(discovery.managedSongs.map((song) => inspectSongAssets(discovery.vaultPath, song)));
  return {
    contract: "asset-inspection-report.v1",
    generatedAt: new Date().toISOString(),
    authority: assetInspectorAuthority(),
    source: {
      vaultPath: discovery.vaultPath,
      discoveredAt: discovery.discoveredAt,
      projectCount: discovery.managedSongs.length
    },
    inspections,
    counts: {
      projects: inspections.length,
      assets: inspections.reduce((total, inspection) => total + inspection.assets.length, 0),
      findings: inspections.reduce((total, inspection) => total + inspection.findings.length, 0),
      warnings: inspections.reduce((total, inspection) => total + inspection.warnings.length, 0)
    }
  };
}

export async function inspectSongAssets(vaultPath: string, song: ManagedSong): Promise<AssetInspection> {
  const inspectedAt = new Date().toISOString();
  const assets: AssetRecord[] = [];
  const warnings: string[] = [];
  const folderStatus = {
    lyrics: "missing" as FolderStatus,
    audio: "missing" as FolderStatus,
    metadata: "missing" as FolderStatus,
    artwork: "missing" as FolderStatus,
    licensing: "missing" as FolderStatus,
    releaseAdmin: "missing" as FolderStatus
  };

  for (const folder of ASSET_FOLDERS) {
    const absoluteFolder = path.join(song.path, folder);
    const statusKey = folderStatusKey(folder);
    try {
      const stat = await lstat(absoluteFolder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        warnings.push(`Skipped non-directory or linked asset folder: ${path.relative(vaultPath, absoluteFolder)}`);
        continue;
      }
      const folderAssets = await collectFolderAssets(vaultPath, absoluteFolder, folder, warnings);
      folderStatus[statusKey] = folderAssets.length === 0 ? "empty" : "present";
      assets.push(...folderAssets);
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        warnings.push(`Unable to inspect asset folder: ${path.relative(vaultPath, absoluteFolder)}`);
      }
    }
  }

  const sortedAssets = assets.sort((left, right) => compareText(left.path, right.path));
  return {
    contract: "asset-inspection.v1",
    authority: assetInspectorAuthority(),
    projectPath: song.relativePath,
    inspectedAt,
    assets: sortedAssets,
    folderStatus,
    findings: buildFindings(sortedAssets, folderStatus),
    warnings
  };
}

async function collectFolderAssets(vaultPath: string, folderPath: string, folder: AssetFolder, warnings: string[]): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  await visit(folderPath);
  return records;

  async function visit(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      warnings.push(`Unable to read asset directory: ${path.relative(vaultPath, currentPath)}`);
      return;
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(vaultPath, entryPath);
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped linked asset path: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        records.push(await assetRecord(vaultPath, entryPath, folder));
      }
    }
  }
}

async function assetRecord(vaultPath: string, assetPath: string, folder: AssetFolder): Promise<AssetRecord> {
  const stat = await lstat(assetPath);
  const relativePath = path.relative(vaultPath, assetPath);
  const fileName = path.basename(assetPath);
  const extension = path.extname(assetPath).toLowerCase();
  const role = candidateRole(fileName, extension, folder);
  const evidence = role.evidence;
  return {
    path: relativePath,
    category: categoryForFolder(folder),
    candidateRole: role.role,
    confidence: role.confidence,
    extension,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: await hashFile(assetPath),
    evidence
  };
}

function candidateRole(fileName: string, extension: string, folder: AssetFolder): { role: string | null; confidence: AssetConfidence; evidence: string[] } {
  const normalized = fileName.toLowerCase();
  const evidence: string[] = [];
  if (folder === "audio") {
    if (normalized.includes("mastered")) evidence.push("filename contains mastered");
    if (normalized.includes("original") || normalized.includes("origianl")) evidence.push("filename suggests original audio variant");
    if (normalized.includes("alt-version")) evidence.push("filename suggests alternate audio version");
    return { role: audioRole(normalized), confidence: evidence.length > 0 ? "high" : "medium", evidence };
  }
  if (folder === "metadata" && normalized.includes("media-info")) {
    evidence.push("filename contains media-info");
    if (normalized.includes("mastered")) evidence.push("filename references mastered audio");
    if (normalized.includes("alt-version")) evidence.push("filename references alternate audio version");
    if (normalized.includes("original") || normalized.includes("origianl")) evidence.push("filename references original audio version");
    return { role: "media-info-record", confidence: "high", evidence };
  }
  if (folder === "lyrics") {
    evidence.push("asset is inside lyrics folder");
    return { role: "lyric-candidate", confidence: "medium", evidence };
  }
  if (folder === "artwork") {
    evidence.push("asset is inside artwork folder");
    return { role: artworkRole(extension), confidence: "medium", evidence };
  }
  if (folder === "licensing") {
    evidence.push("asset is inside licensing folder");
    return { role: "licensing-or-rights-record", confidence: "medium", evidence };
  }
  if (folder === "release-admin") {
    evidence.push("asset is inside release-admin folder");
    return { role: "release-admin-record", confidence: "medium", evidence };
  }
  return { role: null, confidence: "low", evidence };
}

function audioRole(normalized: string): string {
  if (normalized.includes("mastered")) return "mastered-audio";
  if (normalized.includes("alt-version")) return "alternate-audio";
  if (normalized.includes("original") || normalized.includes("origianl")) return "original-audio-candidate";
  return "audio-candidate";
}

function artworkRole(extension: string): string {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension) ? "artwork-candidate" : "artwork-related-file";
}

function buildFindings(assets: AssetRecord[], folderStatus: AssetInspection["folderStatus"]): AssetInspectionFinding[] {
  const findings: AssetInspectionFinding[] = [];
  const lyricCandidates = assets.filter((asset) => asset.category === "lyrics");
  const audioAssets = assets.filter((asset) => asset.category === "audio");
  const mediaInfoAssets = assets.filter((asset) => asset.category === "metadata" && asset.candidateRole === "media-info-record");
  if (lyricCandidates.length === 0) {
    findings.push({
      type: "canonical-lyric-unresolved",
      severity: "low",
      status: "blocked-insufficient-evidence",
      evidencePaths: [],
      requiredEvidence: ["verified source lyric path", "migration record or explicit human designation"],
      summary: "No lyric candidate was observed; canonical lyric remains unresolved."
    });
  } else {
    findings.push({
      type: "canonical-lyric-unresolved",
      severity: "low",
      status: "blocked-insufficient-evidence",
      evidencePaths: lyricCandidates.map((asset) => asset.path),
      requiredEvidence: ["verified source lyric path", "migration record or explicit human designation"],
      summary: "Lyric candidates were inventoried, but Asset Inspector does not declare a canonical lyric."
    });
  }
  findings.push({
    type: "provenance-insufficient",
    severity: "low",
    status: "blocked-insufficient-evidence",
    evidencePaths: [],
    requiredEvidence: ["verified source paths", "migration record or explicit human designation"],
    summary: "Asset Inspector cannot infer provenance from folder placement or filenames."
  });
  if (folderStatus.releaseAdmin === "empty") {
    findings.push({
      type: "release-admin-empty",
      severity: "info",
      status: "observed",
      evidencePaths: [],
      requiredEvidence: ["release administration record, if one exists"],
      summary: "release-admin folder is present but empty; this is not proof that records never existed."
    });
  }
  if (audioAssets.length > 1) {
    findings.push({
      type: "multiple-audio-variants",
      severity: "info",
      status: "observed",
      evidencePaths: audioAssets.map((asset) => asset.path),
      requiredEvidence: ["explicit master/version designation before promotion"],
      summary: "Multiple audio variants were observed; Asset Inspector does not choose a canonical master."
    });
  }
  if (mediaInfoAssets.length > 0) {
    findings.push({
      type: "media-info-audio-evidence",
      severity: "info",
      status: "observed",
      evidencePaths: mediaInfoAssets.map((asset) => asset.path),
      requiredEvidence: ["matching audio file evidence before version promotion"],
      summary: "Media-info records were observed as audio evidence, not canonical source-of-truth by themselves."
    });
  }
  return findings;
}

function folderStatusKey(folder: AssetFolder): keyof AssetInspection["folderStatus"] {
  return folder === "release-admin" ? "releaseAdmin" : folder;
}

function categoryForFolder(folder: AssetFolder): AssetCategory {
  return folder === "release-admin" ? "release-admin" : folder;
}

async function hashFile(assetPath: string): Promise<string> {
  const content = await readFile(assetPath);
  return createHash("sha256").update(content).digest("hex");
}

function assetInspectorAuthority(): AssetInspection["authority"] {
  return {
    system: "AIBRY Catalog OS",
    specialist: "Asset Inspector",
    authorityMode: "OBSERVE",
    operationalStandard: "ASOS v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
