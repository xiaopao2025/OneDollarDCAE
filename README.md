# OneDollarDCAE

OneDollarDCAE is a cutting-edge decentralized finance (DeFi) smart contract built on Arbitrum. It empowers users to automate dollar-cost averaging (DCA) investments with USDC, while earning rewards in WETH through dynamic and transparent mechanisms. Designed for efficiency, scalability, and user engagement, OneDollarDCAE integrates advanced features like investment batching, token rewards, and burn mechanics to incentivize long-term participation.

## Introduction

OneDollarDCAE brings a unique approach to DeFi investments by automating tokenized dollar-cost averaging strategies. Users deposit USDC and participate in periodic investments into WETH, with rewards distributed via DCAE, a custom ERC-20 token. The contract includes features like dynamic reward distribution, customizable investment amounts, and burn mechanisms to foster long-term engagement.

With seamless integration of Uniswap V3 for swaps, accurate TWAP-based price feeds via oracles, and gas-efficient batch processing, this smart contract provides a secure, transparent, and rewarding platform for DeFi enthusiasts.

## Features

### 🏦 Automated Dollar-Cost Averaging
* Deposit USDC to participate in regular investments into WETH through investment batches
* Dynamic investment intervals to optimize participation and minimize fees

### 💸 DCAE Token Rewards
* Earn DCAE tokens based on your share of investments and reward ratios
* Reward distribution designed to incentivize active and consistent participation

### 🔥 Burn-to-Earn Mechanism
* Burn your DCAE tokens to claim WETH rewards, encouraging long-term token holding
* Rewards increase with token holding duration, up to 180 days

### 📊 Customizable Investment Options
* Set personalized investment amounts and reward ratios within predefined limits
* Fully transparent investment and reward distribution

### 🔒 Security and Gas Efficiency
* Integrates OpenZeppelin contracts for security best practices
* Batch-based investment processing for reduced gas costs
* Uses TWAP oracles to ensure fair and accurate pricing for token swaps

## Core Functionalities

### Deposit USDC
Users deposit USDC to participate in upcoming investment batches.
* Minimum deposit: 1 USDC
* Maximum deposit: 1000 USDC

### Batch Investments
USDC deposits from multiple users are grouped into batches for efficient WETH swaps using Uniswap V3.

### DCAE Minting
Users receive DCAE tokens proportional to their share of the batch's WETH investment, incentivizing continuous participation.

### Reward Burning
Burn DCAE tokens to claim WETH rewards based on token holding duration and participation history.

### Custom Investment Settings
* Adjust investment amounts (1–1000 USDC)
* Modify reward ratios (50–1000)

### Withdrawal Options
* Withdraw deposited USDC or accumulated WETH at any time

## Technology Stack

* **Solidity**: Smart contract programming
* **Uniswap V3**: Efficient token swaps
* **OpenZeppelin**: Industry-standard libraries for security
* **TWAP Oracle**: Accurate time-weighted average pricing

## Getting Started

### Prerequisites
* Node.js and npm
* Hardhat development environment
* Solidity compiler (0.8.28+)
* Ethereum wallet (e.g., MetaMask)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/your-repo/OneDollarDCAE.git
cd OneDollarDCAE
```

2. Install dependencies:
```bash
npm install
```

3. Compile the contracts:
```bash
npx hardhat compile
```

4. Run tests:
```bash
npx hardhat test
```

## Usage

### Deployment
To deploy the contract, update the constructor arguments in the deployment script and run:
```bash
npx hardhat run scripts/deploy.js --network <network_name>
```

### Interaction
Use a frontend or scripts to interact with the deployed contract:

Key Functions:
* `depositUSDC(uint256 amount)`
* `setInvestAmount(uint64 amount)`
* `setRewardRatio(uint16 amount)`
* `executeInvestment(uint256 batchNumber)`
* `burnForFee()`
* `withdrawUSDC()` and `withdrawWETH()`

### Example
**Contract Address**: [0xa87619defaa9b63f5d78ea69a4fbadea7341347e](https://arbiscan.io/address/0xa87619defaa9b63f5d78ea69a4fbadea7341347e)
**A simple frontend**: [https://dcaefront.vercel.app/](https://dcaefront.vercel.app/)

## Question
For significant question, open an issue to discuss it.

## License
This project is licensed under the MIT License. See the LICENSE file for details.

## Contact
For questions, suggestions, or feedback, reach out to:

Telegram: [t.me/xyz9418666](https://t.me/xyz9418666)
