import type { AnalysisInput, LogCluster } from "./types";

const payloadSummary = (cluster: LogCluster) => {
  const sample = cluster.samples[0]?.payload;
  return JSON.stringify(sample, null, 2).slice(0, 1600);
};

const guessCodeContext = (cluster: LogCluster) => {
  switch (cluster.group) {
    case "[MotionVideoSkeletonStuck]":
      return "hugo-aiv-app/src/modules/diagnostics/motionVideoSkeletonLogging.ts";
    case "[videoPlayerError]":
      return "hugo-aiv-app/src/modules/diagnostics/videoPlayerErrorDiagnostics.ts";
    case "[motionVideoDl]":
      return "hugo-aiv-app/src/modules/diagnostics/motionVideoDownloadSessionDiagnostics.ts";
    case "[LinkVideoDraftTrace]":
      return "hugo-aiv-app/src/modules/diagnostics/linkVideoDraftCreateTrace.ts";
    case "[FetchNetworkError]":
      return "hugo-aiv-app/src/api/utils.ts";
    default:
      return "unknown";
  }
};

const buildLocalSummary = (input: AnalysisInput) => {
  const top = input.clusters.slice(0, 20);
  const lines = [
    "# Diagnostics Summary",
    "",
    `Generated at: ${input.generatedAt}`,
    `Window: ${input.window.from} -> ${input.window.to}`,
    `Query: ${input.query}`,
    "",
    `Raw logs: ${input.rawCount}`,
    `Normalized logs: ${input.normalizedCount}`,
    `Clusters: ${input.clusters.length}`,
    "",
    "## Top Clusters",
    "",
  ];

  top.forEach((cluster, index) => {
    lines.push(
      `### ${index + 1}. ${cluster.group} ${cluster.event ?? ""}`.trim(),
      "",
      `Count: ${cluster.count}`,
      `Envs: ${cluster.envs.join(", ") || "-"}`,
      `First seen: ${cluster.firstSeen ?? "-"}`,
      `Last seen: ${cluster.lastSeen ?? "-"}`,
      `Affected projects: ${cluster.projectIds.length}`,
      `Affected users: ${cluster.userIds.length}`,
      `Likely producer: ${guessCodeContext(cluster)}`,
      "",
      "Sample:",
      "```json",
      payloadSummary(cluster),
      "```",
      "",
    );
  });

  return `${lines.join("\n")}\n`;
};

const buildLlmPrompt = (input: AnalysisInput) => `
你是 React Native/Expo 视频创作 app 的线上日志诊断助手。
请基于以下去重后的阿里云 SLS 诊断日志，输出：
1. 中文总览 summary
2. top bug clusters，按影响范围和严重程度排序
3. 每个 bug 的证据日志、可能根因、相关代码位置、下一步验证建议
4. 哪些日志还缺字段，后续应补什么

只基于给定日志判断，不要编造不存在的事实。

${JSON.stringify(
  {
    ...input,
    clusters: input.clusters.slice(0, 30),
  },
  null,
  2,
)}
`;

export const analyzeWithOptionalLlm = async (input: AnalysisInput) => {
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL ?? "gpt-4.1-mini";
  const localSummary = buildLocalSummary(input);

  if (!apiKey) {
    return `${localSummary}\n## LLM Analysis\n\nSkipped: set LLM_API_KEY or OPENAI_API_KEY to enable OpenAI-compatible analysis.\n`;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: buildLlmPrompt(input),
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `${localSummary}\n## LLM Analysis\n\nFailed: ${response.status} ${text.slice(0, 1000)}\n`;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "(empty LLM response)";
  return `${localSummary}\n## LLM Analysis\n\n${content}\n`;
};
