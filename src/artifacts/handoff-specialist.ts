import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "../kernel/canonical-json.js";
import { isLiveMusicVaultPath } from "../kernel/contract-path.js";
import type { ArtifactIdentity, ArtifactStructuralCheck } from "../specialists/contracts.js";
import { assertProposalIntegrity } from "../lyric-source/proposal-specialist.js";
import type { LyricSourceDesignationProposal } from "../lyric-source/contracts.js";
import type { LyricSourceApplyHandoff, LyricSourceCompatibilityFixtureManifest, LyricSourceDryRunReport, LyricSourceOperatorPackage } from "../lyric-source/contracts.js";
import { verifyReviewDecision } from "../lyric-source/approval.js";
import type { AuthorityTransitionDecision } from "../specialists/contracts.js";

export type ArtifactIdentityExpectations = {
  proposalId?: string;
  proposalSha256?: string;
  proposalArtifactSha256?: string;
  decisionArtifactSha256?: string;
  dryRunReportSha256?: string;
  scriptSha256?: string;
};

export type ArtifactVerificationReport = {
  contract: "artifact-verification-report.v1";
  identity: ArtifactIdentity;
  structuralCheck: ArtifactStructuralCheck;
  supersessionState: "active" | "superseded" | "conflicting-active-artifact";
  intendedRepositoryDestination: string;
  verified: boolean;
  conflicts: string[];
};

export type ArtifactStagingReport = {
  contract: "artifact-staging-report.v1";
  source: ArtifactIdentity;
  staged: ArtifactIdentity;
  destination: string;
  checks: {
    exists: true;
    exactByteSize: true;
    exactSha256: true;
    structuralMarker: true;
    canonicalPath: true;
    noConflictingActiveArtifact: true;
  };
};

export async function verifyArtifact(
  fileInput: string,
  expectedContract: string,
  expectedSha256: string,
  intendedDestination = fileInput,
  expectations: ArtifactIdentityExpectations = {}
): Promise<ArtifactVerificationReport> {
  rejectLiveVaultPath(fileInput);
  rejectLiveVaultPath(intendedDestination);
  const filePath = path.resolve(fileInput);
  const bytes = await readFile(filePath);
  const actualSha256 = sha256Bytes(bytes);
  const fileStat = await stat(filePath);
  const structuralCheck = checkArtifactStructure(filePath, bytes.toString("utf8"), expectedContract, expectations);
  const conflicts = await findConflictingArtifacts(filePath, expectedContract);
  const identity: ArtifactIdentity = {
    contract: expectedContract,
    expectedSha256: expectedSha256.toLowerCase(),
    actualSha256,
    byteSize: fileStat.size,
    canonicalFilename: canonicalFilename(expectedContract),
    path: filePath
  };
  const expectedName = identity.canonicalFilename;
  const extensionAllowed = isExtensionAllowed(filePath, expectedContract);
  if (!extensionAllowed) {
    structuralCheck.checks.push({ check: "filename-role", passed: false, detail: `${path.basename(filePath)} is not valid for ${expectedContract}; canonical role is ${expectedName}.` });
    structuralCheck.passed = false;
  }
  const filenameAllowed = isApprovedFilename(filePath, expectedContract);
  structuralCheck.checks.push({ check: "canonical-filename-policy", passed: filenameAllowed, detail: filenameAllowed ? "Filename matches the canonical or approved versioned policy." : `${path.basename(filePath)} is not approved for ${expectedContract}.` });
  structuralCheck.passed = structuralCheck.checks.every((check) => check.passed);
  const destinationAllowed = isApprovedFilename(intendedDestination, expectedContract);
  structuralCheck.checks.push({ check: "canonical-destination", passed: destinationAllowed, detail: destinationAllowed ? "Intended destination matches the approved filename policy." : `Destination ${path.basename(intendedDestination)} is not canonical.` });
  structuralCheck.passed = structuralCheck.checks.every((check) => check.passed);
  const verified = actualSha256 === expectedSha256.toLowerCase() && structuralCheck.passed && conflicts.length === 0;
  return {
    contract: "artifact-verification-report.v1",
    identity,
    structuralCheck,
    supersessionState: conflicts.length > 0 ? "conflicting-active-artifact" : path.basename(filePath).includes(".superseded.") ? "superseded" : "active",
    intendedRepositoryDestination: path.resolve(intendedDestination),
    verified,
    conflicts
  };
}

export async function stageArtifact(
  fileInput: string,
  destinationInput: string,
  expectedContract: string,
  expectedSha256: string,
  expectations: ArtifactIdentityExpectations = {}
): Promise<ArtifactStagingReport> {
  rejectLiveVaultPath(fileInput);
  rejectLiveVaultPath(destinationInput);
  const sourceReport = await verifyArtifact(fileInput, expectedContract, expectedSha256, destinationInput, expectations);
  if (!sourceReport.verified) {
    throw new Error(`Source artifact verification failed: ${verificationFailures(sourceReport).join("; ")}`);
  }
  const destination = path.resolve(destinationInput);
  await mkdir(path.dirname(destination), { recursive: true });
  const preConflicts = (await findConflictingArtifacts(destination, expectedContract)).filter((candidate) => path.resolve(candidate) !== path.resolve(fileInput));
  if (preConflicts.length > 0) {
    throw new Error(`Conflicting active artifact exists for ${expectedContract}: ${preConflicts.join(", ")}`);
  }
  await copyFile(path.resolve(fileInput), destination, constants.COPYFILE_EXCL);
  const staged = await verifyArtifact(destination, expectedContract, expectedSha256, destination, expectations);
  if (!staged.verified || staged.identity.byteSize !== sourceReport.identity.byteSize) {
    throw new Error(`Staged artifact verification failed: ${verificationFailures(staged).join("; ")}`);
  }
  return {
    contract: "artifact-staging-report.v1",
    source: sourceReport.identity,
    staged: staged.identity,
    destination,
    checks: {
      exists: true,
      exactByteSize: true,
      exactSha256: true,
      structuralMarker: true,
      canonicalPath: true,
      noConflictingActiveArtifact: true
    }
  };
}

export function checkArtifactStructure(filePath: string, content: string, expectedContract: string, expectations: ArtifactIdentityExpectations = {}): ArtifactStructuralCheck {
  const trimmed = content.trimStart();
  const checks: ArtifactStructuralCheck["checks"] = [];
  const add = (check: string, passed: boolean, detail: string) => checks.push({ check, passed, detail });
  switch (expectedContract) {
    case "lyric-source-windows-apply-script.v1":
      add("powershell-cmdlet-binding", trimmed.startsWith("[CmdletBinding()]"), "PowerShell APPLY script starts with [CmdletBinding()].");
      add("powershell-param", /\bparam\s*\(/i.test(content), "PowerShell APPLY script contains param(.");
      add("apply-contract-marker", content.includes("lyric-source-windows-apply-script.v1"), "Expected APPLY contract marker is present.");
      add("not-markdown-proposal", !/^#\s+.*proposal/im.test(trimmed), "Artifact does not begin as a Markdown proposal.");
      add("script-contract-identity", /^# contract: lyric-source-windows-apply-script\.v1$/m.test(content), "Script declares its own exact APPLY contract.");
      const scriptProposalId = content.match(/^\$ExpectedProposalId = '([^']+)'$/m)?.[1];
      const scriptProposalSha256 = content.match(/^\$ExpectedProposalSha256 = '([a-f0-9]{64})'$/m)?.[1];
      add("embedded-proposal-id", typeof scriptProposalId === "string" && (!expectations.proposalId || scriptProposalId === expectations.proposalId), "Embedded proposal ID matches the expected identity.");
      add("embedded-proposal-sha256", typeof scriptProposalSha256 === "string" && (!expectations.proposalSha256 || scriptProposalSha256 === expectations.proposalSha256), "Embedded proposal SHA-256 matches the expected identity.");
      break;
    case "lyric-source-designation-proposal.v1":
      try {
        const parsed = JSON.parse(content) as LyricSourceDesignationProposal;
        assertProposalIntegrity(parsed);
        add("proposal-contract", parsed.contract === expectedContract, "Parsed proposal declares its own expected contract.");
        add("operation-envelope", Array.isArray(parsed.operations) && parsed.operations.length > 0, "Parsed proposal contains its operation envelope.");
        add("pending-approval", parsed.approvalState === "pending", "Approval remains pending.");
        add("apply-disabled", parsed.applyEnabled === false, "APPLY remains disabled.");
        add("proposal-id", !expectations.proposalId || parsed.proposalId === expectations.proposalId, "Proposal ID matches the expected identity.");
        add("proposal-sha256", !expectations.proposalSha256 || parsed.proposalSha256 === expectations.proposalSha256, "Proposal SHA-256 matches the expected identity.");
      } catch (error: unknown) {
        add("proposal-json-identity", false, error instanceof Error ? error.message : "Proposal JSON is invalid.");
      }
      break;
    case "lyric-source-rollback-manifest.v1":
      try {
        const parsed = JSON.parse(content) as unknown;
        const valid = isRecord(parsed) && parsed.contract === expectedContract && Number.isInteger(parsed.targetCount) && Array.isArray(parsed.targets)
          && parsed.targets.length === parsed.targetCount && parsed.targets.every((target) => isRecord(target) && typeof target.path === "string" && /^[a-f0-9]{64}$/.test(String(target.originalSha256)));
        add("rollback-schema", valid, "Rollback manifest declares its own contract, exact target count, paths, and original hashes.");
      } catch {
        add("rollback-schema", false, "Rollback manifest must be valid JSON.");
      }
      break;
    case "asos-authority-decision.v1":
      try {
        const parsed = JSON.parse(content) as AuthorityTransitionDecision;
        add("decision-schema", parsed.contract === expectedContract && verifyReviewDecision(parsed) && parsed.decisionState === "approved", "Decision declares its contract, valid canonical hash, and approved state.");
        add("decision-proposal-id", !expectations.proposalId || parsed.proposalId === expectations.proposalId, "Decision proposal ID matches.");
        add("decision-proposal-sha256", !expectations.proposalSha256 || parsed.proposalSha256 === expectations.proposalSha256, "Decision proposal SHA-256 matches.");
        add("decision-artifact-sha256", !expectations.decisionArtifactSha256 || parsed.decisionArtifactSha256 === expectations.decisionArtifactSha256, "Decision binding SHA-256 matches.");
      } catch {
        add("decision-schema", false, "Decision artifact must be valid governed JSON.");
      }
      break;
    case "lyric-source-apply-handoff.v1":
      try {
        const parsed = JSON.parse(content) as LyricSourceApplyHandoff;
        add("handoff-schema", parsed.contract === expectedContract && parsed.state === "eligible-for-guarded-apply" && parsed.applyExecuted === false && Array.isArray(parsed.operations) && parsed.operations.length > 0 && Array.isArray(parsed.rollbackRequirements) && parsed.rollbackRequirements.length > 0 && Array.isArray(parsed.independentValidatorCriteria) && parsed.independentValidatorCriteria.length > 0, "Handoff declares eligible, unexecuted, complete governed state.");
        add("handoff-proposal-id", !expectations.proposalId || parsed.proposalId === expectations.proposalId, "Handoff proposal ID matches.");
        add("handoff-proposal-sha256", !expectations.proposalSha256 || parsed.proposalSha256 === expectations.proposalSha256, "Handoff proposal SHA-256 matches.");
        add("handoff-proposal-artifact", !expectations.proposalArtifactSha256 || parsed.proposalArtifactSha256 === expectations.proposalArtifactSha256, "Handoff proposal artifact SHA-256 matches.");
        add("handoff-decision", !expectations.decisionArtifactSha256 || parsed.decisionArtifactSha256 === expectations.decisionArtifactSha256, "Handoff decision SHA-256 matches.");
        add("handoff-dry-run", !expectations.dryRunReportSha256 || parsed.dryRunReportSha256 === expectations.dryRunReportSha256, "Handoff dry-run SHA-256 matches.");
        add("handoff-script", !expectations.scriptSha256 || parsed.scriptSha256 === expectations.scriptSha256, "Handoff script SHA-256 matches.");
      } catch {
        add("handoff-schema", false, "Handoff artifact must be valid governed JSON.");
      }
      break;
    case "lyric-source-operator-package.v1":
      try {
        const parsed = JSON.parse(content) as LyricSourceOperatorPackage;
        add("operator-package-schema", parsed.contract === expectedContract && Array.isArray(parsed.artifacts) && parsed.artifacts.length === 5 && Array.isArray(parsed.executionCommands) && parsed.executionCommands.length === 1 && parsed.safety?.liveApplyExecuted === false && parsed.safety?.governanceVerified === true, "Operator package has five governed artifacts, one command, and non-executed safety state.");
      } catch {
        add("operator-package-schema", false, "Operator package must be valid governed JSON.");
      }
      break;
    case "lyric-source-compatibility-fixture-manifest.v1":
      try {
        const parsed = JSON.parse(content) as LyricSourceCompatibilityFixtureManifest;
        add(
          "compatibility-fixture-schema",
          parsed.contract === expectedContract && parsed.authority === "OBSERVE" && Array.isArray(parsed.materializedFiles)
            && parsed.materializedFiles.length > 0 && Array.isArray(parsed.operationTargets) && parsed.operationTargets.length > 0
            && Array.isArray(parsed.evidenceFiles) && parsed.evidenceFiles.length > 0 && Array.isArray(parsed.guardFiles)
            && /^[a-f0-9]{64}$/.test(parsed.fixtureSnapshotSha256),
          "Compatibility fixture manifest declares its materialized files, operation/evidence/guard boundaries, and snapshot identity."
        );
        add(
          "compatibility-fixture-safety",
          parsed.safety?.liveVaultAccess === false && parsed.safety?.liveVaultMutation === "none"
            && parsed.safety?.fixtureMutationOnly === true && parsed.safety?.applyExecuted === false,
          "Compatibility fixture manifest is reports-local, non-live, and unexecuted."
        );
      } catch {
        add("compatibility-fixture-schema", false, "Compatibility fixture manifest must be valid governed JSON.");
      }
      break;
    case "asos-workflow-run.v1":
    case "asos-workflow-read-only-refresh.v1.1":
    case "lyric-source-independent-validation-report.v1":
    case "lyric-source-apply-result.v1":
    case "lyric-source-apply-dry-run-report.v1":
      try {
        const parsed = JSON.parse(content) as LyricSourceDryRunReport;
        add("expected-contract", parsed.contract === expectedContract && parsed.status === "passed" && parsed.liveVaultAccess === false && parsed.mutationTarget === "temporary-mirror-only" && parsed.failures.length === 0, `Parsed dry-run artifact declares a successful, temporary-mirror-only ${expectedContract}.`);
        add("dry-run-proposal-id", !expectations.proposalId || parsed.proposalIdentity.proposalId === expectations.proposalId, "Dry-run proposal ID matches.");
        add("dry-run-proposal-sha256", !expectations.proposalSha256 || parsed.proposalIdentity.proposalSha256 === expectations.proposalSha256, "Dry-run proposal SHA-256 matches.");
        add("dry-run-proposal-artifact", !expectations.proposalArtifactSha256 || parsed.proposalIdentity.artifactSha256 === expectations.proposalArtifactSha256, "Dry-run proposal artifact SHA-256 matches.");
        add("dry-run-script", !expectations.scriptSha256 || parsed.scriptIdentity.scriptSha256 === expectations.scriptSha256, "Dry-run script SHA-256 matches.");
      } catch {
        add("expected-contract", false, `Artifact must be valid JSON declaring ${expectedContract}.`);
      }
      break;
    default:
      try {
        const parsed = JSON.parse(content) as unknown;
        add("declared-contract", isRecord(parsed) && parsed.contract === expectedContract, `Parsed artifact declares ${expectedContract}.`);
      } catch {
        add("declared-contract", false, `Artifact must be valid JSON declaring ${expectedContract}.`);
      }
      break;
  }
  return { contract: expectedContract, passed: checks.every((check) => check.passed), checks };
}

export function canonicalFilename(contract: string): string {
  const names: Record<string, string> = {
    "lyric-source-designation-proposal.v1": "lyric-source-designation-proposal.v1.json",
    "lyric-source-windows-apply-script.v1": "lyric-source-windows-apply.v1.ps1",
    "lyric-source-rollback-manifest.v1": "lyric-source-rollback-manifest.v1.json",
    "asos-workflow-run.v1": "asos-workflow-run.v1.json",
    "lyric-source-independent-validation-report.v1": "lyric-source-independent-validation-report.v1.json",
    "lyric-source-apply-result.v1": "lyric-source-apply-result.v1.json",
    "lyric-source-apply-dry-run-report.v1": "lyric-source-apply-dry-run-report.v1.json"
    ,"lyric-source-batch-scout-report.v1": "lyric-source-batch-scout-report.v1.json"
    ,"lyric-source-planning-input.v1": "lyric-source-planning-input.v1.json"
    ,"asos-authority-decision.v1": "asos-authority-decision.v1.json"
    ,"lyric-source-apply-handoff.v1": "lyric-source-apply-handoff.v1.json"
    ,"lyric-source-operator-package.v1": "lyric-source-operator-package.v1.json"
    ,"lyric-source-compatibility-fixture-manifest.v1": "lyric-source-compatibility-fixture-manifest.v1.json"
  };
  return names[contract] ?? `${contract}.json`;
}

function isExtensionAllowed(filePath: string, contract: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (contract === "lyric-source-windows-apply-script.v1") {
    return extension === ".ps1";
  }
  if (contract === "lyric-source-designation-proposal.v1") {
    return extension === ".json";
  }
  return extension === ".json" || extension === ".md";
}

async function findConflictingArtifacts(fileInput: string, expectedContract: string): Promise<string[]> {
  const filePath = path.resolve(fileInput);
  const directory = path.dirname(filePath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const conflicts: string[] = [];
  for (const name of names.sort()) {
    const candidate = path.join(directory, name);
    if (candidate === filePath || name.includes(".superseded.")) {
      continue;
    }
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile()) {
        continue;
      }
      const text = await readFile(candidate, "utf8");
      if (artifactDeclaresContract(candidate, text, expectedContract)) {
        conflicts.push(candidate);
      }
    } catch {
      continue;
    }
  }
  return conflicts;
}

function isApprovedFilename(filePath: string, contract: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name === canonicalFilename(contract).toLowerCase()) {
    return true;
  }
  if (contract === "lyric-source-designation-proposal.v1") {
    return /^lyric-source-designation-proposal-[a-z0-9-]+\.v1\.json$/.test(name);
  }
  if (contract === "lyric-source-windows-apply-script.v1") {
    return /^lyric-source-windows-apply-[a-z0-9-]+\.v1\.ps1$/.test(name);
  }
  return false;
}

function artifactDeclaresContract(filePath: string, content: string, expectedContract: string): boolean {
  if (expectedContract === "lyric-source-windows-apply-script.v1") {
    return path.extname(filePath).toLowerCase() === ".ps1" && /^# contract: lyric-source-windows-apply-script\.v1$/m.test(content) && content.trimStart().startsWith("[CmdletBinding()]");
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) && parsed.contract === expectedContract;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verificationFailures(report: ArtifactVerificationReport): string[] {
  const failures = report.structuralCheck.checks.filter((check) => !check.passed).map((check) => check.check);
  if (report.identity.actualSha256 !== report.identity.expectedSha256) {
    failures.push("sha256");
  }
  if (report.conflicts.length > 0) {
    failures.push("conflicting-active-artifact");
  }
  return failures;
}

function rejectLiveVaultPath(input: string): void {
  if (isLiveMusicVaultPath(input)) {
    throw new Error("Artifact handoff is restricted to paths outside the Music Vault.");
  }
}
