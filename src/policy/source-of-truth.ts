import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function assertVaultDirectory(vaultPath: string): Promise<string> {
  if (vaultPath.trim() === "") {
    throw new Error("Vault path must not be empty.");
  }

  const resolvedVault = path.resolve(vaultPath);
  let vaultStat;
  try {
    vaultStat = await stat(resolvedVault);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      throw new Error(`Vault path does not exist: ${resolvedVault}`, { cause: error });
    }
    throw new Error(`Unable to inspect vault path: ${resolvedVault}`, { cause: error });
  }

  if (!vaultStat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${resolvedVault}`);
  }

  try {
    return await realpath(resolvedVault);
  } catch (error: unknown) {
    throw new Error(`Unable to resolve vault path: ${resolvedVault}`, { cause: error });
  }
}

export async function assertOutputOutsideVault(vaultPath: string, outputPath: string): Promise<string> {
  if (outputPath.trim() === "") {
    throw new Error("Output path must not be empty.");
  }

  const resolvedVault = await realpath(path.resolve(vaultPath));
  const lexicalOutput = path.resolve(outputPath);

  try {
    const outputStat = await lstat(lexicalOutput);
    if (outputStat.isSymbolicLink()) {
      throw new Error(`Refusing to write discovery output through a symbolic link: ${lexicalOutput}`);
    }
    if (outputStat.isDirectory()) {
      throw new Error(`Output path is a directory: ${lexicalOutput}`);
    }
    if (!samePath(await realpath(lexicalOutput), lexicalOutput)) {
      throw new Error(`Refusing to write discovery output through a filesystem alias: ${lexicalOutput}`);
    }

    if (await isVaultFileAlias(resolvedVault, lexicalOutput, outputStat.dev, outputStat.ino)) {
      throw new Error(`Refusing to write discovery output because it aliases a vault file: ${lexicalOutput}`);
    }
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }

  const canonicalOutput = await resolveThroughExistingAncestor(lexicalOutput);
  if (isInsideOrEqual(resolvedVault, canonicalOutput)) {
    throw new Error(`Refusing to write discovery output inside the vault: ${lexicalOutput}`);
  }

  return lexicalOutput;
}

export async function assertPathHasNoAliases(
  rootPath: string,
  targetPath: string,
  description: string
): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (relativeTarget === "" || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`${description} must be inside the vault: ${resolvedTarget}`);
  }

  let currentPath = resolvedRoot;
  let parentStat = await lstat(currentPath);
  for (const segment of relativeTarget.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      throw new Error(`${description} must not use a symbolic link, junction, mount point, or reparse-point alias: ${currentPath}`);
    }

    const canonicalPath = await realpath(currentPath);
    if (!samePath(canonicalPath, currentPath) || currentStat.dev !== parentStat.dev) {
      throw new Error(`${description} must not use a symbolic link, junction, mount point, or reparse-point alias: ${currentPath}`);
    }

    parentStat = currentStat;
  }
}

async function isVaultFileAlias(
  vaultPath: string,
  outputPath: string,
  outputDev: number,
  outputIno: number
): Promise<boolean> {
  async function visit(currentPath: string): Promise<boolean> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        continue;
      }
      if (entryStat.isFile() && entryStat.dev === outputDev && entryStat.ino === outputIno) {
        return true;
      }
      if (entryStat.isDirectory() && await isDirectChild(currentPath, entryPath, entryStat.dev)) {
        if (await visit(entryPath)) {
          return true;
        }
      }
    }
    return false;
  }

  if (samePath(vaultPath, outputPath)) {
    return true;
  }
  return visit(vaultPath);
}

async function isDirectChild(parentPath: string, childPath: string, childDev: number): Promise<boolean> {
  const parentStat = await lstat(parentPath);
  if (childDev !== parentStat.dev) {
    return false;
  }
  return samePath(await realpath(childPath), childPath);
}

async function resolveThroughExistingAncestor(targetPath: string): Promise<string> {
  let currentPath = targetPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existingPath = await realpath(currentPath);
      return path.resolve(existingPath, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error(`Unable to resolve output path: ${targetPath}`, { cause: error });
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw new Error(`Unable to resolve output path: ${targetPath}`, { cause: error });
      }
      missingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function isInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
