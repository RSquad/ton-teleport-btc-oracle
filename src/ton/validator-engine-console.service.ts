import { exec } from "child_process";
import {
  type BaseCommandParams,
  DEFAULT_VERBOSITY_LEVEL,
  type IValidatorEngineConsole,
  type ValidatorEngineCommand,
  type ValidatorEngineConfig,
  type ValidatorKeysResponse,
} from "./types";

export class ValidatorEngineConsoleService implements IValidatorEngineConsole {
  baseCommandParams: BaseCommandParams;

  constructor(
    readonly validatorEngineConsolePath: string,
    readonly serverPublicKeyPath: string,
    readonly clientPrivateKeyPath: string,
    readonly serverAddress: string,
  ) {
    this.baseCommandParams = {
      p: this.serverPublicKeyPath,
      k: this.clientPrivateKeyPath,
      a: this.serverAddress,
      v: DEFAULT_VERBOSITY_LEVEL,
    };
  }

  public async sign(validatorPublicKey: string, hash: string): Promise<string> {
    const params: ValidatorEngineCommand = {
      ...this.baseCommandParams,
      c: `sign ${validatorPublicKey} ${hash}`,
    };

    const result = await this.runCmd(params);

    return this.extractSignature(result!);
  }

  public async getValidatorPublicKey(timestamp: number): Promise<string> {
    const config = await this.getValidatorConfig();

    const sortedValidators = config.validators.sort(
      (a, b) => b.election_date - a.election_date,
    );

    for (const validator of sortedValidators) {
      const validatorId = validator.id;
      const validatorKey = this._base64ToHex(validatorId).toUpperCase();

      if (
        validator.election_date < timestamp &&
        timestamp < validator.expire_at
      ) {
        return validatorKey;
      }
    }

    throw new Error(
      "GetValidatorKey error: validator key not found. Are you sure you are a validator?",
    );
  }

  public async exportPub(validatorIdBase64: string): Promise<string> {
    const validatorKey = this._base64ToHex(validatorIdBase64);
    const params: ValidatorEngineCommand = {
      ...this.baseCommandParams,
      c: `exportpub ${validatorKey}`,
    };

    const result = await this.runCmd(params);
    const base64Result = this.extractPublicKey(result!);

    return this._base64ToHex(base64Result);
  }

  public async getValidatorConfig(): Promise<ValidatorEngineConfig> {
    const params: ValidatorEngineCommand = {
      ...this.baseCommandParams,
      c: `getconfig`,
    };

    const result = await this.runCmd(params);
    return this.extractJson(result!);
  }

  public async getValidatorKeys(): Promise<ValidatorKeysResponse> {
    const cfg = await this.getValidatorConfig();
    const validatorKeys: any = [];
    const validatorIds: any = [];
    for (const val of cfg.validators) {
      const valId = await this.exportPub(val.id);
      validatorKeys.push(valId.slice(8));
      validatorIds.push(this._base64ToHex(val.id));
    }
    return { validatorKeys, validatorIds };
  }

  private _buildCommand(
    executable: string,
    parameters: ValidatorEngineCommand,
  ): string {
    const args = Object.entries(parameters).map(([key, value]) => {
      const needsQuotes = /\s/.test(value) || /["'`]/.test(value);
      const escapedValue = needsQuotes
        ? `"${value.replace(/(["\\])/g, "\\$1")}"`
        : value;
      return `-${key} ${escapedValue}`;
    });

    return `${executable} ${args.join(" ")}`;
  }

  private extractSignature(output: string): string {
    const regex = /got signature\s+([A-Za-z0-9+/=]+)/;
    const match = output.match(regex);
    if (!match) {
      throw new Error(`Error parse result`);
    }

    return match[1];
  }

  private extractPublicKey(output: string): string {
    const regex = /got public key:\s*([A-Za-z0-9+/=]+)/;
    const match = output.match(regex);
    if (!match) {
      throw new Error(`Error parse result`);
    }

    return match[1];
  }

  private extractJson(output: string): ValidatorEngineConfig {
    const regex = /-+[\r\n]+([\s\S]*?)[\r\n]+-+/;
    const match = output.match(regex);
    if (!match) {
      throw new Error(`Error parse result`);
    }

    return JSON.parse(match[1].trim());
  }

  private async runCmd(params: ValidatorEngineCommand) {
    const command = this._buildCommand(
      `${this.validatorEngineConsolePath}/validator-engine-console`,
      params,
    );

    try {
      return await this.executeCommand(command);
    } catch (error) {
      throw new Error(`Error run cmd ${error}`);
    }
  }

  private executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(`Execute Command Error: ${error.message}`);
          return;
        }
        if (stderr) {
          reject(`Stderr: ${stderr}`);
          return;
        }
        resolve(stdout);
      });
    });
  }

  private _base64ToHex(id: string): string {
    return Buffer.from(id, "base64").toString("hex");
  }
}
