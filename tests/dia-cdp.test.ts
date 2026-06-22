import { describe, expect, test } from "bun:test";

import {
  buildConsoleAuthFromCdpRequest,
  selectSlsTarget,
  type CdpRequestSnapshot,
  type CdpTarget,
} from "../src/dia-cdp";

describe("Dia CDP cookie import", () => {
  test("extracts console auth from a captured SLS request", () => {
    const request: CdpRequestSnapshot = {
      url: "https://sls.console.aliyun.com/console/getConfigData.json",
      headers: {
        Cookie: "login_aliyunid_ticket=secret; aliyun_country=CN",
        "x-csrf-token": "csrf-secret",
        Referer:
          "https://sls.console.aliyun.com/lognext/project/prod-project/logsearch/hugo-api?slsRegion=cn-shenzhen",
        "User-Agent": "Dia/1.34.2",
      },
    };

    expect(buildConsoleAuthFromCdpRequest("single", request)).toEqual({
      env: "single",
      cookie: "login_aliyunid_ticket=secret; aliyun_country=CN",
      csrfToken: "csrf-secret",
      referer:
        "https://sls.console.aliyun.com/lognext/project/prod-project/logsearch/hugo-api?slsRegion=cn-shenzhen",
      userAgent: "Dia/1.34.2",
      consoleBaseUrl: "https://sls.console.aliyun.com",
      projectName: undefined,
      logstoreName: undefined,
      importedAt: expect.any(String),
      source: "dia-cdp",
    });
  });

  test("prefers the production project tab", () => {
    const targets: CdpTarget[] = [
      {
        id: "alpha",
        type: "page",
        title: "SLS alpha",
        url: "https://sls.console.aliyun.com/lognext/project/alpha-project/logsearch/hugo-alpha-api",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/alpha",
      },
      {
        id: "production",
        type: "page",
        title: "SLS production",
        url: "https://sls.console.aliyun.com/lognext/project/prod-project/logsearch/hugo-api",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/production",
      },
    ];

    expect(selectSlsTarget(targets, "prod-project")?.id).toBe("production");
  });

  test("prefers an existing profile tab over project tabs", () => {
    const targets: CdpTarget[] = [
      {
        id: "production",
        type: "page",
        title: "SLS production",
        url: "https://sls.console.aliyun.com/lognext/project/prod-project/logsearch/hugo-api",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/production",
      },
      {
        id: "profile",
        type: "page",
        title: "SLS profile",
        url: "https://sls.console.aliyun.com/lognext/profile",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/profile",
      },
    ];

    expect(selectSlsTarget(targets, "prod-project")?.id).toBe("profile");
  });
});
