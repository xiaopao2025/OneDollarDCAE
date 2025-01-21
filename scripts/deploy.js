const hre = require("hardhat");

async function main() {
  // Mainnet addresses for constructor parameters
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";  // USDC on Ethereum mainnet
  const WSTETH_ADDRESS = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"; // wstETH on Ethereum mainnet
  const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";     // Uniswap V3 Quoter
  const SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";   // Uniswap V3 SwapRouter

  console.log("Starting deployment...");

  // Get the contract factory
  const OneDollarDCAE = await hre.ethers.getContractFactory("OneDollarDCAE");

  // Deploy the contract
  console.log("Deploying OneDollarDCAE...");
  const dca = await OneDollarDCAE.deploy(
    USDC_ADDRESS,
    WSTETH_ADDRESS,
    QUOTER_V2,
    SWAP_ROUTER
  );

  // Wait for deployment to finish
  await dca.waitForDeployment();

  // Get the deployed contract address
  const dcaAddress = await dca.getAddress();
  console.log("OneDollarDCAE deployed to:", dcaAddress);

  // Get the DCAE token address
  const dcaeTokenAddress = await dca.dcaeToken();
  console.log("DCAE Token deployed to:", dcaeTokenAddress);

  

  console.log("Deployment completed!");
}

// Execute deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });