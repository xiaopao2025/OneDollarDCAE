require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 从.env文件中获取环境变量
//const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
//const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      },
      {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      }
    ]
  },
  
  networks: {
    // Hardhat本地网络配置
    hardhat: {
      forking: {
        url: `https://cloudflare-eth.com`,
        blockNumber: 21694444 // 指定要fork的区块高度
      },
      chainId: 1337,
      gasPrice: "auto",
      initialBaseFeePerGas: 0,
      accounts:{
        count: 51
      }
    },
    
    // 本地开发网络
    //localhost: {
    //  url: "http://127.0.0.1:8545"
   // },
    
    // Sepolia测试网络
    //sepolia: {
    ///  url: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    //  accounts: [`0x${PRIVATE_KEY}`]
    //},
    
    // 主网配置
    //mainnet: {
    //  url: `https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_API_KEY}`,
    //  accounts: [`0x${PRIVATE_KEY}`]
    //}
  },
  
  // Etherscan验证配置
  etherscan: {
    apiKey: ETHERSCAN_API_KEY
  },
  
  // 测试配置
  mocha: {
    timeout: 100000000
  }
};