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
  type DictionaryKey,
  type DictionaryValue,
  type ContractProvider,
  type Sender,
} from "@ton/core";
import { bigIntToBuf, intToBitcoinHash } from "./common";
import { Logs } from "./constants";
import { type PegoutTxConfig, PegoutTxContract } from "./pegouttx.contract";
import {
  type TDeposit,
  type TTeleportConfig,
  txidKey,
  utxoValue,
} from "./types";

function teleportConfigToCell(config: TTeleportConfig): Cell {
  let inputCount = 0;
  let inputAmount = 0n;
  config.utxoSet.keys().forEach((k) => {
    inputAmount += config.utxoSet.get(k)!.amount;
    inputCount += 1;
  });

  const partialBlockData = beginCell()
    .storeUint(0, 1)
    .storeAddress(config.bitcoinClientAddress)
    .endCell();
  return beginCell()
    .storeDict(
      config.deposits,
      TeleportContract.TransferKey,
      TeleportContract.TransferValue,
    )
    .storeRef(config.blockCode)
    .storeRef(partialBlockData)
    .storeUint(config.tweakedPubkey, 256)
    .storeAddress(config.minterAddress)
    .storeAddress(config.verifierAddress)
    .storeUint(config.id, 32)
    .storeBuffer(config.locktime, 4)
    .storeUint(config.satPerByte, 16)
    .storeUint(config.satPerByteInc, 16)
    .storeUint(config.maxSatPerByte, 16)
    .storeUint(config.initialSatPerByte, 16)
    .storeRef(
      beginCell()
        .storeRef(config.pegouttxCode)
        .storeUint(inputCount, 16)
        .storeUint(inputAmount, 64)
        .storeDict(config.utxoSet)
        .storeRef(config.pegintxCode)
        .storeAddress(config.dkgChannelAddress)
        .storeAddress(config.tweakerAddress)
        .storeMaybeRef(
          config.taproot &&
            beginCell()
              .storeBuffer(config.taproot.internalKeyX, 32)
              .storeBuffer(config.taproot.internalKeyY, 32)
              .endCell(),
        )
        .endCell(),
    )
    .endCell();
}

export class TeleportContract implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  //
  // Define Key and Value types for Dictionary (Hashmap)
  //
  static TransferKey: DictionaryKey<bigint> = Dictionary.Keys.BigUint(64);
  static TransferValue: DictionaryValue<TDeposit> = {
    serialize: (src: TDeposit, builder: Builder) => {
      const transfer_cell = beginCell()
        .storeUint(src.blockHash, 256)
        .storeBuffer(src.tapMerkleRoot || Buffer.alloc(32), 32)
        .storeUint(src.amount, 128)
        .storeAddress(src.dest)
        .storeRef(src.txproof)
        .storeRef(src.tx)
        .endCell();
      builder.storeRef(transfer_cell);
    },
    parse: (src: Slice): TDeposit => {
      src = src.loadRef().beginParse();
      const data: TDeposit = {
        blockHash: src.loadUintBig(256),
        tapMerkleRoot: src.loadBuffer(32),
        amount: src.loadUintBig(128),
        dest: src.loadAddress(),
        txproof: src.loadRef(),
        tx: src.loadRef(),
      };

      if (data.tapMerkleRoot?.equals(Buffer.alloc(32))) {
        data.tapMerkleRoot = undefined;
      }

      return data;
    },
  };

  //
  // Class initializers
  //
  static createFromAddress(address: Address) {
    return new TeleportContract(address);
  }

  static createFromConfig(config: TTeleportConfig, code: Cell, workchain = 0) {
    const data = teleportConfigToCell(config);
    const init = { code, data };
    return new TeleportContract(contractAddress(workchain, init), init);
  }

  //
  // Body builders
  //
  // static buildTransferBtcBodyCell(
  //   params: TTransferBtcBodyParams,
  //   queryId?: number,
  // ): Cell {
  //   const generatedId = Math.floor(Math.random() * (Math.pow(2, 64) - 1));
  //   return beginCell()
  //     .storeUint(OpCodes.TELEPORT_TRANSFER_BTC, 32)
  //     .storeUint(queryId ?? generatedId, 64)
  //     .storeUint(bitcoinHashToInt(params.blockHash), 256)
  //     .storeRef(serializeTransaction(params.tx))
  //     .storeRef(serializeMerkleProof(params.txproof))
  //     .storeMaybeRef(
  //       params.recoveryKeyX
  //         ? beginCell().storeBuffer(params.recoveryKeyX).endCell()
  //         : undefined,
  //     )
  //     .storeAddress(params.destAddress)
  //     .storeAddress(params.responseAddress)
  //     .endCell();
  // }

  // static parseTransferBtcBodyCell(msgBodyCell: Cell): {
  //   opCode: number;
  //   queryId: number;
  //   blockHash: string;
  //   tx: Cell;
  //   txproof: Cell;
  //   destAddress: Address;
  // } {
  //   const msgBodySlice = msgBodyCell.beginParse();
  //   return {
  //     opCode: msgBodySlice.loadUint(32),
  //     queryId: msgBodySlice.loadUint(64),
  //     blockHash: intToBitcoinHash(msgBodySlice.loadUintBig(256)),
  //     tx: msgBodySlice.loadRef(),
  //     txproof: msgBodySlice.loadRef(),
  //     destAddress: msgBodySlice.loadAddress(),
  //   };
  // }

  static parseLogEventCell(logBurnCell: Cell):
    | {
        id: number;
        amount: bigint;
        bitcoinTxid: string;
        sender: Address;
        bitcoinScript: Buffer;
      }
    | undefined {
    const logMsgSlice = logBurnCell.beginParse();
    const logId = logMsgSlice.loadUint(32);
    if (logId == Logs.BURN) {
      const id = logMsgSlice.loadUint(32);
      const amount = logMsgSlice.loadCoins();
      const bitcoinTxid = intToBitcoinHash(logMsgSlice.loadUintBig(256));
      const sender = logMsgSlice.loadAddress();
      const scriptSlice = logMsgSlice.loadRef().beginParse();
      const bitcoinScript = scriptSlice.loadBuffer(
        scriptSlice.remainingBits / 8,
      );
      return { id, amount, bitcoinTxid, sender, bitcoinScript };
    }
    return undefined;
  }

  static parseReinitializeLogCell(logReinitializeCell: Cell):
    | {
        id: number;
        amount: bigint;
        bitcoinTxid: string;
        bitcoinScript?: Buffer;
      }
    | undefined {
    const logMsgSlice = logReinitializeCell.beginParse();
    const logId = logMsgSlice.loadUint(32);
    if (logId == Logs.REINITIALIZE) {
      const id = logMsgSlice.loadUint(32);
      const amount = logMsgSlice.loadCoins();
      const bitcoinTxid = intToBitcoinHash(logMsgSlice.loadUintBig(256));
      const scriptCell = logMsgSlice.loadRef();
      const scriptSlice = scriptCell.beginParse();
      let bitcoinScript = undefined;
      if (scriptSlice.remainingBits > 2) {
        bitcoinScript = scriptSlice.loadBuffer(scriptSlice.remainingBits / 8);
      }
      return { id, amount, bitcoinTxid, bitcoinScript };
    }
    return undefined;
  }

  // static parseLogMintEventCell(logBurnCell: Cell):
  //   | {
  //       amount: bigint;
  //       mintAddress: Address;
  //       txId: string;
  //     }
  //   | undefined {
  //   const logMsgSlice = logBurnCell.beginParse();
  //   if (!logMsgSlice.remainingBits) return;
  //   const logId = logMsgSlice.loadUint(32);
  //   if (logId == Logs.MINT) {
  //     const amount = logMsgSlice.loadCoins();
  //     const mintAddress = logMsgSlice.loadAddress();
  //     const txId = intToBitcoinHash(logMsgSlice.loadUintBig(256));
  //     return { amount, mintAddress, txId };
  //   }
  //   return undefined;
  // }

  //
  // Internal message calls
  //
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  // async sendTransferBtc(
  //   provider: ContractProvider,
  //   via: Sender,
  //   value: bigint,
  //   params: TTransferBtcBodyParams,
  //   queryId?: number,
  // ) {
  //   await provider.internal(via, {
  //     value,
  //     sendMode: SendMode.PAY_GAS_SEPARATELY,
  //     body: TeleportContract.buildTransferBtcBodyCell(params, queryId),
  //   });
  // }

  // async sendNotifyBurn(
  //   provider: ContractProvider,
  //   via: Sender,
  //   amount: number,
  //   value: bigint,
  //   outScript: Buffer,
  //   senderTonAddress: Address,
  // ) {
  //   await provider.internal(via, {
  //     value,
  //     sendMode: SendMode.PAY_GAS_SEPARATELY,
  //     body: beginCell()
  //       .storeUint(0x587643a2, 32)
  //       .storeUint(0, 64)
  //       .storeCoins(amount)
  //       .storeRef(beginCell().storeBuffer(outScript).endCell())
  //       // my TON address
  //       .storeAddress(senderTonAddress)
  //       .endCell(),
  //   });
  // }
  //
  // async sendInternalKey(
  //   provider: ContractProvider,
  //   via: Sender,
  //   value: bigint,
  //   internalKeyXY: Buffer,
  //   queryId?: number,
  // ) {
  //   await provider.internal(via, {
  //     value,
  //     sendMode: SendMode.PAY_GAS_SEPARATELY,
  //     body: beginCell()
  //       .storeUint(OpCodes.TELEPORT_SEND_INTERNAL_KEY, 32)
  //       .storeUint(queryId ?? 0, 64)
  //       .storeBuffer(internalKeyXY, 64)
  //       .endCell(),
  //   });
  // }

  //
  // Get-methods
  //
  async getStorage(provider: ContractProvider): Promise<TTeleportConfig> {
    const result = await provider.get("get_storage", []);
    const storage: TTeleportConfig = {
      id: result.stack.readNumber(),
      blockCode: result.stack.readCell(),
      deposits: Dictionary.loadDirect(
        TeleportContract.TransferKey,
        TeleportContract.TransferValue,
        result.stack.readCellOpt(),
      ),
      minterAddress: result.stack.readAddress(),
      verifierAddress: result.stack.readAddress(),
      bitcoinClientAddress: result.stack.readAddress(),
      tweakedPubkey: result.stack.readBigNumber(),
      pegouttxCode: result.stack.readCell(),
      dkgChannelAddress: result.stack.readAddress(),
      utxoSet: Dictionary.loadDirect(
        txidKey,
        utxoValue,
        result.stack.readCellOpt(),
      ),
      pegintxCode: result.stack.readCell(),
      satPerByte: result.stack.readNumber(),
      satPerByteInc: result.stack.readNumber(),
      maxSatPerByte: result.stack.readNumber(),
      initialSatPerByte: result.stack.readNumber(),
      tweakerAddress: new Address(0, Buffer.alloc(32)),
      taproot: {
        internalKeyX: bigIntToBuf(result.stack.readBigNumber(), 32),
        internalKeyY: bigIntToBuf(result.stack.readBigNumber(), 32),
      },
      locktime: bigIntToBuf(result.stack.readBigNumber(), 4),
    };
    return storage;
  }

  async getPegoutTxAddress(
    provider: ContractProvider,
    initArgs: PegoutTxConfig,
  ): Promise<Address> {
    const result = await provider.get("get_storage", []);
    result.stack.skip(7);
    const code = result.stack.readCell();
    return PegoutTxContract.createFromConfig(initArgs, code).address;
  }

  // async getNextFee(provider: ContractProvider): Promise<number> {
  //   const result = await provider.get("get_next_fee", []);
  //   return result.stack.readNumber();
  // }
}
