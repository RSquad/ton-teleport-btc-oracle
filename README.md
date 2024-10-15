# @ton-teleport/oracle

This repo is an Oracle service designed for TON blockchain, specifically as part of the TON Teleport BTC system.

Key features include:
- _DKG:_ Enables secure and decentralized generation of aggregated keys among validators without the need for a trusted third party. This process ensures that private keys are never exposed or reconstructed at any single point.
- _FROST:_ Implements threshold signature schemes that allow a group of validators to create a joint signature on a transaction without revealing their individual private keys.

## Prerequisites

### Dependencies

Before you begin, ensure you have the following installed:
- Rust: [Install Rust](https://www.rust-lang.org/tools/install)
- Bun: [Install Bun](https://bun.sh/)

### Configuration

Create a .env file in the root directory of the project and add the following variables:

#### [TON HTTP API](https://github.com/toncenter/ton-http-api) Variables
`TON_CENTER_V2_ENDPOINT` — The endpoint for the TON HTTP API. Example:
```bash
TON_CENTER_V2_ENDPOINT=https://testnet.toncenter.com/api/v2
```
`TON_CENTER_API_KEY` — _(Optional)_ Your API key for the TON HTTP API. Example:
```bash
TON_CENTER_API_KEY=your_api_key_here
```

#### Contract Variables
`DKG_CHANNEL` — The address of the DKGChannel contract in TON. Example:
```bash
DKG_CHANNEL=EQDIEVARwkn6_4qNWeDlHwT40kzJBGIzKo4vcqRSvDUUS6bT
```

#### Key Storage
`KEYSTORE_DIR` — The directory for storing secret shares of generated keys. It’s important to store this securely for a significant period. Example:
```bash
KEYSTORE_DIR=/home/apps/oracle/data
```

#### Mode of Operation

The application can operate in two modes: _Regular Mode_ and _Standalone Mode_.
- _Regular Mode_: The application interacts with the TON blockchain and requires access to the validator’s keys and the Validator Engine Console.
- _Standalone Mode_: The application operates independently, simulating validator behavior without connecting to a real validator. This mode is useful for testing and development purposes.


`STANDALONE` — Values 1 or 0. Indicates whether the application is launched in standalone mode. Example:
```bash
STANDALONE=0
```

#### Variables for Regular Mode
If `STANDALONE=0`, set the following variables:

`SERVER_PUBLIC_KEY_PATH` —  Path to the validator’s public key. Example:
```bash
SERVER_PUBLIC_KEY_PATH=/path/to/public/key
```
`CLIENT_PRIVATE_KEY_PATH` — Path to the validator’s private key. Example:
```bash
CLIENT_PRIVATE_KEY_PATH=/path/to/private/key
```
`VALIDATOR_ENGINE_CONSOLE_PATH` — Path to the [Validator Engine Console](https://github.com/ton-blockchain/ton/tree/master/validator-engine-console). Example:
```bash
VALIDATOR_ENGINE_CONSOLE_PATH=/path/to/validator-engine-console
```

#### Variables for Standalone Mode
If `STANDALONE=1`, set the following variables:

`STANDALONE_MAX_SIGNERS` —  Maximum number of validators. Example:
```bash
STANDALONE_MAX_SIGNERS=3
```
`STANDALONE_MIN_SIGNERS` — Minimum number of validators. Example:
```bash
STANDALONE_MIN_SIGNERS=2
```
`STANDALONE_VALIDATOR_PUBKEY` — Validator’s public key. **Important!** Must be loaded into the DKGChannel contract. Example:
```bash
STANDALONE_VALIDATOR_PUBKEY=your_validator_public_key
```
`STANDALONE_VALIDATOR_SECRET` — Validator’s secret key. Example:
```bash
STANDALONE_VALIDATOR_SECRET=your_validator_secret_key
```

## Installation
1. Clone the repository 
```bash
git clone git@github.com:RSquad/ton-teleport-btc-oracle.git
cd ton-teleport-btc-oracle
```
2. Install dependencies
```bash
bun install
```

## Scripts
- Start the service for production
```bash
bun run start
```
- Development mode with watch
```bash
bun run dev
```
- Build the project (not recommended for usage, use `bun run start` instead)
```bash
bun run build
```
- Start the service
```bash
bun run start
```
- Build the FROST module
```bash
bun run build:frost
```
- Run tests
```bash
bun run test
```
- Run tests for FROST module
```bash
bun run test:frost
```