import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { OperatorRequestError } from "./contracts.js";

export function validateReportRelativePath(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new OperatorRequestError(400, "invalid-report-path", "A non-empty reports-relative path is required.");
  }
  if (input.includes("\0") || input.includes(":")) {
    throw new OperatorRequestError(400, "invalid-report-path", "Alternate data streams and NUL characters are not allowed.");
  }
  const slashPath = input.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    input.startsWith("\\\\") ||
    path.win32.isAbsolute(input) ||
    path.posix.isAbsolute(slashPath)
  ) {
    throw new OperatorRequestError(400, "absolute-report-path", "Only reports-relative paths are allowed.");
  }
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new OperatorRequestError(400, "path-traversal", "Dot segments and duplicate separators are not allowed.");
  }
  return segments.join("/");
}

export async function ensureReportsRoot(reportsRootInput: string): Promise<string> {
  const reportsRoot = path.resolve(reportsRootInput);
  await mkdir(reportsRoot, { recursive: true });
  await assertNoLinkedSegments(reportsRoot, false);
  const item = await lstat(reportsRoot);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new OperatorRequestError(500, "unsafe-reports-root", "The reports root must be a normal local directory.");
  }
  return realpath(reportsRoot);
}

export async function resolveReportPath(
  reportsRootInput: string,
  relativeInput: unknown,
  options: { mustExist: boolean; expectedKind?: "file" | "directory" } = { mustExist: true }
): Promise<{ relativePath: string; absolutePath: string }> {
  const reportsRoot = await ensureReportsRoot(reportsRootInput);
  const relativePath = validateReportRelativePath(relativeInput);
  const absolutePath = path.resolve(reportsRoot, ...relativePath.split("/"));
  assertLexicallyInside(reportsRoot, absolutePath);
  await assertNoLinkedSegments(absolutePath, !options.mustExist);
  if (options.mustExist) {
    let item;
    try {
      item = await stat(absolutePath);
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
      if (code === "ENOENT") {
        throw new OperatorRequestError(404, "report-not-found", `Reports artifact does not exist: ${relativePath}`);
      }
      throw error;
    }
    if (options.expectedKind === "file" && !item.isFile()) {
      throw new OperatorRequestError(400, "report-not-file", `${relativePath} is not a file.`);
    }
    if (options.expectedKind === "directory" && !item.isDirectory()) {
      throw new OperatorRequestError(400, "report-not-directory", `${relativePath} is not a directory.`);
    }
    const real = await realpath(absolutePath);
    assertLexicallyInside(reportsRoot, real);
  }
  return { relativePath, absolutePath };
}

export function toReportRelativePath(reportsRootInput: string, absoluteInput: string): string {
  const reportsRoot = path.resolve(reportsRootInput);
  const absolutePath = path.resolve(absoluteInput);
  assertLexicallyInside(reportsRoot, absolutePath);
  return path.relative(reportsRoot, absolutePath).split(path.sep).join("/");
}

export function assertDistinctOutputPaths(paths: string[]): void {
  const normalized = paths.map((candidate) => path.resolve(candidate).toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new OperatorRequestError(400, "duplicate-output-path", "Output paths must be distinct.");
  }
}

function assertLexicallyInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new OperatorRequestError(400, "reports-boundary", "The requested path must remain beneath the reports root.");
  }
}

async function assertNoLinkedSegments(targetInput: string, allowMissingTail: boolean): Promise<void> {
  const target = path.resolve(targetInput);
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const item = await lstat(current);
      if (item.isSymbolicLink()) {
        throw new OperatorRequestError(400, "linked-path-segment", `Linked or reparse path segments are not allowed: ${current}`);
      }
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
      if (allowMissingTail && code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
