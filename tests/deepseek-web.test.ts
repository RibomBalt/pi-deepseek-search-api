import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import deepseekWebExtension from "../extensions/deepseek-web.js";

const TEST_KEY = "unit-test-key-not-a-credential";
type TestTool = ToolDefinition<any, any, any>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getTools(): TestTool[] {
  const tools: TestTool[] = [];
  const extensionApi = {
    registerTool(tool: TestTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  deepseekWebExtension(extensionApi);
  return tools;
}

function getTool(name: string): TestTool {
  const tool = getTools().find((candidate) => candidate.name === name);
  expect(tool, `registered tool ${name}`).toBeDefined();
  return tool!;
}

function makeContext(apiKey: string | undefined = TEST_KEY) {
  const getApiKeyForProvider = vi.fn().mockResolvedValue(apiKey);
  const context = {
    modelRegistry: { getApiKeyForProvider },
  } as unknown as ExtensionToolContext;
  return { context, getApiKeyForProvider };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

async function executeTool(name: string, args: unknown, apiKey: string | undefined = TEST_KEY, signal?: AbortSignal) {
  const tool = getTool(name);
  const { context, getApiKeyForProvider } = makeContext(apiKey);
  const result = await tool.execute("test-call", args as never, signal, undefined, context);
  return { result, getApiKeyForProvider };
}

describe("DeepSeek native tools", () => {
  it("registers exactly the two native tools with required argument fields", () => {
    const tools = getTools();

    expect(tools.map((tool) => tool.name)).toEqual(["deepseek_search", "deepseek_fetch"]);
    expect(tools.find((tool) => tool.name === "deepseek_search")?.parameters.required).toEqual(["query"]);
    expect(tools.find((tool) => tool.name === "deepseek_fetch")?.parameters.required).toEqual(["url"]);
  });

  it("declares Search bounds and optional arguments in the tool schema", () => {
    const schema = getTool("deepseek_search").parameters;
    const properties = schema.properties as Record<string, { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>;

    expect(properties.query).toMatchObject({ type: "string", minLength: 1, maxLength: 128 });
    expect(properties.count).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    expect(properties.ori_question).toMatchObject({ type: "string", minLength: 1, maxLength: 128 });
    expect(properties.need_content?.type).toBe("boolean");
  });

  it("describes returned webpage content as untrusted source material", () => {
    const descriptions = getTools().map((tool) => tool.description.toLowerCase()).join(" ");

    expect(descriptions).toMatch(/untrusted|不可信/);
  });

  it("resolves the provider key at each Search invocation and returns Search output", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ title: "Result", url: "https://example.com", summary: "Summary" }],
    }));
    vi.stubGlobal("fetch", fakeFetch);
    const tool = getTool("deepseek_search");
    const { context, getApiKeyForProvider } = makeContext();

    const result = await tool.execute("call-1", { query: "pi" }, undefined, undefined, context);

    expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
    expect(getApiKeyForProvider).toHaveBeenCalledWith("deepseek");
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("Summary");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a Pi login hint without making a request when the key is missing", async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    const getApiKeyForProvider = vi.fn().mockResolvedValue(undefined);
    const context = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionToolContext;
    const result = await getTool("deepseek_search").execute("missing-key", { query: "pi" }, undefined, undefined, context);

    expect(getApiKeyForProvider).toHaveBeenCalledWith("deepseek");
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/\/login deepseek/);
    expect(resultText(result)).not.toContain(TEST_KEY);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["one Unicode character", "雪", false],
    ["128 Unicode characters", "雪".repeat(128), false],
    ["129 Unicode characters", "雪".repeat(129), true],
    ["whitespace-only query", " \t\n", true],
  ])("validates Search query length (%s)", async (_caseName, query, invalid) => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_search", { query });

    expect(result.isError).toBe(invalid);
    expect(fakeFetch).toHaveBeenCalledTimes(invalid ? 0 : 1);
  });

  it.each([
    ["minimum", 1, false],
    ["maximum", 50, false],
    ["below minimum", 0, true],
    ["above maximum", 51, true],
    ["fractional", 1.5, true],
  ])("validates Search count (%s)", async (_caseName, count, invalid) => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_search", { query: "pi", count });

    expect(result.isError).toBe(invalid);
    expect(fakeFetch).toHaveBeenCalledTimes(invalid ? 0 : 1);
  });

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(129)],
  ])("rejects an %s Search ori_question before network access", async (_caseName, oriQuestion) => {
    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_search", { query: "pi", ori_question: oriQuestion });

    expect(result.isError).toBe(true);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP", "http://example.com"],
    ["HTTPS", "https://example.com/article"],
  ])("accepts a valid %s Fetch URL", async (_caseName, url) => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ title: "Example", content: "Page" }));
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_fetch", { url });

    expect(result.isError).not.toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing host", "http://?missing-host"],
    ["unsupported protocol", "ftp://example.com/file"],
    ["username", "https://user@example.com/file"],
    ["password", "https://user:pass@example.com/file"],
    ["over 8192 characters", `https://example.com/${"x".repeat(8192)}`],
  ])("rejects a Fetch URL with %s before network access", async (_caseName, url) => {
    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_fetch", { url });

    expect(result.isError).toBe(true);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed tool arguments before resolving credentials", async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);
    const { context, getApiKeyForProvider } = makeContext();

    const result = await getTool("deepseek_search").execute(
      "call-invalid",
      { query: " \n " },
      undefined,
      undefined,
      context,
    );

    expect(result.isError).toBe(true);
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("forwards a tool cancellation signal to the API request", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fakeFetch);
    const controller = new AbortController();
    const { context } = makeContext();

    await getTool("deepseek_search").execute("call-abort", { query: "pi" }, controller.signal, undefined, context);

    expect(fakeFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("looks up the Pi-managed provider key for every invocation", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fakeFetch);
    const { context, getApiKeyForProvider } = makeContext();
    const tool = getTool("deepseek_search");

    await tool.execute("call-1", { query: "one" }, undefined, undefined, context);
    await tool.execute("call-2", { query: "two" }, undefined, undefined, context);

    expect(getApiKeyForProvider).toHaveBeenCalledTimes(2);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not include a fake key in API error tool output", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: `denied ${TEST_KEY}` } }, 401));
    vi.stubGlobal("fetch", fakeFetch);

    const { result } = await executeTool("deepseek_fetch", { url: "https://example.com" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("HTTP 401");
    expect(resultText(result)).not.toContain(TEST_KEY);
  });
});
