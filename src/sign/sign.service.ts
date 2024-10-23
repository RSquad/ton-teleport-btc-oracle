import { Address, Dictionary } from "@ton/core";
import { ConfigService } from "../base/config.service";
import { Logger } from "../base/logger.service";
import { CoordinatorContract, DkgState, PegoutTxContract, type TDKG } from "../contracts";
import type { TPegoutRecord } from "../contracts";
import { DkgService } from "../dkg/dkg.service";
import { KeystoreService } from "../keystore/keystore.service";
import { TonService } from "../ton/ton.service";
import type { OpenedContract } from "@ton/ton";
import type {
  TValidatorKey,
  ValidatorService,
} from "../ton/validator.service.ts";
const frost = require("frost.node");

export class SignService {
  private readonly logger = new Logger(SignService.name);
  private inProgress: boolean;
  private tonService: TonService;
  private dkgService: DkgService;
  private configService: ConfigService;
  private keyStore: KeystoreService;
  private tcCoordinator: OpenedContract<CoordinatorContract>;
  private validatorService: ValidatorService;

  constructor(
    configService: ConfigService,
    dkgService: DkgService,
    tonService: TonService,
    keyStore: KeystoreService,
    validatorService: ValidatorService,
  ) {
    this.tonService = tonService;
    this.configService = configService;
    this.dkgService = dkgService;
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

  async executeSign() {
    if (this.inProgress) {
      this.logger.warn("Job is in progress.");
      return;
    }
    try {
      this.inProgress = true;
      this.logger.log("Cron Job started.");

      let dkg = await this.tonService.tcCoordinator.getPrevDKG();
      if (!dkg) {
        this.logger.log("DKG not yet completed.");
        return;
      }

      await this.execute(dkg);
    } finally {
      this.logger.log("Cron Job completed.");
      this.inProgress = false;
    }
  }
  private async execute(dkg: TDKG) {
    const pegoutRecords = await this.tcCoordinator.getUnsignedPegouts();
    if (!pegoutRecords?.size) {
      this.logger.log("No sign requests.");
      return;
    }

    this.logger.log(`${pegoutRecords.size} signing requests.`);

    const pegoutTxId = pegoutRecords.keys()[0];
    const pegoutTx: TPegoutRecord = pegoutRecords.get(pegoutTxId)!;
    this.logger.log(pegoutTxId);
    this.logger.log(pegoutTx.pegoutAddress);

    const valKey = await this.validatorService.getValidatorKey(dkg);
    if (!valKey) {
      this.logger.warn(
        `Oracle is not a validator. Cannot participate in signing pegout ${pegoutTxId.toString(16)}`,
      );
      return;
    }

    await this.tcCoordinator.connect(
      this.validatorService.getSigner(valKey.validatorId),
    );

    const minSigners = Math.floor((dkg.maxSigners * 2) / 3);
    try {
      (await this.doCommit(valKey, pegoutTxId, pegoutTx, minSigners)) &&
        (await this.doSign(valKey, pegoutTxId, pegoutTx, minSigners)) &&
        (await this.doAggregate(valKey, pegoutTxId, pegoutTx));
    } catch (error: any) {
      this.logger.log(error?.response?.data || error, error?.stack);
    }
  }

  private async doCommit(
    validatorKey: TValidatorKey,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
    minSigners: number,
  ): Promise<boolean> {
    this.logger.log(`Commit pegout ${pegoutId.toString(16)}`);
    const identifier = validatorKey.validatorKey;

    const pegoutAddressStr = pegoutRecord.pegoutAddress.toString();

    const isCommitSent = !!pegoutRecord.commitments.get(identifier);

    const pegoutTxContract = this.tonService.tonClient.open(
      PegoutTxContract.createFromAddress(pegoutRecord.pegoutAddress),
    );
    const { internalKey } = await pegoutTxContract.getTxParts();

    if (!isCommitSent) {
      let nonce = this.keyStore.loadTemp(`nonce_${pegoutAddressStr}`);

      let commitments = this.keyStore.loadTemp(
        `commitments_${pegoutAddressStr}`,
      );

      if (!nonce || !commitments) {
        if (!nonce && !commitments) {
          const commitResult = await this.dkgService.commit(internalKey);
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

      await this.tcCoordinator.sendCommitments({
        pegoutId,
        validatorIdx: validatorKey.validatorIdx,
        identifier,
        commitments: commitments,
        lifetime: 30,
      });
      this.logger.log(`Commit sent for pegout ${pegoutId.toString(16)}`);
    } else {
      if (pegoutRecord.commitments.size >= minSigners) {
        this.logger.log(
          `Moving to signing phase for pegout ${pegoutId.toString(16)}`,
        );
        return true;
      }
    }
    return false;
  }

  private async doSign(
    validatorKey: TValidatorKey,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
    minSigners: number,
  ): Promise<boolean> {
    this.logger.log(`Sign pegout ${pegoutId.toString(16)}`);
    const identifier = validatorKey.validatorKey;

    const pegoutAddressStr = pegoutRecord.pegoutAddress.toString();
    const isCommitSent = !!pegoutRecord.commitments.get(identifier);
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

    const { inputs, internalKey } = await pegoutTxContract.getTxParts();
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
    const isShareSent = !!shares.get(identifier);
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
          const signShare = await this.dkgService.sign(
            internalKey,
            signPkgs[i],
            nonce,
          );
          signShares.push(signShare);
        }
        this.keyStore.storeTempArray(`shares_${pegoutAddressStr}`, signShares);
      }

      await this.tcCoordinator.sendSigningShare({
        pegoutId,
        validatorIdx: validatorKey.validatorIdx,
        identifier,
        signingShares: signShares,
        lifetime: 30,
      });
      this.logger.log(`Signing share sent for pegout ${pegoutId.toString(16)}`);
    } else {
      if (shares.size >= minSigners) {
        this.logger.log(
          `Moving to aggregation phase for pegout ${pegoutId.toString(16)}`,
        );
        return true;
      }
    }
    return false;
  }

  private async doAggregate(
    validatorKey: TValidatorKey,
    pegoutId: number,
    pegoutRecord: TPegoutRecord,
  ): Promise<boolean> {
    this.logger.log(
      `Aggregate sign shares for pegout ${pegoutId.toString(16)}`,
    );
    const identifier = validatorKey.validatorKey;

    const pegoutTxContract = this.tonService.tonClient.open(
      PegoutTxContract.createFromAddress(pegoutRecord.pegoutAddress),
    );

    const { signatures: pegoutSignatures } =
      await pegoutTxContract.getTxParts();
    const pubkeyPackage = await this.tcCoordinator.getPubkeyPackage({identifier});
    const isSignatureExists = !!pegoutSignatures.length;
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
        pubkeyPackage,
      );
      signatures.push(signature);
    }

    await this.tcCoordinator.sendSignatures({
      pegoutId,
      validatorIdx: validatorKey.validatorIdx,
      identifier,
      signatures,
      lifetime: 30,
    });
    this.logger.log(`Signature sent for pegout ${pegoutId.toString(16)}`);
    return true;
  }
}
