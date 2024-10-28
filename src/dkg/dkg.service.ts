import { ConfigService } from "../base/config.service";
import { Logger } from "../base/logger.service";
import { CoordinatorContract, DkgState, type TDKG } from "../contracts";
import { KeystoreService } from "../keystore/keystore.service";
import { TonService } from "../ton/ton.service";
import type { OpenedContract } from "@ton/ton";
import { Address } from "@ton/core";
import type { ValidatorService } from "../ton/validator.service.ts";

const frost = require("frost.node");

type TDKGRound1Result = {
  secretPackagePtr: string;
  packageBuffer: Buffer;
};

type TDKGRound2Result = {
  secretPtr: string;
  round2Packages: {
    identifier: string;
    package: Buffer;
  }[];
};

type TDKGRound3Result = {
  keyPackage: Buffer;
  publicKeyPackage: Buffer;
  verifyingKey: Buffer;
};

export class DkgService {
  private readonly logger = new Logger(DkgService.name);
  private inProgress: boolean;
  private part1Result?: TDKGRound1Result;
  private part2Result?: TDKGRound2Result;
  private part3Result?: TDKGRound3Result;
  private configService: ConfigService;
  private tonService: TonService;
  private keyStore: KeystoreService;
  private tcCoordinator: OpenedContract<CoordinatorContract>;
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
    this.tcCoordinator = this.tonService.tonClient.open(
      CoordinatorContract.createFromAddress(
        Address.parse(this.configService.getOrThrow("COORDINATOR")),
      ),
    );
  }

  async init() {}

  private reset() {
    this.part1Result = undefined;
    this.part2Result = undefined;
    this.part3Result = undefined;
  }

  async executeDkg() {
    if (this.inProgress) {
      this.logger.log("DKG is in progress.");
      return;
    }
    this.inProgress = true;
    this.logger.log("DKG job started.");

    try {
      await this.tonService.tcCoordinator.sendStartDKG();
      this.reset();
    } catch (e) {
      this.logger.debug(e);
    }

    try {
      let dkg = await this.tonService.tcCoordinator.getDKG();
      if (!dkg) {
        this.logger.log("DKG not yet started.");
        return;
      }

      if (dkg!.state === DkgState.FINISHED) {
        this.logger.log("DKG finished. No need to execute.");
        return;
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
      (await this.executeR1(dkg, validatorIdx!, validatorPublicKey!)) &&
        (await this.executeR2(dkg, validatorIdx!, validatorPublicKey!)) &&
        (await this.executeR3(dkg, validatorIdx!, validatorPublicKey!));
    } catch (e: any) {
      this.logger.error(e);
    }
  }

  private async executeR3(
    dkg: TDKG,
    validatorIdx: number,
    identifier: string,
  ): Promise<boolean> {
    this.logger.log("Entering R3...");

    const dkgCompleted = dkg.state === DkgState.FINISHED;
    if (dkgCompleted) {
      this.logger.log("DKG completed.");
      return false;
    }

    const isR2Completed = dkg.state >= DkgState.PART2_FINISHED;
    if (!isR2Completed) {
      this.logger.log("R2 not yet completed, waiting for more packages.");
      return false;
    }

    const isPackageSent = dkg.r3Package.mask & (1n << BigInt(validatorIdx));
    const onchainPubkeyPackage = dkg.r3Package.pubkeyData?.pubkeyPackage;
    if (
      onchainPubkeyPackage == undefined ||
      this.loadSecretPackage(onchainPubkeyPackage) == undefined
    ) {
      // to generate secret package, r2 secret must be present.
      if (!this.part2Result) {
        throw new Error("R2 secret not found");
      }
      const r1Pkgs = this.tcCoordinator.r1Pkgs(dkg, identifier);
      const r2Pkgs = this.tcCoordinator.r2Pkgs(dkg, identifier);
      if (!this.part3Result) {
        this.logger.log(`Call Part3`);
        this.part3Result = frost.dkgPart3(
          this.part2Result.secretPtr,
          r1Pkgs,
          r2Pkgs,
        );
      }
      this.storeSecretPackage(
        this.part3Result!.publicKeyPackage,
        this.part3Result!.keyPackage,
      );
      this.logger.log(`Secret package saved.`);
    } else {
      if (!this.part3Result) {
        this.part3Result = {
          publicKeyPackage: onchainPubkeyPackage,
          keyPackage: this.loadSecretPackage(onchainPubkeyPackage)!,
          verifyingKey: (await frost.fromPublicKeyPackage(onchainPubkeyPackage))
            .verifyingKey,
        };
      }
    }

    if (this.part3Result && !isPackageSent) {
      await this.tcCoordinator.sendPubkeyPackage({
        identifier: Buffer.from(identifier, "hex"),
        validatorIdx,
        pubkeyPackage: this.part3Result.publicKeyPackage,
        internalKeyXY: this.part3Result.verifyingKey,
      });
      this.logger.log(`R3 package sent.`);
    }

    return false;
  }

  private async executeR2(
    dkg: TDKG,
    validatorIdx: number,
    identifier: string,
  ): Promise<boolean> {
    this.logger.log("Entering R2...");
    const isR1Completed =
      dkg.state >= DkgState.PART1_FINISHED || dkg.state === DkgState.FINISHED;
    if (!isR1Completed) {
      this.logger.log("R1 not yet completed, waiting for more packages.");
      return false;
    }

    const isR2Completed =
      dkg.state >= DkgState.PART2_FINISHED || dkg.state === DkgState.FINISHED;
    if (isR2Completed) {
      this.logger.log("R2 completed.");
      return true;
    }

    const r2Pkgs = dkg.r2Packages.packages;
    const r2Map = this.tcCoordinator.parseRound2Packages(r2Pkgs);
    r2Map.delete(identifier);

    let sentCount = 0;
    r2Map.forEach((pkg) => {
      if (pkg.has(identifier)) {
        sentCount += 1;
      }
    });
    if (sentCount >= dkg.maxSigners - 1) {
      this.logger.log(`R2 packages are sent.`);
      return false;
    }

    if (!this.part1Result) {
      throw new Error("R1 secret not found.");
    }

    this.logger.log(`Received R1 packages. Preparing for R2.`);

    if (!this.part2Result) {
      const r1Pkgs = await this.tcCoordinator.r1Pkgs(dkg, identifier);
      this.part2Result = frost.dkgPart2(
        this.part1Result!.secretPackagePtr,
        r1Pkgs,
      );
    }

    for (const pkg of this.part2Result!.round2Packages) {
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
    return false;
  }

  private async executeR1(
    dkg: TDKG,
    validatorIdx: number,
    identifier: string,
  ): Promise<boolean> {
    this.logger.log("Entering R1...");
    const isR1Completed =
      dkg.state >= DkgState.PART1_FINISHED || dkg.state === DkgState.FINISHED;
    if (isR1Completed) {
      this.logger.log("R1 already completed.");
      return true;
    }

    const identifierBuf = Buffer.from(identifier, "hex");
    if (dkg.r1Packages.packages.get(identifierBuf)) {
      this.logger.log(`R1 package already sent.`);
      return false;
    }

    this.logger.log("Starting DKG process with R1.");

    if (!this.part1Result) {
      const minSigners = Math.max(2, Math.floor((dkg.maxSigners * 2) / 3));
      this.part1Result = frost.dkgPart1(identifier, dkg.maxSigners, minSigners);
    }

    await this.tcCoordinator.sendRound1({
      validatorIdx: validatorIdx,
      identifier: Buffer.from(identifier, "hex"),
      round1Package: this.part1Result!.packageBuffer,
      lifetime: 30,
    });
    this.logger.log("R1 package sent.");
    return false;
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
}
