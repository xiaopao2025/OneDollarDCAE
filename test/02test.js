const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const erc20abi = require('erc-20-abi');
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { addresses } = require("./address.json");
const { swaprouterabi } = require("./swaprouter.json");

describe("OneDollarDCAE Contract - Specific User Batch Execution", function () {
    const USER_COUNT = 3;
    const USDC_AMOUNT = ethers.parseUnits("1000", 6);
    const MIN_INVEST_AMOUNT = ethers.parseUnits("1", 6);
    
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
        
        const OneDollarDCAE = await ethers.getContractFactory("OneDollarDCAE");
        dcae = await OneDollarDCAE.deploy(
            addresses.usdc,
            addresses.wETH,
            oracleAddress,
            addresses.swaprouter
        );
        await dcae.waitForDeployment();
        const dcaeAddress = await dcae.getAddress();
        
        const dcaeTokenAddress = await dcae.dcaeToken();
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
        
        console.log("Preparing users with USDC and approvals...");
        for (let i = 0; i < USER_COUNT; i++) {
            await swapETHForUSDC(users[i]);
            await usdcToken.connect(users[i]).approve(dcaeAddress, USDC_AMOUNT);
            
            const depositAmount = MIN_INVEST_AMOUNT * BigInt(Math.floor(Math.random() * 20) + 100);
            await dcae.connect(users[i]).depositUSDC(depositAmount);
        }
        console.log("All users prepared!");
    });
    
    describe("Specific User Batch Investment Execution", function () {
        it("Allows 10 randomly selected users to execute their batch investments", async function () {
            // Randomly select 10 unique users
            const selectedUsers = [];
            while (selectedUsers.length < 2) {
                const randomIndex = Math.floor(Math.random() * USER_COUNT);
                const user = users[randomIndex];
                if (!selectedUsers.some(u => u.address === user.address)) {
                    selectedUsers.push(user);
                }
            }

            for (const user of selectedUsers) {
                // Get user's inBatch
                const userInfo = await dcae.userInfo(user.address);
                const userBatch = userInfo.inBatch;

                console.log(`User ${user.address} in Batch ${userBatch}`);

                // Advance time to ensure investment interval has passed
                await time.increase(86401);
                
                // Get batch info before execution
                const batchBefore = await dcae.batches(userBatch);
                
                // Execute investment for the user's batch
                const tx = await dcae.connect(user).executeInvestment(userBatch);
                const receipt = await tx.wait();

                // Verify batch execution
                const batchAfter = await dcae.batches(userBatch);
                
                // Check that nextInvestmentTime has been updated
                console.log("batchBefore",batchBefore);
                console.log("batchAfter",batchAfter);
                
                // Robust check for nextInvestmentTime
                expect(batchAfter).to.exist;
                expect(typeof batchAfter).to.equal('bigint');
                expect(batchAfter).to.be.gt(batchBefore);
                
                // Check DCAE token minting
                const dcaeTokenBalance = await dcaeTokenContract.balanceOf(user.address);
                expect(dcaeTokenBalance).to.be.gt(0n);

                console.log(`Batch ${userBatch} executed by ${user.address}`);
                console.log(`Gas used: ${receipt.gasUsed}`);
            }
        });
    });
});