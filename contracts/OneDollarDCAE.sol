// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
pragma abicoder v2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';
import '@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol';

interface IOracle {
    function pool() external view returns (address);
    function getTwap(uint32 _twapDuration) external view returns (uint256);
}

contract DCAE is ERC20 {
    address public immutable owner;

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

    // Pack storage variables to reduce gas
    struct User {
        uint128 balance;
        uint128 wETH;
        uint64 investAmount;
        uint16 rewardRatio;
        uint64 burnTime;
        bool exists;
    }

    struct Batch {
        address[] users;
        uint256 nextInvestmentTime;
    }

    // Immutable variables
    address public immutable usdc;
    address public immutable wETH;
    DCAE public immutable dcaeToken;
    IOracle public immutable oracle;
    ISwapRouter public immutable swapRouter;

    // Constant gas-efficient values
    uint256 public constant MIN_INVEST_AMOUNT = 1 * 10**6; // 1 USDC
    uint256 public constant INVESTMENT_INTERVAL = 86400; // 86400 seconds
    uint24 public constant FEE = 3000; // 3000 fee ratio
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant SLIPPAGE_DENOMINATOR = 1000;

    // Packed state variables
    uint64 public totalUsers;
    uint64 public totalBatches;
    uint16 public slippage = 10; // Default 1% slippage

    mapping(address => User) public userInfo;
    mapping(uint256 => Batch) public batches;

    // Gas-optimized events with indexed parameters
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Burned(address indexed user, uint256 amountIn, uint256 amountOut);
    event InvestmentExecuted(address indexed user, uint256 totalUSDC, uint256 wETHReceived);
    event SlippageUpdated(uint16 newSlippage);

    constructor(
        address _usdc,
        address _wETH,
        address _oracle,
        address _swapRouter
    ) Ownable(msg.sender) {
        usdc = _usdc;
        wETH = _wETH;
        oracle = IOracle(_oracle);
        swapRouter = ISwapRouter(_swapRouter);
        dcaeToken = new DCAE();
    }

    function setInvestAmount(uint64 amount) external {
        User storage user = userInfo[msg.sender];
        require(user.balance > 0, "No deposited");
        require(amount >= MIN_INVEST_AMOUNT && amount <= 1000 * MIN_INVEST_AMOUNT, "Amount in 1~1000USDC");
        user.investAmount = amount;
    }

    function setRewardRatio(uint16 amount) external {
        User storage user = userInfo[msg.sender];
        require(user.balance > 0, "No deposited");
        require(amount >= 50 && amount <= 1000, "Amount in 10~1000");
        user.rewardRatio = amount;
    }

    function depositUSDC(uint256 amount) external nonReentrant {
        require(amount >= MIN_INVEST_AMOUNT, "Amount too low");

        User storage user = userInfo[msg.sender];
        if (!user.exists) {
            // Efficient user initialization
            user.exists = true;
            user.investAmount = uint64(MIN_INVEST_AMOUNT);
            user.rewardRatio = 100;
            user.burnTime = uint64(block.timestamp);
            
            unchecked { totalUsers++; }

            // Determine current batch with minimal operations
            uint256 currentBatch = (totalUsers - 1) / MAX_BATCH_SIZE;
            
            unchecked { totalBatches = uint64(currentBatch + 1); }
            batches[currentBatch].users.push(msg.sender);
        }

        unchecked { user.balance += uint128(amount); }
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

        uint256 totalUSDC;
        uint256 totalRewardRatio;

        // Pre-allocate fixed-size arrays
        address[] memory validInvestors = new address[](MAX_BATCH_SIZE);
        uint256[] memory validShares = new uint256[](MAX_BATCH_SIZE);
        uint256 investorCount;

        // Optimized batch processing
        for (uint256 i; i < batch.users.length; ) {
            User storage user = userInfo[batch.users[i]];
            uint256 investAmount = user.investAmount;
            
            if (user.balance >= investAmount) {
                validInvestors[investorCount] = batch.users[i];
                validShares[investorCount] = investAmount;
                
                unchecked {
                    totalUSDC += investAmount;
                    totalRewardRatio += user.rewardRatio;
                    investorCount++;
                }
            }

            unchecked { ++i; }
        }

        require(totalUSDC > 0, "No funds to invest");
        
        uint256 wETHReceived = _swapUSDCForWETH(totalUSDC);
        uint256 rewardRatio = totalRewardRatio / batch.users.length;

        uint256 remainingWETH = _distributeCaller(wETHReceived, rewardRatio);

        // Efficient WETH and DCAE token distribution
        for (uint256 i; i < investorCount; ) {
            address investor = validInvestors[i];
            uint256 share = (validShares[i] * 1e18) / totalUSDC;
            uint256 investorWETH = (remainingWETH * share) / 1e18;

            unchecked {
                userInfo[investor].wETH += uint128(investorWETH);
                userInfo[investor].balance -= uint128(validShares[i]);
                ++i;
            }

            dcaeToken.mint(investor, investorWETH);
        }

        batch.nextInvestmentTime = block.timestamp + INVESTMENT_INTERVAL;
        emit InvestmentExecuted(msg.sender, totalUSDC, wETHReceived);
    }

    function _swapUSDCForWETH(uint256 amountIn) internal returns (uint256) {
        uint256 minOutput = _getMinOutput(amountIn);

        if(IERC20(usdc).allowance(address(this), address(swapRouter)) < amountIn){
            TransferHelper.safeApprove(usdc, address(swapRouter), type(uint256).max);
        }

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: usdc,
            tokenOut: wETH,
            fee: FEE,
            recipient: address(this),
            deadline: block.timestamp + 15 minutes,
            amountIn: amountIn,
            amountOutMinimum: minOutput,
            sqrtPriceLimitX96: 0
        });

        return swapRouter.exactInputSingle(params);
    }

    function _distributeCaller(uint256 totalWETH, uint256 finalRewardRatio) internal returns (uint256 remainingWETH) {
        uint256 rewardAmount = (totalWETH * finalRewardRatio) / 10000;
        uint256 finalRewardAmount = rewardAmount * 90 / 100;

        unchecked {
            userInfo[msg.sender].wETH += uint128(finalRewardAmount);
            userInfo[address(this)].wETH += uint128(rewardAmount - finalRewardAmount);
            remainingWETH = totalWETH - rewardAmount;
        }

        dcaeToken.mint(msg.sender, finalRewardAmount);
        return remainingWETH;
    }

    function _getMinOutput(uint256 amountIn) internal view returns (uint256) {
        uint256 twapPrice = oracle.getTwap(1800);
        require(twapPrice > 0, "Invalid TWAP");
        uint256 amountOut = (amountIn * 1e18) / twapPrice;
        return (amountOut * (SLIPPAGE_DENOMINATOR - slippage)) / SLIPPAGE_DENOMINATOR;
    }

    function updateSlippage(uint16 newSlippage) external onlyOwner {
        require(newSlippage >= 5 && newSlippage <= 50, "Invalid slippage");
        slippage = newSlippage;
        emit SlippageUpdated(newSlippage);
    }

    function burnForFee() external nonReentrant {
        User storage user = userInfo[msg.sender];
        require(block.timestamp > user.burnTime, "Burn interval not passed");
        user.burnTime = uint64(block.timestamp + INVESTMENT_INTERVAL);
        
        uint256 dcaeBalance = dcaeToken.balanceOf(msg.sender);
        require(dcaeBalance > 0, "Insufficient DCAE balance");

        uint256 totalSupply = dcaeToken.totalSupply();
        require(totalSupply > 0, "No DCAE tokens in circulation");

        User storage contractUser = userInfo[address(this)];
        require(contractUser.wETH > 0, "No wETH available for rewards");

        // Efficient reward calculation
        uint256 dcaeShare = (dcaeBalance * 1e18) / totalSupply;
        uint256 wETHFee = (contractUser.wETH * dcaeShare) / 1e18;
        require(wETHFee > 0, "Reward too small");

        unchecked { contractUser.wETH -= uint128(wETHFee); }
        IERC20(wETH).safeTransfer(msg.sender, wETHFee);

        IERC20(dcaeToken).safeTransferFrom(msg.sender, address(this), dcaeBalance);
        dcaeToken.burn(dcaeBalance);

        emit Burned(msg.sender, dcaeBalance, wETHFee);
    }
}