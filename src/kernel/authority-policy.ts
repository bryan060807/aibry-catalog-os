import { requireSpecialist } from "../specialists/registry.js";
import { specialistId, type AuthorityTransition, type AuthorityTransitionDecisionResult, type SpecialistAuthorityMode, type SpecialistRefusal } from "../specialists/contracts.js";

const legalTransitions = new Set<string>([
  "START:OBSERVE",
  "START:PROPOSE",
  "START:ORCHESTRATE",
  "OBSERVE:PROPOSE",
  "PROPOSE:HANDOFF",
  "HANDOFF:APPLY",
  "APPLY:OBSERVE",
  "APPLY_OUTSIDE_VAULT:OBSERVE",
  "ORCHESTRATE:OBSERVE",
  "ORCHESTRATE:PROPOSE",
  "ORCHESTRATE:HANDOFF"
]);

export function evaluateAuthorityTransition(transition: AuthorityTransition): AuthorityTransitionDecisionResult {
  const manifest = requireSpecialist(transition.specialistId);
  if (!manifest.authorityModes.includes(transition.to)) {
    return denied(transition, "authority-not-declared", `${manifest.name} does not declare ${transition.to} authority.`);
  }
  if (!legalTransitions.has(`${transition.from}:${transition.to}`)) {
    return denied(transition, "illegal-authority-transition", `Transition ${transition.from} -> ${transition.to} is not allowed.`);
  }
  const unknownInput = transition.inputContracts.find((contract) => !acceptsContract(manifest.acceptedInputContracts, contract));
  if (unknownInput) {
    return denied(transition, "unknown-input-contract", `${manifest.name} does not accept ${unknownInput}.`);
  }
  const undeclaredOutput = transition.outputContracts.find((contract) => !manifest.emittedOutputContracts.includes(contract));
  if (undeclaredOutput) {
    return denied(transition, "undeclared-output-contract", `${manifest.name} cannot emit ${undeclaredOutput}.`);
  }
  if ((transition.to === "OBSERVE" || transition.to === "PROPOSE") && manifest.musicVaultWriteAllowed) {
    return denied(transition, "non-mutating-authority-required", `${transition.to} specialists cannot mutate the Music Vault.`);
  }
  if (transition.to === "APPLY_OUTSIDE_VAULT" && manifest.musicVaultWriteAllowed) {
    return denied(transition, "outside-vault-mutation-only", "APPLY_OUTSIDE_VAULT cannot mutate the Music Vault.");
  }
  if (transition.to === "HANDOFF" || transition.to === "APPLY") {
    if (!transition.proposalBinding) {
      return denied(transition, "missing-proposal-binding", "A proposal ID and exact SHA-256 binding are required.");
    }
    if (!transition.decision || transition.decision.decisionState !== "approved") {
      return denied(transition, "proposal-not-approved", "Exact human approval is required.");
    }
    if (transition.decision.proposalId !== transition.proposalBinding.proposalId || transition.decision.proposalSha256 !== transition.proposalBinding.proposalSha256) {
      return denied(transition, "stale-approval", "Approval does not bind to the exact current proposal ID and SHA-256.");
    }
    if (!transition.completeOperationPlan || !transition.completeRollbackCriteria || !transition.completeValidatorCriteria) {
      return denied(transition, "incomplete-handoff", "Operation, rollback, and validator criteria must all be complete.");
    }
  }
  if (transition.to === "APPLY" && !manifest.musicVaultWriteAllowed) {
    return denied(transition, "apply-specialist-required", "APPLY requires a separately declared Music Vault mutating specialist.");
  }
  if (manifest.musicVaultWriteAllowed && transition.independentValidatorId === transition.specialistId) {
    return denied(transition, "self-validation-forbidden", "A mutating specialist cannot independently validate its own work.");
  }
  return { allowed: true, nextAuthority: transition.to, refusal: null };
}

export function assertSpecialistOutputContract(specialist: string, contract: string): void {
  const manifest = requireSpecialist(specialist);
  if (!manifest.emittedOutputContracts.includes(contract)) {
    throw new Error(`${manifest.name} cannot emit undeclared contract ${contract}.`);
  }
}

export function assertNonMutatingAuthority(mode: SpecialistAuthorityMode, vaultMutation: "none" | "approved-bounded"): void {
  if ((mode === "OBSERVE" || mode === "PROPOSE" || mode === "APPLY_OUTSIDE_VAULT") && vaultMutation !== "none") {
    throw new Error(`${mode} authority cannot mutate the Music Vault.`);
  }
}

function acceptsContract(accepted: string[], contract: string): boolean {
  return accepted.includes("*") || accepted.includes(contract);
}

function denied(transition: AuthorityTransition, code: string, message: string): AuthorityTransitionDecisionResult {
  const refusal: SpecialistRefusal = {
    contract: "specialist-refusal.v1",
    code,
    message,
    specialistId: transition.specialistId ?? specialistId("unknown"),
    authorityMode: transition.to,
    details: []
  };
  return { allowed: false, nextAuthority: null, refusal };
}
