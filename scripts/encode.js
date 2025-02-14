const { ethers } = require("ethers");

async function main() {
    const addresses = [
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        "0xf0A358c3Eb979F7EFBb2Fd5F69899eaDaeC97d80",
        "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    ];

    // 使用 ethers v6 的新语法
    const abiCoder = new ethers.AbiCoder();
    const encodedParams = abiCoder.encode(
        ['address', 'address', 'address', 'address'],
        addresses
    );

    console.log('Encoded parameters:', encodedParams);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });