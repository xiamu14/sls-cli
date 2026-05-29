import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJson } from "./io";

type RawRecord = Record<string, unknown>;

type SkeletonItem = {
  env?: string;
  slsTime?: string;
  reportTime?: string;
  platform: string;
  appVersion: string;
  appVersionCode: string;
  osVersion?: string;
  deviceBrand?: string;
  deviceModel?: string;
  userId?: string;
  projectId?: string;
  activeProjectId?: string;
  event?: string;
  elapsedMs?: number;
  loadMotionType?: string;
  directOpen?: boolean;
  draftStatus?: string;
  draftSchemaStatus?: string;
  draftIsTemplate?: boolean;
  hasOutputFileUrl?: boolean;
  missingEssential: string[];
  missingFull: string[];
  resourceState: Record<string, boolean | undefined>;
  resourceCounts: Record<string, number | undefined>;
  parseQuality: "json" | "regex" | "failed";
  rawGroup?: string;
  firstFrameReady?: boolean;
  hasEssentialResourcesForPlay?: boolean;
  truncatedMessage: boolean;
  messageLength: number;
};

type CountMap = Record<string, number>;

const inc = (map: CountMap, key: string | undefined, by = 1) => {
  const safe = key && key.length > 0 ? key : "unknown";
  map[safe] = (map[safe] ?? 0) + by;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const parseNestedJson = (value: unknown): unknown => {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    if (typeof current !== "string") break;
    const next = parseJson(current);
    if (next == null) break;
    current = next;
  }
  if (Array.isArray(current) && current.length === 1) {
    return parseNestedJson(current[0]);
  }
  return current;
};

const readPath = (record: Record<string, unknown>, path: string[]) => {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const parseUserAgent = (ua?: string) => {
  if (!ua) return {};
  return {
    osVersion:
      ua.match(/Android\s+([^;)\s]+)/i)?.[1] ??
      ua.match(/OS\s+([0-9_]+)/i)?.[1]?.replace(/_/g, "."),
    deviceBrand: ua.match(/\bBrand\/([^ ]+)/i)?.[1],
    deviceModel:
      ua.match(/\bModel\/(.+?)\s+PackageName\//i)?.[1] ??
      ua.match(/;\s*([^;()]+?)\s+Build\//i)?.[1]?.trim(),
  };
};

const regexString = (text: string, key: string) =>
  text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1];

const regexBool = (text: string, key: string) => {
  const value = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`))?.[1];
  return value == null ? undefined : value === "true";
};

const regexNumber = (text: string, key: string) => {
  const value = text.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`))?.[1];
  return value == null ? undefined : Number(value);
};

const regexStringArray = (text: string, key: string) => {
  const raw = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`))?.[1];
  if (!raw) return [];
  return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

const objectStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const getBodyEntries = (content: Record<string, unknown>) => {
  const data = readPath(content, ["reqData", "body", "data"]);
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data)) return Object.values(data).filter(isRecord);
  return [];
};

const extractPayload = (message: unknown) => {
  const parsed = parseNestedJson(message);
  if (isRecord(parsed)) return { payload: parsed, quality: "json" as const };
  if (typeof message === "string") return { raw: message, quality: "regex" as const };
  return { quality: "failed" as const };
};

const classifyPayload = ({
  rawRecord,
  content,
  entry,
}: {
  rawRecord: RawRecord;
  content: Record<string, unknown>;
  entry: Record<string, unknown>;
}): SkeletonItem => {
  const headers = readPath(content, ["reqData", "headers"]);
  const headerRecord = isRecord(headers) ? headers : {};
  const ua = asString(headerRecord["user-agent"]);
  const uaInfo = parseUserAgent(ua);
  const extracted = extractPayload(entry.message);
  const payload = isRecord(extracted.payload) ? extracted.payload : undefined;
  const rawMessage = typeof entry.message === "string" ? entry.message : "";
  const previewGate = isRecord(payload?.previewGate) ? payload.previewGate : {};
  const resourceStatus = isRecord(payload?.resourceStatus)
    ? payload.resourceStatus
    : {};
  const resourceCounts = isRecord(payload?.resourceCounts)
    ? payload.resourceCounts
    : {};
  const draft = isRecord(payload?.draft) ? payload.draft : {};
  const route = isRecord(payload?.route) ? payload.route : {};

  return {
    slsTime: asString(rawRecord._time_) ?? asString(rawRecord.__time__),
    reportTime: asString(entry.time),
    platform:
      asString(headerRecord["x-device-platform"]) ??
      (ua?.includes("Android") ? "Android" : ua?.includes("iPhone") ? "iOS" : "unknown"),
    appVersion: asString(headerRecord["x-app-version"]) ?? "unknown",
    appVersionCode: asString(headerRecord["x-app-version-code"]) ?? "unknown",
    osVersion: uaInfo.osVersion,
    deviceBrand: uaInfo.deviceBrand,
    deviceModel: uaInfo.deviceModel,
    userId:
      asString(readPath(content, ["reqData", "userId"])) ??
      asString(readPath(payload ?? {}, ["user", "id"])),
    projectId: asString(payload?.projectId) ?? regexString(rawMessage, "projectId"),
    activeProjectId:
      asString(payload?.activeProjectId) ?? regexString(rawMessage, "activeProjectId"),
    event: asString(payload?.event) ?? regexString(rawMessage, "event"),
    firstFrameReady:
      typeof previewGate.firstFrameReady === "boolean"
        ? previewGate.firstFrameReady
        : regexBool(rawMessage, "firstFrameReady"),
    hasEssentialResourcesForPlay:
      typeof previewGate.hasEssentialResourcesForPlay === "boolean"
        ? previewGate.hasEssentialResourcesForPlay
        : regexBool(rawMessage, "hasEssentialResourcesForPlay"),
    elapsedMs: asNumber(payload?.elapsedMs) ?? regexNumber(rawMessage, "elapsedMs"),
    loadMotionType:
      asString(route.loadMotionType) ?? regexString(rawMessage, "loadMotionType"),
    directOpen:
      typeof route.directOpen === "boolean"
        ? route.directOpen
        : regexBool(rawMessage, "directOpen"),
    draftStatus: asString(draft.status) ?? regexString(rawMessage, "status"),
    draftSchemaStatus:
      asString(draft.schemaStatus) ?? regexString(rawMessage, "schemaStatus"),
    draftIsTemplate:
      typeof draft.isTemplate === "boolean"
        ? draft.isTemplate
        : regexBool(rawMessage, "isTemplate"),
    hasOutputFileUrl:
      typeof draft.hasOutputFileUrl === "boolean"
        ? draft.hasOutputFileUrl
        : regexBool(rawMessage, "hasOutputFileUrl"),
    missingEssential:
      objectStringArray(previewGate.missingEssential).length > 0
        ? objectStringArray(previewGate.missingEssential)
        : regexStringArray(rawMessage, "missingEssential"),
    missingFull:
      objectStringArray(resourceStatus.missingFull).length > 0
        ? objectStringArray(resourceStatus.missingFull)
        : regexStringArray(rawMessage, "missingFull"),
    resourceState: {
      essentialReady:
        typeof resourceStatus.essentialReady === "boolean"
          ? resourceStatus.essentialReady
          : regexBool(rawMessage, "essentialReady"),
      fonts:
        typeof resourceStatus.fonts === "boolean"
          ? resourceStatus.fonts
          : regexBool(rawMessage, "fonts"),
      firstImage:
        typeof resourceStatus.firstImage === "boolean"
          ? resourceStatus.firstImage
          : regexBool(rawMessage, "firstImage"),
      firstAudio:
        typeof resourceStatus.firstAudio === "boolean"
          ? resourceStatus.firstAudio
          : regexBool(rawMessage, "firstAudio"),
      backgroundMusic:
        typeof resourceStatus.backgroundMusic === "boolean"
          ? resourceStatus.backgroundMusic
          : regexBool(rawMessage, "backgroundMusic"),
      avatar:
        typeof resourceStatus.avatar === "boolean"
          ? resourceStatus.avatar
          : regexBool(rawMessage, "avatar"),
      watermark:
        typeof resourceStatus.watermark === "boolean"
          ? resourceStatus.watermark
          : regexBool(rawMessage, "watermark"),
    },
    resourceCounts: {
      imageClips: asNumber(resourceCounts.imageClips) ?? regexNumber(rawMessage, "imageClips"),
      backgroundImageClips:
        asNumber(resourceCounts.backgroundImageClips) ??
        regexNumber(rawMessage, "backgroundImageClips"),
      audioClips: asNumber(resourceCounts.audioClips) ?? regexNumber(rawMessage, "audioClips"),
      businessCardClips:
        asNumber(resourceCounts.businessCardClips) ??
        regexNumber(rawMessage, "businessCardClips"),
      aRollVideoClips:
        asNumber(resourceCounts.aRollVideoClips) ??
        regexNumber(rawMessage, "aRollVideoClips"),
      previewCoverClips:
        asNumber(resourceCounts.previewCoverClips) ??
        regexNumber(rawMessage, "previewCoverClips"),
    },
    parseQuality: extracted.quality,
    rawGroup: asString(entry.group),
    truncatedMessage: rawMessage.endsWith("..."),
    messageLength: rawMessage.length,
  };
};

export const extractMotionSkeletonItems = (records: RawRecord[]) => {
  const items: SkeletonItem[] = [];
  for (const rawRecord of records) {
    const contentText = asString(rawRecord.content);
    const content = contentText ? parseJson(contentText) : rawRecord;
    if (!isRecord(content)) continue;
    for (const entry of getBodyEntries(content)) {
      if (entry.group !== "[MotionVideoSkeletonStuck]") continue;
      items.push(classifyPayload({ rawRecord, content, entry }));
    }
  }
  return items;
};

const signatureOf = (item: SkeletonItem) => {
  const missing =
    item.missingEssential.length > 0 ? item.missingEssential.slice().sort().join("+") : "unknown";
  const full =
    item.missingFull.length > 0 ? item.missingFull.slice().sort().join("+") : "unknown";
  return [
    item.event ?? "unknown",
    `missingEssential=${missing}`,
    `missingFull=${full}`,
    `firstFrameReady=${String(item.firstFrameReady)}`,
    `hasEssentialResourcesForPlay=${String(item.hasEssentialResourcesForPlay)}`,
    `firstImage=${String(item.resourceState.firstImage)}`,
    `firstAudio=${String(item.resourceState.firstAudio)}`,
    `fonts=${String(item.resourceState.fonts)}`,
    `loadMotionType=${item.loadMotionType ?? "unknown"}`,
    `template=${String(item.draftIsTemplate)}`,
  ].join(" | ");
};

const groupItems = (items: SkeletonItem[]) => {
  const map = new Map<string, SkeletonItem[]>();
  for (const item of items) {
    const key = signatureOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()]
    .map(([signature, values]) => ({
      signature,
      count: values.length,
      versions: countBy(values, (item) => `${item.appVersion}(${item.appVersionCode})`),
      platforms: countBy(values, (item) => item.platform),
      projects: unique(values.map((item) => item.projectId)).slice(0, 20),
      users: unique(values.map((item) => item.userId)).slice(0, 20),
      sample: values[0],
    }))
    .sort((a, b) => b.count - a.count);
};

const unique = (values: Array<string | undefined>) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

const countBy = (items: SkeletonItem[], getKey: (item: SkeletonItem) => string | undefined) => {
  const map: CountMap = {};
  for (const item of items) inc(map, getKey(item));
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]));
};

const countMany = (items: SkeletonItem[], getKeys: (item: SkeletonItem) => string[]) => {
  const map: CountMap = {};
  for (const item of items) {
    const keys = getKeys(item);
    if (keys.length === 0) inc(map, "unknown");
    keys.forEach((key) => inc(map, key));
  }
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]));
};

export const classifyMotionSkeleton = (records: RawRecord[]) => {
  const items = extractMotionSkeletonItems(records);
  return {
    total: items.length,
    parseQuality: countBy(items, (item) => item.parseQuality),
    events: countBy(items, (item) => item.event),
    platforms: countBy(items, (item) => item.platform),
    versions: countBy(items, (item) => `${item.appVersion}(${item.appVersionCode})`),
    firstFrameReady: countBy(items, (item) => String(item.firstFrameReady)),
    hasEssentialResourcesForPlay: countBy(items, (item) =>
      String(item.hasEssentialResourcesForPlay),
    ),
    osVersions: countBy(items, (item) => `${item.platform} ${item.osVersion ?? "unknown"}`),
    loadMotionTypes: countBy(items, (item) => item.loadMotionType),
    draftStatus: countBy(items, (item) => item.draftStatus),
    draftSchemaStatus: countBy(items, (item) => item.draftSchemaStatus),
    templateDistribution: countBy(items, (item) =>
      item.draftIsTemplate == null ? "unknown" : String(item.draftIsTemplate),
    ),
    outputFileDistribution: countBy(items, (item) =>
      item.hasOutputFileUrl == null ? "unknown" : String(item.hasOutputFileUrl),
    ),
    missingEssential: countMany(items, (item) => item.missingEssential),
    missingEssentialCombos: countBy(items, (item) =>
      item.missingEssential.length > 0
        ? item.missingEssential.slice().sort().join("+")
        : "unknown",
    ),
    missingFull: countMany(items, (item) => item.missingFull),
    resourceStateFalse: countMany(items, (item) =>
      Object.entries(item.resourceState)
        .filter(([, value]) => value === false)
        .map(([key]) => key),
    ),
    resourceStateUnknown: countMany(items, (item) =>
      Object.entries(item.resourceState)
        .filter(([, value]) => value == null)
        .map(([key]) => key),
    ),
    truncation: {
      truncatedMessages: items.filter((item) => item.truncatedMessage).length,
      messageLength: {
        min: Math.min(...items.map((item) => item.messageLength)),
        max: Math.max(...items.map((item) => item.messageLength)),
      },
    },
    errorGroups: groupItems(items),
    items,
  };
};

const formatCountMap = (title: string, map: CountMap) => {
  const lines = [`## ${title}`, ""];
  for (const [key, count] of Object.entries(map)) {
    lines.push(`- ${key}: ${count}`);
  }
  lines.push("");
  return lines;
};

export const writeMotionSkeletonClassification = async ({
  records,
  outputDir,
}: {
  records: RawRecord[];
  outputDir: string;
}) => {
  const result = classifyMotionSkeleton(records);
  await writeJson(join(outputDir, "motion-skeleton-classification.json"), result);
  const lines = [
    "# MotionVideoSkeletonStuck Classification",
    "",
    `Total: ${result.total}`,
    "",
    ...formatCountMap("Parse Quality", result.parseQuality),
    ...formatCountMap("Events", result.events),
    ...formatCountMap("Platforms", result.platforms),
    ...formatCountMap("Versions", result.versions),
    ...formatCountMap("First Frame Ready", result.firstFrameReady),
    ...formatCountMap(
      "Has Essential Resources For Play",
      result.hasEssentialResourcesForPlay,
    ),
    ...formatCountMap("Missing Essential Combos", result.missingEssentialCombos),
    ...formatCountMap("Missing Essential Fields", result.missingEssential),
    ...formatCountMap("Missing Full Fields", result.missingFull),
    ...formatCountMap("Resource State False", result.resourceStateFalse),
    "## Error Groups",
    "",
  ];

  result.errorGroups.slice(0, 30).forEach((group, index) => {
    lines.push(
      `### ${index + 1}. ${group.signature}`,
      "",
      `Count: ${group.count}`,
      `Platforms: ${JSON.stringify(group.platforms)}`,
      `Versions: ${JSON.stringify(group.versions)}`,
      `Projects: ${group.projects.length}`,
      `Users: ${group.users.length}`,
      "",
    );
  });

  await writeFile(
    join(outputDir, "motion-skeleton-classification.md"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
  return result;
};

export const classifyMotionSkeletonArtifact = async (artifactDir: string) => {
  const rawPath = resolve(process.cwd(), artifactDir, "production.raw.jsonl");
  const text = await Bun.file(rawPath).text();
  const records = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return await writeMotionSkeletonClassification({
    records,
    outputDir: resolve(process.cwd(), artifactDir),
  });
};
