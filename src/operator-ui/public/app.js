const token = new URLSearchParams(location.search).get("token") || "";
history.replaceState({}, "", location.pathname);

const state = {
  status: null,
  scout: null,
  proposal: null,
  proposalArtifact: null,
  decision: null,
  fixture: null,
  build: null,
  selectedReport: null
};

const byId = (id) => document.getElementById(id);
const setResult = (id, value) => {
  byId(id).innerHTML = `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
};
const setStage = (stage, status, label = status) => {
  const item = document.querySelector(`[data-stage="${stage}"]`);
  if (!item) return;
  item.classList.remove("running", "passed", "failed", "refused");
  item.classList.add(status);
  item.querySelector("strong").textContent = label;
};

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (init.method === "POST") {
    init.headers["Content-Type"] = "application/json";
    init.headers["X-Operator-Token"] = token;
    init.body = JSON.stringify(options.body || {});
  }
  const response = await fetch(path, init);
  const payload = await response.json();
  if (!response.ok) {
    const diagnostic = payload.error?.diagnostic;
    const safeChannel = diagnostic?.stderr || diagnostic?.stdout || "";
    const diagnosticLabel = diagnostic
      ? `${diagnostic.stage} · ${diagnostic.kind}${diagnostic.exitCode === null ? "" : ` · exit ${diagnostic.exitCode}`}`
      : "";
    throw new Error([
      payload.error?.message || `Request failed: ${response.status}`,
      diagnosticLabel,
      safeChannel
    ].filter(Boolean).join("\n\n"));
  }
  return payload;
}

async function runButton(button, action) {
  button.disabled = true;
  try {
    return await action();
  } catch (error) {
    alert(error.message);
    throw error;
  } finally {
    button.disabled = false;
    void loadActivity();
  }
}

async function loadStatus() {
  const status = await api("/api/status");
  state.status = status;
  byId("refresh-vault").textContent = status.musicVaultPath;
  const fields = {
    Repository: status.repositoryPath,
    "Music Vault": status.musicVaultPath,
    Reports: status.reportsPath,
    Node: status.nodeVersion,
    "Windows PowerShell": status.powerShellVersion || "Unavailable",
    Branch: status.currentBranch || "Unknown",
    "Dirty files": status.dirtyWorkingTreeCount ?? "Unknown",
    Build: status.frameworkBuildStatus,
    "Server start": status.serverStartTime
  };
  byId("status-grid").innerHTML = Object.entries(fields).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("");
  updatePreviews();
}

async function loadRegistry() {
  const registry = await api("/api/specialists");
  byId("specialist-select").innerHTML = registry.specialists.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.authorityModes.join(", "))}</option>`).join("");
  if (registry.specialists.length) await showSpecialist();
}

async function showSpecialist() {
  const specialist = await api(`/api/specialists/${encodeURIComponent(byId("specialist-select").value)}`);
  setResult("specialist-details", specialist);
}

async function loadReports() {
  const payload = await api("/api/reports");
  const body = byId("reports-list");
  body.innerHTML = payload.reports.map((report, index) => `<tr data-report-index="${index}"><td>${escapeHtml(report.relativePath)}</td><td>${escapeHtml(report.contract || "unknown")}</td><td>${report.size}</td><td>${escapeHtml(report.status)}</td></tr>`).join("");
  body.querySelectorAll("tr").forEach((row) => row.addEventListener("click", () => {
    body.querySelectorAll("tr").forEach((candidate) => candidate.classList.remove("selected"));
    row.classList.add("selected");
    state.selectedReport = payload.reports[Number(row.dataset.reportIndex)];
    ["view-formatted", "view-raw", "copy-report-path"].forEach((id) => { byId(id).disabled = false; });
    byId("verify-report").disabled = !state.selectedReport.contract;
  }));
}

async function viewReport(mode) {
  if (!state.selectedReport) return;
  const payload = await api(`/api/reports/view?path=${encodeURIComponent(state.selectedReport.relativePath)}&mode=${mode}&showPayload=${byId("show-payload").checked}`);
  byId("report-viewer").textContent = typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content, null, 2);
}

async function loadActivity() {
  const payload = await api("/api/activity");
  byId("activity-log").innerHTML = payload.activities.map((item) => `<div class="activity-item"><span>${escapeHtml(item.time)}</span><span>${escapeHtml(item.operation)}${item.outputPath ? ` · ${escapeHtml(item.outputPath)}` : ""}</span><strong class="${escapeHtml(item.status)}">${escapeHtml(item.status)}</strong><span>${item.durationMs ?? "—"} ms</span></div>`).join("") || "<p>No operations yet.</p>";
}

function updatePreviews() {
  const root = state.status?.repositoryPath || "C:\\Users\\bryan\\aibry\\projects\\aibry-catalog-os";
  const vault = state.status?.musicVaultPath || "C:\\AIBRY\\music-vault";
  const reports = state.status?.reportsPath || `${root}\\reports`;
  const cli = "dist\\src\\cli.js";
  const refreshOutput = `${reports}\\${byId("refresh-output").value.replaceAll("/", "\\")}`;
  const decisions = byId("refresh-decisions").value.trim();
  byId("refresh-command").textContent = `node ${cli} catalog workflow read-only-refresh --vault '${vault}' --output '${refreshOutput}'${decisions ? ` --decisions '${reports}\\${decisions.replaceAll("/", "\\")}'` : ""}`;
  const planning = byId("planning-input").value.trim();
  const scoutRefresh = byId("scout-refresh").value.trim();
  const scoutDirectory = byId("scout-directory").value.trim();
  byId("scout-command").textContent = scoutRefresh && scoutDirectory
    ? `node ${cli} catalog workflow scout-lyric-source-batch --vault '${vault}' --refresh-report '${reports}\\${scoutRefresh.replaceAll("/", "\\")}' --output-directory '${reports}\\${scoutDirectory.replaceAll("/", "\\")}' --min-tracks ${byId("scout-min-tracks").value} --max-tracks ${byId("scout-max-tracks").value}`
    : "Select a fresh refresh artifact to preview.";
  const proposalDir = byId("proposal-directory").value.trim();
  byId("proposal-command").textContent = planning
    ? `node ${cli} catalog workflow plan-lyric-source-migration --input '${reports}\\${planning.replaceAll("/", "\\")}' --output '${reports}\\${proposalDir.replaceAll("/", "\\")}\\lyric-source-designation-proposal.v1.json'`
    : "Select a planning input to preview.";
  const proposal = byId("build-proposal").value.trim();
  const decision = byId("build-decision").value.trim();
  const fixture = byId("build-fixture").value.trim();
  const output = byId("build-directory").value.trim();
  byId("build-command").textContent = proposal && decision && fixture && output
    ? `node ${cli} catalog workflow build-windows-lyric-source-apply --proposal '${reports}\\${proposal.replaceAll("/", "\\")}' --approval '${reports}\\${decision.replaceAll("/", "\\")}' --fixture-vault '${reports}\\${fixture.replaceAll("/", "\\")}' --dry-run-report '${reports}\\${output.replaceAll("/", "\\")}\\lyric-source-apply-dry-run-report.v1.json' --output '${reports}\\${output.replaceAll("/", "\\")}\\lyric-source-windows-apply.v1.ps1'`
    : "Complete the governed inputs to preview.";
  const fixtureScout = byId("fixture-scout-report").value.trim();
  const fixturePlanning = byId("fixture-planning-input").value.trim();
  const fixtureProposal = byId("fixture-proposal").value.trim();
  const fixtureDecision = byId("fixture-decision").value.trim();
  const fixtureOutput = byId("fixture-output-directory").value.trim();
  byId("fixture-command").textContent = fixtureScout && fixturePlanning && fixtureProposal && fixtureDecision && fixtureOutput
    ? `node ${cli} catalog workflow materialize-lyric-source-compatibility-fixture --scout-report '${reports}\\${fixtureScout.replaceAll("/", "\\")}' --planning-input '${reports}\\${fixturePlanning.replaceAll("/", "\\")}' --proposal '${reports}\\${fixtureProposal.replaceAll("/", "\\")}' --decision '${reports}\\${fixtureDecision.replaceAll("/", "\\")}' --output-directory '${reports}\\${fixtureOutput.replaceAll("/", "\\")}'`
    : "Complete the governed inputs to preview.";
}

function updateFixtureAvailability() {
  const complete = ["fixture-scout-report", "fixture-planning-input", "fixture-proposal", "fixture-decision", "fixture-output-directory"]
    .every((id) => byId(id).value.trim().length > 0);
  byId("materialize-fixture").disabled = !complete;
}

byId("refresh-status").addEventListener("click", () => runButton(byId("refresh-status"), loadStatus));
byId("refresh-registry").addEventListener("click", () => runButton(byId("refresh-registry"), loadRegistry));
byId("view-specialist").addEventListener("click", () => runButton(byId("view-specialist"), showSpecialist));
byId("run-typecheck").addEventListener("click", () => runButton(byId("run-typecheck"), async () => {
  byId("status-command").textContent = "npm run typecheck";
  setResult("refresh-result", await api("/api/framework/typecheck", { method: "POST", body: {} }));
}));
byId("run-build").addEventListener("click", () => runButton(byId("run-build"), async () => {
  byId("status-command").textContent = "npm run build";
  setResult("refresh-result", await api("/api/framework/build", { method: "POST", body: {} }));
}));

byId("run-refresh").addEventListener("click", () => runButton(byId("run-refresh"), async () => {
  setStage("refresh", "running", "Running");
  try {
    const result = await api("/api/catalog/refresh", { method: "POST", body: {
      outputPath: byId("refresh-output").value,
      decisionsPath: byId("refresh-decisions").value || undefined
    } });
    setResult("refresh-result", result);
    byId("refresh-command").textContent = result.commandPreview;
    byId("scout-refresh").value = result.outputPath;
    setStage("refresh", "passed", "Passed");
    updatePreviews();
  } catch (error) {
    setStage("refresh", "failed", "Failed");
    throw error;
  }
}));

byId("run-scout").addEventListener("click", () => runButton(byId("run-scout"), async () => {
  setStage("select", "running", "Scouting");
  byId("generate-proposal").disabled = true;
  try {
    const result = await api("/api/lyric-source/scout", { method: "POST", body: {
      refreshReportPath: byId("scout-refresh").value,
      outputDirectory: byId("scout-directory").value,
      minTracks: Number(byId("scout-min-tracks").value),
      maxTracks: Number(byId("scout-max-tracks").value)
    } });
    state.scout = result;
    setResult("scout-result", result);
    byId("scout-command").textContent = result.commandPreview;
    if (result.status === "passed") {
      byId("planning-input").value = result.planningInput.path;
      byId("fixture-scout-report").value = result.scoutReport.path;
      byId("fixture-planning-input").value = result.planningInput.path;
      byId("generate-proposal").disabled = false;
      setStage("select", "passed", "Planning Input Sealed");
      updatePreviews();
      void loadReports();
      return;
    }
    byId("planning-input").value = "";
    setStage("select", "refused", "Refused");
    updatePreviews();
  } catch (error) {
    byId("planning-input").value = "";
    setStage("select", "failed", "Failed");
    updatePreviews();
    throw error;
  }
}));

byId("generate-proposal").addEventListener("click", () => runButton(byId("generate-proposal"), async () => {
  setStage("select", "passed", "Selected");
  setStage("proposal", "running", "Running");
  try {
    const result = await api("/api/lyric-source/plan", { method: "POST", body: {
      planningInputPath: byId("planning-input").value,
      outputDirectory: byId("proposal-directory").value
    } });
    state.proposal = result.proposal;
    state.proposalArtifact = result.artifact;
    byId("approval-proposal").value = result.artifact.path;
    byId("build-proposal").value = result.artifact.path;
    byId("fixture-proposal").value = result.artifact.path;
    byId("verify-proposal").disabled = false;
    ["approve-proposal", "reject-proposal", "defer-proposal"].forEach((id) => { byId(id).disabled = false; });
    setResult("proposal-result", result);
    byId("proposal-command").textContent = result.commandPreview;
    setStage("proposal", "passed", "Passed");
    setStage("review", "passed", "Verified");
    setStage("approve", "", "Awaiting authorization");
    updatePreviews();
    void loadReports();
  } catch (error) {
    setStage("proposal", "failed", "Failed");
    throw error;
  }
}));

byId("verify-proposal").addEventListener("click", () => runButton(byId("verify-proposal"), async () => {
  const result = await api("/api/artifacts/verify", { method: "POST", body: {
    path: state.proposalArtifact.path,
    expectedContract: "lyric-source-designation-proposal.v1",
    expectedSha256: state.proposalArtifact.sha256
  } });
  setResult("proposal-result", result);
}));

byId("approve-proposal").addEventListener("click", () => {
  const details = {
    "Proposal ID": state.proposal?.proposalId || "Load a proposal",
    "Full SHA-256": state.proposal?.proposalSha256 || "Unknown",
    "Included projects": state.proposal?.includedProjects?.length ?? 0,
    Operations: state.proposal?.operationCount ?? 0
  };
  byId("approval-confirmation").innerHTML = Object.entries(details).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("");
  byId("approval-confirmation-input").value = "";
  byId("approval-dialog").showModal();
});

byId("approval-dialog").addEventListener("close", () => {
  if (byId("approval-dialog").returnValue !== "approve") return;
  void createDecision("approved", byId("approval-confirmation-input").value);
});
byId("reject-proposal").addEventListener("click", () => void createDecision("rejected", ""));
byId("defer-proposal").addEventListener("click", () => void createDecision("deferred", ""));

async function createDecision(decisionState, confirmation) {
  const button = byId(decisionState === "approved" ? "approve-proposal" : decisionState === "rejected" ? "reject-proposal" : "defer-proposal");
  await runButton(button, async () => {
    const result = await api("/api/decisions", { method: "POST", body: {
      proposalPath: byId("approval-proposal").value,
      decisionState,
      confirmation
    } });
    state.decision = result;
    setResult("approval-result", result);
    if (decisionState === "approved") {
      byId("build-decision").value = result.outputPath;
      byId("fixture-decision").value = result.outputPath;
      byId("build-script").disabled = true;
      setStage("approve", "passed", "Approved exact hash");
      updateFixtureAvailability();
      updatePreviews();
    } else {
      setStage("approve", "refused", decisionState);
    }
    void loadReports();
  });
}

byId("materialize-fixture").addEventListener("click", () => runButton(byId("materialize-fixture"), async () => {
  setStage("fixture", "running", "Running");
  byId("build-script").disabled = true;
  try {
    const result = await api("/api/lyric-source/materialize-fixture", { method: "POST", body: {
      scoutReportPath: byId("fixture-scout-report").value,
      planningInputPath: byId("fixture-planning-input").value,
      proposalPath: byId("fixture-proposal").value,
      decisionPath: byId("fixture-decision").value,
      outputDirectory: byId("fixture-output-directory").value
    } });
    state.fixture = result;
    byId("build-fixture").value = result.fixturePath;
    byId("build-script").disabled = false;
    byId("fixture-command").textContent = result.commandPreview;
    setResult("fixture-result", result);
    setStage("fixture", "passed", "Verified fixture");
    updatePreviews();
    void loadReports();
  } catch (error) {
    setStage("fixture", "failed", "Failed");
    throw error;
  }
}));

byId("build-script").addEventListener("click", () => runButton(byId("build-script"), async () => {
  setStage("build", "running", "Running");
  try {
    const result = await api("/api/lyric-source/build-script", { method: "POST", body: {
      proposalPath: byId("build-proposal").value,
      decisionPath: byId("build-decision").value,
      fixtureVaultPath: byId("build-fixture").value,
      outputDirectory: byId("build-directory").value
    } });
    state.build = result;
    const scriptPath = `${byId("build-directory").value}/lyric-source-windows-apply.v1.ps1`;
    byId("handoff-manifest").value = result.operatorPackagePath;
    byId("run-dryrun").dataset.scriptPath = scriptPath;
    byId("run-dryrun").disabled = false;
    byId("build-handoff").disabled = false;
    byId("build-command").textContent = result.commandPreview;
    setResult("build-result", result);
    setStage("build", "passed", "Passed");
    void loadReports();
  } catch (error) {
    setStage("build", "failed", "Failed");
    throw error;
  }
}));

byId("run-dryrun").addEventListener("click", () => runButton(byId("run-dryrun"), async () => {
  setStage("dryrun", "running", "Running");
  try {
    const result = await api("/api/lyric-source/dry-run", { method: "POST", body: {
      proposalPath: byId("build-proposal").value,
      scriptPath: byId("run-dryrun").dataset.scriptPath,
      fixtureVaultPath: byId("build-fixture").value,
      outputDirectory: byId("dryrun-directory").value
    } });
    setResult("build-result", result);
    setStage("dryrun", "passed", "Passed");
    void loadReports();
  } catch (error) {
    setStage("dryrun", "failed", "Failed");
    throw error;
  }
}));

byId("build-handoff").addEventListener("click", () => runButton(byId("build-handoff"), async () => {
  setStage("handoff", "running", "Running");
  try {
    const result = await api("/api/lyric-source/handoff", { method: "POST", body: {
      packageManifestPath: byId("handoff-manifest").value
    } });
    setResult("build-result", result);
    setStage("handoff", "passed", "Eligible for guarded APPLY");
  } catch (error) {
    setStage("handoff", "failed", "Failed");
    throw error;
  }
}));

byId("refresh-reports").addEventListener("click", () => runButton(byId("refresh-reports"), loadReports));
byId("view-formatted").addEventListener("click", () => viewReport("formatted"));
byId("view-raw").addEventListener("click", () => viewReport("raw"));
byId("copy-report-path").addEventListener("click", () => state.selectedReport && navigator.clipboard.writeText(state.selectedReport.relativePath));
byId("verify-report").addEventListener("click", () => runButton(byId("verify-report"), async () => {
  const result = await api("/api/artifacts/verify", { method: "POST", body: {
    path: state.selectedReport.relativePath,
    expectedContract: state.selectedReport.contract,
    expectedSha256: state.selectedReport.sha256
  } });
  byId("report-viewer").textContent = JSON.stringify(result, null, 2);
}));
byId("refresh-activity").addEventListener("click", () => runButton(byId("refresh-activity"), loadActivity));

document.querySelectorAll("[data-copy-target]").forEach((button) => button.addEventListener("click", () => {
  void navigator.clipboard.writeText(byId(button.dataset.copyTarget).textContent);
}));
["refresh-output", "refresh-decisions", "scout-refresh", "scout-directory", "scout-min-tracks", "scout-max-tracks", "planning-input", "proposal-directory", "build-proposal", "build-decision", "build-fixture", "build-directory", "fixture-scout-report", "fixture-planning-input", "fixture-proposal", "fixture-decision", "fixture-output-directory"].forEach((id) => byId(id).addEventListener("input", updatePreviews));
["fixture-scout-report", "fixture-planning-input", "fixture-proposal", "fixture-decision", "fixture-output-directory"].forEach((id) => byId(id).addEventListener("input", () => {
  state.fixture = null;
  byId("build-script").disabled = true;
  updateFixtureAvailability();
}));
byId("build-fixture").addEventListener("input", () => { if (!state.fixture || byId("build-fixture").value !== state.fixture.fixturePath) byId("build-script").disabled = true; });
byId("planning-input").addEventListener("input", () => { byId("generate-proposal").disabled = byId("planning-input").value.trim().length === 0; });

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

Promise.all([loadStatus(), loadRegistry(), loadReports(), loadActivity()]).catch((error) => alert(error.message));
