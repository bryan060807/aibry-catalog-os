import { readFile } from "node:fs/promises";
import type { OperationJournal, OperationJournalEntry } from "./operation-journal.js";

export type OperationResultState = "applied" | "failed" | "skipped";

export type OperationResult = {
  operationId: string;
  state: OperationResultState;
  summary: string;
  evidence: string[];
  mutatedPaths?: string[];
};

export type ValidationState = "verified" | "unsupported" | "not-applied";

export type ValidationRecord = {
  validationId: string;
  operationId: string;
  proposalId: string;
  findingId: string;
  state: ValidationState;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "Independent Validator";
    authorityMode: "OBSERVE";
    operationalStandard: "ASOS v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  source: {
    sourcePath: string;
    findingCategory: OperationJournalEntry["source"]["findingCategory"];
    operationState: OperationJournalEntry["state"];
    resultState: OperationResultState | null;
  };
  summary: string;
  evidence: string[];
  unresolvedReason: string | null;
};

export type ValidationReport = {
  schemaVersion: "validation-report.v1";
  generatedAt: string;
  authority: ValidationRecord["authority"];
  source: {
    operationJournalSchemaVersion: OperationJournal["schemaVersion"];
    operationJournalGeneratedAt: string;
    operationCount: number;
    resultCount: number;
  };
  counts: {
    verified: number;
    unsupported: number;
    notApplied: number;
    total: number;
  };
  records: ValidationRecord[];
};

export async function buildValidationReportFromPaths(journalPath: string, resultsPath: string): Promise<ValidationReport> {
  const journal = await loadOperationJournal(journalPath);
  const results = await loadOperationResults(resultsPath);
  return buildValidationReport(journal, results);
}

export function buildValidationReport(journal: OperationJournal, results: OperationResult[]): ValidationReport {
  const resultsByOperation = new Map(results.map((result) => [result.operationId, result]));
  const records = journal.entries.map((entry) => validationRecord(entry, resultsByOperation.get(entry.operationId) ?? null));
  const counts = countStates(records);
  return {
    schemaVersion: "validation-report.v1",
    generatedAt: new Date().toISOString(),
    authority: validatorAuthority(),
    source: {
      operationJournalSchemaVersion: journal.schemaVersion,
      operationJournalGeneratedAt: journal.generatedAt,
      operationCount: journal.entries.length,
      resultCount: results.length
    },
    counts: { ...counts, total: records.length },
    records
  };
}

function validationRecord(entry: OperationJournalEntry, result: OperationResult | null): ValidationRecord {
  if (!result) {
    return baseRecord(entry, null, "not-applied", "No operation result was provided for this approved handoff.", entry.evidence, "missing-result");
  }
  if (result.state !== "applied") {
    return baseRecord(entry, result.state, "not-applied", result.summary, result.evidence, `result-${result.state}`);
  }
  const hasEvidence = result.evidence.length > 0;
  const referencesExpectedPath = (result.mutatedPaths ?? []).includes(entry.source.sourcePath) || result.evidence.some((line) => line.includes(entry.source.sourcePath));
  if (hasEvidence && referencesExpectedPath) {
    return baseRecord(entry, result.state, "verified", result.summary, result.evidence, null);
  }
  return baseRecord(entry, result.state, "unsupported", result.summary, result.evidence, "applied-result-did-not-reference-journaled-source-path");
}

function baseRecord(
  entry: OperationJournalEntry,
  resultState: OperationResultState | null,
  state: ValidationState,
  summary: string,
  evidence: string[],
  unresolvedReason: string | null
): ValidationRecord {
  return {
    validationId: `validation:${entry.operationId.replace(/^operation:/, "")}`,
    operationId: entry.operationId,
    proposalId: entry.proposalId,
    findingId: entry.findingId,
    state,
    authority: validatorAuthority(),
    source: {
      sourcePath: entry.source.sourcePath,
      findingCategory: entry.source.findingCategory,
      operationState: entry.state,
      resultState
    },
    summary,
    evidence,
    unresolvedReason
  };
}

function validatorAuthority(): ValidationRecord["authority"] {
  return {
    system: "AIBRY Catalog OS",
    specialist: "Independent Validator",
    authorityMode: "OBSERVE",
    operationalStandard: "ASOS v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}

function countStates(records: ValidationRecord[]): Omit<ValidationReport["counts"], "total"> {
  return records.reduce<Omit<ValidationReport["counts"], "total">>((counts, record) => {
    if (record.state === "verified") {
      counts.verified += 1;
    } else if (record.state === "unsupported") {
      counts.unsupported += 1;
    } else {
      counts.notApplied += 1;
    }
    return counts;
  }, { verified: 0, unsupported: 0, notApplied: 0 });
}

async function loadOperationJournal(journalPath: string): Promise<OperationJournal> {
  const parsed = JSON.parse(await readFile(journalPath, "utf8")) as unknown;
  assertOperationJournal(parsed, journalPath);
  return parsed;
}

async function loadOperationResults(resultsPath: string): Promise<OperationResult[]> {
  const parsed = JSON.parse(await readFile(resultsPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Operation results file must be a JSON array: ${resultsPath}`);
  }
  for (const result of parsed) {
    assertOperationResult(result, resultsPath);
  }
  return parsed;
}

function assertOperationJournal(value: unknown, journalPath: string): asserts value is OperationJournal {
  if (!isRecord(value) || value.schemaVersion !== "operation-journal.v1") {
    throw new Error(`Expected ${journalPath} to contain an operation-journal.v1 document.`);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`Operation journal ${journalPath} is missing entries.`);
  }
  if (!isRecord(value.authority) || value.authority.vaultMutation !== "none") {
    throw new Error(`Operation journal ${journalPath} does not declare the required non-mutating authority boundary.`);
  }
}

function assertOperationResult(value: unknown, resultsPath: string): asserts value is OperationResult {
  if (!isRecord(value) || typeof value.operationId !== "string" || !isOperationResultState(value.state) || typeof value.summary !== "string" || !Array.isArray(value.evidence)) {
    throw new Error(`Operation results file contains an invalid result entry: ${resultsPath}`);
  }
  if (value.mutatedPaths !== undefined && !Array.isArray(value.mutatedPaths)) {
    throw new Error(`Operation result mutatedPaths must be an array when provided: ${resultsPath}`);
  }
}

function isOperationResultState(value: unknown): value is OperationResultState {
  return value === "applied" || value === "failed" || value === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
