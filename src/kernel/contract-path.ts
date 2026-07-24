import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export function normalizeContractPath(input: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Contract path must be a non-empty scalar string.");
  }
  const slashPath = input.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath) || slashPath.startsWith("//")) {
    throw new Error(`Absolute contract path is not allowed: ${input}`);
  }
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new Error(`Dot segments and empty path segments are not allowed: ${input}`);
  }
  return segments.join("/");
}

export function contractPathToNative(root: string, contractPath: string): string {
  const normalized = normalizeContractPath(contractPath);
  return path.join(root, ...normalized.split("/"));
}

export async function assertPathInsideRoot(rootInput: string, targetInput: string): Promise<void> {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Path escapes its declared root: ${target}`);
}

export async function assertNoLinkedPathSegment(rootInput: string, contractPath: string, allowMissingLeaf = false): Promise<void> {
  await assertPathHasNoLinkedSegments(rootInput, false);
  const root = await realpath(rootInput);
  const normalized = normalizeContractPath(contractPath);
  const segments = normalized.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Linked path segment is not allowed: ${normalized}`);
      }
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (allowMissingLeaf && code === "ENOENT" && index === segments.length - 1) {
        return;
      }
      throw error;
    }
  }
}

export async function assertPathHasNoLinkedSegments(pathInput: string, allowMissingLeaf: boolean): Promise<void> {
  const resolved = path.resolve(pathInput);
  const parsed = path.parse(resolved);
  const relativeSegments = resolved.slice(parsed.root.length).split(path.sep).filter((segment) => segment.length > 0);
  let current = parsed.root;
  for (let index = 0; index < relativeSegments.length; index += 1) {
    current = path.join(current, relativeSegments[index] ?? "");
    try {
      const item = await lstat(current);
      if (item.isSymbolicLink()) {
        throw new Error(`Linked or reparse path segment is not allowed: ${current}`);
      }
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code === "ENOENT" && allowMissingLeaf) {
        return;
      }
      throw error;
    }
  }
}

export async function assertOutputOutsideRoot(rootInput: string, outputInput: string): Promise<void> {
  const root = path.resolve(rootInput);
  const output = path.resolve(outputInput);
  await assertPathHasNoLinkedSegments(root, false);
  await assertPathHasNoLinkedSegments(output, true);
  const relative = path.relative(root, output);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`Output path must remain outside the protected root: ${output}`);
  }
  const rootReal = await realpath(root);
  let existing = output;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw error;
      }
      existing = parent;
    }
  }
  const resolvedRelative = path.relative(rootReal, existing);
  if (resolvedRelative === "" || (!resolvedRelative.startsWith(`..${path.sep}`) && resolvedRelative !== ".." && !path.isAbsolute(resolvedRelative))) {
    throw new Error(`Output path resolves inside the protected root: ${output}`);
  }
}

export function isLiveMusicVaultPath(input: string): boolean {
  const resolved = path.resolve(input).replace(/\\/g, "/").toLowerCase();
  const liveRoot = "c:/aibry/music-vault";
  return resolved === liveRoot || resolved.startsWith(`${liveRoot}/`);
}
