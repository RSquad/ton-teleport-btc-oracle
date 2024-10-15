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
  type ISigner,
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
  return Buffer.concat([Buffer.alloc(1, script.length), script]);
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
    readonly signer?: ISigner,
  ) {}

  static RefValue: DictionaryValue<Buffer> = {
    serialize: (src: Buffer, builder: Builder) => {
      builder.storeRef(splitBufferToCells(src));
    },
    parse: (src: Slice): Buffer => {
      return writeCellsToBuffer(src.loadRef());
    },
  };

  static createFromAddress(address: Address, signer?: ISigner) {
    return new PegoutTxContract(address, undefined, signer);
  }

  static createFromConfig(
    config: PegoutTxConfig,
    code: Cell,
    workchain = 0,
    signer?: ISigner,
  ) {
    const data = pegoutTxConfigToCell(config);
    const init = { code, data };
    return new PegoutTxContract(contractAddress(workchain, init), init, signer);
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

  //
  // Private methods
  //

  // private async buildExternalMessage(signBody: Cell): Promise<Cell> {
  //   const signature = this.signer
  //     ? ((await this.signer?.signCell(signBody)) as Buffer)
  //     : randomBytes(64);
  //   const body = beginCell()
  //     .storeBuffer(signature, 64)
  //     .storeSlice(signBody.asSlice())
  //     .endCell();
  //   const message: Message = {
  //     info: {
  //       type: "external-in",
  //       dest: this.address,
  //       importFee: 0n,
  //     },
  //     body,
  //   };
  //   const cell = beginCell();
  //   const store = storeMessage(message);
  //   store(cell);
  //   return cell.endCell();
  // }
}
