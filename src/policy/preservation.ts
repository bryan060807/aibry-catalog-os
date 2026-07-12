export type PreservationDecision = {
  allowed: boolean;
  reason: string;
};

export function requireExplicitApproval(operation: string): PreservationDecision {
  return {
    allowed: false,
    reason: `${operation} requires a reviewable proposal, backup plan, and explicit approval.`
  };
}

export function readOnlyDiscoveryPolicy(): PreservationDecision {
  return {
    allowed: true,
    reason: "Discovery may read vault files and write generated reports outside the vault."
  };
}
