import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OperatorUiConfig } from "../../src/operator-ui/contracts.js";
import { startOperatorUi } from "../../src/operator-ui/server.js";
import { materializeGroundWireGospelFixture } from "./lyric-source-scout-fixture.js";

const token = "fixture-only-compatibility-smoke";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-compatibility-ui-smoke-"));
  const repositoryRoot = path.join(root, "repository");
  const reportsRoot = path.join(repositoryRoot, "reports");
  const musicVaultRoot = path.join(root, "fixture-music-vault");
  await mkdir(reportsRoot, { recursive: true });
  const source = await materializeGroundWireGospelFixture(path.join(root, "source"));
  await cp(source.vault, musicVaultRoot, { recursive: true, force: true });
  const config: OperatorUiConfig = {
    repositoryRoot,
    reportsRoot,
    musicVaultRoot,
    publicRoot: path.resolve(process.cwd(), "src", "operator-ui", "public"),
    cliPath: path.resolve(process.cwd(), "dist", "src", "cli.js"),
    host: "127.0.0.1",
    port: 0,
    requestBodyLimitBytes: 64 * 1024,
    commandTimeoutMs: 300_000
  };
  const runtime = await startOperatorUi({ config, token });
  try {
    const refresh = await post<{ outputPath: string }>(runtime.url, "/api/catalog/refresh", { outputPath: "smoke/refresh.json" });
    const scout = await post<{
      selectedAlbum: string;
      selectedTracks: string[];
      planningInput: { path: string };
      scoutReport: { path: string };
    }>(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: refresh.outputPath,
      outputDirectory: "smoke/scout",
      minTracks: 2,
      maxTracks: 4
    });
    const proposal = await post<{ artifact: { path: string }; proposal: { operationCount: number } }>(runtime.url, "/api/lyric-source/plan", {
      planningInputPath: scout.planningInput.path,
      outputDirectory: "smoke/proposal"
    });
    const decision = await post<{ outputPath: string }>(runtime.url, "/api/decisions", {
      proposalPath: proposal.artifact.path,
      decisionState: "approved",
      confirmation: "APPROVE"
    });
    const fixture = await post<{
      fixturePath: string;
      materializedFileCount: number;
      operationCount: number;
      evidenceFileCount: number;
      guardFileCount: number;
      fixtureSnapshotSha256: string;
    }>(runtime.url, "/api/lyric-source/materialize-fixture", {
      scoutReportPath: scout.scoutReport.path,
      planningInputPath: scout.planningInput.path,
      proposalPath: proposal.artifact.path,
      decisionPath: decision.outputPath,
      outputDirectory: "smoke/compatibility-fixture"
    });
    const fixtureRepeat = await post<{
      fixtureSnapshotSha256: string;
    }>(runtime.url, "/api/lyric-source/materialize-fixture", {
      scoutReportPath: scout.scoutReport.path,
      planningInputPath: scout.planningInput.path,
      proposalPath: proposal.artifact.path,
      decisionPath: decision.outputPath,
      outputDirectory: "smoke/compatibility-fixture-repeat"
    });
    if (fixtureRepeat.fixtureSnapshotSha256 !== fixture.fixtureSnapshotSha256) {
      throw new Error(`Fixture snapshot mismatch: ${fixture.fixtureSnapshotSha256} != ${fixtureRepeat.fixtureSnapshotSha256}`);
    }
    const build = await post<{ scriptSha256: string; operatorPackagePath: string; handoffArtifactSha256: string }>(runtime.url, "/api/lyric-source/build-script", {
      proposalPath: proposal.artifact.path,
      decisionPath: decision.outputPath,
      fixtureVaultPath: fixture.fixturePath,
      outputDirectory: "smoke/build"
    });
    const dryRun = await post<{ status: string; scenarioCount: number; failedScenarios: number }>(runtime.url, "/api/lyric-source/dry-run", {
      proposalPath: proposal.artifact.path,
      scriptPath: "smoke/build/lyric-source-windows-apply.v1.ps1",
      fixtureVaultPath: fixture.fixturePath,
      outputDirectory: "smoke/dry-run"
    });
    const handoff = await post<{ status: string; artifactCount: number; applyExecuted: boolean }>(runtime.url, "/api/lyric-source/handoff", {
      packageManifestPath: build.operatorPackagePath
    });
    process.stdout.write(`${JSON.stringify({
      contract: "compatibility-fixture-ui-smoke-result.v1",
      selectedAlbum: scout.selectedAlbum,
      selectedTracks: scout.selectedTracks,
      proposalOperationCount: proposal.proposal.operationCount,
      fixture: {
        path: fixture.fixturePath,
        materializedFileCount: fixture.materializedFileCount,
        operationCount: fixture.operationCount,
        evidenceFileCount: fixture.evidenceFileCount,
        guardFileCount: fixture.guardFileCount,
        snapshotRun1Sha256: fixture.fixtureSnapshotSha256,
        snapshotRun2Sha256: fixtureRepeat.fixtureSnapshotSha256,
        repeatable: true
      },
      build: {
        scriptSha256: build.scriptSha256,
        operatorPackagePath: build.operatorPackagePath,
        handoffArtifactSha256: build.handoffArtifactSha256
      },
      dryRun: { status: dryRun.status, scenarioCount: dryRun.scenarioCount, failedScenarios: dryRun.failedScenarios },
      handoff: { status: handoff.status, artifactCount: handoff.artifactCount, applyExecuted: handoff.applyExecuted },
      safety: { liveVaultAccess: false, liveApplyExecuted: false, productionApprovalCreated: false }
    }, null, 2)}\n`);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function post<T>(base: string, pathname: string, body: Record<string, unknown>): Promise<T> {
  const parsed = new URL(base);
  const response = await fetch(`${parsed.protocol}//${parsed.host}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Operator-Token": token },
    body: JSON.stringify(body)
  });
  const result = await response.json() as unknown;
  if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(result)}`);
  return result as T;
}

await main();
