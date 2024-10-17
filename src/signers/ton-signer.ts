import { Cell } from "@ton/core";
import {
  type KeyPair,
  mnemonicNew,
  mnemonicToPrivateKey,
  sign,
} from "@ton/crypto";
import { type ISigner } from "./types";

export class TonSigner implements ISigner {
  constructor(readonly secretKey: string) {}

  async signCell(cell: Cell): Promise<Buffer> {
    return sign(cell.hash(), Buffer.from(this.secretKey, "hex"));
  }

  static async createFromMnemonic(mnemonic: string[], password?: string) {
    if (password) {
      return await mnemonicToPrivateKey(mnemonic, password);
    }
    return await mnemonicToPrivateKey(mnemonic);
  }

  static async generateRandomKeyPair(): Promise<KeyPair> {
    const mnemonic = await mnemonicNew(24);
    return await mnemonicToPrivateKey(mnemonic);
  }
}
