# DeepSeek Search / Fetch Pi Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个轻量 Pi package，注册 `deepseek_search` 和 `deepseek_fetch` 两个原生工具，并以不直接读取凭据的单元测试和真实 API 集成测试验证行为。

**Architecture:** `extensions/deepseek-web.ts` 负责定义 schema、获取 Pi 托管的 DeepSeek API Key 和注册工具；`extensions/deepseek-client.ts` 负责请求、错误解析和结果格式化。客户端使用 Node 原生 `fetch`，单元测试通过注入 fake fetch 隔离网络；端到端集成测试启动系统安装的 Pi，沿用用户当前 Pi 配置和 provider 凭据解析，实际调用 DeepSeek Search 与 Fetch。

**Tech Stack:** TypeScript、Pi Extension API、TypeBox、Node.js 原生 fetch、Vitest（开发依赖）、系统全局安装的 Pi（可选集成测试）。

**Spec:** `docs/superpowers/specs/2026-10-19-deepseek-search-fetch-pi-package-design.md`

## Global Constraints

- Search 端点固定为 `https://api.deepseek.com/v1/tools/search`，Fetch 端点固定为 `https://api.deepseek.com/v1/tools/fetch`。
- API Key 仅通过 `ctx.modelRegistry.getApiKeyForProvider("deepseek")` 获取；不得自行读取环境变量、`auth.json`、`models.json` 或其他凭据来源。
- 请求使用 Node 原生 `fetch`；不添加运行时 HTTP 依赖、重试、缓存、代理或可配置 base URL。
- `deepseek_search` 参数沿用规格：query 1–128 字符、count 1–50（默认 10）、ori_question 1–128 字符（可选）、localization（可选）、need_content（默认 false）。
- `deepseek_fetch` 接受 HTTP/HTTPS URL，最多 8192 字符，不接受用户名或密码；Markdown 正文最多输出 30,000 字符并明确标记截断。
- 两个工具分别注册；扩展不启动服务、计时器或其他长期资源。
- 工具错误不回显 API Key、请求头或凭据；不自动重试。
- 单元测试使用 fake key `unit-test-key-not-a-credential`，通过注入 fake fetch 隔离网络。
- 集成测试使用系统 Pi 当前配置，不覆写 `HOME` 或 `PI_CODING_AGENT_DIR`，不启用离线模式；由 Pi 自身的 ModelRegistry/provider 机制解析凭据。测试代码不得读取、打印或解析凭据文件，不显式传入 API Key，也不得调用 `pi auth`。
- 集成测试是独立的显式命令，不属于默认单元测试；它会发起真实 DeepSeek Search 和 Fetch 请求，并可能产生服务费用。为触发工具而发起的 LLM 请求应尽可能减少。
- 本机此前出现过 pnpm 默认 store 写入权限错误；安装依赖时只使用 pnpm 默认 store。若被权限策略阻止，停止并申请对默认 store 的手动审批，不改用临时 store。

## Review Focus

- Pi 未返回 DeepSeek Key 时，调用工具应给出 `/login deepseek` 提示，且不请求网络、不暴露凭据。测试：Task 3 的 missing-key cases。
- API 错误体不是 JSON 或缺少 `error.message` 时仍应返回状态码和简明错误。测试：Task 2 的错误响应矩阵。
- Search 响应字段缺失、结果为空或带可选元数据时，格式化不应崩溃或丢失有用来源信息。测试：Task 2 的 Search response cases。
- Fetch 正文长度恰好在 30,000、超过 30,000 或为空时应遵守上限并正确报告截断。测试：Task 2 的 Fetch output boundary cases。
- 工具取消和网络拒绝不得触发重试或泄漏授权头。测试：Task 2 的 abort/network cases 与 Task 3 的 credential non-disclosure case。

---

## Files and Interfaces

- `extensions/deepseek-client.ts`：DeepSeek 固定端点、请求类型、通过注入 fetch 的小型客户端、响应错误解析、Search/Fetch 文本格式化。
- `extensions/deepseek-web.ts`：Pi 工具 schema、参数校验、从 ModelRegistry 取 key、调用客户端、注册两个工具。
- `tests/deepseek-client.test.ts`：纯单元测试，mock fetch，不开网络。
- `tests/deepseek-web.test.ts`：扩展注册与 handler 单元测试，使用 fake ExtensionAPI 和 fake ModelRegistry。
- `tests/pi-live.integration.test.ts`：显式运行的真实 API 集成测试，使用系统 Pi 当前配置启动 RPC 并实际调用两个工具；不直接探测或读取凭据。
- `package.json` / `pnpm-lock.yaml`：保留无运行时依赖；添加 Vitest 与 TypeScript 开发依赖及 `test`、`test:integration`、`typecheck` 脚本。
- `tsconfig.json`：严格检查扩展和测试代码，保持不生成文件。
- `README.md`：安装、Pi 凭据配置、工具接口、测试命令及已知边界。

### Shared client interfaces

```ts
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

export function createDeepSeekClient(
  apiKey: string,
  fetchImpl?: typeof fetch,
): DeepSeekClient;
```

`createDeepSeekClient` 默认使用全局 `fetch`；生产扩展不配置 fetch 替身。测试传入 fake fetch，并断言请求体、headers、signal 与输出。Pi tool handlers 的依赖由闭包提供，API Key 每次 handler 执行时从传入 `ctx.modelRegistry` 获取；不得在模块加载时解析或缓存凭据。

## Tasks

### Task 1: Configure test and type-check commands

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

**Interfaces:**
- Produces scripts `pnpm test`, `pnpm test:unit`, `pnpm test:integration`, `pnpm typecheck`.
- `pnpm test` runs only unit test files; `pnpm test:integration` runs only the live integration file and fails with a clear message if system `pi` is unavailable.
- Set `test` and `test:unit` to `vitest run tests/setup.test.ts tests/deepseek-client.test.ts tests/deepseek-web.test.ts`; set `test:integration` to `vitest run tests/pi-live.integration.test.ts`. The default `vitest.config.ts` can discover all `tests/**/*.test.ts`; scripts explicitly keep live tests out of the unit suite.

- [ ] **Step 1: Add a test-runner configuration check**

Create `vitest.config.ts` with Node environment, `tests/**/*.test.ts` discovery, and a 5-second default timeout. Configure `tests/setup.ts` to fail if a test attempts real network access by replacing global fetch only within test setup with a throwing function; tests needing HTTP must use the injected fake fetch.

Create `tests/setup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("loads in the Node environment", () => {
    expect(typeof process.versions.node).toBe("string");
  });
});
```

- [ ] **Step 2: Run the new test and confirm the runner is available**

Run: `pnpm exec vitest run tests/setup.test.ts`
Expected before setup: command fails because `vitest` and its config are not yet present.

- [ ] **Step 3: Add the development dependencies and scripts**

Add `vitest` and `typescript` as development dependencies; add scripts `test`, `test:unit`, `test:integration`, and `typecheck`. Do not add runtime dependencies. Use the default pnpm store. If pnpm reports a store permission failure, stop and request approval for that default store path; do not retry with another store.

- [ ] **Step 4: Run the test harness and type check**

Run: `pnpm exec vitest run tests/setup.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS with no emitted files.

### Task 2: Implement the DeepSeek HTTP client and unit tests

**Files:**
- Create: `extensions/deepseek-client.ts`
- Create: `tests/deepseek-client.test.ts`

**Interfaces:**
- Consumes: `DeepSeekSearchArgs`, `DeepSeekFetchArgs`, `DeepSeekClient`, and `createDeepSeekClient` from the shared interface block above.
- Produces: a client with fixed endpoints; methods return already formatted plain text; fetch injection exists only as a defaultable function argument for deterministic tests.

- [ ] **Step 1: Write failing request-shape tests**

Add tests that call each method with `fakeFetch` and assert URL, `POST`, `Authorization: Bearer unit-test-key-not-a-credential`, JSON content type, body defaults, and exact optional fields. Example:

```ts
it("sends Search defaults to the fixed DeepSeek endpoint", async () => {
  const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
  const client = createDeepSeekClient("unit-test-key-not-a-credential", fakeFetch);

  await client.search({ query: "pi extensions" });

  expect(fakeFetch).toHaveBeenCalledWith(
    "https://api.deepseek.com/v1/tools/search",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer unit-test-key-not-a-credential",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ query: "pi extensions", count: 10, need_content: false }),
    }),
  );
});
```

Add the parallel Fetch request test and assert the provided AbortSignal is passed through unchanged.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec vitest run tests/deepseek-client.test.ts`
Expected: FAIL because the client module and response fixture do not exist.

- [ ] **Step 3: Implement request and response handling**

Implement `createDeepSeekClient`, `search`, and `fetchPage`. Normalize defaults in the client. Format Search results with title, URL, long snippet and any present short snippet, site name, date, relevance, authority, and requested content. Return an explicit no-results message for an empty/missing results array. Format Fetch title and Markdown body; truncate at 30,000 JavaScript string characters and append a clear truncation marker. Parse JSON success responses; for HTTP errors parse `error.message` when available and always include status. For non-JSON errors, include status and a generic message. Catch network errors and surface a concise message without serializing request options or headers. Do not retry.

- [ ] **Step 4: Add and pass the complete HTTP client unit matrix**

Cover these cases with table-driven tests:

```ts
it.each([
  {
    name: "Search empty results",
    method: "search" as const,
    args: { query: "x" },
    payload: { results: [] },
    expected: /no results/i,
  },
  {
    name: "Search optional fields",
    method: "search" as const,
    args: { query: "x" },
    payload: {
      results: [{ title: "A", url: "https://a.test", snippet: "short", summary: "long", site_name: "A", date: "2026-01-01", rerank_score: 2.4, authority: 3 }],
    },
    expected: /long/,
  },
  {
    name: "Fetch empty body",
    method: "fetchPage" as const,
    args: { url: "https://a.test" },
    payload: { title: "A", content: "" },
    expected: /A/,
  },
])("formats $name", async ({ method, args, payload, expected }) => {
  const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(payload));
  const client = createDeepSeekClient("unit-test-key-not-a-credential", fakeFetch);
  const result = method === "search"
    ? await client.search(args as DeepSeekSearchArgs)
    : await client.fetchPage(args as DeepSeekFetchArgs);

  expect(result).toMatch(expected);
});
```

Also cover: all Search request options map to JSON; result with missing optional fields; Search `need_content: true` includes returned `content`; format the documented `summary` (long), `snippet` (short), `rerank_score`, `site_name`, `date`, and numeric `authority` fields; Fetch accepts response `title`/`content`; body length 30,000 is unchanged; body length 30,001 yields exactly 30,000 body characters plus the marker; HTTP JSON with `error.message`; HTTP JSON without it; HTTP non-JSON body; fetch rejection; AbortError; no retry (`fakeFetch` called once); and output/error strings never contain the test key. Use valid minimal JSON response fixtures and assert output structure without depending on unrelated whitespace.

Run: `pnpm exec vitest run tests/deepseek-client.test.ts`
Expected: PASS.

### Task 3: Register native Pi tools and test credential behavior

**Files:**
- Modify: `extensions/deepseek-web.ts`
- Create: `tests/deepseek-web.test.ts`

**Interfaces:**
- Consumes: `createDeepSeekClient` from Task 2 and Pi `ExtensionAPI` / tool types from the declared peer dependency.
- Produces: default extension function `deepseekWebExtension(pi: ExtensionAPI): void`; exactly two registered tools named `deepseek_search` and `deepseek_fetch`.

- [x] **Step 1: Add failing fake-ExtensionAPI tests**

Build a test-local fake `ExtensionAPI` whose `registerTool` captures definitions, and a fake `ctx.modelRegistry.getApiKeyForProvider`. Test names, descriptions, schema-required fields, and handler call shape. For example:

```ts
it("registers the two native tools", () => {
  const tools = captureRegisteredTools(deepseekWebExtension);
  expect(tools.map((tool) => tool.name)).toEqual(["deepseek_search", "deepseek_fetch"]);
});
```

Add handler tests verifying it requests provider ID `deepseek` on invocation and uses the returned fake key only for an injected client request. Missing-key tests must assert a `/login deepseek` hint, zero fetch calls, and no credential-like value in output.

- [x] **Step 2: Run focused tests to verify they fail**

Run: `pnpm exec vitest run tests/deepseek-web.test.ts`
Expected: FAIL because native tools are not registered yet.

- [x] **Step 3: Implement the extension and schemas**

Define TypeBox schemas for Search and Fetch. Enforce Search query non-empty after trimming and maximum 128 characters; enforce count integer 1–50; enforce optional `ori_question` length 1–128; accept optional `localization` string and `need_content` boolean. Enforce Fetch URL length at most 8192, valid URL parsing, protocol HTTP or HTTPS, a non-empty host, and no username/password. Register two tools with user-facing descriptions that label fetched webpage text as untrusted source material. In each handler, obtain the current key from `ctx.modelRegistry.getApiKeyForProvider("deepseek")`; when absent return a clear configuration error without calling fetch. Pass `signal` through to the client. Do not print/log credentials.

- [x] **Step 4: Complete registration and validation unit tests**

Test valid Search defaults and optional fields; whitespace-only query; 1 and 128 character queries; 129 character query; count 1, 50, 0, 51, and fractional count; invalid `ori_question` length; URL with HTTP and HTTPS; missing host, unsupported protocol, username/password, and 8193-character URL; missing API Key; API Key lookup once per tool call (not at module import); handler cancellation propagation; error output with no fake key; and that exactly two tools are registered. Each invalid input must reject before any fake network call.

Run: `pnpm exec vitest run tests/deepseek-web.test.ts`
Expected: PASS.

### Task 4: Add a live system Pi and DeepSeek integration test

**Files:**
- Create: `tests/pi-live.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the built-in package extension path and the test script from Task 1.
- Produces: an opt-in `test:integration` test that uses system `pi` and the current Pi profile to make real Search and Fetch calls through the registered tools.

- [x] **Step 1: Write the failing live subprocess integration test**

The test locates `pi` on `PATH` and starts `pi --mode rpc --no-session --no-mcp --no-skills --no-extensions --tools deepseek_search,deepseek_fetch --extension <absolute extension path>` with the normal process environment and existing Pi model/provider configuration. `--no-extensions` prevents unrelated installed extensions from prompting the RPC client; the explicit package extension is still loaded. Do not set `HOME`, `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, or `--api-key`. Send one `prompt` RPC command instructing Pi to call `deepseek_search` exactly once with a fixed query, then `deepseek_fetch` exactly once with `https://example.com`, and use no other tools. Parse JSONL events until the child exits; assert each requested tool has a `tool_execution_start` and a matching `tool_execution_end` with `isError: false`, and each result has non-empty text content. Enforce a bounded 120-second timeout, terminate the child on failure, and include sanitized stderr in failures. Pi is the only credential resolver; the test never reads or prints auth/model configuration files.

Example command setup:

```ts
const child = spawn("pi", [
  "--mode", "rpc", "--no-session", "--no-mcp", "--no-skills",
  "--tools", "deepseek_search,deepseek_fetch", "--extension", extensionPath,
], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.write(`${JSON.stringify({
  id: "live-search-fetch",
  type: "prompt",
  message: "Call deepseek_search exactly once with query 'pi package integration test 2026-10-19'. Then call deepseek_fetch exactly once with url 'https://example.com'. Do not use other tools. After both calls, briefly report whether each returned data.",
})}\n`);
child.stdin.end();
```

- [ ] **Step 2: Run the live integration test against system Pi and DeepSeek**

Run: `pnpm test:integration`
Expected: PASS when system Pi has a usable selected model and Pi can resolve the DeepSeek provider credential. This run makes one real Search request and one real Fetch request, does not read credentials directly in test code, and may incur DeepSeek API charges. Missing Pi/model/provider configuration must fail with an actionable model or `/login deepseek` message; do not silently skip a failed live API call.

- [x] **Step 3: Review and tighten child process cleanup**

Ensure the test terminates the Pi child on assertion failure. Do not print child environment values, Pi configuration, provider credentials, request headers, or full process arguments beyond the non-secret extension path. A Pi startup or API failure may include sanitized stderr/error text, but must redact bearer-token-shaped strings and never read credential files to do so.

### Task 5: Document package use and verify the complete suite

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tests/setup.ts`

**Interfaces:**
- README installation and use instructions match the package manifest and tool schemas.
- `pnpm test` runs unit tests only; `pnpm test:integration` makes real DeepSeek calls through the current system Pi configuration; `pnpm typecheck` covers extension and tests.

- [x] **Step 1: Document installation, credentials, and tool behavior**

Document installing the package in Pi, configuring DeepSeek through Pi's existing `/login deepseek` or supported provider credential sources, the two tools and their arguments, the 30,000-character Fetch cap, no retry behavior, and the fact that search terms/URLs are sent to DeepSeek. Include the local commands `pnpm test`, `pnpm test:integration`, and `pnpm typecheck`; state that integration test uses the current Pi profile, makes real DeepSeek calls, may be billable, and does not read credentials directly.

- [x] **Step 2: Run all unit tests and static checking**

Run: `pnpm test`
Expected: PASS for the full unit suite; no test uses external network.

Run: `pnpm typecheck`
Expected: PASS with strict TypeScript checks.

- [ ] **Step 3: Run Pi integration and packaging checks**

Run: `pnpm test:integration`
Observed: `pnpm pack --dry-run` passes and includes both extension files plus README. The live command was attempted using system Pi/current configuration, but Pi generated no tool-execution events; it failed with an actionable tool-call support/authentication message before making either DeepSeek API request. Re-run this step after the current Pi profile produces calls to the registered tools.

Run: `pnpm pack --dry-run`
Expected: package includes `extensions/deepseek-web.ts`, `extensions/deepseek-client.ts`, and README; it does not include tests, local credentials, or `node_modules`.

- [ ] **Step 4: Review repository changes and commit**

Run: `git diff --check` and inspect `git status --short`.
Expected: clean whitespace, only intended project files changed, no `.superpowers/`, `node_modules`, generated output, temp files, or credential files staged.

Commit implementation with `feat: add DeepSeek Search and Fetch Pi tools` and documentation-only changes, if any, with a separate `docs:` commit.

## Self-review

- **Spec coverage:** Both tool names, endpoints, parameters, defaults, formatting, content cap, Pi-managed credentials, fixed endpoint, cancellation, error mapping, no retry, no runtime dependency, README, and risks are assigned to tasks. Unit tests cover handler/HTTP behavior; Task 4 exercises both registered tools against real DeepSeek APIs through system Pi.
- **Credential boundary:** No test reads credential files or invokes `pi auth`; the live integration process uses Pi's existing configuration and normal provider resolution without explicitly passing API keys. Unit tests use only a clearly fake in-memory key and injected fetch.
- **External API calls:** Unit tests use fake fetch and never access the network. The opt-in integration command submits one prompt through the configured model and intentionally makes real Search and Fetch API calls; it is separate from `pnpm test` and may be billable.
- **Dependency policy:** Vitest and TypeScript are development-only. Dependency installation is blocked on the existing default-store permission behavior and must follow the global AGENTS approval rule; no `/tmp` store fallback is allowed.
- **Review Focus:** Each listed failure mode has an owning task and explicit cases. The live integration is designed to check actual tool selection/execution and DeepSeek API responses through Pi; this environment's run did not reach either tool, so live API behavior remains unverified. Deterministic schema and error boundaries are covered by unit tests.
- **No placeholders:** The plan gives paths, interfaces, commands, expected outcomes, and behavior cases. The illustrative table-driven test uses the defined `search` and `fetchPage` methods directly; implementation supplies the shared `jsonResponse` fixture in the test file.
