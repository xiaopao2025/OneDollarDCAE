const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const erc20abi = require('erc-20-abi');
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { addresses } = require("./address.json");
const { swaprouterabi } = require("./swaprouter.json");

describe("OneDollarDCAE Contract - Mass User Scenario", function () {
    const USER_COUNT = 100;
    const BATCH_EXECUTE_COUNT = 5;
    const USDC_AMOUNT = ethers.parseUnits("1000", 6);
    const MIN_INVEST_AMOUNT = ethers.parseUnits("1", 6);
    
    let owner, users, oracle, dcae, dcaeTokenContract, usdcToken, wETHToken, swapRouter;
    let totalInitialDeposit = 0n;
    
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
            totalInitialDeposit += depositAmount;
        }
        console.log("All users prepared!");
    });
    
    describe("Batch Investment Execution with Random Selection and Parameter", function () {
        it("Randomly selects users and investment parameters", async function () {
            const selectedUsers = [];
            while (selectedUsers.length < BATCH_EXECUTE_COUNT) {
                const randomIndex = Math.floor(Math.random() * USER_COUNT);
                if (!selectedUsers.includes(users[randomIndex])) {
                    selectedUsers.push(users[randomIndex]);
                }
            }
            
            const gasUsagePerUser = [];
            let totalWETHReceived = 0n;
            let totalDCAETokensMinted = 0n;
            
            for (let user of selectedUsers) {
                await time.increase(86401);
                
                // Randomly select 0 or 1 for executeInvestment parameter
                const investmentParam = Math.random() < 0.5 ? 0 : 1;
                
                const tx = await dcae.connect(user).executeInvestment(investmentParam);
                const receipt = await tx.wait();
                
                gasUsagePerUser.push(receipt.gasUsed);
                
                const userInfo = await dcae.userInfo(user.address);
                const dcaeTokenBalance = await dcaeTokenContract.balanceOf(user.address);
                
                expect(userInfo.wETH).to.be.gt(0);
                expect(dcaeTokenBalance).to.be.gt(0);
                
                totalWETHReceived += userInfo.wETH;
                totalDCAETokensMinted += dcaeTokenBalance;
            }
            
            const avgGas = gasUsagePerUser.reduce((a, b) => a + b, 0n) / BigInt(BATCH_EXECUTE_COUNT);
            const maxGas = gasUsagePerUser.reduce((a, b) => a > b ? a : b, 0n);
            const minGas = gasUsagePerUser.reduce((a, b) => a < b ? a : b, Infinity);
            
            console.log(`Batch Investment Execution Results:`);
            console.log(`Selected Users: ${selectedUsers.map(u => u.address).join(', ')}`);
            console.log(`Average Gas per User: ${avgGas}`);
            console.log(`Max Gas Used: ${maxGas}`);
            console.log(`Min Gas Used: ${minGas}`);
            console.log(`Total wETH Received: ${totalWETHReceived}`);
            console.log(`Total DCAE Tokens Minted: ${totalDCAETokensMinted}`);
        });
    });
});