const SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";
const MAX_FETCH_CONTENT_LENGTH = 30_000;

export type DeepSeekSearchArgs = {
  query: string;
  count?: number;
  ori_question?: string;
  localization?: string;
  need_content?: boolean;
};

export type DeepSeekFetchArgs = { url: string };

export type DeepSeekClient = {
  search(args: DeepSeekSearchArgs, signal?: AbortSignal): Promise<string>;
  fetchPage(args: DeepSeekFetchArgs, signal?: AbortSignal): Promise<string>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redactSecret(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[REDACTED]") : text;
}

function formatSearchResult(result: JsonObject, index: number, includeContent: boolean): string {
  const title = optionalString(result.title) ?? "Untitled result";
  const lines = [`${index + 1}. ${title}`];
  const url = optionalString(result.url);
  const siteName = optionalString(result.site_name);
  const date = optionalString(result.date);
  const snippet = optionalString(result.snippet);
  const summary = optionalString(result.summary);
  const content = includeContent ? optionalString(result.content) : undefined;

  if (url) lines.push(`URL: ${url}`);
  if (siteName) lines.push(`Site: ${siteName}`);
  if (date) lines.push(`Date: ${date}`);
  if (typeof result.rerank_score === "number") lines.push(`Relevance: ${result.rerank_score}`);
  if (typeof result.authority === "number") lines.push(`Authority: ${result.authority}`);
  if (snippet) lines.push(`Snippet: ${snippet}`);
  if (summary) lines.push(`Summary: ${summary}`);
  if (content) lines.push(`Content: ${content}`);

  return lines.join("\n");
}

function formatSearch(payload: unknown, query: string, includeContent: boolean, apiKey: string): string {
  const resultsValue = isObject(payload) ? payload.results : undefined;
  const results = Array.isArray(resultsValue) ? resultsValue.filter(isObject) : [];
  if (results.length === 0) {
    return redactSecret(`No search results found for "${query}".`, apiKey);
  }

  const formatted = [
    `Search results for "${query}" (${results.length}):`,
    ...results.map((result, index) => formatSearchResult(result, index, includeContent)),
  ].join("\n\n");
  return redactSecret(formatted, apiKey);
}

function formatFetch(payload: unknown, apiKey: string): string {
  if (!isObject(payload)) {
    throw new Error("DeepSeek API returned an invalid Fetch response (HTTP 200).");
  }

  const title = optionalString(payload.title);
  const content = typeof payload.content === "string" ? payload.content : "";
  const truncated = content.length > MAX_FETCH_CONTENT_LENGTH;
  const body = truncated ? content.slice(0, MAX_FETCH_CONTENT_LENGTH) : content;
  const parts: string[] = [];

  if (title) parts.push(`# ${title}`);
  if (body) parts.push(body);
  if (!body) parts.push("No Markdown content was returned.");
  if (truncated) parts.push("[Fetch content truncated at 30,000 characters.]");

  return redactSecret(parts.join("\n\n"), apiKey);
}

function getApiErrorMessage(payload: unknown, apiKey: string): string {
  if (isObject(payload) && isObject(payload.error)) {
    const message = optionalString(payload.error.message);
    if (message) return redactSecret(message, apiKey);
  }
  return "DeepSeek returned an error response.";
}

function isAbortError(error: unknown): boolean {
  return isObject(error) && error.name === "AbortError";
}

export function createDeepSeekClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): DeepSeekClient {
  async function request(endpoint: string, body: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new Error("DeepSeek request was cancelled.");
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new Error("DeepSeek request was cancelled.");
      }
      throw new Error("DeepSeek request failed due to a network error.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(`DeepSeek API request failed (HTTP ${response.status}): DeepSeek returned a non-JSON error response.`);
      }
      throw new Error(`DeepSeek API returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = getApiErrorMessage(payload, apiKey);
      throw new Error(`DeepSeek API request failed (HTTP ${response.status}): ${message}`);
    }
    return payload;
  }

  return {
    async search(args, signal) {
      const payload = await request(SEARCH_ENDPOINT, {
        query: args.query,
        count: args.count ?? 10,
        ...(args.ori_question !== undefined ? { ori_question: args.ori_question } : {}),
        ...(args.localization !== undefined ? { localization: args.localization } : {}),
        need_content: args.need_content ?? false,
      }, signal);
      return formatSearch(payload, args.query, args.need_content ?? false, apiKey);
    },

    async fetchPage(args, signal) {
      const payload = await request(FETCH_ENDPOINT, { url: args.url }, signal);
      return formatFetch(payload, apiKey);
    },
  };
}
