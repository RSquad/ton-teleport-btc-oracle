# @ton-teleport-btc/oracle

This repository is an Oracle service designed for the TON blockchain, specifically as part of the TON Teleport BTC system.

## Key Features

- **DKG:** Enables secure and decentralized generation of aggregated keys among validators without the need for a trusted third party. This process ensures that private keys are never exposed or reconstructed at any single point.
- **FROST:** Implements threshold signature schemes that allow a group of validators to create a joint signature on a transaction without revealing their individual private keys.

## Prerequisites

### Dependencies

Before you begin, ensure you have the following installed:

- **Rust:** [Install Rust](https://www.rust-lang.org/tools/install)
- **Bun:** [Install Bun](https://bun.sh/)

### Configuration

Create a `.env` file in the root directory of the project and add the following variables:

#### [TON HTTP API](https://github.com/toncenter/ton-http-api) Variables

- `TON_CENTER_V2_ENDPOINT` — The endpoint for the TON HTTP API. Example:
    ```bash
    TON_CENTER_V2_ENDPOINT=https://testnet.toncenter.com/api/v2
    ```
- `TON_CENTER_API_KEY` — _(Optional)_ Your API key for the TON HTTP API. Example:
    ```bash
    TON_CENTER_API_KEY=your_api_key_here
    ```

#### Contract Variables

- `COORDINATOR` — The address of the Coordinator contract in TON. Example:
    ```bash
    COORDINATOR=EQDIEVARwkn6_4qNWeDlHwT40kzJBGIzKo4vcqRSvDUUS6bT
    ```

#### Key Storage

- `KEYSTORE_DIR` — The directory for storing secret shares of generated keys. It’s important to store this securely for a significant period. Example:
    ```bash
    KEYSTORE_DIR=/home/apps/oracle/data
    ```

  **Note:** When running the application using Docker, Docker provides write permissions only to the `/home` directory and mounted directories by default.

#### Mode of Operation

The application can operate in two modes: **Regular Mode** and **Standalone Mode**.

- **Regular Mode:** The application interacts with the TON blockchain and requires access to the validator’s keys and the Validator Engine Console.
- **Standalone Mode:** The application operates independently, simulating validator behavior without connecting to a real validator. This mode is useful for testing and development purposes.

- `STANDALONE` — Values `1` or `0`. Indicates whether the application is launched in standalone mode. Example:
    ```bash
    STANDALONE=0
    ```

#### Variables for Regular Mode

If `STANDALONE=0`, set the following variables:

- `SERVER_PUBLIC_KEY_PATH` — Path to the validator’s public key. Example:
    ```bash
    SERVER_PUBLIC_KEY_PATH=/path/to/certs/server.pub
    ```
- `CLIENT_PRIVATE_KEY_PATH` — Path to the validator’s private key. Example:
    ```bash
    CLIENT_PRIVATE_KEY_PATH=/path/to/certs/client
    ```
- `VALIDATOR_ENGINE_CONSOLE_PATH` — Path to the [Validator Engine Console](https://github.com/ton-blockchain/ton/tree/master/validator-engine-console). Example:
    ```bash
    VALIDATOR_ENGINE_CONSOLE_PATH=/path/to/validator-engine-console
    ```
- `VALIDATOR_SERVER_ADDRESS` — Address of the validator’s server. Example:
    ```bash
    VALIDATOR_SERVER_ADDRESS=127.0.0.1:4441
    ```

#### Variables for Standalone Mode

If `STANDALONE=1`, set the following variables:

- `STANDALONE_MAX_SIGNERS` — Maximum number of validators. Example:
    ```bash
    STANDALONE_MAX_SIGNERS=3
    ```
- `STANDALONE_MIN_SIGNERS` — Minimum number of validators. Example:
    ```bash
    STANDALONE_MIN_SIGNERS=2
    ```
- `STANDALONE_VALIDATOR_PUBKEY` — Validator’s public key. **Important!** Must be loaded into the DKGChannel contract. Example:
    ```bash
    STANDALONE_VALIDATOR_PUBKEY=your_validator_public_key
    ```
- `STANDALONE_VALIDATOR_SECRET` — Validator’s secret key. Example:
    ```bash
    STANDALONE_VALIDATOR_SECRET=your_validator_secret_key
    ```

## Installation

1. **Clone the Repository**
    ```bash
    git clone git@github.com:RSquad/ton-teleport-btc-oracle.git
    cd ton-teleport-btc-oracle
    ```

2. **Install Dependencies**
    ```bash
    bun install
    ```

## Getting Started

Follow these steps to set up and run the Oracle service:

1. **Installation**
    - Follow the instructions in the **Installation** section above.

2. **Build the FROST Module**
    ```bash
    bun run build:frost
    ```

3. **Start the Service**
    ```bash
    bun start
    ```

## Scripts

- **Start the service for production**
    ```bash
    bun run start
    ```

- **Development mode with watch**
    ```bash
    bun run dev
    ```

- **Build the project** _(not recommended for usage, use `bun run start` instead)_
    ```bash
    bun run build
    ```

- **Build the FROST module**
    ```bash
    bun run build:frost
    ```

- **Run tests**
    ```bash
    bun run test
    ```

- **Run tests for FROST module**
    ```bash
    bun run test:frost
    ```

## Running with Docker

To run the Oracle service using Docker, follow these steps:

1. **Configure Environment Variables**

   Ensure all necessary environment variables are set in the `.env` file or pass them directly when running the Docker container.

2. **Build the Docker Image**
    ```bash
    docker build -t ton-teleport-btc-oracle .
    ```

3. **Run the Docker Container**
    ```bash
    docker run -d \
        --name ton-teleport-btc-oracle \
        -v /path/to/keystore:<KEYSTORE_DIR> \
        ton-teleport-btc-oracle
    ```

   **Parameters:**
    - `-v /path/to/keystore:<KEYSTORE_DIR>`: Mounts the host directory `/path/to/keystore` to the container's `KEYSTORE_DIR` to ensure the application has write permissions.
    - `-e`: Sets the necessary environment variables. Add or replace the example values with your actual configuration.
    - You can skip specifying environments when starting docker if you filled them in the _.env_ file.

4. **Verify the Container is Running**
    ```bash
    docker ps
    ```
   You should see `ton-teleport-btc-oracle` listed as a running container.

5. **Access Logs (Optional)**
    ```bash
    docker logs -f ton-teleport-btc-oracle
    ```
   This command streams the logs from the running container, which is useful for monitoring and debugging.

## Additional Notes

- Ensure that the mounted `KEYSTORE_DIR` has appropriate permissions and is secure, as it contains sensitive key material.
- If running via Docker, `KEYSTORE_DIR` must be located within the `/home` directory to maintain write permissions.
- Update environment variables as needed to match your deployment environment and configuration requirements.
- Refer to the [Docker Documentation](https://docs.docker.com/) for more details on Docker commands and best practices.