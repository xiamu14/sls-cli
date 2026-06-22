import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { loadConsoleAuthCache } from "./cookie-cache";
import type { EnvironmentName, SlsConsoleEnvConfig } from "./types";

loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });
loadDotenv({ path: resolve(process.cwd(), ".env.local"), override: true, quiet: true });

const DEFAULT_ENVS = ["alpha", "production"];

const DEFAULT_CONSOLE_ENV: Record<
  string,
  Partial<
    Pick<
      SlsConsoleEnvConfig,
      "consoleBaseUrl" | "referer"
    >
  >
> = {
  production: {
    consoleBaseUrl: "https://sls.console.aliyun.com",
  },
};

const get = (key: string) => {
  const value = process.env[key]?.trim();
  if (value?.includes("<project>") || value?.includes("<logstore>") || value?.includes("<region>")) {
    return undefined;
  }
  return value ? value : undefined;
};

const upperEnv = (env: string) => env.toUpperCase().replace(/[^A-Z0-9]/g, "_");

const getEnvValue = (env: string, key: string) =>
  get(`SLS_${upperEnv(env)}_${key}`) ?? get(`ALIYUN_SLS_${key}`);

const getConsoleEnvValue = (env: string, key: string) =>
  get(`SLS_CONSOLE_${upperEnv(env)}_${key}`) ??
  get(`SLS_${upperEnv(env)}_${key}`) ??
  get(`ALIYUN_SLS_CONSOLE_${key}`) ??
  get(`ALIYUN_SLS_${key}`);

export const getConsoleAccountMode = (): "single" | "environment" => {
  const value = (
    get("SLS_ACCOUNT_MODE") ??
    get("ACCOUNT_MODE") ??
    get("account_mode") ??
    "single"
  ).toLowerCase();
  if (value === "single" || value === "signle") return "single";
  if (value === "environment") return "environment";
  throw new Error(`Invalid SLS_ACCOUNT_MODE: ${value}. Use single or environment.`);
};

const requiredConsole = (env: string, key: string, aliases: string[] = []) => {
  const keys = [key, ...aliases];
  for (const item of keys) {
    const value = getConsoleEnvValue(env, item);
    if (value) return value;
  }
  throw new Error(
    `Missing SLS console config for ${env}: ${keys
      .map((item) => `SLS_CONSOLE_${upperEnv(env)}_${item}`)
      .join(" / ")}`,
  );
};

export const parseEnvList = (value?: string): EnvironmentName[] => {
  const raw = value ?? get("SLS_ENVIRONMENTS") ?? DEFAULT_ENVS.join(",");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const extractRegionFromReferer = (referer?: string) =>
  referer?.match(/[?&]slsRegion=([^&]+)/)?.[1];

const extractRegionFromEndpoint = (endpoint?: string) =>
  endpoint?.replace(/^https?:\/\//, "").match(/^([a-z]+-[a-z]+-\d+)\.log\.aliyuncs\.com$/)?.[1];

const getConsoleRegion = (env: EnvironmentName, cachedReferer?: string) =>
  getConsoleEnvValue(env, "REGION") ??
  getEnvValue(env, "REGION") ??
  extractRegionFromReferer(getConsoleEnvValue(env, "REFERER")) ??
  extractRegionFromReferer(cachedReferer) ??
  extractRegionFromEndpoint(getEnvValue(env, "ENDPOINT")) ??
  "cn-shenzhen";

const buildConsoleReferer = ({
  consoleBaseUrl,
  projectName,
  logstoreName,
  region,
}: {
  consoleBaseUrl: string;
  projectName: string;
  logstoreName: string;
  region: string;
}) =>
  `${consoleBaseUrl.replace(/\/$/, "")}/lognext/project/${projectName}/logsearch/${logstoreName}?slsRegion=${region}`;

const loadConsoleAuthForEnv = (env: EnvironmentName) => {
  const accountMode = getConsoleAccountMode();
  if (accountMode === "environment") {
    return {
      accountMode,
      authEnv: env,
      cached: loadConsoleAuthCache(env),
    };
  }

  const candidates = ["single", env, "production", "alpha"];
  for (const candidate of candidates) {
    const cached = loadConsoleAuthCache(candidate);
    if (cached) {
      return {
        accountMode,
        authEnv: candidate,
        cached,
      };
    }
  }
  return {
    accountMode,
    authEnv: "single",
    cached: undefined,
  };
};

export const loadSlsConsoleConfig = (
  env: EnvironmentName,
): SlsConsoleEnvConfig => {
  const target = loadSlsConsoleTarget(env);
  const { cached } = loadConsoleAuthForEnv(env);
  return {
    ...target,
    cookie:
      getConsoleEnvValue(env, "COOKIE") ??
      cached?.cookie ??
      requiredConsole(env, "COOKIE"),
    csrfToken:
      getConsoleEnvValue(env, "CSRF_TOKEN") ??
      getConsoleEnvValue(env, "X_CSRF_TOKEN") ??
      cached?.csrfToken ??
      requiredConsole(env, "CSRF_TOKEN", ["X_CSRF_TOKEN"]),
  };
};

const loadSlsConsoleTarget = (env: EnvironmentName) => {
  const { accountMode, authEnv, cached } = loadConsoleAuthForEnv(env);
  const defaults = DEFAULT_CONSOLE_ENV[env] ?? {};
  const consoleBaseUrl =
    getConsoleEnvValue(env, "BASE_URL") ??
    cached?.consoleBaseUrl ??
    defaults.consoleBaseUrl ??
    "https://sls.console.aliyun.com";
  const projectName =
    getConsoleEnvValue(env, "PROJECT_NAME") ??
    getConsoleEnvValue(env, "PROJECT") ??
    requiredConsole(env, "PROJECT_NAME", ["PROJECT"]);
  const logstoreName =
    getConsoleEnvValue(env, "LOGSTORE_NAME") ??
    getConsoleEnvValue(env, "LOGSTORE") ??
    requiredConsole(env, "LOGSTORE_NAME", ["LOGSTORE"]);
  const region = getConsoleRegion(env, cached?.referer ?? defaults.referer);
  const cachedRefererMatchesTarget =
    cached?.projectName === projectName && cached?.logstoreName === logstoreName;
  return {
    env,
    accountMode,
    authEnv,
    consoleBaseUrl,
    projectName,
    logstoreName,
    referer:
      getConsoleEnvValue(env, "REFERER") ??
      (cachedRefererMatchesTarget ? cached?.referer : undefined) ??
      defaults.referer ??
      buildConsoleReferer({ consoleBaseUrl, projectName, logstoreName, region }),
    userAgent:
      getConsoleEnvValue(env, "USER_AGENT") ??
      cached?.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };
};

export const ensureEnvFileHint = () => {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) return;

  console.warn(
    `[config] No .env found at ${envPath}. Copy .env.example and fill SLS credentials.`,
  );
};
