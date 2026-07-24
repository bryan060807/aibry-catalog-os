import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { BoundedCommandError, runBoundedCommand, renderCommandPreview, type BoundedCommandSpec } from "../src/operator-ui/command-runner.js";
import type { OperatorUiConfig } from "../src/operator-ui/contracts.js";
import { startOperatorUi } from "../src/operator-ui/server.js";
import { materializeGoldenLyricFixture } from "./helpers/lyric-source-fixture.js";
import { materializeGroundWireGospelFixture, materializeLyricSourceScoutFixture } from "./helpers/lyric-source-scout-fixture.js";

const PROJECT_ROOT = process.cwd();
const PUBLIC_ROOT = path.join(PROJECT_ROOT, "src", "operator-ui", "public");
const CLI_PATH = path.join(PROJECT_ROOT, "dist", "src", "cli.js");
const TOKEN = "operator-test-token";

test("operator console binds only to loopback and exposes the expected allowlisted routes", async () => {
  await withConsole(async ({ runtime }) => {
    assert.equal(runtime.host, "127.0.0.1");
    assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const expectedGets = ["/api/status", "/api/specialists", "/api/reports", "/api/activity"];
    for (const route of expectedGets) {
      const response = await fetch(`${baseUrl(runtime.url)}${route}`);
      assert.notEqual(response.status, 404, route);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.equal(await statusWithHost(runtime.port, "operator.example.test"), 400);
    const expectedPosts = [
      "/api/framework/typecheck", "/api/framework/build", "/api/catalog/refresh", "/api/lyric-source/scout", "/api/lyric-source/plan", "/api/lyric-source/materialize-fixture",
      "/api/artifacts/verify", "/api/decisions", "/api/lyric-source/build-script", "/api/lyric-source/dry-run",
      "/api/lyric-source/handoff"
    ];
    for (const route of expectedPosts) {
      const response = await post(runtime.url, route, {}, TOKEN);
      assert.notEqual(response.status, 404, route);
    }
    for (const forbidden of ["/api/apply", "/api/shell", "/api/command", "/api/reports/delete", "/api/reports/edit"]) {
      assert.equal((await post(runtime.url, forbidden, {}, TOKEN)).status, 404, forbidden);
    }
  }, { runCommand: successfulStub });
});

test("operator token, JSON body, schema, and body-size boundaries are enforced", async () => {
  await withConsole(async ({ runtime }) => {
    assert.equal((await post(runtime.url, "/api/framework/typecheck", {}, null)).status, 403);
    assert.equal((await post(runtime.url, "/api/framework/typecheck", {}, "wrong-token")).status, 403);
    assert.equal((await post(runtime.url, "/api/framework/typecheck", {}, TOKEN)).status, 200);
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/framework/typecheck`, {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Operator-Token": TOKEN }, body: "{}"
    })).status, 415);
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/framework/typecheck`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Operator-Token": TOKEN }, body: "{bad"
    })).status, 400);
    assert.equal((await post(runtime.url, "/api/framework/typecheck", { executable: "cmd.exe", args: ["/c", "whoami"] }, TOKEN)).status, 400);
    assert.equal((await post(runtime.url, "/api/framework/typecheck", { padding: "x".repeat(70_000) }, TOKEN)).status, 413);
  }, { runCommand: successfulStub });
});

test("reports browser rejects traversal, UNC, absolute, sibling-prefix, Vault, and linked paths", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const outside = path.join(root, "reports-backup");
    await mkdir(outside);
    await writeFile(path.join(outside, "outside.json"), "{}\n", "utf8");
    for (const candidate of [
      "../reports-backup/outside.json", "..\\reports-backup\\outside.json", "\\\\server\\share\\artifact.json",
      "C:\\AIBRY\\music-vault\\artifact.json", "C:\\Users\\bryan\\aibry\\projects\\aibry-catalog-os\\reports\\artifact.json"
    ]) {
      const response = await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=${encodeURIComponent(candidate)}`);
      assert.equal(response.status, 400, candidate);
    }
    const linkedTarget = path.join(root, "linked-target");
    await mkdir(linkedTarget);
    await writeFile(path.join(linkedTarget, "linked.json"), "{}\n", "utf8");
    const linkedDirectory = path.join(config.reportsRoot, "linked");
    await symlink(linkedTarget, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=linked%2Flinked.json`)).status, 400);
    assert.equal((await post(runtime.url, "/api/catalog/refresh", { outputPath: "C:\\AIBRY\\music-vault\\report.json" }, TOKEN)).status, 400);
  }, { runCommand: successfulStub });
});

test("specialist list is sourced from the real central registry", async () => {
  await withConsole(async ({ runtime }) => {
    const response = await fetch(`${baseUrl(runtime.url)}/api/specialists`);
    const body = await response.json() as { specialists: Array<{ id: string; authorityModes: string[] }> };
    assert.equal(response.status, 200);
    assert.ok(body.specialists.some((specialist) => specialist.id === "asos-kernel"));
    assert.deepEqual(body.specialists.find((specialist) => specialist.id === "lyric-source-proposal")?.authorityModes, ["PROPOSE"]);
    assert.deepEqual(body.specialists.find((specialist) => specialist.id === "lyric-source-batch-scout")?.authorityModes, ["OBSERVE"]);
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/specialists/windows-lyric-source-apply-builder`)).status, 200);
  }, { runCommand: successfulStub });
});

test("read-only refresh route crosses the real kernel CLI boundary using only a temporary Vault", async () => {
  await withConsole(async ({ runtime, config }) => {
    await setupRefreshVault(config.musicVaultRoot);
    const response = await post(runtime.url, "/api/catalog/refresh", { outputPath: "refresh/read-only-refresh.json" }, TOKEN);
    const body = await response.json() as { status: string; counts: { pendingApply: number }; outputPath: string; sha256: string; commandPreview: string };
    assert.equal(response.status, 200);
    assert.equal(body.status, "passed");
    assert.equal(body.counts.pendingApply, 0);
    assert.equal(body.outputPath, "refresh/read-only-refresh.json");
    assert.match(body.sha256, /^[a-f0-9]{64}$/);
    assert.match(body.commandPreview, /catalog workflow read-only-refresh/);
    const persisted = JSON.parse(await readFile(path.join(config.reportsRoot, body.outputPath), "utf8")) as { contract: string; safety: { applyEnabled: boolean; vaultMutation: string } };
    assert.equal(persisted.contract, "asos-workflow-read-only-refresh.v1.1");
    assert.equal(persisted.safety.applyEnabled, false);
    assert.equal(persisted.safety.vaultMutation, "none");
  });
});

test("proposal route uses the real specialist workflow and approval binds to the exact verified proposal", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeGoldenLyricFixture("the-violence-of-spring", path.join(root, "golden"));
    const inputRelative = "pilot/input/lyric-source-planning-input.v1.json";
    const fixtureRelative = "pilot/fixture-vault";
    await mkdir(path.dirname(path.join(config.reportsRoot, inputRelative)), { recursive: true });
    await cp(fixture.inputPath, path.join(config.reportsRoot, inputRelative));
    await cp(fixture.vault, path.join(config.reportsRoot, fixtureRelative), { recursive: true });
    const plan = await post(runtime.url, "/api/lyric-source/plan", { planningInputPath: inputRelative, outputDirectory: "pilot/run" }, TOKEN);
    const planBody = await plan.json() as {
      status: string;
      proposal: { proposalId: string; proposalSha256: string; operationCount: number };
      artifact: { path: string; sha256: string };
      commandPreview: string;
    };
    assert.equal(plan.status, 200);
    assert.equal(planBody.status, "awaiting-authorization");
    assert.equal(planBody.proposal.operationCount, 7);
    assert.match(planBody.commandPreview, /plan-lyric-source-migration/);
    assert.equal(await exists(path.join(config.reportsRoot, `${planBody.artifact.path}.workflow.json`)), true);
    const verification = await post(runtime.url, "/api/artifacts/verify", {
      path: planBody.artifact.path,
      expectedContract: "lyric-source-designation-proposal.v1",
      expectedSha256: planBody.artifact.sha256
    }, TOKEN);
    assert.equal(verification.status, 200);
    assert.equal((await verification.json() as { verified: boolean }).verified, true);
    assert.equal((await post(runtime.url, "/api/decisions", {
      proposalPath: planBody.artifact.path, decisionState: "approved", confirmation: "approve"
    }, TOKEN)).status, 400);
    const approval = await post(runtime.url, "/api/decisions", {
      proposalPath: planBody.artifact.path, decisionState: "approved", confirmation: "APPROVE"
    }, TOKEN);
    const approvalBody = await approval.json() as { proposalId: string; proposalSha256: string; outputPath: string; applyExecuted: boolean };
    assert.equal(approval.status, 200);
    assert.equal(approvalBody.proposalId, planBody.proposal.proposalId);
    assert.equal(approvalBody.proposalSha256, planBody.proposal.proposalSha256);
    assert.equal(approvalBody.applyExecuted, false);
    const staleDirectory = path.join(config.reportsRoot, "pilot", "stale");
    await mkdir(staleDirectory, { recursive: true });
    const stalePath = path.join(staleDirectory, "lyric-source-designation-proposal.v1.json");
    const stale = JSON.parse(await readFile(path.join(config.reportsRoot, planBody.artifact.path), "utf8")) as { proposalSha256: string };
    stale.proposalSha256 = "0".repeat(64);
    await writeFile(stalePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
    assert.notEqual((await post(runtime.url, "/api/decisions", {
      proposalPath: "pilot/stale/lyric-source-designation-proposal.v1.json", decisionState: "approved", confirmation: "APPROVE"
    }, TOKEN)).status, 200);
    assert.notEqual((await post(runtime.url, "/api/lyric-source/build-script", {
      proposalPath: planBody.artifact.path, decisionPath: "missing-decision.json", fixtureVaultPath: fixtureRelative, outputDirectory: "pilot/build"
    }, TOKEN)).status, 200);
    assert.notEqual((await post(runtime.url, "/api/lyric-source/dry-run", {
      proposalPath: planBody.artifact.path, scriptPath: "missing-script.ps1", fixtureVaultPath: fixtureRelative, outputDirectory: "pilot/dry-run"
    }, TOKEN)).status, 200);
  });
});

test("batch scout route uses the kernel workflow, seals planning input, and enables the UI proposal boundary", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeLyricSourceScoutFixture(path.join(root, "scout-source"));
    await cp(fixture.vault, config.musicVaultRoot, { recursive: true, force: true });
    const refresh = await post(runtime.url, "/api/catalog/refresh", { outputPath: "scout/refresh/read-only-refresh.json" }, TOKEN);
    assert.equal(refresh.status, 200);
    const response = await post(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: "scout/refresh/read-only-refresh.json",
      outputDirectory: "scout/pilot",
      minTracks: 2,
      maxTracks: 4
    }, TOKEN);
    const body = await response.json() as {
      status: string;
      selectedAlbum: string;
      includedCount: number;
      expectedOperationCount: number;
      planningInput: { path: string; sha256: string };
      scoutReport: { path: string; sha256: string };
      commandPreview: string;
    };
    assert.equal(response.status, 200);
    assert.equal(body.status, "passed");
    assert.equal(body.selectedAlbum, "alpha-signal");
    assert.equal(body.includedCount, 4);
    assert.equal(body.expectedOperationCount, 7);
    assert.match(body.commandPreview, /scout-lyric-source-batch/);
    assert.equal((await post(runtime.url, "/api/artifacts/verify", {
      path: body.planningInput.path,
      expectedContract: "lyric-source-planning-input.v1",
      expectedSha256: body.planningInput.sha256
    }, TOKEN)).status, 200);
    const plan = await post(runtime.url, "/api/lyric-source/plan", {
      planningInputPath: body.planningInput.path,
      outputDirectory: "scout/proposal"
    }, TOKEN);
    const planBody = await plan.json() as { status: string; proposal: { operationCount: number } };
    assert.equal(plan.status, 200);
    assert.equal(planBody.status, "awaiting-authorization");
    assert.equal(planBody.proposal.operationCount, 7);
    const appSource = await readFile(path.join(PUBLIC_ROOT, "app.js"), "utf8");
    const htmlSource = await readFile(path.join(PUBLIC_ROOT, "index.html"), "utf8");
    assert.match(appSource, /planning-input"\)\.value = result\.planningInput\.path/);
    assert.match(appSource, /Planning Input Sealed/);
    assert.match(htmlSource, /Find Safe Pilot Batch/);
    assert.doesNotMatch(htmlSource, /id="[^\"]*apply[^\"]*"/i);
  }, { runCommand: hybridStatusRunner });
});

test("Ground Wire Gospel console smoke refreshes, scouts tracks 01-04, seals planning input, and stops before approval", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeGroundWireGospelFixture(path.join(root, "ground-wire-source"));
    await cp(fixture.vault, config.musicVaultRoot, { recursive: true, force: true });
    const refresh = await post(runtime.url, "/api/catalog/refresh", { outputPath: "ground-wire/refresh/read-only-refresh.json" }, TOKEN);
    assert.equal(refresh.status, 200);
    const scout = await post(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: "ground-wire/refresh/read-only-refresh.json",
      outputDirectory: "ground-wire/pilot",
      minTracks: 2,
      maxTracks: 4
    }, TOKEN);
    const scoutBody = await scout.json() as {
      status: string;
      selectedAlbum: string;
      selectedTracks: string[];
      expectedOperationCount: number;
      planningInput: { path: string; sha256: string };
    };
    assert.equal(scout.status, 200);
    assert.equal(scoutBody.status, "passed");
    assert.equal(scoutBody.selectedAlbum, "ground-wire-gospel");
    assert.deepEqual(scoutBody.selectedTracks.map((item) => path.posix.basename(item)), [
      "01-rust-on-the-ignition", "02-oxidation-at-the-joints", "03-voltage-bleed", "04-scrap-iron-sermon"
    ]);
    assert.equal(scoutBody.expectedOperationCount, 7);
    assert.equal((await post(runtime.url, "/api/artifacts/verify", {
      path: scoutBody.planningInput.path,
      expectedContract: "lyric-source-planning-input.v1",
      expectedSha256: scoutBody.planningInput.sha256
    }, TOKEN)).status, 200);
    const proposal = await post(runtime.url, "/api/lyric-source/plan", {
      planningInputPath: scoutBody.planningInput.path,
      outputDirectory: "ground-wire/proposal"
    }, TOKEN);
    const proposalBody = await proposal.json() as { status: string; proposal: { operationCount: number } };
    assert.equal(proposal.status, 200);
    assert.equal(proposalBody.status, "awaiting-authorization");
    assert.equal(proposalBody.proposal.operationCount, 7);
    assert.equal(await exists(path.join(config.reportsRoot, "ground-wire", "proposal", "asos-authority-decision.v1.json")), false);
  }, { runCommand: hybridStatusRunner });
});

test("compatibility fixture route uses the kernel workflow and the UI gates Build Script on verified fixture success", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeGroundWireGospelFixture(path.join(root, "compatibility-source"));
    await cp(fixture.vault, config.musicVaultRoot, { recursive: true, force: true });
    assert.equal((await post(runtime.url, "/api/catalog/refresh", { outputPath: "compatibility/refresh.json" }, TOKEN)).status, 200);
    const scout = await post(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: "compatibility/refresh.json",
      outputDirectory: "compatibility/scout",
      minTracks: 2,
      maxTracks: 4
    }, TOKEN);
    const scoutBody = await scout.json() as { scoutReport: { path: string }; planningInput: { path: string } };
    assert.equal(scout.status, 200);
    const plan = await post(runtime.url, "/api/lyric-source/plan", {
      planningInputPath: scoutBody.planningInput.path,
      outputDirectory: "compatibility/proposal"
    }, TOKEN);
    const planBody = await plan.json() as { artifact: { path: string } };
    assert.equal(plan.status, 200);
    const approval = await post(runtime.url, "/api/decisions", {
      proposalPath: planBody.artifact.path,
      decisionState: "approved",
      confirmation: "APPROVE"
    }, TOKEN);
    const approvalBody = await approval.json() as { outputPath: string };
    assert.equal(approval.status, 200);
    assert.notEqual((await post(runtime.url, "/api/lyric-source/build-script", {
      proposalPath: planBody.artifact.path,
      decisionPath: approvalBody.outputPath,
      fixtureVaultPath: "compatibility/missing-fixture/fixture-vault",
      outputDirectory: "compatibility/build-before-fixture"
    }, TOKEN)).status, 200);
    const materialize = await post(runtime.url, "/api/lyric-source/materialize-fixture", {
      scoutReportPath: scoutBody.scoutReport.path,
      planningInputPath: scoutBody.planningInput.path,
      proposalPath: planBody.artifact.path,
      decisionPath: approvalBody.outputPath,
      outputDirectory: "compatibility/materialized"
    }, TOKEN);
    const body = await materialize.json() as {
      status: string;
      fixturePath: string;
      materializedFileCount: number;
      operationCount: number;
      evidenceFileCount: number;
      guardFileCount: number;
      fixtureSnapshotSha256: string;
      manifest: { path: string; sha256: string };
      workflow: { path: string; sha256: string };
      commandPreview: string;
    };
    assert.equal(materialize.status, 200);
    assert.equal(body.status, "passed");
    assert.equal(body.fixturePath, "compatibility/materialized/fixture-vault");
    assert.equal(body.materializedFileCount, 18);
    assert.equal(body.operationCount, 7);
    assert.equal(body.evidenceFileCount, 8);
    assert.equal(body.guardFileCount, 2);
    assert.match(body.fixtureSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.match(body.commandPreview, /materialize-lyric-source-compatibility-fixture/);
    assert.equal((await post(runtime.url, "/api/artifacts/verify", {
      path: body.manifest.path,
      expectedContract: "lyric-source-compatibility-fixture-manifest.v1",
      expectedSha256: body.manifest.sha256
    }, TOKEN)).status, 200);
    const reports = await fetch(`${baseUrl(runtime.url)}/api/reports`);
    const reportRows = (await reports.json() as { reports: Array<{ relativePath: string }> }).reports;
    assert.equal(reportRows.some((report) => report.relativePath.includes("/fixture-vault/")), false);
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=${encodeURIComponent(`${body.fixturePath}/.asos-fixture-vault`)}`)).status, 403);
    const appSource = await readFile(path.join(PUBLIC_ROOT, "app.js"), "utf8");
    const htmlSource = await readFile(path.join(PUBLIC_ROOT, "index.html"), "utf8");
    assert.match(appSource, /byId\("build-fixture"\)\.value = result\.fixturePath/);
    assert.match(appSource, /byId\("build-script"\)\.disabled = true/);
    assert.match(appSource, /byId\("build-script"\)\.disabled = false/);
    assert.match(htmlSource, /Build Compatibility Fixture/);
    assert.match(htmlSource, /<button id="build-script" type="button" disabled>/);
    assert.doesNotMatch(htmlSource, /id="[^"]*apply[^"]*"/i);
  }, { runCommand: hybridStatusRunner });
});

test("batch scout refusal does not create or enable a planning input", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeLyricSourceScoutFixture(path.join(root, "refusal-source"), "refusal");
    await cp(fixture.vault, config.musicVaultRoot, { recursive: true, force: true });
    assert.equal((await post(runtime.url, "/api/catalog/refresh", { outputPath: "refusal/refresh.json" }, TOKEN)).status, 200);
    const response = await post(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: "refusal/refresh.json",
      outputDirectory: "refusal/pilot",
      minTracks: 2,
      maxTracks: 4
    }, TOKEN);
    const body = await response.json() as { status: string; refusal: { code: string; details: string[] }; scoutReport: { path: string } };
    assert.equal(response.status, 200);
    assert.equal(body.status, "refused");
    assert.equal(body.refusal.code, "no-safe-batch");
    assert.match(body.refusal.details[0] ?? "", /release=one-track-only; eligibleEvidence=1; leadingReason=/i);
    assert.equal(await exists(path.join(config.reportsRoot, "refusal/pilot/lyric-source-planning-input.v1.json")), false);
    const appSource = await readFile(path.join(PUBLIC_ROOT, "app.js"), "utf8");
    assert.match(appSource, /generate-proposal"\)\.disabled = true/);
  }, { runCommand: hybridStatusRunner });
});

test("nonzero scout commands return bounded sanitized stderr without expanding the activity log", async () => {
  const secret = "operator-token-must-not-escape";
  const encoded = "Q".repeat(500);
  await withConsole(async ({ runtime, config }) => {
    const refreshRelative = "diagnostic/read-only-refresh.json";
    await mkdir(path.dirname(path.join(config.reportsRoot, refreshRelative)), { recursive: true });
    await writeFile(path.join(config.reportsRoot, refreshRelative), `${JSON.stringify({ contract: "asos-workflow-read-only-refresh.v1.1" })}\n`, "utf8");
    const response = await post(runtime.url, "/api/lyric-source/scout", {
      refreshReportPath: refreshRelative,
      outputDirectory: "diagnostic/scout",
      minTracks: 2,
      maxTracks: 4
    }, TOKEN);
    const body = await response.json() as {
      error: {
        message: string;
        diagnostic: { stage: string; kind: string; exitCode: number | null; stderr: string | null; stdout: string | null };
      };
    };
    assert.equal(response.status, 500);
    assert.match(body.error.message, /process exited with code 1/i);
    assert.equal(body.error.diagnostic.stage, "lyric-source-batch-scout");
    assert.equal(body.error.diagnostic.kind, "nonzero-exit");
    assert.equal(body.error.diagnostic.exitCode, 1);
    assert.match(body.error.diagnostic.stderr ?? "", /Refresh lineage SHA-256 mismatch/);
    assert.equal(Buffer.byteLength(body.error.diagnostic.stderr ?? "", "utf8") <= 2048, true);
    assert.equal(body.error.diagnostic.stdout, null);
    assert.doesNotMatch(body.error.diagnostic.stderr ?? "", new RegExp(secret));
    assert.doesNotMatch(body.error.diagnostic.stderr ?? "", new RegExp(encoded));
    assert.doesNotMatch(body.error.diagnostic.stderr ?? "", /SPECIAL_TOKEN=.*must-not-escape/);
    assert.doesNotMatch(body.error.diagnostic.stderr ?? "", /contentBase64:\s*Q+/);

    const activityResponse = await fetch(`${baseUrl(runtime.url)}/api/activity`);
    const activity = (await activityResponse.json() as { activities: Array<{ operation: string; refusalReason: string | null }> }).activities
      .find((item) => item.operation === "lyric-source-batch-scout");
    assert.ok(activity);
    assert.match(activity.refusalReason ?? "", /process exited with code 1/i);
    assert.doesNotMatch(activity.refusalReason ?? "", /Refresh lineage|SPECIAL_TOKEN|contentBase64/);
    const appSource = await readFile(path.join(PUBLIC_ROOT, "app.js"), "utf8");
    assert.match(appSource, /diagnostic\?\.stderr \|\| diagnostic\?\.stdout/);
  }, {
    runCommand: async (spec) => {
      if (spec.stage !== "lyric-source-batch-scout") return successfulStub(spec);
      throw new BoundedCommandError(
        spec.stage,
        "nonzero-exit",
        "process exited with code 1.",
        1,
        `irrelevant JSON stdout ${"z".repeat(5000)}`,
        `${"x".repeat(5000)}\nSPECIAL_TOKEN=${secret}\ncontentBase64: ${encoded}\nRefresh lineage SHA-256 mismatch for catalog-index.\n`
      );
    }
  });
});

test("stale disk artifacts and stdout-only artifacts cannot be reported as workflow success", async () => {
  let invoked = 0;
  await withConsole(async ({ runtime, config }) => {
    await setupRefreshVault(config.musicVaultRoot);
    const output = path.join(config.reportsRoot, "stale", "read-only-refresh.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({ contract: "asos-workflow-read-only-refresh.v1.1" })}\n`, "utf8");
    assert.equal((await post(runtime.url, "/api/catalog/refresh", { outputPath: "stale/read-only-refresh.json" }, TOKEN)).status, 409);
    assert.equal(invoked, 0);
    assert.equal((await post(runtime.url, "/api/catalog/refresh", { outputPath: "stdout-only/read-only-refresh.json" }, TOKEN)).status, 500);
    assert.equal(invoked, 1);
  }, {
    runCommand: async () => {
      invoked += 1;
      return { exitCode: 0, stdout: JSON.stringify({ contract: "asos-workflow-read-only-refresh.v1.1" }), stderr: "", elapsedMs: 1 };
    }
  });
});

test("bounded command runner surfaces timeout and command previews do not interpolate shell text", async () => {
  const spec: BoundedCommandSpec = {
    stage: "operator-ui-timeout-test", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: PROJECT_ROOT, timeoutMs: 250, maxBufferBytes: 16 * 1024
  };
  await assert.rejects(() => runBoundedCommand(spec), /operator-ui-timeout-test: process exceeded 250 ms/);
  const preview = renderCommandPreview("node", ["safe; Remove-Item C:\\unsafe", "$(Get-ChildItem)", "a'b"]);
  assert.equal(preview, "node 'safe; Remove-Item C:\\unsafe' '$(Get-ChildItem)' 'a''b'");
  const source = await readFile(path.join(PROJECT_ROOT, "src", "operator-ui", "routes.ts"), "utf8");
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /\/api\/(?:apply|shell|command)["']/);
});

test("reports browser is read-only and hides encoded operation payloads by default", async () => {
  await withConsole(async ({ runtime, config }) => {
    const relative = "browser/proposal.json";
    await mkdir(path.dirname(path.join(config.reportsRoot, relative)), { recursive: true });
    await writeFile(path.join(config.reportsRoot, relative), `${JSON.stringify({ contract: "fixture-report.v1", contentBase64: "dG9wLXNlY3JldC1wYXlsb2Fk" })}\n`, "utf8");
    const hidden = await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=${encodeURIComponent(relative)}&mode=raw`);
    const hiddenBody = await hidden.json() as { content: string };
    assert.equal(hidden.status, 200);
    assert.doesNotMatch(hiddenBody.content, /dG9wLXNlY3JldC1wYXlsb2Fk/);
    assert.match(hiddenBody.content, /encoded payload hidden/);
    const shown = await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=${encodeURIComponent(relative)}&mode=raw&showPayload=true`);
    assert.match((await shown.json() as { content: string }).content, /dG9wLXNlY3JldC1wYXlsb2Fk/);
    assert.equal((await fetch(`${baseUrl(runtime.url)}/api/reports/view?path=${encodeURIComponent(relative)}`, { method: "DELETE" })).status, 405);
  }, { runCommand: successfulStub });
});

test("fixture-only local smoke loads status and registry, plans and verifies a proposal, then closes cleanly", async () => {
  await withConsole(async ({ runtime, config, root }) => {
    const fixture = await materializeGoldenLyricFixture("black-box-psalms", path.join(root, "smoke-golden"));
    const inputRelative = "smoke/input/lyric-source-planning-input.v1.json";
    await mkdir(path.dirname(path.join(config.reportsRoot, inputRelative)), { recursive: true });
    await cp(fixture.inputPath, path.join(config.reportsRoot, inputRelative));
    const status = await fetch(`${baseUrl(runtime.url)}/api/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { bindAddress: string }).bindAddress.startsWith("127.0.0.1:"), true);
    const registry = await fetch(`${baseUrl(runtime.url)}/api/specialists`);
    assert.equal(registry.status, 200);
    assert.ok((await registry.json() as { specialists: unknown[] }).specialists.length > 0);
    const plan = await post(runtime.url, "/api/lyric-source/plan", {
      planningInputPath: inputRelative,
      outputDirectory: "smoke/run"
    }, TOKEN);
    const planBody = await plan.json() as { artifact: { path: string; sha256: string }; proposal: { operationCount: number } };
    assert.equal(plan.status, 200);
    assert.equal(planBody.proposal.operationCount, 8);
    const verification = await post(runtime.url, "/api/artifacts/verify", {
      path: planBody.artifact.path,
      expectedContract: "lyric-source-designation-proposal.v1",
      expectedSha256: planBody.artifact.sha256
    }, TOKEN);
    assert.equal(verification.status, 200);
    assert.equal((await verification.json() as { verified: boolean }).verified, true);
  }, { runCommand: hybridStatusRunner });
});

type ConsoleContext = {
  runtime: Awaited<ReturnType<typeof startOperatorUi>>;
  config: OperatorUiConfig;
  root: string;
};

async function withConsole(
  action: (context: ConsoleContext) => Promise<void>,
  options: { runCommand?: typeof successfulStub } = {}
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-operator-ui-"));
  const repositoryRoot = path.join(root, "repository");
  const reportsRoot = path.join(repositoryRoot, "reports");
  const musicVaultRoot = path.join(root, "fixture-music-vault");
  await mkdir(reportsRoot, { recursive: true });
  await mkdir(musicVaultRoot, { recursive: true });
  const config: OperatorUiConfig = {
    repositoryRoot, reportsRoot, musicVaultRoot, publicRoot: PUBLIC_ROOT, cliPath: CLI_PATH, host: "127.0.0.1", port: 0,
    requestBodyLimitBytes: 64 * 1024, commandTimeoutMs: 120_000
  };
  const runtime = await startOperatorUi({ config, token: TOKEN, runCommand: options.runCommand });
  try {
    await action({ runtime, config, root });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function successfulStub(spec: BoundedCommandSpec): Promise<{ exitCode: 0; stdout: string; stderr: string; elapsedMs: number }> {
  const stdout = spec.stage.includes("git-branch") ? "fixture-branch\n"
    : spec.stage.includes("git-dirty") ? " M fixture.ts\n"
      : spec.stage.includes("powershell") ? "5.1.19041.1\n" : "";
  return { exitCode: 0, stdout, stderr: "", elapsedMs: 1 };
}

async function hybridStatusRunner(spec: BoundedCommandSpec, signal?: AbortSignal) {
  if (spec.stage.startsWith("operator-status-")) return successfulStub(spec);
  return runBoundedCommand(spec, signal);
}

async function post(base: string, pathname: string, body: unknown, token: string | null): Promise<Response> {
  return fetch(`${baseUrl(base)}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Operator-Token": token } : {}) },
    body: JSON.stringify(body)
  });
}

function baseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

async function statusWithHost(port: number, hostHeader: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/status",
      method: "GET",
      headers: { Host: hostHeader }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

async function setupRefreshVault(vault: string): Promise<void> {
  const project = path.join(vault, "project-memory", "music", "singles", "operator-fixture-song");
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  for (const directory of ["lyrics", "audio", "metadata", "artwork", "licensing", "release-admin"]) {
    await mkdir(path.join(project, directory), { recursive: true });
  }
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Fixture structure\n", "utf8");
  await writeFile(path.join(project, "project.md"), "# Operator Fixture Song\n\nKnown source lyric path: Not yet established.\n", "utf8");
  await writeFile(path.join(project, "lyrics", "operator-fixture-song.txt"), "fixture lyric\n", "utf8");
  await writeFile(path.join(project, "audio", "operator-fixture-song.wav"), "audio\n", "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try { await readFile(filePath); return true; } catch { return false; }
}
