import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { valkeyGet, valkeySetEx } from "./valkey-cache";

type CachePayload<T> = {
  savedAt: string;
  expiresAt: string;
  value: T;
};

const provider = () => process.env.QUERY_CACHE_PROVIDER ?? "file";

const ttlSeconds = () => Number(process.env.QUERY_CACHE_TTL_SECONDS ?? 3600);

export const createQueryCacheKey = (parts: unknown) =>
  `hugo-aiv-logs:${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")}`;

const filePath = (key: string) =>
  resolve(process.cwd(), ".cache", "query", `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

const isFresh = <T>(payload: CachePayload<T>) =>
  new Date(payload.expiresAt).getTime() > Date.now();

const readFileCache = <T>(key: string): T | undefined => {
  const path = filePath(key);
  if (!existsSync(path)) return undefined;
  const payload = JSON.parse(readFileSync(path, "utf8")) as CachePayload<T>;
  return isFresh(payload) ? payload.value : undefined;
};

const writeFileCache = async <T>(key: string, value: T) => {
  const path = filePath(key);
  await mkdir(dirname(path), { recursive: true });
  const ttl = ttlSeconds();
  const now = Date.now();
  const payload: CachePayload<T> = {
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    value,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

export const getQueryCache = async <T>(key: string): Promise<T | undefined> => {
  if (provider() === "none") return undefined;

  if (provider() === "valkey" || provider() === "auto") {
    try {
      const cached = await valkeyGet(key);
      if (cached) return JSON.parse(cached) as T;
    } catch (error) {
      if (provider() === "valkey") throw error;
    }
  }

  return readFileCache<T>(key);
};

export const setQueryCache = async <T>(key: string, value: T) => {
  if (provider() === "none") return;

  if (provider() === "valkey" || provider() === "auto") {
    try {
      await valkeySetEx(key, ttlSeconds(), JSON.stringify(value));
      if (provider() === "valkey") return;
    } catch (error) {
      if (provider() === "valkey") throw error;
    }
  }

  await writeFileCache(key, value);
};
