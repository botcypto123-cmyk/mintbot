// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * FeeRouter — routes ETH through on behalf of users, collecting a platform fee.
 * 
 * Deploy on both Ethereum mainnet and Base.
 * Add addresses to .env as FEE_ROUTER_CONTRACT_ETH and FEE_ROUTER_CONTRACT_BASE.
 *
 * The bot calls this contract instead of the NFT contract directly.
 * The router splits payment: (mintPrice) to NFT/SeaDrop, (fee) to treasury.
 *
 * PATH 1 — OpenSea SeaDrop:
 *   router.mintViaSeaDrop(seadropAddress, nftContract, feeRecipient, qty, treasury, feeBps)
 *
 * PATH 2 — mint(address to, uint256 qty):
 *   router.mintWithTo(nftContract, to, qty, treasury, feeBps)
 *
 * PATH 3 — mint(uint256 qty) [no to param]:
 *   router.mintNoTo(nftContract, qty, treasury, feeBps)
 *   (NFT lands in router, router transfers to caller in same tx)
 *
 * If any path reverts, the bot falls back to minting directly with no fee.
 */

interface ISeaDrop {
    function mintPublic(
        address nftContract,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity
    ) external payable;
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}

contract FeeRouter {
    address public immutable owner;

    // SeaDrop contract address (same on ETH + Base)
    address public constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;

    event FeeSent(address indexed treasury, uint256 amount, address indexed minter);
    event MintRouted(address indexed nftContract, address indexed minter, uint8 path);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() { owner = msg.sender; }

    // ─── PATH 1: OpenSea SeaDrop ────────────────────────────────────────────
    function mintViaSeaDrop(
        address nftContract,
        address feeRecipient,
        uint256 quantity,
        address treasury,
        uint256 feeBps  // e.g. 500 = 5%
    ) external payable {
        uint256 fee = (msg.value * feeBps) / 10000;
        uint256 mintPayment = msg.value - fee;

        ISeaDrop(SEADROP).mintPublic{value: mintPayment}(
            nftContract,
            feeRecipient,
            msg.sender, // minterIfNotPayer — NFT goes directly to caller
            quantity
        );

        if (fee > 0 && treasury != address(0)) {
            (bool sent, ) = treasury.call{value: fee}("");
            require(sent, "fee transfer failed");
            emit FeeSent(treasury, fee, msg.sender);
        }

        emit MintRouted(nftContract, msg.sender, 1);
    }

    // ─── PATH 2: mint(address to, uint256 quantity) ─────────────────────────
    function mintWithTo(
        address nftContract,
        uint256 quantity,
        address treasury,
        uint256 feeBps,
        bytes calldata callData  // encoded mint(address,uint256) calldata
    ) external payable {
        uint256 fee = (msg.value * feeBps) / 10000;
        uint256 mintPayment = msg.value - fee;

        (bool success, ) = nftContract.call{value: mintPayment}(callData);
        require(success, "mint failed");

        if (fee > 0 && treasury != address(0)) {
            (bool sent, ) = treasury.call{value: fee}("");
            require(sent, "fee transfer failed");
            emit FeeSent(treasury, fee, msg.sender);
        }

        emit MintRouted(nftContract, msg.sender, 2);
    }

    // ─── PATH 3: mint(uint256) — NFT lands in router, transfer to caller ────
    function mintNoTo(
        address nftContract,
        uint256 quantity,
        address treasury,
        uint256 feeBps,
        bytes calldata callData  // encoded mint(uint256) calldata
    ) external payable {
        uint256 fee = (msg.value * feeBps) / 10000;
        uint256 mintPayment = msg.value - fee;

        // Predict token IDs before minting
        uint256 supplyBefore = IERC721(nftContract).totalSupply();

        (bool success, ) = nftContract.call{value: mintPayment}(callData);
        require(success, "mint failed");

        // Transfer each newly minted token to the original caller
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = supplyBefore + i; // sequential ID assumption
            try IERC721(nftContract).transferFrom(address(this), msg.sender, tokenId) {
                // success
            } catch {
                // If sequential prediction fails, try tokenOfOwnerByIndex
                try IERC721(nftContract).tokenOfOwnerByIndex(address(this), 0) returns (uint256 tid) {
                    IERC721(nftContract).transferFrom(address(this), msg.sender, tid);
                } catch {
                    // Can't recover — revert so bot uses path 4 (direct mint, no fee)
                    revert("token transfer failed — use direct mint");
                }
            }
        }

        if (fee > 0 && treasury != address(0)) {
            (bool sent, ) = treasury.call{value: fee}("");
            require(sent, "fee transfer failed");
            emit FeeSent(treasury, fee, msg.sender);
        }

        emit MintRouted(nftContract, msg.sender, 3);
    }

    // ─── Owner can withdraw any ETH stuck in the contract ───────────────────
    function withdraw() external onlyOwner {
        (bool sent, ) = owner.call{value: address(this).balance}("");
        require(sent, "withdraw failed");
    }

    receive() external payable {}
}
