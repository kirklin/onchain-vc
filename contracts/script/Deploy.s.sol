// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";

import {BatchExecutor} from "../src/BatchExecutor.sol";
import {Faucet} from "../src/Faucet.sol";
import {Forwarder} from "../src/Forwarder.sol";
import {Token} from "../src/Token.sol";

/// @notice Deploys every contract and records the addresses in deployments/<chainId>.json.
/// @dev Everything goes through the CREATE2 factory that Foundry and most chains share, so an
///      address depends only on the contract's code and constructor arguments. Running the
///      script again deploys only what changed.
///
///      Reads OPERATOR_PRIVATE_KEY, the account that deploys and pays.
contract Deploy is Script {
    bytes32 private constant SALT = keccak256("onchain-vc");

    string private constant CONTRACTS = "contracts";
    /// @dev The JSON object of recorded addresses, as built so far.
    string private _recorded;

    function run() external {
        uint256 key = vm.envUint("OPERATOR_PRIVATE_KEY");
        address operator = vm.addr(key);
        uint256 startBlock = block.number;

        vm.startBroadcast(key);

        _deploy("Faucet", type(Faucet).creationCode);
        _deploy("BatchExecutor", type(BatchExecutor).creationCode);
        _deploy("Forwarder", type(Forwarder).creationCode);
        _deploy("Token", abi.encodePacked(type(Token).creationCode, abi.encode("Test USD", "tUSD", operator)));

        vm.stopBroadcast();
        _record(startBlock);
    }

    /// @dev Deploys `initCode` at its CREATE2 address unless something already lives there,
    ///      and records the address under `name`.
    function _deploy(string memory name, bytes memory initCode) private returns (address deployed) {
        deployed = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);
        if (deployed.code.length == 0) {
            (bool created,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
            require(created, string.concat("CREATE2 deployment failed: ", name));
        }
        _recorded = vm.serializeAddress(CONTRACTS, name, deployed);
    }

    function _record(uint256 startBlock) private {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");

        // The first deployment's block is where indexing starts, and later runs keep it.
        if (vm.exists(path)) {
            startBlock = vm.parseJsonUint(vm.readFile(path), ".block");
        }

        vm.serializeUint("deployment", "block", startBlock);
        vm.writeJson(vm.serializeString("deployment", CONTRACTS, _recorded), path);
    }
}
