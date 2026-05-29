import type { EnvironmentName, NormalizedLog, RawSlsRecord } from "./types";

const KNOWN_GROUPS = [
  "[MotionVideoSkeletonStuck]",
  "[videoPlayerError]",
  "[motionVideoDl]",
  "[LinkVideoDraftTrace]",
  "[FetchNetworkError]",
];

export const DEFAULT_QUERY = KNOWN_GROUPS.map((group) => `group:"${group}"`).join(
  " or ",
);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const tryParseJson = (text: string) => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      value: text,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const getField = (record: RawSlsRecord, keys: string[]) => {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  return undefined;
};

const normalizeVolatileText = (value: string) =>
  value
    .replace(/\d{13}/g, "<ts-ms>")
    .replace(/\d{10}/g, "<ts-s>")
    .replace(/[a-z0-9]{8,}/gi, (token) =>
      /\d/.test(token) && /[a-z]/i.test(token) ? "<id>" : token,
    )
    .slice(0, 300);

const compactStable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.slice(0, 20).map(compactStable);
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? normalizeVolatileText(value) : value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      [
        "time",
        "reportedAtMs",
        "elapsedMs",
        "stageElapsedMs",
        "startedAt",
        "stageStartedAt",
        "sessionId",
        "traceId",
      ].includes(key)
    ) {
      continue;
    }
    result[key] = compactStable(item);
  }
  return result;
};

export const normalizeLogs = (
  env: EnvironmentName,
  logs: RawSlsRecord[],
): NormalizedLog[] =>
  logs.map((source) => {
    const rawMessage = getField(source, ["message", "Message", "msg", "content"]);
    const parsed =
      typeof rawMessage === "string"
        ? tryParseJson(rawMessage)
        : { value: rawMessage ?? source };
    const payload = Array.isArray(parsed.value) && parsed.value.length === 1
      ? parsed.value[0]
      : parsed.value;
    const payloadRecord = asRecord(payload);
    const group =
      asString(getField(source, ["group", "Group"])) ??
      asString(payloadRecord?.group) ??
      "unknown";
    const event = asString(payloadRecord?.event);
    const scope = asString(payloadRecord?.scope);
    const projectId =
      asString(payloadRecord?.projectId) ??
      asString(payloadRecord?.activeProjectId) ??
      asString(asRecord(payloadRecord?.video)?.id);
    const userId =
      asString(asRecord(payloadRecord?.user)?.id) ??
      asString(asRecord(asRecord(payloadRecord?.snapshot)?.user)?.id);
    const traceId = asString(payloadRecord?.traceId);
    const sessionId = asString(payloadRecord?.sessionId);
    const category = asString(payloadRecord?.category);
    const reason = asString(payloadRecord?.reason);
    const stage = asString(payloadRecord?.stage) ?? asString(payloadRecord?.currentStage);
    const error = asRecord(payloadRecord?.error);
    const errorName = asString(error?.name);
    const errorMessage = asString(error?.message);
    const missing = asRecord(payloadRecord?.previewGate)?.missingEssential;

    const signature = {
      env,
      group,
      event,
      scope,
      category,
      reason,
      stage,
      errorName,
      errorMessage,
      missing,
      stable: compactStable(payload),
    };

    return {
      env,
      source,
      receiveTime: Number(source.__time__ ?? source.__receive_time__) || undefined,
      time: asString(getField(source, ["time", "Time"])) ?? asString(source.__time__),
      group,
      type: asString(getField(source, ["type", "Type"])),
      payload,
      payloadParseError: parsed.error,
      event,
      scope,
      projectId,
      userId,
      traceId,
      sessionId,
      fingerprint: JSON.stringify(signature),
    };
  });
