import type { KeystoreStrategyInterface } from "./strategies/keystore-strategy.interface";
import { StrategyEnum } from "./strategies/strategy.enum";
import { StrategyFabric } from "./strategies/strategy.fabric";

export class KeystoreService {
  strategy: KeystoreStrategyInterface;

  constructor(strategy: StrategyEnum, dirname: string) {
    const fabric = new StrategyFabric(dirname);
    this.strategy = fabric.getStrategy(strategy);
  }

  store(key: string, secret: Buffer): boolean {
    return this.strategy.store(key, secret);
  }

  load(key: string): Buffer | undefined {
    return this.strategy.load(key);
  }

  cleanup() {
    this.strategy.cleanup();
  }

  storeTemp(key: string, secret: Buffer): boolean {
    return <boolean>this.strategy.storeTemp(key, secret);
  }

  loadTemp(key: string): Buffer | undefined {
    return this.strategy.loadTemp(key);
  }

  loadTempArray(key: string): Buffer[] | undefined {
    return this.strategy.loadTempArray(key);
  }
  storeTempArray(key: string, data: Buffer[]) {
    return this.strategy.storeTempArray(key, data);
  }
}
