#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runReadOnlyRefreshWorkflow, type ReadOnlyRefreshWorkflowSummary } from "../asos-workflow.js";
import { assertOutputOutsideRoot } from "../kernel/contract-path.js";
import { resolveLyricSourceDesignation } from "../lyric-source-resolver.js";
import { parseAndVerifyLyricSourceProposal } from "../lyric-source/proposal-specialist.js";
import type { RefreshAdapterConfig } from "./contracts.js";
import { assertSafeExistingDirectory, assertSafeExistingFile, assertSafeNewPath } from "./path-policy.js";

type AdapterReport = ReadOnlyRefreshWorkflowSummary & { resolverRecords: Array<{ projectPath: string; state: string }> };

export async function runRefreshAdapter(configPathInput: string, phaseInput: string, outputInput: string): Promise<AdapterReport> {
  if (phaseInput !== "pre" && phaseInput !== "post") throw new Error("Refresh adapter phase must be pre or post.");
  const configPath = await assertSafeExistingFile(configPathInput, "refresh adapter config");
  const config = JSON.parse(await readFile(configPath, "utf8")) as RefreshAdapterConfig;
  if (config.contract !== "lyric-source-live-refresh-adapter-config.v1") throw new Error("Refresh adapter config contract is invalid.");
  const vaultRoot = await assertSafeExistingDirectory(config.vaultRoot, "refresh adapter Vault root");
  const proposalPath = await assertSafeExistingFile(config.proposalPath, "refresh adapter proposal");
  await assertOutputOutsideRoot(vaultRoot, configPath);
  await assertOutputOutsideRoot(vaultRoot, proposalPath);
  const expectedOutput = path.resolve(phaseInput === "pre" ? config.preOutputPath : config.postOutputPath);
  const outputPath = await assertSafeNewPath(outputInput, "refresh adapter output");
  if (outputPath.toLowerCase() !== expectedOutput.toLowerCase()) throw new Error("Refresh adapter output path does not match sealed configuration.");
  await assertOutputOutsideRoot(vaultRoot, outputPath);
  const proposal = parseAndVerifyLyricSourceProposal(await readFile(proposalPath, "utf8"), proposalPath);
  const startedAt = Date.now();
  const summary = await runReadOnlyRefreshWorkflow(vaultRoot, outputPath);
  const resolverRecords: AdapterReport["resolverRecords"] = [];
  if (phaseInput === "post") {
    for (const projectPath of proposal.resolverExpectedProjects) {
      const resolution = await resolveLyricSourceDesignation(vaultRoot, path.join(vaultRoot, ...projectPath.split("/"), "project.md"));
      resolverRecords.push({ projectPath, state: resolution.state });
    }
  }
  const report: AdapterReport = { ...summary, resolverRecords };
  await writeJson(outputPath, report);
  const persisted = JSON.parse(await readFile(outputPath, "utf8")) as AdapterReport;
  const fileStat = await stat(outputPath);
  if (
    persisted.contract !== "asos-workflow-read-only-refresh.v1.1" || persisted.safety.applyEnabled !== false ||
    persisted.safety.vaultMutation !== "none" || persisted.counts.pendingApply !== 0 ||
    !Array.isArray(persisted.findingRoutes) || !Array.isArray(persisted.resolverRecords) || fileStat.mtimeMs < startedAt - 1_000
  ) throw new Error("Persisted refresh adapter report failed contract, freshness, or safety verification.");
  return persisted;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, strict: true, options: { config: { type: "string" }, phase: { type: "string" }, output: { type: "string" } } });
  if (!parsed.values.config || !parsed.values.phase || !parsed.values.output || parsed.positionals.length > 0) throw new Error("Usage: workflow-adapter --config <path> --phase pre|post --output <path>");
  await runRefreshAdapter(parsed.values.config, parsed.values.phase, parsed.values.output);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
