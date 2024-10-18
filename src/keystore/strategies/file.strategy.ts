import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../base/logger.service";
import type { KeystoreStrategyInterface } from "./keystore-strategy.interface.ts";

export class FileStrategy implements KeystoreStrategyInterface {
  protected logger = new Logger(FileStrategy.name);

  private DIR_NAME: string;
  private dir: string;
  private storageDir: string;
  private tempDir: string;

  private storageCache: Map<string, Buffer> = new Map();
  private tempCache: Map<string, Buffer> = new Map();

  constructor(dirname: string) {
    this.DIR_NAME = path.join(dirname, "keystores");
    this.dir = path.resolve(__dirname, this.DIR_NAME);
    this.storageDir = path.resolve(__dirname, this.DIR_NAME + "/storage");
    this.tempDir = path.resolve(__dirname, this.DIR_NAME + "/temp");

    this.logger.log("SET DIR_NAME:", this.DIR_NAME);
    this.logger.log("SET dir:", this.dir);
    this.logger.log("SET storageDir:", this.storageDir);
    this.logger.log("SET tempDir:", this.tempDir);

    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private _getFileNameByKey(key: string): string {
    return key.substring(0, 64);
  }

  private _store(
    key: string,
    secret: Buffer,
    dir: string,
    cache: Map<string, Buffer>,
  ) {
    try {
      if (!key || key.length === 0) {
        throw new Error("Invalid public key provided.");
      }

      const filename = this._getFileNameByKey(key);
      const filepath = path.join(dir, filename);

      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        if (stats.isDirectory()) {
          throw new Error(`Filepath is a directory: ${filepath}`);
        }
      }

      fs.writeFileSync(filepath, secret as any, { flag: "w+" });
      cache.set(filename, secret);

      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  private _storeArray(key: string, data: Buffer[], dir: string) {
    try {
      if (!key || key.length === 0) {
        throw new Error("Invalid public key provided.");
      }

      const filename = this._getFileNameByKey(key);
      const filepath = path.join(dir, filename);

      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        if (stats.isDirectory()) {
          throw new Error(`Filepath is a directory: ${filepath}`);
        }
      }

      const fileStream = fs.createWriteStream(filepath);

      for (let i = 0; i < data.length; i++) {
        fileStream.write(data[i].toString("hex") + "\n");
      }

      fileStream.end();
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
  }

  private _loadArray(key: string, dir: string): Buffer[] | undefined {
    const filename = this._getFileNameByKey(key);
    const filepath = path.join(dir, filename);

    if (fs.existsSync(filepath)) {
      return fs
        .readFileSync(filepath)
        .toString()
        .split("\n")
        .filter((elem) => elem.length)
        .map((elem) => Buffer.from(elem, "hex"));
    }
    return undefined;
  }

  private _load(
    key: string,
    dir: string,
    cache: Map<string, Buffer>,
  ): Buffer | undefined {
    const filename = this._getFileNameByKey(key);
    const filepath = path.join(dir, filename);

    if (cache.has(filename)) {
      return cache.get(filename)!;
    }

    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath);
    }
    return undefined;
  }

  load(key: string): Buffer | undefined {
    return this._load(key, this.storageDir, this.storageCache);
  }

  store(key: string, secretPackage: Buffer): boolean {
    return this._store(key, secretPackage, this.storageDir, this.storageCache);
  }

  loadTempArray(key: string): Buffer[] | undefined {
    return this._loadArray(key, this.tempDir);
  }

  storeTempArray(key: string, data: Buffer[]) {
    return this._storeArray(key, data, this.tempDir);
  }

  cleanup(): void {
    this._clearTempDir();
    this._clearCaches();
  }

  private _clearTempDir() {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.tempDir, file));
      }
      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  loadTemp(key: string): Buffer | undefined {
    return this._load(key, this.tempDir, this.tempCache);
  }

  storeTemp(key: string, secretPackage: Buffer): boolean {
    return this._store(key, secretPackage, this.tempDir, this.tempCache);
  }

  private _clearCache(cache: Map<string, Buffer>): void {
    cache.clear();
  }

  private _clearCaches(): void {
    this._clearCache(this.storageCache);
    this._clearCache(this.tempCache);
  }
}
