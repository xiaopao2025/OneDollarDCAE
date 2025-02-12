const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const erc20abi = require('erc-20-abi');
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { addresses } = require("./address.json");
const { swaprouterabi } = require("./swaprouter.json");

describe("OneDollarDCAE Contract - DCAE Burn Reward Analysis", function () {
    const USER_COUNT = 40;
    const USDC_AMOUNT = ethers.parseUnits("1000000000", 6);
    const MIN_INVEST_AMOUNT = ethers.parseUnits("1", 6);
    const INVESTMENT_INTERVAL = 86400; // 1 day
    const ONE_DAY = 86400;
    const THIRTY_DAYS = ONE_DAY * 30;
    
    let owner, users, oracle, dcae, dcaeTokenContract, usdcToken, wETHToken, swapRouter;
    
    before(async function () {
        this.timeout(0); 
        
        [owner, ...users] = await ethers.getSigners();
        
        usdcToken = new ethers.Contract(addresses.usdc, erc20abi, ethers.provider);
        wETHToken = new ethers.Contract(addresses.wETH, erc20abi, ethers.provider);
        swapRouter = new ethers.Contract(addresses.swaprouter, swaprouterabi, ethers.provider);
        
        const Oracle = await ethers.getContractFactory("Oracle");
        oracle = await Oracle.deploy(
            addresses.factory,
            addresses.usdc,
            addresses.wETH
        );
        await oracle.waitForDeployment();
        const oracleAddress = await oracle.getAddress();
        console.log("oracleAddress:", oracleAddress);
        
        const OneDollarDCAE = await ethers.getContractFactory("OneDollarDCAE");
        dcae = await OneDollarDCAE.deploy(
            addresses.usdc,
            addresses.wETH,
            oracleAddress,
            addresses.swaprouter
        );
        await dcae.waitForDeployment();
        const dcaeAddress = await dcae.getAddress();
        console.log("dcaeAddress:", dcaeAddress);
        
        const dcaeTokenAddress = await dcae.dcaeToken();
        console.log("dcaeTokenAddress:", dcaeTokenAddress);
        dcaeTokenContract = new ethers.Contract(
            dcaeTokenAddress,
            erc20abi,
            ethers.provider
        );
        
        const swapETHForUSDC = async (signer) => {
            const blockTimestamp = await time.latest();
            const params = {
                tokenIn: addresses.WETH9,
                tokenOut: addresses.usdc,
                fee: 3000,
                recipient: signer.address,
                deadline: blockTimestamp + 60 * 10,
                amountIn: ethers.parseEther("5"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            };

            const tx = await swapRouter.connect(signer).exactInputSingle(
                params,
                { value: ethers.parseEther("5") }
            );
            await tx.wait();
        };
        
        console.log("Preparing users with USDC and approvals...");
        for (let i = 0; i < USER_COUNT; i++) {
            await swapETHForUSDC(users[i]);
            await usdcToken.connect(users[i]).approve(dcaeAddress, USDC_AMOUNT);
            
            const depositAmount = MIN_INVEST_AMOUNT * BigInt(Math.floor(Math.random() * 20) + 1000);
            await dcae.connect(users[i]).depositUSDC(depositAmount);
            const investAmount = MIN_INVEST_AMOUNT * BigInt(100);
            await dcae.connect(users[i]).setInvestAmount(investAmount);
        }
        console.log("All users prepared!");
    });
    
    describe("DCAE Burn Reward Analysis", function () {
        it("Analyzes WETH rewards for different holding periods", async function () {
            // Select 10 random users
            const selectedUsers = [];
            while (selectedUsers.length < 10) {
                const randomIndex = Math.floor(Math.random() * USER_COUNT);
                const user = users[randomIndex];
                if (!selectedUsers.some(u => u.address === user.address)) {
                    selectedUsers.push(user);
                }
            }

            // Execute investments first
            console.log("\n=== Executing Initial Investments ===");
            for (const user of selectedUsers) {
                const userInfo = await dcae.userInfo(user.address);
                const userBatch = userInfo.inBatch;
                await time.increase(INVESTMENT_INTERVAL);
                await dcae.connect(user).executeInvestment(userBatch);
            }

            // Wait for all investments to be processed
            await time.increase(INVESTMENT_INTERVAL);

            // Get total DCAE supply for percentage calculations
            const totalSupply = await dcaeTokenContract.totalSupply();
            console.log(`\nTotal DCAE Supply: ${ethers.formatEther(totalSupply)} DCAE`);

            // Test burns with different holding periods
            console.log("\n=== Analyzing Burns at Different Time Periods ===");
            
            const holdingPeriods = [
                30,    // 30 days - base reward (40%)
                60,    // 60 days - 52% reward
                90,   // 90 days - 64% reward
                120,   // 120 days - 76% reward
                150,   // 150 days - 88% reward
                180,   // 180 days - 100% reward (maximum)
            ];

            const burnResults = [];
            
            for (let i = 0; i < selectedUsers.length; i++) {
                const user = selectedUsers[i];
                const daysToHold = holdingPeriods[i % holdingPeriods.length];
                
                // Get user's DCAE balance
                const dcaeBalance = await dcaeTokenContract.balanceOf(user.address);
                const dcaePercentage = (Number(dcaeBalance) * 100) / Number(totalSupply);
                
                // Approve DCAE for burning
                await dcaeTokenContract.connect(user).approve(await dcae.getAddress(), dcaeBalance);
                
                // Record initial WETH balance
                const initialWethBalance = await wETHToken.balanceOf(user.address);
                
                // Advance time
                await time.increase(daysToHold * ONE_DAY);
                
                console.log(`\n--- Burn Analysis for ${daysToHold} Days Holding Period ---`);
                console.log(`User Address: ${user.address}`);
                console.log(`DCAE Balance: ${ethers.formatEther(dcaeBalance)} DCAE (${dcaePercentage.toFixed(2)}% of total supply)`);
                
                // Execute burn
                const burnTx = await dcae.connect(user).burnForFee();
                const burnReceipt = await burnTx.wait();
                
                // Calculate WETH received
                const finalWethBalance = await wETHToken.balanceOf(user.address);
                const wethReceived = finalWethBalance - initialWethBalance;
                
                const rewardRatio = Number(wethReceived) / Number(dcaeBalance);
                
                console.log(`WETH Received: ${ethers.formatEther(wethReceived)} WETH`);
                console.log(`Reward Ratio: ${(rewardRatio * 100).toFixed(4)}%`);
                console.log(`Gas Used: ${burnReceipt.gasUsed}`);
                
                burnResults.push({
                    daysHeld: daysToHold,
                    dcaeAmount: ethers.formatEther(dcaeBalance),
                    wethReceived: ethers.formatEther(wethReceived),
                    rewardRatio: rewardRatio,
                    dcaePercentage: dcaePercentage,
                    gasUsed: burnReceipt.gasUsed
                });
            }

            // Print summary analysis
            console.log("\n=== Burn Reward Analysis Summary ===");
            
            // Group results by holding period
            const holdingPeriodGroups = {};
            for (const result of burnResults) {
                if (!holdingPeriodGroups[result.daysHeld]) {
                    holdingPeriodGroups[result.daysHeld] = [];
                }
                holdingPeriodGroups[result.daysHeld].push(result);
            }

            // Calculate averages for each holding period
            for (const [period, results] of Object.entries(holdingPeriodGroups)) {
                const avgRewardRatio = results.reduce((sum, r) => sum + r.rewardRatio, 0) / results.length;
                const avgWethReceived = results.reduce((sum, r) => sum + Number(r.wethReceived), 0) / results.length;
                const avgGasUsed = results.reduce((sum, r) => sum + Number(r.gasUsed), 0) / results.length;

                console.log(`\n${period} Days Holding Period:`);
                console.log(`- Average WETH Received: ${avgWethReceived.toFixed(18)} WETH`);
                console.log(`- Average Reward Ratio: ${(avgRewardRatio * 100).toFixed(4)}%`);
                console.log(`- Average Gas Used: ${Math.floor(avgGasUsed)} units`);
            }

            // Find best and worst cases
            const bestReward = burnResults.reduce((max, curr) => Number(curr.wethReceived) > Number(max.wethReceived) ? curr : max);
            const worstReward = burnResults.reduce((min, curr) => Number(curr.wethReceived) < Number(min.wethReceived) ? curr : min);

            console.log("\nBest Performing Burn:");
            console.log(`- Holding Period: ${bestReward.daysHeld} days`);
            console.log(`- WETH Received: ${bestReward.wethReceived} WETH`);
            console.log(`- Reward Ratio: ${(bestReward.rewardRatio * 100).toFixed(4)}%`);

            console.log("\nWorst Performing Burn:");
            console.log(`- Holding Period: ${worstReward.daysHeld} days`);
            console.log(`- WETH Received: ${worstReward.wethReceived} WETH`);
            console.log(`- Reward Ratio: ${(worstReward.rewardRatio * 100).toFixed(4)}%`);
        });
    });
});
//npx hardhat test test/02test.js --network localhost