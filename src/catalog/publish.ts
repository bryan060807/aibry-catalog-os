import path from "node:path";
import type { AuditFinding, CatalogAudit } from "./audit.js";
import { auditCatalog } from "./audit.js";
import { getManagedSongContract } from "./contract.js";
import type { ManagedSongContract } from "./contract.js";
import { discoverCatalog } from "./discover.js";
import type { AlbumReleaseContainer, CatalogDiscovery, ProjectFile, ReleaseContext } from "./types.js";

export type CatalogIndexSongRecord = {
  catalogId: string;
  title: string | null;
  lifecycleState: "managed";
  directoryRelativePath: string;
  projectFileRelativePath: string;
  releaseContext: ReleaseContext;
  frontDoor: {
    relativePath: string;
    lineCount: number;
  };
  findings: Array<Pick<AuditFinding, "findingId" | "severity" | "category" | "summary" | "recommendedAction">>;
};

export type CatalogIndexAlbumRelease = Pick<AlbumReleaseContainer, "relativePath" | "title"> & {
  managedSongCount: number;
  findings: Array<Pick<AuditFinding, "findingId" | "severity" | "category" | "summary" | "recommendedAction">>;
};

export type CatalogIndex = {
  schemaVersion: "catalog-index.v1";
  generatedAt: string;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "Catalog Publisher";
    authorityMode: "APPLY_OUTSIDE_VAULT";
    operationalStandard: "ASOS v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  contract: ManagedSongContract;
  source: {
    vaultPath: string;
    discoveredAt: string;
    auditedAt: string;
    instructionPath: string;
  };
  counts: {
    managedSongs: number;
    albumReleaseContainers: number;
    provisionalSongCandidates: number;
    findings: number;
    warnings: number;
  };
  songs: CatalogIndexSongRecord[];
  albumReleases: CatalogIndexAlbumRelease[];
  findings: AuditFinding[];
  provisionalSongCandidates: CatalogDiscovery["provisionalSongCandidates"];
  warnings: string[];
  scopeNotes: string[];
};

export async function publishCatalogIndex(vaultInput: string): Promise<CatalogIndex> {
  const discovery = await discoverCatalog(vaultInput);
  const audit = await auditCatalog(discovery);
  return buildCatalogIndex(discovery, audit);
}

export function buildCatalogIndex(discovery: CatalogDiscovery, audit: CatalogAudit): CatalogIndex {
  const findingsBySource = groupFindingsBySource(audit.findings);
  const songs = discovery.projectFiles.map((project) => songRecord(project, findingsBySource.get(project.relativePath) ?? []));
  const albumReleases = discovery.albumReleaseContainers.map((release) => albumReleaseRecord(discovery, release, findingsBySource.get(release.relativePath) ?? []));

  return {
    schemaVersion: "catalog-index.v1",
    generatedAt: new Date().toISOString(),
    authority: {
      system: "AIBRY Catalog OS",
      specialist: "Catalog Publisher",
      authorityMode: "APPLY_OUTSIDE_VAULT",
      operationalStandard: "ASOS v1",
      sourceOfTruth: "Music Vault",
      vaultMutation: "none"
    },
    contract: getManagedSongContract(),
    source: {
      vaultPath: discovery.vaultPath,
      discoveredAt: discovery.discoveredAt,
      auditedAt: audit.auditedAt,
      instructionPath: discovery.instruction.path
    },
    counts: {
      managedSongs: songs.length,
      albumReleaseContainers: albumReleases.length,
      provisionalSongCandidates: discovery.provisionalSongCandidates.length,
      findings: audit.findings.length,
      warnings: discovery.warnings.length
    },
    songs,
    albumReleases,
    findings: audit.findings,
    provisionalSongCandidates: discovery.provisionalSongCandidates,
    warnings: discovery.warnings,
    scopeNotes: [
      "Catalog Publisher writes a disposable index outside the vault and never mutates canonical vault files.",
      ...audit.scopeNotes
    ]
  };
}

function songRecord(project: ProjectFile, findings: AuditFinding[]): CatalogIndexSongRecord {
  return {
    catalogId: stableCatalogId("song", project.directoryRelativePath),
    title: project.title,
    lifecycleState: "managed",
    directoryRelativePath: project.directoryRelativePath,
    projectFileRelativePath: project.relativePath,
    releaseContext: project.releaseContext,
    frontDoor: {
      relativePath: project.relativePath,
      lineCount: project.lineCount
    },
    findings: summarizeFindings(findings)
  };
}

function albumReleaseRecord(discovery: CatalogDiscovery, release: AlbumReleaseContainer, findings: AuditFinding[]): CatalogIndexAlbumRelease {
  return {
    relativePath: release.relativePath,
    title: release.title,
    managedSongCount: discovery.managedSongs.filter((song) => song.releaseContext.releaseContainerRelativePath === release.relativePath).length,
    findings: summarizeFindings(findings)
  };
}

function groupFindingsBySource(findings: AuditFinding[]): Map<string, AuditFinding[]> {
  const grouped = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    grouped.set(finding.sourcePath, [...(grouped.get(finding.sourcePath) ?? []), finding]);
  }
  return grouped;
}

function summarizeFindings(findings: AuditFinding[]): CatalogIndexSongRecord["findings"] {
  return findings.map(({ findingId, severity, category, summary, recommendedAction }) => ({ findingId, severity, category, summary, recommendedAction }));
}

function stableCatalogId(prefix: string, relativePath: string): string {
  return `${prefix}:${relativePath.split(path.sep).join("/")}`;
}
