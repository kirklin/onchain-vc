// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title BatchExecutor
/// @notice Code an ordinary account takes on through EIP-7702 so that it can make several
///         calls in one transaction, all of them or none.
/// @dev The account delegates to this contract and then calls `execute` on itself. Nothing
///      is stored, so the delegation can be changed or dropped at any time.
///
///      An account with code is treated as a contract by everything it talks to, which is
///      why this also accepts safe NFT transfers and answers ERC-1271: the account's own
///      key stays the one thing that can sign for it.
contract BatchExecutor is ERC721Holder, ERC1155Holder, IERC1271 {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error CallFailed(uint256 index);
    error Unauthorized();

    /// @notice Makes every call in order. If one reverts, the whole batch reverts with its reason.
    function execute(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert Unauthorized();

        for (uint256 i = 0; i < calls.length; ++i) {
            _call(i, calls[i]);
        }
    }

    /// @dev Calling wherever the account says, in a loop, and stopping the batch at the first
    ///      failure is what this contract is for. Only the account itself gets this far.
    // forge-lint: disable-next-item(arbitrary-send-eth, calls-loop, require-revert-in-loop)
    function _call(uint256 index, Call calldata call) private {
        (bool success, bytes memory result) = call.to.call{value: call.value}(call.data);
        if (success) return;

        if (result.length == 0) revert CallFailed(index);
        assembly ("memory-safe") {
            revert(add(result, 0x20), mload(result))
        }
    }

    /// @dev ERC-1271. A signature is valid when the account's own key made it.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError failure,) = ECDSA.tryRecoverCalldata(hash, signature);
        bool valid = failure == ECDSA.RecoverError.NoError && recovered == address(this);
        return valid ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    receive() external payable {}
}
