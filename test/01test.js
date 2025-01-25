const { expect } = require("chai");
const { ethers } = require("hardhat");
const erc20abi = require('erc-20-abi');
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { addresses } = require("./address.json");
const { swaprouterabi } = require("./swaprouter.json");

describe("OneDollarDCAE Contract", function () {
    let owner, user1, user2, user3, user4;
    let oracle, dcae, dcaeTokenContract, usdcToken, wETHToken, swapRouter;
    let Oracle, OneDollarDCAE;
    
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

        wETHToken = new ethers.Contract(
            addresses.wETH,
            erc20abi,
            ethers.provider
        );

        swapRouter = new ethers.Contract(
            addresses.swaprouter, 
            swaprouterabi,
            ethers.provider
        );

        // Deploy Oracle contract
        Oracle = await ethers.getContractFactory("Oracle");
        oracle = await Oracle.deploy(
            addresses.factory,
            addresses.usdc,
            addresses.wETH
        );

        await oracle.waitForDeployment();
        const oracleAddress = await oracle.getAddress();

        // Deploy DCA contract
        OneDollarDCAE = await ethers.getContractFactory("OneDollarDCAE");
        dcae = await OneDollarDCAE.deploy(
            addresses.usdc,
            addresses.wETH,
            oracleAddress,
            addresses.swaprouter // Updated router address
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

        // Approve DCA contract to spend USDC
        await usdcToken.connect(user1).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user2).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user3).approve(dcaeAddress, USDC_AMOUNT);
        await usdcToken.connect(user4).approve(dcaeAddress, USDC_AMOUNT);
    });
    
    // Rest of the test script remains the same...
    
    describe("Deposit Functions", function () {
        it("Should allow users to deposit USDC", async function () {
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT);
            const user = await dcae.userInfo(user1.address);
            expect(user.balance).to.equal(MIN_INVEST_AMOUNT);
            expect(user.exists).to.be.true;
            expect(user.investAmount).to.equal(MIN_INVEST_AMOUNT);
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
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT * 10n);
            await dcae.connect(user2).depositUSDC(MIN_INVEST_AMOUNT * 15n);
            await dcae.connect(user3).depositUSDC(MIN_INVEST_AMOUNT * 20n);
        });
        
        it("Should execute investment for multiple users in batch", async function () {
            await time.increase(86401);
            
            await dcae.connect(user4).executeInvestment(0);
            
            const user1Info = await dcae.userInfo(user1.address);
            const user2Info = await dcae.userInfo(user2.address);
            const user3Info = await dcae.userInfo(user3.address);
            const user4Info = await dcae.userInfo(user4.address);

            expect(user1Info.wETH).to.be.gt(0);
            expect(user2Info.wETH).to.be.gt(0);
            expect(user3Info.wETH).to.be.gt(0);
            expect(user4Info.wETH).to.be.gt(0);
            
            expect(await dcaeTokenContract.balanceOf(user1.address)).to.be.gt(0);
            expect(await dcaeTokenContract.balanceOf(user2.address)).to.be.gt(0);
            expect(await dcaeTokenContract.balanceOf(user3.address)).to.be.gt(0);
            expect(await dcaeTokenContract.balanceOf(user4.address)).to.be.gt(0);
        });
        
        it("Should respect investment intervals", async function () {
            await dcae.connect(user1).executeInvestment(0);
            await time.increase(1);
            await expect(
                dcae.connect(user4).executeInvestment(0)
            ).to.be.revertedWith("Interval not passed");
        });
    });
    
    describe("Withdrawal Functions", function () {
        beforeEach(async function () {
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT * 2n);
            await time.increase(121);
            await dcae.connect(user4).executeInvestment(0);
        });
        
        it("Should allow USDC withdrawal", async function () {
            const initialBalance = await usdcToken.balanceOf(user1.address);
            console.log("user1 initialBalance:",initialBalance);
            await dcae.connect(user1).withdrawUSDC();
            
            const finalBalance = await usdcToken.balanceOf(user1.address);
            console.log("user1 finalBalance:",finalBalance);
            expect(finalBalance - initialBalance).to.equal(MIN_INVEST_AMOUNT * 1n);
        });
        
        it("Should allow wETH withdrawal", async function () {
            await dcae.connect(user1).withdrawWETH();
            
            const user1Info = await dcae.userInfo(user1.address);
            expect(user1Info.wETH).to.equal(0);
        });
    });
    
    describe("Fee Distribution", function () {
        beforeEach(async function () {
            await dcae.connect(user1).depositUSDC(MIN_INVEST_AMOUNT * 10n);
            await dcae.connect(user2).depositUSDC(MIN_INVEST_AMOUNT * 10n);
            await time.increase(121);
            await dcae.connect(user4).executeInvestment(0);
        });
        
        it("Should allow burning DCAE tokens for fees", async function () {
            await dcae.connect(user1).withdrawWETH();
            const dcaeBalance = await dcaeTokenContract.balanceOf(user1.address);
            
            await dcaeTokenContract.connect(user1).approve(await dcae.getAddress(), dcaeBalance);
            await dcae.connect(user1).burnForFee();
            
            expect(await dcaeTokenContract.balanceOf(user1.address)).to.equal(0);
            expect(await wETHToken.balanceOf(user1.address)).to.be.gt(0);
        });
    });
});
