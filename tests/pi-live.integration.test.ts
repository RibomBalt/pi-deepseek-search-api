import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionPath = resolve(fileURLToPath(new URL("../extensions/deepseek-web.ts", import.meta.url)));
const timeoutMs = 120_000;

type RpcEvent = {
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { disposition?: string };
  toolName?: string;
  isError?: boolean;
  result?: { content?: Array<{ type?: string; text?: string }> };
  [key: string]: unknown;
};

function summarizeEvents(events: RpcEvent[]): string {
  return events.map((event) => {
    const message = typeof event.message === "object" && event.message !== null
      ? event.message as Record<string, unknown>
      : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const blockTypes = content.map((block) => {
      if (typeof block !== "object" || block === null) return "unknown";
      const value = block as Record<string, unknown>;
      return value.type === "toolCall" && typeof value.name === "string" ? `tool:${value.name}` : String(value.type ?? "unknown");
    });
    return [
      event.type ?? "unknown",
      typeof message?.role === "string" ? message.role : "",
      typeof message?.stopReason === "string" ? message.stopReason : "",
      blockTypes.join("+"),
    ].filter(Boolean).join(":");
  }).join(", ");
}

function sanitize(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

describe("live Pi + DeepSeek integration", () => {
  it("runs Search and Fetch through the current system Pi profile", async () => {
    const child = spawn("pi", [
      "--mode", "rpc",
      "--no-session",
      "--no-mcp",
      "--no-skills",
      "--no-extensions",
      "--tools", "deepseek_search,deepseek_fetch",
      "--extension", extensionPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const events: RpcEvent[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let markRunFinished!: () => void;
    const runFinished = new Promise<void>((resolveRun) => { markRunFinished = resolveRun; });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });

    function collectEvent(line: string): void {
      try {
        const event = JSON.parse(line) as RpcEvent;
        events.push(event);
        if (
          event.type === "agent_settled" ||
          (event.type === "response" && event.command === "prompt" && (
            event.success === false || event.data?.disposition === "handled"
          ))
        ) {
          markRunFinished();
        }
      } catch {
        // Non-event output is ignored; assertions below report missing RPC events.
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) collectEvent(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => { spawnError = error; });
    child.once("close", () => markRunFinished());
    child.stdin.on("error", () => markRunFinished());

    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    try {
      child.stdin.write(`${JSON.stringify({
        id: "live-search-fetch",
        type: "prompt",
        message: "Call deepseek_search exactly once with query 'Pi package integration test'. Then call deepseek_fetch exactly once with url 'https://example.com'. Do not use other tools. After both calls, briefly report whether each returned data.",
      })}\n`);
      await runFinished;
      if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      const exit = await exitPromise;

      if (spawnError) {
        throw new Error(`Could not start system Pi. Ensure pi is installed and on PATH. ${sanitize(spawnError.message)}`);
      }
      if (exit.code !== 0) {
        throw new Error(`System Pi exited with code ${String(exit.code)} (${String(exit.signal)}). ${sanitize(stderr)}`);
      }
      if (stdoutBuffer.trim()) {
        collectEvent(stdoutBuffer);
      }

      const promptFailure = events.find((event) => event.type === "response" && event.command === "prompt" && event.success === false);
      if (promptFailure) {
        throw new Error(`Pi could not complete the live prompt. Check the current Pi model and provider login. ${sanitize(promptFailure.error ?? "")}`);
      }

      for (const toolName of ["deepseek_search", "deepseek_fetch"]) {
        const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === toolName);
        const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
        if (starts.length !== 1) {
          throw new Error(`Pi did not invoke ${toolName}. Check that the current model supports tool calls and is authenticated. Observed: ${summarizeEvents(events)}. ${sanitize(stderr)}`);
        }
        expect(ends, `${toolName} end event`).toHaveLength(1);
        expect(ends[0]?.isError, `${toolName} should succeed; Pi stderr: ${sanitize(stderr)}`).toBe(false);
        const text = ends[0]?.result?.content
          ?.filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n") ?? "";
        expect(text.trim(), `${toolName} should return non-empty text`).not.toBe("");
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }, timeoutMs + 5_000);
});
