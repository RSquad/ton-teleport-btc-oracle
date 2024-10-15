import dotenv from "dotenv";

dotenv.config();

export class ConfigService {
  get<T = string>(key: string): T | undefined {
    return process.env[key as string]
      ? (process.env[key as string] as T)
      : undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(
        `Configuration key "${key as string}" is not defined in the .env file`,
      );
    }
    return value;
  }
}
