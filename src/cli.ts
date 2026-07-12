#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverCatalog } from "./catalog/discover.js";
import { assertOutputOutsideVault, assertVaultDirectory } from "./policy/source-of-truth.js";
import { renderDiscoveryReport } from "./reports/discovery-report.js";

type DiscoveryArguments = {
  vault: string;
  output: string;
};

function parseDiscoveryArguments(argv: string[]): DiscoveryArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        vault: { type: "string" },
        output: { type: "string" }
      }
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments: ${detail}\n\n${usage()}`, { cause: error });
  }

  if (parsed.positionals.length !== 2 || parsed.positionals[0] !== "catalog" || parsed.positionals[1] !== "discover") {
    throw new Error(usage());
  }

  if (!parsed.values.vault || !parsed.values.output) {
    throw new Error(`Both --vault and --output are required.\n\n${usage()}`);
  }

  return { vault: parsed.values.vault, output: parsed.values.output };
}

function usage(): string {
  return [
    "Usage:",
    "  catalog discover --vault <path> --output <path>",
    "",
    "Safety:",
    "  Discovery is read-only and refuses to write inside the vault."
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseDiscoveryArguments(argv);
  const vaultPath = await assertVaultDirectory(args.vault);
  const outputPath = await assertOutputOutsideVault(vaultPath, args.output);
  const discovery = await discoverCatalog(vaultPath);
  const report = renderDiscoveryReport(discovery);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report, "utf8");
  process.stdout.write(`Discovery report written to ${outputPath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
