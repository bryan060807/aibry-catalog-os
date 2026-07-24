import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPowerShellParses,
  getPowerShellRuntime,
  POWERSHELL_PROBE_MAX_BUFFER_BYTES,
  POWERSHELL_PROBE_TIMEOUT_MS,
  PowerShellProbeError,
  runBoundedPowerShellProbe
} from "../src/lyric-source/dry-run-specialist.js";

const powerShell51 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

test("bounded PowerShell version probe succeeds with parseable runtime output", async () => {
  const runtime = await getPowerShellRuntime(powerShell51);
  assert.match(runtime.powerShellVersion, /^5\.1\.\d+\.\d+$/);
  assert.match(runtime.clrVersion, /^4\.0\.\d+\.\d+$/);
});

test("bounded PowerShell parse probe accepts a valid script", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-probe-parse-"));
  try {
    const scriptPath = path.join(root, "valid.ps1");
    await writeFile(scriptPath, "[CmdletBinding()]\nparam()\n", "utf8");
    await assertPowerShellParses(powerShell51, scriptPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delayed PowerShell probe times out at its named stage and leaves no child", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "powershell-probe-timeout-"));
  try {
    const pidPath = path.join(root, "child.pid");
    const literal = pidPath.replace(/'/g, "''");
    const startedAt = Date.now();
    await assert.rejects(
      runBoundedPowerShellProbe(powerShell51, "deliberate-delay", `[System.IO.File]::WriteAllText('${literal}', [string]$PID); Start-Sleep -Seconds 120`),
      (error: unknown) => {
        assert.ok(error instanceof PowerShellProbeError);
        assert.equal(error.stage, "deliberate-delay");
        assert.equal(error.kind, "timeout");
        assert.match(error.message, /deliberate-delay timed out/);
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= POWERSHELL_PROBE_TIMEOUT_MS - 1_000, `Probe returned too early after ${elapsed} ms.`);
    assert.ok(elapsed < POWERSHELL_PROBE_TIMEOUT_MS + 10_000, `Probe exceeded its bounded timeout: ${elapsed} ms.`);
    const childPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    assert.equal(Number.isInteger(childPid), true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(processExists(childPid), false, `PowerShell probe child ${childPid} survived timeout handling.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell probe maxBuffer overflow is bounded and stage-specific", async () => {
  await assert.rejects(
    runBoundedPowerShellProbe(powerShell51, "bounded-output", `[Console]::Out.Write(('x' * ${POWERSHELL_PROBE_MAX_BUFFER_BYTES + 1024}))`),
    (error: unknown) => {
      assert.ok(error instanceof PowerShellProbeError);
      assert.equal(error.stage, "bounded-output");
      assert.equal(error.kind, "max-buffer");
      assert.match(error.message, /bounded-output exceeded/);
      return true;
    }
  );
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ESRCH") return false;
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
