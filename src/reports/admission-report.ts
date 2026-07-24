import type { AdmissionReport, AdmissionStatus } from "../catalog/admit.js";

const statuses: AdmissionStatus[] = ["WOULD_ADMIT", "ADMITTED", "SKIPPED", "NEEDS_REVIEW", "ERROR"];

export function renderAdmissionReport(report: AdmissionReport): string {
  const lines = [
    "# AIBRY Project Admitter v2 Report", "",
    `- SPECIALIST: ${report.specialist}`,
    `- Specialist Version: ${report.specialistVersion}`,
    `- Operational Standard: ${report.operationalStandardVersion}`,
    `- Run ID: ${report.runId}`,
    `- Mode: ${report.mode}`,
    `- Started: ${report.started}`,
    `- Completed: ${report.completed}`,
    `- Duration: ${report.durationMs}ms`,
    `- Vault root: \`${report.vaultPath}\``, "", "## Status Summary", ""
  ];
  for (const status of statuses) lines.push(`- ${status}: ${report.entries.filter((entry) => entry.status === status).length}`);
  if (report.mode === "APPLY") {
    lines.push(
      "", "## Execution Summary", "",
      `- Attempted: ${report.entries.filter((entry) => entry.attempted === true).length}`,
      `- Succeeded: ${report.entries.filter((entry) => entry.status === "ADMITTED").length}`,
      `- Failed: ${report.entries.filter((entry) => entry.status === "ERROR").length}`,
      `- Skipped without attempt: ${report.entries.filter((entry) => entry.status === "SKIPPED" && entry.attempted === false).length}`,
      `- Remained unverified: ${report.entries.filter((entry) => entry.status === "NEEDS_REVIEW" && entry.attempted === false).length}`
    );
  }
  lines.push("", "## Findings", "");
  for (const entry of report.entries) {
    lines.push(`### ${entry.status} — \`${entry.relativePath}\``, "", `- Status: ${entry.status}`, `- Subject: \`${entry.relativePath}\``, `- Evidence: Target: \`${entry.projectRelativePath}\``);
    for (const evidence of entry.evidence) lines.push(`- Evidence: ${evidence}`);
    if (entry.attempted !== undefined) lines.push(`- Attempted: ${entry.attempted ? "Yes" : "No"}`);
    if (entry.recommendation) lines.push(`- Recommendation: ${entry.recommendation}`);
    if (entry.result) lines.push(`- Result: ${entry.result}`);
    if (entry.recovery) lines.push(`- Recovery: ${entry.recovery}`);
    lines.push("");
  }
  const mutations = report.entries.filter((entry) => entry.status === "ADMITTED");
  lines.push("## Mutation Record", "", mutations.length === 0 ? "- No vault mutations were recorded." : "- Every recorded mutation is listed below:");
  for (const mutation of mutations) lines.push(`- Created and verified: \`${mutation.projectRelativePath}\``);
  lines.push("", "## Safeguards", "");
  for (const safeguard of report.safeguards) lines.push(`- ${safeguard}`);
  lines.push("", report.mode === "APPLY" ? "This final report includes successful mutations and any execution errors; existing files and all other vault content were left unchanged." : "No Music Vault files were changed in this mode.", "");
  return lines.join("\n");
}
