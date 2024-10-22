import { ConfigService } from "../base/config.service";
import { Logger } from "../base/logger.service";
import { DKGChannelContract, DkgState, type TDKG } from "../contracts";
import { KeystoreService } from "../keystore/keystore.service";
import { TonService } from "../ton/ton.service";
import type { OpenedContract } from "@ton/ton";
import { Address } from "@ton/core";
import type { ValidatorService } from "../ton/validator.service.ts";

const frost = require("frost.node");

enum DkgRound {
  NOT_STARTED,
  R1_COMPLETED,
  R2_COMPLETED,
  COMPLETED,
}

export type TDKGRound1Result = {
  secretPackagePtr: string;
  packageBuffer: Buffer;
};

export type TDKGRound2Result = {
  secretPtr: string;
  round2Packages: {
    identifier: string;
    package: Buffer;
  }[];
};

export class DkgService {
  private readonly logger = new Logger(DkgService.name);
  private dkgRound: DkgRound;
  private inProgress: boolean;
  private r1Secret?: string;
  private r2Secret?: string;
  private dkgR1Res?: TDKGRound1Result;
  private dkgR2Res?: TDKGRound2Result;
  private configService: ConfigService;
  private tonService: TonService;
  private keyStore: KeystoreService;
  private tcCoordinator: OpenedContract<DKGChannelContract>;
  private validatorService: ValidatorService;

  constructor(
    configService: ConfigService,
    tonService: TonService,
    keyStore: KeystoreService,
    validatorService: ValidatorService,
  ) {
    this.configService = configService;
    this.tonService = tonService;
    this.keyStore = keyStore;
    this.validatorService = validatorService;

    this.inProgress = false;
    this.dkgRound = DkgRound.NOT_STARTED;
    this.tcCoordinator = this.tonService.tonClient.open(
      DKGChannelContract.createFromAddress(
        Address.parse(this.configService.getOrThrow("COORDINATOR")),
      ),
    );
  }

  async init() {}

  async executeDkg() {
    if (this.inProgress) {
      this.logger.log("DKG is in progress.");
      return;
    }
    this.inProgress = true;
    this.logger.log("DKG job started.");

    try {
      await this.tonService.tcDkgChannel.sendStartDKG();
    } catch (e) {
      this.logger.debug(e);
    }

    try {
      let dkg = await this.tonService.tcDkgChannel.getDKG();
      if (!dkg) {
        this.logger.log("DKG not yet started.");
        return;
      }

      if (this.dkgRound === DkgRound.COMPLETED) {
        if (dkg!.state === DkgState.FINISHED) {
          this.logger.log("DKG finished. No need to execute.");
          return;
        }
        this.reset();
      }

      await this.execute(dkg);
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.inProgress = false;
      this.logger.log("DKG job completed.");
    }
  }

  async execute(dkg: TDKG) {
    const key = await this.validatorService.getValidatorKey(dkg);
    if (!key) {
      this.logger.warn(
        "Oracle is not a future valdiator. Cannot participate in DKG.",
      );
      return;
    }

    await this.tcCoordinator.connect(
      this.validatorService.getSigner(key!.validatorId),
    );

    const validatorIdx = key!.validatorIdx;
    const validatorPublicKey = key!.validatorKey.toString("hex");
    try {
      switch (this.dkgRound) {
        case DkgRound.R2_COMPLETED:
          await this.executeR3(dkg, validatorIdx!, validatorPublicKey!);
          break;
        case DkgRound.R1_COMPLETED:
          await this.executeR2(dkg, validatorIdx!, validatorPublicKey!);
          break;
        default:
          await this.executeR1(dkg, validatorIdx!, validatorPublicKey!);
          break;
      }
    } catch (e) {
      this.logger.error(e);
    }
  }

  private async executeR3(dkg: TDKG, validatorIdx: number, identifier: string) {
    this.logger.log("Entering R3...");

    const isR2Completed =
      dkg.state >= DkgState.PART2_FINISHED || dkg.state === DkgState.FINISHED;
    if (!isR2Completed) {
      this.logger.log("R2 not yet completed, waiting for more packages...");
      return;
    }

    const onchainPubkeyPackage = dkg.pubkeyPackage;
    let pubkeyPkg = onchainPubkeyPackage;
    if (!(pubkeyPkg && this.loadSecretPackage(pubkeyPkg))) {
      // to generate secret package, r2 secret must be present.
      if (!this.r2Secret) {
        throw new Error("R2 secret not found");
      }
      const r1Pkgs = this.tcCoordinator.r1Pkgs(dkg, identifier);
      const r2Pkgs = this.tcCoordinator.r2Pkgs(dkg, identifier);
      this.logger.log(`Part3 started`);
      const dkgR3Res = frost.dkgPart3(this.r2Secret, r1Pkgs, r2Pkgs);
      this.storeSecretPackage(dkgR3Res.publicKeyPackage, dkgR3Res.keyPackage);
      pubkeyPkg = dkgR3Res.publicKeyPackage;
      this.logger.log(`Secret package saved.`);
      this.logger.log(`Part3 completed.`);
    }

    if (!onchainPubkeyPackage && pubkeyPkg) {
      const { verifyingKey }: { verifyingKey: Buffer } =
        await frost.fromPublicKeyPackage(pubkeyPkg);
      const internalKeyXY = verifyingKey;
      await this.tcCoordinator.sendPubkeyPackage({
        validatorIdx,
        pubkeyPackage: pubkeyPkg,
        internalKeyXY,
      });
    }

    if (
      onchainPubkeyPackage &&
      pubkeyPkg &&
      this.loadSecretPackage(pubkeyPkg)
    ) {
      this.dkgRound = DkgRound.COMPLETED;
    }
  }

  private async executeR2(dkg: TDKG, validatorIdx: number, identifier: string) {
    this.logger.log("Entering R2...");
    const isR1Completed =
      dkg.state >= DkgState.PART1_FINISHED || dkg.state === DkgState.FINISHED;
    if (!isR1Completed) {
      this.logger.log("R1 not yet completed, waiting for more packages.");
      return;
    }

    const isR2Completed =
      dkg.state >= DkgState.PART2_FINISHED || dkg.state === DkgState.FINISHED;
    if (isR2Completed) {
      this.logger.log("R2 completed.");
      this.dkgRound = DkgRound.R2_COMPLETED;
      return;
    }

    const r2Pkgs = dkg.r2Packages.packages;

    let sentCount = 0;
    const r2Map = this.tcCoordinator.parseRound2Packages(r2Pkgs);
    r2Map.delete(identifier);

    r2Map.forEach((pkg) => {
      if (pkg.has(identifier)) {
        sentCount += 1;
      }
    });
    if (sentCount >= dkg.maxSigners - 1) {
      this.logger.log(`R2 packages are sent.`);
      this.dkgRound = DkgRound.R2_COMPLETED;
      return;
    }

    if (!this.r1Secret) {
      throw new Error("R1 secret not found.");
    }

    this.logger.log(`Received R1 packages. Preparing for R2.`);

    if (!this.r2Secret) {
      const r1Pkgs = await this.tcCoordinator.r1Pkgs(dkg, identifier);
      this.dkgR2Res = frost.dkgPart2(this.r1Secret, r1Pkgs);
    }

    if (!this.dkgR2Res) {
      throw new Error("dkgR2Res is undefined");
    }

    this.r2Secret = this.dkgR2Res!.secretPtr;

    for (const pkg of this.dkgR2Res!.round2Packages) {
      try {
        this.logger.log(`Sending R2 package to ${pkg.identifier}`);
        await this.tcCoordinator.sendRound2({
          validatorIdx,
          fromIdentifier: Buffer.from(identifier, "hex"),
          toIdentifier: Buffer.from(pkg.identifier, "hex"),
          round2Package: pkg.package,
        });
      } catch (e) {
        this.logger.error(
          `Failed to send R2 package to ${pkg.identifier}: ${e}`,
        );
      }
    }
  }

  private async executeR1(dkg: TDKG, validatorIdx: number, identifier: string) {
    const r1Pkgs = dkg.r1Packages.packages;

    if (!!this.tcCoordinator.parseRound1Packages(r1Pkgs).get(identifier)) {
      this.logger.log(`R1 package sent. DKG R1 initiated.`);
      this.dkgRound = DkgRound.R1_COMPLETED;
      return;
    }

    this.logger.log("Starting DKG process with R1.");

    if (!this.dkgR1Res) {
      const minSigners = Math.floor((dkg.maxSigners * 2) / 3);
      this.dkgR1Res = frost.dkgPart1(identifier, dkg.maxSigners, minSigners);
    }

    this.r1Secret = this.dkgR1Res!.secretPackagePtr;

    await this.tcCoordinator.sendRound1({
      validatorIdx: validatorIdx,
      identifier: Buffer.from(identifier, "hex"),
      round1Package: this.dkgR1Res!.packageBuffer,
      lifetime: 30,
    });
  }

  private reset() {
    this.dkgRound = DkgRound.NOT_STARTED;
    this.dkgR1Res = undefined;
    this.dkgR2Res = undefined;
    this.r1Secret = "";
    this.r2Secret = "";
  }

  private loadSecretPackage(publicKeyPackage: Buffer): Buffer | undefined {
    if (!publicKeyPackage) return undefined;

    try {
      return this.keyStore.load(
        frost.getSchnorrPubkey(publicKeyPackage).toString("hex"),
      );
    } catch (e) {
      this.logger.error(`Failed to load secret.`);
      return undefined;
    }
  }

  private storeSecretPackage(publicKeyPackage: Buffer, secretPackage: Buffer) {
    this.keyStore.store(
      frost.getSchnorrPubkey(publicKeyPackage).toString("hex"),
      secretPackage,
    );
  }

  public isDkgCompleted() {
    return this.dkgRound === DkgRound.COMPLETED;
  }

  public async sign(
    publicKey: Buffer,
    signingPackage: Buffer,
    signingNonce: Buffer,
  ) {
    return await frost.sign(
      signingPackage,
      signingNonce,
      this.keyStore.load(publicKey.toString("hex")),
    );
  }

  public async commit(
    internalKey: Buffer,
  ): Promise<{ nonce: Buffer; commitments: Buffer }> {
    const key = internalKey.toString("hex");
    const result = await frost.commit(this.keyStore.load(key));
    return {
      nonce: result.signingNonce,
      commitments: result.signingCommitments,
    };
  }

  public async getCommitsMap(pegoutTxId: number) {
    return this.tcCoordinator.getCommitsMap({
      pegoutTxId: pegoutTxId,
    });
  }
}
