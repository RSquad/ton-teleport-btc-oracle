import { ConfigService } from "src/base/config.service";
import { type TDKG } from "src/contracts";
import { type ISigner, TonSigner, ValidatorSigner } from "src/signers";
import { ValidatorEngineConsoleService } from "./validator-engine-console.service";

export type TValidatorKey = {
  validatorIdx: number;
  validatorKey: Buffer;
  validatorId: Buffer;
};
export class ValidatorService {
  private validatorConsole?: ValidatorEngineConsoleService;
  private standaloneMode: boolean;
  private standalonePublicKey?: string;
  private standaloneSecretKey?: string;

  constructor(readonly configService: ConfigService) {
    const mode = this.configService.get<string>("STANDALONE");
    this.standaloneMode = mode ? mode === "1" : false;
    if (this.standaloneMode) {
      this.standalonePublicKey = this.configService.getOrThrow<string>(
        "STANDALONE_VALIDATOR_PUBKEY",
      );
      this.standaloneSecretKey = this.configService.getOrThrow<string>(
        "STANDALONE_VALIDATOR_SECRET",
      );
    } else {
      this.validatorConsole = new ValidatorEngineConsoleService(
        this.configService.getOrThrow<string>("VALIDATOR_ENGINE_CONSOLE_PATH"),
        this.configService.getOrThrow<string>("SERVER_PUBLIC_KEY_PATH"),
        this.configService.getOrThrow<string>("CLIENT_PRIVATE_KEY_PATH"),
        this.configService.getOrThrow<string>("VALIDATOR_SERVER_ADDRESS"),
      );
    }
  }

  async getValidatorKey(dkg: TDKG): Promise<TValidatorKey | undefined> {
    let validatorIdx: number | undefined = undefined;
    let validatorKey: Buffer | undefined = undefined;
    let validatorId: Buffer | undefined = undefined;

    if (this.standaloneMode) {
      const index = dkg.vset.values().findIndex((publicKey) => {
        return this.standalonePublicKey == publicKey.toString("hex");
      });
      validatorIdx = index >= 0 ? dkg.vset.keys()[index] : undefined;
      validatorKey = Buffer.from(this.standalonePublicKey!, "hex");
      validatorId = validatorKey;
    } else {
      const validatorKeys = await this.validatorConsole!.getValidatorKeys();
      validatorKey = dkg.vset.values().find((vsetKey, i) => {
        const found = validatorKeys.validatorKeys.includes(
          vsetKey.toString("hex"),
        );
        if (found) {
          validatorIdx = dkg.vset.keys()[i];
          validatorId = Buffer.from(validatorKeys.validatorIds[i], "hex");
        }
        return found;
      });
    }

    if (!validatorKey) {
      return undefined;
    }
    return {
      validatorIdx: validatorIdx!,
      validatorKey: validatorKey!,
      validatorId: validatorId!,
    };
  }

  getSigner(validatorKey: Buffer): ISigner {
    if (this.standaloneMode) {
      return new TonSigner(this.standaloneSecretKey!);
    } else {
      return new ValidatorSigner(this.validatorConsole!, validatorKey);
    }
  }
}
