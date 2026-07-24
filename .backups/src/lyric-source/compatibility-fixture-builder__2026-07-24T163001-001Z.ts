import { lstat, readdir, rm } from "node:fs/promises";
import {
  materializeLyricSourceCompatibilityFixture as materializeCore,
  verifyCompatibilityFixtureManifest
} from "./compatibility-fixture-builder-core.js";
import type {
  CompatibilityFixtureBuilderOptions,
  CompatibilityFixtureBuilderResult
} from "./compatibility-fixture-builder-core.js";

export type {
  CompatibilityFixtureBuilderOptions,
  CompatibilityFixtureBuilderResult
} from "./compatibility-fixture-builder-core.js";
export { verifyCompatibilityFixtureManifest };

export async function materializeLyricSourceCompatibilityFixture(
  options: CompatibilityFixtureBuilderOptions
): Promise<CompatibilityFixtureBuilderResult> {
  await removeEmptyNonLinkedOutputDirectory(options.outputDirectory);
  return materializeCore(options);
}

async function removeEmptyNonLinkedOutputDirectory(directory: string): Promise<void> {
  try {
    const item = await lstat(directory);
    if (item.isSymbolicLink() || !item.isDirectory()) return;
    const entries = await readdir(directory);
    if (entries.length === 0) await rm(directory, { recursive: false });
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") throw error;
  }
}
