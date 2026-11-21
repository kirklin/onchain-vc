// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Fund} from "./Fund.sol";

/// @title Reception
/// @notice Takes visitors into the fund on the host's account, many in one transaction. Each
///         gets the same number of shares, bought with the asset this contract holds, and
///         native tokens for the gas of their own votes.
/// @dev The host keeps this contract stocked with the fund's asset. A room of people who
///      arrive together is then taken in by a single transaction instead of one each.
contract Reception {
    using SafeERC20 for IERC20;

    uint256 public constant TRANSFER_GAS = 3000;

    Fund public immutable fund;
    address public immutable host;

    /// @param cost What the shares cost this contract, in the fund's asset.
    event Admitted(address indexed visitor, uint256 shares, uint256 cost);

    error NotTheHost();
    error RefundFailed();

    constructor(Fund fund_, address host_) {
        if (host_ == address(0)) revert NotTheHost();
        fund = fund_;
        host = host_;
        IERC20(fund_.asset()).forceApprove(address(fund_), type(uint256).max);
    }

    /// @notice Gives each visitor who holds no shares yet `shares` of the fund, and raises
    ///         each visitor's balance of native tokens to `gasMoney`. The unspent value
    ///         returns to the host.
    function admit(address[] calldata visitors, uint256 shares, uint256 gasMoney) external payable {
        if (msg.sender != host) revert NotTheHost();

        uint256 length = visitors.length;
        for (uint256 i = 0; i < length; ++i) {
            address visitor = visitors[i];
            // The fund is this contract's own, so a call to it per visitor cannot be made to fail by one of them.
            // forge-lint: disable-next-line(incorrect-strict-equality, calls-loop)
            if (fund.balanceOf(visitor) == 0) {
                // forge-lint: disable-next-line(calls-loop)
                emit Admitted(visitor, shares, fund.mint(shares, visitor));
            }

            uint256 balance = visitor.balance;
            if (balance >= gasMoney) continue;
            uint256 amount = gasMoney - balance;
            uint256 stipend = TRANSFER_GAS;
            assembly ("memory-safe") {
                pop(call(stipend, visitor, amount, 0, 0, 0, 0))
            }
        }

        uint256 unspent = address(this).balance;
        if (unspent > 0) {
            (bool refunded,) = msg.sender.call{value: unspent}("");
            if (!refunded) revert RefundFailed();
        }
    }
}
