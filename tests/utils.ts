import { Address } from "@ton/core";
import { type Taptree } from "bitcoinjs-lib/src/types";
import * as bitcoin from "bitcoinjs-lib";
import { script } from "bitcoinjs-lib";
import { toHashTree, tweakKey } from "bitcoinjs-lib/src/payments/bip341";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";

const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 22;
const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;
const SECONDS_IN_HOUR = 3600;
export const TIME_LOCK_UNIT = 512;
export const DEFAULT_CSV_LOCK = hoursToCsvLock(18);

export function hoursToCsvLock(h: number) {
  const totalSeconds = h * SECONDS_IN_HOUR;
  return Math.ceil(totalSeconds / TIME_LOCK_UNIT);
}

export function applyTimeLockFlag(timeLock: number) {
  return SEQUENCE_LOCKTIME_TYPE_FLAG | (timeLock & SEQUENCE_LOCKTIME_MASK);
}

export function buildScriptTree(
  tonAddress: Address,
  recoveryPubkey: Buffer = Buffer.alloc(32),
  csvLock: number,
): Taptree {
  return [
    {
      output: ScriptBuilder.opCheckSequenceVerify(recoveryPubkey, csvLock),
    },
    {
      output: ScriptBuilder.opReturn(serializeAddressUnsafe(tonAddress)),
    },
  ];
}

export function serializeAddressUnsafe(address: Address) {
  return Buffer.from(
    address.hash.toString("hex") + (address.workChain == 0 ? "00" : "ff"),
    "hex",
  );
}

export const ScriptBuilder = {
  opReturn: (data: Buffer) =>
    script.fromASM(`OP_RETURN ${data.toString("hex")}`),

  opCheckSig: (pubkey: Buffer) =>
    script.fromASM(`${pubkey.toString("hex")} OP_CHECKSIG`),

  opCheckSequenceVerify: (
    pubkey: Buffer,
    lock: number,
    useTimeFlag: boolean = true,
  ) => {
    const sequence = useTimeFlag ? applyTimeLockFlag(lock) : lock;
    return bitcoin.script.compile([
      bitcoin.script.number.encode(sequence),
      bitcoin.opcodes["OP_CHECKSEQUENCEVERIFY"],
      bitcoin.opcodes["OP_DROP"],
      pubkey,
      bitcoin.opcodes["OP_CHECKSIG"],
    ]);
  },
};

export function calcTapscriptMerkleRoot(
  tonAddress: Address,
  recoveryPubkey?: Buffer,
  csvLock?: number,
): Buffer {
  const { hash } = toHashTree(
    buildScriptTree(tonAddress, recoveryPubkey, csvLock ?? DEFAULT_CSV_LOCK),
  );
  return hash;
}

export function tweakInternalKey(internalKey: Buffer, tapMerkleRoot?: Buffer) {
  return tweakKey(toXOnly(internalKey), tapMerkleRoot)?.x;
}
