// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintRegistry {
    function recordMint(address nftContract, uint256 tokenId, address minter, uint256 mintPriceWei) external;
}

interface IERC721Transfer {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract FeeRouter {
    address public owner;
    address payable public treasury;
    IMintRegistry public registry;

    event TreasuryUpdated(address indexed treasury);
    event RegistryUpdated(address indexed registry);
    event MintRouted(
        address indexed nftContract,
        address indexed minter,
        uint256 mintValueWei,
        uint256 platformFeeWei,
        uint256 tokenId
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address payable treasury_, address registry_) {
        require(treasury_ != address(0), "zero treasury");
        owner = msg.sender;
        treasury = treasury_;
        registry = IMintRegistry(registry_);
    }

    receive() external payable {}

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "zero owner");
        owner = nextOwner;
    }

    function setTreasury(address payable nextTreasury) external onlyOwner {
        require(nextTreasury != address(0), "zero treasury");
        treasury = nextTreasury;
        emit TreasuryUpdated(nextTreasury);
    }

    function setRegistry(address nextRegistry) external onlyOwner {
        registry = IMintRegistry(nextRegistry);
        emit RegistryUpdated(nextRegistry);
    }

    function routeMint(
        address nftContract,
        bytes calldata mintCallData,
        uint256 mintValueWei,
        uint256 platformFeeWei,
        uint256 expectedTokenId,
        address userWallet
    ) external payable returns (bytes memory result) {
        require(userWallet != address(0), "zero user");
        require(msg.value >= mintValueWei + platformFeeWei, "insufficient value");

        (bool ok, bytes memory data) = nftContract.call{value: mintValueWei}(mintCallData);
        require(ok, _revertMessage(data));

        if (platformFeeWei > 0) {
            (bool paid,) = treasury.call{value: platformFeeWei}("");
            require(paid, "fee transfer failed");
        }

        if (expectedTokenId != 0) {
            try registry.recordMint(nftContract, expectedTokenId, userWallet, mintValueWei) {} catch {}
        }

        uint256 refund = address(this).balance;
        if (refund > 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            require(refunded, "refund failed");
        }

        emit MintRouted(nftContract, userWallet, mintValueWei, platformFeeWei, expectedTokenId);
        return data;
    }

    function routeMintToSelfThenTransfer(
        address nftContract,
        bytes calldata mintCallData,
        uint256 mintValueWei,
        uint256 platformFeeWei,
        uint256 tokenId,
        address userWallet
    ) external payable returns (bytes memory result) {
        require(tokenId != 0, "token required");
        bytes memory data = this.routeMint{value: msg.value}(
            nftContract,
            mintCallData,
            mintValueWei,
            platformFeeWei,
            tokenId,
            userWallet
        );
        IERC721Transfer(nftContract).transferFrom(address(this), userWallet, tokenId);
        return data;
    }

    function _revertMessage(bytes memory data) private pure returns (string memory) {
        if (data.length < 68) return "mint call failed";
        assembly {
            data := add(data, 0x04)
        }
        return abi.decode(data, (string));
    }
}
