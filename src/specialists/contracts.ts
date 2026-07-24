export type SpecialistId = string & { readonly __specialistId: unique symbol };
export type SpecialistVersion = string & { readonly __specialistVersion: unique symbol };

export type SpecialistAuthorityMode =
  | "OBSERVE"
  | "PROPOSE"
  | "HANDOFF"
  | "APPLY"
  | "APPLY_OUTSIDE_VAULT"
  | "ORCHESTRATE"
  | "OBSERVE_PROPOSE";

export type SpecialistManifest = {
  id: SpecialistId;
  name: string;
  version: SpecialistVersion;
  authorityModes: SpecialistAuthorityMode[];
  acceptedInputContracts: string[];
  emittedOutputContracts: string[];
  musicVaultReadAllowed: boolean;
  musicVaultWriteAllowed: boolean;
  humanAuthorizationRequired: boolean;
  independentValidationRequired: boolean;
  supportedRuntime: string | null;
};

export type ArtifactIdentity = {
  contract: string;
  expectedSha256: string | null;
  actualSha256: string;
  byteSize: number;
  canonicalFilename: string;
  path: string;
};

export type ArtifactStructuralCheck = {
  contract: string;
  passed: boolean;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
};

export type ArtifactLineage = {
  artifact: ArtifactIdentity;
  producedBy: SpecialistId;
  producedByVersion: SpecialistVersion;
  inputs: ArtifactIdentity[];
  evidence: SpecialistEvidenceReference[];
  supersedes: ArtifactIdentity[];
};

export type SpecialistExecutionContext = {
  runId: string;
  specialistId: SpecialistId;
  specialistVersion: SpecialistVersion;
  authorityMode: SpecialistAuthorityMode;
  startedAt: string;
  runtime: string;
  humanAuthorization: AuthorityTransitionDecision | null;
};

export type SpecialistInputArtifact = ArtifactIdentity & {
  role: string;
};

export type SpecialistOutputArtifact = ArtifactIdentity & {
  role: string;
  lineage: ArtifactLineage;
};

export type SpecialistEvidenceReference = {
  evidenceId: string;
  contract: string;
  artifactSha256: string;
  path: string;
};

export type SpecialistRefusal = {
  contract: "specialist-refusal.v1";
  code: string;
  message: string;
  specialistId: SpecialistId | null;
  authorityMode: SpecialistAuthorityMode | null;
  details: string[];
};

export type SpecialistRunResult = {
  contract: "specialist-run-result.v1";
  runId: string;
  specialist: { id: SpecialistId; version: SpecialistVersion };
  authorityMode: SpecialistAuthorityMode;
  status: "completed" | "refused";
  inputs: SpecialistInputArtifact[];
  outputs: SpecialistOutputArtifact[];
  evidence: SpecialistEvidenceReference[];
  refusal: SpecialistRefusal | null;
  safety: { applyEnabled: boolean; vaultMutation: "none" | "approved-bounded" };
};

export type AuthorityTransition = {
  from: SpecialistAuthorityMode | "START";
  to: SpecialistAuthorityMode;
  specialistId: SpecialistId;
  inputContracts: string[];
  outputContracts: string[];
  proposalBinding: { proposalId: string; proposalSha256: string } | null;
  decision: AuthorityTransitionDecision | null;
  completeOperationPlan: boolean;
  completeRollbackCriteria: boolean;
  completeValidatorCriteria: boolean;
  independentValidatorId: SpecialistId | null;
};

export type AuthorityTransitionDecision = {
  contract: "asos-authority-decision.v1";
  proposalId: string;
  proposalSha256: string;
  decisionState: "approved" | "rejected" | "deferred";
  decisionTimestamp: string;
  decisionArtifactSha256: string;
};

export type AuthorityTransitionDecisionResult = {
  allowed: boolean;
  nextAuthority: SpecialistAuthorityMode | null;
  refusal: SpecialistRefusal | null;
};

export function specialistId(value: string): SpecialistId {
  return value as SpecialistId;
}

export function specialistVersion(value: string): SpecialistVersion {
  return value as SpecialistVersion;
}
