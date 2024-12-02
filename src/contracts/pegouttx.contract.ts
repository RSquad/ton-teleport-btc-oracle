import {
  Address,
  Builder,
  Cell,
  Dictionary,
  SendMode,
  Slice,
  beginCell,
  contractAddress,
  type Contract,
  type DictionaryValue,
  type ContractProvider,
  type Sender,
} from "@ton/core";
import { bigIntToBuf, splitBufferToCells, writeCellsToBuffer } from "./common";
import { OpCodes } from "./constants";
import {
  type TTeleportOutput,
  type TTeleportUtxo,
  txidKey,
  utxoValue,
} from "./types";

export type PegoutTxConfig = {
  id: number;
  amount: bigint;
  bitcoinScript: Buffer;
  teleportAddress: Address;
};
function serializeScript(script: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(1, script.length), script as any]);
}

export function pegoutTxConfigToCell(config: PegoutTxConfig): Cell {
  return beginCell()
    .storeUint(0, 1)
    .storeUint(config.id, 32)
    .storeUint(config.amount, 64)
    .storeBuffer(serializeScript(config.bitcoinScript))
    .storeAddress(config.teleportAddress)
    .endCell();
}

export class PegoutTxContract implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static RefValue: DictionaryValue<Buffer> = {
    serialize: (src: Buffer, builder: Builder) => {
      builder.storeRef(splitBufferToCells(src));
    },
    parse: (src: Slice): Buffer => {
      return writeCellsToBuffer(src.loadRef());
    },
  };

  static createFromAddress(address: Address) {
    return new PegoutTxContract(address, undefined);
  }

  static createFromConfig(config: PegoutTxConfig, code: Cell, workchain = 0) {
    const data = pegoutTxConfigToCell(config);
    const init = { code, data };
    return new PegoutTxContract(contractAddress(workchain, init), init);
  }

  async sendDeploy(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      maxSigners?: number;
      txFee: number;
      changeScript: Buffer;
      utxoSet: Dictionary<bigint, TTeleportUtxo>;
      internalKey: Buffer;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.PEGOUT_TX_INITIALIZE, 32)
        .storeUint(opts.maxSigners ?? 2, 8)
        .storeUint(opts.txFee, 64)
        .storeBuffer(serializeScript(opts.changeScript))
        .storeBuffer(opts.internalKey, 32)
        .storeDict(opts.utxoSet)
        .endCell(),
    });
  }

  //
  // Getters
  //

  async getSigningHashes(provider: ContractProvider): Promise<Buffer[]> {
    const result = await provider.get("get_signing_hashes", []);
    const cell = result.stack.readCellOpt();
    if (cell == undefined) {
      return [];
    }
    return cell
      .beginParse()
      .loadDictDirect(Dictionary.Keys.Int(16), Dictionary.Values.Buffer(32))
      .values();
  }

  async getTxParts(provider: ContractProvider): Promise<{
    inputs: Dictionary<bigint, TTeleportUtxo>;
    outputs: TTeleportOutput[];
    signatures: Buffer[];
    internalKey: Buffer;
  }> {
    const result = await provider.get("get_tx_parts", []);

    const inputs = Dictionary.loadDirect(
      txidKey,
      utxoValue,
      result.stack.readCellOpt(),
    );

    const decodeOutput = (c: Cell) => {
      const s = c.beginParse();
      return {
        amount: s.loadUintBig(64),
        script: s.loadBuffer(s.loadUint(8)),
      };
    };
    const pegoutOutput = result.stack.readCell();
    const outputs: TTeleportOutput[] = [decodeOutput(pegoutOutput)];
    const changeOutput = result.stack.readCellOpt();
    if (changeOutput) {
      outputs.push(decodeOutput(changeOutput));
    }

    const signatures =
      Dictionary.loadDirect(
        Dictionary.Keys.Uint(16),
        Dictionary.Values.Buffer(65),
        result.stack.readCellOpt(),
      )?.values() || [];

    const internalKey = bigIntToBuf(result.stack.readBigNumber(), 32);
    return {
      inputs,
      outputs,
      signatures,
      internalKey,
    };
  }
}
