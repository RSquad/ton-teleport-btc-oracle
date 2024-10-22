import cron from "node-cron";
import { ConfigService } from "./base/config.service";
import { DkgService } from "./dkg/dkg.service";
import { KeystoreService } from "./keystore/keystore.service";
import { StrategyEnum } from "./keystore/strategies/strategy.enum";
import { SignService } from "./sign/sign.service";
import { TonService } from "./ton/ton.service";
import { ValidatorService } from "./ton/validator.service.ts";

enum CronExpression {
  EVERY_10_SECONDS = "*/10 * * * * *",
}

async function main() {
  const configService = new ConfigService();
  const tonService = new TonService(configService);

  const coordinatorStandaloneMode = await tonService.tcCoordinator.getStandaloneMode();
  const standaloneMode = +configService.getOrThrow("STANDALONE");
  if (coordinatorStandaloneMode !== standaloneMode) {
    throw Error(`Coordinator and oracle have different modes: ${coordinatorStandaloneMode} ${standaloneMode}`);
  }

  const secretRootDir = configService.getOrThrow<string>("KEYSTORE_DIR");
  const keyStore = new KeystoreService(StrategyEnum.FILE, secretRootDir);
  const validatorService = new ValidatorService(configService);
  const dkgService = new DkgService(
    configService,
    tonService,
    keyStore,
    validatorService,
  );
  const signService = new SignService(
    configService,
    dkgService,
    tonService,
    keyStore,
    validatorService,
  );
  await dkgService.init();
  await signService.init();

  cron.schedule(
    CronExpression.EVERY_10_SECONDS,
    async () => {
      await dkgService.executeDkg();
    },
    { name: "execute-dkg" },
  );

  cron.schedule(
    CronExpression.EVERY_10_SECONDS,
    async () => {
      await signService.executeSign();
    },
    { name: "execute-sign" },
  );
}

main();
