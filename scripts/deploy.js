const hre = require("hardhat");

async function main() {
  // Get the contract factories
  const Oracle = await hre.ethers.getContractFactory("Oracle");
  const OneDollarDCAE = await hre.ethers.getContractFactory("OneDollarDCAE");

  // Get network specific addresses
  let UNISWAP_FACTORY, USDC, WETH, UNISWAP_ROUTER;

  // Set addresses based on network
  if (hre.network.name === "arbitrum") {
    UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  } else if (hre.network.name === "localhost") {
    UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  } else {
    throw new Error("Please set addresses for the current network");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Deploy Oracle
  console.log("Deploying Oracle...");
  const oracle = await Oracle.deploy(
    UNISWAP_FACTORY,
    USDC,
    WETH
  );
  
  // Wait for Oracle deployment
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("Oracle deployed to:", oracleAddress);

  // Deploy OneDollarDCAE
  console.log("Deploying OneDollarDCAE...");
  const oneDollarDCAE = await OneDollarDCAE.deploy(
    USDC,
    WETH,
    oracleAddress,
    UNISWAP_ROUTER
  );
  
  // Wait for OneDollarDCAE deployment
  await oneDollarDCAE.waitForDeployment();
  const oneDollarDCAEAddress = await oneDollarDCAE.getAddress();
  console.log("OneDollarDCAE deployed to:", oneDollarDCAEAddress);

  // Get DCAE token address
  const dcaeAddress = await oneDollarDCAE.dcaeToken();

  // Print all addresses for verification
  console.log("\nDeployed Contract Addresses:");
  console.log("--------------------------");
  console.log("DCAE Token:", dcaeAddress);
  console.log("Oracle:", oracleAddress);
  console.log("OneDollarDCAE:", oneDollarDCAEAddress);

  // Wait for additional confirmations
  //console.log("\nWaiting for additional confirmations...");
  
  // Get the deployment transaction receipt
  //const oracleDeploymentReceipt = await oracle.deploymentTransaction().wait(5);
  //const oneDollarDCAEDeploymentReceipt = await oneDollarDCAE.deploymentTransaction().wait(5);
  
  console.log("Deployment completed and confirmed!");

  // Verification section (commented out for now)
  /*
  if (hre.network.name !== "localhost") {
    console.log("\nVerifying contracts on Etherscan...");
    try {
      await hre.run("verify:verify", {
        address: oracleAddress,
        constructorArguments: [UNISWAP_FACTORY, USDC, WETH],
      });

      await hre.run("verify:verify", {
        address: oneDollarDCAEAddress,
        constructorArguments: [USDC, WETH, oracleAddress, UNISWAP_ROUTER],
      });

      await hre.run("verify:verify", {
        address: dcaeAddress,
        constructorArguments: [],
      });
    } catch (error) {
      console.error("Error verifying contracts:", error);
    }
  }
  */
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
  //npx hardhat run scripts/deploy.js --network localhost