import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AlbumReleaseContainer,
  LegacyCorpusEntry,
  ManagedSong,
  ProvisionalSongCandidate,
  ProjectFile,
  ProjectPlaceholder,
  ProjectScan,
  ReleaseContext
} from "./types.js";

const SINGLES_ROOT = ["project-memory", "music", "singles"];
const ALBUMS_ROOT = ["project-memory", "music", "albums"];
const LEGACY_CORPUS_ROOT = ["lyrics"];
const RESERVED_SONG_PROJECT_NAME = "song-name";
const RESERVED_ALBUM_RELEASE_NAME = "album-name";
const ALBUM_TRACK_DIRECTORY_NAME = /^\d+-[a-z0-9][a-z0-9-]*$/i;

export async function scanProjectDirectories(vaultPath: string): Promise<ProjectScan> {
  const skippedDirectoryLinks: string[] = [];
  const [singles, albums, legacyCorpusEntries] = await Promise.all([
    discoverStandaloneSongs(vaultPath, skippedDirectoryLinks),
    discoverAlbumTrackSongs(vaultPath, skippedDirectoryLinks),
    discoverLegacyCorpusEntries(vaultPath, skippedDirectoryLinks)
  ]);
  const managedSongs = [...singles.managedSongs, ...albums.managedSongs].sort(compareByRelativePath);
  const provisionalSongCandidates = [...singles.provisionalSongCandidates, ...albums.provisionalSongCandidates].sort(compareByRelativePath);
  const projectFiles = await Promise.all(managedSongs.map((song) => readProjectFile(vaultPath, song)));

  return {
    managedSongs,
    provisionalSongCandidates,
    projectFiles: projectFiles.sort(compareByRelativePath),
    albumReleaseContainers: albums.releaseContainers.sort(compareByRelativePath),
    placeholders: [...singles.placeholders, ...albums.placeholders].sort(compareByRelativePath),
    legacyCorpusEntries,
    irregularDirectories: [],
    skippedDirectoryLinks: skippedDirectoryLinks.sort(compareText)
  };
}

type SongDiscoveryResult = {
  managedSongs: ManagedSong[];
  provisionalSongCandidates: ProvisionalSongCandidate[];
  placeholders: ProjectPlaceholder[];
};

async function discoverStandaloneSongs(vaultPath: string, skippedDirectoryLinks: string[]): Promise<SongDiscoveryResult> {
  const rootPath = await resolveDirectRoot(vaultPath, SINGLES_ROOT, skippedDirectoryLinks);
  if (rootPath === null) return { managedSongs: [], provisionalSongCandidates: [], placeholders: [] };

  const managedSongs: ManagedSong[] = [];
  const provisionalSongCandidates: ProvisionalSongCandidate[] = [];
  const placeholders: ProjectPlaceholder[] = [];
  for (const entry of await readDirectory(rootPath)) {
    const entryPath = path.join(rootPath, entry.name);
    const relativePath = path.relative(vaultPath, entryPath);
    if (await isSkippedDirectoryLink(entryPath, relativePath, skippedDirectoryLinks) || !(await isDirectory(entryPath))) continue;
    if (entry.name.toLowerCase() === RESERVED_SONG_PROJECT_NAME) {
      placeholders.push({ relativePath, placeholderType: "single-song-name" });
      continue;
    }
    await addSongByAdmission(managedSongs, provisionalSongCandidates, entryPath, relativePath, {
      type: "standalone-single",
      albumTitle: null,
      releaseContainerRelativePath: null
    });
  }
  return { managedSongs, provisionalSongCandidates, placeholders };
}

type AlbumSongDiscoveryResult = SongDiscoveryResult & { releaseContainers: AlbumReleaseContainer[] };

async function discoverAlbumTrackSongs(vaultPath: string, skippedDirectoryLinks: string[]): Promise<AlbumSongDiscoveryResult> {
  const rootPath = await resolveDirectRoot(vaultPath, ALBUMS_ROOT, skippedDirectoryLinks);
  if (rootPath === null) return { managedSongs: [], provisionalSongCandidates: [], placeholders: [], releaseContainers: [] };

  const managedSongs: ManagedSong[] = [];
  const provisionalSongCandidates: ProvisionalSongCandidate[] = [];
  const placeholders: ProjectPlaceholder[] = [];
  const releaseContainers: AlbumReleaseContainer[] = [];
  for (const entry of await readDirectory(rootPath)) {
    const releasePath = path.join(rootPath, entry.name);
    const releaseRelativePath = path.relative(vaultPath, releasePath);
    if (await isSkippedDirectoryLink(releasePath, releaseRelativePath, skippedDirectoryLinks) || !(await isDirectory(releasePath))) continue;
    if (entry.name.toLowerCase() === RESERVED_ALBUM_RELEASE_NAME) {
      placeholders.push({ relativePath: releaseRelativePath, placeholderType: "album-release-name" });
      continue;
    }
    releaseContainers.push({ path: releasePath, relativePath: releaseRelativePath, title: entry.name });
    const releaseContext: ReleaseContext = {
      type: "album-track",
      albumTitle: entry.name,
      releaseContainerRelativePath: releaseRelativePath
    };
    for (const songEntry of await readDirectory(releasePath)) {
      const songPath = path.join(releasePath, songEntry.name);
      const songRelativePath = path.relative(vaultPath, songPath);
      if (await isSkippedDirectoryLink(songPath, songRelativePath, skippedDirectoryLinks) || !(await isDirectory(songPath))) continue;
      if (songEntry.name.toLowerCase() === RESERVED_SONG_PROJECT_NAME) {
        placeholders.push({ relativePath: songRelativePath, placeholderType: "album-track-name" });
        continue;
      }
      if (!ALBUM_TRACK_DIRECTORY_NAME.test(songEntry.name)) continue;
      await addSongByAdmission(managedSongs, provisionalSongCandidates, songPath, songRelativePath, releaseContext);
    }
  }
  return { managedSongs, provisionalSongCandidates, placeholders, releaseContainers };
}

async function addSongByAdmission(
  managedSongs: ManagedSong[],
  provisionalSongCandidates: ProvisionalSongCandidate[],
  pathname: string,
  relativePath: string,
  releaseContext: ReleaseContext
): Promise<void> {
  const admissionReason = await getProjectAdmissionReason(pathname);
  const song = { path: pathname, relativePath, releaseContext };
  if (admissionReason === null) managedSongs.push(song);
  else provisionalSongCandidates.push({ ...song, admissionReason });
}

async function readDirectory(directoryPath: string) {
  try {
    return (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
  } catch (error: unknown) {
    throw new Error(`Unable to read discovery root: ${directoryPath}`, { cause: error });
  }
}

async function isDirectory(pathname: string): Promise<boolean> {
  return (await lstat(pathname)).isDirectory();
}

async function isSkippedDirectoryLink(pathname: string, relativePath: string, skippedDirectoryLinks: string[]): Promise<boolean> {
  if (!(await lstat(pathname)).isSymbolicLink()) return false;
  skippedDirectoryLinks.push(relativePath);
  return true;
}

async function discoverLegacyCorpusEntries(vaultPath: string, skippedDirectoryLinks: string[]): Promise<LegacyCorpusEntry[]> {
  const rootPath = await resolveDirectRoot(vaultPath, LEGACY_CORPUS_ROOT, skippedDirectoryLinks);
  if (rootPath === null) return [];
  const entries: LegacyCorpusEntry[] = [];
  await visitLegacyCorpus(rootPath);
  return entries.sort(compareByRelativePath);

  async function visitLegacyCorpus(currentPath: string): Promise<void> {
    for (const child of await readDirectory(currentPath)) {
      const childPath = path.join(currentPath, child.name);
      const relativePath = path.relative(vaultPath, childPath);
      if (await isSkippedDirectoryLink(childPath, relativePath, skippedDirectoryLinks)) continue;
      if (await isDirectory(childPath)) {
        entries.push({ relativePath, entryType: "directory" });
        await visitLegacyCorpus(childPath);
      } else if ((await lstat(childPath)).isFile()) {
        entries.push({ relativePath, entryType: "file" });
      }
    }
  }
}

async function resolveDirectRoot(vaultPath: string, segments: string[], skippedDirectoryLinks: string[]): Promise<string | null> {
  let currentPath = vaultPath;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let currentStat;
    try { currentStat = await lstat(currentPath); } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return null;
      throw new Error(`Unable to inspect discovery root: ${currentPath}`, { cause: error });
    }
    if (currentStat.isSymbolicLink()) {
      skippedDirectoryLinks.push(path.relative(vaultPath, currentPath));
      return null;
    }
    if (!currentStat.isDirectory()) return null;
  }
  return currentPath;
}

async function getProjectAdmissionReason(directoryPath: string): Promise<ProvisionalSongCandidate["admissionReason"] | null> {
  const projectPath = path.join(directoryPath, "project.md");
  try {
    const projectStat = await lstat(projectPath);
    return projectStat.isFile() && !projectStat.isSymbolicLink() && projectStat.nlink === 1 ? null : "unsafe-project-file";
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return "missing-project-file";
    throw new Error(`Unable to inspect project file: ${projectPath}`, { cause: error });
  }
}

async function readProjectFile(vaultPath: string, song: ManagedSong): Promise<ProjectFile> {
  const projectPath = path.join(song.path, "project.md");
  let content: string;
  try { content = await readFile(projectPath, "utf8"); } catch (error: unknown) {
    throw new Error(`Unable to read project file as UTF-8: ${projectPath}`, { cause: error });
  }
  return { path: projectPath, relativePath: path.relative(vaultPath, projectPath), directoryRelativePath: song.relativePath, title: extractTitle(content), lineCount: countLines(content), releaseContext: song.releaseContext };
}

function extractTitle(content: string): string | null {
  const heading = content.split(/\r?\n/).find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() || null : null;
}
function countLines(content: string): number { return content.length === 0 ? 0 : content.split(/\r?\n/).length; }
function compareByRelativePath(left: { relativePath: string }, right: { relativePath: string }): number { return compareText(left.relativePath, right.relativePath); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
