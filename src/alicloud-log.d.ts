declare module "@alicloud/log" {
  export default class Client {
    constructor(config: {
      endpoint?: string;
      region?: string;
      net?: string;
      accessKeyId: string;
      accessKeySecret: string;
      securityToken?: string;
      use_https?: boolean;
      userAgent?: string;
    });

    getLogs(
      projectName: string,
      logstoreName: string,
      from: Date,
      to: Date,
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  }
}
