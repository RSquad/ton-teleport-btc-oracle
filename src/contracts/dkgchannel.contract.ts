import {
  Address,
  Builder,
  Cell,
  Dictionary,
  SendMode,
  Slice,
  beginCell,
  contractAddress,
  storeMessage,
  type Contract,
  type DictionaryKey,
  type DictionaryValue,
  type ContractProvider,
  type Sender,
  type Message,
} from "@ton/core";
import { type ISigner } from "../signers";
import { splitBufferToCells, writeCellsToBuffer } from "./common";
import { OpCodes } from "./constants";
import { PegoutTxContract } from "./pegouttx.contract";
import {
  DkgState,
  type TDKG,
  type TDKGChannelConfig,
  type TPegoutRecord,
} from "./types";

export type TReceivedPkg = {
  identifier: string;
  package: Buffer;
};

function storeDKGToCell(dkg?: TDKG) {
  if (!dkg) {
    return undefined;
  }

  return beginCell()
    .storeUint(dkg.state, 2)
    .storeDict(dkg.vset)
    .storeUint(dkg.maxSigners, 16)
    .storeUint(dkg.r1Packages.mask, 256)
    .storeUint(dkg.r1Packages.count, 16)
    .storeDict(dkg.r1Packages.packages)
    .storeUint(dkg.r2Packages.mask, 256)
    .storeUint(dkg.r2Packages.count, 16)
    .storeDict(dkg.r2Packages.packages)
    .storeBuffer(dkg.cfgHash, 32)
    .storeUint(dkg.attempts, 8)
    .storeUint(dkg.timeout, 32)
    .storeMaybeRef(
      dkg.pubkeyPackage ? splitBufferToCells(dkg.pubkeyPackage) : null,
    )
    .endCell();
}

function dKGChannelConfigToCell(config: TDKGChannelConfig): Cell {
  return beginCell()
    .storeUint(0, 1) // initialized?
    .storeUint(config.id, 32)
    .storeMaybeRef(storeDKGToCell(config.dkg))
    .storeMaybeRef(storeDKGToCell(config.prevDKG))
    .storeDict(config.pegouts || Dictionary.empty())
    .storeRef(config.pegoutTxCode)
    .endCell();
}
export const ED25519_PUBKEY_TAG = 0x8e81278a;
export function buildVsetFromArray(
  vset: Buffer[],
  count: number,
): Dictionary<number, Cell> {
  if (vset.length <= count) {
    throw Error(
      "Not anough validators. Change maxSigners or add more validators",
    );
  }
  const dict = Dictionary.empty(
    Dictionary.Keys.Uint(16),
    Dictionary.Values.Cell(),
  );
  for (let i = 0; i < count; i++) {
    const validator = beginCell()
      .storeUint(0x53, 8)
      .storeUint(ED25519_PUBKEY_TAG, 32)
      .storeBuffer(vset[i], 32)
      .endCell();
    dict.set(i, validator);
  }
  return dict;
}

export const ValidatorDescrValue: DictionaryValue<Buffer> = {
  serialize: (src: Buffer, builder: Builder) => {
    builder
        .storeUint(0x53, 8)
        .storeUint(ED25519_PUBKEY_TAG, 32)
        .storeBuffer(src, 32);
  },
  parse: (src: Slice): Buffer => {
    const slice = src;
    const tag = slice.loadUint(8);
    if ((tag & ~0x20) != 0x53) {
      throw "Invalid ValidatorDescr tag";
    }
    const pubkeyTag = slice.loadUint(32);
    if (pubkeyTag != ED25519_PUBKEY_TAG) {
      throw "Invalid PublicKey tag";
    }
    return slice.loadBuffer(32);
  },
};

export class DKGChannelContract implements Contract {
  private signer?: ISigner | undefined;
  constructor(
    readonly address: Address,
    signer?: ISigner,
    readonly init?: { code: Cell; data: Cell },
  ) {
    this.signer = signer;
  }

  static identifierKey: DictionaryKey<Buffer> = Dictionary.Keys.Buffer(32);
  static packageValue: DictionaryValue<Buffer> = {
    serialize: (src: Buffer, builder: Builder) => {
      builder.storeRef(splitBufferToCells(src));
    },
    parse: (src: Slice): Buffer => {
      return writeCellsToBuffer(src.loadRef());
    },
  };
  static pegoutRecordKey: DictionaryKey<number> = Dictionary.Keys.Uint(64);
  static pegoutRecordValue: DictionaryValue<TPegoutRecord> = {
    serialize: (src: TPegoutRecord, builder: Builder) => {
      builder.storeRef(
        beginCell()
          .storeBuffer(src.commitmentMask, 32)
          .storeUint(src.commitments.keys().length, 16)
          .storeDict(src.commitments)
          .storeBuffer(src.signSharesMask, 32)
          .storeUint(src.signingShares.keys().length, 16)
          .storeDict(src.signingShares)
          .storeAddress(src.pegoutAddress)
          .endCell(),
      );
    },
    parse: (src: Slice): TPegoutRecord => {
      const slice = src.loadRef().beginParse();
      const commitmentMask = slice.loadBuffer(32);
      slice.loadUint(16);
      const commitmentsDict = slice.loadDict(
        DKGChannelContract.identifierKey,
        DKGChannelContract.packageValue,
      );
      const signSharesMask = slice.loadBuffer(32);
      slice.loadUint(16);
      const signingSharesDict = slice.loadDict(
        DKGChannelContract.identifierKey,
        Dictionary.Values.Cell(),
      );

      const pegoutAddress = slice.loadAddress();
      return {
        pegoutAddress,
        commitments: commitmentsDict,
        signingShares: signingSharesDict,
        commitmentMask,
        signSharesMask,
      };
    },
  };
  static packageDictionaryValue: DictionaryValue<Dictionary<Buffer, Buffer>> = {
    serialize: (src: Dictionary<Buffer, Buffer>, builder: Builder) => {
      builder
        .storeUint(0, 256)
        .storeDict(
          src,
          DKGChannelContract.identifierKey,
          DKGChannelContract.packageValue,
        );
    },
    parse: (src: Slice): Dictionary<Buffer, Buffer> => {
      src.loadUint(256);
      return src.loadDict(
        DKGChannelContract.identifierKey,
        DKGChannelContract.packageValue,
      );
    },
  };

  static createFromAddress(address: Address, signer?: ISigner) {
    return new DKGChannelContract(address, signer ?? undefined);
  }

  static createFromConfig(
    config: TDKGChannelConfig,
    code: Cell,
    workchain = 0,
    signer: ISigner,
  ) {
    const data = dKGChannelConfigToCell(config);
    const init = { code, data };
    return new DKGChannelContract(
      contractAddress(workchain, init),
      signer,
      init,
    );
  }

  async connect(signer: ISigner) {
    this.signer = signer;
  }

  async sendDeploy(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      teleportAddress: Address;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.DKG_CHANNEL_INITIALIZE, 32)
        .storeAddress(opts.teleportAddress)
        .endCell(),
    });
  }

  async sendStartDKG(provider: ContractProvider, lifetime?: number) {
    const signBody = beginCell()
      .storeUint(OpCodes.DKG_START, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (lifetime ?? 30), 32)
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  async sendRound1(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      identifier: Buffer;
      round1Package: Buffer;
    },
  ) {
    if (opts.identifier.length != 32) {
      throw "identifier must be 32 bytes length";
    }
    const signBody = beginCell()
      .storeUint(OpCodes.DKGCHANNEL_ROUND1, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeBuffer(opts.identifier, 32)
          .storeRef(splitBufferToCells(opts.round1Package))
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  async sendRound2(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      fromIdentifier: Buffer;
      toIdentifier: Buffer;
      round2Package: Buffer;
    },
  ) {
    if (opts.fromIdentifier.length != 32 || opts.toIdentifier.length != 32) {
      throw "identifier must be 32 bytes length";
    }
    const signBody = beginCell()
      .storeUint(OpCodes.DKGCHANNEL_ROUND2, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeBuffer(opts.fromIdentifier, 32)
          .storeBuffer(opts.toIdentifier, 32)
          .storeRef(splitBufferToCells(opts.round2Package))
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  async sendPubkeyPackage(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      pubkeyPackage: Buffer;
      internalKeyXY: Buffer;
    },
  ) {
    if (opts.internalKeyXY.length != 65 && opts.internalKeyXY[0] != 0x04)
      throw "Internal key must be 65 bytes and has prefix 0x04";

    const signBody = beginCell()
      .storeUint(OpCodes.DKGCHANNEL_ROUND3, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeBuffer(opts.internalKeyXY.subarray(1, 65), 64)
          .storeRef(splitBufferToCells(opts.pubkeyPackage))
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  async sendReinitializeDkg(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(OpCodes.REINITIALIZE_DKG, 32).endCell(),
    });
  }

  async sendCommitments(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      identifier: Buffer;
      commitments: Buffer;
      pegoutId: number;
    },
  ) {
    if (opts.identifier.length != 32) {
      throw "identifier must be 32 bytes length";
    }
    const signBody = beginCell()
      .storeUint(OpCodes.PEGOUT_TX_SEND_COMMITMENTS, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeBuffer(opts.identifier, 32)
          .storeUint(opts.pegoutId, 64)
          .storeRef(splitBufferToCells(opts.commitments))
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);

    if (opts.identifier.length != 32) {
      throw "identifier must be 32 bytes length";
    }
  }

  async sendSigningShare(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      identifier: Buffer;
      signingShares: Buffer[];
      pegoutId: number;
    },
  ) {
    if (opts.identifier.length != 32) {
      throw "identifier must be 32 bytes length";
    }

    const signingDict = Dictionary.empty(
      Dictionary.Keys.Uint(64),
      PegoutTxContract.RefValue,
    );

    opts.signingShares.forEach((signingShare, index) => {
      signingDict.set(index, signingShare);
    });

    const signBody = beginCell()
      .storeUint(OpCodes.PEGOUT_TX_SEND_SIGN_SHARE, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeBuffer(opts.identifier, 32)
          .storeUint(opts.pegoutId, 64)
          .storeDict(signingDict)
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  async sendSignatures(
    provider: ContractProvider,
    opts: {
      lifetime?: number;
      validatorIdx: number;
      identifier: Buffer;
      signatures: Buffer[];
      pegoutId: number;
    },
  ) {
    const signaturesDict = Dictionary.empty(
      Dictionary.Keys.Uint(16),
      Dictionary.Values.Buffer(65),
    );

    for (let i = 0; i < opts.signatures.length; i++) {
      const signature = opts.signatures[i];
      if (opts.identifier.length != 32) {
        throw "identifier must be 32 bytes length";
      }
      if (signature.length != 65) {
        throw "signature must be 65 bytes length";
      }
      signaturesDict.set(i, signature);
    }
    const signBody = beginCell()
      .storeUint(OpCodes.PEGOUT_TX_SEND_SIGNATURE, 32)
      .storeUint(Math.floor(Date.now() / 1000) + (opts.lifetime ?? 30), 32)
      .storeUint(opts.validatorIdx, 16)
      .storeRef(
        beginCell()
          .storeUint(opts.pegoutId, 64)
          .storeDict(signaturesDict)
          .endCell(),
      )
      .endCell();
    const msgCell = await this.buildExternalMessage(signBody);
    await provider.external(msgCell);
  }

  parseRound1Packages = (
    packagesDict: Dictionary<Buffer, Buffer>,
  ): Map<string, Buffer> => {
    const packagesMap = new Map<string, Buffer>();
    for (const pack of packagesDict) {
      packagesMap.set(pack[0].toString("hex"), pack[1]);
    }
    return packagesMap;
  };

  parseRound2Packages = (
    packagesDict: Dictionary<Buffer, Dictionary<Buffer, Buffer>>,
  ): Map<string, Map<string, Buffer>> => {
    const outerMap = new Map<string, Map<string, Buffer>>();
    packagesDict.keys().forEach((key) => {
      const innerMap = new Map<string, Buffer>();
      packagesDict
        .get(key)!
        .keys()
        .forEach((innerKey) => {
          innerMap.set(
            innerKey.toString("hex"),
            packagesDict.get(key)!.get(innerKey)!,
          );
        });
      outerMap.set(key.toString("hex"), innerMap);
    });
    return outerMap;
  };

  //
  // Public getters
  //

  async getDKG(provider: ContractProvider) {
    const result = await provider.get("get_dkg", []);
    const dkgCell = result.stack.readCellOpt();
    return dkgCell ? this.parseDKG(dkgCell.beginParse()) : undefined;
  }

  async getPrevDKG(provider: ContractProvider) {
    const result = await provider.get("get_prev_dkg", []);
    const dkgCell = result.stack.readCellOpt();
    return dkgCell ? this.parseDKG(dkgCell.beginParse()) : undefined;
  }

  private parseDKG(dkgSlice: Slice): TDKG {
    const state = dkgSlice.loadUint(2) as DkgState;
    const vset = dkgSlice.loadDict(
      Dictionary.Keys.Uint(16),
      ValidatorDescrValue,
    );
    const maxSigners = dkgSlice.loadUint(16);
    const r1PackageParams = this.parsePackage(dkgSlice);
    const r1PackageDict = dkgSlice.loadDict(
      DKGChannelContract.identifierKey,
      DKGChannelContract.packageValue,
    );
    const r2PackageParams = this.parsePackage(dkgSlice);
    const r2PackageDict = dkgSlice.loadDict(
      DKGChannelContract.identifierKey,
      DKGChannelContract.packageDictionaryValue,
    );
    const cfgHash = dkgSlice.loadBuffer(32);
    const attempts = dkgSlice.loadUint(8);
    const timeout = dkgSlice.loadUint(32);
    const packageCell = dkgSlice.loadMaybeRef();
    const dkg: TDKG = {
      state,
      vset,
      maxSigners,
      r1Packages: {
        ...r1PackageParams,
        packages: r1PackageDict,
      },
      r2Packages: {
        ...r2PackageParams,
        packages: r2PackageDict,
      },
      cfgHash,
      attempts,
      timeout,
    };
    if (packageCell) {
      dkg.pubkeyPackage = writeCellsToBuffer(packageCell);
    }
    return dkg;
  }

  private parsePackage(dkg: Slice) {
    const mask = dkg.loadUintBig(256);
    const count = dkg.loadUint(16);

    return {
      mask,
      count,
    };
  }

  async getRound1Packages(
    provider: ContractProvider,
  ): Promise<Dictionary<Buffer, Buffer> | undefined> {
    const dkg = await this.getDKG(provider);
    return dkg?.r1Packages.packages;
  }

  async getRound2Packages(
    provider: ContractProvider,
  ): Promise<Dictionary<Buffer, Dictionary<Buffer, Buffer>> | undefined> {
    const dkg = await this.getDKG(provider);
    return dkg?.r2Packages.packages;
  }

  async getPubkeyPackage(
    provider: ContractProvider,
  ): Promise<Buffer | undefined> {
    const dkg = await this.getPrevDKG(provider);
    return dkg?.pubkeyPackage;
  }

  async getVset(
    provider: ContractProvider,
  ): Promise<
    { vsetMain: number; dict: Dictionary<number, Buffer> } | undefined
  > {
    const dkg = await this.getDKG(provider);
    if (!dkg) return undefined;
    return { vsetMain: dkg!.maxSigners, dict: dkg!.vset };
  }

  async getValidatorIdx(
    provider: ContractProvider,
    { pubkey }: { pubkey: string },
  ): Promise<number | undefined> {
    const dkg = await this.getDKG(provider);
    return dkg?.vset.keys().find((idx) => {
      const validatorKey = dkg.vset.get(idx);
      if (validatorKey && validatorKey.toString("hex") === pubkey) {
        return true;
      } else false;
    });
  }

  r1Pkgs(dkg: TDKG, identifier: string): TReceivedPkg[] {
    const tmpPkgs: TReceivedPkg[] = [];
    const r1PkgsDict = dkg.r1Packages.packages;
    const r1Pkgs = this.parseRound1Packages(r1PkgsDict);
    r1Pkgs.forEach((pkg, key) => {
      if (identifier != key) {
        tmpPkgs.push({ identifier: key, package: pkg });
      }
    });
    return tmpPkgs;
  }

  r2Pkgs(dkg: TDKG, identifier: string): TReceivedPkg[] {
    const r2PkgsArr: TReceivedPkg[] = [];
    const r2PkgsDict = dkg.r2Packages.packages;
    const r2Pkgs = this.parseRound2Packages(r2PkgsDict);
    r2Pkgs.get(identifier)!.forEach((value, key) => {
      r2PkgsArr.push({ identifier: key, package: value });
    });
    return r2PkgsArr;
  }

  async getR1Completed(provider: ContractProvider) {
    const dkg = await this.getDKG(provider);
    if (!dkg) throw "dkg is undefined";
    return (
      dkg.state >= DkgState.PART1_FINISHED || dkg.state === DkgState.FINISHED
    );
  }

  async getR2Completed(provider: ContractProvider): Promise<boolean> {
    const dkg = await this.getDKG(provider);
    if (!dkg) throw "dkg is undefined";
    return (
      dkg.state >= DkgState.PART2_FINISHED || dkg.state === DkgState.FINISHED
    );
  }

  private async buildExternalMessage(signBody: Cell): Promise<Cell> {
    const signature = this.signer
      ? await this.signer!.signCell(signBody)
      : Buffer.alloc(64, 0);
    const body = beginCell()
      .storeBuffer(signature, 64)
      .storeSlice(signBody.asSlice())
      .endCell();
    const message: Message = {
      info: {
        type: "external-in",
        dest: this.address,
        importFee: 0n,
      },
      body,
    };
    const cell = beginCell();
    const store = storeMessage(message);
    store(cell);
    return cell.endCell();
  }

  async getCommitments(
    provider: ContractProvider,
    args: {
      pegoutTxId: number;
    },
  ): Promise<Dictionary<Buffer, Buffer> | undefined> {
    const result = await provider.get("get_commitments", [
      { type: "int", value: BigInt(args.pegoutTxId) },
    ]);
    const cell = result.stack.readCellOpt();
    const dict = cell
      ?.beginParse()
      .loadDictDirect(Dictionary.Keys.Buffer(32), PegoutTxContract.RefValue);
    return dict;
  }

  async getCommitsMap(
    provider: ContractProvider,
    args: {
      pegoutTxId: number;
    },
  ): Promise<Map<string, Buffer>> {
    const dict = await this.getCommitments(provider, args);
    return dict ? await this.dictToMap(dict) : new Map<string, Buffer>();
  }

  async getSigningShares(
    provider: ContractProvider,
    args: {
      pegoutTxId: number;
    },
  ): Promise<Dictionary<Buffer, Cell> | undefined> {
    const result = await provider.get("get_signature_shares", [
      { type: "int", value: BigInt(args.pegoutTxId) },
    ]);
    const cell = result.stack.readCellOpt();
    const dict = cell
      ?.beginParse()
      .loadDictDirect(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    return dict;
  }

  async getSigningSharesMap(
    provider: ContractProvider,
    args: {
      pegoutTxId: number;
    },
  ): Promise<Map<string, Map<string, Buffer>>> {
    const dict = await this.getSigningShares(provider, args);
    const map = dict ? await this.dictToMap(dict) : new Map<string, Cell>();
    const res = new Map<string, Map<string, Buffer>>();
    for (const [key, shares] of map) {
      const sharesMap = await this.dictToMap(
        shares
          .beginParse()
          .loadDictDirect(Dictionary.Keys.Buffer(8), PegoutTxContract.RefValue),
      );
      res.set(key, sharesMap);
    }
    return res;
  }

  async getUnsignedPegouts(
    provider: ContractProvider,
  ): Promise<Dictionary<number, TPegoutRecord> | undefined> {
    const result = await provider.get("get_pegout_records", []);
    const cell = result.stack.readCellOpt();
    const dict = cell
      ?.beginParse()
      .loadDictDirect(
        DKGChannelContract.pegoutRecordKey,
        DKGChannelContract.pegoutRecordValue,
      );
    return dict;
  }

  public dictToMap = async <T = Buffer>(
    dict: Dictionary<Buffer, T>,
  ): Promise<Map<string, T>> => {
    const map = new Map<string, T>();
    for (const element of dict) {
      map.set(element[0].toString("hex"), element[1]);
    }
    return map;
  };
}
