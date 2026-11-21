// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Token
/// @notice An ERC-20 with permit. Anyone may claim a fixed amount once per interval, and the
///         owner may mint freely.
contract Token is ERC20, ERC20Permit, Ownable {
    uint256 public constant CLAIM_AMOUNT = 100e18;
    uint256 public constant CLAIM_INTERVAL = 1 days;

    /// @notice When each account may claim next. Zero for accounts that never claimed.
    mapping(address account => uint256 timestamp) public nextClaimAt;

    event Claimed(address indexed account, uint256 amount);

    error ClaimTooSoon(uint256 availableAt);

    constructor(string memory name, string memory symbol, address owner)
        ERC20(name, symbol)
        ERC20Permit(name)
        Ownable(owner)
    {}

    /// @notice Mints CLAIM_AMOUNT to the caller.
    function claim() external {
        uint256 availableAt = nextClaimAt[msg.sender];
        if (block.timestamp < availableAt) revert ClaimTooSoon(availableAt);

        nextClaimAt[msg.sender] = block.timestamp + CLAIM_INTERVAL;
        _mint(msg.sender, CLAIM_AMOUNT);
        emit Claimed(msg.sender, CLAIM_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
