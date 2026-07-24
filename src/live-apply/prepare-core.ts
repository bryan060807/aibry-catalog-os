import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Bytes } from "../kernel/canonical-json.js";
import type { GuardedLiveApplyPlan } from "./contracts.js";
import { assertGuardedPlanIntegrity, sealGuardedLiveApplyPlan } from "./canonical-plan.js";
import { verifyGuardedOperatorPackage, type GuardedPackagePolicy } from "./package-verifier.js";
import { assertChildPath, assertDistinctPaths, assertOutsideVault, assertSafeExistingDirectory, assertSafeExistingFile, assertSafeNewPath } from "./path-policy.js";

const execFileAsync = promisify(execFile);

export type PrepareGuardedLiveApplyOptions = {
  packageManifest: string;
  vaultRoot: string;
  rollbackRoot: string;
  resultDirectory: string;
  outputPath: string;
  packagePolicy?: GuardedPackagePolicy;
  generatedAt?: string;
};

export type PrepareGuardedLiveApplyTestDependencies = { testOnly: true; allowFixturePackage: true };

const GOVERNED_GROUND_WIRE_GOSPEL = {
  proposalId: "lyric-source:scout-ground-wire-gospel-9d55f0d2c021:e4c950696723bb6b",
  proposalSha256: "32d9322816f9a36cb07575584fa8c11551194815044460c62666a2d59cfbfd5a",
  decisionCanonicalSha256: "0a50f14743bf12fdcf7bac9c1a2fc6002ff4d333b4e4fb3c7b7e8bd89e8e2556",
  artifactHashes: {
    proposal: "bbc4bc750dd7ccc5a4735af4882286a2e7532dc95788df9f26005c17cd308d6a",
    decision: "1a0cef9cfd95f71c3512e611e2252ca3e1ec3fc32c5506794357b83ef4f9cad7",
    script: "5e5b01714723b9862c1688692f279301767b0f5c9af55658a2f4410d7d6059cd",
    "dry-run-report": "bf9481c965601a5de1a33f01fce1d633c8550a4dec4870561a48633096eeb607",
    handoff: "aad334b1533f9d49aabb29fbecbdbe51516037e443d0e23b9cc0316d4e4f51f5"
  },
  operationPaths: [
    "project-memory/music/albums/ground-wire-gospel/01-rust-on-the-ignition/project.md",
    "project-memory/music/albums/ground-wire-gospel/02-oxidation-at-the-joints/project.md",
    "project-memory/music/albums/ground-wire-gospel/03-voltage-bleed/project.md",
    "project-memory/music/albums/ground-wire-gospel/04-scrap-iron-sermon/project.md",
    "project-memory/music/albums/ground-wire-gospel/migration-manifest.md",
    "project-memory/music/albums/ground-wire-gospel/README.md",
    "project-memory/music/albums/ground-wire-gospel/tracklist.md"
  ]
} as const;

export async function prepareGuardedLiveApply(options: PrepareGuardedLiveApplyOptions, testDependencies?: PrepareGuardedLiveApplyTestDependencies): Promise<GuardedLiveApplyPlan> {
  const vaultRoot = await assertSafeExistingDirectory(options.vaultRoot, "intended Vault root");
  const rollbackRoot = await assertSafeNewPath(options.rollbackRoot, "intended rollback root");
  const resultDirectory = await assertSafeNewPath(options.resultDirectory, "intended result directory");
  const outputPath = await assertSafeNewPath(options.outputPath, "guarded plan output");
  for (const [candidate, label] of [[rollbackRoot, "rollback root"], [resultDirectory, "result directory"], [outputPath, "plan output"]] as const) await assertOutsideVault(vaultRoot, candidate, label);
  assertDistinctPaths([
    { path: vaultRoot, label: "Vault root" }, { path: rollbackRoot, label: "rollback root" },
    { path: resultDirectory, label: "result directory" }, { path: outputPath, label: "plan output" }
  ]);
  assertNotNested(outputPath, resultDirectory, "Plan output must remain outside the unused result directory.");
  assertNotNested(outputPath, rollbackRoot, "Plan output must remain outside the unused rollback root.");

  const packagePolicy = options.packagePolicy ?? "ground-wire-gospel-pilot";
  const packageManifest = await assertSafeExistingFile(options.packageManifest, "operator package manifest");
  await assertOutsideVault(vaultRoot, packageManifest, "operator package");
  const verified = await verifyGuardedOperatorPackage(packageManifest, packagePolicy);
  if (packagePolicy === "ground-wire-gospel-pilot" && !testDependencies) await assertGovernedGroundWireGospelPackage(verified);
  for (const artifact of verified.artifacts) await assertOutsideVault(vaultRoot, artifact.path, `${artifact.role} artifact`);

  const currentModuleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workflowAdapterPath = await assertSafeExistingFile(path.join(currentModuleDirectory, "workflow-adapter.js"), "compiled workflow adapter");
  const validatorAdapterPath = await assertSafeExistingFile(path.join(currentModuleDirectory, "validator-adapter.js"), "compiled validator adapter");
  const cliPath = await assertSafeExistingFile(path.resolve(currentModuleDirectory, "..", "cli.js"), "compiled Catalog CLI");
  void cliPath;
  const nodePath = await assertSafeExistingFile(process.execPath, "Node executable");
  const powerShellPath = await assertSafeExistingFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "Windows PowerShell executable");
  const powerShellVersion = await probePowerShellVersion(powerShellPath);
  if (!powerShellVersion.startsWith("5.1.")) throw new Error(`Windows PowerShell 5.1 is required; found ${powerShellVersion}.`);

  const expectedResultPaths = {
    plan: path.join(resultDirectory, "lyric-source-guarded-live-apply-plan.v1.json"),
    snapshot: path.join(resultDirectory, "lyric-source-vault-snapshot.v1.json"),
    preRefresh: path.join(resultDirectory, "pre-read-only-refresh.json"),
    postRefresh: path.join(resultDirectory, "post-read-only-refresh.json"),
    validator: path.join(resultDirectory, "lyric-source-independent-validation-report.v1.json"),
    applyResult: path.join(resultDirectory, "lyric-source-apply-result.v1.json"),
    launcherReport: path.join(resultDirectory, "lyric-source-guarded-live-apply-launch-report.v1.json"),
    stdoutLog: path.join(resultDirectory, "guarded-live-apply.stdout.log"),
    stderrLog: path.join(resultDirectory, "guarded-live-apply.stderr.log"),
    workflowAdapterConfig: path.join(resultDirectory, "workflow-adapter-config.v1.json"),
    validatorAdapterConfig: path.join(resultDirectory, "validator-adapter-config.v1.json"),
    workflowAdapterBootstrap: path.join(resultDirectory, "workflow-adapter-bootstrap.mjs"),
    validatorAdapterBootstrap: path.join(resultDirectory, "validator-adapter-bootstrap.mjs"),
    recoveryRefresh: path.join(resultDirectory, "recovery-read-only-refresh.json"),
    recoveryVerification: path.join(resultDirectory, "lyric-source-recovery-verification.v1.json")
  };
  for (const [label, candidate] of Object.entries(expectedResultPaths)) assertChildPath(resultDirectory, candidate, `expected ${label} path`);

  const plan = sealGuardedLiveApplyPlan({
    contract: "lyric-source-guarded-live-apply-plan.v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    state: "prepared",
    operatorControlled: true,
    specialistAuthority: "none",
    package: { path: verified.manifestPath, artifactSha256: verified.manifestSha256 },
    proposalId: verified.proposalId,
    proposalSha256: verified.proposalSha256,
    artifacts: verified.artifacts,
    operationPaths: verified.operations.map((item) => item.path),
    expectedBaselineCounts: verified.expectedBaselineCounts,
    expectedPostApplyCounts: verified.expectedPostApplyCounts,
    intendedVaultRoot: vaultRoot,
    intendedRollbackRoot: rollbackRoot,
    intendedResultDirectory: resultDirectory,
    expectedResultPaths,
    powerShell: { path: powerShellPath, sha256: sha256Bytes(await readFile(powerShellPath)), version: powerShellVersion },
    node: { path: nodePath, sha256: sha256Bytes(await readFile(nodePath)), version: process.version },
    adapters: [
      { role: "workflow", path: workflowAdapterPath, sha256: sha256Bytes(await readFile(workflowAdapterPath)) },
      { role: "validator", path: validatorAdapterPath, sha256: sha256Bytes(await readFile(validatorAdapterPath)) }
    ],
    safety: { applyExecuted: false, vaultMutation: "none", interactiveAuthorizationRequired: true, browserApplyAvailable: false }
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const persisted = JSON.parse(await readFile(outputPath, "utf8")) as GuardedLiveApplyPlan;
  assertGuardedPlanIntegrity(persisted, plan.planSha256);
  return persisted;
}

async function assertGovernedGroundWireGospelPackage(verified: Awaited<ReturnType<typeof verifyGuardedOperatorPackage>>): Promise<void> {
  if (verified.proposalId !== GOVERNED_GROUND_WIRE_GOSPEL.proposalId || verified.proposalSha256 !== GOVERNED_GROUND_WIRE_GOSPEL.proposalSha256) throw new Error("Package is not the governed Ground Wire Gospel proposal.");
  for (const artifact of verified.artifacts) {
    if (artifact.sha256 !== GOVERNED_GROUND_WIRE_GOSPEL.artifactHashes[artifact.role]) throw new Error(`${artifact.role} artifact does not match the governed Ground Wire Gospel hash.`);
  }
  const decisionArtifact = verified.artifacts.find((item) => item.role === "decision");
  if (!decisionArtifact) throw new Error("Governed decision artifact is missing.");
  const decision = JSON.parse(await readFile(decisionArtifact.path, "utf8")) as { decisionArtifactSha256?: string };
  if (decision.decisionArtifactSha256 !== GOVERNED_GROUND_WIRE_GOSPEL.decisionCanonicalSha256) throw new Error("Decision canonical SHA-256 does not match the governed Ground Wire Gospel approval.");
  if (JSON.stringify(verified.operations.map((item) => item.path)) !== JSON.stringify(GOVERNED_GROUND_WIRE_GOSPEL.operationPaths)) throw new Error("Operation paths do not match the governed Ground Wire Gospel boundary.");
  if (
    verified.expectedBaselineCounts.catalogFindings !== 55 || verified.expectedPostApplyCounts.catalogFindings !== 51 ||
    verified.expectedBaselineCounts.assetFindings !== 234 || verified.expectedPostApplyCounts.assetFindings !== 226 ||
    verified.expectedBaselineCounts.routedFindings["blocks-existing-proposal"] !== 108 || verified.expectedPostApplyCounts.routedFindings["blocks-existing-proposal"] !== 100 ||
    verified.expectedBaselineCounts.pendingApply !== 0 || verified.expectedPostApplyCounts.pendingApply !== 0
  ) throw new Error("Package count transition does not match the governed Ground Wire Gospel approval.");
}

async function probePowerShellVersion(powerShellPath: string): Promise<string> {
  const { stdout } = await execFileAsync(powerShellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8"
  });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Windows PowerShell version probe returned malformed output.");
  return version;
}

function assertNotNested(candidate: string, root: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error(message);
}

export async function loadAndVerifyGuardedPlan(planPathInput: string, expectedSha256?: string): Promise<{ path: string; plan: GuardedLiveApplyPlan; artifactSha256: string }> {
  const planPath = await assertSafeExistingFile(planPathInput, "guarded live APPLY plan");
  const bytes = await readFile(planPath);
  const plan = JSON.parse(bytes.toString("utf8")) as GuardedLiveApplyPlan;
  assertGuardedPlanIntegrity(plan, expectedSha256);
  return { path: planPath, plan, artifactSha256: sha256Bytes(bytes) };
}
