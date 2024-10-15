export const intToBitcoinHash = (int: bigint): string => {
  const base = BigInt(Math.pow(2, 64));
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 3; i++) {
    buf.writeBigUInt64LE(int % base, i * 8);
    int = int / base;
  }
  buf.writeBigUInt64LE(int, 24);
  return buf.toString("hex").padStart(64, "0");
};

export const bitcoinHashToInt = (hash: string): bigint => {
  return BigInt("0x" + Buffer.from(hash, "hex").reverse().toString("hex"));
};

export const bigIntToBuf = (bi: bigint, bytes?: number) => {
  let hex = bi.toString(16);
  hex = hex.replace(/^0x/, "");
  if (bytes && hex.length < bytes * 2) {
    hex = "0".repeat(bytes * 2 - hex.length) + hex;
  }
  return Buffer.from(hex, "hex");
};
