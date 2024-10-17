import { Cell } from "@ton/core";
import { type ISigner } from "./types";
import { type IValidatorEngineConsole } from "../ton/types";

export class ValidatorSigner implements ISigner {
  constructor(
    readonly validatorEngineConsole: IValidatorEngineConsole,
    public validatorPublicKey?: Buffer,
  ) {}

  async signCell(cell: Cell): Promise<Buffer> {
    const result = await this.validatorEngineConsole.sign(
      this.validatorPublicKey!.toString("hex"),
      cell.hash().toString("hex"),
    );

    return Buffer.from(result!);
  }

  set publicKey(pubkey: Buffer) {
    this.validatorPublicKey = pubkey;
  }
}
