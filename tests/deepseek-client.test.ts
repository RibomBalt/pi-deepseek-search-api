import { describe, expect, it, vi } from "vitest";
import {
  createDeepSeekClient,
  type DeepSeekFetchArgs,
  type DeepSeekSearchArgs,
} from "../extensions/deepseek-client.js";

const TEST_KEY = "unit-test-key-not-a-credential";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function getRequestInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const call = fetchMock.mock.calls[0];
  expect(call).toBeDefined();
  return call[1] as RequestInit;
}

describe("DeepSeek HTTP client", () => {
  it("sends Search defaults to the fixed endpoint", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await client.search({ query: "pi extensions" });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/search",
      expect.any(Object),
    );
    const init = getRequestInit(fakeFetch);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TEST_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: "pi extensions",
      count: 10,
      need_content: false,
    });
  });

  it("maps every supplied Search option into the request body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await client.search({
      query: "site:example.com DeepSeek",
      count: 5,
      ori_question: "Where are the docs?",
      localization: "203.0.113.9",
      need_content: true,
    });

    expect(JSON.parse(getRequestInit(fakeFetch).body as string)).toEqual({
      query: "site:example.com DeepSeek",
      count: 5,
      ori_question: "Where are the docs?",
      localization: "203.0.113.9",
      need_content: true,
    });
  });

  it("sends Fetch to the fixed endpoint and forwards the cancellation signal", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ title: "Example", content: "# Example" }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);
    const controller = new AbortController();

    await client.fetchPage({ url: "https://example.com/article" }, controller.signal);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/fetch",
      expect.any(Object),
    );
    const init = getRequestInit(fakeFetch);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TEST_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/article" });
    expect(init.signal).toBe(controller.signal);
  });

  it("formats documented Search result fields as readable source entries", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      results: [{
        title: "Pi Extensions",
        url: "https://example.com/pi",
        snippet: "Short result text",
        summary: "Long result summary",
        content: "Full page body",
        site_name: "Example",
        site_icon: "https://example.com/favicon.ico",
        date: "2026-10-19T00:00:00+00:00",
        rerank_score: 2.4,
        authority: 3,
      }],
    }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.search({ query: "pi", need_content: true });

    expect(result).toContain("Pi Extensions");
    expect(result).toContain("https://example.com/pi");
    expect(result).toContain("Long result summary");
    expect(result).toContain("Short result text");
    expect(result).toContain("Example");
    expect(result).toContain("2026-10-19T00:00:00+00:00");
    expect(result).toContain("Relevance: 2.4");
    expect(result).toContain("Authority: 3");
    expect(result).toContain("Full page body");
    expect(result).toContain("untrusted source material");
  });

  it("returns an explicit message for empty or missing Search results", async () => {
    for (const payload of [{ results: [] }, {}]) {
      const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(payload));
      const client = createDeepSeekClient(TEST_KEY, fakeFetch);

      await expect(client.search({ query: "nothing" })).resolves.toMatch(/no search results/i);
    }
  });

  it("formats a result when optional metadata fields are absent", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ title: "Minimal", url: "https://example.com", summary: "Summary" }],
    }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.search({ query: "minimal" });

    expect(result).toContain("Minimal");
    expect(result).toContain("https://example.com");
    expect(result).toContain("Summary");
  });

  it("does not include Search content unless requested", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ title: "A", url: "https://a.test", summary: "Summary", content: "Page body" }],
    }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.search({ query: "a", need_content: false });

    expect(result).not.toContain("Page body");
  });

  it("formats Fetch title and Markdown body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      title: "Example article",
      content: "# Example article\n\nArticle text.",
    }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.fetchPage({ url: "https://example.com/article" });

    expect(result).toContain("Example article");
    expect(result).toContain("# Example article");
    expect(result).toContain("Article text.");
    expect(result).toContain("untrusted source material");
  });

  it("preserves Fetch content at the 30,000-character limit", async () => {
    const content = "x".repeat(30_000);
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ title: "Large", content }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.fetchPage({ url: "https://example.com/large" });

    expect(result.endsWith(content)).toBe(true);
    expect(result).not.toContain("truncated");
  });

  it("truncates Fetch content after 30,000 characters and marks the result", async () => {
    const content = "x".repeat(30_001);
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ title: "Large", content }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.fetchPage({ url: "https://example.com/large" });

    expect(result).toContain("x".repeat(30_000));
    expect(result).not.toContain("x".repeat(30_001));
    expect(result).toMatch(/truncated/i);
    const bodyStart = result.indexOf("x".repeat(64));
    const markerStart = result.indexOf("[Fetch content truncated");
    expect(result.slice(bodyStart, markerStart).trimEnd()).toBe("x".repeat(30_000));
  });

  it("reports an API error message and HTTP status", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      error: { message: "Invalid query", type: "invalid_request_error", param: null, code: "invalid_request_error" },
    }, 400));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await expect(client.search({ query: "x" })).rejects.toThrow(/HTTP 400.*Invalid query/);
  });

  it("reports status and a generic message when an API error has no message", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { type: "server_error" } }, 500));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await expect(client.search({ query: "x" })).rejects.toThrow(/HTTP 500/);
  });

  it("hides non-JSON error bodies and includes their HTTP status", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(textResponse("secret response details", 502));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const error = await client.search({ query: "x" }).catch((value: unknown) => String(value));

    expect(error).toMatch(/HTTP 502/);
    expect(error).not.toContain("secret response details");
  });

  it("returns a concise error for a non-JSON success response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(textResponse("html body", 200));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await expect(client.fetchPage({ url: "https://example.com" })).rejects.toThrow(/invalid JSON.*HTTP 200/i);
  });

  it("does not retry a network failure or include its message", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error(`failed request using ${TEST_KEY}`));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const error = await client.search({ query: "x" }).catch((value: unknown) => String(value));

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(error).toMatch(/network/i);
    expect(error).not.toContain(TEST_KEY);
  });

  it("returns a cancellation error when fetch aborts", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const error = await client.fetchPage({ url: "https://example.com" }).catch((value: unknown) => String(value));

    expect(error).toMatch(/cancel/i);
    expect(error).not.toContain(TEST_KEY);
  });

  it("returns a cancellation error when reading the response body is aborted", async () => {
    const response = jsonResponse({ results: [] });
    vi.spyOn(response, "text").mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    const fakeFetch = vi.fn().mockResolvedValue(response);
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    await expect(client.search({ query: "x" }, new AbortController().signal)).rejects.toThrow(/cancel/i);
  });

  it("redacts the API key if the server echoes it in an error message", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: `Invalid token ${TEST_KEY}` } }, 401));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const error = await client.search({ query: "x" }).catch((value: unknown) => String(value));

    expect(error).toContain("HTTP 401");
    expect(error).not.toContain(TEST_KEY);
  });

  it("redacts the API key if successful page content echoes it", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({
      title: "Example",
      content: `Page body containing ${TEST_KEY}`,
    }));
    const client = createDeepSeekClient(TEST_KEY, fakeFetch);

    const result = await client.fetchPage({ url: "https://example.com" });

    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(TEST_KEY);
  });
});
