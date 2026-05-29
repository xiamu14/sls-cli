import type { ConsolePullMeta, RawSlsRecord, SlsConsoleEnvConfig } from "./types";

type ConsoleEndpoint = "indexLogs" | "histograms" | "packedLogs";

const endpointPath: Record<ConsoleEndpoint, string> = {
  indexLogs: "/console/logstoreindex/getLogs.json",
  histograms: "/console/logstoreindex/getHistograms.json",
  packedLogs: "/console/logs/getLogs.json",
};

const randomHex = (length: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2))))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);

const appendPackMeta = (query: string) => {
  if (/\|\s*with_pack_meta\b/i.test(query)) return query;
  return `${query} | with_pack_meta`;
};

const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

const postForm = async ({
  config,
  endpoint,
  body,
}: {
  config: SlsConsoleEnvConfig;
  endpoint: ConsoleEndpoint;
  body: Record<string, string | number | boolean>;
}) => {
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  const url = `${config.consoleBaseUrl.replace(/\/$/, "")}${endpointPath[endpoint]}`;
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    form.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      b3: `${traceId}-${spanId}-1`,
      "bx-v": "2.5.36",
      "content-type": "application/x-www-form-urlencoded",
      cookie: config.cookie,
      origin: config.consoleBaseUrl.replace(/\/$/, ""),
      referer:
        config.referer ??
        `${config.consoleBaseUrl.replace(/\/$/, "")}/lognext/project/${config.projectName}/logsearch/${config.logstoreName}`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      traceparent: `00-${traceId}-${spanId}-01`,
      "uber-trace-id": `${traceId}:${spanId}:0:1`,
      "user-agent": config.userAgent,
      "x-csrf-token": config.csrfToken,
    },
    body: form,
  });

  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!response.ok) {
    throw new Error(
      `[sls-console] ${endpoint} failed ${response.status}: ${text.slice(0, 800)}`,
    );
  }

  return json;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const looksLikeLog = (value: unknown) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.includes("__time__") ||
    keys.includes("message") ||
    keys.includes("Message") ||
    keys.includes("group") ||
    keys.includes("LogItem") ||
    keys.includes("Contents")
  );
};

const collectLogArrays = (value: unknown, result: RawSlsRecord[][]) => {
  if (Array.isArray(value)) {
    if (value.some(looksLikeLog)) {
      result.push(value.filter(isRecord) as RawSlsRecord[]);
      return;
    }
    value.forEach((item) => collectLogArrays(item, result));
    return;
  }

  if (!isRecord(value)) return;
  for (const item of Object.values(value)) {
    collectLogArrays(item, result);
  }
};

export const extractConsoleLogs = (response: unknown): RawSlsRecord[] => {
  const arrays: RawSlsRecord[][] = [];
  collectLogArrays(response, arrays);
  return arrays.sort((a, b) => b.length - a.length)[0] ?? [];
};

export const pullSlsConsoleLogs = async ({
  config,
  from,
  to,
  query,
  line,
  reverse,
  maxPages,
  withPackMeta,
}: {
  config: SlsConsoleEnvConfig;
  from: Date;
  to: Date;
  query: string;
  line: number;
  reverse: boolean;
  maxPages: number;
  withPackMeta: boolean;
}): Promise<{ logs: RawSlsRecord[]; meta: ConsolePullMeta }> => {
  const common = {
    ProjectName: config.projectName,
    LogStoreName: config.logstoreName,
    from: toSeconds(from),
    to: toSeconds(to),
  };

  const histogramsResponse = await postForm({
    config,
    endpoint: "histograms",
    body: {
      ...common,
      query,
      reverse,
    },
  });

  const logs: RawSlsRecord[] = [];
  let indexLogsResponse: unknown;
  let packedLogsResponse: unknown;

  for (let page = 1; page <= maxPages; page += 1) {
    indexLogsResponse = await postForm({
      config,
      endpoint: "indexLogs",
      body: {
        ...common,
        query,
        Page: page,
        Size: line,
      },
    });

    packedLogsResponse = await postForm({
      config,
      endpoint: "packedLogs",
      body: {
        ...common,
        query: withPackMeta ? appendPackMeta(query) : query,
        Page: page,
        Size: line,
        Reverse: reverse,
        pSql: false,
        fullComplete: false,
        schemaFree: false,
        needHighlight: true,
      },
    });

    const pageLogs = extractConsoleLogs(packedLogsResponse);
    const fallbackLogs = extractConsoleLogs(indexLogsResponse);
    const selected = pageLogs.length > 0 ? pageLogs : fallbackLogs;
    logs.push(...selected.map((item) => ({ ...item, __console_page__: page })));
    if (selected.length < line) break;
  }

  return {
    logs,
    meta: {
      env: config.env,
      histogramsResponse,
      indexLogsResponse,
      packedLogsResponse,
    },
  };
};

export const probeSlsConsoleAuth = async (config: SlsConsoleEnvConfig) => {
  const to = new Date();
  const from = new Date(to.getTime() - 60_000);
  const response = await postForm({
    config,
    endpoint: "histograms",
    body: {
      ProjectName: config.projectName,
      LogStoreName: config.logstoreName,
      from: toSeconds(from),
      to: toSeconds(to),
      query: "*",
      reverse: false,
    },
  });
  return response;
};
