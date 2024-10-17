import { Address, TonClient } from "@ton/ton";
import type { OpenedContract } from "@ton/ton";
import { Logger } from "../base/logger.service";
import { ConfigService } from "../base/config.service";
import { DKGChannelContract } from "../contracts";

export class TonService {
  protected readonly logger = new Logger(TonService.name);

  configService: ConfigService;
  tonClient: TonClient;
  tcDkgChannel: OpenedContract<DKGChannelContract>;

  constructor(configService: ConfigService) {
    this.configService = configService;

    this.tonClient = new TonClient({
      endpoint:
        this.configService.getOrThrow<string>("TON_CENTER_V2_ENDPOINT") +
        "/jsonRPC",
      apiKey: this.configService.get<string | undefined>("TON_CENTER_API_KEY"),
    });

    this.tcDkgChannel = this.tonClient.open(
      DKGChannelContract.createFromAddress(
        Address.parse(this.configService.getOrThrow("COORDINATOR")),
      ),
    );
  }
}
