import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectCatalogAssets, type AssetInspectionFinding, type AssetInspectionReport } from "./asset-inspector.js";
import { renderManagedSongContractJson } from "./catalog/contract.js";
import { publishCatalogIndex, type CatalogIndex } from "./catalog/publish.js";
import { buildOperationJournal, type OperationJournal } from "./operation-journal.js";
import { assertOperationalInputOutsideVault, assertOutputOutsideVault, assertVaultDirectory } from "./policy/source-of-truth.js";
import { buildReviewInboxFromIndexPath, type ReviewInbox } from "./review-inbox.js";

export type FindingRoute = "evidence-only" | "reviewable" | "blocks-existing-proposal" | "eligible-for-proposal";

export type RoutedFindingSummary = {
  route: FindingRoute;
  count: number;
};

export type RoutedAssetFinding = {
  projectPath: string;
  findingType: AssetInspectionFinding["type"];
  route: FindingRoute;
  routingRule: "asos-finding-routing.v1";
  evidencePaths: string[];
  reason: string;
};

export type AssetFindingRoutesArtifact = {
  contract: "asset-finding-routes.v1";
  generatedAt: string;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "ASOS Kernel / Workflow Orchestrator";
    authorityMode: "ORCHESTRATE";
    operationalStandard: "ASOS v1 / AVC v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  source: {
    assetInspectionContract: AssetInspectionReport["contract"];
    assetInspectionGeneratedAt: string;
    assetInspectionSha256: string;
  };
  counts: RoutedFindingSummary[];
  routes: RoutedAssetFinding[];
};

export type WorkflowArtifact = {
  name: "review-decisions" | "contract" | "catalog-index" | "asset-inspection" | "asset-finding-routes" | "review-inbox" | "operation-journal";
  role: "input" | "output";
  path: string;
  sha256: string;
  contract: string;
};

type GeneratedWorkflowArtifactName = Exclude<WorkflowArtifact["name"], "review-decisions">;

export type WorkflowStep = {
  name: GeneratedWorkflowArtifactName | "finding-router";
  authorityMode: string;
  status: "completed" | "blocked";
  inputArtifacts: string[];
  outputArtifacts: string[];
  notes: string[];
};

export type ReadOnlyRefreshWorkflowSummary = {
  contract: "asos-workflow-read-only-refresh.v1.1";
  workflow: "read-only-refresh";
  runId: string;
  generatedAt: string;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "ASOS Kernel / Workflow Orchestrator";
    authorityMode: "ORCHESTRATE";
    operationalStandard: "ASOS v1 / AVC v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  source: {
    vaultPath: string;
    outputDirectory: string;
    decisionsPath: string | null;
  };
  reviewStateMode: "fresh-unreviewed-snapshot" | "preserved-decisions";
  artifacts: WorkflowArtifact[];
  steps: WorkflowStep[];
  counts: {
    managedSongs: number;
    albumReleaseContainers: number;
    catalogFindings: number;
    assetProjects: number;
    assetRecords: number;
    assetFindings: number;
    reviewPending: number;
    reviewApproved: number;
    reviewRejected: number;
    reviewDeferred: number;
    pendingApply: number;
    blockedInsufficientEvidence: number;
  };
  findingRoutes: RoutedFindingSummary[];
  safety: {
    applyEnabled: false;
    vaultMutation: "none";
    reviewInboxIntegration: "catalog-findings-only";
    assetFindingPolicy: "routed-outside-inbox-unless-eligible-for-proposal";
  };
};

export async function runReadOnlyRefreshWorkflow(vaultInput: string, outputInput: string, decisionsInput?: string): Promise<ReadOnlyRefreshWorkflowSummary> {
  const vaultPath = await assertVaultDirectory(vaultInput);
  const outputPath = await assertOutputOutsideVault(vaultPath, outputInput);
  const outputDirectory = path.dirname(outputPath);
  const decisionsPath = decisionsInput
    ? await assertOperationalInputOutsideVault(vaultPath, decisionsInput, "review decisions")
    : null;
  const reviewStateMode = decisionsPath ? "preserved-decisions" as const : "fresh-unreviewed-snapshot" as const;
  const runId = runIdFromDate(new Date());
  const baseName = path.basename(outputPath, path.extname(outputPath));
  await mkdir(outputDirectory, { recursive: true });

  const contractPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "contract");
  const catalogIndexPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "catalog-index");
  const assetInspectionPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "asset-inspection");
  const assetFindingRoutesPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "asset-finding-routes");
  const reviewInboxPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "review-inbox");
  const operationJournalPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "operation-journal");

  const contractJson = renderManagedSongContractJson();
  await writeFile(contractPath, contractJson, "utf8");

  const catalogIndex = await publishCatalogIndex(vaultPath);
  await writeJson(catalogIndexPath, catalogIndex);

  const assetInspection = await inspectCatalogAssets(vaultPath);
  await writeJson(assetInspectionPath, assetInspection);
  const assetInspectionSha256 = await hashFile(assetInspectionPath);

  const routedAssetFindings = routeAssetFindings(assetInspection);
  const findingRoutes = summarizeFindingRoutes(routedAssetFindings);
  const assetFindingRoutes = buildAssetFindingRoutesArtifact(assetInspection, assetInspectionSha256, routedAssetFindings, findingRoutes);
  await writeJson(assetFindingRoutesPath, assetFindingRoutes);

  const reviewInbox = await buildReviewInboxFromIndexPath(catalogIndexPath, decisionsPath ?? undefined);
  await writeJson(reviewInboxPath, reviewInbox);

  const operationJournal = buildOperationJournal(reviewInbox);
  await writeJson(operationJournalPath, operationJournal);

  const artifacts: WorkflowArtifact[] = [
    ...(decisionsPath ? [await artifact("review-decisions", decisionsPath, "review-decisions.v1", "input")] : []),
    await artifact("contract", contractPath, "managed-song-contract.v1", "output"),
    await artifact("catalog-index", catalogIndexPath, catalogIndex.schemaVersion, "output"),
    await artifact("asset-inspection", assetInspectionPath, assetInspection.contract, "output"),
    await artifact("asset-finding-routes", assetFindingRoutesPath, assetFindingRoutes.contract, "output"),
    await artifact("review-inbox", reviewInboxPath, reviewInbox.schemaVersion, "output"),
    await artifact("operation-journal", operationJournalPath, operationJournal.schemaVersion, "output")
  ];

  const summary: ReadOnlyRefreshWorkflowSummary = {
    contract: "asos-workflow-read-only-refresh.v1.1",
    workflow: "read-only-refresh",
    runId,
    generatedAt: new Date().toISOString(),
    authority: workflowAuthority(),
    source: {
      vaultPath,
      outputDirectory,
      decisionsPath
    },
    reviewStateMode,
    artifacts,
    steps: workflowSteps(artifacts, findingRoutes, reviewStateMode),
    counts: workflowCounts(catalogIndex, assetInspection, reviewInbox, operationJournal),
    findingRoutes,
    safety: {
      applyEnabled: false,
      vaultMutation: "none",
      reviewInboxIntegration: "catalog-findings-only",
      assetFindingPolicy: "routed-outside-inbox-unless-eligible-for-proposal"
    }
  };
  await writeJson(outputPath, summary);
  return summary;
}

export function routeAssetInspectionFinding(finding: AssetInspectionFinding): FindingRoute {
  switch (finding.type) {
    case "media-info-audio-evidence":
    case "release-admin-empty":
      return "evidence-only";
    case "canonical-lyric-unresolved":
    case "provenance-insufficient":
      return "blocks-existing-proposal";
    case "multiple-audio-variants":
      return "reviewable";
    default:
      return "evidence-only";
  }
}

function workflowCounts(catalogIndex: CatalogIndex, assetInspection: AssetInspectionReport, reviewInbox: ReviewInbox, operationJournal: OperationJournal): ReadOnlyRefreshWorkflowSummary["counts"] {
  return {
    managedSongs: catalogIndex.counts.managedSongs,
    albumReleaseContainers: catalogIndex.counts.albumReleaseContainers,
    catalogFindings: catalogIndex.counts.findings,
    assetProjects: assetInspection.counts.projects,
    assetRecords: assetInspection.counts.assets,
    assetFindings: assetInspection.counts.findings,
    reviewPending: reviewInbox.counts.pending,
    reviewApproved: reviewInbox.counts.approved,
    reviewRejected: reviewInbox.counts.rejected,
    reviewDeferred: reviewInbox.counts.deferred,
    pendingApply: operationJournal.counts.pendingApply,
    blockedInsufficientEvidence: operationJournal.counts.blockedInsufficientEvidence
  };
}

function routeAssetFindings(report: AssetInspectionReport): RoutedAssetFinding[] {
  return report.inspections.flatMap((inspection) => inspection.findings.map((finding) => ({
    projectPath: inspection.projectPath,
    findingType: finding.type,
    route: routeAssetInspectionFinding(finding),
    routingRule: "asos-finding-routing.v1" as const,
    evidencePaths: finding.evidencePaths,
    reason: routingReason(finding)
  })));
}

function summarizeFindingRoutes(routes: RoutedAssetFinding[]): RoutedFindingSummary[] {
  const counts = new Map<FindingRoute, number>([
    ["evidence-only", 0],
    ["reviewable", 0],
    ["blocks-existing-proposal", 0],
    ["eligible-for-proposal", 0]
  ]);
  for (const finding of routes) {
    counts.set(finding.route, (counts.get(finding.route) ?? 0) + 1);
  }
  return [...counts.entries()].map(([route, count]) => ({ route, count }));
}

function buildAssetFindingRoutesArtifact(assetInspection: AssetInspectionReport, assetInspectionSha256: string, routes: RoutedAssetFinding[], counts: RoutedFindingSummary[]): AssetFindingRoutesArtifact {
  return {
    contract: "asset-finding-routes.v1",
    generatedAt: new Date().toISOString(),
    authority: workflowAuthority(),
    source: {
      assetInspectionContract: assetInspection.contract,
      assetInspectionGeneratedAt: assetInspection.generatedAt,
      assetInspectionSha256
    },
    counts,
    routes
  };
}

function routingReason(finding: AssetInspectionFinding): string {
  switch (finding.type) {
    case "media-info-audio-evidence":
      return "Media-info is supporting evidence only and cannot establish a canonical audio asset.";
    case "release-admin-empty":
      return "An empty release-admin folder is context only and does not justify a proposal.";
    case "canonical-lyric-unresolved":
      return "Canonical lyric evidence is unresolved, so related promotion remains blocked pending verified source evidence.";
    case "provenance-insufficient":
      return "Provenance evidence is insufficient, so related promotion remains blocked pending verified source paths or human designation.";
    case "multiple-audio-variants":
      return "Multiple audio variants require human review and explicit master designation before any proposal can become eligible.";
    default:
      return "The finding is retained as kernel routing context and is not eligible for direct Review Inbox promotion.";
  }
}

function workflowSteps(artifacts: WorkflowArtifact[], routes: RoutedFindingSummary[], reviewStateMode: ReadOnlyRefreshWorkflowSummary["reviewStateMode"]): WorkflowStep[] {
  const artifactPath = (name: WorkflowArtifact["name"]) => artifacts.find((artifactItem) => artifactItem.name === name)?.path ?? "";
  const routedCount = routes.reduce((total, route) => total + route.count, 0);
  const decisionsPath = artifactPath("review-decisions");
  return [
    {
      name: "contract",
      authorityMode: "OBSERVE_PROPOSE",
      status: "completed",
      inputArtifacts: [],
      outputArtifacts: [artifactPath("contract")],
      notes: ["Catalog Contract Steward emitted the active managed-song contract."]
    },
    {
      name: "catalog-index",
      authorityMode: "APPLY_OUTSIDE_VAULT",
      status: "completed",
      inputArtifacts: [artifactPath("contract")],
      outputArtifacts: [artifactPath("catalog-index")],
      notes: ["Catalog Publisher produced a disposable index outside the vault."]
    },
    {
      name: "asset-inspection",
      authorityMode: "OBSERVE",
      status: "completed",
      inputArtifacts: [artifactPath("catalog-index")],
      outputArtifacts: [artifactPath("asset-inspection")],
      notes: ["Asset Inspector inventoried asset folders without selecting canonical assets."]
    },
    {
      name: "finding-router",
      authorityMode: "ORCHESTRATE",
      status: "completed",
      inputArtifacts: [artifactPath("asset-inspection")],
      outputArtifacts: [artifactPath("asset-finding-routes")],
      notes: [`Kernel routed ${routedCount} asset findings into a hashed lineage artifact; only eligible-for-proposal findings may enter Review Inbox.`]
    },
    {
      name: "review-inbox",
      authorityMode: "PROPOSE",
      status: "completed",
      inputArtifacts: [artifactPath("catalog-index"), decisionsPath].filter((value) => value.length > 0),
      outputArtifacts: [artifactPath("review-inbox")],
      notes: [reviewStateMode === "preserved-decisions"
        ? "Review Inbox preserved approved, rejected, deferred, and pending states from the hashed decisions input; non-eligible Asset Inspector findings remained routed context."
        : "Review Inbox was generated from catalog findings only as a fresh unreviewed snapshot; non-eligible Asset Inspector findings remained routed context."]
    },
    {
      name: "operation-journal",
      authorityMode: "HANDOFF",
      status: "completed",
      inputArtifacts: [artifactPath("review-inbox")],
      outputArtifacts: [artifactPath("operation-journal")],
      notes: ["Operation Journal evaluated reviewed proposals without APPLY capability in this workflow."]
    }
  ];
}

async function workflowArtifactPath(vaultPath: string, outputDirectory: string, baseName: string, artifactName: GeneratedWorkflowArtifactName): Promise<string> {
  return assertOutputOutsideVault(vaultPath, path.join(outputDirectory, `${baseName}.${artifactName}.json`));
}

async function artifact(name: WorkflowArtifact["name"], artifactPath: string, contract: string, role: WorkflowArtifact["role"]): Promise<WorkflowArtifact> {
  return { name, role, path: artifactPath, sha256: await hashFile(artifactPath), contract };
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runIdFromDate(date: Date): string {
  return `read-only-refresh:${date.toISOString().replace(/[:.]/g, "-")}`;
}

function workflowAuthority(): ReadOnlyRefreshWorkflowSummary["authority"] {
  return {
    system: "AIBRY Catalog OS",
    specialist: "ASOS Kernel / Workflow Orchestrator",
    authorityMode: "ORCHESTRATE",
    operationalStandard: "ASOS v1 / AVC v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}
