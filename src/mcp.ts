import { Hono } from "hono";
import type { Context } from "hono";

import { analyzeLogs, getCookieStatus, queryLogs } from "./services";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolCallParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

const protocolVersion = "2024-11-05";

const jsonText = (value: unknown) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(value, null, 2),
    },
  ],
});

const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStringOrArray = (value: unknown) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
};

const tools = [
  {
    name: "query",
    description:
      "Query Alibaba Cloud SLS diagnostic logs through cached console cookies, normalize logs, and write analysis artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        env: {
          description: "Environment name or comma-separated/list value, such as production or alpha,production.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        from: {
          type: "string",
          description: 'Window start, such as "2h ago" or "2026-05-28 00:00:00+08:00". Defaults to 2h before to.',
        },
        to: {
          type: "string",
          description: 'Window end, such as "now". Defaults to now.',
        },
        query: {
          type: "string",
          description: "SLS query. Defaults to the built-in Hugo AIV diagnostics query.",
        },
        line: {
          type: "number",
          description: "Rows per page. Defaults to 100.",
        },
        maxPages: {
          type: "number",
          description: "Maximum pages to fetch. Defaults to 20.",
        },
        reverse: {
          type: "boolean",
          description: "Whether to reverse SLS result order.",
        },
        withPackMeta: {
          type: "boolean",
          description: "Append with_pack_meta to the primary console query. Defaults to true.",
        },
        cache: {
          type: "boolean",
          description: "Use local query response cache. Defaults to true.",
        },
        out: {
          type: "string",
          description: "Artifact output directory. Defaults to artifacts/<timestamp>.",
        },
        analyze: {
          type: "boolean",
          description: "Generate summary.md and conclusion.md after querying. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "analyze",
    description:
      "Generate summary.md and conclusion.md from an artifact directory's analysis-input.json and logs.json.",
    inputSchema: {
      type: "object",
      properties: {
        inputPath: {
          type: "string",
          description: "Path to analysis-input.json.",
        },
        summaryPath: {
          type: "string",
          description: "Optional destination for summary.md.",
        },
        conclusionPath: {
          type: "string",
          description: "Optional destination for conclusion.md.",
        },
      },
      required: ["inputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "cookie_status",
    description:
      "Inspect cached SLS console cookie status and optionally probe whether it is usable.",
    inputSchema: {
      type: "object",
      properties: {
        env: {
          description: "Environment name or comma-separated/list value. Defaults to SLS_ENVIRONMENTS.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        probe: {
          type: "boolean",
          description: "Probe the SLS console API. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
];

const callTool = async ({ name, arguments: input = {} }: ToolCallParams) => {
  switch (name) {
    case "query":
      return jsonText(await queryLogs({
        env: asStringOrArray(input.env),
        from: asString(input.from),
        to: asString(input.to),
        query: asString(input.query),
        line: asNumber(input.line),
        maxPages: asNumber(input.maxPages),
        reverse: asBoolean(input.reverse),
        withPackMeta: asBoolean(input.withPackMeta),
        cache: asBoolean(input.cache),
        out: asString(input.out),
        analyze: asBoolean(input.analyze),
        cleanupAnalysisInput: false,
      }));
    case "analyze": {
      const inputPath = asString(input.inputPath);
      if (!inputPath) throw new Error("Missing required argument: inputPath");
      return jsonText(await analyzeLogs({
        inputPath,
        summaryPath: asString(input.summaryPath),
        conclusionPath: asString(input.conclusionPath),
      }));
    }
    case "cookie_status":
      return jsonText(await getCookieStatus({
        env: asStringOrArray(input.env),
        probe: asBoolean(input.probe),
      }));
    default:
      throw new Error(`Unknown tool: ${name ?? "-"}`);
  }
};

const result = (id: JsonRpcRequest["id"], value: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: value,
});

const errorResult = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    data,
  },
});

const handleRpc = async (request: JsonRpcRequest) => {
  try {
    switch (request.method) {
      case "initialize":
        return result(request.id, {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "hugo-aiv-logs",
            version: "0.1.0",
          },
        });
      case "notifications/initialized":
        return { notification: true };
      case "ping":
        return result(request.id, {});
      case "tools/list":
        return result(request.id, { tools });
      case "tools/call":
        return result(request.id, await callTool(request.params as ToolCallParams));
      default:
        return errorResult(request.id, -32601, `Method not found: ${request.method ?? "-"}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(request.id, -32000, message);
  }
};

const app = new Hono();

app.get("/", (c) =>
  c.json({
    ok: true,
    name: "hugo-aiv-logs",
    mcp: "/mcp",
    tools: tools.map((tool) => tool.name),
  }),
);

app.get("/healthz", (c) => c.json({ ok: true }));

const handleMcpPost = async (c: Context) => {
  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = await c.req.json();
  } catch {
    return c.json(errorResult(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map(handleRpc))).filter(Boolean);
    return c.json(responses);
  }

  const response = await handleRpc(payload);
  if (response && "notification" in response) {
    return c.json({ ok: true }, 202);
  }
  return c.json(response);
};

app.post("/mcp", handleMcpPost);
app.post("/mcp/", handleMcpPost);

const port = process.env.PORT ? Number(process.env.PORT) : 0;
const hostname = process.env.HOST ?? "127.0.0.1";

const server = Bun.serve({
  fetch: app.fetch,
  port,
  hostname,
});

const publicUrl =
  process.env.PORT && process.env.PORTLESS_URL
    ? process.env.PORTLESS_URL
    : `http://${hostname}:${server.port}`;
console.log(`[mcp] hugo-aiv-logs listening at ${publicUrl}/mcp`);
