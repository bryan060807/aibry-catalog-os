import { timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { canonicalFilename, verifyArtifact } from "../artifacts/handoff-specialist.js";
import { sha256Bytes } from "../kernel/canonical-json.js";
import { buildReviewDecision, verifyReviewDecision } from "../lyric-source/approval.js";
import type {
  LyricSourceBatchScoutReport,
  LyricSourceCompatibilityFixtureManifest,
  LyricSourceDesignationProposal,
  LyricSourceDryRunReport,
  LyricSourceOperatorPackage
} from "../lyric-source/contracts.js";
import { verifyCompatibilityFixtureManifest } from "../lyric-source/compatibility-fixture-builder.js";
import { parseAndVerifyLyricSourceProposal } from "../lyric-source/proposal-specialist.js";
import { listSpecialists, describeSpecialist } from "../specialists/registry.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import { BoundedCommandError, boundedCommandDiagnostic, runBoundedCommand, renderCommandPreview, type BoundedCommandResult, type BoundedCommandSpec } from "./command-runner.js";
import { OperatorRequestError, type OperatorActivity, type OperatorUiConfig } from "./contracts.js";
import { assertDistinctOutputPaths, resolveReportPath, toReportRelativePath, validateReportRelativePath } from "./path-policy.js";

const ALLOWED_ARTIFACT_CONTRACTS = new Set([
  "asos-authority-decision.v1",
  "asos-workflow-read-only-refresh.v1.1",
  "asos-workflow-run.v1",
  "lyric-source-apply-dry-run-report.v1",
  "lyric-source-apply-handoff.v1",
  "lyric-source-batch-scout-report.v1",
  "lyric-source-compatibility-fixture-manifest.v1",
  "lyric-source-designation-proposal.v1",
  "lyric-source-independent-validation-report.v1",
  "lyric-source-operator-package.v1",
  "lyric-source-planning-input.v1",
  "lyric-source-windows-apply-script.v1"
]);

type CommandRunner = (spec: BoundedCommandSpec, signal?: AbortSignal) => Promise<BoundedCommandResult>;

export type OperatorRouteContext = {
  config: OperatorUiConfig;
  token: string;
  startedAt: string;
  activities: OperatorActivity[];
  outputLocks: Set<string>;
  runCommand?: CommandRunner;
};

export function createOperatorApiRouter(context: OperatorRouteContext) {
  const execute = context.runCommand ?? runBoundedCommand;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return false;
    setApiHeaders(response);
    const abortController = new AbortController();
    const abort = (): void => {
      if (!response.writableEnded) abortController.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      if (request.method === "GET") {
        await handleGet(context, execute, url, response, abortController.signal);
        return true;
      }
      if (request.method === "POST") {
        requireOperatorToken(request, context.token);
        const body = await readJsonBody(request, context.config.requestBodyLimitBytes);
        await handlePost(context, execute, url, body, response, abortController.signal);
        return true;
      }
      throw new OperatorRequestError(405, "method-not-allowed", "This API route does not accept that HTTP method.");
    } catch (error: unknown) {
      writeError(response, error);
      return true;
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  };
}

async function handleGet(
  context: OperatorRouteContext,
  execute: CommandRunner,
  url: URL,
  response: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  if (url.pathname === "/api/status") {
    writeJson(response, 200, await buildStatus(context, execute, signal));
    return;
  }
  if (url.pathname === "/api/specialists") {
    writeJson(response, 200, { contract: "specialist-registry.v1", specialists: listSpecialists() });
    return;
  }
  if (url.pathname.startsWith("/api/specialists/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/specialists/".length));
    if (!/^[a-z0-9-]+$/.test(id)) throw new OperatorRequestError(400, "invalid-specialist-id", "Specialist ID is invalid.");
    const specialist = describeSpecialist(id);
    if (!specialist) throw new OperatorRequestError(404, "unknown-specialist", `Unknown specialist: ${id}`);
    writeJson(response, 200, specialist);
    return;
  }
  if (url.pathname === "/api/reports") {
    writeJson(response, 200, { reportsRoot: context.config.reportsRoot, reports: await listReports(context.config.reportsRoot) });
    return;
  }
  if (url.pathname === "/api/reports/view") {
    const requested = await resolveReportPath(context.config.reportsRoot, url.searchParams.get("path"), { mustExist: true, expectedKind: "file" });
    if (isCompatibilityFixturePayloadPath(requested.relativePath)) {
      throw new OperatorRequestError(403, "fixture-payload-hidden", "Compatibility fixture payload bytes are not exposed by the reports browser; inspect the verified fixture manifest instead.");
    }
    const showPayload = url.searchParams.get("showPayload") === "true";
    const mode = url.searchParams.get("mode") === "raw" ? "raw" : "formatted";
    const bytes = await readFile(requested.absolutePath);
    const text = bytes.toString("utf8");
    const value = parseJsonOrText(text);
    const safeValue = showPayload ? value : redactEncodedPayloads(value);
    writeJson(response, 200, {
      relativePath: requested.relativePath,
      mode,
      encodedPayloadsVisible: showPayload,
      sha256: sha256Bytes(bytes),
      content: mode === "raw"
        ? typeof safeValue === "string" ? safeValue : `${JSON.stringify(safeValue, null, 2)}\n`
        : safeValue
    });
    return;
  }
  if (url.pathname === "/api/activity") {
    writeJson(response, 200, { activities: context.activities.slice(-100).reverse() });
    return;
  }
  throw new OperatorRequestError(404, "route-not-found", "API route not found.");
}

async function handlePost(
  context: OperatorRouteContext,
  execute: CommandRunner,
  url: URL,
  body: unknown,
  response: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  if (url.pathname === "/api/framework/typecheck" || url.pathname === "/api/framework/build") {
    const object = requireObject(body);
    rejectUnknownKeys(object, []);
    const script = url.pathname.endsWith("typecheck") ? "typecheck" : "build";
    const args = ["run", script];
    const result = await runActivity(context, `framework-${script}`, null, null, async () => execute({
      stage: `operator-ui-${script}`,
      executable: npmExecutable(),
      args,
      cwd: context.config.repositoryRoot,
      timeoutMs: 180_000
    }, signal));
    writeJson(response, 200, { status: "passed", elapsedMs: result.elapsedMs, commandPreview: renderCommandPreview("npm", args) });
    return;
  }
  if (url.pathname === "/api/catalog/refresh") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["outputPath", "decisionsPath"]);
    const output = await resolveOutput(context, requireString(object.outputPath, "outputPath"), ".json");
    const decisions = object.decisionsPath === undefined || object.decisionsPath === null || object.decisionsPath === ""
      ? null
      : await resolveReportPath(context.config.reportsRoot, object.decisionsPath, { mustExist: true, expectedKind: "file" });
    const args = ["catalog", "workflow", "read-only-refresh", "--vault", context.config.musicVaultRoot, "--output", output.absolutePath];
    if (decisions) args.push("--decisions", decisions.absolutePath);
    await withOutputLocks(context, [output.absolutePath], async () => {
      await assertOutputsAbsent([output.absolutePath]);
      const started = Date.now();
      const result = await runActivity(context, "catalog-read-only-refresh", output.relativePath, null, async () => execute(cliSpec(context, "catalog-read-only-refresh", args), signal));
      const artifact = await requireFreshJsonArtifact(output.absolutePath, started, "asos-workflow-read-only-refresh.v1.1");
      const parsed = artifact.value;
      if (!isRecord(parsed.safety) || parsed.safety.applyEnabled !== false || parsed.safety.vaultMutation !== "none" || !isRecord(parsed.counts) || !Object.hasOwn(parsed.counts, "pendingApply")) {
        throw new OperatorRequestError(502, "unsafe-workflow-report", "Read-only refresh report failed its kernel safety checks.");
      }
      updateLastActivity(context, output.relativePath, artifact.sha256);
      writeJson(response, 200, {
        status: "passed",
        counts: parsed.counts,
        findingRoutes: parsed.findingRoutes,
        outputPath: output.relativePath,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        elapsedMs: result.elapsedMs,
        commandPreview: renderCatalogPreview(context, args)
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/scout") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["refreshReportPath", "outputDirectory", "minTracks", "maxTracks"]);
    const refresh = await resolveReportPath(context.config.reportsRoot, requireString(object.refreshReportPath, "refreshReportPath"), { mustExist: true, expectedKind: "file" });
    await requireJsonContract(refresh.absolutePath, "asos-workflow-read-only-refresh.v1.1");
    const minTracks = requireIntegerRange(object.minTracks, "minTracks", 2, 4);
    const maxTracks = requireIntegerRange(object.maxTracks, "maxTracks", minTracks, 4);
    const report = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-batch-scout-report.v1");
    const planning = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-planning-input.v1");
    const workflow = await canonicalOutputInDirectory(context, object.outputDirectory, "asos-workflow-run.v1");
    assertDistinctOutputPaths([report.absolutePath, planning.absolutePath, workflow.absolutePath]);
    const outputDirectory = path.dirname(report.absolutePath);
    const args = [
      "catalog", "workflow", "scout-lyric-source-batch",
      "--vault", context.config.musicVaultRoot,
      "--refresh-report", refresh.absolutePath,
      "--output-directory", outputDirectory,
      "--min-tracks", String(minTracks),
      "--max-tracks", String(maxTracks)
    ];
    await withOutputLocks(context, [report.absolutePath, planning.absolutePath, workflow.absolutePath], async () => {
      await assertOutputsAbsent([report.absolutePath, planning.absolutePath, workflow.absolutePath]);
      const started = Date.now();
      const command = await runActivity(context, "lyric-source-batch-scout", report.relativePath, null, async () => execute(cliSpec(context, "lyric-source-batch-scout", args), signal));
      const reportArtifact = await requireFreshJsonArtifact(report.absolutePath, started, "lyric-source-batch-scout-report.v1");
      const scout = reportArtifact.value as unknown as LyricSourceBatchScoutReport;
      if (scout.authority !== "OBSERVE" || scout.vaultMutation !== "none" || scout.safety.applyEnabled !== false || scout.safety.approvalCreated !== false || scout.safety.applyScriptCreated !== false) {
        throw new OperatorRequestError(502, "unsafe-scout-report", "Scout report failed its read-only safety contract.");
      }
      const reportVerification = await verifyArtifact(report.absolutePath, scout.contract, reportArtifact.sha256, report.absolutePath);
      if (!reportVerification.verified) {
        throw new OperatorRequestError(502, "scout-report-verification-failed", "Persisted scout report failed artifact verification.");
      }
      const workflowArtifact = await requireFreshJsonArtifact(workflow.absolutePath, started, "asos-workflow-run.v1");
      if (scout.refusal) {
        if (await pathExists(planning.absolutePath)) {
          throw new OperatorRequestError(502, "refused-scout-created-planning-input", "A refused scout must not create a planning input.");
        }
        const activity = context.activities.at(-1);
        if (activity) {
          activity.status = "refused";
          activity.refusalReason = scout.refusal.message;
        }
        updateLastActivity(context, report.relativePath, reportArtifact.sha256);
        writeJson(response, 200, {
          status: "refused",
          refusal: scout.refusal,
          scoutReport: { path: report.relativePath, sha256: reportArtifact.sha256, byteSize: reportArtifact.byteSize },
          workflow: { path: workflow.relativePath, sha256: workflowArtifact.sha256 },
          elapsedMs: command.elapsedMs,
          commandPreview: renderCatalogPreview(context, args)
        });
        return;
      }
      if (!scout.planningInputSha256 || !scout.planningInputPath) {
        throw new OperatorRequestError(502, "planning-input-identity-missing", "Successful scout report did not bind a planning input.");
      }
      const planningArtifact = await requireFreshJsonArtifact(planning.absolutePath, started, "lyric-source-planning-input.v1");
      if (planningArtifact.sha256 !== scout.planningInputSha256 || path.resolve(scout.planningInputPath) !== planning.absolutePath) {
        throw new OperatorRequestError(502, "planning-input-binding-mismatch", "Scout report planning-input identity does not match the sealed artifact.");
      }
      const planningVerification = await verifyArtifact(planning.absolutePath, "lyric-source-planning-input.v1", planningArtifact.sha256, planning.absolutePath);
      if (!planningVerification.verified) {
        throw new OperatorRequestError(502, "planning-input-verification-failed", "Sealed planning input failed artifact verification.");
      }
      updateLastActivity(context, report.relativePath, reportArtifact.sha256);
      writeJson(response, 200, {
        status: "passed",
        selectedAlbum: scout.selectedReleaseContainer,
        selectedTracks: scout.selectedIncludedProjects,
        naturalBoundary: scout.naturalBatchBoundary,
        includedCount: scout.selectedIncludedProjects.length,
        expectedOperationCount: scout.expectedOperationCount,
        baselineCounts: scout.baselineCounts,
        expectedCounts: scout.expectedCounts,
        candidates: scout.candidateProjects.filter((candidate) => scout.selectedIncludedProjects.includes(candidate.projectPath)),
        exclusions: scout.excludedProjects,
        scoutReport: { path: report.relativePath, sha256: reportArtifact.sha256, byteSize: reportArtifact.byteSize },
        planningInput: { path: planning.relativePath, sha256: planningArtifact.sha256, byteSize: planningArtifact.byteSize },
        workflow: { path: workflow.relativePath, sha256: workflowArtifact.sha256 },
        elapsedMs: command.elapsedMs,
        commandPreview: renderCatalogPreview(context, args)
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/plan") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["planningInputPath", "outputDirectory"]);
    const input = await resolveReportPath(context.config.reportsRoot, requireString(object.planningInputPath, "planningInputPath"), { mustExist: true, expectedKind: "file" });
    await requireJsonContract(input.absolutePath, "lyric-source-planning-input.v1");
    const output = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-designation-proposal.v1");
    const args = ["catalog", "workflow", "plan-lyric-source-migration", "--input", input.absolutePath, "--output", output.absolutePath];
    await withOutputLocks(context, [output.absolutePath], async () => {
      await assertOutputsAbsent([output.absolutePath, `${output.absolutePath}.review-inbox.json`, `${output.absolutePath}.workflow.json`]);
      const started = Date.now();
      const result = await runActivity(context, "lyric-source-plan", output.relativePath, null, async () => execute(cliSpec(context, "lyric-source-plan", args), signal));
      const artifact = await requireFreshJsonArtifact(output.absolutePath, started, "lyric-source-designation-proposal.v1");
      const proposal = parseAndVerifyLyricSourceProposal(artifact.bytes.toString("utf8"), output.absolutePath);
      const verification = await verifyArtifact(output.absolutePath, proposal.contract, artifact.sha256, output.absolutePath, {
        proposalId: proposal.proposalId,
        proposalSha256: proposal.proposalSha256
      });
      if (!verification.verified || verification.supersessionState !== "active") {
        throw new OperatorRequestError(409, "proposal-verification-failed", "Generated proposal did not pass governed artifact verification.");
      }
      updateLastActivity(context, output.relativePath, artifact.sha256);
      writeJson(response, 200, {
        status: "awaiting-authorization",
        proposal: summarizeProposal(proposal),
        artifact: { path: output.relativePath, sha256: artifact.sha256, byteSize: artifact.byteSize },
        elapsedMs: result.elapsedMs,
        commandPreview: renderCatalogPreview(context, args),
        authorizationMessage: "AWAITING HUMAN AUTHORIZATION"
      });
    });
    return;
  }
  if (url.pathname === "/api/artifacts/verify") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["path", "expectedContract", "expectedSha256"]);
    const artifactPath = await resolveReportPath(context.config.reportsRoot, requireString(object.path, "path"), { mustExist: true, expectedKind: "file" });
    const expectedContract = requireString(object.expectedContract, "expectedContract");
    if (!ALLOWED_ARTIFACT_CONTRACTS.has(expectedContract)) {
      throw new OperatorRequestError(400, "contract-not-allowlisted", "Artifact contract is not allowlisted in the operator console.");
    }
    const bytes = await readFile(artifactPath.absolutePath);
    const expectedSha256 = object.expectedSha256 === undefined
      ? sha256Bytes(bytes)
      : requireSha256(object.expectedSha256, "expectedSha256");
    const verification = await runActivity(context, "artifact-verify", artifactPath.relativePath, null, () => verifyArtifact(
      artifactPath.absolutePath,
      expectedContract,
      expectedSha256,
      artifactPath.absolutePath
    ));
    updateLastActivity(context, artifactPath.relativePath, verification.identity.actualSha256);
    writeJson(response, verification.verified ? 200 : 409, {
      ...verification,
      commandPreview: renderCatalogPreview(context, [
        "catalog", "artifact", "verify",
        "--file", artifactPath.absolutePath,
        "--expected-contract", expectedContract,
        "--expected-sha256", expectedSha256
      ])
    });
    return;
  }
  if (url.pathname === "/api/decisions") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["proposalPath", "decisionState", "confirmation"]);
    const proposalPath = await resolveReportPath(context.config.reportsRoot, requireString(object.proposalPath, "proposalPath"), { mustExist: true, expectedKind: "file" });
    const state = requireDecisionState(object.decisionState);
    if (state === "approved" && object.confirmation !== "APPROVE") {
      throw new OperatorRequestError(400, "approval-confirmation-required", "Type APPROVE exactly to approve the exact proposal.");
    }
    const proposalBytes = await readFile(proposalPath.absolutePath);
    const proposal = parseAndVerifyLyricSourceProposal(proposalBytes.toString("utf8"), proposalPath.absolutePath);
    const proposalArtifactSha256 = sha256Bytes(proposalBytes);
    const verification = await verifyArtifact(proposalPath.absolutePath, proposal.contract, proposalArtifactSha256, proposalPath.absolutePath, {
      proposalId: proposal.proposalId,
      proposalSha256: proposal.proposalSha256
    });
    if (!verification.verified || verification.supersessionState !== "active") {
      throw new OperatorRequestError(409, "proposal-not-approvable", "Proposal structural, canonical, decoded-byte, or supersession verification failed.");
    }
    const output = await canonicalSibling(context, proposalPath.absolutePath, "asos-authority-decision.v1");
    await withOutputLocks(context, [output.absolutePath], async () => {
      await assertOutputsAbsent([output.absolutePath]);
      const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, state, new Date().toISOString());
      await runActivity(context, `proposal-${state}`, output.relativePath, null, async () => {
        await writeFile(output.absolutePath, `${JSON.stringify(decision, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        const persisted = JSON.parse(await readFile(output.absolutePath, "utf8")) as AuthorityTransitionDecision;
        if (!verifyReviewDecision(persisted) || persisted.proposalId !== proposal.proposalId || persisted.proposalSha256 !== proposal.proposalSha256) {
          throw new OperatorRequestError(500, "decision-persistence-failed", "Persisted decision failed exact proposal binding verification.");
        }
      });
      const bytes = await readFile(output.absolutePath);
      const hash = sha256Bytes(bytes);
      updateLastActivity(context, output.relativePath, hash);
      writeJson(response, 200, {
        status: state,
        proposalId: proposal.proposalId,
        proposalSha256: proposal.proposalSha256,
        decisionArtifactSha256: decision.decisionArtifactSha256,
        artifactSha256: hash,
        outputPath: output.relativePath,
        applyExecuted: false,
        commandPreview: "Catalog approval module: exact governed decision artifact (no APPLY)"
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/materialize-fixture") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["scoutReportPath", "planningInputPath", "proposalPath", "decisionPath", "outputDirectory"]);
    const scout = await resolveReportPath(context.config.reportsRoot, requireString(object.scoutReportPath, "scoutReportPath"), { mustExist: true, expectedKind: "file" });
    const planning = await resolveReportPath(context.config.reportsRoot, requireString(object.planningInputPath, "planningInputPath"), { mustExist: true, expectedKind: "file" });
    const proposal = await resolveReportPath(context.config.reportsRoot, requireString(object.proposalPath, "proposalPath"), { mustExist: true, expectedKind: "file" });
    const decision = await resolveReportPath(context.config.reportsRoot, requireString(object.decisionPath, "decisionPath"), { mustExist: true, expectedKind: "file" });
    await requireJsonContract(scout.absolutePath, "lyric-source-batch-scout-report.v1");
    await requireJsonContract(planning.absolutePath, "lyric-source-planning-input.v1");
    const persistedProposal = parseAndVerifyLyricSourceProposal(await readFile(proposal.absolutePath, "utf8"), proposal.absolutePath);
    const persistedDecision = JSON.parse(await readFile(decision.absolutePath, "utf8")) as AuthorityTransitionDecision;
    if (
      !verifyReviewDecision(persistedDecision) || persistedDecision.decisionState !== "approved" ||
      persistedDecision.proposalId !== persistedProposal.proposalId || persistedDecision.proposalSha256 !== persistedProposal.proposalSha256
    ) throw new OperatorRequestError(409, "approval-binding-invalid", "Compatibility fixture materialization requires an approved decision bound to the exact proposal.");
    const outputRelative = validateReportRelativePath(requireString(object.outputDirectory, "outputDirectory"));
    const output = await resolveReportPath(context.config.reportsRoot, outputRelative, { mustExist: false, expectedKind: "directory" });
    const fixture = await resolveReportPath(context.config.reportsRoot, `${outputRelative}/fixture-vault`, { mustExist: false, expectedKind: "directory" });
    const manifest = await canonicalOutputInDirectory(context, outputRelative, "lyric-source-compatibility-fixture-manifest.v1");
    const workflow = await canonicalOutputInDirectory(context, outputRelative, "asos-workflow-run.v1");
    const args = [
      "catalog", "workflow", "materialize-lyric-source-compatibility-fixture",
      "--scout-report", scout.absolutePath,
      "--planning-input", planning.absolutePath,
      "--proposal", proposal.absolutePath,
      "--decision", decision.absolutePath,
      "--output-directory", output.absolutePath
    ];
    await withOutputLocks(context, [output.absolutePath, fixture.absolutePath, manifest.absolutePath, workflow.absolutePath], async () => {
      await assertOutputsAbsent([output.absolutePath]);
      const started = Date.now();
      const command = await runActivity(context, "lyric-source-materialize-fixture", manifest.relativePath, null, async () => execute(cliSpec(context, "lyric-source-materialize-fixture", args), signal));
      const manifestArtifact = await requireFreshJsonArtifact(manifest.absolutePath, started, "lyric-source-compatibility-fixture-manifest.v1");
      const fixtureManifest = await verifyCompatibilityFixtureManifest(manifest.absolutePath);
      const manifestVerification = await verifyArtifact(manifest.absolutePath, fixtureManifest.contract, manifestArtifact.sha256, manifest.absolutePath);
      if (!manifestVerification.verified || !sameResolvedPath(fixtureManifest.fixtureRoot, fixture.absolutePath)) {
        throw new OperatorRequestError(502, "compatibility-fixture-verification-failed", "Persisted compatibility fixture failed structural or path verification.");
      }
      const workflowArtifact = await requireFreshJsonArtifact(workflow.absolutePath, started, "asos-workflow-run.v1");
      updateLastActivity(context, manifest.relativePath, manifestArtifact.sha256);
      writeJson(response, 200, {
        status: "passed",
        fixturePath: fixture.relativePath,
        materializedFileCount: fixtureManifest.materializedFiles.length,
        operationCount: fixtureManifest.operationTargets.length,
        evidenceFileCount: fixtureManifest.evidenceFiles.length,
        guardFileCount: fixtureManifest.guardFiles.length,
        fixtureSnapshotSha256: fixtureManifest.fixtureSnapshotSha256,
        manifest: { path: manifest.relativePath, sha256: manifestArtifact.sha256, byteSize: manifestArtifact.byteSize },
        workflow: { path: workflow.relativePath, sha256: workflowArtifact.sha256, byteSize: workflowArtifact.byteSize },
        elapsedMs: command.elapsedMs,
        commandPreview: renderCatalogPreview(context, args),
        applyExecuted: false
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/build-script") {
    const inputs = await resolveBuildInputs(context, body);
    const args = buildWorkflowArgs(inputs);
    const outputs = [
      inputs.script.absolutePath,
      inputs.dryRun.absolutePath,
      `${inputs.script.absolutePath}.workflow.json`,
      `${inputs.script.absolutePath}.operator-package`
    ];
    await withOutputLocks(context, outputs, async () => {
      await assertOutputsAbsent(outputs);
      const result = await runActivity(context, "lyric-source-build-script", inputs.script.relativePath, null, async () => execute(cliSpec(context, "lyric-source-build-script", args), signal));
      const details = await inspectBuiltPackage(context, inputs.script.absolutePath);
      updateLastActivity(context, inputs.script.relativePath, details.scriptSha256);
      writeJson(response, 200, {
        status: "passed",
        ...details,
        elapsedMs: result.elapsedMs,
        commandPreview: renderCatalogPreview(context, args)
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/dry-run") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["proposalPath", "scriptPath", "fixtureVaultPath", "outputDirectory"]);
    const proposal = await resolveReportPath(context.config.reportsRoot, requireString(object.proposalPath, "proposalPath"), { mustExist: true, expectedKind: "file" });
    const script = await resolveReportPath(context.config.reportsRoot, requireString(object.scriptPath, "scriptPath"), { mustExist: true, expectedKind: "file" });
    const fixture = await resolveReportPath(context.config.reportsRoot, requireString(object.fixtureVaultPath, "fixtureVaultPath"), { mustExist: true, expectedKind: "directory" });
    const packageDecision = path.join(`${script.absolutePath}.operator-package`, canonicalFilename("asos-authority-decision.v1"));
    const decision = await resolveReportPath(context.config.reportsRoot, toReportRelativePath(context.config.reportsRoot, packageDecision), { mustExist: true, expectedKind: "file" });
    const output = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-apply-dry-run-report.v1");
    const args = ["catalog", "workflow", "dry-run-lyric-source-apply", "--proposal", proposal.absolutePath, "--script", script.absolutePath, "--fixture-vault", fixture.absolutePath, "--decision", decision.absolutePath, "--output", output.absolutePath];
    await withOutputLocks(context, [output.absolutePath], async () => {
      await assertOutputsAbsent([output.absolutePath, `${output.absolutePath}.workflow.json`]);
      const started = Date.now();
      const result = await runActivity(context, "lyric-source-dry-run", output.relativePath, null, async () => execute(cliSpec(context, "lyric-source-dry-run", args), signal));
      const artifact = await requireFreshJsonArtifact(output.absolutePath, started, "lyric-source-apply-dry-run-report.v1");
      const report = artifact.value as unknown as LyricSourceDryRunReport;
      if (report.status !== "passed" || report.liveVaultAccess !== false || report.mutationTarget !== "temporary-mirror-only" || report.failures.length !== 0) {
        throw new OperatorRequestError(409, "dry-run-failed", "Compatibility report did not pass its temporary-mirror safety criteria.");
      }
      updateLastActivity(context, output.relativePath, artifact.sha256);
      writeJson(response, 200, {
        status: report.status,
        outputPath: output.relativePath,
        sha256: artifact.sha256,
        proposalIdentity: report.proposalIdentity,
        scriptIdentity: report.scriptIdentity,
        powerShellVersion: report.powerShellVersion,
        scenarioCount: report.scenarios?.length ?? 0,
        failedScenarios: report.scenarios?.filter((scenario) => scenario.observed !== scenario.expected).length ?? 0,
        elapsedMs: result.elapsedMs,
        commandPreview: renderCatalogPreview(context, args)
      });
    });
    return;
  }
  if (url.pathname === "/api/lyric-source/handoff") {
    const object = requireObject(body);
    rejectUnknownKeys(object, ["packageManifestPath"]);
    const manifestPath = await resolveReportPath(context.config.reportsRoot, requireString(object.packageManifestPath, "packageManifestPath"), { mustExist: true, expectedKind: "file" });
    const result = await runActivity(context, "lyric-source-handoff-verify", manifestPath.relativePath, null, () => verifyOperatorPackage(context, manifestPath.absolutePath));
    updateLastActivity(context, manifestPath.relativePath, result.manifestSha256);
    writeJson(response, 200, {
      status: "eligible-for-guarded-apply",
      ...result,
      commandPreview: renderCatalogPreview(context, [
        "catalog", "artifact", "verify",
        "--file", manifestPath.absolutePath,
        "--expected-contract", "lyric-source-operator-package.v1",
        "--expected-sha256", result.manifestSha256
      ]),
      applyExecuted: false
    });
    return;
  }
  throw new OperatorRequestError(404, "route-not-found", "API route not found.");
}

async function buildStatus(context: OperatorRouteContext, execute: CommandRunner, signal: AbortSignal): Promise<Record<string, unknown>> {
  const gitBranch = await optionalCommand(execute, {
    stage: "operator-status-git-branch",
    executable: "git.exe",
    args: ["-c", `safe.directory=${context.config.repositoryRoot.replace(/\\/g, "/")}`, "branch", "--show-current"],
    cwd: context.config.repositoryRoot,
    timeoutMs: 10_000,
    maxBufferBytes: 128 * 1024
  }, signal);
  const gitStatus = await optionalCommand(execute, {
    stage: "operator-status-git-dirty",
    executable: "git.exe",
    args: ["-c", `safe.directory=${context.config.repositoryRoot.replace(/\\/g, "/")}`, "status", "--porcelain"],
    cwd: context.config.repositoryRoot,
    timeoutMs: 10_000,
    maxBufferBytes: 256 * 1024
  }, signal);
  const powerShell = await optionalCommand(execute, {
    stage: "operator-status-powershell",
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    cwd: context.config.repositoryRoot,
    timeoutMs: 30_000,
    maxBufferBytes: 64 * 1024
  }, signal);
  const buildExists = await pathExists(context.config.cliPath);
  return {
    contract: "catalog-operator-status.v1",
    repositoryPath: context.config.repositoryRoot,
    musicVaultPath: context.config.musicVaultRoot,
    reportsPath: context.config.reportsRoot,
    nodeVersion: process.version,
    powerShellVersion: powerShell?.stdout.trim() || null,
    currentBranch: gitBranch?.stdout.trim() || null,
    dirtyWorkingTreeCount: gitStatus ? gitStatus.stdout.split(/\r?\n/).filter(Boolean).length : null,
    frameworkBuildStatus: buildExists ? "compiled" : "missing",
    serverStartTime: context.startedAt,
    bindAddress: `${context.config.host}:${context.config.port}`,
    commandPreviews: {
      typecheck: "npm run typecheck",
      build: "npm run build"
    }
  };
}

async function resolveBuildInputs(context: OperatorRouteContext, body: unknown) {
  const object = requireObject(body);
  rejectUnknownKeys(object, ["proposalPath", "decisionPath", "fixtureVaultPath", "outputDirectory"]);
  const proposal = await resolveReportPath(context.config.reportsRoot, requireString(object.proposalPath, "proposalPath"), { mustExist: true, expectedKind: "file" });
  const decision = await resolveReportPath(context.config.reportsRoot, requireString(object.decisionPath, "decisionPath"), { mustExist: true, expectedKind: "file" });
  const fixture = await resolveReportPath(context.config.reportsRoot, requireString(object.fixtureVaultPath, "fixtureVaultPath"), { mustExist: true, expectedKind: "directory" });
  const script = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-windows-apply-script.v1");
  const dryRun = await canonicalOutputInDirectory(context, object.outputDirectory, "lyric-source-apply-dry-run-report.v1");
  assertDistinctOutputPaths([script.absolutePath, dryRun.absolutePath]);
  const proposalArtifact = parseAndVerifyLyricSourceProposal(await readFile(proposal.absolutePath, "utf8"), proposal.absolutePath);
  const decisionArtifact = JSON.parse(await readFile(decision.absolutePath, "utf8")) as AuthorityTransitionDecision;
  if (
    !verifyReviewDecision(decisionArtifact) ||
    decisionArtifact.decisionState !== "approved" ||
    decisionArtifact.proposalId !== proposalArtifact.proposalId ||
    decisionArtifact.proposalSha256 !== proposalArtifact.proposalSha256
  ) {
    throw new OperatorRequestError(409, "approval-binding-invalid", "Build requires an approved decision bound to the exact verified proposal.");
  }
  const fixtureManifestPath = path.join(path.dirname(fixture.absolutePath), canonicalFilename("lyric-source-compatibility-fixture-manifest.v1"));
  let fixtureManifest: LyricSourceCompatibilityFixtureManifest;
  try {
    fixtureManifest = await verifyCompatibilityFixtureManifest(fixtureManifestPath);
  } catch (error: unknown) {
    throw new OperatorRequestError(409, "compatibility-fixture-required", error instanceof Error ? error.message : "Build requires a verified compatibility fixture.");
  }
  const [proposalBytes, decisionBytes] = await Promise.all([readFile(proposal.absolutePath), readFile(decision.absolutePath)]);
  if (
    !sameResolvedPath(fixtureManifest.fixtureRoot, fixture.absolutePath) ||
    !sameResolvedPath(fixtureManifest.proposal.path, proposal.absolutePath) ||
    !sameResolvedPath(fixtureManifest.decision.path, decision.absolutePath) ||
    fixtureManifest.proposal.proposalId !== proposalArtifact.proposalId ||
    fixtureManifest.proposal.proposalSha256 !== proposalArtifact.proposalSha256 ||
    fixtureManifest.proposal.artifactSha256 !== sha256Bytes(proposalBytes) ||
    fixtureManifest.decision.decisionArtifactSha256 !== decisionArtifact.decisionArtifactSha256 ||
    fixtureManifest.decision.artifactSha256 !== sha256Bytes(decisionBytes)
  ) throw new OperatorRequestError(409, "compatibility-fixture-binding-invalid", "Compatibility fixture does not bind the exact build proposal and decision artifacts.");
  return { proposal, decision, fixture, script, dryRun };
}

function buildWorkflowArgs(input: Awaited<ReturnType<typeof resolveBuildInputs>>): string[] {
  return [
    "catalog", "workflow", "build-windows-lyric-source-apply",
    "--proposal", input.proposal.absolutePath,
    "--approval", input.decision.absolutePath,
    "--fixture-vault", input.fixture.absolutePath,
    "--dry-run-report", input.dryRun.absolutePath,
    "--output", input.script.absolutePath
  ];
}

async function inspectBuiltPackage(context: OperatorRouteContext, scriptPath: string): Promise<{
  proposalSha256: string;
  decisionArtifactSha256: string;
  scriptSha256: string;
  dryRunReportSha256: string;
  handoffArtifactSha256: string;
  operationCount: number;
  operatorPackagePath: string;
  handoffEligibilityState: "eligible-for-guarded-apply";
  applyExecuted: false;
}> {
  const scriptBytes = await readFile(scriptPath);
  const packageRoot = `${scriptPath}.operator-package`;
  const manifestPath = path.join(packageRoot, canonicalFilename("lyric-source-operator-package.v1"));
  const manifest = await requireJsonContract(manifestPath, "lyric-source-operator-package.v1") as unknown as LyricSourceOperatorPackage;
  const dryRunArtifact = manifest.artifacts.find((artifact) => artifact.role === "dry-run-report");
  const decisionArtifact = manifest.artifacts.find((artifact) => artifact.role === "decision");
  const handoffArtifact = manifest.artifacts.find((artifact) => artifact.role === "handoff");
  if (!dryRunArtifact || !decisionArtifact || !handoffArtifact || manifest.artifacts.length !== 5) {
    throw new OperatorRequestError(502, "operator-package-incomplete", "Builder did not emit the complete five-artifact operator package.");
  }
  return {
    proposalSha256: manifest.proposalSha256,
    decisionArtifactSha256: decisionArtifact.sha256,
    scriptSha256: sha256Bytes(scriptBytes),
    dryRunReportSha256: dryRunArtifact.sha256,
    handoffArtifactSha256: handoffArtifact.sha256,
    operationCount: (JSON.parse(await readFile(path.join(packageRoot, handoffArtifact.canonicalPath), "utf8")) as { operations: unknown[] }).operations.length,
    operatorPackagePath: toReportRelativePath(context.config.reportsRoot, manifestPath),
    handoffEligibilityState: "eligible-for-guarded-apply",
    applyExecuted: false
  };
}

async function verifyOperatorPackage(context: OperatorRouteContext, manifestPath: string) {
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as LyricSourceOperatorPackage;
  const manifestVerification = await verifyArtifact(manifestPath, "lyric-source-operator-package.v1", manifestSha256, manifestPath, {
    proposalId: manifest.proposalId,
    proposalSha256: manifest.proposalSha256
  });
  if (!manifestVerification.verified || manifest.artifacts.length !== 5 || manifest.executionCommands.length !== 1 || manifest.safety.liveApplyExecuted !== false) {
    throw new OperatorRequestError(409, "operator-package-invalid", "Operator package manifest failed structural verification.");
  }
  const packageRoot = path.dirname(manifestPath);
  const proposalDefinition = manifest.artifacts.find((artifact) => artifact.role === "proposal");
  const decisionDefinition = manifest.artifacts.find((artifact) => artifact.role === "decision");
  const dryRunDefinition = manifest.artifacts.find((artifact) => artifact.role === "dry-run-report");
  const scriptDefinition = manifest.artifacts.find((artifact) => artifact.role === "script");
  const handoffDefinition = manifest.artifacts.find((artifact) => artifact.role === "handoff");
  if (!proposalDefinition || !decisionDefinition || !dryRunDefinition || !scriptDefinition || !handoffDefinition) {
    throw new OperatorRequestError(409, "operator-package-incomplete", "Operator package roles are incomplete.");
  }
  const proposalPath = packageArtifactPath(packageRoot, proposalDefinition.canonicalPath);
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  const expectations = {
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    proposalArtifactSha256: proposalDefinition.sha256,
    decisionArtifactSha256: (JSON.parse(await readFile(packageArtifactPath(packageRoot, decisionDefinition.canonicalPath), "utf8")) as AuthorityTransitionDecision).decisionArtifactSha256,
    dryRunReportSha256: dryRunDefinition.sha256,
    scriptSha256: scriptDefinition.sha256
  };
  for (const artifact of manifest.artifacts) {
    const artifactPath = packageArtifactPath(packageRoot, artifact.canonicalPath);
    const verification = await verifyArtifact(artifactPath, artifact.contract, artifact.sha256, artifactPath, expectations);
    if (!verification.verified || verification.identity.byteSize !== artifact.byteSize) {
      throw new OperatorRequestError(409, "operator-package-artifact-invalid", `${artifact.role} failed package verification.`);
    }
  }
  return {
    manifestSha256,
    proposalSha256: proposal.proposalSha256,
    decisionArtifactSha256: expectations.decisionArtifactSha256,
    scriptSha256: scriptDefinition.sha256,
    dryRunReportSha256: dryRunDefinition.sha256,
    handoffArtifactSha256: handoffDefinition.sha256,
    operationCount: proposal.operations.length,
    artifactCount: manifest.artifacts.length,
    packagePath: toReportRelativePath(context.config.reportsRoot, manifestPath)
  };
}

function packageArtifactPath(packageRoot: string, canonicalPath: string): string {
  if (path.basename(canonicalPath) !== canonicalPath || canonicalPath.includes(":")) {
    throw new OperatorRequestError(409, "operator-package-path-invalid", "Package artifact paths must be canonical filenames.");
  }
  return path.join(packageRoot, canonicalPath);
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function isCompatibilityFixturePayloadPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.toLowerCase() === "fixture-vault");
}

async function listReports(reportsRoot: string): Promise<Array<Record<string, unknown>>> {
  const root = path.resolve(reportsRoot);
  await mkdir(root, { recursive: true });
  const output: Array<Record<string, unknown>> = [];
  await walkReports(root, root, output);
  return output.sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
}

async function walkReports(root: string, directory: string, output: Array<Record<string, unknown>>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "fixture-vault") continue;
      await walkReports(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(absolutePath);
    const item = await stat(absolutePath);
    const parsed = parseJsonOrText(bytes.toString("utf8"));
    const record = isRecord(parsed) ? parsed : null;
    output.push({
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      contract: typeof record?.contract === "string" ? record.contract : detectScriptContract(bytes.toString("utf8")),
      size: item.size,
      modifiedTime: item.mtime.toISOString(),
      sha256: sha256Bytes(bytes),
      status: entry.name.includes(".superseded.") ? "superseded" : "active",
      proposalId: typeof record?.proposalId === "string" ? record.proposalId : null,
      workflow: typeof record?.workflow === "string" ? record.workflow : null
    });
  }
}

async function canonicalOutputInDirectory(context: OperatorRouteContext, directoryInput: unknown, contract: string) {
  const directory = validateReportRelativePath(requireString(directoryInput, "outputDirectory"));
  return resolveReportPath(context.config.reportsRoot, `${directory}/${canonicalFilename(contract)}`, { mustExist: false, expectedKind: "file" });
}

async function canonicalSibling(context: OperatorRouteContext, sourcePath: string, contract: string) {
  const relativeDirectory = toReportRelativePath(context.config.reportsRoot, path.dirname(sourcePath));
  return resolveReportPath(context.config.reportsRoot, `${relativeDirectory}/${canonicalFilename(contract)}`, { mustExist: false, expectedKind: "file" });
}

async function resolveOutput(context: OperatorRouteContext, relativeInput: string, extension: string) {
  const relative = validateReportRelativePath(relativeInput);
  if (path.posix.extname(relative).toLowerCase() !== extension) {
    throw new OperatorRequestError(400, "invalid-output-extension", `Output must use the ${extension} extension.`);
  }
  return resolveReportPath(context.config.reportsRoot, relative, { mustExist: false, expectedKind: "file" });
}

async function assertOutputsAbsent(paths: string[]): Promise<void> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      throw new OperatorRequestError(409, "output-conflict", `Output already exists: ${candidate}`);
    }
  }
}

async function requireFreshJsonArtifact(filePath: string, startedAt: number, contract: string) {
  const bytes = await readFile(filePath);
  const item = await stat(filePath);
  if (item.mtimeMs + 2_000 < startedAt) {
    throw new OperatorRequestError(502, "stale-output-artifact", "Required output was not created after the operation began.");
  }
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (!isRecord(value) || value.contract !== contract) {
    throw new OperatorRequestError(502, "output-contract-mismatch", `Expected persisted ${contract} output.`);
  }
  return { bytes, value, byteSize: item.size, sha256: sha256Bytes(bytes) };
}

async function requireJsonContract(filePath: string, contract: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.contract !== contract) {
    throw new OperatorRequestError(400, "input-contract-mismatch", `Expected ${contract} artifact.`);
  }
  return parsed;
}

function summarizeProposal(proposal: LyricSourceDesignationProposal): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    authority: proposal.authority,
    approvalState: proposal.approvalState,
    includedProjects: proposal.includedProjects,
    excludedProjects: proposal.excludedProjects,
    operationCount: proposal.operations.length,
    expectedFindingDeltas: proposal.expectedFindingDeltas,
    operations: proposal.operations.map((operation) => ({
      order: operation.order,
      path: operation.path,
      currentSha256: operation.currentSha256,
      proposedSha256: operation.proposedSha256,
      currentByteCount: operation.currentByteCount,
      proposedByteCount: operation.proposedByteCount
    })),
    preconditions: proposal.preconditions,
    rollbackRequirements: proposal.rollbackRequirements,
    independentValidatorCriteria: proposal.independentValidatorCriteria,
    applyEnabled: false,
    vaultMutation: "none"
  };
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new OperatorRequestError(415, "json-required", "POST requests must use application/json.");
  }
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new OperatorRequestError(413, "request-too-large", `Request body exceeds ${limit} bytes.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new OperatorRequestError(413, "request-too-large", `Request body exceeds ${limit} bytes.`);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OperatorRequestError(400, "invalid-json", "Request body is not valid JSON.");
  }
}

function requireOperatorToken(request: IncomingMessage, expected: string): void {
  const provided = request.headers["x-operator-token"];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value || !safeEqual(value, expected)) {
    throw new OperatorRequestError(403, "operator-token-required", "A valid per-start operator token is required.");
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function runActivity<T>(
  context: OperatorRouteContext,
  operation: string,
  outputPath: string | null,
  outputSha256: string | null,
  action: () => Promise<T>
): Promise<T> {
  const activity: OperatorActivity = {
    time: new Date().toISOString(),
    operation,
    status: "running",
    durationMs: null,
    outputPath,
    outputSha256,
    refusalReason: null
  };
  context.activities.push(activity);
  const started = Date.now();
  try {
    const result = await action();
    activity.status = "passed";
    return result;
  } catch (error: unknown) {
    activity.status = error instanceof OperatorRequestError && error.statusCode < 500 ? "refused" : "failed";
    activity.refusalReason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    activity.durationMs = Date.now() - started;
    if (context.activities.length > 200) context.activities.splice(0, context.activities.length - 200);
  }
}

function updateLastActivity(context: OperatorRouteContext, outputPath: string, outputSha256: string): void {
  const activity = context.activities.at(-1);
  if (activity) {
    activity.outputPath = outputPath;
    activity.outputSha256 = outputSha256;
  }
}

async function withOutputLocks<T>(context: OperatorRouteContext, paths: string[], action: () => Promise<T>): Promise<T> {
  const keys = paths.map((candidate) => path.resolve(candidate).toLowerCase());
  if (keys.some((key) => context.outputLocks.has(key))) {
    throw new OperatorRequestError(409, "output-busy", "An operation is already writing one of the requested outputs.");
  }
  keys.forEach((key) => context.outputLocks.add(key));
  try {
    return await action();
  } finally {
    keys.forEach((key) => context.outputLocks.delete(key));
  }
}

function cliSpec(context: OperatorRouteContext, stage: string, args: string[]): BoundedCommandSpec {
  return {
    stage,
    executable: process.execPath,
    args: [context.config.cliPath, ...args],
    cwd: context.config.repositoryRoot,
    timeoutMs: context.config.commandTimeoutMs,
    maxBufferBytes: 1024 * 1024
  };
}

function renderCatalogPreview(context: OperatorRouteContext, args: string[]): string {
  const relativeCli = path.relative(context.config.repositoryRoot, context.config.cliPath).split(path.sep).join("\\");
  return renderCommandPreview("node", [relativeCli, ...args]);
}

async function optionalCommand(execute: CommandRunner, spec: BoundedCommandSpec, signal: AbortSignal): Promise<BoundedCommandResult | null> {
  try {
    return await execute(spec, signal);
  } catch {
    return null;
  }
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new OperatorRequestError(400, "invalid-body", "JSON request body must be an object.");
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperatorRequestError(400, "invalid-field", `${name} must be a non-empty string.`);
  }
  return value;
}

function requireIntegerRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new OperatorRequestError(400, "invalid-field", `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function requireSha256(value: unknown, name: string): string {
  const hash = requireString(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new OperatorRequestError(400, "invalid-sha256", `${name} must be a SHA-256 value.`);
  return hash;
}

function requireDecisionState(value: unknown): AuthorityTransitionDecision["decisionState"] {
  if (value !== "approved" && value !== "rejected" && value !== "deferred") {
    throw new OperatorRequestError(400, "invalid-decision-state", "Decision state must be approved, rejected, or deferred.");
  }
  return value;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new OperatorRequestError(400, "unexpected-fields", `Unexpected request fields: ${unexpected.join(", ")}`);
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactEncodedPayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEncodedPayloads);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "contentBase64" && typeof child === "string"
      ? `[encoded payload hidden: ${child.length} characters]`
      : redactEncodedPayloads(child)
  ]));
}

function detectScriptContract(text: string): string | null {
  return /^# contract: lyric-source-windows-apply-script\.v1$/m.test(text)
    ? "lyric-source-windows-apply-script.v1"
    : null;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  if (error instanceof BoundedCommandError) {
    writeJson(response, 500, {
      error: {
        code: "bounded-command-failed",
        message: error.message,
        details: [],
        diagnostic: boundedCommandDiagnostic(error)
      }
    });
    return;
  }
  const requestError = error instanceof OperatorRequestError
    ? error
    : new OperatorRequestError(500, "operator-operation-failed", error instanceof Error ? error.message : String(error));
  writeJson(response, requestError.statusCode, {
    error: {
      code: requestError.code,
      message: requestError.message,
      details: requestError.details
    }
  });
}

function setApiHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
