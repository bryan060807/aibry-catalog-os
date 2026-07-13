import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { CatalogDiscovery, ProjectFile } from "./types.js";

export type AuditSeverity = "info" | "warning" | "error";

export type AuditFinding = {
  findingId: string;
  severity: AuditSeverity;
  category: "duplicate" | "front-door" | "metadata" | "orphan" | "relationship" | "migration" | "provenance";
  sourcePath: string;
  summary: string;
  evidence: string[];
  recommendedAction: string;
};

export type CatalogAudit = {
  vaultPath: string;
  auditedAt: string;
  findings: AuditFinding[];
  scopeNotes: string[];
};

type FrontMatter = Record<string, unknown>;

export async function auditCatalog(discovery: CatalogDiscovery): Promise<CatalogAudit> {
  const findings: AuditFinding[] = [];
  const frontMatters = new Map<string, FrontMatter>();

  for (const project of discovery.projectFiles) {
    const parsed = await readFrontMatter(project.path, project.relativePath, findings);
    if (parsed) frontMatters.set(project.relativePath, parsed);
  }

  addDuplicateFindings(discovery.projectFiles, frontMatters, findings);
  addFrontDoorFindings(discovery, findings);
  addOrphanFindings(discovery, findings);
  addRelationshipFindings(discovery, frontMatters, findings);
  addProvenanceFindings(discovery, frontMatters, findings);
  await inspectMetadataFiles(discovery, findings);

  return {
    vaultPath: discovery.vaultPath,
    auditedAt: new Date().toISOString(),
    findings: findings.sort((left, right) => left.findingId.localeCompare(right.findingId)),
    scopeNotes: [
      "Read-only audit; no vault file was created, moved, renamed, deleted, or rewritten.",
      "Duplicate IDs and relationships are assessed only when declared in YAML front matter.",
      "Migration completeness is reported from observed front doors, legacy inventory, and declared provenance; it does not infer intended destinations or canon."
    ]
  };
}

async function readFrontMatter(filePath: string, relativePath: string, findings: AuditFinding[]): Promise<FrontMatter | null> {
  const content = await readFile(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!content.startsWith("---")) return null;
  if (!match) {
    findings.push(finding("metadata", "error", relativePath, "Malformed YAML front matter", ["Opening `---` has no matching closing delimiter."], "Repair the front matter syntax in a reviewed change; do not rewrite content automatically."));
    return null;
  }
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0 || !isRecord(document.toJSON())) {
    findings.push(finding("metadata", "error", relativePath, "Malformed YAML front matter", document.errors.map((error) => error.message), "Repair the front matter syntax or mapping shape in a reviewed change; do not rewrite content automatically."));
    return null;
  }
  return document.toJSON() as FrontMatter;
}

function addDuplicateFindings(projects: ProjectFile[], frontMatters: Map<string, FrontMatter>, findings: AuditFinding[]): void {
  addDuplicates(projects.map((project) => ({ key: normalized(project.title), path: project.relativePath })), "title", findings);
  addDuplicates(projects.map((project) => ({ key: stringValue(frontMatters.get(project.relativePath)?.id), path: project.relativePath })), "ID", findings);
}

function addDuplicates(values: Array<{ key: string | null; path: string }>, label: string, findings: AuditFinding[]): void {
  const groups = new Map<string, string[]>();
  for (const value of values) if (value.key) groups.set(value.key, [...(groups.get(value.key) ?? []), value.path]);
  for (const [key, paths] of groups) if (paths.length > 1) {
    findings.push(finding("duplicate", "warning", paths[0] ?? "catalog", `Duplicate ${label}: ${key}`, paths, "Review whether these entries intentionally share a title or ID; record the decision without merging or deleting files."));
  }
}

function addFrontDoorFindings(discovery: CatalogDiscovery, findings: AuditFinding[]): void {
  for (const candidate of discovery.provisionalSongCandidates) {
    findings.push(finding("front-door", "warning", candidate.relativePath, "Song-shaped directory lacks a safe direct project.md front door", [`Admission status: ${candidate.admissionReason}.`], "Review ownership and admission intent before proposing a front door; do not create one automatically."));
  }
}

function addOrphanFindings(discovery: CatalogDiscovery, findings: AuditFinding[]): void {
  for (const release of discovery.albumReleaseContainers) {
    const count = discovery.managedSongs.filter((song) => song.releaseContext.releaseContainerRelativePath === release.relativePath).length;
    if (count === 0) findings.push(finding("orphan", "warning", release.relativePath, "Album release container has no admitted tracks", ["No managed track has this release container as its observed release context."], "Confirm whether the container is intentional, incomplete, or obsolete before proposing any change."));
  }
}

function addRelationshipFindings(discovery: CatalogDiscovery, frontMatters: Map<string, FrontMatter>, findings: AuditFinding[]): void {
  for (const project of discovery.projectFiles) {
    const metadata = frontMatters.get(project.relativePath);
    if (!metadata) continue;
    for (const [field, value] of Object.entries(metadata)) {
      if (!/^(related_to|relationship|source_project|parent_project)$/i.test(field)) continue;
      for (const declaredPath of stringValues(value)) {
        const normalizedPath = declaredPath.replace(/[\\/]+/g, path.sep);
        if (!discovery.projectFiles.some((candidate) => candidate.relativePath === normalizedPath)) {
          findings.push(finding("relationship", "warning", project.relativePath, `Broken declared relationship: ${field}`, [`Declared target: ${declaredPath}`, "No admitted project.md path matches the declared target."], "Review the relationship target and preserve the existing declaration until a reviewed correction is approved."));
        }
      }
    }
  }
}

function addProvenanceFindings(discovery: CatalogDiscovery, frontMatters: Map<string, FrontMatter>, findings: AuditFinding[]): void {
  for (const project of discovery.projectFiles) {
    const metadata = frontMatters.get(project.relativePath);
    const declared = metadata && ["provenance", "source_path", "source_paths", "legacy_source"].some((key) => key in metadata);
    if (!declared) findings.push(finding("provenance", "info", project.relativePath, "No structured migration provenance declared", ["No recognized provenance field was found in YAML front matter."], "If this project was migrated, record verified source paths and review state in a future approved metadata update; do not infer provenance."));
  }
  if (discovery.legacyCorpusEntries.length > 0) findings.push(finding("migration", "info", "lyrics", "Legacy corpus remains an inventory", [`Observed legacy entries: ${discovery.legacyCorpusEntries.length}.`], "Use the Stage 1 review queue to plan one destination at a time; do not bulk-migrate or retire source material."));
}

async function inspectMetadataFiles(discovery: CatalogDiscovery, findings: AuditFinding[]): Promise<void> {
  for (const project of discovery.projectFiles) {
    const metadataRoot = path.join(path.dirname(project.path), "metadata");
    let rootStat;
    try { rootStat = await lstat(metadataRoot); } catch (error: unknown) { if (hasCode(error, "ENOENT")) continue; throw error; }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
    for (const entry of await readdir(metadataRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.(md|ya?ml)$/i.test(entry.name)) continue;
      await readFrontMatter(path.join(metadataRoot, entry.name), path.relative(discovery.vaultPath, path.join(metadataRoot, entry.name)), findings);
    }
  }
}

function finding(category: AuditFinding["category"], severity: AuditSeverity, sourcePath: string, summary: string, evidence: string[], recommendedAction: string): AuditFinding {
  return { findingId: `${category}-${sourcePath.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, severity, category, sourcePath, summary, evidence, recommendedAction };
}
function normalized(value: string | null): string | null { return value?.trim().toLocaleLowerCase() || null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function stringValues(value: unknown): string[] { return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
