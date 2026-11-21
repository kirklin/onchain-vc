// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title Forwarder
/// @notice Executes calls that users signed off chain, so a relayer can pay their gas.
///         Contracts that trust it read the real sender with `_msgSender()` (ERC-2771).
contract Forwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("Forwarder") {}
}
