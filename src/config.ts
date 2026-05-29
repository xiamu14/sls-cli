import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { loadConsoleAuthCache } from "./cookie-cache";
import { loadStsCredentialCache } from "./sts-cache";
import type { EnvironmentName, SlsConsoleEnvConfig, SlsEnvConfig } from "./types";

loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

const DEFAULT_ENVS = ["alpha", "production"];

const DEFAULT_CONSOLE_ENV: Record<
  string,
  Partial<
    Pick<
      SlsConsoleEnvConfig,
      "consoleBaseUrl" | "projectName" | "logstoreName" | "referer"
    >
  >
> = {
  production: {
    consoleBaseUrl: "https://sls.console.aliyun.com",
    projectName: "k8s-log-c7c49b76851914521a874b49399a75ca1",
    logstoreName: "hugo-api",
    referer:
      "https://sls.console.aliyun.com/lognext/project/k8s-log-c7c49b76851914521a874b49399a75ca1/logsearch/hugo-api?slsRegion=cn-shenzhen",
  },
};

const DEFAULT_SLS_ENV: Record<
  string,
  Partial<Pick<SlsEnvConfig, "endpoint" | "projectName" | "logstoreName">>
> = {
  production: {
    endpoint: "cn-shenzhen.log.aliyuncs.com",
    projectName: "k8s-log-c7c49b76851914521a874b49399a75ca1",
    logstoreName: "hugo-api",
  },
};

const get = (key: string) => process.env[key]?.trim();

const upperEnv = (env: string) => env.toUpperCase().replace(/[^A-Z0-9]/g, "_");

const getEnvValue = (env: string, key: string) =>
  get(`SLS_${upperEnv(env)}_${key}`) ?? get(`ALIYUN_SLS_${key}`);

const getConsoleEnvValue = (env: string, key: string) =>
  get(`SLS_CONSOLE_${upperEnv(env)}_${key}`) ??
  get(`SLS_${upperEnv(env)}_${key}`) ??
  get(`ALIYUN_SLS_CONSOLE_${key}`) ??
  get(`ALIYUN_SLS_${key}`);

const getEnvValueAny = (env: string, keys: string[]) => {
  for (const key of keys) {
    const value = getEnvValue(env, key);
    if (value) return value;
  }
  return undefined;
};

const required = (env: string, key: string, aliases: string[] = []) => {
  const keys = [key, ...aliases];
  const value = getEnvValueAny(env, keys);
  if (!value) {
    throw new Error(
      `Missing SLS config: ${keys
        .map((item) => `SLS_${upperEnv(env)}_${item}`)
        .join(" / ")} or ${keys.map((item) => `ALIYUN_SLS_${item}`).join(" / ")}`,
    );
  }
  return value;
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

export const loadSlsConfig = (env: EnvironmentName): SlsEnvConfig => {
  const sts = loadStsCredentialCache(env);
  const defaults = DEFAULT_SLS_ENV[env] ?? {};
  return {
    env,
    endpoint: (
      getEnvValue(env, "ENDPOINT") ??
      defaults.endpoint ??
      required(env, "ENDPOINT")
    ).replace(/^https?:\/\//, ""),
    accessKeyId:
      getEnvValueAny(env, ["ACCESS_KEY_ID", "KEY"]) ??
      sts?.accessKeyId ??
      required(env, "ACCESS_KEY_ID", ["KEY"]),
    accessKeySecret:
      getEnvValueAny(env, ["ACCESS_KEY_SECRET", "SECRET"]) ??
      sts?.accessKeySecret ??
      required(env, "ACCESS_KEY_SECRET", ["SECRET"]),
    projectName:
      getEnvValueAny(env, ["PROJECT_NAME", "PROJECT"]) ??
      defaults.projectName ??
      required(env, "PROJECT_NAME", ["PROJECT"]),
    logstoreName:
      getEnvValueAny(env, ["LOGSTORE_NAME", "LOGSTORE"]) ??
      defaults.logstoreName ??
      required(env, "LOGSTORE_NAME", ["LOGSTORE"]),
    securityToken: getEnvValue(env, "SECURITY_TOKEN") ?? sts?.securityToken,
  };
};

export const loadSlsConsoleConfig = (
  env: EnvironmentName,
): SlsConsoleEnvConfig => {
  const cached = loadConsoleAuthCache(env);
  const defaults = DEFAULT_CONSOLE_ENV[env] ?? {};
  return {
    env,
    consoleBaseUrl:
      getConsoleEnvValue(env, "BASE_URL") ??
      cached?.consoleBaseUrl ??
      defaults.consoleBaseUrl ??
      "https://sls.console.aliyun.com",
    projectName:
      getConsoleEnvValue(env, "PROJECT_NAME") ??
      getConsoleEnvValue(env, "PROJECT") ??
      cached?.projectName ??
      defaults.projectName ??
      requiredConsole(env, "PROJECT_NAME", ["PROJECT"]),
    logstoreName:
      getConsoleEnvValue(env, "LOGSTORE_NAME") ??
      getConsoleEnvValue(env, "LOGSTORE") ??
      cached?.logstoreName ??
      defaults.logstoreName ??
      requiredConsole(env, "LOGSTORE_NAME", ["LOGSTORE"]),
    cookie:
      getConsoleEnvValue(env, "COOKIE") ??
      cached?.cookie ??
      requiredConsole(env, "COOKIE"),
    csrfToken:
      getConsoleEnvValue(env, "CSRF_TOKEN") ??
      getConsoleEnvValue(env, "X_CSRF_TOKEN") ??
      cached?.csrfToken ??
      requiredConsole(env, "CSRF_TOKEN", ["X_CSRF_TOKEN"]),
    referer: getConsoleEnvValue(env, "REFERER") ?? cached?.referer ?? defaults.referer,
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
