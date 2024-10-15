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

import { splitBufferToCells, writeCellsToBuffer } from "./common";
import { OpCodes } from "./constants";
import { PegoutTxContract } from "./pegouttx.contract";
import type { ISigner, TPegoutRecord, TValidator } from "./types.ts";

export enum DkgState {
  FINISHED = 0,
  IN_PROGRESS = 1,
  PART1_FINISHED = 2,
  PART2_FINISHED = 3,
}

export type TDKGChannelConfig = {
  id: number;
  maxSigners: number;
  state: DkgState;
  round1Dict: Dictionary<Buffer, Buffer>;
  round2Dict: Dictionary<Buffer, Dictionary<Buffer, Buffer>>;
  pubkeyPackage: Cell | null;
  tweakedKey: bigint;
  vset?: TValidator[] | null;
  vsetMain?: number | null;
  pegouts?: Dictionary<Buffer, TPegoutRecord>;
  pegoutTxCode: Cell;
};

export type TReceivedPkg = {
  identifier: string;
  package: Buffer;
};

function dKGChannelConfigToCell(config: TDKGChannelConfig): Cell {
  const subCell = beginCell().storeMaybeRef(config.pubkeyPackage);
  if (config.vset) {
    subCell.storeMaybeRef(
      beginCell()
        .storeUint(0x12, 8)
        .storeUint(0, 32) // utime_since
        .storeUint(0, 32)
        .storeUint(0, 16)
        .storeUint(config.vsetMain ?? 0, 16)
        .storeUint(0, 64)
        .storeDict(buildVsetFromArray(config.vset, config.vsetMain ?? 0))
        .endCell(),
    );
  } else {
    subCell.storeMaybeRef(null);
  }
  subCell.storeRef(config.pegoutTxCode);

  return beginCell()
    .storeUint(0, 1) // initialized?
    .storeUint(config.id, 32)
    .storeUint(config.maxSigners, 16)
    .storeInt(config.state, 2)
    .storeInt(config.maxSigners, 16) // expected_packages_count
    .storeDict(config.round1Dict)
    .storeDict(config.round2Dict)
    .storeDict(config.pegouts || Dictionary.empty())
    .storeRef(subCell.endCell())
    .endCell();
}

export function buildVsetFromArray(
  vset: TValidator[],
  count: number,
): Dictionary<number, Cell> {
  const ed25519Tag = 0x8e81278a;
  const dict = Dictionary.empty(
    Dictionary.Keys.Uint(16),
    Dictionary.Values.Cell(),
  );
  for (let i = 0; i < count; i++) {
    const validator = beginCell()
      .storeUint(0x53, 8)
      .storeUint(ed25519Tag, 32)
      .storeUint(BigInt("0x" + vset[i].publicKey), 256)
      .endCell();
    dict.set(i, validator);
  }
  return dict;
}

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
      builder.storeRef(
        beginCell().storeDictDirect(
          src,
          DKGChannelContract.identifierKey,
          DKGChannelContract.packageValue,
        ),
      );
    },
    parse: (src: Slice): Dictionary<Buffer, Buffer> => {
      return src
        .loadRef()
        .beginParse()
        .loadDictDirect(
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

  parseRound1Packages = async (
    packagesDict: Dictionary<Buffer, Buffer>,
  ): Promise<Map<string, Buffer>> => {
    const packagesMap = new Map<string, Buffer>();
    for (const pack of packagesDict) {
      packagesMap.set(pack[0].toString("hex"), pack[1]);
    }
    return packagesMap;
  };

  parseRound2Packages = async (
    packagesDict: Dictionary<Buffer, Dictionary<Buffer, Buffer>>,
  ): Promise<Map<string, Map<string, Buffer>>> => {
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

  async getState(provider: ContractProvider): Promise<DkgState> {
    const result = await provider.get("get_state", []);
    const number = result.stack.readNumber();
    return number;
  }

  async getMaxSigners(provider: ContractProvider): Promise<number> {
    const result = await provider.get("get_max_signers", []);
    const number = result.stack.readNumber();
    return number;
  }

  async getInternalKey(
    provider: ContractProvider,
  ): Promise<Buffer | undefined> {
    const pubkeyPackage = await this.getPubkeyPackage(provider);
    return pubkeyPackage!.subarray(pubkeyPackage!.length - 32);
  }

  async getRound1Packages(
    provider: ContractProvider,
  ): Promise<Dictionary<Buffer, Buffer> | undefined> {
    const result = await provider.get("get_round1_packages", []);
    const cell = result.stack.readCellOpt();
    const dict = cell
      ?.beginParse()
      .loadDictDirect(
        DKGChannelContract.identifierKey,
        DKGChannelContract.packageValue,
      );
    return dict;
  }

  async getRound2Packages(
    provider: ContractProvider,
  ): Promise<Dictionary<Buffer, Dictionary<Buffer, Buffer>> | undefined> {
    const result = await provider.get("get_round2_packages", []);
    const cell = result.stack.readCellOpt();
    const dict = cell
      ?.beginParse()
      .loadDictDirect(
        DKGChannelContract.identifierKey,
        DKGChannelContract.packageDictionaryValue,
      );
    return dict;
  }

  async getPubkeyPackage(
    provider: ContractProvider,
  ): Promise<Buffer | undefined> {
    const result = await provider.get("get_pubkey_package", []);
    const cell = result.stack.readCellOpt();
    if (!cell) return undefined;
    return writeCellsToBuffer(cell!);
  }

  async getVset(
    provider: ContractProvider,
  ): Promise<{ vsetMain: number; dict: Dictionary<number, Cell> } | undefined> {
    const result = await provider.get("get_vset", []);
    const cell = result.stack.readCellOpt();
    if (!cell) return undefined;
    const slice = cell?.beginParse();
    slice.skip(8 + 32 + 32 + 16);
    const vsetMain = slice.loadUint(16);
    slice.skip(64);
    const dict = slice.loadDict(
      Dictionary.Keys.Uint(16),
      Dictionary.Values.Cell(),
    );
    return { vsetMain, dict };
  }

  async getValidatorIdx(
    provider: ContractProvider,
    { pubkey }: { pubkey: string },
  ): Promise<number | undefined> {
    const result = await provider.get("get_vset", []);
    const cell = result.stack.readCellOpt();
    if (!cell) return undefined;
    const slice = cell!.beginParse();
    slice.skip(8 + 32 + 32 + 16 + 16 + 64);
    const dict = slice.loadDict(
      Dictionary.Keys.Uint(16),
      Dictionary.Values.Cell(),
    );

    for (let i = 0; i < dict.size; i++) {
      const cell = dict.get(i);
      const slice = cell!.beginParse();
      slice.skip(8 + 32);
      const publicKey = slice.loadUintBig(256);
      if (publicKey == BigInt("0x" + pubkey)) {
        return dict.keys().at(i);
      }
    }
    return undefined;
  }

  async getR1Pkgs(
    provider: ContractProvider,
    { identifier }: { identifier: string },
  ): Promise<TReceivedPkg[]> {
    const tmpPkgs: TReceivedPkg[] = [];
    const r1PkgsDict = await this.getRound1Packages(provider);
    if (!r1PkgsDict) return [];
    const r1Pkgs = await this.parseRound1Packages(r1PkgsDict);
    r1Pkgs.forEach((pkg, key) => {
      if (identifier != key) {
        tmpPkgs.push({ identifier: key, package: pkg });
      }
    });
    return tmpPkgs;
  }

  async getR2Pkgs(
    provider: ContractProvider,
    { identifier }: { identifier: string },
  ): Promise<TReceivedPkg[]> {
    const r2PkgsArr: TReceivedPkg[] = [];
    const r2PkgsDict = await this.getRound2Packages(provider);
    if (!r2PkgsDict) return r2PkgsArr;
    const r2Pkgs = await this.parseRound2Packages(r2PkgsDict);
    r2Pkgs.get(identifier)!.forEach((value, key) => {
      r2PkgsArr.push({ identifier: key, package: value });
    });
    return r2PkgsArr;
  }

  async getR1Completed(provider: ContractProvider) {
    const state = await this.getState(provider);
    return state >= DkgState.PART1_FINISHED || state === DkgState.FINISHED;
  }

  async getR2Completed(provider: ContractProvider): Promise<boolean> {
    const state = await this.getState(provider);
    return state >= DkgState.PART2_FINISHED || state === DkgState.FINISHED;
  }

  private async buildExternalMessage(signBody: Cell): Promise<Cell> {
    const signature = await this.signer!.signCell(signBody);
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
