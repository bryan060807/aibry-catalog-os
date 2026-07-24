import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertOutputOutsideRoot, assertPathHasNoLinkedSegments } from "../kernel/contract-path.js";

export function requireAbsoluteLocalPath(input: string, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.includes("\0")) throw new Error(`${label} must be a non-empty local path.`);
  if (input.startsWith("\\\\") || input.startsWith("//") || !path.win32.isAbsolute(input)) throw new Error(`${label} must be an absolute non-UNC Windows path.`);
  const tail = input.slice(path.win32.parse(input).root.length);
  if (tail.includes(":")) throw new Error(`${label} must not contain an alternate data stream.`);
  const normalized = path.resolve(input);
  if (normalized.split(path.sep).some((segment) => segment === "." || segment === "..")) throw new Error(`${label} contains an unsafe segment.`);
  return normalized;
}

export async function assertSafeExistingDirectory(input: string, label: string): Promise<string> {
  const resolved = requireAbsoluteLocalPath(input, label);
  await assertPathHasNoLinkedSegments(resolved, false);
  const item = await lstat(resolved);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`${label} must be a normal local directory.`);
  return realpath(resolved);
}

export async function assertSafeExistingFile(input: string, label: string): Promise<string> {
  const resolved = requireAbsoluteLocalPath(input, label);
  await assertPathHasNoLinkedSegments(resolved, false);
  const item = await lstat(resolved);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`${label} must be a normal local file.`);
  return realpath(resolved);
}

export async function assertSafeNewPath(input: string, label: string): Promise<string> {
  const resolved = requireAbsoluteLocalPath(input, label);
  await assertPathHasNoLinkedSegments(resolved, true);
  try {
    await lstat(resolved);
    throw new Error(`${label} must be new and unused: ${resolved}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith(`${label} must be new`)) throw error;
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") throw error;
  }
  return resolved;
}

export async function assertOutsideVault(vaultRoot: string, candidate: string, label: string): Promise<void> {
  await assertOutputOutsideRoot(vaultRoot, candidate);
  const vault = path.resolve(vaultRoot).toLowerCase();
  const target = path.resolve(candidate).toLowerCase();
  if (vault === target) throw new Error(`${label} must be distinct from the Vault root.`);
}

export function assertDistinctPaths(entries: Array<{ path: string; label: string }>): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const normalized = path.resolve(entry.path).toLowerCase();
    const previous = seen.get(normalized);
    if (previous) throw new Error(`${entry.label} conflicts with ${previous}.`);
    seen.set(normalized, entry.label);
  }
}

export function assertChildPath(rootInput: string, childInput: string, label: string): void {
  const root = path.resolve(rootInput);
  const child = path.resolve(childInput);
  const relative = path.relative(root, child);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its intended root.`);
  }
}
