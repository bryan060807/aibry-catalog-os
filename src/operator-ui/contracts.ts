import type { Server } from "node:http";

export type OperatorUiConfig = {
  repositoryRoot: string;
  musicVaultRoot: string;
  reportsRoot: string;
  publicRoot: string;
  cliPath: string;
  host: "127.0.0.1";
  port: number;
  requestBodyLimitBytes: number;
  commandTimeoutMs: number;
};

export type OperatorActivity = {
  time: string;
  operation: string;
  status: "running" | "passed" | "refused" | "failed";
  durationMs: number | null;
  outputPath: string | null;
  outputSha256: string | null;
  refusalReason: string | null;
};

export type OperatorApiErrorShape = {
  error: {
    code: string;
    message: string;
    details: string[];
    diagnostic?: {
      stage: string;
      kind: string;
      exitCode: number | null;
      stderr: string | null;
      stdout: string | null;
    };
  };
};

export type OperatorUiRuntime = {
  server: Server;
  url: string;
  token: string;
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
};

export class OperatorRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "OperatorRequestError";
  }
}
