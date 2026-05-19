// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MintRegistry {
    struct MintRecord {
        address minter;
        uint256 mintPriceWei;
        uint256 recordedAt;
    }

    address public owner;
    mapping(address => bool) public recorders;
    mapping(address => mapping(uint256 => MintRecord)) private records;

    event RecorderSet(address indexed recorder, bool enabled);
    event MintRecorded(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed minter,
        uint256 mintPriceWei
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRecorder() {
        require(msg.sender == owner || recorders[msg.sender], "not recorder");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "zero owner");
        owner = nextOwner;
    }

    function setRecorder(address recorder, bool enabled) external onlyOwner {
        recorders[recorder] = enabled;
        emit RecorderSet(recorder, enabled);
    }

    function recordMint(
        address nftContract,
        uint256 tokenId,
        address minter,
        uint256 mintPriceWei
    ) external onlyRecorder {
        records[nftContract][tokenId] = MintRecord({
            minter: minter,
            mintPriceWei: mintPriceWei,
            recordedAt: block.timestamp
        });

        emit MintRecorded(nftContract, tokenId, minter, mintPriceWei);
    }

    function getMint(address nftContract, uint256 tokenId)
        external
        view
        returns (address minter, uint256 mintPriceWei, uint256 recordedAt)
    {
        MintRecord memory record = records[nftContract][tokenId];
        return (record.minter, record.mintPriceWei, record.recordedAt);
    }
}
