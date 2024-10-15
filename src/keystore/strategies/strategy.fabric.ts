import { FileStrategy } from "./file.strategy";
import type { KeystoreStrategyInterface } from "./keystore-strategy.interface";
import { StrategyEnum } from "./strategy.enum";

export class StrategyFabric {
  protected readonly strategies = new Map<
    StrategyEnum,
    KeystoreStrategyInterface
  >();
  constructor(dirname: string) {
    this.strategies.set(StrategyEnum.FILE, new FileStrategy(dirname));
  }

  getStrategy(strategy: StrategyEnum): KeystoreStrategyInterface {
    const findStrategy = this.strategies.get(strategy);
    if (findStrategy) {
      return findStrategy;
    } else {
      throw new Error(`Strategy ${strategy} not found`);
    }
  }
}
