// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
pragma abicoder v2;

//import "hardhat/console.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

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
        _checkOwner();
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _checkOwner() private view {
        require(msg.sender == owner, "Only owner can mint");
    }
}

contract OneDollarDCAE is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Packed storage variables
    struct User {
        uint128 balance;
        uint128 wETH;
        uint64 investAmount;
        uint16 rewardRatio;
        uint64 burnTime;
        uint256 inBatch;
    }

    struct Batch {
        address[] users;
        uint256 nextInvestmentTime;
    }

    // Immutable variables to prevent unauthorized changes
    address public immutable usdc;
    address public immutable wETH;
    DCAE public immutable dcaeToken;
    IOracle public immutable oracle;
    ISwapRouter public immutable swapRouter;

    // Constant gas-efficient values with safety checks
    uint256 private constant MIN_INVEST_AMOUNT = 1 * 10 ** 6; // 1 USDC
    uint256 private constant MAX_INVEST_AMOUNT = 1000 * 10 ** 6; // 1000 USDC
    uint256 private constant INVESTMENT_INTERVAL = 1 days; // 1 days
    uint24 private constant FEE = 3000; // 3000 fee ratio
    uint256 private constant MAX_BATCH_SIZE = 30;
    uint256 private constant SLIPPAGE_DENOMINATOR = 1000;
    uint256 private constant TWAP_DURATION = 1800; // 30 minutes
    uint256 private constant MAX_REWARD_RATIO = 1000;
    uint256 private constant INVESTMENT_BUFFER = 15 minutes;

    // Packed state variables
    uint64 public totalUsers;
    uint16 public slippage = 10; // Default 1% slippage

    mapping(address => User) public userInfo;
    mapping(uint256 => Batch) public batches;

    // Gas-optimized events with indexed parameters
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Burned(address indexed user, uint256 amountIn, uint256 amountOut);
    event InvestmentExecuted(
        address indexed user,
        uint256 totalUSDC,
        uint256 wETHReceived
    );

    // Prevent initialization of implementation contract
    constructor(
        address _usdc,
        address _wETH,
        address _oracle,
        address _swapRouter
    ) {
        require(
            _usdc != address(0) &&
                _wETH != address(0) &&
                _oracle != address(0) &&
                _swapRouter != address(0),
            "Invalid address"
        );

        usdc = _usdc;
        wETH = _wETH;
        oracle = IOracle(_oracle);
        swapRouter = ISwapRouter(_swapRouter);
        dcaeToken = new DCAE();
    }

    function getUsersInfo(
        uint256 batchNumber
    ) external view returns (User[] memory userInfoArray) {
        address[] memory users = batches[batchNumber].users;
        userInfoArray = new User[](users.length);

        for (uint256 i = 0; i < users.length; i++) {
            userInfoArray[i] = userInfo[users[i]];
        }

        return userInfoArray;
    }

    function setInvestAmount(uint64 amount) external {
        _validateUser();
        require(
            amount >= MIN_INVEST_AMOUNT && amount <= MAX_INVEST_AMOUNT,
            "Invalid invest amount"
        );
        userInfo[msg.sender].investAmount = amount;
    }

    function setRewardRatio(uint16 amount) external {
        _validateUser();
        require(
            amount >= 50 && amount <= MAX_REWARD_RATIO,
            "Invalid reward ratio"
        );
        userInfo[msg.sender].rewardRatio = amount;
    }

    function _validateUser() private view {
        require(userInfo[msg.sender].balance > 0, "No deposited funds");
    }

    function depositUSDC(uint256 amount) external nonReentrant {
        require(amount >= MIN_INVEST_AMOUNT, "Amount too low");

        User storage user = userInfo[msg.sender];
        if (user.inBatch == 0) {
            _initializeNewUser(user);
        }

        unchecked {
            user.balance += uint128(amount);
        }
        TransferHelper.safeTransferFrom(
            usdc,
            msg.sender,
            address(this),
            amount
        );
        emit Deposited(msg.sender, amount);
    }

    function _initializeNewUser(User storage user) private {
        uint256 currentBatch;

        unchecked {
            totalUsers++;
            currentBatch = (totalUsers - 1) / MAX_BATCH_SIZE;
        }
        user.inBatch = currentBatch + 1;
        user.investAmount = uint64(MIN_INVEST_AMOUNT);
        user.rewardRatio = 100;
        user.burnTime = uint64(block.timestamp + 30 * INVESTMENT_INTERVAL);

        batches[user.inBatch].users.push(msg.sender);
    }

    function withdrawUSDC() external nonReentrant {
        _withdraw(usdc, "balance");
    }

    function withdrawWETH() external nonReentrant {
        _withdraw(wETH, "wETH");
    }

    function _withdraw(address token, string memory balanceType) private {
        User storage user = userInfo[msg.sender];
        uint256 balance;

        if (
            keccak256(abi.encodePacked(balanceType)) ==
            keccak256(abi.encodePacked("balance"))
        ) {
            balance = user.balance;
            user.balance = 0;
        } else {
            balance = user.wETH;
            user.wETH = 0;
        }

        require(
            balance > 0,
            string(abi.encodePacked("No ", balanceType, " to withdraw"))
        );
        IERC20(token).safeTransfer(msg.sender, balance);
        emit Withdrawn(msg.sender, balance);
    }

    function executeInvestment(uint256 batchNumber) external nonReentrant {
        Batch storage batch = batches[batchNumber];
        _validateInvestmentEligibility(batch);

        // Step 1: Load and validate all data
        (
            address[] memory validInvestors,
            uint256[] memory validShares,
            uint256 totalUSDC,
            uint256 totalRewardRatio,
            uint256 investorCount
        ) = _processInvestmentBatch(batch);

        // Step 2: Update all state variables before any external calls
        // Update batch timing
        batch.nextInvestmentTime = block.timestamp + INVESTMENT_INTERVAL;

        // Update USDC balances for all investors
        for (uint256 i; i < investorCount; ) {
            address investor = validInvestors[i];
            userInfo[investor].balance -= uint128(validShares[i]);
            unchecked {
                ++i;
            }
        }

        // Step 3: Perform the swap (external interaction)
        TransferHelper.safeApprove(usdc, address(swapRouter), totalUSDC);
        uint256 wETHReceived = _swapExactUSDCForWETH(totalUSDC);

        // Step 4: Calculate all shares and rewards
        uint256 rewardAmount = (wETHReceived * totalRewardRatio) /
            (batch.users.length * 10000);
        uint256 callerRewardAmount = (rewardAmount * 9) / 10;
        uint256 remainingWETH = wETHReceived - rewardAmount;

        // Step 5: Update all WETH balances
        userInfo[msg.sender].wETH += uint128(callerRewardAmount);
        userInfo[address(this)].wETH += uint128(
            rewardAmount - callerRewardAmount
        );

        // Calculate and store WETH amounts for each investor
        uint256[] memory wethAmountsToMint = new uint256[](investorCount);
        for (uint256 i; i < investorCount; ) {
            address investor = validInvestors[i];
            uint256 investorWETH = (remainingWETH * validShares[i]) / totalUSDC;

            userInfo[investor].wETH += uint128(investorWETH);
            wethAmountsToMint[i] = investorWETH;

            unchecked {
                ++i;
            }
        }

        // Step 6: Perform all token minting operations (external interactions) after state updates
        dcaeToken.mint(msg.sender, callerRewardAmount);

        for (uint256 i; i < investorCount; ) {
            dcaeToken.mint(validInvestors[i], wethAmountsToMint[i]);
            unchecked {
                ++i;
            }
        }

        emit InvestmentExecuted(msg.sender, totalUSDC, wETHReceived);
    }

    function _validateInvestmentEligibility(Batch storage batch) private view {
        require(
            block.timestamp >= batch.nextInvestmentTime,
            "Interval not passed"
        );
        require(batch.users.length > 0, "No users in batch");
    }

    function _processInvestmentBatch(
        Batch storage batch
    )
        private
        view
        returns (
            address[] memory validInvestors,
            uint256[] memory validShares,
            uint256 totalUSDC,
            uint256 totalRewardRatio,
            uint256 investorCount
        )
    {
        validInvestors = new address[](MAX_BATCH_SIZE);
        validShares = new uint256[](MAX_BATCH_SIZE);

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

            unchecked {
                ++i;
            }
        }

        require(totalUSDC > 0, "No funds to invest");
        return (
            validInvestors,
            validShares,
            totalUSDC,
            totalRewardRatio,
            investorCount
        );
    }

    function _swapExactUSDCForWETH(uint256 amountIn) private returns (uint256) {
        uint256 minOutput = _getMinOutput(amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: wETH,
                fee: FEE,
                recipient: address(this),
                deadline: block.timestamp + INVESTMENT_BUFFER,
                amountIn: amountIn,
                amountOutMinimum: minOutput,
                sqrtPriceLimitX96: 0
            });

        return swapRouter.exactInputSingle(params);
    }

    function _getMinOutput(uint256 amountIn) internal view returns (uint256) {
        uint256 twapPrice = oracle.getTwap(uint32(TWAP_DURATION));
        require(twapPrice > 0, "Invalid TWAP");

        return
            (amountIn * (SLIPPAGE_DENOMINATOR - slippage) * 1e18) /
            (twapPrice * SLIPPAGE_DENOMINATOR);
    }

    function burnForFee() external nonReentrant {
        uint64 currentTime = uint64(block.timestamp);
        User storage user = userInfo[msg.sender];
        uint64 burnTime = user.burnTime;
        _validateBurnEligibility(user, currentTime);

        uint256 dcaeBalance = dcaeToken.balanceOf(msg.sender);
        uint256 wETHFee = _calculateBurnReward(
            dcaeBalance,
            currentTime,
            burnTime
        );

        _transferBurnRewards(dcaeBalance, wETHFee);
    }

    function _validateBurnEligibility(
        User storage user,
        uint64 currenttime
    ) private {
        require(currenttime > user.burnTime, "Burn interval not passed");

        user.burnTime = uint64(block.timestamp + 30 * INVESTMENT_INTERVAL);
    }

    function _calculateBurnReward(
        uint256 dcaeBalance,
        uint64 currenttime,
        uint64 burnTime
    ) private view returns (uint256) {
        require(dcaeBalance > 0, "Insufficient DCAE balance");
        uint256 holdingTime = currenttime - burnTime;

        // Base reward ratio starts at 40%
        uint256 rewardMultiplier = 40;

        // Each 30 days adds 12% to reward ratio, up to 180 days
        uint256 holdingDurationThreshold = 30 days;
        uint256 maxPeriods = 6; // 180 days = 6 periods of 30 days

        if (holdingTime >= holdingDurationThreshold) {
            uint256 holdingTimeMultiple = holdingTime /
                holdingDurationThreshold;
            if (holdingTimeMultiple > maxPeriods) {
                holdingTimeMultiple = maxPeriods;
            }
            // Add 12% for each 30-day period
            uint256 bonusMultiplier = holdingTimeMultiple * 12;
            rewardMultiplier += bonusMultiplier;
        }

        User storage contractUser = userInfo[address(this)];
        require(contractUser.wETH > 0, "No wETH available for rewards");

        uint256 totalSupply = dcaeToken.totalSupply();
        require(totalSupply > 0, "No DCAE tokens in circulation");

        uint256 wETHFee = ((contractUser.wETH * rewardMultiplier) / 100);
        wETHFee = (wETHFee * dcaeBalance) / totalSupply;

        require(wETHFee > 0, "Reward too small");
        require(
            wETHFee <= contractUser.wETH,
            "Insufficient contract WETH balance"
        );

        return wETHFee;
    }

    function _transferBurnRewards(
        uint256 dcaeBalance,
        uint256 wETHFee
    ) private {
        IERC20(dcaeToken).safeTransferFrom(
            msg.sender,
            address(this),
            dcaeBalance
        );

        dcaeToken.burn(dcaeBalance);

        unchecked {
            userInfo[address(this)].wETH -= uint128(wETHFee);
        }

        IERC20(wETH).safeTransfer(msg.sender, wETHFee);

        emit Burned(msg.sender, dcaeBalance, wETHFee);
    }
}
