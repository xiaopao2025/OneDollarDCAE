// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";
import "@uniswap/swap-router-contracts/contracts/interfaces/IV3SwapRouter.sol";

contract DCAE is ERC20 {
    address public owner;

    constructor() ERC20("DCA WstETH", "DCAE") {
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

contract OneDollarDCAE is ReentrancyGuard,Ownable {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public immutable wstETH;
    DCAE public immutable dcaeToken;
    IQuoterV2 public immutable quoterv2;
    IV3SwapRouter public immutable swapRouter;

    uint256 public immutable MAX_USERS = 10000;
    uint256 public immutable investmentInterval = 120; // Investment interval
    uint256 public immutable MIN_INVEST_AMOUNT = 1 * 10**6; // Minimum investment amount in USDC
    uint256 public immutable rewardRatio = 50; // 0.5% in basis points
    uint256 public immutable maxRewardRatio = 1000; // 10% max

    uint256 public nextInvestmentTime;
    uint256 public slippage = 10; // Default apply 1% slippage
    uint256 public batchSize = 100; // Batch size (100 users per batch)
    
    mapping(address => uint256) public userBalances;
    mapping(address => uint256) public userWstETH;
    mapping(address => uint256) public userInvestAmount;

    address[] public depositedUsers;
    mapping(address => uint256) public userIndex;
    mapping(address => bool) public added;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event InvestAmountUpdated(address indexed user, uint256 amount);
    event InvestmentExecuted(uint256 totalUSDC, uint256 wstETHReceived);
    event ParametersUpdated(uint256 newSlippage, uint256 newBatchSize);


    constructor(
        address _usdc,
        address _wstETH,
        address _quoterv2,
        address _swapRouter
    ) Ownable(msg.sender) {
        usdc = _usdc;
        wstETH = _wstETH;
        swapRouter = IV3SwapRouter(_swapRouter);
        quoterv2 = IQuoterV2(_quoterv2);
        nextInvestmentTime = block.timestamp;
        dcaeToken = new DCAE();
    }

    function depositUSDC(uint256 amount) external nonReentrant {
        require(amount >= MIN_INVEST_AMOUNT, "Amount too low");
        if (added[msg.sender] == false && depositedUsers.length < MAX_USERS) {
            depositedUsers.push(msg.sender);
            added[msg.sender] = true;
            userInvestAmount[msg.sender] = MIN_INVEST_AMOUNT;
        }
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        userBalances[msg.sender] += amount;
        
        emit Deposited(msg.sender, amount);
    }

    function withdrawUSDC() external nonReentrant {
        uint256 balance = userBalances[msg.sender];
        require(balance > 0, "No USDC to withdraw");
        userBalances[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, balance);
        _removeUser(msg.sender);

        emit Withdrawn(msg.sender, balance);
    }

    function withdrawWstETH() external nonReentrant {
        uint256 balance = userWstETH[msg.sender];
        require(balance > 0, "No wstETH to withdraw");
        userWstETH[msg.sender] = 0;
        IERC20(wstETH).safeTransfer(msg.sender, balance);

        dcaeToken.mint(msg.sender, balance);

        emit Withdrawn(msg.sender, balance);
    }

    function burnForFee() external nonReentrant {
        uint256 dcaeBalance = dcaeToken.balanceOf(msg.sender);
        require( dcaeBalance > 0, "Insufficient DCAE balance");
        uint256 totalSupply = dcaeToken.totalSupply();
        require(totalSupply > 0, "No DCAE tokens in circulation");
        uint256 contractWstETHBalance = userWstETH[address(this)];
        require(contractWstETHBalance > 0, "No wstETH available for rewards");
        uint256 dcaeShare = (dcaeBalance * 1e18) / totalSupply;
        uint256 fee = (contractWstETHBalance * dcaeShare) / 1e18;
        require(fee > 0, "Reward too small");

        IERC20(dcaeToken).safeTransferFrom(msg.sender, address(this), dcaeBalance);
        dcaeToken.burn(dcaeBalance);
        userWstETH[address(this)] -= fee;
        IERC20(wstETH).safeTransfer(msg.sender, fee);
       

    }

    function setInvestAmount(uint256 amount) external nonReentrant {
        require(userBalances[msg.sender] > 0, "No deposit made");
        require(amount >= MIN_INVEST_AMOUNT, "Amount must >= MIN_INVEST_AMOUNT");
        userInvestAmount[msg.sender] = amount;
        emit InvestAmountUpdated(msg.sender, amount);
    }

    function updateParameters(
        uint256 newSlippage,
        uint256 newBatchSize
    ) external onlyOwner {
        require(newSlippage >= 5 && newSlippage <= 50, "Invalid slippage");
        require(newBatchSize >= 10 && newBatchSize <= 1000, "Invalid batch size");

        slippage = newSlippage;
        batchSize = newBatchSize;

        emit ParametersUpdated(newSlippage, newBatchSize);
    }

    function _removeUser(address userToRemove) internal {
        uint256 index = userIndex[userToRemove];
        if (index == 0) return;
        if (index != depositedUsers.length) {
            address lastUser = depositedUsers[depositedUsers.length - 1];
            depositedUsers[index - 1] = lastUser;
            userIndex[lastUser] = index;
        }
        depositedUsers.pop();
        delete userIndex[userToRemove];
        added[userToRemove] = false;
    }


    function executeInvestment(uint256 batchNumber) external nonReentrant {
        uint256 currentTimestamp = block.timestamp;
        require(currentTimestamp >= nextInvestmentTime, "Interval not passed");
        uint256 totalUSDC = 0;
        uint256 startIndex = batchNumber * batchSize;
        uint256 endIndex = (batchNumber + 1) * batchSize > depositedUsers.length
            ? depositedUsers.length
            : (batchNumber + 1) * batchSize;


        // Ensure we don't go out of bounds
        if (startIndex >= depositedUsers.length) {
         revert("Batch number exceeds total users");
        }
        

        // Create dynamic arrays for valid investors
        address[] memory validInvestors = new address[](endIndex - startIndex);
        uint256[] memory validShares = new uint256[](endIndex - startIndex);
        uint256 investorCount = 0;

        // Collect valid investors and their shares
        for (uint256 i = startIndex; i < endIndex; i++) {
            address user = depositedUsers[i];
            uint256 userAmount = userInvestAmount[user];
            if (userBalances[user] >= userAmount && userAmount > 0) {
                validInvestors[investorCount] = user;
                validShares[investorCount] = userAmount;
                totalUSDC += userAmount;
                investorCount++;
            }
        }

        require(totalUSDC > 0, "DCA: No funds to invest");

        

        // Execute swap
        uint256 totalWstETHReceived = _swapUSDCForWstETH(totalUSDC);

        require(totalWstETHReceived > 0, "Swap failed or received 0 wstETH");

        uint256 remainingWstETH = _distributeCaller(totalWstETHReceived,currentTimestamp);

        // Distribute wstETH to investors
        uint256 precisionFactor = 1e18; // Declare precisionFactor once before loop
        for (uint256 i = 0; i < investorCount; i++) {
            address investor = validInvestors[i];
            uint256 share = (userInvestAmount[investor] * precisionFactor) / totalUSDC;
            uint256 investorWstETH = (remainingWstETH * share) / precisionFactor;

            userWstETH[investor] += investorWstETH;
            userBalances[investor] -= validShares[i];
        }

        nextInvestmentTime = currentTimestamp + investmentInterval;
        emit InvestmentExecuted(totalUSDC, totalWstETHReceived);
    }

    function _distributeCaller(uint256 totalWstETH, uint256 timeStamp) internal returns (uint256 remainingWstETH) {
        uint256 multiples = (timeStamp- nextInvestmentTime) / investmentInterval;

        uint256 finalRewardRatio = rewardRatio + multiples * 10;
        if (finalRewardRatio > maxRewardRatio) {
            finalRewardRatio = maxRewardRatio;
        }

        uint256 rewardAmount = (totalWstETH * finalRewardRatio) / 10000;
        uint256 finalRewardAmount = rewardAmount * 99 / 100;
        userWstETH[msg.sender] += finalRewardAmount;
        userWstETH[address(this)] += rewardAmount - finalRewardAmount;
        remainingWstETH = totalWstETH - rewardAmount;


    }

    function _swapUSDCForWstETH(uint256 amountIn) internal returns (uint256 amountOut) {
        uint256 minOutput = _getAmountOutMinimum(amountIn,slippage);
        require(minOutput > 0, "Invalid minimum output amount");
        if(IERC20(usdc).allowance(address(this), address(swapRouter)) < amountIn){
            IERC20(usdc).approve(address(swapRouter), amountIn);
        }

        IV3SwapRouter.ExactInputSingleParams memory params = IV3SwapRouter.ExactInputSingleParams({
            tokenIn: usdc,
            tokenOut: wstETH,
            fee: 3000,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: minOutput,
            sqrtPriceLimitX96: 0
        });

        amountOut = swapRouter.exactInputSingle(params);
        
    }

    function _getAmountOutMinimum(uint256 amountIn, uint256 slipPage) internal returns (uint256) {

        IQuoterV2.QuoteExactInputSingleParams memory params = IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: usdc,
            tokenOut: wstETH,
            amountIn: amountIn,
            fee: 3000,
            sqrtPriceLimitX96: 0

        });

        (uint256 amountOut, , , ) = quoterv2.quoteExactInputSingle(params);
           
        uint256 minOutput = (amountOut * (1000 - slipPage)) / 1000;

        return minOutput;
    }
    
}
