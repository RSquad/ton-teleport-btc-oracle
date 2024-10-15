import { Address } from "@ton/core";
import {
  Psbt,
  type SignerAsync,
  initEccLib,
  networks,
  payments,
  script,
} from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { broadcast, waitUntilUTXO } from "./blockstream-utils.test";
import { FrostService } from "./frost.service";
import { type Taptree } from "bitcoinjs-lib/src/types";
import {
  buildScriptTree,
  calcTapscriptMerkleRoot,
  DEFAULT_CSV_LOCK,
  tweakInternalKey,
} from "./utils";

initEccLib(tinysecp as any);
const network = networks.testnet;

class FROSTSigner implements SignerAsync {
  // @ts-ignore
  publicKey: Buffer | undefined;
  network?: any;
  frost: FrostService;
  tapMerkleRoot: Buffer;
  scriptTree: Taptree;
  constructor(frost: FrostService, tonAddress: Address) {
    this.frost = frost;
    this.scriptTree = buildScriptTree(
      tonAddress,
      this.getInternalPubkey(),
      DEFAULT_CSV_LOCK,
    );
    const tapMerkleRoot = calcTapscriptMerkleRoot(
      tonAddress,
      this.getInternalPubkey(),
    );
    const pubkey = tweakInternalKey(this.getInternalPubkey(), tapMerkleRoot);
    this.publicKey = pubkey;
    this.network = network;
    this.tapMerkleRoot = tapMerkleRoot;
  }
  async sign(hash: Buffer, lowR?: boolean): Promise<Buffer> {
    lowR;
    console.log("sign hash", hash.toString("hex"));
    await this.frost.commit();
    const signingPackage = await this.frost.createSigningPackage(
      hash,
      this.tapMerkleRoot,
    );
    await this.frost.signMessage(signingPackage);
    const signature = await this.frost.aggregate();
    console.log("signature", signature.toString("hex"), signature.length);
    return signature.subarray(1);
  }

  async signSchnorr(hash: Buffer): Promise<Buffer> {
    return await this.sign(hash);
  }

  getPublicKey?(): Buffer {
    return <Buffer>this.publicKey;
  }

  getInternalPubkey(): Buffer {
    return this.frost.schnorrPubkey;
  }
}

describe("FrostService", () => {
  let frostService: FrostService;
  const expectedSignatureLength = 65;

  beforeEach(async () => {
    // const moduleRef = await Test.createTestingModule({
    //   providers: [FrostService],
    // }).compile();
    //
    frostService = new FrostService();
  });

  it("should generate same pubkeyPackage for all participants", async () => {
    await frostService.init();

    await frostService.generateKey();

    const maxSigners = frostService.getMaxSigners();

    const pubkeyPackages = frostService.pubkeyPackages;
    expect(frostService.keyPackages.size).toEqual(maxSigners);
    expect(pubkeyPackages.size).toEqual(maxSigners);

    const expected = pubkeyPackages.values().next().value;
    pubkeyPackages.forEach((pubkeyPackage) => {
      expect(pubkeyPackage).toStrictEqual(expected);
    });
  });

  it("should commit", async () => {
    await frostService.init();

    await frostService.generateKey();

    await frostService.commit();

    const minSigners = frostService.getMinSigners();
    expect(frostService.signingCommitments.size).toEqual(minSigners);
    expect(frostService.signingNonces.size).toEqual(minSigners);
  });

  it("should create signing message", async () => {
    await frostService.init();

    await frostService.generateKey();

    await frostService.commit();

    const message = Buffer.from("message to sign");
    const anotherMessage = Buffer.from("another message");

    const firstPackageSameMessage =
      await frostService.createSigningPackage(message);
    const secondPackageSameMessage =
      await frostService.createSigningPackage(message);
    const packageAnotherMessage =
      await frostService.createSigningPackage(anotherMessage);

    expect(firstPackageSameMessage).toStrictEqual(secondPackageSameMessage); // not sure
    expect(firstPackageSameMessage).not.toStrictEqual(packageAnotherMessage);
  });

  it("should sign message", async () => {
    await frostService.init();
    await frostService.generateKey();
    await frostService.commit();

    const message = Buffer.from("message to sign");
    const signingPackage = await frostService.createSigningPackage(message);

    const minSigners = frostService.getMinSigners();

    const signatureShares = await frostService.signMessage(signingPackage);

    expect(signatureShares.size).toEqual(minSigners);
    signatureShares.forEach((signatureShare) => {
      expect(signatureShare).toBeTruthy();
    });
  });
  it("should aggregate signature", async () => {
    await frostService.init();
    await frostService.generateKey();
    await frostService.commit();

    const message = Buffer.from("message to sign");
    const signingPackage = await frostService.createSigningPackage(message);

    await frostService.signMessage(signingPackage);

    const signature = await frostService.aggregate();

    expect(signature).toBeTruthy();
    const expectedSignatureLength = 65;
    expect(signature).toHaveLength(expectedSignatureLength);
  });
  it("signature verification", async () => {
    await frostService.init();
    await frostService.generateKey();
    await frostService.commit();

    const message = Buffer.from("message to sign");
    const signingPackage = await frostService.createSigningPackage(message);

    await frostService.signMessage(signingPackage);

    const signature = await frostService.aggregate();

    expect(await frostService.verify(message, signature)).toBeUndefined();
  });

  it("should sign with lesser participants than committed", async () => {
    await frostService.init();
    await frostService.generateKey();
    const commitsNumber = 4;
    const message = Buffer.from("message to sign");

    await frostService.commit(commitsNumber);

    const identifiers = new Map<number, string>();
    [1, 2, 3].forEach((idx) => {
      identifiers.set(idx, <string>frostService.getIdentifiers().get(idx));
    });

    const signingPackage = await frostService.createSigningPackage(
      message,
      undefined,
      identifiers,
    );

    await frostService.signMessage(signingPackage, identifiers);
    const signature = await frostService.aggregate(identifiers);

    expect(signature).toBeTruthy();
    expect(signature).toHaveLength(expectedSignatureLength);
  });

  it("should sign by any set of participants among committed (ids 2 3 4)", async () => {
    await frostService.init();
    await frostService.generateKey();
    const commitsNumber = 4;
    const message = Buffer.from("message to sign");

    await frostService.commit(commitsNumber);

    const identifiers = new Map<number, string>();
    [2, 3, 4].forEach((idx) => {
      identifiers.set(idx, <string>frostService.getIdentifiers().get(idx));
    });

    const signingPackage = await frostService.createSigningPackage(
      message,
      undefined,
      identifiers,
    );

    await frostService.signMessage(signingPackage, identifiers);
    const signature = await frostService.aggregate(identifiers);

    expect(signature).toBeTruthy();
    expect(signature).toHaveLength(expectedSignatureLength);
  });

  it("should sign by any set of participants among committed (ids 1 3 4)", async () => {
    await frostService.init();
    await frostService.generateKey();
    const commitsNumber = 4;
    const message = Buffer.from("message to sign");

    await frostService.commit(commitsNumber);

    const identifiers = new Map<number, string>();
    [1, 3, 4].forEach((idx) => {
      identifiers.set(idx, <string>frostService.getIdentifiers().get(idx));
    });

    const signingPackage = await frostService.createSigningPackage(
      message,
      undefined,
      identifiers,
    );

    await frostService.signMessage(signingPackage, identifiers);
    const signature = await frostService.aggregate(identifiers);

    expect(signature).toBeTruthy();
    expect(signature).toHaveLength(expectedSignatureLength);
  });

  it("should sign by any set of participants among committed (ids 1 2 4)", async () => {
    await frostService.init();
    await frostService.generateKey();
    const commitsNumber = 4;
    const message = Buffer.from("message to sign");

    await frostService.commit(commitsNumber);

    const identifiers = new Map<number, string>();

    [1, 2, 4].forEach((idx) => {
      identifiers.set(idx, <string>frostService.getIdentifiers().get(idx));
    });

    const signingPackage = await frostService.createSigningPackage(
      message,
      undefined,
      identifiers,
    );

    await frostService.signMessage(signingPackage, identifiers);
    const signature = await frostService.aggregate(identifiers);

    expect(signature).toBeTruthy();
    expect(signature).toHaveLength(expectedSignatureLength);
  });

  it.skip("Sign bitcoin taproot transaction", async () => {
    await frostService.init();
    await frostService.generateKey();
    const tonAddress = Address.parse(
      "0QAPBt1yVUndYKbKN0OsUy21J4nLFa8flD_patu0wahhVe_P",
    );
    const frostSigner = new FROSTSigner(frostService, tonAddress);
    console.log(
      "internalKey",
      frostSigner.getInternalPubkey().toString("hex"),
      frostSigner.getInternalPubkey().length,
    );
    // @ts-ignore
    console.log("tweakedKey", frostSigner.publicKey.toString("hex"));

    const p2pktr = payments.p2tr({
      internalPubkey: frostSigner.getInternalPubkey(),
      scriptTree: frostSigner.scriptTree,
      network,
    });
    const p2pktr_addr = p2pktr.address ?? "";
    console.log(
      `Waiting till UTXO is detected at this Address: ${p2pktr_addr}`,
    );

    const utxos = await waitUntilUTXO(p2pktr_addr);
    console.log(`Using UTXO ${utxos[0].txid}:${utxos[0].vout}`);

    const p2pkRedeem = {
      output: script.fromASM(
        `${frostSigner.getInternalPubkey().toString("hex")} OP_CHECKSIG`,
      ),
      redeemVersion: 192,
    };

    const p2pkScriptPath = payments.p2tr({
      internalPubkey: frostSigner.getInternalPubkey(),
      scriptTree: frostSigner.scriptTree,
      redeem: p2pkRedeem,
      network,
    });

    const psbt = new Psbt({ network });
    psbt.addInput({
      hash: utxos[0].txid,
      index: utxos[0].vout,
      witnessUtxo: { value: utxos[0].value, script: p2pktr.output! },
      tapInternalKey: p2pktr.internalPubkey!,
      tapLeafScript: [
        {
          leafVersion: p2pkRedeem.redeemVersion,
          script: p2pkRedeem.output,
          controlBlock:
            p2pkScriptPath.witness![p2pkScriptPath.witness!.length - 1],
        },
      ],
    });

    psbt.addOutput({
      address: "tb1qx6qzawgya324umgkqyqejhr2gj0hghp4mfk9nd",
      value: utxos[0].value - 150,
    });

    // @ts-ignore
    await psbt.signInputAsync(0, frostSigner);
    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    console.log(`Broadcasting Transaction Hex: ${tx.toHex()}`);
    const txid = await broadcast(tx.toHex());
    console.log(`Success! Txid is ${txid}`);
  }, 300000);
});
