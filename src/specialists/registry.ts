import { specialistId, specialistVersion, type SpecialistId, type SpecialistManifest } from "./contracts.js";

const manifests: SpecialistManifest[] = [
  manifest("asos-kernel", "ASOS Kernel", "1.1.0", ["ORCHESTRATE"], ["*"], ["asos-workflow-run.v1"], true, false, false, false, null),
  manifest("catalog-contract-steward", "Catalog Contract Steward", "1.0.0", ["OBSERVE_PROPOSE"], [], ["managed-song-contract.v1"], false, false, false, false, null),
  manifest("catalog-publisher", "Catalog Publisher", "1.0.0", ["APPLY_OUTSIDE_VAULT"], ["managed-song-contract.v1"], ["catalog-index.v1"], true, false, false, false, null),
  manifest("project-admitter", "Project Admitter", "2.0.0", ["OBSERVE", "PROPOSE", "APPLY"], ["catalog-discovery.v1"], ["project-admission-report.v2"], true, true, true, true, null),
  manifest("asset-inspector", "Asset Inspector", "1.1.0", ["OBSERVE"], [], ["asset-inspection.v1"], true, false, false, false, null),
  manifest("lyric-source-resolver", "Lyric Source Resolver", "1.0.0", ["OBSERVE"], ["lyric-source-designation.v1"], ["lyric-source-resolution.v1"], true, false, false, false, null),
  manifest("lyric-source-batch-scout", "Lyric Source Batch Scout / Planning Input Builder", "1.0.0", ["OBSERVE"], ["asos-workflow-read-only-refresh.v1.1", "catalog-index.v1", "asset-inspection-report.v1", "asset-finding-routes.v1"], ["lyric-source-batch-scout-report.v1", "lyric-source-planning-input.v1"], true, false, false, false, null),
  manifest("review-inbox", "Review Inbox", "1.1.0", ["PROPOSE"], ["catalog-index.v1", "lyric-source-designation-proposal.v1"], ["review-inbox.v1", "lyric-source-review-proposal.v1"], false, false, true, false, null),
  manifest("operation-journal", "Operation Journal", "1.1.0", ["HANDOFF"], ["review-inbox.v1", "asos-authority-decision.v1"], ["operation-journal.v1", "lyric-source-apply-handoff.v1"], false, false, true, true, null),
  manifest("lyric-source-proposal", "Lyric Source Proposal Specialist", "1.0.0", ["PROPOSE"], ["lyric-source-planning-input.v1"], ["lyric-source-designation-proposal.v1"], false, false, true, true, null),
  manifest("lyric-source-compatibility-fixture-builder", "Lyric Source Compatibility Fixture Builder", "1.0.0", ["OBSERVE"], ["lyric-source-batch-scout-report.v1", "lyric-source-planning-input.v1", "lyric-source-designation-proposal.v1", "asos-authority-decision.v1"], ["lyric-source-compatibility-fixture-manifest.v1", "asos-workflow-run.v1"], false, false, false, false, null),
  manifest("artifact-handoff", "Artifact Handoff Specialist", "1.0.0", ["OBSERVE", "HANDOFF"], ["*"], ["artifact-verification-report.v1", "artifact-staging-report.v1"], false, false, false, false, null),
  manifest("windows-lyric-source-apply-builder", "Windows APPLY Builder", "1.0.0", ["PROPOSE"], ["lyric-source-designation-proposal.v1", "asos-authority-decision.v1", "lyric-source-apply-dry-run-report.v1"], ["lyric-source-windows-apply-script.v1"], false, false, true, true, "Windows PowerShell 5.1"),
  manifest("lyric-source-apply-dry-run", "Dry-Run and Compatibility Specialist", "1.0.0", ["OBSERVE"], ["lyric-source-designation-proposal.v1", "lyric-source-windows-apply-script.v1"], ["lyric-source-apply-dry-run-report.v1"], true, false, false, true, "Windows PowerShell 5.1"),
  manifest("lyric-source-independent-validator", "Independent Validation Specialist", "1.0.0", ["OBSERVE"], ["lyric-source-designation-proposal.v1", "asos-workflow-read-only-refresh.v1.1"], ["lyric-source-independent-validation-report.v1"], true, false, false, false, null)
].sort((left, right) => left.id.localeCompare(right.id));

export function listSpecialists(): SpecialistManifest[] {
  return manifests.map(cloneManifest);
}

export function describeSpecialist(id: string): SpecialistManifest | null {
  const found = manifests.find((candidate) => candidate.id === id);
  return found ? cloneManifest(found) : null;
}

export function requireSpecialist(id: SpecialistId | string): SpecialistManifest {
  const found = describeSpecialist(id);
  if (!found) {
    throw new Error(`Unknown specialist: ${id}`);
  }
  return found;
}

function manifest(
  id: string,
  name: string,
  version: string,
  authorityModes: SpecialistManifest["authorityModes"],
  acceptedInputContracts: string[],
  emittedOutputContracts: string[],
  musicVaultReadAllowed: boolean,
  musicVaultWriteAllowed: boolean,
  humanAuthorizationRequired: boolean,
  independentValidationRequired: boolean,
  supportedRuntime: string | null
): SpecialistManifest {
  return {
    id: specialistId(id),
    name,
    version: specialistVersion(version),
    authorityModes,
    acceptedInputContracts,
    emittedOutputContracts,
    musicVaultReadAllowed,
    musicVaultWriteAllowed,
    humanAuthorizationRequired,
    independentValidationRequired,
    supportedRuntime
  };
}

function cloneManifest(value: SpecialistManifest): SpecialistManifest {
  return {
    ...value,
    authorityModes: [...value.authorityModes],
    acceptedInputContracts: [...value.acceptedInputContracts],
    emittedOutputContracts: [...value.emittedOutputContracts]
  };
}
