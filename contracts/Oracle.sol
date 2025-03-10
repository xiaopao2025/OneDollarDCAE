// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

//import "hardhat/console.sol";

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";

contract Oracle {
    IUniswapV3Pool public pool;

    constructor(address _factory, address _usdc, address _weth) {
        IUniswapV3Factory factory = IUniswapV3Factory(_factory);
        pool = IUniswapV3Pool(factory.getPool(_usdc, _weth, 3000));
    }

    function getTwap(uint32 _twapDuration) public view returns (uint256) {
        require(_twapDuration <= 86400, "Duration too long");

        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = _twapDuration;
        secondsAgo[1] = 0;

        // Properly capture both return values
        (
            int56[] memory tickCumulatives,
        ) = pool.observe(secondsAgo);

        // Calculate arithmetic mean tick
        int24 timeWeightedAverageTick = int24(
            (tickCumulatives[1] - tickCumulatives[0]) / _twapDuration
        );

        // Convert tick to price using TickMath
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(
            timeWeightedAverageTick
        );

        // Calculate price from sqrtPriceX96
        uint256 price = (uint256(sqrtPriceX96) *
            uint256(sqrtPriceX96) *
            1e18) >> 192;

        //console.log("TWAP Price: %s", price);
        return price;
    }
}
