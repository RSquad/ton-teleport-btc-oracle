import { Dictionary } from "@ton/core";
import { ConfigService } from "../base/config.service";
import { Logger } from "../base/logger.service";
import { PegoutTxContract } from "../contracts";
import type { TPegoutRecord } from "../contracts";
import { DkgService } from "../dkg/dkg.service";
import { KeystoreService } from "../keystore/keystore.service";
import { TonService } from "../ton/ton.service";
const frost = require("frost.node");

export class SignService {
  private readonly logger = new Logger(SignService.name);
  private identifier: Buffer;
  private inProgress: boolean;
  private minSigners: number;
  private pubkey: string;
  private tonService: TonService;
  private dkgService: DkgService;
  private configService: ConfigService;
  private keyStore: KeystoreService;

  constructor(
    configService: ConfigService,
    dkgService: DkgService,
    tonService: TonService,
    keyStore: KeystoreService,
  ) {
    this.tonService = tonService;
    this.configService = configService;
    this.dkgService = dkgService;
    this.keyStore = keyStore;

    this.inProgress = false;
    this.minSigners = +this.configService.getOrThrow<number>(
      "STANDALONE_MIN_SIGNERS",
    );
    this.pubkey = this.configService.getOrThrow<string>(
      "STANDALONE_VALIDATOR_PUBKEY",
    );
    this.identifier = Buffer.from(
      frost.deriveIdentifier(Buffer.from(this.pubkey, "hex")),
      "hex",
    );
  }

  async init() {}

  async executeSign() {
    if (!this.dkgService.isDkgCompleted()) {
      this.logger.warn("DKG is not completed yet.");
      return;
    }
    if (this.inProgress) {
      this.logger.warn("Job is in progress.");
      return;
    }
    try {
      this.inProgress = true;
      this.logger.log("Cron Job started.");
      await this.execute();
    } finally {
      this.logger.log("Cron Job completed.");
      this.inProgress = false;
    }
  }
  private async execute() {
    const pegoutRecords =
      await this.tonService.tcDkgChannel.getUnsignedPegouts();
    if (!pegoutRecords?.size) {
      this.logger.log("No sign requests.");
      return;
    }

    this.logger.log(`${pegoutRecords.size} signing requests.`);

    const pegoutTxId = pegoutRecords.keys()[0];
    const pegoutTx: TPegoutRecord = pegoutRecords.get(pegoutTxId)!;
    this.logger.log(pegoutTxId);
    this.logger.log(pegoutTx.pegoutAddress.toRawString());

    const validatorIdx = await this.tonService.tcDkgChannel.getValidatorIdx({
      pubkey: this.pubkey,
    });
    if (validatorIdx == undefined) {
      this.logger.error(
        `Oracle is not a validator and cannot participate in signing pegout ${pegoutTxId.toString(16)}`,
      );
      return;
    }

    try {
      (await this.doCommit(validatorIdx, pegoutTxId, pegoutTx)) &&
        (await this.doSign(validatorIdx, pegoutTxId, pegoutTx)) &&
        (await this.doAggregate(validatorIdx, pegoutTxId, pegoutTx));
    } catch (error: any) {
      this.logger.log(error?.response?.data || error, error?.stack);
    }
  }

  private async doCommit(
    validatorIdx: number,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
  ): Promise<boolean> {
    this.logger.log(`Commit pegout ${pegoutId.toString(16)}`);
    const pegoutAddressStr = pegoutRecord.pegoutAddress.toString();

    const isCommitSent = !!pegoutRecord.commitments.get(this.identifier);

    if (!isCommitSent) {
      let nonce = this.keyStore.loadTemp(`nonce_${pegoutAddressStr}`);

      let commitments = this.keyStore.loadTemp(
        `commitments_${pegoutAddressStr}`,
      );

      if (!nonce || !commitments) {
        if (!nonce && !commitments) {
          const commitResult = await this.dkgService.commit();
          nonce = commitResult.nonce;
          commitments = commitResult.commitments;
          this.keyStore.storeTemp(
            `nonce_${pegoutAddressStr}`,
            commitResult.nonce,
          );

          this.keyStore.storeTemp(
            `commitments_${pegoutAddressStr}`,
            commitResult.commitments,
          );
        } else {
          this.logger.error("Problem with saved nonce or commitments");
          this.logger.error(pegoutAddressStr);
          return false;
        }
      }

      await this.dkgService.sendCommitments({
        pegoutId,
        validatorIdx,
        identifier: this.identifier,
        commitments: commitments,
        lifetime: 30,
      });
      this.logger.log(`Commit sent for pegout ${pegoutId.toString(16)}`);
    } else {
      if (pegoutRecord.commitments.size >= this.minSigners) {
        this.logger.log(
          `Moving to signing phase for pegout ${pegoutId.toString(16)}`,
        );
        return true;
      }
    }
    return false;
  }

  private async doSign(
    validatorIdx: number,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
  ): Promise<boolean> {
    this.logger.log(`Sign pegout ${pegoutId.toString(16)}`);
    const pegoutAddressStr = pegoutRecord.pegoutAddress.toString();
    const isCommitSent = !!pegoutRecord.commitments.get(this.identifier);
    const pegoutTxContract = this.tonService.tonClient.open(
      PegoutTxContract.createFromAddress(pegoutRecord.pegoutAddress),
    );

    if (!isCommitSent) {
      this.logger.log(
        `Oracle didn't send commitment and cannot participate in signing for pegout ${pegoutId.toString(16)}`,
      );
      return false;
    }

    const commitsArr: { identifier: string; package: Buffer }[] = [];
    pegoutRecord.commitments.keys().forEach((key) => {
      commitsArr.push({
        identifier: key.toString("hex"),
        package: pegoutRecord.commitments.get(key)!,
      });
    });

    const signHashes = await pegoutTxContract.getSigningHashes();
    if (signHashes.length == 0) {
      this.logger.error(`NO signing hashes in pegout ${pegoutId.toString(16)}`);
      // for unknown reasons there is no signing hashes, just go to sleep
      // and try query signing hashes again later.
      return false;
    }

    const { inputs } = await pegoutTxContract.getTxParts();
    const inputTxids = inputs.keys().sort((a, b) => (a - b >= 0 ? 1 : -1));

    let signPkgs = this.keyStore.loadTempArray(`pkgs_${pegoutAddressStr}`);
    if (!signPkgs) {
      signPkgs = [];
      for (let i = 0; i < signHashes.length; i++) {
        const signPkg = await frost.createSigningPackage(
          commitsArr,
          signHashes[i],
          inputs.get(inputTxids[i])!.taprootMerkleRoot,
        );
        signPkgs.push(signPkg);
      }

      this.keyStore.storeTempArray(`pkgs_${pegoutAddressStr}`, signPkgs);
    }

    const shares = pegoutRecord.signingShares;
    const isShareSent = !!shares.get(this.identifier);
    if (!isShareSent) {
      let signShares = this.keyStore.loadTempArray(
        `shares_${pegoutAddressStr}`,
      );
      if (!signShares) {
        const nonce = this.keyStore.loadTemp(`nonce_${pegoutAddressStr}`);
        if (!nonce) {
          throw "Signing nonce is undefined.";
        }
        signShares = [];
        for (let i = 0; i < signHashes.length; i++) {
          const signShare = await this.dkgService.sign(signPkgs[i], nonce);
          signShares.push(signShare);
        }
        this.keyStore.storeTempArray(`shares_${pegoutAddressStr}`, signShares);
      }

      await this.dkgService.sendSigningShare({
        pegoutId,
        validatorIdx,
        identifier: this.identifier,
        signingShares: signShares,
        lifetime: 30,
      });
      this.logger.log(`Signing share sent for pegout${pegoutId.toString(16)}`);
    } else {
      if (shares.size >= this.minSigners) {
        this.logger.log(
          `Moving to aggregation phase for pegout${pegoutId.toString(16)}`,
        );
        return true;
      }
    }
    return false;
  }

  private async doAggregate(
    validatorIdx: number,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
  ): Promise<boolean> {
    this.logger.log(
      `Aggregate sign shares for pegout ${pegoutId.toString(16)}`,
    );
    const pegoutTxContract = this.tonService.tonClient.open(
      PegoutTxContract.createFromAddress(pegoutRecord.pegoutAddress),
    );

    const isSignatureExists = !!(await pegoutTxContract.getTxParts()).signatures
      .length;
    if (isSignatureExists) {
      this.logger.log("Completed. Signature already exists.");
      return true;
    }

    const sharesArr: {
      identifier: string;
      package: Buffer;
      index: string;
    }[] = [];

    for (const [key, shares] of pegoutRecord.signingShares) {
      const sharesDict = shares
        .beginParse()
        .loadDictDirect(Dictionary.Keys.Buffer(8), PegoutTxContract.RefValue);

      for (const [index, share] of sharesDict) {
        sharesArr.push({
          identifier: key.toString("hex"),
          package: share,
          index: index.toString("hex"),
        });
      }
    }
    const localPubkeyPackage = this.dkgService.localPubkeyPackage;
    const signatures: Buffer[] = [];
    let signPkgs = this.keyStore.loadTempArray(
      `pkgs_${pegoutRecord.pegoutAddress.toString()}`,
    );
    if (!signPkgs) {
      this.logger.error("Signing packages array is empty");
      return false;
    }
    for (let i = 0; i < signPkgs.length; i++) {
      const signPkg = signPkgs[i];
      const signature = await frost.aggregate(
        signPkg,
        sharesArr.filter((share) => +("0x" + share.index) === i),
        localPubkeyPackage,
      );
      signatures.push(signature);
    }

    await this.tonService.tcDkgChannel.sendSignatures({
      pegoutId,
      validatorIdx,
      identifier: this.identifier,
      signatures,
      lifetime: 30,
    });
    this.logger.log(`Signature sent for pegout ${pegoutId.toString(16)}`);
    return true;
  }
}
