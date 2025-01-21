const { expect } = require("chai");
const { ethers } = require("hardhat");
const erc20abi = require('erc-20-abi')
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { addresses } = require("./address.json")
const { quoterv2abi } = require("./quoterv2.json")
const { swaprouter02abi } = require("./swaprouter02.json")

describe("OneDollarDCAE Contract", function () {
    let owner, user1, user2, user3, user4,dcaeAddress;
    let dcae, dcaeTokenContract,usdcToken, wstETHToken, quoterV2, swapRouter;
    let OneDollarDCAE;
    
    const USDC_AMOUNT = ethers.parseUnits("1000", 6); // 1000 USDC
    const MIN_INVEST_AMOUNT = ethers.parseUnits("1", 6); // 1 USDC
    
    beforeEach(async function () {
        // Get signers
        [owner, user1, user2, user3, user4] = await ethers.getSigners();
        
        usdcToken = new ethers.Contract(
            addresses.usdc,
            erc20abi,
            ethers.provider
        );

        wstETHToken = new ethers.Contract(
            addresses.wstETH,
            erc20abi,
            ethers.provider
        );

        quoterV2 = new ethers.Contract(
            addresses.quoterv2,
            quoterv2abi,
            ethers.provider
        );

        swapRouter = new ethers.Contract(
            addresses.swaprouter02,
            swaprouter02abi,
            ethers.provider
        );
        
        // Deploy DCA contract
        OneDollarDCAE = await ethers.getContractFactory("OneDollarDCAE");
        dcae = await OneDollarDCAE.deploy(
            addresses.usdc,
            addresses.wstETH,
            addresses.quoterv2,
            addresses.swaprouter02
        );

        await dcae.waitForDeployment();

        dcaeAddress = await dcae.getAddress();

        const dcaeTokenAddress = await dcae.dcaeToken();
        dcaeTokenContract = new ethers.Contract(
            dcaeTokenAddress,
            erc20abi,
            ethers.provider
        );
        
        // Swap 1 ETH for USDC for each user
        const swapETHForUSDC = async (signer) => {
            const params = {
                tokenIn: addresses.WETH9,
                tokenOut: addresses.usdc,
                fee: 3000, // 0.3% fee tier
                recipient: signer.address,
                deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes from now
                amountIn: ethers.parseEther("1"),
                amountOutMinimum: 0, // Note: In production, should use quoter to set proper slippage
                sqrtPriceLimitX96: 0
            };

            const tx = await swapRouter.connect(signer).exactInputSingle(
                params,
                { value: ethers.parseEther("1") }
            );
            await tx.wait();
        };

        // Execute swaps for each user
        await swapETHForUSDC(user1);
        await swapETHForUSDC(user2);
        await swapETHForUSDC(user3);
        await swapETHForUSDC(user4);

        //console.log("Swapped Finished.")
        //console.log("ERC20 ABI:", erc20abi);

        sym = await usdcToken.symbol()
        //console.log("Symbol:",sym)
        // The number of decimals the token uses
        decimals = await usdcToken.decimals()
        //console.log("Decimals:",decimals)


        // Approve DCA contract to spend USDC
        await usdcToken.connect(user1).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user2).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user3).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user4).approve(dcaeAddress, USDC_AMOUNT);
    });
    
    describe("Deposit Functions", function () {
        it("Should allow multiple users to deposit USDC", async function () {
            // User1 deposits
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT);
            expect(await dcae.userBalances(user1.address)).to.equal(MIN_INVEST_AMOUNT);
            
            // User2 deposits
            await dcae.connect(user2).depositUSDC(MIN_INVEST_AMOUNT*2n);
            expect(await dcae.userBalances(user2.address)).to.equal(MIN_INVEST_AMOUNT*2n);
            
            // Check deposited users array
            expect(await dcae.depositedUsers(0)).to.equal(user1.address);
            expect(await dcae.depositedUsers(1)).to.equal(user2.address);
        });
        
        it("Should reject deposits below minimum amount", async function () {
            const smallAmount = MIN_INVEST_AMOUNT / 2n;
            await expect(
                dcae.connect(user1).depositUSDC(smallAmount)
            ).to.be.revertedWith("Amount too low");
        });
    });
    
    describe("Investment Execution", function () {
        beforeEach(async function () {
            // Setup mock swap returns
            //await swapRouter.setMockReturn(ethers.parseEther("0.1")); // 0.1 wstETH per USDC
            //await quoterV2.setMockQuote(ethers.parseEther("0.1"));
            
            // Setup multiple users with deposits
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT*10n);
            await dcae.connect(user2).depositUSDC(MIN_INVEST_AMOUNT*15n);
            await dcae.connect(user3).depositUSDC(MIN_INVEST_AMOUNT*20n);
        });
        
        it("Should execute investment for multiple users in batch", async function () {
            // Fast forward time to allow investment
            await time.increase(121); // Move past investmentInterval
            
            // Execute investment for first batch
            await dcae.connect(user4).executeInvestment(0);
            
            // Check user balances after investment
            expect(await dcae.userWstETH(user1.address)).to.be.gt(0);
            expect(await dcae.userWstETH(user2.address)).to.be.gt(0);
            expect(await dcae.userWstETH(user3.address)).to.be.gt(0);
            
            // Check caller rewards
            expect(await dcae.userWstETH(user4.address)).to.be.gt(0);
        });
        
        it("Should respect investment intervals", async function () {
            await dcae.connect(user1).executeInvestment(0)
            await time.increase(1)
            await expect(
                dcae.connect(user4).executeInvestment(0)
            ).to.be.revertedWith("Interval not passed");
        });
    });
    
    describe("Withdrawal Functions", function () {
        beforeEach(async function () {
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT*2n);
            await time.increase(121);
            await dcae.connect(user4).executeInvestment(0);
        });
        
        it("Should allow USDC withdrawal", async function () {

            const initialBalance = await usdcToken.balanceOf(user1.address);
            const withdrawAmount = MIN_INVEST_AMOUNT*1n;
            
            await dcae.connect(user1).withdrawUSDC();
            
            const finalBalance = await usdcToken.balanceOf(user1.address);
            expect(finalBalance - initialBalance).to.equal(withdrawAmount);
        });
        
        it("Should allow wstETH withdrawal and mint DCAE tokens", async function () {
            const initialWstETH = await dcae.userWstETH(user1.address);
            await dcae.connect(user1).withdrawWstETH();
            
            expect(await dcae.userWstETH(user1.address)).to.equal(0);
            
            expect(await dcaeTokenContract.balanceOf(user1.address)).to.equal(initialWstETH);
        });
    });
    
    describe("Fee Distribution", function () {
        beforeEach(async function () {
            // Setup scenario with multiple investments
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT*10n);
            await dcae.connect(user2).depositUSDC(MIN_INVEST_AMOUNT*10n);
            await time.increase(121);
            await dcae.connect(user4).executeInvestment(0);
        });
        
        it("Should allow burning DCAE tokens for fees", async function () {
           
            // Withdraw wstETH to get DCAE tokens
            await dcae.connect(user1).withdrawWstETH();
            const dcaeBalance = await dcaeTokenContract.balanceOf(user1.address);
            
            // Approve and burn DCAE tokens
            await dcaeTokenContract.connect(user1).approve(dcaeAddress, dcaeBalance);
            await dcae.connect(user1).burnForFee();
            
            // Check DCAE tokens were burned
            expect(await dcaeTokenContract.balanceOf(user1.address)).to.equal(0);
            // Check received wstETH
            expect(await wstETHToken.balanceOf(user1.address)).to.be.gt(0);
        });
    });
});