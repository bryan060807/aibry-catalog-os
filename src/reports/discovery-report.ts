import type {
  CatalogDiscovery,
  AlbumReleaseContainer,
  LegacyCorpusEntry,
  ManagedSong,
  ProvisionalSongCandidate,
  ProjectFile,
  ProjectPlaceholder
} from "../catalog/types.js";

export function renderDiscoveryReport(discovery: CatalogDiscovery): string {
  const lines = [
    "# AIBRY Catalog Discovery Report",
    "",
    `- Vault root: ${inlineCode(discovery.vaultPath)}`,
    `- Inspection timestamp: ${discovery.discoveredAt}`,
    "- Read-only confirmation: discovery opened vault entries for reading only",
    `- Canonical instruction path: ${inlineCode(discovery.instruction.path)}`,
    `- Canonical instruction size: ${discovery.instruction.lineCount} lines, ${discovery.instruction.byteLength} UTF-8 bytes`,
    "",
    "## Managed Songs (Admitted by project.md)",
    ""
  ];

  appendManagedSongs(lines, discovery.managedSongs);
  lines.push("## Managed project.md Files", "");
  appendProjectFiles(lines, discovery.projectFiles);
  lines.push("## Provisional / Unadmitted Song Candidates", "");
  lines.push("Song-shaped directories without a direct regular non-link `project.md` are surfaced here only; they do not count as managed songs, discovered projects, or release completeness.", "");
  appendProvisionalSongCandidates(lines, discovery.provisionalSongCandidates);
  lines.push("## Album Release Containers (Not Managed Projects)", "");
  appendReleaseContainers(lines, discovery.albumReleaseContainers);
  lines.push("## Copy/Paste Placeholders Excluded From Managed Projects", "");
  appendPlaceholders(lines, discovery.placeholders);
  lines.push("## Legacy Corpus / Migration Inventory", "");
  lines.push("The `lyrics` tree is inventory only and does not define managed songs or album release containers.", "");
  appendLegacyCorpusEntries(lines, discovery.legacyCorpusEntries);
  lines.push("## Irregular Or Unclassified Directories", "");
  appendManagedSongs(lines, discovery.irregularDirectories);
  lines.push("## Warnings", "");
  appendStringList(lines, discovery.warnings);
  lines.push(
    "## Vault Change Confirmation",
    "",
    "No Music Vault files were changed. This report is generated output outside the vault and is not canonical.",
    ""
  );

  return lines.join("\n");
}

function appendPlaceholders(lines: string[], placeholders: ProjectPlaceholder[]): void {
  if (placeholders.length === 0) {
    lines.push("- None", "");
    return;
  }

  lines.push("| Placeholder | Scaffold type |", "| --- | --- |");
  for (const placeholder of placeholders) {
    lines.push(`| ${escapeCell(placeholder.relativePath)} | ${placeholder.placeholderType} |`);
  }
  lines.push("");
}

function appendLegacyCorpusEntries(lines: string[], entries: LegacyCorpusEntry[]): void {
  if (entries.length === 0) {
    lines.push("- None", "");
    return;
  }

  lines.push("| Legacy entry | Type |", "| --- | --- |");
  for (const entry of entries) {
    lines.push(`| ${escapeCell(entry.relativePath)} | ${entry.entryType} |`);
  }
  lines.push("");
}

function appendManagedSongs(lines: string[], songs: ManagedSong[]): void {
  if (songs.length === 0) {
    lines.push("- None", "");
    return;
  }

  lines.push("| Song directory | Release context |", "| --- | --- |");
  for (const song of songs) {
    lines.push(`| ${escapeCell(song.relativePath)} | ${escapeCell(renderReleaseContext(song.releaseContext))} |`);
  }
  lines.push("");
}

function appendProvisionalSongCandidates(lines: string[], candidates: ProvisionalSongCandidate[]): void {
  if (candidates.length === 0) {
    lines.push("- None", "");
    return;
  }
  lines.push("| Song-shaped directory | Release context | Admission status |", "| --- | --- | --- |");
  for (const candidate of candidates) {
    const reason = candidate.admissionReason === "missing-project-file" ? "project.md missing" : "project.md is not a direct regular non-link file";
    lines.push(`| ${escapeCell(candidate.relativePath)} | ${escapeCell(renderReleaseContext(candidate.releaseContext))} | ${reason} |`);
  }
  lines.push("");
}

function appendProjectFiles(lines: string[], projectFiles: ProjectFile[]): void {
  if (projectFiles.length === 0) {
    lines.push("- None", "");
    return;
  }

  lines.push("| File | Title | Release context | Lines |", "| --- | --- | --- | --- |");
  for (const project of projectFiles) {
    lines.push(
      `| ${escapeCell(project.relativePath)} | ${escapeCell(project.title ?? "Unknown")} | ${escapeCell(renderReleaseContext(project.releaseContext))} | ${project.lineCount} |`
    );
  }
  lines.push("");
}

function appendReleaseContainers(lines: string[], containers: AlbumReleaseContainer[]): void {
  if (containers.length === 0) {
    lines.push("- None", "");
    return;
  }
  lines.push("| Release container | Album title |", "| --- | --- |");
  for (const container of containers) lines.push(`| ${escapeCell(container.relativePath)} | ${escapeCell(container.title)} |`);
  lines.push("");
}

function renderReleaseContext(context: ManagedSong["releaseContext"]): string {
  return context.type === "standalone-single" ? "standalone single" : `album track: ${context.albumTitle}`;
}

function appendStringList(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("- None", "");
    return;
  }

  for (const value of values) {
    lines.push(`- ${inlineCode(value)}`);
  }
  lines.push("");
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
