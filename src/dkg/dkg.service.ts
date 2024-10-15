import { ConfigService } from "../base/config.service";
import { Logger } from "../base/logger.service";
import { DkgState, type ISigner } from "../contracts";
import { TonSigner } from "../contracts/ton-signer";
import { KeystoreService } from "../keystore/keystore.service";
import { TonService } from "../ton/ton.service";
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
  private maxSigners: number;
  private minSigners: number;
  private dkgRound: DkgRound | undefined;
  private inProgress: boolean | undefined;
  private pubkey: string;
  private bufferPubKey: Buffer;
  private identifier: string;
  localPubkeyPackage?: Buffer;
  private r1Secret?: string;
  private r2Secret?: string;
  private dkgR1Res?: TDKGRound1Result;
  private dkgR2Res?: TDKGRound2Result;
  private signer: ISigner;
  private validatorIdx?: number;
  private configService: ConfigService;
  private tonService: TonService;
  private keyStore: KeystoreService;

  constructor(
    configService: ConfigService,
    tonService: TonService,
    keyStore: KeystoreService,
  ) {
    this.configService = configService;
    this.tonService = tonService;
    this.keyStore = keyStore;

    this.inProgress = false;
    this.maxSigners = +this.configService.getOrThrow<number>(
      "STANDALONE_MAX_SIGNERS",
    );
    this.minSigners = +this.configService.getOrThrow<number>(
      "STANDALONE_MIN_SIGNERS",
    );
    this.dkgRound = DkgRound.NOT_STARTED;
    this.pubkey = this.configService.getOrThrow<string>(
      "STANDALONE_VALIDATOR_PUBKEY",
    );
    this.signer = new TonSigner(
      this.configService.getOrThrow<string>("STANDALONE_VALIDATOR_SECRET"),
    );
    this.bufferPubKey = Buffer.from(this.pubkey, "hex");
    this.identifier = frost.deriveIdentifier(this.bufferPubKey);
  }

  async init() {
    await this.tonService.tcDkgChannel.connect(this.signer);
    const validatorIdx = await this.tonService.tcDkgChannel.getValidatorIdx({
      pubkey: this.pubkey,
    });
    if (validatorIdx !== undefined) {
      this.validatorIdx = validatorIdx;
    } else {
      throw new Error("ValidatorIdx is not defined");
    }
  }

  async executeDkg() {
    if (this.dkgRound === DkgRound.COMPLETED) {
      if (
        (await this.tonService.tcDkgChannel.getState()) === DkgState.FINISHED
      ) {
        this.logger.log("DKG finished. No need to execute.");
        return;
      }
      this.logger.log("Reinitializing DKG.");
      this.reset();
    }

    if (this.inProgress) {
      this.logger.log("DKG is in progress.");
      return;
    }
    this.inProgress = true;
    this.logger.log("DKG started.");

    try {
      switch (this.dkgRound) {
        case DkgRound.R2_COMPLETED:
          await this.executeR3();
          break;
        case DkgRound.R1_COMPLETED:
          await this.executeR2();
          break;
        default:
          await this.executeR1();
          break;
      }
    } catch (e) {
      this.logger.error(e);
    }
    this.inProgress = false;
  }

  private async executeR3() {
    this.logger.log("Entering R3...");

    if (!(await this.tonService.tcDkgChannel.getR2Completed())) {
      this.logger.log("R2 not yet completed, waiting for more packages...");
      return;
    }

    const onChainPubkeyPackage =
      await this.tonService.tcDkgChannel.getPubkeyPackage();
    let pubkeyPkg = onChainPubkeyPackage ?? this.localPubkeyPackage;
    if (!(pubkeyPkg && this.loadSecretPackage(pubkeyPkg))) {
      // to generate secret package, r2 secret must be present.
      if (!this.r2Secret) {
        throw new Error("R2 secret not found");
      }
      const r1Pkgs = await this.tonService.tcDkgChannel.getR1Pkgs({
        identifier: this.identifier!,
      });
      const r2Pkgs = await this.tonService.tcDkgChannel.getR2Pkgs({
        identifier: this.identifier!,
      });
      this.logger.log(`Part3 started`);
      const dkgR3Res = frost.dkgPart3(this.r2Secret, r1Pkgs, r2Pkgs);
      this.storeSecretPackage(dkgR3Res.publicKeyPackage, dkgR3Res.keyPackage);
      pubkeyPkg = dkgR3Res.publicKeyPackage;
      this.logger.log(`Secret package saved.`);
      this.logger.log(`Part3 completed.`);
    }

    // From the contract or generated locally.
    this.localPubkeyPackage = pubkeyPkg;

    if (!onChainPubkeyPackage && this.localPubkeyPackage) {
      const { verifyingKey }: { verifyingKey: Buffer } =
        await frost.fromPublicKeyPackage(this.localPubkeyPackage);
      const internalKeyXY = verifyingKey;
      await this.tonService.tcDkgChannel.sendPubkeyPackage({
        validatorIdx: this.validatorIdx!,
        pubkeyPackage: this.localPubkeyPackage!,
        internalKeyXY,
      });
    }

    if (
      onChainPubkeyPackage &&
      this.localPubkeyPackage &&
      this.keyStore.load(this.localPubkeyPackage.toString("hex"))
    ) {
      this.dkgRound = DkgRound.COMPLETED;
    }
  }

  private async executeR2() {
    this.logger.log("Entering R2...");

    if (!(await this.tonService.tcDkgChannel.getR1Completed())) {
      this.logger.log("R1 not yet completed, waiting for more packages...");
      return;
    }

    if (await this.tonService.tcDkgChannel.getR2Completed()) {
      this.logger.log("R2 completed.");
      this.dkgRound = DkgRound.R2_COMPLETED;
      return;
    }

    const r2Pkgs = await this.tonService.tcDkgChannel.getRound2Packages();

    if (r2Pkgs) {
      let sentCount = 0;
      const r2Map =
        await this.tonService.tcDkgChannel.parseRound2Packages(r2Pkgs);
      r2Map.delete(this.identifier);

      r2Map.forEach((pkg) => {
        if (pkg.has(this.identifier)) {
          sentCount += 1;
        }
      });
      if (sentCount >= this.maxSigners - 1) {
        this.logger.log(`R2 packages are sent.`);
        this.dkgRound = DkgRound.R2_COMPLETED;
        return;
      }
    }

    if (!this.r1Secret) {
      throw new Error("R1 secret not found.");
    }

    this.logger.log(`Received R1 packages. Preparing for R2.`);

    if (!this.r2Secret) {
      const r1Pkgs = await this.tonService.tcDkgChannel.getR1Pkgs({
        identifier: this.identifier,
      });
      this.dkgR2Res = frost.dkgPart2(this.r1Secret, r1Pkgs);
    }

    this.r2Secret = this.dkgR2Res!.secretPtr;
    const bufferSecret = Buffer.from(this.r2Secret, "hex");
    this.keyStore.storeTemp(this.bufferPubKey.toString("hex"), bufferSecret);

    for (const pkg of this.dkgR2Res!.round2Packages) {
      try {
        this.logger.log(`Sending R2 package to ${pkg.identifier}`);
        await this.tonService.tcDkgChannel.sendRound2({
          validatorIdx: this.validatorIdx!,
          fromIdentifier: Buffer.from(this.identifier, "hex"),
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

  private async executeR1() {
    const r1Pkgs = await this.tonService.tcDkgChannel.getRound1Packages();

    if (
      r1Pkgs &&
      !!(await this.tonService.tcDkgChannel.parseRound1Packages(r1Pkgs)).get(
        <string>this.identifier,
      )
    ) {
      this.logger.log(`R1 package sent. DKG R1 initiated.`);
      this.dkgRound = DkgRound.R1_COMPLETED;
      return;
    }

    this.logger.log("Starting DKG process with R1.");

    if (!this.dkgR1Res) {
      this.dkgR1Res = frost.dkgPart1(
        this.identifier,
        this.maxSigners,
        this.minSigners,
      );
    }

    this.r1Secret = this.dkgR1Res!.secretPackagePtr;
    const bufferSecret = Buffer.from(this.r1Secret, "hex");
    this.keyStore.storeTemp(
      this.dkgR1Res!.packageBuffer.toString("hex"),
      bufferSecret,
    );

    await this.tonService.tcDkgChannel.sendRound1({
      validatorIdx: this.validatorIdx!,
      identifier: Buffer.from(this.identifier, "hex"),
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
      return this.keyStore.load(publicKeyPackage.toString("hex"));
    } catch (e) {
      this.logger.error(`Failed to load secret.`);
      return undefined;
    }
  }

  private storeSecretPackage(publicKeyPackage: Buffer, secretPackage: Buffer) {
    this.keyStore.store(publicKeyPackage.toString("hex"), secretPackage);
  }

  public isDkgCompleted() {
    return this.dkgRound === DkgRound.COMPLETED;
  }

  public async sign(signingPackage: Buffer, signingNonce: Buffer) {
    return await frost.sign(
      signingPackage,
      signingNonce,
      this.keyStore.load(this.localPubkeyPackage!.toString("hex")),
    );
  }

  public async commit(): Promise<{ nonce: Buffer; commitments: Buffer }> {
    const key = this.localPubkeyPackage!.toString("hex");
    const result = await frost.commit(this.keyStore.load(key));
    return {
      nonce: result.signingNonce,
      commitments: result.signingCommitments,
    };
  }

  public async getCommitsMap(pegoutTxId: number) {
    return this.tonService.tcDkgChannel.getCommitsMap({
      pegoutTxId: pegoutTxId,
    });
  }

  public async sendCommitments(
    opts: Parameters<typeof this.tonService.tcDkgChannel.sendCommitments>[0],
  ) {
    return this.tonService.tcDkgChannel.sendCommitments(opts);
  }

  public async sendSigningShare(
    opts: Parameters<typeof this.tonService.tcDkgChannel.sendSigningShare>[0],
  ) {
    return this.tonService.tcDkgChannel.sendSigningShare(opts);
  }

  public async sendSignatures(
    opts: Parameters<typeof this.tonService.tcDkgChannel.sendSignatures>[0],
  ) {
    return this.tonService.tcDkgChannel.sendSignatures(opts);
  }
}
