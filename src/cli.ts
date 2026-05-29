import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { analyzeWithOptionalLlm } from "./analyze";
import {
  getAliyunApiAuthCacheStatus,
  parseAliyunApiCurl,
  saveAliyunApiAuthCache,
} from "./aliyun-api-auth";
import { assumeRoleViaProxy, getCallerIdentityViaProxy } from "./aliyun-openapi-proxy";
import {
  loadSlsConfig,
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
import { writeJson, writeJsonl } from "./io";
import { DEFAULT_QUERY, normalizeLogs } from "./normalize";
import { createQueryCacheKey, getQueryCache, setQueryCache } from "./query-cache";
import { pullSlsLogs } from "./sls";
import { probeSlsConsoleAuth, pullSlsConsoleLogs } from "./sls-console";
import { getStsCredentialCacheStatus, saveStsCredentialCache } from "./sts-cache";
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

const getOutputDir = (from: Date, to: Date) =>
  resolve(
    process.cwd(),
    argString(args, "out") ??
      join("artifacts", `${toFileStamp(from)}_${toFileStamp(to)}`),
  );

const readCurlInput = async () => {
  const curlValue = argString(args, "curl");
  if (curlValue) return curlValue;
  const curlFile = argString(args, "curl-file");
  if (curlFile) return await readFile(resolve(process.cwd(), curlFile), "utf8");
  throw new Error("Missing --curl or --curl-file");
};

const importCookie = async () => {
  const env = argString(args, "env") ?? "production";
  const curl = await readCurlInput();
  const auth = parseConsoleCurl(env, curl);
  await saveConsoleAuthCache(auth);
  console.log(
    `[cookie] imported ${env}: project=${auth.projectName ?? "-"} logstore=${auth.logstoreName ?? "-"} csrf=${auth.csrfToken ? "yes" : "no"}`,
  );
};

const importApiCookie = async () => {
  const env = argString(args, "env") ?? "production";
  const curl = await readCurlInput();
  const auth = parseAliyunApiCurl(env, curl);
  await saveAliyunApiAuthCache(auth);
  console.log(
    `[api-cookie] imported ${env}: csrf=${auth.csrfToken ? "yes" : "no"} referer=${auth.referer ? "yes" : "no"}`,
  );
};

const apiCookieStatus = async () => {
  const envs = parseEnvList(argString(args, "env"));
  for (const env of envs) {
    console.log(JSON.stringify(getAliyunApiAuthCacheStatus(env), null, 2));
  }
};

const stsIdentity = async () => {
  const env = argString(args, "env") ?? "production";
  const response = await getCallerIdentityViaProxy(env);
  console.log(JSON.stringify(response, null, 2));
};

const stsAssumeRole = async () => {
  const env = argString(args, "env") ?? "production";
  const roleArn =
    argString(args, "role-arn") ??
    process.env[`STS_${env.toUpperCase()}_ROLE_ARN`] ??
    process.env.STS_ROLE_ARN;
  if (!roleArn) throw new Error("Missing --role-arn or STS_ROLE_ARN");
  const roleSessionName =
    argString(args, "session-name") ?? `hugo-aiv-logs-${Date.now()}`;
  const durationSeconds = argNumber(args, "duration", 3600);
  const credential = await assumeRoleViaProxy({
    env,
    roleArn,
    roleSessionName,
    durationSeconds,
  });
  await saveStsCredentialCache(credential);
  console.log(
    JSON.stringify(
      {
        env,
        accessKeyIdPrefix: credential.accessKeyId.slice(0, 8),
        expiration: credential.expiration,
        roleArn,
        roleSessionName,
        cache: `.cache/sts/${env}.json`,
      },
      null,
      2,
    ),
  );
};

const stsStatus = async () => {
  const envs = parseEnvList(argString(args, "env"));
  for (const env of envs) {
    console.log(JSON.stringify(getStsCredentialCacheStatus(env), null, 2));
  }
};

const cookieStatus = async () => {
  const envs = parseEnvList(argString(args, "env"));
  const probe = argBoolean(args, "probe", false);
  for (const env of envs) {
    const status = getConsoleAuthCacheStatus(env);
    console.log(JSON.stringify(status, null, 2));
    if (probe && status.exists) {
      const config = loadSlsConsoleConfig(env);
      await probeSlsConsoleAuth(config);
      console.log(`[cookie] ${env} probe ok`);
    }
  }
};

const pull = async () => {
  ensureEnvFileHint();

  const { from, to } = getWindow();
  const envs = parseEnvList(argString(args, "env"));
  const query = argString(args, "query") ?? DEFAULT_QUERY;
  const provider = argString(args, "provider") ?? "sdk";
  const line = argNumber(args, "line", 100);
  const maxPages = argNumber(args, "max-pages", 20);
  const reverse = args.reverse === true || argString(args, "reverse") === "true";
  const withPackMeta = argBoolean(args, "with-pack-meta", true);
  const outputDir = getOutputDir(from, to);
  const sdkConfigs = provider === "sdk" ? envs.map((env) => loadSlsConfig(env)) : [];
  const consoleConfigs =
    provider === "console" ? envs.map((env) => loadSlsConsoleConfig(env)) : [];
  if (provider !== "sdk" && provider !== "console") {
    throw new Error(`Unsupported --provider ${provider}. Use sdk or console.`);
  }
  await mkdir(outputDir, { recursive: true });

  const rawByEnv: Record<string, RawSlsRecord[]> = {};
  const consoleMetaByEnv: Record<string, ConsolePullMeta> = {};
  const normalized: NormalizedLog[] = [];

  for (const config of sdkConfigs) {
    const env = config.env;
    console.log(
      `[pull:sdk] ${env}: ${config.projectName}/${config.logstoreName} ${from.toISOString()} -> ${to.toISOString()}`,
    );
    const cacheKey = createQueryCacheKey({
      provider,
      env,
      projectName: config.projectName,
      logstoreName: config.logstoreName,
      from: from.toISOString(),
      to: to.toISOString(),
      query,
      line,
      reverse,
      maxPages,
    });
    const cached = await getQueryCache<RawSlsRecord[]>(cacheKey);
    const logs = cached ?? (await pullSlsLogs({
      config,
      from,
      to,
      query,
      line,
      reverse,
      maxPages,
    }));
    if (cached) console.log(`[cache] hit ${env}`);
    else await setQueryCache(cacheKey, logs);
    rawByEnv[env] = logs;
    normalized.push(...normalizeLogs(env, logs));
    await writeJsonl(join(outputDir, `${env}.raw.jsonl`), logs);
    console.log(`[pull] ${env}: ${logs.length} raw logs`);
  }

  for (const config of consoleConfigs) {
    const env = config.env;
    console.log(
      `[pull:console] ${env}: ${config.projectName}/${config.logstoreName} ${from.toISOString()} -> ${to.toISOString()}`,
    );
    const cacheKey = createQueryCacheKey({
      provider,
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
    const cached = await getQueryCache<{
      logs: RawSlsRecord[];
      meta: ConsolePullMeta;
    }>(cacheKey);
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
    else await setQueryCache(cacheKey, result);
    rawByEnv[env] = result.logs;
    consoleMetaByEnv[env] = result.meta;
    normalized.push(...normalizeLogs(env, result.logs));
    await writeJsonl(join(outputDir, `${env}.raw.jsonl`), result.logs);
    console.log(`[pull] ${env}: ${result.logs.length} raw logs`);
  }

  const clusters = clusterLogs(normalized);
  const analysisInput: AnalysisInput = {
    generatedAt: new Date().toISOString(),
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    query,
    provider,
    rawCount: Object.values(rawByEnv).reduce((sum, items) => sum + items.length, 0),
    normalizedCount: normalized.length,
    clusters,
  };

  await writeJson(join(outputDir, "raw-by-env.json"), rawByEnv);
  if (Object.keys(consoleMetaByEnv).length > 0) {
    await writeJson(join(outputDir, "console-meta-by-env.json"), consoleMetaByEnv);
  }
  await writeJson(join(outputDir, "normalized.json"), normalized);
  await writeJson(join(outputDir, "clusters.json"), clusters);
  await writeJson(join(outputDir, "analysis-input.json"), analysisInput);

  console.log(`[pull] wrote ${outputDir}`);
  return { outputDir, analysisInput };
};

const analyze = async (inputPath?: string) => {
  const path =
    inputPath ??
    argString(args, "input") ??
    (() => {
      throw new Error("Missing --input path to analysis-input.json");
    })();
  const input = (await Bun.file(resolve(process.cwd(), path)).json()) as AnalysisInput;
  const summary = await analyzeWithOptionalLlm(input);
  const output = argString(args, "summary") ?? join(resolve(path, ".."), "summary.md");
  await writeFile(output, summary, "utf8");
  console.log(`[analyze] wrote ${output}`);
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
  if (command === "api-cookie:import") {
    await importApiCookie();
    return;
  }

  if (command === "api-cookie:status") {
    await apiCookieStatus();
    return;
  }

  if (command === "sts:identity") {
    await stsIdentity();
    return;
  }

  if (command === "sts:assume-role") {
    await stsAssumeRole();
    return;
  }

  if (command === "sts:status") {
    await stsStatus();
    return;
  }

  if (command === "cookie:import") {
    await importCookie();
    return;
  }

  if (command === "cookie:status" || command === "check-cookie") {
    await cookieStatus();
    return;
  }

  if (command === "pull") {
    await pull();
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

  if (command === "run") {
    const result = await pull();
    await analyze(join(result.outputDir, "analysis-input.json"));
    return;
  }

  console.log(`Usage:
  bun run src/index.ts api-cookie:import -- --env production --curl-file api-curl.txt
  bun run src/index.ts sts:identity -- --env production
  bun run src/index.ts sts:assume-role -- --env production --role-arn acs:ram::...:role/...
  bun run src/index.ts sts:status -- --env production
  bun run src/index.ts cookie:status -- --env production --probe
  bun run src/index.ts cookie:import -- --env production --curl-file latest-curl.txt
  bun run src/index.ts pull -- --provider sdk --env alpha,production --from "2h ago" --to now
  bun run src/index.ts pull -- --provider console --env production --from "2h ago" --to now
  bun run src/index.ts classify:skeleton -- --artifact artifacts/motion-video-skeleton-102047-week
  bun run src/index.ts analyze -- --input artifacts/.../analysis-input.json
  bun run src/index.ts run -- --env alpha,production --from "2026-05-28 00:00:00+08:00" --to now
`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
