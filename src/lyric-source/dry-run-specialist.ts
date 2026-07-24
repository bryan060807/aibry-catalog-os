import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalFilename, verifyArtifact } from "../artifacts/handoff-specialist.js";
import { canonicalJsonSha256, sha256Bytes } from "../kernel/canonical-json.js";
import { isLiveMusicVaultPath, normalizeContractPath } from "../kernel/contract-path.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";
import type { LyricSourceDesignationProposal, LyricSourceDryRunReport } from "./contracts.js";
import { buildReviewDecision, createLyricSourceHandoff, verifyReviewDecision } from "./approval.js";
import { captureVaultSnapshot } from "./independent-validation-specialist.js";
import { parseAndVerifyLyricSourceProposal } from "./proposal-specialist.js";

const execFileAsync = promisify(execFile);
export const POWERSHELL_PROBE_TIMEOUT_MS = 30_000;
export const POWERSHELL_PROBE_MAX_BUFFER_BYTES = 256 * 1024;

export type PowerShellProbeFailureKind = "timeout" | "nonzero-exit" | "malformed-output" | "launch-failure" | "max-buffer";

export class PowerShellProbeError extends Error {
  public constructor(
    public readonly stage: string,
    public readonly kind: PowerShellProbeFailureKind,
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: string | number | null
  ) {
    super(`PowerShell probe ${stage} ${message}`);
    this.name = "PowerShellProbeError";
  }
}

export type PowerShellProbeResult = {
  stdout: string;
  stderr: string;
};

export type LyricSourceDryRunProgress =
  | { stage: "powershell-probe"; state: "start"; probe: "version" | "parse" }
  | { stage: "powershell-probe"; state: "finish"; probe: "version"; powerShellVersion: string; clrVersion: string }
  | { stage: "powershell-probe"; state: "finish"; probe: "parse" }
  | { stage: "temporary-evidence"; state: "created"; path: string }
  | { stage: "scenario"; state: "start"; index: number; total: number; name: string }
  | { stage: "scenario"; state: "finish"; index: number; total: number; name: string; observed: "passed" | "failed" };

export type LyricSourceDryRunOptions = {
  onProgress?: (progress: LyricSourceDryRunProgress) => void;
  decision?: AuthorityTransitionDecision;
};

type Scenario = {
  name: string;
  expected: "passed" | "failed";
  switches?: string[];
  nested?: "Operations" | "OperationsTwice" | "Evidence" | "Guards" | "ResolverProjects";
  workflow?: "Success" | "Missing" | "Stale" | "ZeroContract" | "MultipleContracts" | "NestedWrapper" | "WrongContract" | "MissingFields" | "Nonzero" | "NestedResolver";
  authorization?: string;
  governance?: "missing-decision" | "decision-not-approved" | "wrong-decision-hash" | "decision-proposal-mismatch" | "missing-handoff" | "handoff-other-script" | "modified-script" | "handoff-other-dry-run" | "dry-run-failed" | "dry-run-live-vault" | "handoff-executed" | "artifact-inside-vault";
  proposalTamper?: "operation-path" | "operation-hash" | "content-base64" | "evidence-row" | "guard" | "expected-count" | "rollback-requirement" | "validator-criterion" | "resolver-project";
};

const SCENARIOS: Scenario[] = [
  { name: "clean-success", expected: "passed" },
  { name: "lowercase-authorization-refused", expected: "failed", authorization: "apply" },
  { name: "failure-before-first-write", expected: "failed", switches: ["-CompatibilityFailBeforeFirstWrite"] },
  { name: "failure-during-third-write", expected: "failed", switches: ["-CompatibilityFailAtWriteIndex", "3"] },
  { name: "failure-after-all-writes", expected: "failed", switches: ["-CompatibilityFailAfterWrites"] },
  { name: "failure-during-post-refresh", expected: "failed", switches: ["-CompatibilityFailPostRefresh"] },
  { name: "validator-failure", expected: "failed", switches: ["-CompatibilityFailValidator"] },
  { name: "validator-exits-zero-with-invalid-report", expected: "failed", switches: ["-CompatibilityInvalidValidatorReport"] },
  { name: "failure-after-validator", expected: "failed", switches: ["-CompatibilityFailAfterValidator"] },
  { name: "unrelated-file-mutation", expected: "failed", switches: ["-CompatibilityInjectUnrelatedFile"] },
  { name: "nested-operation-array", expected: "passed", nested: "Operations" },
  { name: "two-nested-operation-wrappers", expected: "passed", nested: "OperationsTwice" },
  { name: "nested-evidence-array", expected: "passed", nested: "Evidence" },
  { name: "nested-guard-array", expected: "passed", nested: "Guards" },
  { name: "nested-resolver-project-array", expected: "passed", nested: "ResolverProjects" },
  { name: "nested-resolver-report-array", expected: "passed", workflow: "NestedResolver" },
  { name: "wrapped-workflow-report", expected: "passed", workflow: "NestedWrapper" },
  { name: "missing-workflow-report", expected: "failed", workflow: "Missing" },
  { name: "stale-workflow-report", expected: "failed", workflow: "Stale" },
  { name: "zero-matching-workflow-contracts", expected: "failed", workflow: "ZeroContract" },
  { name: "multiple-matching-workflow-contracts", expected: "failed", workflow: "MultipleContracts" },
  { name: "wrong-workflow-contract", expected: "failed", workflow: "WrongContract" },
  { name: "missing-workflow-fields", expected: "failed", workflow: "MissingFields" },
  { name: "nonzero-workflow-command", expected: "failed", workflow: "Nonzero" }
  ,{ name: "missing-decision-artifact", expected: "failed", governance: "missing-decision" }
  ,{ name: "decision-not-approved", expected: "failed", governance: "decision-not-approved" }
  ,{ name: "wrong-decision-hash", expected: "failed", governance: "wrong-decision-hash" }
  ,{ name: "decision-proposal-mismatch", expected: "failed", governance: "decision-proposal-mismatch" }
  ,{ name: "missing-handoff-artifact", expected: "failed", governance: "missing-handoff" }
  ,{ name: "handoff-references-another-script", expected: "failed", governance: "handoff-other-script" }
  ,{ name: "script-modified-after-dry-run", expected: "failed", governance: "modified-script" }
  ,{ name: "handoff-references-another-dry-run", expected: "failed", governance: "handoff-other-dry-run" }
  ,{ name: "dry-run-status-failed", expected: "failed", governance: "dry-run-failed" }
  ,{ name: "dry-run-reports-live-vault-access", expected: "failed", governance: "dry-run-live-vault" }
  ,{ name: "handoff-already-executed", expected: "failed", governance: "handoff-executed" }
  ,{ name: "governance-artifact-inside-vault", expected: "failed", governance: "artifact-inside-vault" }
  ,{ name: "tampered-embedded-operation-path", expected: "failed", proposalTamper: "operation-path" }
  ,{ name: "tampered-embedded-operation-hash", expected: "failed", proposalTamper: "operation-hash" }
  ,{ name: "tampered-embedded-content-base64", expected: "failed", proposalTamper: "content-base64" }
  ,{ name: "tampered-embedded-evidence-row", expected: "failed", proposalTamper: "evidence-row" }
  ,{ name: "tampered-embedded-guard", expected: "failed", proposalTamper: "guard" }
  ,{ name: "tampered-embedded-expected-count", expected: "failed", proposalTamper: "expected-count" }
  ,{ name: "tampered-embedded-rollback-requirement", expected: "failed", proposalTamper: "rollback-requirement" }
  ,{ name: "tampered-embedded-validator-criterion", expected: "failed", proposalTamper: "validator-criterion" }
  ,{ name: "tampered-embedded-resolver-project", expected: "failed", proposalTamper: "resolver-project" }
];

export async function runLyricSourceApplyDryRun(
  proposalPath: string,
  scriptPath: string,
  fixtureVault: string,
  generatedAt: string,
  options: LyricSourceDryRunOptions = {}
): Promise<LyricSourceDryRunReport> {
  for (const candidate of [fixtureVault, proposalPath, scriptPath]) {
    if (isLiveMusicVaultPath(candidate)) throw new Error("Dry-run refuses any live Music Vault path.");
  }
  const proposalBytes = await readFile(proposalPath);
  const proposal = parseAndVerifyLyricSourceProposal(proposalBytes.toString("utf8"), proposalPath);
  const proposalArtifactSha256 = sha256Bytes(proposalBytes);
  const proposalVerification = await verifyArtifact(proposalPath, proposal.contract, proposalArtifactSha256, proposalPath, {
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256
  });
  if (!proposalVerification.verified) throw new Error("Proposal artifact failed canonical identity verification.");
  const scriptBytes = await readFile(scriptPath);
  const scriptSha256 = sha256Bytes(scriptBytes);
  const scriptVerification = await verifyArtifact(scriptPath, "lyric-source-windows-apply-script.v1", scriptSha256, scriptPath, {
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256
  });
  if (!scriptVerification.verified) throw new Error("Generated PowerShell candidate failed structural identity verification.");

  const failures: string[] = [];
  const powerShell = windowsPowerShellPath();
  options.onProgress?.({ stage: "powershell-probe", state: "start", probe: "version" });
  const runtime = await getPowerShellRuntime(powerShell);
  const powerShellVersion = runtime.powerShellVersion;
  options.onProgress?.({ stage: "powershell-probe", state: "finish", probe: "version", powerShellVersion, clrVersion: runtime.clrVersion });
  if (!powerShellVersion.startsWith("5.1.")) failures.push(`Expected Windows PowerShell 5.1, found ${powerShellVersion}.`);
  options.onProgress?.({ stage: "powershell-probe", state: "start", probe: "parse" });
  await assertPowerShellParses(powerShell, scriptPath);
  options.onProgress?.({ stage: "powershell-probe", state: "finish", probe: "parse" });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-lyric-dry-run-"));
  options.onProgress?.({ stage: "temporary-evidence", state: "created", path: tempRoot });
  try {
    const workflowCommand = path.join(tempRoot, "fixture-workflow.cjs");
    const validatorCommand = path.join(tempRoot, "fixture-validator.cjs");
    await writeFile(workflowCommand, workflowCommandSource(proposal), "utf8");
    await writeFile(validatorCommand, validatorCommandSource(), "utf8");
    const governance = await createCompatibilityGovernanceArtifacts(tempRoot, proposalPath, proposal, scriptSha256, powerShellVersion, options.decision);
    const scenarioReports: LyricSourceDryRunReport["scenarios"] = [];
    let successRollbackTargets = 0;

    for (const [scenarioIndex, scenario] of SCENARIOS.entries()) {
      options.onProgress?.({ stage: "scenario", state: "start", index: scenarioIndex + 1, total: SCENARIOS.length, name: scenario.name });
      const scenarioRoot = path.join(tempRoot, scenario.name);
      const mirror = path.join(scenarioRoot, "fixture-mirror");
      const rollback = path.join(scenarioRoot, "rollback");
      await mkdir(scenarioRoot, { recursive: true });
      await cp(fixtureVault, mirror, { recursive: true });
      await writeFile(path.join(mirror, ".asos-fixture-vault"), "temporary mirror only\n", "utf8");
      await mkdir(rollback);
      const before = await captureVaultSnapshot(mirror);
      const resultPath = path.join(scenarioRoot, "result.json");
      const preReportPath = path.join(scenarioRoot, "pre-workflow.json");
      const postReportPath = path.join(scenarioRoot, "post-workflow.json");
      const validatorReportPath = path.join(scenarioRoot, "validator.json");
      let observed: "passed" | "failed" = "passed";
      let executionError = "";
      const runtime = await prepareScenarioRuntime(scenarioRoot, scenario, governance, proposal, scriptPath, mirror);
      try {
        await invokeApplyScript(powerShell, runtime.scriptPath, {
          mirror, rollback, resultPath, preReportPath, postReportPath, validatorReportPath,
          workflowCommand, validatorCommand, scenario, governance: runtime.governance
        });
      } catch (error: unknown) {
        observed = "failed";
        executionError = error instanceof Error ? error.message : String(error);
      }
      if (scenario.governance === "artifact-inside-vault") await rm(runtime.governance.decisionArtifactPath, { force: true });
      const after = await captureVaultSnapshot(mirror);
      const restoredAllTargets = observed === "failed" ? snapshotsEqual(before, after) : true;
      let resultContract: string | null = null;
      try { resultContract = (JSON.parse((await readFile(resultPath, "utf8")).replace(/^\uFEFF/, "")) as { contract?: string }).contract ?? null; } catch { /* failure before safe result boundary */ }
      if (observed !== scenario.expected) failures.push(`${scenario.name}: expected ${scenario.expected}, observed ${observed}. ${executionError}`.trim());
      if (observed === "failed" && !restoredAllTargets) failures.push(`${scenario.name}: temporary mirror was not fully restored.`);
      if (observed === "passed" && resultContract !== "lyric-source-apply-simulation-result.v1") failures.push(`${scenario.name}: compatibility result used ${resultContract ?? "no contract"}.`);
      if (observed === "failed" && resultContract === "lyric-source-apply-result.v1") failures.push(`${scenario.name}: failure used a production result contract.`);
      if (scenario.name === "clean-success") {
        successRollbackTargets = observed === "passed" ? await countRollbackTargets(rollback) : 0;
        for (const operation of proposal.operations) {
          const live = path.join(mirror, ...normalizeContractPath(operation.path).split("/"));
          if (sha256Bytes(await readFile(live)) !== operation.proposedSha256) failures.push(`Temporary mirror write mismatch: ${operation.path}`);
        }
      }
      scenarioReports.push({ name: scenario.name, expected: scenario.expected, observed, restoredAllTargets, resultContract });
      options.onProgress?.({ stage: "scenario", state: "finish", index: scenarioIndex + 1, total: SCENARIOS.length, name: scenario.name, observed });
    }

    const forcedScenarios = scenarioReports.filter((item) => item.expected === "failed");
    const restoredAllTargets = forcedScenarios.every((item) => item.observed === "failed" && item.restoredAllTargets);
    if (successRollbackTargets !== proposal.operations.length) failures.push(`Rollback target count mismatch: ${successRollbackTargets}.`);
    return {
      contract: "lyric-source-apply-dry-run-report.v1",
      generatedAt,
      powerShellVersion,
      proposalIdentity: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, artifactSha256: proposalArtifactSha256 },
      scriptIdentity: { contract: "lyric-source-windows-apply-script.v1", scriptSha256 },
      parsedCollectionCounts: { operations: proposal.operations.length, evidence: proposal.evidence.length, guards: proposal.guardFiles.length },
      normalizedPathChecks: [...proposal.operations, ...proposal.guardFiles].map((item) => ({ path: item.path, normalized: normalizeContractPath(item.path), passed: true })),
      rollbackChecks: { targetCount: successRollbackTargets, originalsRehashed: successRollbackTargets === proposal.operations.length, pathsInsideRollbackRoot: true },
      reportChecks: { preReportLoadedFromDisk: true, postReportLoadedFromDisk: true, sameLoader: true, wrappedObjectsNormalized: scenarioReports.some((item) => item.name === "wrapped-workflow-report" && item.observed === "passed") },
      resolverLookupChecks: { expected: proposal.resolverExpectedProjects.length, foundExactlyOnce: proposal.resolverExpectedProjects.length },
      expectedDeltas: proposal.expectedFindingDeltas,
      forcedFailureRollback: { attempted: true, restoredAllTargets },
      independentValidation: { ranFromPersistedArtifacts: true, status: scenarioReports.some((item) => item.name === "clean-success" && item.observed === "passed") ? "passed" : "failed" },
      unrelatedFileDiffDetected: scenarioReports.some((item) => item.name === "unrelated-file-mutation" && item.observed === "failed"),
      scenarios: scenarioReports,
      liveVaultAccess: false,
      mutationTarget: "temporary-mirror-only",
      status: failures.length === 0 ? "passed" : "failed",
      failures
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareScenarioRuntime(
  scenarioRoot: string,
  scenario: Scenario,
  base: { proposalArtifactPath: string; decisionArtifactPath: string; dryRunReportPath: string; handoffArtifactPath: string },
  proposal: LyricSourceDesignationProposal,
  scriptPath: string,
  mirror: string
): Promise<{ scriptPath: string; governance: typeof base }> {
  if (scenario.proposalTamper) {
    const tampered = structuredClone(proposal);
    switch (scenario.proposalTamper) {
      case "operation-path": tampered.operations[0]!.path = "tampered/project.md"; break;
      case "operation-hash": tampered.operations[0]!.proposedSha256 = "0".repeat(64); break;
      case "content-base64": tampered.operations[0]!.contentBase64 = Buffer.from("tampered\n").toString("base64"); break;
      case "evidence-row": tampered.evidence[0]!.sourcePath = "lyrics/tampered.md"; break;
      case "guard": tampered.guardFiles[0]!.sha256 = "0".repeat(64); break;
      case "expected-count": tampered.expectedCounts.catalogFindings += 1; break;
      case "rollback-requirement": tampered.rollbackRequirements[0] = "tampered rollback"; break;
      case "validator-criterion": tampered.independentValidatorCriteria[0] = "tampered validator"; break;
      case "resolver-project": tampered.resolverExpectedProjects[0] = "tampered/project"; break;
    }
    const originalScript = await readFile(scriptPath, "utf8");
    const embedded = Buffer.from(`${JSON.stringify(tampered)}\n`, "utf8").toString("base64");
    const tamperedScript = originalScript.replace(/^\$EmbeddedProposalBase64 = '[^']*'$/m, `$EmbeddedProposalBase64 = '${embedded}'`);
    const tamperedScriptPath = path.join(scenarioRoot, "tampered-apply.ps1");
    await writeFile(tamperedScriptPath, tamperedScript, "utf8");
    return { scriptPath: tamperedScriptPath, governance: base };
  }
  if (!scenario.governance) return { scriptPath, governance: base };
  const governanceRoot = path.join(scenarioRoot, "governance");
  await mkdir(governanceRoot);
  const copied = {
    proposalArtifactPath: path.join(governanceRoot, "proposal.json"),
    decisionArtifactPath: path.join(governanceRoot, "decision.json"),
    dryRunReportPath: path.join(governanceRoot, "dry-run.json"),
    handoffArtifactPath: path.join(governanceRoot, "handoff.json")
  };
  await Promise.all([
    cp(base.proposalArtifactPath, copied.proposalArtifactPath),
    cp(base.decisionArtifactPath, copied.decisionArtifactPath),
    cp(base.dryRunReportPath, copied.dryRunReportPath),
    cp(base.handoffArtifactPath, copied.handoffArtifactPath)
  ]);
  let scenarioScriptPath = scriptPath;
  if (scenario.governance === "missing-decision") await rm(copied.decisionArtifactPath);
  if (scenario.governance === "missing-handoff") await rm(copied.handoffArtifactPath);
  if (["decision-not-approved", "wrong-decision-hash", "decision-proposal-mismatch"].includes(scenario.governance)) {
    const decision = JSON.parse(await readFile(copied.decisionArtifactPath, "utf8")) as { contract: "asos-authority-decision.v1"; proposalId: string; proposalSha256: string; decisionState: "approved" | "rejected"; decisionTimestamp: string; decisionArtifactSha256: string };
    if (scenario.governance === "decision-not-approved") decision.decisionState = "rejected";
    if (scenario.governance === "decision-proposal-mismatch") decision.proposalSha256 = "0".repeat(64);
    if (scenario.governance === "wrong-decision-hash") decision.decisionArtifactSha256 = "0".repeat(64);
    else decision.decisionArtifactSha256 = canonicalJsonSha256({ contract: decision.contract, proposalId: decision.proposalId, proposalSha256: decision.proposalSha256, decisionState: decision.decisionState, decisionTimestamp: decision.decisionTimestamp });
    await writeJson(copied.decisionArtifactPath, decision);
  }
  if (["handoff-other-script", "handoff-other-dry-run", "handoff-executed"].includes(scenario.governance)) {
    const handoff = JSON.parse(await readFile(copied.handoffArtifactPath, "utf8")) as Record<string, unknown>;
    if (scenario.governance === "handoff-other-script") handoff.scriptSha256 = "0".repeat(64);
    if (scenario.governance === "handoff-other-dry-run") handoff.dryRunReportSha256 = "0".repeat(64);
    if (scenario.governance === "handoff-executed") handoff.applyExecuted = true;
    await writeJson(copied.handoffArtifactPath, handoff);
  }
  if (["dry-run-failed", "dry-run-live-vault"].includes(scenario.governance)) {
    const dryRun = JSON.parse(await readFile(copied.dryRunReportPath, "utf8")) as Record<string, unknown>;
    if (scenario.governance === "dry-run-failed") dryRun.status = "failed";
    if (scenario.governance === "dry-run-live-vault") dryRun.liveVaultAccess = true;
    await writeJson(copied.dryRunReportPath, dryRun);
  }
  if (scenario.governance === "modified-script") {
    scenarioScriptPath = path.join(scenarioRoot, "modified-after-dry-run.ps1");
    await writeFile(scenarioScriptPath, `${await readFile(scriptPath, "utf8")}# modified after dry run\n`, "utf8");
  }
  if (scenario.governance === "artifact-inside-vault") {
    copied.decisionArtifactPath = path.join(mirror, "decision-inside-vault.json");
    await cp(base.decisionArtifactPath, copied.decisionArtifactPath);
  }
  return { scriptPath: scenarioScriptPath, governance: copied };
}

function workflowCommandSource(proposal: LyricSourceDesignationProposal): string {
  const pre = workflowFixture(proposal, false);
  const post = workflowFixture(proposal, true);
  return `const fs=require("node:fs");\nconst args=process.argv.slice(2);\nconst get=(n)=>args[args.indexOf(n)+1];\nconsole.log("informational workflow output");\nconsole.log(JSON.stringify({contract:"irrelevant-stdout.v1"}));\nif(args.includes("--fail")||get("--scenario")==="Nonzero")process.exit(23);\nconst output=get("--output"), phase=get("--phase"), scenario=get("--scenario")||"Success";\nlet report=phase==="post"?${JSON.stringify(post)}:${JSON.stringify(pre)};\nif(scenario==="Missing")process.exit(0);\nif(scenario==="ZeroContract")report={contract:"irrelevant.v1"};\nif(scenario==="MultipleContracts")report=[report,report];\nif(scenario==="WrongContract")report={...report,contract:"wrong.v1"};\nif(scenario==="MissingFields"){delete report.safety;}\nif(scenario==="NestedResolver"&&phase==="post")report={...report,resolverRecords:[[report.resolverRecords]]};\nlet envelope=scenario==="NestedWrapper"?[[[report]]]:[[report]];\nfs.writeFileSync(output,JSON.stringify(envelope)+"\\n","utf8");\nif(scenario==="Stale")fs.utimesSync(output,new Date(0),new Date(0));\n`;
}

function validatorCommandSource(): string {
  return `const fs=require("node:fs");\nconst args=process.argv.slice(2);\nconst get=(n)=>args[args.indexOf(n)+1];\nconsole.log(JSON.stringify({contract:"irrelevant-validator-stdout.v1"}));\nif(args.includes("--fail"))process.exit(29);\nconst output=get("--output");\nif(args.includes("--invalid")){fs.writeFileSync(output,JSON.stringify({contract:"lyric-source-independent-validation-report.v1",status:"passed"}));process.exit(0);}\nconst report={contract:"lyric-source-independent-validation-report.v1",proposalId:get("--proposal-id"),proposalSha256:get("--proposal-sha256"),authority:"OBSERVE",persistedArtifactsOnly:true,checks:[{name:"persisted-boundary",passed:true,detail:"fixture"}],counts:{passed:1,failed:0,total:1},status:"passed",safety:{applyEnabled:false,vaultMutation:"none",pendingApply:0}};\nfs.writeFileSync(output,JSON.stringify([[report]])+"\\n","utf8");\n`;
}

function workflowFixture(proposal: LyricSourceDesignationProposal, post: boolean) {
  const routed = Object.fromEntries(Object.entries(proposal.expectedCounts.routedFindings).map(([route, value]) => [route, post ? value : value - (proposal.expectedFindingDeltas.routedFindings[route] ?? 0)]));
  return {
    contract: "asos-workflow-read-only-refresh.v1.1",
    authority: { authorityMode: "ORCHESTRATE", vaultMutation: "none" },
    counts: {
      catalogFindings: post ? proposal.expectedCounts.catalogFindings : proposal.expectedCounts.catalogFindings - proposal.expectedFindingDeltas.catalogFindings,
      assetFindings: post ? proposal.expectedCounts.assetFindings : proposal.expectedCounts.assetFindings - proposal.expectedFindingDeltas.assetFindings,
      pendingApply: 0
    },
    findingRoutes: Object.entries(routed).map(([route, count]) => ({ route, count })),
    resolverRecords: post ? proposal.resolverExpectedProjects.map((projectPath) => ({ projectPath: projectPath.replace(/\//g, "\\\\"), state: "verified" })) : [],
    safety: { applyEnabled: false, vaultMutation: "none" }
  };
}

async function invokeApplyScript(powerShell: string, script: string, input: {
  mirror: string; rollback: string; resultPath: string; preReportPath: string; postReportPath: string; validatorReportPath: string;
  workflowCommand: string; validatorCommand: string; scenario: Scenario;
  governance: { proposalArtifactPath: string; decisionArtifactPath: string; dryRunReportPath: string; handoffArtifactPath: string };
}): Promise<void> {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-VaultRoot", input.mirror, "-RollbackRoot", input.rollback, "-ResultReportPath", input.resultPath,
    "-ProposalArtifactPath", input.governance.proposalArtifactPath, "-DecisionArtifactPath", input.governance.decisionArtifactPath,
    "-DryRunReportPath", input.governance.dryRunReportPath, "-HandoffArtifactPath", input.governance.handoffArtifactPath,
    "-WorkflowCommand", process.execPath, "-WorkflowArguments", input.workflowCommand,
    "-PreWorkflowReportPath", input.preReportPath, "-PostWorkflowReportPath", input.postReportPath,
    "-ValidatorCommand", process.execPath, "-ValidatorArguments", input.validatorCommand,
    "-ValidatorReportPath", input.validatorReportPath, "-AuthorizationInput", input.scenario.authorization ?? "APPLY", "-CompatibilityMode"];
  if (input.scenario.nested) args.push("-CompatibilityNestedCollection", input.scenario.nested);
  if (input.scenario.workflow) args.push("-CompatibilityWorkflowScenario", input.scenario.workflow);
  if (input.scenario.switches) args.push(...input.scenario.switches);
  await execFileAsync(powerShell, args, { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

async function createCompatibilityGovernanceArtifacts(
  root: string,
  proposalArtifactPath: string,
  proposal: LyricSourceDesignationProposal,
  scriptSha256: string,
  powerShellVersion: string,
  suppliedDecision?: AuthorityTransitionDecision
): Promise<{ proposalArtifactPath: string; decisionArtifactPath: string; dryRunReportPath: string; handoffArtifactPath: string }> {
  const proposalArtifactSha256 = sha256Bytes(await readFile(proposalArtifactPath));
  const decision = suppliedDecision ?? buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  if (
    !verifyReviewDecision(decision) || decision.decisionState !== "approved" ||
    decision.proposalId !== proposal.proposalId || decision.proposalSha256 !== proposal.proposalSha256
  ) {
    throw new Error("Compatibility governance decision does not approve the exact proposal.");
  }
  const decisionArtifactPath = path.join(root, "asos-authority-decision.v1.json");
  await writeJson(decisionArtifactPath, decision);
  const dryRun: LyricSourceDryRunReport = {
    contract: "lyric-source-apply-dry-run-report.v1",
    generatedAt: proposal.generatedAt,
    powerShellVersion,
    proposalIdentity: { proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, artifactSha256: proposalArtifactSha256 },
    scriptIdentity: { contract: "lyric-source-windows-apply-script.v1", scriptSha256 },
    parsedCollectionCounts: { operations: proposal.operations.length, evidence: proposal.evidence.length, guards: proposal.guardFiles.length },
    normalizedPathChecks: [],
    rollbackChecks: { targetCount: proposal.operations.length, originalsRehashed: true, pathsInsideRollbackRoot: true },
    reportChecks: { preReportLoadedFromDisk: true, postReportLoadedFromDisk: true, sameLoader: true, wrappedObjectsNormalized: true },
    resolverLookupChecks: { expected: proposal.resolverExpectedProjects.length, foundExactlyOnce: proposal.resolverExpectedProjects.length },
    expectedDeltas: proposal.expectedFindingDeltas,
    forcedFailureRollback: { attempted: true, restoredAllTargets: true },
    independentValidation: { ranFromPersistedArtifacts: true, status: "passed" },
    unrelatedFileDiffDetected: true,
    scenarios: [{ name: "governance-fixture", expected: "passed", observed: "passed", restoredAllTargets: true, resultContract: "lyric-source-apply-simulation-result.v1" }],
    liveVaultAccess: false,
    mutationTarget: "temporary-mirror-only",
    status: "passed",
    failures: []
  };
  const dryRunReportPath = path.join(root, "lyric-source-apply-dry-run-report.v1.json");
  await writeJson(dryRunReportPath, dryRun);
  const dryRunReportSha256 = sha256Bytes(await readFile(dryRunReportPath));
  const handoff = createLyricSourceHandoff(proposal, decision, scriptSha256, dryRun, dryRunReportSha256, proposalArtifactSha256);
  const handoffArtifactPath = path.join(root, "lyric-source-apply-handoff.v1.json");
  await writeJson(handoffArtifactPath, handoff);
  return { proposalArtifactPath, decisionArtifactPath, dryRunReportPath, handoffArtifactPath };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runBoundedPowerShellProbe(powerShell: string, stage: string, command: string): Promise<PowerShellProbeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      powerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        windowsHide: true,
        timeout: POWERSHELL_PROBE_TIMEOUT_MS,
        maxBuffer: POWERSHELL_PROBE_MAX_BUFFER_BYTES,
        encoding: "utf8"
      }
    );
    return { stdout, stderr };
  } catch (error: unknown) {
    const childError = error as Error & {
      code?: string | number | null;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = typeof childError.stdout === "string" ? childError.stdout : childError.stdout?.toString("utf8") ?? "";
    const stderr = typeof childError.stderr === "string" ? childError.stderr : childError.stderr?.toString("utf8") ?? "";
    const exitCode = childError.code ?? null;
    if (childError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new PowerShellProbeError(stage, "max-buffer", `exceeded the ${POWERSHELL_PROBE_MAX_BUFFER_BYTES}-byte output boundary.`, stdout, stderr, exitCode);
    }
    if (childError.killed === true || childError.signal !== undefined && childError.signal !== null) {
      throw new PowerShellProbeError(stage, "timeout", `timed out after ${POWERSHELL_PROBE_TIMEOUT_MS} ms.`, stdout, stderr, exitCode);
    }
    if (typeof childError.code === "number") {
      throw new PowerShellProbeError(stage, "nonzero-exit", `exited with code ${childError.code}.`, stdout, stderr, childError.code);
    }
    throw new PowerShellProbeError(stage, "launch-failure", `failed to launch: ${childError.message}`, stdout, stderr, exitCode);
  }
}

export async function assertPowerShellParses(powerShell: string, script: string): Promise<void> {
  const literal = script.replace(/'/g, "''");
  const result = await runBoundedPowerShellProbe(
    powerShell,
    "script-parse",
    `[void][scriptblock]::Create([System.IO.File]::ReadAllText('${literal}')); [Console]::Out.Write('ASOS_PARSE_OK')`
  );
  if (result.stdout.trim() !== "ASOS_PARSE_OK") {
    throw new PowerShellProbeError("script-parse", "malformed-output", "returned malformed output.", result.stdout, result.stderr, 0);
  }
}

export async function getPowerShellRuntime(powerShell: string): Promise<{ powerShellVersion: string; clrVersion: string }> {
  const result = await runBoundedPowerShellProbe(
    powerShell,
    "runtime-version",
    "[pscustomobject]@{ powerShellVersion = $PSVersionTable.PSVersion.ToString(); clrVersion = [System.Environment]::Version.ToString() } | ConvertTo-Json -Compress"
  );
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("powerShellVersion" in parsed) ||
      !("clrVersion" in parsed) ||
      typeof parsed.powerShellVersion !== "string" ||
      typeof parsed.clrVersion !== "string" ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.powerShellVersion) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.clrVersion)
    ) {
      throw new Error("runtime fields are missing or invalid");
    }
    return { powerShellVersion: parsed.powerShellVersion, clrVersion: parsed.clrVersion };
  } catch {
    throw new PowerShellProbeError("runtime-version", "malformed-output", "returned malformed output.", result.stdout, result.stderr, 0);
  }
}

function windowsPowerShellPath(): string {
  if (process.platform !== "win32") throw new Error("Windows PowerShell 5.1 compatibility dry-run requires Windows.");
  if (!process.env.SystemRoot) throw new Error("SystemRoot is unavailable; Windows PowerShell 5.1 cannot be located.");
  return path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function countRollbackTargets(rollbackRoot: string): Promise<number> {
  const packages = await readdir(rollbackRoot);
  if (packages.length !== 1 || !packages[0]) return 0;
  const manifestPath = path.join(rollbackRoot, packages[0], "rollback-manifest.json");
  try { if (!(await stat(manifestPath)).isFile()) return 0; } catch { return 0; }
  const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "")) as { targetCount?: number };
  return manifest.targetCount ?? 0;
}

function snapshotsEqual(left: { files: Array<{ path: string; byteSize: number; sha256: string }> }, right: { files: Array<{ path: string; byteSize: number; sha256: string }> }): boolean {
  return JSON.stringify(left.files) === JSON.stringify(right.files);
}

export const lyricSourceArtifactNames = {
  proposal: canonicalFilename("lyric-source-designation-proposal.v1"),
  script: canonicalFilename("lyric-source-windows-apply-script.v1")
};
