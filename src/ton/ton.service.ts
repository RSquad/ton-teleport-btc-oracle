import { Address, TonClient } from "@ton/ton";
import type { OpenedContract } from "@ton/ton";
import { Logger } from "../base/logger.service";
import { ConfigService } from "../base/config.service";
import { DKGChannelContract, TeleportContract } from "../contracts";

export class TonService {
  protected readonly logger = new Logger(TonService.name);

  configService: ConfigService;

  tonCenterApiKey: string;

  tonClient: TonClient;

  tcDkgChannel: OpenedContract<DKGChannelContract>;
  tcTeleport: OpenedContract<TeleportContract>;

  constructor(configService: ConfigService) {
    this.configService = configService;
    this.tonCenterApiKey = this.configService.getOrThrow<string>(
      "COMMON_TON_CENTER_API_KEY",
    );

    this.tonClient = new TonClient({
      endpoint: this.configService.getOrThrow<string>(
        "COMMON_TON_CENTER_ENDPOINT",
      ),
      apiKey: this.tonCenterApiKey,
    });

    this.tcDkgChannel = this.tonClient.open(
      DKGChannelContract.createFromAddress(
        Address.parse(
          this.configService.getOrThrow("COMMON_TON_CONTRACT_DKG_CHANNEL"),
        ),
      ),
    );

    this.tcTeleport = this.tonClient.open(
      TeleportContract.createFromAddress(
        Address.parse(
          this.configService.getOrThrow("COMMON_TON_CONTRACT_TELEPORT_ADDR"),
        ),
      ),
    );
  }
}
