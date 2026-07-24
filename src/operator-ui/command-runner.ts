import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BoundedCommandSpec = {
  stage: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes?: number;
};

export type BoundedCommandResult = {
  exitCode: 0;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

export type BoundedCommandDiagnostic = {
  stage: string;
  kind: BoundedCommandError["kind"];
  exitCode: number | null;
  stderr: string | null;
  stdout: string | null;
};

const DIAGNOSTIC_CHANNEL_LIMIT_BYTES = 2048;

export class BoundedCommandError extends Error {
  public constructor(
    public readonly stage: string,
    public readonly kind: "timeout" | "aborted" | "nonzero-exit" | "launch-failure" | "max-buffer",
    message: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(`${stage}: ${message}`);
    this.name = "BoundedCommandError";
  }
}

export function boundedCommandDiagnostic(error: BoundedCommandError): BoundedCommandDiagnostic {
  const stderr = sanitizeDiagnosticChannel(error.stderr);
  const stdoutCandidate = stderr ? "" : sanitizeDiagnosticChannel(error.stdout);
  const stdout = isUsefulDiagnosticStdout(stdoutCandidate) ? stdoutCandidate : "";
  return {
    stage: error.stage.replace(/[^a-z0-9._-]/gi, "-").slice(0, 128),
    kind: error.kind,
    exitCode: error.exitCode,
    stderr: stderr || null,
    stdout: stdout || null
  };
}

export async function runBoundedCommand(spec: BoundedCommandSpec, signal?: AbortSignal): Promise<BoundedCommandResult> {
  const started = Date.now();
  const maxBuffer = spec.maxBufferBytes ?? 1024 * 1024;
  return new Promise<BoundedCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationKind: BoundedCommandError["kind"] | null = null;
    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const finish = (error: BoundedCommandError | null, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (exitCode !== 0) reject(new BoundedCommandError(spec.stage, "nonzero-exit", `process exited with code ${String(exitCode)}.`, exitCode, stdout, stderr));
      else resolve({ exitCode: 0, stdout, stderr, elapsedMs: Date.now() - started });
    };
    const terminate = (kind: BoundedCommandError["kind"], message: string): void => {
      if (settled || terminationKind) return;
      terminationKind = kind;
      void terminateOwnedProcess(child.pid).finally(() => {
        finish(new BoundedCommandError(spec.stage, kind, message, null, stdout, stderr), null);
      });
    };
    const append = (channel: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (channel === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        terminate("max-buffer", `output exceeded ${maxBuffer} bytes.`);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      finish(new BoundedCommandError(spec.stage, "launch-failure", error.message, null, stdout, stderr), null);
    });
    child.once("close", (code) => {
      if (!terminationKind) finish(null, code);
    });
    const abort = (): void => terminate("aborted", "request was cancelled; the owned process tree was terminated.");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate("timeout", `process exceeded ${spec.timeoutMs} ms.`), spec.timeoutMs);
    timer.unref();
    if (signal?.aborted) abort();
  });
}

function sanitizeDiagnosticChannel(input: string): string {
  if (!input.trim()) return "";
  const sanitized = input
    .replace(/("(?:contentBase64|proposedContent|currentContent|lyricContents?)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
    .replace(/\b(contentBase64|proposedContent|currentContent|lyricContents?)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(authorization|cookie|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]{2,})=(?:"[^"]*"|'[^']*'|\S+)/g, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[encoded-payload-redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return utf8Tail(sanitized.trim(), DIAGNOSTIC_CHANNEL_LIMIT_BYTES);
}

function isUsefulDiagnosticStdout(input: string): boolean {
  return /^(?:error|refused|invalid|expected|required|missing|unsafe|usage)\b/im.test(input);
}

function utf8Tail(input: string, maximumBytes: number): string {
  const bytes = Buffer.from(input, "utf8");
  return bytes.byteLength <= maximumBytes
    ? input
    : bytes.subarray(bytes.byteLength - maximumBytes).toString("utf8");
}

export function renderCommandPreview(executableLabel: string, args: readonly string[]): string {
  return [executableLabel, ...args].map(quotePowerShellArgument).join(" ");
}

function quotePowerShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

async function terminateOwnedProcess(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      });
    } catch {
      return;
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}
