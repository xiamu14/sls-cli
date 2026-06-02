import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildAnalysisArtifacts } from "./analyze";
import {
  getConsoleAccountMode,
  loadSlsConsoleConfig,
  parseEnvList,
  ensureEnvFileHint,
} from "./config";
import {
  getConsoleAuthCacheStatus,
  parseConsoleCurl,
  saveConsoleAuthCache,
} from "./cookie-cache";
import { classifyMotionSkeletonArtifact } from "./classify-motion-skeleton";
import { clusterLogs } from "./dedupe";
import { syncConsoleCurlToEnvLocal } from "./env-local";
import { writeJson } from "./io";
import { DEFAULT_QUERY, normalizeLogs } from "./normalize";
import { createQueryCacheKey, getQueryCache, setQueryCache } from "./query-cache";
import { buildReadableLogs } from "./readable-logs";
import { probeSlsConsoleAuth, pullSlsConsoleLogs } from "./sls-console";
import { parseFlexibleDate, toFileStamp } from "./time";
import type {
  AnalysisInput,
  ConsolePullMeta,
  EnvironmentName,
  NormalizedLog,
  RawSlsRecord,
} from "./types";

export type QueryLogsOptions = {
  env?: string | string[];
  from?: string;
  to?: string;
  query?: string;
  line?: number;
  maxPages?: number;
  reverse?: boolean;
  withPackMeta?: boolean;
  cache?: boolean;
  out?: string;
  analyze?: boolean;
  cleanupAnalysisInput?: boolean;
};

export type AnalyzeOptions = {
  inputPath: string;
  summaryPath?: string;
  conclusionPath?: string;
};

export type CookieStatusOptions = {
  env?: string | string[];
  probe?: boolean;
};

const toEnvCsv = (env?: string | string[]) =>
  Array.isArray(env) ? env.join(",") : env;

export const getWindow = (fromValue?: string, toValue?: string) => {
  const to = parseFlexibleDate(toValue, new Date());
  const from = parseFlexibleDate(fromValue, new Date(to.getTime() - 2 * 60 * 60_000));
  if (from >= to) throw new Error("from must be earlier than to");
  return { from, to };
};

export const getOutputDir = (out?: string) =>
  resolve(process.cwd(), out ?? join("artifacts", toFileStamp(new Date())));

const readCurlInput = async (env: string, curl?: string, curlFile?: string) => {
  if (curl) return curl;
  const path = curlFile ?? `.cookie.${env}`;
  try {
    return await readFile(resolve(process.cwd(), path), "utf8");
  } catch (error) {
    throw new Error(
      `Missing cURL file for ${env}: ${path}. Save the browser cURL to .cookie.${env} or pass curlFile.`,
      { cause: error },
    );
  }
};

export const importConsoleCookie = async (params: {
  env?: string;
  curl?: string;
  curlFile?: string;
}) => {
  const env = params.env ?? "production";
  const curl = await readCurlInput(env, params.curl, params.curlFile);
  const auth = parseConsoleCurl(env, curl);
  const envLocal = syncConsoleCurlToEnvLocal({ env, auth });
  const accountMode = getConsoleAccountMode();
  const authEnv = accountMode === "single" ? "single" : env;
  await saveConsoleAuthCache({
    ...auth,
    env: authEnv,
    projectName: undefined,
    logstoreName: undefined,
  });

  return {
    env,
    authEnv,
    accountMode,
    projectName: auth.projectName,
    logstoreName: auth.logstoreName,
    hasCsrfToken: Boolean(auth.csrfToken),
    envLocalChanged: envLocal.changed,
  };
};

export const getCookieStatus = async (options: CookieStatusOptions = {}) => {
  const envs = parseEnvList(toEnvCsv(options.env));
  const probe = options.probe ?? true;

  const statuses = [];
  for (const env of envs) {
    const status = getConsoleAuthCacheStatus(env);
    let probeStatus: unknown = { skipped: !probe };
    let effective: unknown;
    try {
      const config = loadSlsConsoleConfig(env);
      effective = {
        accountMode: config.accountMode,
        authEnv: config.authEnv,
        projectName: config.projectName,
        logstoreName: config.logstoreName,
        hasCookie: Boolean(config.cookie),
        hasCsrfToken: Boolean(config.csrfToken),
        referer: config.referer,
      };
      if (probe) {
        await probeSlsConsoleAuth(config);
        probeStatus = { usable: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (effective) probeStatus = { usable: false, error: message };
      else {
        effective = { error: message };
        probeStatus = { usable: false, error: message };
      }
    }
    statuses.push({ ...status, effective, probe: probeStatus });
  }

  return statuses;
};

export const queryLogs = async (options: QueryLogsOptions = {}) => {
  ensureEnvFileHint();

  const { from, to } = getWindow(options.from, options.to);
  const envs = parseEnvList(toEnvCsv(options.env));
  const query = options.query ?? DEFAULT_QUERY;
  const line = options.line ?? 100;
  const maxPages = options.maxPages ?? 20;
  const reverse = options.reverse ?? false;
  const withPackMeta = options.withPackMeta ?? true;
  const useCache = options.cache ?? true;
  const outputDir = getOutputDir(options.out);
  const consoleConfigs = envs.map((env) => loadSlsConsoleConfig(env));

  const rawByEnv: Record<string, RawSlsRecord[]> = {};
  const metaByEnv: Record<string, ConsolePullMeta> = {};
  const normalized: NormalizedLog[] = [];
  const cacheHits: EnvironmentName[] = [];

  for (const config of consoleConfigs) {
    const env = config.env;
    const cacheKey = createQueryCacheKey({
      provider: "console",
      env,
      projectName: config.projectName,
      logstoreName: config.logstoreName,
      from: from.toISOString(),
      to: to.toISOString(),
      query,
      line,
      reverse,
      maxPages,
      withPackMeta,
    });
    const cached = useCache ? await getQueryCache<{
      logs: RawSlsRecord[];
      meta: ConsolePullMeta;
    }>(cacheKey) : undefined;
    const result = cached ?? (await pullSlsConsoleLogs({
      config,
      from,
      to,
      query,
      line,
      reverse,
      maxPages,
      withPackMeta,
    }));
    if (cached) cacheHits.push(env);
    else if (useCache) await setQueryCache(cacheKey, result);
    rawByEnv[env] = result.logs;
    metaByEnv[env] = result.meta;
    normalized.push(...normalizeLogs(env, result.logs));
  }

  const rawCount = Object.values(rawByEnv).reduce((sum, items) => sum + items.length, 0);
  if (rawCount === 0) {
    return {
      outputDir: null,
      rawCount,
      normalizedCount: 0,
      message: "no logs found",
      cacheHits,
    };
  }

  await mkdir(outputDir, { recursive: true });
  const readableLogs = buildReadableLogs(rawByEnv);
  await writeJson(join(outputDir, "logs.json"), readableLogs);
  await writeJson(join(outputDir, "console-meta-by-env.json"), metaByEnv);

  const clusters = clusterLogs(normalized);
  const analysisInput: AnalysisInput = {
    generatedAt: new Date().toISOString(),
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    envs,
    query,
    provider: "console",
    rawCount,
    normalizedCount: normalized.length,
    clusters,
  };

  const analysisPath = join(outputDir, "analysis-input.json");
  await writeJson(analysisPath, analysisInput);

  let analysis:
    | Awaited<ReturnType<typeof analyzeLogs>>
    | undefined;
  if (options.analyze ?? true) {
    analysis = await analyzeLogs({ inputPath: analysisPath });
    if (options.cleanupAnalysisInput) await rm(analysisPath, { force: true });
  }

  return {
    outputDir,
    logsPath: join(outputDir, "logs.json"),
    consoleMetaPath: join(outputDir, "console-meta-by-env.json"),
    analysisInputPath: options.cleanupAnalysisInput ? undefined : analysisPath,
    summaryPath: analysis?.summaryPath,
    conclusionPath: analysis?.conclusionPath,
    rawCount,
    normalizedCount: normalized.length,
    clusters: clusters.length,
    envs,
    query,
    window: analysisInput.window,
    cacheHits,
  };
};

export const analyzeLogs = async (options: AnalyzeOptions) => {
  const resolvedInputPath = resolve(process.cwd(), options.inputPath);
  const artifactDir = resolve(resolvedInputPath, "..");
  const input = (await Bun.file(resolvedInputPath).json()) as AnalysisInput;
  const logs = (await Bun.file(join(artifactDir, "logs.json")).json()) as Record<
    string,
    unknown
  >[];
  const summaryPath = options.summaryPath ?? join(artifactDir, "summary.md");
  const conclusionPath = options.conclusionPath ?? join(artifactDir, "conclusion.md");
  const artifacts = buildAnalysisArtifacts({
    input,
    logs,
    summaryPath,
  });
  await writeFile(summaryPath, artifacts.summary, "utf8");
  await writeFile(conclusionPath, artifacts.conclusion, "utf8");

  return {
    inputPath: resolvedInputPath,
    artifactDir,
    summaryPath,
    conclusionPath,
    readableLogCount: logs.length,
    clusterCount: input.clusters.length,
  };
};

export const classifySkeletonArtifact = async (artifactDir: string) => {
  const result = await classifyMotionSkeletonArtifact(artifactDir);
  return {
    total: result.total,
    platforms: result.platforms,
    versions: result.versions,
    missingEssentialCombos: result.missingEssentialCombos,
    errorGroupCount: result.errorGroups.length,
  };
};
