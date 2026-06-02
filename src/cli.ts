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
  NormalizedLog,
  RawSlsRecord,
} from "./types";

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]) => {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
};

const argString = (args: Args, key: string) => {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

const argNumber = (args: Args, key: string, fallback: number) => {
  const value = argString(args, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
};

const argBoolean = (args: Args, key: string, fallback: boolean) => {
  const value = args[key];
  if (value == null) return fallback;
  if (value === true) return true;
  if (typeof value !== "string") return fallback;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  return fallback;
};

const command = process.argv[2] ?? "run";
const args = parseArgs(process.argv.slice(3));

const getWindow = () => {
  const to = parseFlexibleDate(argString(args, "to"), new Date());
  const from = parseFlexibleDate(
    argString(args, "from"),
    new Date(to.getTime() - 2 * 60 * 60_000),
  );
  if (from >= to) throw new Error("--from must be earlier than --to");
  return { from, to };
};

const getOutputDir = () =>
  resolve(
    process.cwd(),
    argString(args, "out") ?? join("artifacts", toFileStamp(new Date())),
  );

const readCurlInput = async (env: string) => {
  const curlValue = argString(args, "curl");
  if (curlValue) return curlValue;
  const curlFile = argString(args, "curl-file") ?? `.cookie.${env}`;
  try {
    return await readFile(resolve(process.cwd(), curlFile), "utf8");
  } catch (error) {
    throw new Error(
      `Missing cURL file for ${env}: ${curlFile}. Save the browser cURL to .cookie.${env} or pass --curl-file.`,
      { cause: error },
    );
  }
};

const importCookie = async () => {
  const env = argString(args, "env") ?? "production";
  const curl = await readCurlInput(env);
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
  console.log(
    `[cookie] imported ${env}: auth=${authEnv} mode=${accountMode} project=${auth.projectName ?? "-"} logstore=${auth.logstoreName ?? "-"} csrf=${auth.csrfToken ? "yes" : "no"} envLocal=${envLocal.changed.length > 0 ? envLocal.changed.join(",") : "unchanged"}`,
  );
};

const cookieStatus = async () => {
  const envs = parseEnvList(argString(args, "env"));
  const probe = argBoolean(args, "probe", true);
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
    console.log(JSON.stringify({ ...status, effective, probe: probeStatus }, null, 2));
  }
};

const queryLogs = async () => {
  ensureEnvFileHint();

  const { from, to } = getWindow();
  const envs = parseEnvList(argString(args, "env"));
  const query = argString(args, "query") ?? DEFAULT_QUERY;
  const line = argNumber(args, "line", 100);
  const maxPages = argNumber(args, "max-pages", 20);
  const reverse = args.reverse === true || argString(args, "reverse") === "true";
  const withPackMeta = argBoolean(args, "with-pack-meta", true);
  const useCache = argBoolean(args, "cache", true);
  const outputDir = getOutputDir();
  const consoleConfigs = envs.map((env) => loadSlsConsoleConfig(env));

  const rawByEnv: Record<string, RawSlsRecord[]> = {};
  const metaByEnv: Record<string, ConsolePullMeta> = {};
  const normalized: NormalizedLog[] = [];

  for (const config of consoleConfigs) {
    const env = config.env;
    console.log(
      `[query:console] ${env}: ${config.projectName}/${config.logstoreName} auth=${config.authEnv} mode=${config.accountMode} ${from.toISOString()} -> ${to.toISOString()}`,
    );
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
    if (cached) console.log(`[cache] hit ${env}`);
    else if (useCache) await setQueryCache(cacheKey, result);
    rawByEnv[env] = result.logs;
    metaByEnv[env] = result.meta;
    normalized.push(...normalizeLogs(env, result.logs));
    console.log(`[query] ${env}: ${result.logs.length} raw logs`);
  }

  const rawCount = Object.values(rawByEnv).reduce((sum, items) => sum + items.length, 0);
  if (rawCount === 0) {
    console.log("[query] no logs found, skipped artifact and analysis output");
    return null;
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

  await writeJson(join(outputDir, "analysis-input.json"), analysisInput);

  console.log(`[query] wrote ${outputDir}`);
  return { outputDir, analysisInput };
};

const analyze = async (inputPath?: string) => {
  const path =
    inputPath ??
    argString(args, "input") ??
    (() => {
      throw new Error("Missing --input path to analysis-input.json");
    })();
  const resolvedInputPath = resolve(process.cwd(), path);
  const artifactDir = resolve(resolvedInputPath, "..");
  const input = (await Bun.file(resolvedInputPath).json()) as AnalysisInput;
  const logs = (await Bun.file(join(artifactDir, "logs.json")).json()) as Record<
    string,
    unknown
  >[];
  const summaryPath = argString(args, "summary") ?? join(artifactDir, "summary.md");
  const conclusionPath =
    argString(args, "conclusion") ?? join(artifactDir, "conclusion.md");
  const artifacts = buildAnalysisArtifacts({
    input,
    logs,
    summaryPath,
  });
  await writeFile(summaryPath, artifacts.summary, "utf8");
  await writeFile(conclusionPath, artifacts.conclusion, "utf8");
  console.log(`[analyze] wrote ${summaryPath}`);
  console.log(`[analyze] wrote ${conclusionPath}`);
};

const classifySkeleton = async () => {
  const artifactDir =
    argString(args, "artifact") ??
    argString(args, "input") ??
    (() => {
      throw new Error("Missing --artifact path");
    })();
  const result = await classifyMotionSkeletonArtifact(artifactDir);
  console.log(
    JSON.stringify(
      {
        total: result.total,
        platforms: result.platforms,
        versions: result.versions,
        missingEssentialCombos: result.missingEssentialCombos,
        errorGroupCount: result.errorGroups.length,
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  if (command === "cookie:import") {
    await importCookie();
    return;
  }

  if (command === "cookie:status" || command === "check-cookie") {
    await cookieStatus();
    return;
  }

  if (command === "query" || command === "pull" || command === "run") {
    const result = await queryLogs();
    if (result) {
      const analysisPath = join(result.outputDir, "analysis-input.json");
      await analyze(analysisPath);
      await rm(analysisPath, { force: true });
    }
    return;
  }

  if (command === "analyze") {
    await analyze();
    return;
  }

  if (command === "classify:skeleton") {
    await classifySkeleton();
    return;
  }

  console.log(`Usage:
  bun run src/index.ts cookie:status -- --env production --probe
  bun run src/index.ts cookie:import -- --env production
  bun run src/index.ts query -- --env production --from "2h ago" --to now
  bun run src/index.ts classify:skeleton -- --artifact artifacts/motion-video-skeleton-102047-week
  bun run src/index.ts analyze -- --input artifacts/.../analysis-input.json
`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
