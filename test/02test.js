const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const erc20abi = require('erc-20-abi');
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { addresses } = require("./address.json");
const { swaprouterabi } = require("./swaprouter.json");

describe("OneDollarDCAE Contract - Mass User Scenario", function () {
    const USER_COUNT = 50;
    const USDC_AMOUNT = ethers.parseUnits("1000", 6); // 1000 USDC per user
    const MIN_INVEST_AMOUNT = ethers.parseUnits("1", 6); // 1 USDC
    
    let owner, users, oracle, dcae, dcaeTokenContract, usdcToken, wETHToken, swapRouter;
    let totalInitialDeposit = 0n;
    
    before(async function () {
        // Increase timeout for large number of users
        this.timeout(500000);
        
        // Generate multiple users
        [owner, ...users] = await ethers.getSigners();

        console.log("owner",owner.address);
        for(i=0;i<users.length;i++) {
            console.log("user ",i,users[i].address);
        }
        
        // Initialize tokens and contracts
        usdcToken = new ethers.Contract(addresses.usdc, erc20abi, ethers.provider);
        wETHToken = new ethers.Contract(addresses.wETH, erc20abi, ethers.provider);
        swapRouter = new ethers.Contract(addresses.swaprouter, swaprouterabi, ethers.provider);
        
        // Deploy Oracle
        const Oracle = await ethers.getContractFactory("Oracle");
        oracle = await Oracle.deploy(
            addresses.factory,
            addresses.usdc,
            addresses.wETH
        );
        await oracle.waitForDeployment();
        const oracleAddress = await oracle.getAddress();
        
        // Deploy DCA Contract
        const OneDollarDCAE = await ethers.getContractFactory("OneDollarDCAE");
        dcae = await OneDollarDCAE.deploy(
            addresses.usdc,
            addresses.wETH,
            oracleAddress,
            addresses.swaprouter
        );
        await dcae.waitForDeployment();
        const dcaeAddress = await dcae.getAddress();
        console.log("dcae address:",dcaeAddress);
        
        // Get DCAE Token Contract
        const dcaeTokenAddress = await dcae.dcaeToken();
        dcaeTokenContract = new ethers.Contract(
            dcaeTokenAddress,
            erc20abi,
            ethers.provider
        );
        
        // Helper function for ETH to USDC swap
        const swapETHForUSDC = async (signer) => {
            const params = {
                tokenIn: addresses.WETH9,
                tokenOut: addresses.usdc,
                fee: 3000,
                recipient: signer.address,
                deadline: Math.floor(Date.now() / 1000) + 60 * 10,
                amountIn: ethers.parseEther("1"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            };

            const tx = await swapRouter.connect(signer).exactInputSingle(
                params,
                { value: ethers.parseEther("1") }
            );
            await tx.wait();
        };
        
        // Prepare users with USDC and approvals
        console.log("Preparing users with USDC and approvals...");
        for (let i = 0; i < USER_COUNT; i++) {
            await swapETHForUSDC(users[i]);
            await usdcToken.connect(users[i]).approve(dcaeAddress, USDC_AMOUNT);
            
            // Deposit varying amounts for more realistic scenario
            const depositAmount = MIN_INVEST_AMOUNT * BigInt(Math.floor(Math.random() * 20) + 100);
            await dcae.connect(users[i]).depositUSDC(depositAmount);
            //console.log("user %s deposited %s",users[i].address,depositAmount);
            totalInitialDeposit += depositAmount;
            
            //if (i % 20 === 0) console.log(`Prepared ${i} users...`);
        }
        console.log("All users prepared!");
    });
    
    describe("Mass Deposit Validation", function () {
        it("Validates all user deposits", async function () {
            for (let user of users) {
                const userInfo = await dcae.userInfo(user.address);
                //console.log("user s% is %s",user.address,userInfo.exists);
                expect(userInfo.exists).to.be.true;
                expect(userInfo.balance).to.be.gt(0);
            }
        });
    });
    
    describe("Batch Investment Execution", function () {
        it("Executes investments for all users with gas tracking", async function () {
            
            const gasUsagePerUser = [];
            let totalWETHReceived = 0n;
            let totalDCAETokensMinted = 0n;
            
            for (let i = 0; i < USER_COUNT; i++) {
                await time.increase(86401); // Pass investment interval
                //console.log("user ", users[i].address," is executeInvestment")
                const tx = await dcae.connect(users[i]).executeInvestment(0);
                //console.log("user ", users[i].address," is successful")
                const receipt = await tx.wait();
                
                // Track gas usage
                gasUsagePerUser.push(receipt.gasUsed);
                
                const userInfo = await dcae.userInfo(users[i].address);
                const dcaeTokenBalance = await dcaeTokenContract.balanceOf(users[i].address);
                
                // Validate investment results
                expect(userInfo.wETH).to.be.gt(0);
                expect(dcaeTokenBalance).to.be.gt(0);
                
                totalWETHReceived += userInfo.wETH;
                totalDCAETokensMinted += dcaeTokenBalance;
            }
            
            // Statistical analysis of gas usage
            const avgGas = gasUsagePerUser.reduce((a, b) => a + b, 0n) / BigInt(USER_COUNT);
            const maxGas = gasUsagePerUser.reduce((a, b) => a > b ? a : b, 0n);
            const minGas = gasUsagePerUser.reduce((a, b) => a < b ? a : b, Infinity);
            
            console.log(`Gas Usage Statistics:`);
            console.log(`Average Gas per User: ${avgGas}`);
            console.log(`Max Gas Used: ${maxGas}`);
            console.log(`Min Gas Used: ${minGas}`);
            console.log(`Total wETH Received: ${totalWETHReceived}`);
            console.log(`Total DCAE Tokens Minted: ${totalDCAETokensMinted}`);
        });
    });
    
    describe("Multi-User Withdrawal Scenarios", function () {
        it("Allows sequential USDC and wETH withdrawals", async function () {
            // Withdraw in batches to simulate real-world scenarios
            const batchSize = 25;
            for (let i = 0; i < USER_COUNT; i += batchSize) {
                const batchUsers = users.slice(i, i + batchSize);
                
                for (let user of batchUsers) {
                    const initialUSDCBalance = await usdcToken.balanceOf(user.address);
                    const initialWETHBalance = await wETHToken.balanceOf(user.address);
                    await dcae.connect(user).withdrawUSDC();
                    await dcae.connect(user).withdrawWETH();
                    
                    const finalUSDCBalance = await usdcToken.balanceOf(user.address);
                    const finalWETHBalance = await wETHToken.balanceOf(user.address);
                    
                    expect(finalUSDCBalance).to.be.gt(initialUSDCBalance);
                    expect(finalWETHBalance).to.be.gt(initialWETHBalance);
                }
            }
        });
    });
    
    describe("Fee Distribution Validation", function () {
        it("Validates DCAE token burning mechanism", async function () {
            const burnResults = [];
            
            for (let user of users) {
                const dcaeBalance = await dcaeTokenContract.balanceOf(user.address);
                
                if (dcaeBalance > 0) {
                    const initialWETHBalance = await wETHToken.balanceOf(user.address);
                    
                    await dcaeTokenContract.connect(user).approve(await dcae.getAddress(), dcaeBalance);
                    await dcae.connect(user).burnForFee();
                    
                    const finalDCAEBalance = await dcaeTokenContract.balanceOf(user.address);
                    const finalWETHBalance = await wETHToken.balanceOf(user.address);
                    
                    expect(finalDCAEBalance).to.equal(0);
                    expect(finalWETHBalance).to.be.gt(initialWETHBalance);
                    
                    burnResults.push({
                        dcaeBurned: dcaeBalance,
                        wETHReceived: finalWETHBalance - initialWETHBalance
                    });
                }
            }
            
            console.log(`Fee Distribution Results:`);
            console.log(`Total Users Who Burned DCAE: ${burnResults.length}`);
        });
    });
});