// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

//import "hardhat/console.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";

contract Oracle is Ownable {
    IUniswapV3Pool public pool;
    IUniswapV3Factory public factory;
    uint24 public fee = 3000;
    address public usdc;
    address public weth;
    
    constructor(
        address _factory,
        address _usdc,
        address _weth
    ) Ownable() {
        usdc = _usdc;
        weth = _weth;
        factory = IUniswapV3Factory(_factory);
        pool = IUniswapV3Pool(factory.getPool(_usdc, _weth, fee));   
    }

    function updateFee(uint24 newFee) external onlyOwner {
        require(newFee == 500 || newFee == 3000 || newFee == 10000, "Invalid fee");
        fee = newFee;
        pool = IUniswapV3Pool(factory.getPool(usdc, weth, fee)); 
    }

    
    function getTwap(uint32 _twapDuration) public view returns (uint256) {
        require(_twapDuration <= 86400, "Duration too long");

        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = _twapDuration;
        secondsAgo[1] = 0;
        
        (int56[] memory tickCumulatives, ) = pool.observe(secondsAgo);
        
        // Calculate arithmetic mean tick
        int24 timeWeightedAverageTick = int24(
            (tickCumulatives[1] - tickCumulatives[0]) / _twapDuration
        );
        
        // Convert tick to price using TickMath
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(timeWeightedAverageTick);
        
        // Calculate price from sqrtPriceX96
        uint256 price = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * 1e18) >> 192;
        
        return price;
    }
}