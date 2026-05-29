import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ConsoleAuthCache, EnvironmentName } from "./types";

const cachePath = (env: EnvironmentName) =>
  resolve(process.cwd(), ".cache", "console-auth", `${env}.json`);

const parseHeader = (curl: string, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `-H\\s+(?:'|")${escaped}\\s*:\\s*([^'"]+)(?:'|")`,
    "i",
  );
  return curl.match(re)?.[1]?.trim();
};

const parseCookie = (curl: string) => {
  const cookieFlag = curl.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
  if (cookieFlag?.[2]) return cookieFlag[2].trim();
  return parseHeader(curl, "cookie");
};

const parseUrl = (curl: string) => {
  const quoted = curl.match(/curl\s+(['"])(https?:\/\/[\s\S]*?)\1/);
  if (quoted?.[2]) return quoted[2];
  return curl.match(/curl\s+(https?:\/\/\S+)/)?.[1];
};

const parseData = (curl: string) => {
  const raw = curl.match(/--data-raw\s+\$?(['"])([\s\S]*?)\1/)?.[2];
  if (!raw) return new URLSearchParams();
  return new URLSearchParams(raw.replace(/\\'/g, "'"));
};

export const parseConsoleCurl = (
  env: EnvironmentName,
  curl: string,
): ConsoleAuthCache => {
  const cookie = parseCookie(curl);
  const csrfToken = parseHeader(curl, "x-csrf-token");
  if (!cookie) throw new Error("Could not find cookie in curl (-b/--cookie/header).");
  if (!csrfToken) throw new Error("Could not find x-csrf-token in curl.");

  const url = parseUrl(curl);
  const data = parseData(curl);
  const userAgent = parseHeader(curl, "user-agent");
  const referer = parseHeader(curl, "referer");
  const origin = parseHeader(curl, "origin");

  return {
    env,
    cookie,
    csrfToken,
    referer,
    userAgent,
    consoleBaseUrl: origin ?? (url ? new URL(url).origin : undefined),
    projectName: data.get("ProjectName") ?? undefined,
    logstoreName: data.get("LogStoreName") ?? undefined,
    importedAt: new Date().toISOString(),
    source: "curl",
  };
};

export const saveConsoleAuthCache = async (auth: ConsoleAuthCache) => {
  const path = cachePath(auth.env);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
};

export const loadConsoleAuthCache = (
  env: EnvironmentName,
): ConsoleAuthCache | undefined => {
  const path = cachePath(env);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ConsoleAuthCache;
};

export const getConsoleAuthCacheStatus = (env: EnvironmentName) => {
  const path = cachePath(env);
  const auth = loadConsoleAuthCache(env);
  if (!auth) {
    return {
      env,
      path,
      exists: false,
    };
  }
  const importedAtMs = new Date(auth.importedAt).getTime();
  return {
    env,
    path,
    exists: true,
    importedAt: auth.importedAt,
    ageMinutes: Number.isFinite(importedAtMs)
      ? Math.round((Date.now() - importedAtMs) / 60_000)
      : null,
    hasCookie: Boolean(auth.cookie),
    hasCsrfToken: Boolean(auth.csrfToken),
    hasReferer: Boolean(auth.referer),
    projectName: auth.projectName,
    logstoreName: auth.logstoreName,
  };
};
