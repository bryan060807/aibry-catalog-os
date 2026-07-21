import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { discoverCatalog } from "./discover.js";
import type { ManagedSong, ProvisionalSongCandidate } from "./types.js";
import { assertPathHasNoAliases } from "../policy/source-of-truth.js";

export type AdmissionMode = "OBSERVE" | "PROPOSE" | "APPLY";
export type AdmissionStatus = "WOULD_ADMIT" | "ADMITTED" | "SKIPPED" | "NEEDS_REVIEW" | "ERROR";

type AdmissionEvidence = {
  relativePath: string;
  projectRelativePath: string;
  evidence: string[];
};

type ProposedAdmissionEntry = AdmissionEvidence & {
  status: "WOULD_ADMIT";
  recommendation: string;
  result?: never;
};

export type AdmissionEntry =
  | ProposedAdmissionEntry
  | AdmissionEvidence & {
      status: "SKIPPED" | "NEEDS_REVIEW";
      recommendation: string;
      result?: never;
    }
  | AdmissionEvidence & {
      status: "ADMITTED";
      recommendation?: never;
      result: string;
    }
  | AdmissionEvidence & {
      status: "ERROR";
      recommendation: string;
      result: string;
    };

export type AdmissionReport = {
  vaultPath: string;
  specialist: "Project Admitter";
  specialistVersion: "v2";
  operationalStandardVersion: "ASOS v1";
  runId: string;
  mode: AdmissionMode;
  started: string;
  completed: string;
  durationMs: number;
  entries: AdmissionEntry[];
  safeguards: string[];
};

/**
 * Project Admitter v2 creates only direct, missing front doors whose title,
 * release context, and single lyric source are observed without interpretation.
 * Existing or unsafe front doors are never modified.
 */
export async function admitProjects(vaultPath: string, mode: AdmissionMode = "PROPOSE"): Promise<AdmissionReport> {
  const startedAt = new Date();
  const discovery = await discoverCatalog(vaultPath);
  let entries: AdmissionEntry[] = [];

  for (const song of discovery.managedSongs) entries.push(skipped(song));
  for (const placeholder of discovery.placeholders) {
    entries.push({
      status: "SKIPPED",
      relativePath: placeholder.relativePath,
      projectRelativePath: path.join(placeholder.relativePath, "project.md"),
      evidence: ["Placeholder directories are excluded by the catalog discovery contract."],
      recommendation: "No action. Reserved scaffolds are not song candidates."
    });
  }
  for (const candidate of discovery.provisionalSongCandidates) {
    entries.push(await assessCandidate(candidate, discovery.vaultPath));
  }

  if (mode === "APPLY") {
    const appliedEntries: AdmissionEntry[] = [];
    for (const entry of entries) {
      if (entry.status !== "WOULD_ADMIT") {
        appliedEntries.push(entry);
        continue;
      }

      try {
        await createAdmittedProject(discovery.vaultPath, entry);
        appliedEntries.push(applied(entry));
      } catch (error: unknown) {
        appliedEntries.push(failed(entry, error));
      }
    }
    entries = appliedEntries;
  }

  const completedAt = new Date();
  return {
    vaultPath: discovery.vaultPath,
    specialist: "Project Admitter",
    specialistVersion: "v2",
    operationalStandardVersion: "ASOS v1",
    runId: randomUUID(),
    mode,
    started: startedAt.toISOString(),
    completed: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    entries: entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    safeguards: [
      "PROPOSE is the default. No Music Vault file is created unless explicit --apply selects APPLY mode.",
      "Existing project.md files are always skipped; this command never overwrites, moves, renames, deletes, or rewrites content.",
      "Policy uncertainty is reported as NEEDS_REVIEW; execution failures are reported separately as ERROR.",
      "Only a direct, missing project.md with one approved UTF-8 Markdown lyric source and an unambiguous observed directory identity is eligible.",
      "No AI services, databases, or network calls are used."
    ]
  };
}

function applied(entry: ProposedAdmissionEntry): AdmissionEntry {
  return {
    status: "ADMITTED",
    relativePath: entry.relativePath,
    projectRelativePath: entry.projectRelativePath,
    evidence: entry.evidence,
    result: "Created and verified a new direct regular project.md file."
  };
}

function failed(entry: ProposedAdmissionEntry, error: unknown): AdmissionEntry {
  return {
    status: "ERROR",
    relativePath: entry.relativePath,
    projectRelativePath: entry.projectRelativePath,
    evidence: entry.evidence,
    result: `No admission was confirmed: ${errorMessage(error)}`,
    recommendation: "Investigate the execution failure, preserve the existing target state, and rerun only after review."
  };
}

async function assessCandidate(candidate: ProvisionalSongCandidate, vaultPath: string): Promise<AdmissionEntry> {
  const projectRelativePath = path.join(candidate.relativePath, "project.md");
  if (candidate.admissionReason !== "missing-project-file") {
    return {
      status: "NEEDS_REVIEW", relativePath: candidate.relativePath, projectRelativePath,
      evidence: ["Discovery classified the existing path as unsafe (link, non-file, or hard-linked file)."],
      recommendation: "Review the unsafe target manually; the Admitter will not replace or change it."
    };
  }

  const lyricSources = await approvedLyricSources(candidate, vaultPath);
  if (lyricSources.length !== 1) {
    return {
      status: "NEEDS_REVIEW", relativePath: candidate.relativePath, projectRelativePath,
      evidence: lyricSources.length === 0
        ? [
            "No approved UTF-8 Markdown lyric source remained after exclusions.",
            `Approved locations inspected: ${approvedLyricLocations(candidate, vaultPath).map((location) => path.relative(vaultPath, location)).join(", ")}`
          ]
        : ["More than one approved lyric source was observed.", ...lyricSources.map((source) => `Observed lyric source: ${source}`)],
      recommendation: lyricSources.length === 0
        ? "Provide one unambiguous approved lyric source through a separately reviewed change."
        : "Resolve the competing lyric sources through review; the Admitter will not choose one."
    };
  }

  return {
    status: "WOULD_ADMIT", relativePath: candidate.relativePath, projectRelativePath,
    evidence: [
      `Observed directory identity: ${path.basename(candidate.path)}`,
      `Observed release context: ${candidate.releaseContext.type}`,
      `Selected lyric source: ${lyricSources[0]}`
    ],
    recommendation: "Review this proposal. Run again with --apply only to create the missing direct project.md."
  };
}

function skipped(song: ManagedSong): AdmissionEntry {
  return {
    status: "SKIPPED", relativePath: song.relativePath, projectRelativePath: path.join(song.relativePath, "project.md"),
    evidence: ["Discovery classified this song as managed through its existing direct regular non-link project.md."],
    recommendation: "No action. Preserve the existing front door."
  };
}

async function approvedLyricSources(candidate: ProvisionalSongCandidate, vaultPath: string): Promise<string[]> {
  const sources = new Set<string>();
  for (const lyricsPath of approvedLyricLocations(candidate, vaultPath)) {
    for (const source of await markdownSourcesIn(lyricsPath, vaultPath, candidate)) sources.add(source);
  }
  return [...sources].sort();
}

function approvedLyricLocations(candidate: ProvisionalSongCandidate, vaultPath: string): string[] {
  const locations = [path.join(candidate.path, "lyrics")];
  if (candidate.releaseContext.type !== "album-track") {
    locations.push(path.join(vaultPath, "lyrics", "singles"));
    return locations;
  }

  const releaseSlug = path.basename(candidate.releaseContext.releaseContainerRelativePath);
  const albumSlugs = releaseSlug.startsWith("the-") ? [releaseSlug] : [releaseSlug, `the-${releaseSlug}`];
  for (const albumSlug of albumSlugs) locations.push(path.join(vaultPath, "lyrics", "albums", albumSlug));
  return locations;
}

async function markdownSourcesIn(lyricsPath: string, vaultPath: string, candidate: ProvisionalSongCandidate): Promise<string[]> {
  try {
    const lyricsStat = await lstat(lyricsPath);
    if (!lyricsStat.isDirectory() || lyricsStat.isSymbolicLink()) return [];
    const entries = await readdir(lyricsPath, { withFileTypes: true });
    const sources: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !isApprovedMarkdownName(entry.name, candidate, lyricsPath, vaultPath)) continue;
      const sourcePath = path.join(lyricsPath, entry.name);
      const sourceStat = await lstat(sourcePath);
      if (sourceStat.nlink !== 1 || !await isNonEmptyUtf8Markdown(sourcePath)) continue;
      sources.push(path.relative(vaultPath, sourcePath));
    }
    return sources.sort();
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

function isApprovedMarkdownName(fileName: string, candidate: ProvisionalSongCandidate, lyricsPath: string, vaultPath: string): boolean {
  if (!/\.md$/i.test(fileName) || isExcludedMarkdownName(fileName)) return false;
  const relativeLocation = path.relative(vaultPath, lyricsPath);
  if (relativeLocation === path.relative(vaultPath, path.join(candidate.path, "lyrics"))) return true;
  if (candidate.releaseContext.type === "standalone-single") return fileName.toLowerCase() === `${path.basename(candidate.path)}.md`.toLowerCase();
  const trackPrefix = path.basename(candidate.path).match(/^(\d+)(?=[.-])/u)?.[1];
  return trackPrefix !== undefined && new RegExp(`^${trackPrefix}[.-]`, "i").test(fileName);
}

function isExcludedMarkdownName(fileName: string): boolean {
  const stem = path.basename(fileName, path.extname(fileName));
  return /(^|[-_.\s])(project|readme|metadata|notes?|reports?)(?=$|[-_.\s])/i.test(stem);
}

async function isNonEmptyUtf8Markdown(sourcePath: string): Promise<boolean> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(sourcePath)).trim() !== "";
  } catch { return false; }
}

async function createAdmittedProject(vaultPath: string, entry: AdmissionEntry): Promise<void> {
  const target = path.join(vaultPath, entry.projectRelativePath);
  const candidatePath = path.join(vaultPath, entry.relativePath);
  await assertPathHasNoAliases(vaultPath, candidatePath, "Admission candidate directory");
  try {
    const existing = await lstat(target);
    throw new Error(`Refusing to create project.md because it now exists: ${target} (${existing.isFile() ? "file" : "non-file"})`);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const lyric = entry.evidence.find((evidence) => evidence.startsWith("Selected lyric source: "))?.replace("Selected lyric source: ", "");
  if (!lyric) throw new Error(`Admission evidence unexpectedly lacks a lyric source: ${target}`);
  await writeFile(target, renderProjectTemplate(path.basename(entry.relativePath), entry.relativePath, lyric), { encoding: "utf8", flag: "wx" });
  const verified = await lstat(target);
  if (!verified.isFile() || verified.isSymbolicLink() || verified.nlink !== 1) throw new Error(`Created target did not verify as a direct regular non-link file: ${target}`);
}

function renderProjectTemplate(title: string, relativePath: string, lyricSource: string): string {
  return [
    `# ${title}`, "", "## Observed Context", "",
    `- Project directory: \`${relativePath}\`.`,
    "- Admission record: created by Project Admitter v2 from direct filesystem evidence; governance approval remains unconfirmed.",
    "", "## Observed Sources", "", `- Lyric source: \`${lyricSource}\`.`, "", "## Review Required", "",
    "- Confirm title, identity, rights, credits, release intent, and canonical-source status before adding factual metadata or approvals.", ""
  ].join("\n");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
