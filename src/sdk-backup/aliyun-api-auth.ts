import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AliyunApiAuthCache, EnvironmentName } from "../types";

const cachePath = (env: EnvironmentName) =>
  resolve(process.cwd(), ".cache", "sdk-auth", `${env}.json`);

const parseHeader = (curl: string, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `-H\\s+(?:'|")${escaped}(?:\\s*:\\s*([^'"]*)|\\s*;)(?:'|")`,
    "i",
  );
  const match = curl.match(re);
  if (!match) return undefined;
  return match[1]?.trim() ?? "";
};

const parseCookie = (curl: string) => {
  const cookieFlag = curl.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
  if (cookieFlag?.[2]) return cookieFlag[2].trim();
  return parseHeader(curl, "cookie");
};

export const parseAliyunApiCurl = (
  env: EnvironmentName,
  curl: string,
): AliyunApiAuthCache => {
  const cookie = parseCookie(curl);
  if (!cookie) throw new Error("Could not find API Explorer cookie in curl.");

  return {
    env,
    cookie,
    csrfToken: parseHeader(curl, "x-csrf-token"),
    referer: parseHeader(curl, "referer"),
    userAgent: parseHeader(curl, "user-agent"),
    origin: parseHeader(curl, "origin") || "https://api.aliyun.com",
    importedAt: new Date().toISOString(),
    source: "curl",
  };
};

export const saveAliyunApiAuthCache = async (auth: AliyunApiAuthCache) => {
  const path = cachePath(auth.env);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
};

export const loadAliyunApiAuthCache = (
  env: EnvironmentName,
): AliyunApiAuthCache | undefined => {
  const path = cachePath(env);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as AliyunApiAuthCache;
};

export const getAliyunApiAuthCacheStatus = (env: EnvironmentName) => {
  const path = cachePath(env);
  const auth = loadAliyunApiAuthCache(env);
  if (!auth) return { env, path, exists: false };
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
    referer: auth.referer,
  };
};
