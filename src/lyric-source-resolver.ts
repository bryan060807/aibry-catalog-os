import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

export type LyricSourceDesignationV1 = {
  provenance: {
    contract: "lyric-source-designation.v1";
    status: "verified";
    migration_record: string;
  };
  source_path: string;
  canonical_lyric_source: string;
  managed_lyric_copy: string;
  source_sha256: string;
  managed_sha256: string;
  verification_method: "sha256-byte-match";
  verification_state: "verified";
  designation_state: "human-approved";
};

export type LyricSourceMigrationEntryV1 = {
  project_path: string;
  source_path: string;
  managed_lyric_copy: string;
  source_size_bytes: number;
  managed_size_bytes: number;
  source_sha256: string;
  managed_sha256: string;
  verification_method: "sha256-byte-match";
  verification_state: "verified";
  designation_state: "human-approved";
  verified_at: string;
};

export type LyricSourceMigrationManifestV1 = {
  contract: "lyric-source-migration-manifest.v1";
  entries: LyricSourceMigrationEntryV1[];
};

export type LyricSourceResolution = {
  contract: "lyric-source-resolution.v1";
  projectPath: string;
  state: "verified" | "unresolved";
  designation: LyricSourceDesignationV1 | null;
  evidencePaths: string[];
  failures: string[];
};

export async function resolveLyricSourceDesignation(vaultInput: string, projectFileInput: string): Promise<LyricSourceResolution> {
  const vaultPath = await realpath(path.resolve(vaultInput));
  const lexicalProjectFilePath = path.resolve(projectFileInput);
  const lexicalProjectPath = normalizeRelative(path.relative(vaultPath, lexicalProjectFilePath));
  const failures: string[] = [];
  const evidencePaths = new Set<string>([lexicalProjectPath]);

  if (!isInsideOrEqual(vaultPath, lexicalProjectFilePath)) {
    return unresolved(lexicalProjectPath, evidencePaths, ["project.md is outside the Music Vault"]);
  }
  if (!await verifyNoSymlinkSegments(vaultPath, lexicalProjectFilePath, "project.md", failures)) {
    return unresolved(lexicalProjectPath, evidencePaths, failures);
  }

  const projectFilePath = await realpath(lexicalProjectFilePath);
  const projectPath = normalizeRelative(path.relative(vaultPath, projectFilePath));

  const designation = await readProjectDesignation(projectFilePath, failures);
  if (!designation) return unresolved(projectPath, evidencePaths, failures);

  const sourcePath = await verifyVaultFile(vaultPath, designation.source_path, "canonical source", failures);
  const canonicalPath = await verifyVaultFile(vaultPath, designation.canonical_lyric_source, "canonical lyric source", failures);
  const managedPath = await verifyVaultFile(vaultPath, designation.managed_lyric_copy, "managed lyric copy", failures);
  const migrationRecordPath = await verifyVaultFile(vaultPath, designation.provenance.migration_record, "migration record", failures);

  for (const candidate of [designation.source_path, designation.canonical_lyric_source, designation.managed_lyric_copy, designation.provenance.migration_record]) {
    evidencePaths.add(normalizeRelative(candidate));
  }

  const resolvedProjectDirectory = normalizeRelative(path.relative(vaultPath, path.dirname(projectFilePath)));
  const managedLyricsPrefix = `${resolvedProjectDirectory}/lyrics/`;

  if (sourcePath) {
    const resolvedSourceRelative = normalizeRelative(path.relative(vaultPath, sourcePath));
    if (!resolvedSourceRelative.startsWith("lyrics/")) {
      failures.push("source_path must resolve under lyrics/");
    }
  }
  if (canonicalPath) {
    const resolvedCanonicalRelative = normalizeRelative(path.relative(vaultPath, canonicalPath));
    if (!resolvedCanonicalRelative.startsWith("lyrics/")) {
      failures.push("canonical_lyric_source must resolve under lyrics/");
    }
  }
  if (managedPath) {
    const resolvedManagedRelative = normalizeRelative(path.relative(vaultPath, managedPath));
    if (!resolvedManagedRelative.startsWith(managedLyricsPrefix)) {
      failures.push("managed_lyric_copy must resolve under the project lyrics/ directory");
    }
  }
  if (designation.source_path !== designation.canonical_lyric_source) {
    failures.push("source_path and canonical_lyric_source must identify the same canonical legacy lyric");
  }

  if (sourcePath && canonicalPath && sourcePath !== canonicalPath) {
    failures.push("source_path and canonical_lyric_source resolve to different files");
  }
  if (sourcePath && managedPath && sourcePath === managedPath) {
    failures.push("canonical source and managed lyric copy resolve to the same file");
  }

  let sourceStat: Awaited<ReturnType<typeof lstat>> | null = null;
  let managedStat: Awaited<ReturnType<typeof lstat>> | null = null;
  let sourceSha256: string | null = null;
  let managedSha256: string | null = null;
  if (sourcePath) {
    sourceStat = await lstat(sourcePath);
    sourceSha256 = await hashFile(sourcePath);
    if (sourceSha256 !== designation.source_sha256) failures.push("current canonical source hash does not match source_sha256");
  }
  if (managedPath) {
    managedStat = await lstat(managedPath);
    managedSha256 = await hashFile(managedPath);
    if (managedSha256 !== designation.managed_sha256) failures.push("current managed lyric hash does not match managed_sha256");
  }
  if (sourceSha256 && managedSha256 && sourceSha256 !== managedSha256) {
    failures.push("canonical source and managed lyric copy are not byte-identical");
  }
  if (designation.source_sha256 !== designation.managed_sha256) {
    failures.push("recorded source_sha256 and managed_sha256 do not match");
  }

  if (migrationRecordPath && sourceStat && managedStat) {
    const manifest = await readMigrationManifest(migrationRecordPath, failures);
    if (manifest) {
      verifyManifestMapping(manifest, {
        projectPath,
        designation,
        sourceSizeBytes: sourceStat.size,
        managedSizeBytes: managedStat.size
      }, failures);
    }
  }

  return failures.length === 0
    ? {
        contract: "lyric-source-resolution.v1",
        projectPath,
        state: "verified",
        designation,
        evidencePaths: [...evidencePaths].sort(),
        failures: []
      }
    : unresolved(projectPath, evidencePaths, failures, designation);
}

async function readProjectDesignation(projectFilePath: string, failures: string[]): Promise<LyricSourceDesignationV1 | null> {
  const frontMatter = parseFrontMatter(await readFile(projectFilePath, "utf8"), projectFilePath, failures);
  if (!frontMatter) return null;
  if (!isDesignation(frontMatter)) {
    failures.push("project.md does not contain a complete lyric-source-designation.v1 front-matter designation");
    return null;
  }
  return frontMatter;
}

async function readMigrationManifest(manifestPath: string, failures: string[]): Promise<LyricSourceMigrationManifestV1 | null> {
  const frontMatter = parseFrontMatter(await readFile(manifestPath, "utf8"), manifestPath, failures);
  if (!frontMatter || !isMigrationManifest(frontMatter)) {
    failures.push("migration record does not contain a valid lyric-source-migration-manifest.v1 front matter");
    return null;
  }
  return frontMatter;
}

function verifyManifestMapping(
  manifest: LyricSourceMigrationManifestV1,
  expected: {
    projectPath: string;
    designation: LyricSourceDesignationV1;
    sourceSizeBytes: number;
    managedSizeBytes: number;
  },
  failures: string[]
): void {
  const projectDirectory = normalizeRelative(path.posix.dirname(expected.projectPath));
  const projectEntries = manifest.entries.filter((entry) => normalizeRelative(entry.project_path) === projectDirectory);
  if (projectEntries.length === 0) {
    failures.push("migration record does not contain a mapping for this project");
    return;
  }
  if (projectEntries.length > 1) {
    failures.push("migration record contains competing canonical designations for this project");
    return;
  }

  const entry = projectEntries[0];
  if (!entry) return;
  const checks: Array<[boolean, string]> = [
    [normalizeRelative(entry.source_path) === normalizeRelative(expected.designation.source_path), "migration record source_path does not match project designation"],
    [normalizeRelative(entry.managed_lyric_copy) === normalizeRelative(expected.designation.managed_lyric_copy), "migration record managed_lyric_copy does not match project designation"],
    [entry.source_sha256 === expected.designation.source_sha256, "migration record source_sha256 does not match project designation"],
    [entry.managed_sha256 === expected.designation.managed_sha256, "migration record managed_sha256 does not match project designation"],
    [entry.source_size_bytes === expected.sourceSizeBytes, "migration record source_size_bytes does not match current source"],
    [entry.managed_size_bytes === expected.managedSizeBytes, "migration record managed_size_bytes does not match current managed copy"],
    [entry.verification_method === "sha256-byte-match", "migration record verification_method is not sha256-byte-match"],
    [entry.verification_state === "verified", "migration record verification_state is not verified"],
    [entry.designation_state === "human-approved", "migration record designation_state is not human-approved"]
  ];
  for (const [passes, message] of checks) if (!passes) failures.push(message);

  const sourceCompetitors = manifest.entries.filter((candidate) =>
    normalizeRelative(candidate.project_path) === projectDirectory
    && normalizeRelative(candidate.source_path) !== normalizeRelative(entry.source_path)
  );
  if (sourceCompetitors.length > 0) failures.push("migration record contains a competing canonical source for this project");
}

async function verifyVaultFile(vaultPath: string, relativeInput: string, label: string, failures: string[]): Promise<string | null> {
  const relativePath = normalizeRelative(relativeInput);
  if (path.isAbsolute(relativeInput) || relativePath.startsWith("../") || relativePath === "..") {
    failures.push(`${label} must be a vault-relative path`);
    return null;
  }
  const lexicalPath = path.resolve(vaultPath, relativePath);
  if (!isInsideOrEqual(vaultPath, lexicalPath)) {
    failures.push(`${label} escapes the Music Vault`);
    return null;
  }
  try {
    if (!await verifyNoSymlinkSegments(vaultPath, lexicalPath, label, failures)) return null;
    const stat = await lstat(lexicalPath);
    if (!stat.isFile()) {
      failures.push(`${label} is not a file`);
      return null;
    }
    const canonicalPath = await realpath(lexicalPath);
    if (!isInsideOrEqual(vaultPath, canonicalPath)) {
      failures.push(`${label} resolves outside the Music Vault`);
      return null;
    }
    return canonicalPath;
  } catch (error: unknown) {
    failures.push(`${label} does not exist or cannot be read${hasCode(error, "ENOENT") ? "" : `: ${errorMessage(error)}`}`);
    return null;
  }
}

async function verifyNoSymlinkSegments(vaultPath: string, targetPath: string, label: string, failures: string[]): Promise<boolean> {
  const relative = path.relative(vaultPath, targetPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    failures.push(`${label} is outside the Music Vault`);
    return false;
  }

  let current = vaultPath;
  for (const segment of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      failures.push(`${label} contains a symbolic-link path segment: ${normalizeRelative(path.relative(vaultPath, current))}`);
      return false;
    }
  }
  return true;
}

function parseFrontMatter(content: string, filePath: string, failures: string[]): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    failures.push(`missing YAML front matter: ${filePath}`);
    return null;
  }
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0 || !isRecord(document.toJSON())) {
    failures.push(`invalid YAML front matter: ${filePath}`);
    return null;
  }
  return document.toJSON() as Record<string, unknown>;
}

function isDesignation(value: Record<string, unknown>): value is LyricSourceDesignationV1 {
  const provenance = value.provenance;
  return isRecord(provenance)
    && provenance.contract === "lyric-source-designation.v1"
    && provenance.status === "verified"
    && isNonEmptyString(provenance.migration_record)
    && isNonEmptyString(value.source_path)
    && isNonEmptyString(value.canonical_lyric_source)
    && isNonEmptyString(value.managed_lyric_copy)
    && isSha256(value.source_sha256)
    && isSha256(value.managed_sha256)
    && value.verification_method === "sha256-byte-match"
    && value.verification_state === "verified"
    && value.designation_state === "human-approved";
}

function isMigrationManifest(value: Record<string, unknown>): value is LyricSourceMigrationManifestV1 {
  return value.contract === "lyric-source-migration-manifest.v1"
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isMigrationEntry(entry));
}

function isMigrationEntry(value: unknown): value is LyricSourceMigrationEntryV1 {
  return isRecord(value)
    && isNonEmptyString(value.project_path)
    && isNonEmptyString(value.source_path)
    && isNonEmptyString(value.managed_lyric_copy)
    && typeof value.source_size_bytes === "number"
    && Number.isSafeInteger(value.source_size_bytes)
    && value.source_size_bytes >= 0
    && typeof value.managed_size_bytes === "number"
    && Number.isSafeInteger(value.managed_size_bytes)
    && value.managed_size_bytes >= 0
    && isSha256(value.source_sha256)
    && isSha256(value.managed_sha256)
    && value.verification_method === "sha256-byte-match"
    && value.verification_state === "verified"
    && value.designation_state === "human-approved"
    && isNonEmptyString(value.verified_at);
}

function unresolved(projectPath: string, evidencePaths: Set<string>, failures: string[], designation: LyricSourceDesignationV1 | null = null): LyricSourceResolution {
  return {
    contract: "lyric-source-resolution.v1",
    projectPath,
    state: "unresolved",
    designation,
    evidencePaths: [...evidencePaths].sort(),
    failures: [...new Set(failures)]
  };
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
