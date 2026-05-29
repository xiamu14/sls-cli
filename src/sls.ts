import Client from "@alicloud/log";

import type { RawSlsRecord, SlsEnvConfig } from "./types";

type SlsResponse = RawSlsRecord[] | { logs?: RawSlsRecord[]; count?: number };

const extractLogs = (response: SlsResponse): RawSlsRecord[] => {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.logs)) return response.logs;
  return [];
};

export const createSlsClient = (config: SlsEnvConfig) =>
  new Client({
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    securityToken: config.securityToken,
    use_https: true,
  });

export const pullSlsLogs = async ({
  config,
  from,
  to,
  query,
  line,
  reverse,
  maxPages,
}: {
  config: SlsEnvConfig;
  from: Date;
  to: Date;
  query: string;
  line: number;
  reverse: boolean;
  maxPages: number;
}) => {
  const client = createSlsClient(config);
  const logs: RawSlsRecord[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * line;
    const response = (await client.getLogs(config.projectName, config.logstoreName, from, to, {
      query,
      line,
      offset,
      reverse,
    })) as SlsResponse;
    const pageLogs = extractLogs(response);
    logs.push(...pageLogs);
    if (pageLogs.length < line) break;
  }

  return logs;
};
