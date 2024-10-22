import pino, { type Level } from "pino";

export class Logger {
  logger;

  constructor(private context?: string) {
    if (context) {
      this.setContext(context);
    }

    this.logger = pino({
      transport: {
        targets: [
          {
            target: "pino-pretty",
            options: {
              colorize: true,
            },
          },
        ],
      },
    });
  }

  public setContext(context: string) {
    this.context = context;
  }

  verbose(message: any, ...optionalParams: any[]) {
    this.call("trace", message, ...optionalParams);
  }

  debug(message: any, ...optionalParams: any[]) {
    message = this.context ? `[${this.context}]: ${message}` : message;
    this.call("debug", message, ...optionalParams);
  }

  log(message: any, ...optionalParams: any[]) {
    message = this.context ? `[${this.context}]: ${message}` : message;
    this.call("info", message, ...optionalParams);
  }

  warn(message: any, ...optionalParams: any[]) {
    this.call("warn", message, ...optionalParams);
  }

  error(message: any, ...optionalParams: any[]) {
    this.call("error", message, ...optionalParams);
  }

  fatal(message: any, ...optionalParams: any[]) {
    this.call("fatal", message, ...optionalParams);
  }

  private call(level: Level, message: any, ...optionalParams: any[]) {
    const objArg: Record<string, any> = {};

    let params: any[] = [];
    if (optionalParams.length !== 0) {
      objArg[this.context || ""] = optionalParams[optionalParams.length - 1];
      params = optionalParams.slice(0, -1);
    }

    if (typeof message === "object") {
      if (message instanceof Error) {
        objArg["err"] = message;
      } else {
        Object.assign(objArg, message);
      }
      this.logger[level](objArg, ...params);
    } else if (this.isWrongExceptionsHandlerContract(level, message, params)) {
      objArg["err"] = new Error(message);
      objArg["err"].stack = params[0];
      this.logger[level](objArg);
    } else {
      this.logger[level](objArg, message, ...params);
    }
  }

  private isWrongExceptionsHandlerContract(
    level: Level,
    message: any,
    params: any[],
  ): params is [string] {
    return (
      level === "error" &&
      typeof message === "string" &&
      params.length === 1 &&
      typeof params[0] === "string" &&
      /\n\s*at /.test(params[0])
    );
  }
}
