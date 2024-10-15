import { Logger } from "../src/base/logger.service";
//eslint-disable-next-line @typescript-eslint/no-var-requires
const frost = require("../frost.node");

export type TReceivedPackage = {
  identifier: string;
  package: Buffer;
};

export class FrostService {
  private readonly logger = new Logger(FrostService.name);
  // Temporary map for all-in-one oracle test
  private tmpIdentifiers = new Map<number, string>();
  private round1Secrets = new Map<string, string>();
  private round2Secrets = new Map<string, string>();
  // recevier => (sender -> package)
  private receivedPart1Packages = new Map<string, Buffer>();
  private receivedPart2Packages = new Map<string, Map<string, Buffer>>();
  keyPackages = new Map<string, Buffer>();
  pubkeyPackages = new Map<string, Buffer>();
  signingCommitments = new Map<string, Buffer>();
  signingNonces = new Map<string, string>();
  // @ts-ignore
  signingPackage: Buffer;
  // @ts-ignore
  publicKeyPackage: Buffer;
  signatureShares = new Map<string, Buffer>();
  private maxSigners = 5;
  private minSigners = 3;
  private commitsNumber = this.minSigners;

  getMaxSigners(): number {
    return this.maxSigners;
  }

  getMinSigners(): number {
    return this.minSigners;
  }

  getIdentifiers(): Map<number, string> {
    return this.tmpIdentifiers;
  }

  get schnorrPubkey(): Buffer {
    return frost.getSchnorrPubkey(this.publicKeyPackage) as Buffer;
  }

  private static mapToArray(map: Map<string, Buffer>): TReceivedPackage[] {
    const packages: TReceivedPackage[] = [];
    map.forEach((value, key) => {
      packages.push({ identifier: key, package: value });
    });
    return packages;
  }

  async generateKey() {
    for (let i = 1; i <= this.maxSigners; i++) {
      const part1Package = await this.doPart1(i);
      this.broadcastRound1Package(i, part1Package);
    }
    await this.receiveRound1Packages();

    for (let i = 1; i <= this.maxSigners; i++) {
      const round2Packages = await this.doPart2(i);
      this.sendRound2Packages(i, round2Packages);
    }
    await this.receiveRound2Packages();

    for (let i = 1; i <= this.maxSigners; i++) {
      await this.doPart3(i);
    }
  }

  async commit(commitsNumber?: number) {
    this.signingCommitments.clear();
    this.signingNonces.clear();
    this.signatureShares.clear();
    commitsNumber = commitsNumber ?? this.commitsNumber;
    for (let i = 1; i <= commitsNumber; i++) {
      await this.doCommit(i);
    }
  }

  async createSigningPackage(
    message: Buffer,
    tapMerkleRoot?: Buffer,
    identifiers?: Map<number, string>,
  ) {
    let signingCommitments = new Map<string, Buffer>();
    if (identifiers) {
      // @ts-ignore
      for (const identifier of identifiers) {
        signingCommitments.set(
          identifier[1],
          // @ts-ignore
          this.signingCommitments.get(identifier[1]),
        );
      }
    } else {
      signingCommitments = this.signingCommitments;
    }
    const signingCommitmentsArray = FrostService.mapToArray(signingCommitments);
    const result = frost.createSigningPackage(
      signingCommitmentsArray,
      message,
      tapMerkleRoot,
    );
    this.signingPackage = result;
    return result;
  }

  async signMessage(signingPackage: Buffer, identifiers?: Map<number, string>) {
    const signingIdentifiers = identifiers ?? this.tmpIdentifiers;
    let count = 0;
    // @ts-ignore
    for (const identifier of signingIdentifiers) {
      if (count < this.minSigners) {
        await this.doSignMessage(signingPackage, identifier[1]);
        count++;
      } else {
        break;
      }
    }
    return this.signatureShares;
  }

  private saveRound1Secret(identifier: string, secret: string) {
    this.round1Secrets.set(identifier, secret);
  }
  private saveRound2Secret(identifier: string, secret: string) {
    this.round2Secrets.set(identifier, secret);
  }

  private async broadcastRound1Package(fromId: number, part1Package: Buffer) {
    const fromIdentifier = this.tmpIdentifiers.get(fromId);
    // Every other Id receives a package from fromId
    // @ts-ignore
    this.receivedPart1Packages.set(fromIdentifier, part1Package);
  }

  private async sendRound2Packages(
    fromId: number,
    packages: TReceivedPackage[],
  ) {
    const fromIdentifier = this.tmpIdentifiers.get(fromId);
    // Emulate sending of round2 packages.
    for (const pack of packages) {
      const receivedPackages =
        this.receivedPart2Packages.get(pack.identifier) ??
        new Map<string, Buffer>();
      // Add package from fromId oracle
      // @ts-ignore
      receivedPackages.set(fromIdentifier, pack.package);
      this.receivedPart2Packages.set(pack.identifier, receivedPackages);
    }
  }

  // TODO read contract state and extract packages.
  // For now, all packages already "received" in broadcastRound1Package
  private async receiveRound1Packages() {}

  private async receiveRound2Packages() {}

  private async doPart1(i: number): Promise<Buffer> {
    const identifier = this.tmpIdentifiers.get(i);
    const result = frost.dkgPart1(identifier, this.maxSigners, this.minSigners);
    // @ts-ignore
    this.saveRound1Secret(identifier, result.secretPackagePtr);
    return result.packageBuffer;
  }

  // @ts-ignore
  private async doPart2(i: number): Promise<TReceivedPackage[]> {
    const identifier: string | undefined = this.tmpIdentifiers.get(i);

    if (identifier != undefined) {
      const myPackage = this.receivedPart1Packages.get(identifier);

      this.receivedPart1Packages.delete(identifier);

      const packages = FrostService.mapToArray(this.receivedPart1Packages);
      const result = frost.dkgPart2(
        this.round1Secrets.get(identifier),
        packages,
      );
      if (myPackage) {
        this.receivedPart1Packages.set(identifier, myPackage);
      }
      this.saveRound2Secret(identifier, result.secretPtr);
      return result.round2Packages as TReceivedPackage[];
    }
  }

  private async doPart3(i: number) {
    const identifier: string | undefined = this.tmpIdentifiers.get(i);
    if (identifier != null) {
      const iPackage = this.receivedPart1Packages.get(identifier);

      this.receivedPart1Packages.delete(identifier);

      const round1Packages = FrostService.mapToArray(
        this.receivedPart1Packages,
      );
      const round2Packages = FrostService.mapToArray(
        // @ts-ignore
        this.receivedPart2Packages.get(identifier),
      );
      const secretPackage = this.round2Secrets.get(identifier);
      const result = frost.dkgPart3(
        secretPackage,
        round1Packages,
        round2Packages,
      );
      if (iPackage) {
        this.receivedPart1Packages.set(identifier, iPackage);
      }
      this.keyPackages.set(identifier, result.keyPackage);
      this.pubkeyPackages.set(identifier, result.publicKeyPackage);
      this.publicKeyPackage = result.publicKeyPackage;
    }
  }

  private async doCommit(i: number) {
    const identifier: string | undefined = this.tmpIdentifiers.get(i);
    if (identifier != null) {
      const result = frost.commit(this.keyPackages.get(identifier));
      this.signingCommitments.set(identifier, result.signingCommitments);
      this.signingNonces.set(identifier, result.signingNonce);
      return result;
    }
  }

  private async doSignMessage(signingPackage: Buffer, identifier: string) {
    const result = frost.sign(
      signingPackage,
      this.signingNonces.get(identifier),
      this.keyPackages.get(identifier),
    );
    this.signatureShares.set(identifier, result);
  }

  async aggregate(identifiers?: Map<number, string>): Promise<Buffer> {
    let signatureShares = new Map<string, Buffer>();
    if (identifiers) {
      identifiers.forEach((identifier) => {
        // @ts-ignore
        signatureShares.set(identifier, this.signatureShares.get(identifier));
      });
    } else {
      signatureShares = this.signatureShares;
    }
    const sigShares = FrostService.mapToArray(signatureShares);
    const result = frost.aggregate(
      this.signingPackage,
      sigShares,
      this.publicKeyPackage,
    );

    return result;
  }

  async verify(message: Buffer, signature: Buffer, tapMerkleRoot?: Buffer) {
    frost.verify(this.publicKeyPackage, message, signature, tapMerkleRoot);
  }

  async init() {
    // Each oracle must create its own identifier
    for (let i = 1; i <= this.maxSigners; i++) {
      this.tmpIdentifiers.set(
        i,
        frost.deriveIdentifier(Buffer.from(i.toString())),
      );
    }
  }
}
