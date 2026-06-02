import type { AnalysisInput, LogCluster } from "./types";

type ReadableLog = Record<string, any>;

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const countBy = <T>(items: T[], getKey: (item: T) => string | undefined) => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item) ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const formatCounts = (counts: Array<[string, number]>, empty = "-") =>
  counts.length > 0
    ? counts.map(([key, count]) => `- ${key}: ${count}`).join("\n")
    : empty;

const uniq = (values: Array<string | undefined>) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

const guessCodeContext = (cluster: LogCluster) => {
  switch (cluster.group) {
    case "[MotionVideoSkeletonStuck]":
      return "hugo-aiv-app/src/modules/diagnostics/motionVideoSkeletonDiagnostics.ts";
    case "[videoPlayerError]":
      return "hugo-aiv-app/src/modules/diagnostics/videoPlayerErrorDiagnostics.ts";
    case "[motionVideoDl]":
      return "hugo-aiv-app/src/modules/diagnostics/motionVideoDownloadSessionDiagnostics.ts";
    case "[LinkVideoDraftTrace]":
      return "hugo-aiv-app/src/modules/diagnostics/linkVideoDraftCreateDiagnostics.ts";
    case "[FetchNetworkError]":
      return "hugo-aiv-app/src/api/utils.ts";
    default:
      return "unknown";
  }
};

const toComparableTime = (log: ReadableLog) => {
  const value = asString(log.receiveTime) ?? asString(log.time);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

const buildReadableClusters = (logs: ReadableLog[]) => {
  const groups = new Map<string, ReadableLog[]>();
  for (const log of logs) {
    const key = [
      asString(log.group) ?? "unknown",
      asString(log.event) ?? "unknown-event",
      asString(log.scope) ?? "unknown-scope",
    ].join("|");
    const current = groups.get(key) ?? [];
    current.push(log);
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((items) => {
      const first = items[0] ?? {};
      const times = items
        .map(toComparableTime)
        .filter((value): value is string => Boolean(value))
        .sort();
      return {
        group: asString(first.group) ?? "unknown",
        event: asString(first.event),
        scope: asString(first.scope),
        count: items.length,
        firstSeen: times[0],
        lastSeen: times.at(-1),
        envs: uniq(items.map((item) => asString(item.env))),
        projectIds: uniq(items.map(getProjectId)),
        userIds: uniq(items.map(getUserId)),
      };
    })
    .sort((a, b) => b.count - a.count);
};

const buildLocalSummary = (input: AnalysisInput, logs: ReadableLog[]) => {
  const top = buildReadableClusters(logs).slice(0, 20);
  const lines = [
    "# Diagnostics Summary",
    "",
    `Generated at: ${input.generatedAt}`,
    `Window: ${input.window.from} -> ${input.window.to}`,
    `Envs: ${(input.envs ?? []).join(", ") || "-"}`,
    `Query: ${input.query}`,
    "",
    `Raw logs: ${input.rawCount}`,
    `Normalized logs: ${input.normalizedCount}`,
    `Readable logs: ${logs.length}`,
    `Clusters: ${input.clusters.length}`,
    "",
    "## Top Clusters",
    "",
  ];

  top.forEach((cluster, index) => {
    lines.push(
      `### ${index + 1}. ${cluster.group} ${cluster.event ?? ""}`.trim(),
      "",
      `Count: ${cluster.count}`,
      `Envs: ${cluster.envs.join(", ") || "-"}`,
      `First seen: ${cluster.firstSeen ?? "-"}`,
      `Last seen: ${cluster.lastSeen ?? "-"}`,
      `Affected projects: ${cluster.projectIds.length}`,
      `Affected users: ${cluster.userIds.length}`,
      `Likely producer: ${guessCodeContext(cluster as LogCluster)}`,
      "",
    );
  });

  lines.push(
    "## Codex Analysis",
    "",
    "Detailed classification and conclusions are written to `conclusion.md`.",
    "Codex should read both `logs.json` and this `summary.md` when doing deeper bug analysis, then update `conclusion.md` with targeted evidence and code-location reasoning.",
    "",
  );

  return `${lines.join("\n")}\n`;
};

const getHeaders = (log: ReadableLog) => asRecord(log.request)?.headers ?? {};
const getPayload = (log: ReadableLog) => asRecord(log.payload) ?? {};

const getProjectId = (log: ReadableLog) => {
  const payload = getPayload(log);
  return asString(payload.projectId) ?? asString(payload.activeProjectId);
};

const getUserId = (log: ReadableLog) => asString(asRecord(getPayload(log).user)?.id);

const getPlatform = (log: ReadableLog) =>
  asString(getHeaders(log)["x-device-platform"]) ?? "unknown";

const getVersion = (log: ReadableLog) =>
  asString(getHeaders(log)["x-app-version"]) ??
  asString(getHeaders(log)["x-app-version-code"]) ??
  "unknown";

const getMissingKey = (log: ReadableLog) => {
  const payload = getPayload(log);
  const previewGate = asRecord(payload.previewGate);
  const resourceStatus = asRecord(payload.resourceStatus);
  const missingEssential = [
    ...(Array.isArray(previewGate?.missingEssential) ? previewGate.missingEssential : []),
    ...(Array.isArray(resourceStatus?.missingEssential)
      ? resourceStatus.missingEssential
      : []),
  ].filter(Boolean);
  if (missingEssential.length > 0) return uniq(missingEssential.map(String)).join(", ");

  const flags = [
    ["firstFrameReady", previewGate?.firstFrameReady],
    ["previewEditAssetsReady", previewGate?.previewEditAssetsReady],
    ["hasEssentialResourcesForPlay", previewGate?.hasEssentialResourcesForPlay],
    ["hasEssentialARollCoverReady", previewGate?.hasEssentialARollCoverReady],
    ["hasBusinessCardFontsReady", previewGate?.hasBusinessCardFontsReady],
    ["fonts", resourceStatus?.fonts],
    ["firstImage", resourceStatus?.firstImage],
    ["firstAudio", resourceStatus?.firstAudio],
    ["backgroundMusic", resourceStatus?.backgroundMusic],
    ["avatar", resourceStatus?.avatar],
    ["watermark", resourceStatus?.watermark],
  ]
    .filter(([, value]) => value === false)
    .map(([key]) => key);

  return flags.length > 0 ? flags.join(", ") : "no explicit missing flag";
};

const getErrorKey = (log: ReadableLog) => {
  const error = asRecord(getPayload(log).error);
  const name = asString(error?.name);
  const message = asString(error?.message);
  if (!name && !message) return undefined;
  return [name, message].filter(Boolean).join(": ");
};

const buildEvidenceRows = (logs: ReadableLog[]) =>
  logs.slice(0, 30).map((log) => {
    const payload = getPayload(log);
    const previewGate = asRecord(payload.previewGate);
    const generation = asRecord(payload.generation);
    const draft = asRecord(payload.draft);
    return [
      `- traceId: ${log.traceId ?? "-"}`,
      `event: ${log.event ?? "-"}`,
      `project: ${getProjectId(log) ?? "-"}`,
      `user: ${getUserId(log) ?? "-"}`,
      `platform: ${getPlatform(log)}`,
      `version: ${getVersion(log)}`,
      `firstFrameReady: ${String(previewGate?.firstFrameReady ?? "-")}`,
      `schemaStatus: ${draft?.schemaStatus ?? "-"}`,
      `generationStatus: ${generation?.generateStatus ?? "-"}`,
      `part: ${log.part?.received ?? "-"}/${log.part?.total ?? "-"}`,
    ].join(" | ");
  });

const buildConclusion = (input: AnalysisInput, logs: ReadableLog[], summaryPath: string) => {
  const incompleteParts = logs.filter((log) => log.part?.complete === false);
  const parseErrors = logs.filter(
    (log) =>
      Array.isArray(log.messageParseErrors) && log.messageParseErrors.length > 0 ||
      Boolean(log.payloadParseError),
  );
  const firstFrameFalse = logs.filter(
    (log) => asRecord(getPayload(log).previewGate)?.firstFrameReady === false,
  );

  const lines = [
    "# Diagnostics Conclusion",
    "",
    "## Source",
    "",
    `- Summary: ${summaryPath}`,
    "- Logs: logs.json",
    `- Window: ${input.window.from} -> ${input.window.to}`,
    `- Envs: ${(input.envs ?? []).join(", ") || "-"}`,
    `- Query: ${input.query}`,
    "",
    "## Overview",
    "",
    `- Readable logs: ${logs.length}`,
    `- Unique trace ids: ${uniq(logs.map((log) => asString(log.traceId))).length}`,
    `- Environments: ${uniq(logs.map((log) => asString(log.env))).join(", ") || "-"}`,
    `- Projects: ${uniq(logs.map(getProjectId)).join(", ") || "-"}`,
    `- Users: ${uniq(logs.map(getUserId)).join(", ") || "-"}`,
    `- Incomplete payload parts: ${incompleteParts.length}`,
    `- Parse errors: ${parseErrors.length}`,
    "",
    "## Event Distribution",
    "",
    formatCounts(countBy(logs, (log) => asString(log.event))),
    "",
    "## Platform Distribution",
    "",
    formatCounts(countBy(logs, getPlatform)),
    "",
    "## Version Distribution",
    "",
    formatCounts(countBy(logs, getVersion)),
    "",
    "## State And Reason Distribution",
    "",
    "### Missing Or Blocking Signals",
    "",
    formatCounts(countBy(logs, getMissingKey)),
    "",
    "### firstFrameReady=false",
    "",
    firstFrameFalse.length > 0
      ? buildEvidenceRows(firstFrameFalse).join("\n")
      : "- none",
    "",
    "### Error Signals",
    "",
    formatCounts(countBy(logs, getErrorKey)),
    "",
    "## Evidence",
    "",
    ...buildEvidenceRows(logs),
    "",
    "## Code Context Hints",
    "",
    "- MotionVideoSkeletonStuck: hugo-aiv-app/src/modules/diagnostics/motionVideoSkeletonDiagnostics.ts",
    "- Remote diagnostics transport: hugo-aiv-app/src/modules/diagnostics/diagnosticsRemoteLog.ts",
    "- Remote upload cap: hugo-aiv-app/src/utils/remoteLog.ts",
    "",
    "## Codex Follow-up",
    "",
    "Codex should use `logs.json` as the primary source for targeted bug reasoning. `summary.md` is only the query and cluster index; avoid using raw SLS `content` because it is intentionally not kept in artifacts.",
    "",
  ];

  return `${lines.join("\n")}\n`;
};

export const buildAnalysisArtifacts = (params: {
  input: AnalysisInput;
  logs: ReadableLog[];
  summaryPath: string;
}) => ({
  summary: buildLocalSummary(params.input, params.logs),
  conclusion: buildConclusion(params.input, params.logs, params.summaryPath),
});
