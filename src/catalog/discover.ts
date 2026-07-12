import { readCatalogInstruction } from "./instruction-reader.js";
import { scanProjectDirectories } from "./project-reader.js";
import type { CatalogDiscovery } from "./types.js";
import { assertVaultDirectory } from "../policy/source-of-truth.js";

export async function discoverCatalog(vaultInput: string): Promise<CatalogDiscovery> {
  const vaultPath = await assertVaultDirectory(vaultInput);
  const [instruction, scan] = await Promise.all([
    readCatalogInstruction(vaultPath),
    scanProjectDirectories(vaultPath)
  ]);

  const warnings: string[] = [];
  if (scan.projectFiles.length === 0) {
    warnings.push("No managed project.md front doors were discovered.");
  }
  for (const skippedPath of scan.skippedDirectoryLinks) {
    warnings.push(`Skipped directory link or junction: ${skippedPath}`);
  }

  return {
    vaultPath,
    discoveredAt: new Date().toISOString(),
    instruction,
    managedSongs: scan.managedSongs,
    provisionalSongCandidates: scan.provisionalSongCandidates,
    projectFiles: scan.projectFiles,
    albumReleaseContainers: scan.albumReleaseContainers,
    placeholders: scan.placeholders,
    legacyCorpusEntries: scan.legacyCorpusEntries,
    irregularDirectories: scan.irregularDirectories,
    warnings
  };
}
