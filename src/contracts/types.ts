import {
  Address,
  Builder,
  Cell,
  Dictionary,
  Slice,
  beginCell,
  type DictionaryKey,
  type DictionaryValue,
} from "@ton/core";

export type TDeposit = {
  blockHash: bigint;
  tapMerkleRoot?: Buffer;
  amount: bigint;
  dest: Address;
  txproof: Cell;
  tx: Cell;
};

export type TTeleportUtxo = {
  amount: bigint;
  index: number;
  script: Buffer;
  taprootMerkleRoot?: Buffer;
  mintAddress: Address;
};

export type TTeleportOutput = {
  amount: bigint;
  script: Buffer;
};

export type TTeleportConfig = {
  deposits: Dictionary<bigint, TDeposit>;
  blockCode: Cell;
  bitcoinClientAddress: Address;
  tweakedPubkey: bigint;
  minterAddress: Address;
  verifierAddress: Address;
  id: number;
  satPerByte: number;
  initialSatPerByte: number;
  satPerByteInc: number;
  maxSatPerByte: number;
  pegouttxCode: Cell;
  dkgChannelAddress: Address;
  utxoSet: Dictionary<bigint, TTeleportUtxo>;
  pegintxCode: Cell;
  tweakerAddress: Address;
  taproot?: {
    internalKeyX: Buffer;
    internalKeyY: Buffer;
  };
  locktime: Buffer;
};

export type TTransferBtcBodyParams = {
  blockHash: string;
  tx: string;
  txproof: string;
  destAddress: Address;
  responseAddress: Address;
  recoveryKeyX?: Buffer;
};

export type TValidator = {
  publicKey: string;
  weight: number;
  adnlAddr: string;
};

export type TPegoutRecord = {
  internalKey: Buffer;
  pegoutAddress: Address;
  commitments: Dictionary<Buffer, Buffer>;
  signingShares: Dictionary<Buffer, Cell>;
  commitmentMask: Buffer;
  signSharesMask: Buffer;
};

export enum NetworkName {
  REGTEST,
  BITCOIN,
  TESTNET,
}

export const txidKey: DictionaryKey<bigint> = Dictionary.Keys.BigUint(256);
export const utxoValue: DictionaryValue<TTeleportUtxo> = {
  serialize: (src: TTeleportUtxo, builder: Builder) => {
    builder
      .storeUint(src.amount, 128)
      .storeUint(src.index, 8)
      .storeBuffer(src.taprootMerkleRoot || Buffer.alloc(32), 32)
      .storeAddress(src.mintAddress)
      .storeRef(beginCell().storeBuffer(src.script).endCell());
  },
  parse: (src: Slice): TTeleportUtxo => {
    const ref = src.loadRef().beginParse();

    const data: TTeleportUtxo = {
      amount: src.loadUintBig(128),
      index: src.loadUint(8),
      taprootMerkleRoot: src.loadBuffer(32),
      mintAddress: src.loadAddress(),
      script: ref.loadBuffer(ref.remainingBits / 8),
    };

    if (data.taprootMerkleRoot?.equals(Buffer.alloc(32) as any)) {
      data.taprootMerkleRoot = undefined;
    }

    return data;
  },
};

export enum DkgState {
  FINISHED = 0,
  IN_PROGRESS = 1,
  PART1_FINISHED = 2,
  PART2_FINISHED = 3,
}

export type TR1Package = {
  mask: bigint;
  count: number;
  packages: Dictionary<Buffer, Buffer>;
};

export type TR2Package = {
  mask: bigint;
  count: number;
  packages: Dictionary<Buffer, Dictionary<Buffer, Buffer>>;
};

export type TR3Package = {
  mask: bigint;
  count: number;
  pubkeyData?: {
    pubkeyPackage: Buffer;
    internalKey: Buffer;
  };
};

export type TDKG = {
  state: DkgState;
  vset: Dictionary<number, Buffer>;
  maxSigners: number;
  r1Packages: TR1Package;
  r2Packages: TR2Package;
  r3Package: TR3Package;
  cfgHash: Buffer;
  attempts: number;
  timeout: number;
};

export type TCoordinatorConfig = {
  id: number;
  standaloneMode: boolean;
  dkg?: TDKG;
  prevDKG?: TDKG;
  pegouts?: Dictionary<Buffer, TPegoutRecord>;
  pegoutTxCode: Cell;
};
