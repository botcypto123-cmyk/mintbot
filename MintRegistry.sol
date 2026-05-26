// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * MintRegistry — records mint price per token at mint time.
 * Used by the bot to calculate profit-based fees without an escrow.
 *
 * Deploy on both Ethereum mainnet and Base.
 * Add addresses to .env as MINT_REGISTRY_ETH and MINT_REGISTRY_BASE.
 */
contract MintRegistry {
    struct Record {
        address minter;
        uint256 mintPrice; // in wei
        uint256 timestamp;
    }

    // nftContract => tokenId => Record
    mapping(address => mapping(uint256 => Record)) public records;

    // minter => nftContract => tokenIds[]
    mapping(address => mapping(address => uint256[])) private minterTokens;

    event MintRecorded(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed minter,
        uint256 mintPrice
    );

    /**
     * Record a mint. Called by the bot in the same transaction as the mint.
     * Anyone can record — the nftContract + tokenId pair is the unique key.
     * A second record for the same token is ignored (first write wins).
     */
    function record(
        address nftContract,
        uint256 tokenId,
        address minter,
        uint256 mintPrice
    ) external {
        // First write wins — prevents overwriting a legitimate record
        if (records[nftContract][tokenId].minter != address(0)) return;
        records[nftContract][tokenId] = Record({ minter: minter, mintPrice: mintPrice, timestamp: block.timestamp });
        minterTokens[minter][nftContract].push(tokenId);
        emit MintRecorded(nftContract, tokenId, minter, mintPrice);
    }

    /**
     * Batch record multiple tokens from a single mint transaction.
     */
    function recordBatch(
        address nftContract,
        uint256[] calldata tokenIds,
        address minter,
        uint256 mintPricePerToken
    ) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (records[nftContract][tokenIds[i]].minter != address(0)) continue;
            records[nftContract][tokenIds[i]] = Record({ minter: minter, mintPrice: mintPricePerToken, timestamp: block.timestamp });
            minterTokens[minter][nftContract].push(tokenIds[i]);
            emit MintRecorded(nftContract, tokenIds[i], minter, mintPricePerToken);
        }
    }

    function getRecord(address nftContract, uint256 tokenId)
        external view returns (address minter, uint256 mintPrice, uint256 timestamp)
    {
        Record memory r = records[nftContract][tokenId];
        return (r.minter, r.mintPrice, r.timestamp);
    }

    function getMinterTokens(address minter, address nftContract)
        external view returns (uint256[] memory)
    {
        return minterTokens[minter][nftContract];
    }
}
