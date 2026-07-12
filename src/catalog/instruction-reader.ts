import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CatalogInstruction } from "./types.js";
import { assertPathHasNoAliases } from "../policy/source-of-truth.js";

export async function readCatalogInstruction(vaultPath: string): Promise<CatalogInstruction> {
  const instructionPath = path.join(vaultPath, "instructions", "catalog-structure.md");

  try {
    await assertPathHasNoAliases(vaultPath, instructionPath, "Canonical instruction");
    const fileStat = await stat(instructionPath);
    if (!fileStat.isFile()) {
      throw new Error(`Canonical instruction is not a file: ${instructionPath}`);
    }

    const content = await readFile(instructionPath, "utf8");
    return {
      path: instructionPath,
      lineCount: countLines(content),
      byteLength: Buffer.byteLength(content, "utf8")
    };
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new Error(`Canonical instruction does not exist: ${instructionPath}`, { cause: error });
    }

    if (error instanceof Error && error.message.startsWith("Canonical instruction")) {
      throw error;
    }

    throw new Error(`Unable to read canonical instruction as UTF-8: ${instructionPath}`, { cause: error });
  }
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.split(/\r?\n/).length;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
