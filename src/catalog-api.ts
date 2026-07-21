import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadCatalogIndex } from "./catalog-index-store.js";
import type { CatalogIndex, CatalogIndexSongRecord } from "./catalog/publish.js";

export type CatalogApiOptions = {
  indexPath: string;
  host?: string;
  port?: number;
};

export type CatalogApiServer = {
  server: Server;
  url: string;
};

type JsonRecord = Record<string, unknown>;

export function createCatalogApiHandler(index: CatalogIndex): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://catalog.local");
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method_not_allowed", allowed: ["GET"] });
        return;
      }

      if (url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "aibry-catalog-api",
          indexSchemaVersion: index.schemaVersion,
          generatedAt: index.generatedAt
        });
        return;
      }

      if (url.pathname === "/api/catalog") {
        sendJson(response, 200, catalogSummary(index));
        return;
      }

      if (url.pathname === "/api/contract") {
        sendJson(response, 200, index.contract);
        return;
      }

      if (url.pathname === "/api/songs") {
        sendJson(response, 200, filterSongs(index.songs, url.searchParams));
        return;
      }

      if (url.pathname.startsWith("/api/songs/")) {
        const catalogId = decodeURIComponent(url.pathname.slice("/api/songs/".length));
        const song = index.songs.find((candidate) => candidate.catalogId === catalogId);
        if (!song) {
          sendJson(response, 404, { error: "song_not_found", catalogId });
          return;
        }
        sendJson(response, 200, song);
        return;
      }

      if (url.pathname === "/api/album-releases") {
        sendJson(response, 200, index.albumReleases);
        return;
      }

      if (url.pathname.startsWith("/api/album-releases/")) {
        const relativePath = decodeURIComponent(url.pathname.slice("/api/album-releases/".length));
        const release = index.albumReleases.find((candidate) => candidate.relativePath === relativePath);
        if (!release) {
          sendJson(response, 404, { error: "album_release_not_found", relativePath });
          return;
        }
        sendJson(response, 200, release);
        return;
      }

      if (url.pathname === "/api/findings") {
        sendJson(response, 200, filterFindings(index.findings, url.searchParams));
        return;
      }

      sendJson(response, 404, { error: "not_found", path: url.pathname });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: "internal_error", message });
    }
  };
}

export async function startCatalogApi(options: CatalogApiOptions): Promise<CatalogApiServer> {
  const index = await loadCatalogIndex(options.indexPath);
  const server = createServer(createCatalogApiHandler(index));
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3873;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://${address.address}:${address.port}` };
}

function catalogSummary(index: CatalogIndex): JsonRecord {
  return {
    schemaVersion: index.schemaVersion,
    generatedAt: index.generatedAt,
    authority: index.authority,
    contractSchemaVersion: index.contract.schemaVersion,
    source: index.source,
    counts: index.counts,
    scopeNotes: index.scopeNotes
  };
}

function filterSongs(songs: CatalogIndexSongRecord[], searchParams: URLSearchParams): CatalogIndexSongRecord[] {
  const query = normalizeQuery(searchParams.get("q"));
  const release = normalizeQuery(searchParams.get("release"));
  return songs.filter((song) => {
    const matchesQuery = !query || [song.catalogId, song.title ?? "", song.directoryRelativePath, song.projectFileRelativePath]
      .some((value) => normalizeQuery(value).includes(query));
    const matchesRelease = !release || normalizeQuery(song.releaseContext.releaseContainerRelativePath ?? "").includes(release);
    return matchesQuery && matchesRelease;
  });
}

function filterFindings(findings: CatalogIndex["findings"], searchParams: URLSearchParams): CatalogIndex["findings"] {
  const severity = normalizeQuery(searchParams.get("severity"));
  const category = normalizeQuery(searchParams.get("category"));
  const source = normalizeQuery(searchParams.get("source"));
  return findings.filter((finding) => {
    const matchesSeverity = !severity || normalizeQuery(finding.severity) === severity;
    const matchesCategory = !category || normalizeQuery(finding.category) === category;
    const matchesSource = !source || normalizeQuery(finding.sourcePath).includes(source);
    return matchesSeverity && matchesCategory && matchesSource;
  });
}

function normalizeQuery(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${encoded}\n`);
}
