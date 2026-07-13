import type { CatalogAudit, AuditSeverity } from "../catalog/audit.js";

export function renderAuditReport(audit: CatalogAudit): string {
  const lines = [
    "# AIBRY Catalog Archivist Audit Report",
    "",
    `- Vault root: \`${audit.vaultPath}\``,
    `- Audit timestamp: ${audit.auditedAt}`,
    "- Mode: read-only; report generation is the only write and must be outside the vault.",
    "",
    "## Scope and Limits",
    "",
    ...audit.scopeNotes.map((note) => `- ${note}`),
    "",
    "## Summary",
    "",
    "| Severity | Count |",
    "| --- | ---: |",
    ...(["error", "warning", "info"] as AuditSeverity[]).map((severity) => `| ${severity} | ${audit.findings.filter((finding) => finding.severity === severity).length} |`),
    "",
    "## Findings",
    ""
  ];
  if (audit.findings.length === 0) lines.push("- No findings in the implemented audit scope.", "");
  for (const item of audit.findings) {
    lines.push(`### [${item.severity.toUpperCase()}] ${item.summary}`, "", `- Finding ID: \`${item.findingId}\``, `- Category: ${item.category}`, `- Source: \`${item.sourcePath}\``, "- Evidence:", ...item.evidence.map((evidence) => `  - ${evidence}`), `- Recommendation: ${item.recommendedAction}`, "");
  }
  lines.push("## Mutation Safeguard", "", "This audit never moves, renames, deletes, rewrites, or auto-corrects Music Vault content. Each recommendation requires separate review and explicit approval before any future operation.", "");
  return lines.join("\n");
}
