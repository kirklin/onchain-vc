// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Faucet
/// @notice Tops up many accounts in a single transaction.
/// @dev Holds no funds between calls. Recipients get a fixed gas stipend, so a contract
///      that rejects or burns the transfer is skipped without affecting the others.
contract Faucet {
    uint256 public constant TRANSFER_GAS = 3000;

    event Dripped(address indexed to, uint256 amount);

    error RefundFailed();

    /// @notice Raises every recipient's balance to `target`. Recipients already at or above it
    ///         are skipped, and the unspent value returns to the caller.
    function drip(address[] calldata recipients, uint256 target) external payable {
        uint256 length = recipients.length;
        for (uint256 i = 0; i < length; ++i) {
            address to = recipients[i];
            uint256 balance = to.balance;
            if (balance >= target) continue;

            uint256 amount = target - balance;
            uint256 stipend = TRANSFER_GAS;
            bool sent;
            assembly ("memory-safe") {
                sent := call(stipend, to, amount, 0, 0, 0, 0)
            }
            if (sent) emit Dripped(to, amount);
        }

        uint256 unspent = address(this).balance;
        if (unspent > 0) {
            (bool refunded,) = msg.sender.call{value: unspent}("");
            if (!refunded) revert RefundFailed();
        }
    }
}
