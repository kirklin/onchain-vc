// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {IPermit2} from "../src/interfaces/IPermit2.sol";

/// @notice Shared setup: named accounts, and the canonical contracts at their real addresses.
abstract contract BaseTest is Test {
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    uint256 internal aliceKey = 0xA11CE;
    uint256 internal bobKey = 0xB0B;
    address internal alice = vm.addr(aliceKey);
    address internal bob = vm.addr(bobKey);
    address internal carol = makeAddr("carol");
    address internal admin = makeAddr("admin");

    /// @dev Puts Permit2's runtime code, kept in canonical/, where every chain has it.
    function _installPermit2() internal {
        vm.etch(address(PERMIT2), vm.parseBytes(vm.trim(vm.readFile("canonical/Permit2.hex"))));
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
