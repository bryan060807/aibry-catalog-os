export type CatalogInstruction = {
  path: string;
  lineCount: number;
  byteLength: number;
};

export type ReleaseContext =
  | {
      type: "standalone-single";
      albumTitle: null;
      releaseContainerRelativePath: null;
    }
  | {
      type: "album-track";
      albumTitle: string;
      releaseContainerRelativePath: string;
    };

export type ProjectFile = {
  path: string;
  relativePath: string;
  directoryRelativePath: string;
  title: string | null;
  lineCount: number;
  releaseContext: ReleaseContext;
};

export type ManagedSong = {
  path: string;
  relativePath: string;
  releaseContext: ReleaseContext;
};

export type ProvisionalSongCandidate = {
  path: string;
  relativePath: string;
  releaseContext: ReleaseContext;
  admissionReason: "missing-project-file" | "unsafe-project-file";
};

export type AlbumReleaseContainer = {
  path: string;
  relativePath: string;
  title: string;
};

export type ProjectPlaceholder = {
  relativePath: string;
  placeholderType: "single-song-name" | "album-release-name" | "album-track-name";
};

export type LegacyCorpusEntry = {
  relativePath: string;
  entryType: "directory" | "file";
};

export type ProjectScan = {
  managedSongs: ManagedSong[];
  provisionalSongCandidates: ProvisionalSongCandidate[];
  projectFiles: ProjectFile[];
  albumReleaseContainers: AlbumReleaseContainer[];
  placeholders: ProjectPlaceholder[];
  legacyCorpusEntries: LegacyCorpusEntry[];
  irregularDirectories: ManagedSong[];
  skippedDirectoryLinks: string[];
};

export type CatalogDiscovery = {
  vaultPath: string;
  discoveredAt: string;
  instruction: CatalogInstruction;
  managedSongs: ManagedSong[];
  provisionalSongCandidates: ProvisionalSongCandidate[];
  projectFiles: ProjectFile[];
  albumReleaseContainers: AlbumReleaseContainer[];
  placeholders: ProjectPlaceholder[];
  legacyCorpusEntries: LegacyCorpusEntry[];
  irregularDirectories: ManagedSong[];
  warnings: string[];
};
