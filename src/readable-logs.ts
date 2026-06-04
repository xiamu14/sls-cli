import type { EnvironmentName, RawSlsRecord } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseJson = (value: unknown) => {
  if (typeof value !== "string") return { value };
  try {
    return { value: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      value,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const pickHeaders = (headers: unknown) => {
  if (!isRecord(headers)) return undefined;
  const keys = [
    "x-app-version",
    "x-app-version-code",
    "x-app-package",
    "x-context-id",
    "x-device-platform",
    "user-agent",
    "content-length",
  ];
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (headers[key] != null) result[key] = headers[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const getOuterLog = (record: RawSlsRecord) => {
  const parsed = parseJson(record.content);
  return isRecord(parsed.value) ? parsed.value : undefined;
};

const getDataItems = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  return Object.entries(value)
    .sort(([keyA], [keyB]) => Number(keyA) - Number(keyB))
    .map(([, item]) => item);
};

const getBodyItems = (outer: Record<string, unknown>) => {
  const reqData = isRecord(outer.reqData) ? outer.reqData : undefined;
  const body = isRecord(reqData?.body) ? reqData.body : undefined;
  const reqItems = getDataItems(body?.data);
  if (reqItems.length > 0) return reqItems;

  const dto = isRecord(outer.dto) ? outer.dto : undefined;
  return getDataItems(dto?.data);
};

type Entry = {
  env: EnvironmentName;
  record: RawSlsRecord;
  outer: Record<string, unknown>;
  item: Record<string, unknown>;
  message: Record<string, unknown>;
  messageParseError?: string;
};

const collectEntries = (
  rawByEnv: Record<string, RawSlsRecord[]>,
) => {
  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (const [env, records] of Object.entries(rawByEnv)) {
    const orderedRecords = records.slice().sort((a, b) => {
      const outerA = getOuterLog(a);
      const outerB = getOuterLog(b);
      return Number(isRecord(outerB?.reqData)) - Number(isRecord(outerA?.reqData));
    });

    for (const record of orderedRecords) {
      const outer = getOuterLog(record);
      if (!outer) continue;

      for (const item of getBodyItems(outer)) {
        if (!isRecord(item)) continue;
        const parsed = parseJson(item.message);
        if (!isRecord(parsed.value)) continue;

        const dedupeKey = JSON.stringify([
          env,
          asString(item.group),
          asString(item.type),
          asString(item.time),
          asString(item.message),
        ]);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        entries.push({
          env,
          record,
          outer,
          item,
          message: parsed.value,
          messageParseError: parsed.error,
        });
      }
    }
  }

  return entries;
};

const buildRequest = (outer: Record<string, unknown>) => {
  const reqData = isRecord(outer.reqData) ? outer.reqData : undefined;
  return {
    url: asString(reqData?.url) ?? asString(isRecord(outer.req) ? outer.req.url : undefined),
    ip: asString(reqData?.ip) ?? asString(isRecord(outer.req) ? outer.req.ip : undefined),
    userId: asString(reqData?.userId),
    appId: asString(reqData?.appId),
    headers: pickHeaders(reqData?.headers),
    statusCode: outer.statusCode,
    costTime: outer.costTime,
  };
};

const reassemblePayload = (entries: Entry[]) => {
  const first = entries[0];
  const firstMessage = first?.message ?? {};
  const part = isRecord(firstMessage.part) ? firstMessage.part : undefined;
  const encoding = asString(part?.encoding);

  if (encoding === "json-string-chunk") {
    const sorted = entries
      .slice()
      .sort((a, b) => {
        const partA = isRecord(a.message.part) ? a.message.part : undefined;
        const partB = isRecord(b.message.part) ? b.message.part : undefined;
        return Number(partA?.index ?? 0) - Number(partB?.index ?? 0);
      });
    const joined = sorted.map((entry) => asString(entry.message.payloadChunk) ?? "").join("");
    const parsed = parseJson(joined);
    return {
      payload: parsed.value,
      payloadParseError: parsed.error,
    };
  }

  return {
    payload: firstMessage.payload,
    payloadParseError: undefined,
  };
};

export const buildReadableLogs = (rawByEnv: Record<string, RawSlsRecord[]>) => {
  const entries = collectEntries(rawByEnv);
  const groups = new Map<string, Entry[]>();

  for (const entry of entries) {
    const traceId = asString(entry.message.traceId) ?? "unknown-trace";
    const event = asString(entry.message.event) ?? "unknown-event";
    const key = `${entry.env}:${traceId}:${event}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  return Array.from(groups.values()).map((items) => {
    const first = items[0];
    const message = first?.message ?? {};
    const part = isRecord(message.part) ? message.part : undefined;
    const expectedParts = Number(part?.total) || items.length;
    const { payload, payloadParseError } = reassemblePayload(items);

    return {
      env: first?.env,
      traceId: asString(message.traceId),
      scope: asString(message.scope),
      event: asString(message.event),
      group: asString(first?.item.group),
      type: asString(first?.item.type),
      time: asString(first?.item.time),
      receiveTime: first?.record._time_ ?? first?.record.__time__,
      request: first ? buildRequest(first.outer) : undefined,
      part: {
        encoding: asString(part?.encoding) ?? "json",
        received: items.length,
        total: expectedParts,
        complete: items.length === expectedParts,
      },
      payload,
      messageParseErrors: items
        .map((item) => item.messageParseError)
        .filter((item): item is string => Boolean(item)),
      payloadParseError,
    };
  });
};
