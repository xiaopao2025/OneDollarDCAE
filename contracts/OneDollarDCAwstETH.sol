// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

//import "hardhat/console.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';
import '@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol';




interface IOracle {
    function pool() external view returns (address);
    function getTwap(uint32 _twapDuration) external view returns (uint256);
}

contract DCAE is ERC20 {
    address public owner;

    constructor() ERC20("DCA WETH", "DCAE") {
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner can mint");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

contract OneDollarDCAE is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public immutable wETH;
    DCAE public immutable dcaeToken;

    IOracle public immutable oracle;
    ISwapRouter public immutable swapRouter;

    uint256 public immutable MIN_INVEST_AMOUNT = 1 * 10**6; // 1 USDC
    uint256 public constant INVESTMENT_INTERVAL = 86400; // 86400 seconds
    uint24 public fee = 3000; //3000 fee ratio
    uint256 public slippage = 10; // Default 1% slippage

    uint256 public totalUsers;
    uint256 public totalBatches;

    struct User {
        uint256 balance;
        uint256 wETH;
        uint256 investAmount;
        uint256 rewardRatio;
        uint256 burnTime;
        bool exists;
    }

    struct Batch {
        address[] users;
        uint256 nextInvestmentTime;
    }

    mapping(address => User) public userInfo;
    mapping(uint256 => Batch) public batches;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Burned(address indexed user, uint256 amountIn, uint256 amountOut);
    event InvestmentExecuted(address indexed user, uint256 totalUSDC, uint256 wETHReceived);
    event SlippageUpdated(uint256 newSlippage);
    event FeeUpdated(uint256 newFee);

    constructor(
        address _usdc,
        address _wETH,
        address _oracle,
        address _swapRouter
    ) Ownable() {
        usdc = _usdc;
        wETH = _wETH;
        oracle = IOracle(_oracle);
        swapRouter = ISwapRouter(_swapRouter);
        dcaeToken = new DCAE();
    }

    function setInvestAmount(uint256 amount) external {
        require(amount >= MIN_INVEST_AMOUNT && amount <= 1000 * MIN_INVEST_AMOUNT, "Amount in 1~1000USDC");
        userInfo[msg.sender].investAmount = amount;

    }
    function setRewardRatio(uint256 amount) external {
        require(amount >= 50 && amount <= 1000, "Amount in 10~1000");
        userInfo[msg.sender].investAmount = amount;

    }

    function depositUSDC(uint256 amount) external nonReentrant {
        require(amount >= MIN_INVEST_AMOUNT, "Amount too low");

        if (!userInfo[msg.sender].exists) {
            // Initialize the user struct directly in the mapping
            userInfo[msg.sender] = User({
                exists: true,
                investAmount: MIN_INVEST_AMOUNT,
                rewardRatio: 100,
                balance:0,
                wETH: 0,
                burnTime: block.timestamp
            });
            totalUsers++;
    
            // Determine the current batch
            uint256 currentBatch = (totalUsers - 1) / 50;
    
            // Ensure the batch exists and add the user
            if (currentBatch >= totalBatches) {
                totalBatches = currentBatch + 1;
            }
    
            batches[currentBatch].users.push(msg.sender);
        }

        userInfo[msg.sender].balance += amount;
        TransferHelper.safeTransferFrom(usdc, msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdrawUSDC() external nonReentrant {
        User storage user = userInfo[msg.sender];
        uint256 balance = user.balance;
        require(balance > 0, "No USDC to withdraw");

        user.balance = 0;
        IERC20(usdc).safeTransfer(msg.sender, balance);
        emit Withdrawn(msg.sender, balance);
    }

    function withdrawWETH() external nonReentrant {
        User storage user = userInfo[msg.sender];
        uint256 balance = user.wETH;
        require(balance > 0, "No wETH to withdraw");

        user.wETH = 0;
        IERC20(wETH).safeTransfer(msg.sender, balance);
        emit Withdrawn(msg.sender, balance);
    }

    function executeInvestment(uint256 batchNumber) external nonReentrant {
        Batch storage batch = batches[batchNumber];
        require(block.timestamp >= batch.nextInvestmentTime, "Interval not passed");
        require(batch.users.length > 0, "No users in batch");

        uint256 totalUSDC = 0;
        uint256 totalRewardRatio = 0;

        address[] memory validInvestors = new address[](batch.users.length);
        uint256[] memory validShares = new uint256[](batch.users.length);
        uint256 investorCount = 0;

        for (uint256 i = 0; i < batch.users.length; i++) {
            User storage user = userInfo[batch.users[i]];
            uint256 investAmount = user.investAmount;
            //console.log("userbalance",user.balance);
            if (user.balance >= investAmount) {
                validInvestors[investorCount] = batch.users[i];
                validShares[investorCount] = investAmount;
                investorCount++;
                totalUSDC += investAmount;
                totalRewardRatio += user.rewardRatio;
            }
        }

        require(totalUSDC > 0, "No funds to invest");

        
        uint256 wETHReceived = _swapUSDCForWETH(totalUSDC);


        require(totalUSDC <= type(uint256).max, "Total USDC exceeds uint256 limit");
        require(wETHReceived <= type(uint256).max, "WETH received exceeds uint256 limit");

        uint256 rewardRadio = totalRewardRatio / batch.users.length;


        uint256 remainingWETH = _distributeCaller(wETHReceived, rewardRadio);

        for (uint256 i = 0; i < investorCount; i++) {
            address investor = validInvestors[i];
            uint256 share = (validShares[i]* 1e18) / totalUSDC;
            uint256 investorWETH = (remainingWETH * share) / 1e18;

            userInfo[investor].wETH += investorWETH;
            userInfo[investor].balance -= validShares[i];

            dcaeToken.mint(investor, investorWETH);
        }

        batch.nextInvestmentTime = block.timestamp + INVESTMENT_INTERVAL;
        emit InvestmentExecuted(msg.sender, totalUSDC, wETHReceived);
    }

    function _swapUSDCForWETH(uint256 amountIn) internal returns (uint256) {
        uint256 minOutput = _getMinOutput(amountIn);

        if(IERC20(usdc).allowance(address(this), address(swapRouter)) < amountIn){
            TransferHelper.safeApprove(usdc, address(swapRouter), amountIn);
        }

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: usdc,
            tokenOut: wETH,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 15 minutes,
            amountIn: amountIn,
            amountOutMinimum: minOutput,
            sqrtPriceLimitX96: 0
        });


        return swapRouter.exactInputSingle(params);
    }


    function _getMinOutput(uint256 amountIn) internal view returns (uint256) {
        uint256 twapPrice = oracle.getTwap(1800);
        require(twapPrice > 0, "Invalid TWAP");
        uint256 amountOut = (amountIn * 1e18) / twapPrice;
        return (amountOut * (1000 - slippage)) / 1000;
    }

    function updateSlippage(uint256 newSlippage) external onlyOwner {
        require(newSlippage >= 5 && newSlippage <= 50, "Invalid slippage");
        slippage = newSlippage;
        emit SlippageUpdated(newSlippage);
    }

    function updateFee(uint24 newFee) external onlyOwner {
        require(newFee == 500 || newFee == 3000 || newFee == 10000, "Invalid slippage");
        fee = newFee;
        emit FeeUpdated(newFee);
    }

    // The burnForFee function allows users to burn their DCAE tokens to claim their reward in wETH.
    function burnForFee() external nonReentrant {
        require(block.timestamp > userInfo[msg.sender].burnTime, "Burn interval not passed");
        uint256 dcaeBalance = dcaeToken.balanceOf(msg.sender);
        require(dcaeBalance > 0, "Insufficient DCAE balance");

        uint256 totalSupply = dcaeToken.totalSupply();
        require(totalSupply > 0, "No DCAE tokens in circulation");

        uint256 contractWETHBalance = userInfo[address(this)].wETH;
        require(contractWETHBalance > 0, "No wETH available for rewards");

        uint256 dcaeShare = (dcaeBalance * 1e18) / totalSupply;
        uint256 wETHFee = (contractWETHBalance * dcaeShare) / 1e18;
        require(wETHFee > 0, "Reward too small");

        // Burn the DCAE tokens
        IERC20(dcaeToken).safeTransferFrom(msg.sender, address(this), dcaeBalance);
        dcaeToken.burn(dcaeBalance);

        // Distribute the fee in wETH to the user
        userInfo[address(this)].wETH -= wETHFee;
        IERC20(wETH).safeTransfer(msg.sender, wETHFee);
        userInfo[msg.sender].burnTime = block.timestamp + INVESTMENT_INTERVAL;

        emit Burned(msg.sender, dcaeBalance, wETHFee);
        
    }

    // The _distributeCaller function allows the caller to claim their share of the reward.
    function _distributeCaller(uint256 totalWETH, uint256 finalRewardRatio) internal returns (uint256 remainingWETH) {
        uint256 rewardAmount = (totalWETH * finalRewardRatio) / 10000;
        uint256 finalRewardAmount = rewardAmount * 90 / 100;

        userInfo[msg.sender].wETH += finalRewardAmount;
        dcaeToken.mint(msg.sender, finalRewardAmount);

        userInfo[address(this)].wETH += rewardAmount - finalRewardAmount;
        remainingWETH = totalWETH - rewardAmount;
    }
}
