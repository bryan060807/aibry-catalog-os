import { readFile } from "node:fs/promises";
import type { CatalogIndex } from "./catalog/publish.js";

type JsonRecord = Record<string, unknown>;

export async function loadCatalogIndex(indexPath: string): Promise<CatalogIndex> {
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertCatalogIndex(parsed, indexPath);
  return parsed;
}

export function assertCatalogIndex(value: unknown, indexPath: string): asserts value is CatalogIndex {
  if (!isRecord(value) || value.schemaVersion !== "catalog-index.v1") {
    throw new Error(`Expected ${indexPath} to contain a catalog-index.v1 document.`);
  }
  if (!Array.isArray(value.songs) || !Array.isArray(value.albumReleases) || !Array.isArray(value.findings)) {
    throw new Error(`Catalog index ${indexPath} is missing required collections.`);
  }
  if (!isRecord(value.authority) || value.authority.vaultMutation !== "none") {
    throw new Error(`Catalog index ${indexPath} does not declare the required non-mutating authority boundary.`);
  }
  if (!isRecord(value.contract) || value.contract.schemaVersion !== "managed-song-contract.v1") {
    throw new Error(`Catalog index ${indexPath} is missing the active managed-song contract.`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
