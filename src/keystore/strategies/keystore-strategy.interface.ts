export interface KeystoreStrategyInterface {
  store(key: string, secret: Buffer): boolean;
  load(key: string): Buffer | undefined;
  cleanup(): void;
  storeTemp(key: string, secret: Buffer): boolean;
  loadTemp(key: string): Buffer | undefined;
  loadTempArray(key: string): Buffer[] | undefined;
  storeTempArray(key: string, data: Buffer[]): void;
}
