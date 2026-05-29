import type { LogCluster, NormalizedLog } from "./types";

const uniq = (values: Array<string | undefined>) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

const logTime = (log: NormalizedLog) => {
  if (log.receiveTime) return new Date(log.receiveTime * 1000).toISOString();
  if (log.time) {
    const parsed = new Date(log.time);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
};

export const clusterLogs = (logs: NormalizedLog[], sampleLimit = 3): LogCluster[] => {
  const map = new Map<string, NormalizedLog[]>();
  for (const log of logs) {
    const current = map.get(log.fingerprint) ?? [];
    current.push(log);
    map.set(log.fingerprint, current);
  }

  return [...map.entries()]
    .map(([fingerprint, items]) => {
      const times = items.map(logTime).filter((value): value is string => Boolean(value)).sort();
      const first = items[0];
      return {
        fingerprint,
        group: first?.group ?? "unknown",
        event: first?.event,
        scope: first?.scope,
        count: items.length,
        firstSeen: times[0],
        lastSeen: times.at(-1),
        envs: uniq(items.map((item) => item.env)),
        projectIds: uniq(items.map((item) => item.projectId)).slice(0, 20),
        userIds: uniq(items.map((item) => item.userId)).slice(0, 20),
        samples: items.slice(0, sampleLimit),
      } satisfies LogCluster;
    })
    .sort((a, b) => b.count - a.count);
};
