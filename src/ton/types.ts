export type BaseCommandParams = {
  p: string;
  k: string;
  a: string;
  v: string;
};
export type ValidatorEngineCommand =
  | BaseCommandParams
  | {
      c: string;
    };
export const DEFAULT_VERBOSITY_LEVEL = "0";

export interface IValidatorEngineConsole {
  sign(validatorPublicKey: string, hash: string): Promise<string>;
  getValidatorPublicKey(timestamp: number): Promise<string>;
  getValidatorConfig(): Promise<ValidatorEngineConfig>;
}
export interface ValidatorTempKey {
  "@type": "engine.validatorTempKey";
  "key": string;
  "expire_at": number;
}

export interface ValidatorAdnlAddress {
  "@type": "engine.validatorAdnlAddress";
  "id": string;
  "expire_at": number;
}

export interface Validator {
  "@type": "engine.validator";
  "id": string;
  "temp_keys": ValidatorTempKey[];
  "adnl_addrs": ValidatorAdnlAddress[];
  "election_date": number;
  "expire_at": number;
}

export interface ValidatorEngineConfig {
  "@type": "engine.validator.config";
  "out_port": number;
  "validators": Validator[];
}
