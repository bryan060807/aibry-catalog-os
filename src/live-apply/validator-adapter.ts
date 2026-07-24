#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertOutputOutsideRoot } from "../kernel/contract-path.js";
import type { LyricSourceIndependentValidationReport } from "../lyric-source/contracts.js";
import { validateLyricSourceApplyFromPaths } from "../lyric-source/independent-validation-specialist.js";
import { parseAndVerifyLyricSourceProposal } from "../lyric-source/proposal-specialist.js";
import type { ValidatorAdapterConfig } from "./contracts.js";
import { assertSafeExistingDirectory, assertSafeExistingFile, assertSafeNewPath } from "./path-policy.js";

export async function runValidatorAdapter(configPathInput: string, outputInput: string, proposalId: string, proposalSha256: string): Promise<LyricSourceIndependentValidationReport> {
  const configPath = await assertSafeExistingFile(configPathInput, "validator adapter config");
  const config = JSON.parse(await readFile(configPath, "utf8")) as ValidatorAdapterConfig;
  if (config.contract !== "lyric-source-live-validator-adapter-config.v1") throw new Error("Validator adapter config contract is invalid.");
  const vaultRoot = await assertSafeExistingDirectory(config.vaultRoot, "validator adapter Vault root");
  const proposalPath = await assertSafeExistingFile(config.proposalPath, "validator adapter proposal");
  const snapshotPath = await assertSafeExistingFile(config.snapshotPath, "validator adapter snapshot");
  const workflowPath = await assertSafeExistingFile(config.postWorkflowReportPath, "validator adapter post-workflow report");
  const outputPath = await assertSafeNewPath(outputInput, "validator adapter output");
  if (outputPath.toLowerCase() !== path.resolve(config.outputPath).toLowerCase()) throw new Error("Validator adapter output path does not match sealed configuration.");
  for (const candidate of [configPath, proposalPath, snapshotPath, workflowPath, outputPath]) await assertOutputOutsideRoot(vaultRoot, candidate);
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  if (proposal.proposalId !== proposalId || proposal.proposalSha256 !== proposalSha256) throw new Error("Validator adapter appended proposal identity does not match its sealed proposal.");
  const startedAt = Date.now();
  const report = await validateLyricSourceApplyFromPaths(proposalPath, vaultRoot, snapshotPath, workflowPath, new Date().toISOString());
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const persisted = JSON.parse(await readFile(outputPath, "utf8")) as LyricSourceIndependentValidationReport;
  const fileStat = await stat(outputPath);
  if (
    persisted.contract !== "lyric-source-independent-validation-report.v1" || persisted.proposalId !== proposalId || persisted.proposalSha256 !== proposalSha256 ||
    persisted.status !== "passed" || persisted.counts.failed !== 0 || persisted.authority !== "OBSERVE" || persisted.persistedArtifactsOnly !== true ||
    persisted.safety.applyEnabled !== false || persisted.safety.vaultMutation !== "none" || persisted.safety.pendingApply !== 0 || fileStat.mtimeMs < startedAt - 1_000
  ) throw new Error("Persisted Independent Validator report failed identity, status, or safety verification.");
  return persisted;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, strict: true, options: { config: { type: "string" }, output: { type: "string" }, "proposal-id": { type: "string" }, "proposal-sha256": { type: "string" } } });
  if (!parsed.values.config || !parsed.values.output || !parsed.values["proposal-id"] || !parsed.values["proposal-sha256"] || parsed.positionals.length > 0) {
    throw new Error("Usage: validator-adapter --config <path> --output <path> --proposal-id <id> --proposal-sha256 <hash>");
  }
  await runValidatorAdapter(parsed.values.config, parsed.values.output, parsed.values["proposal-id"], parsed.values["proposal-sha256"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
