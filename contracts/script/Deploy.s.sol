// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";

import {BatchExecutor} from "../src/BatchExecutor.sol";
import {Committee} from "../src/Committee.sol";
import {Faucet} from "../src/Faucet.sol";
import {Forwarder} from "../src/Forwarder.sol";
import {Fund} from "../src/Fund.sol";
import {PortfolioBadge} from "../src/PortfolioBadge.sol";
import {Token} from "../src/Token.sol";

/// @notice Deploys every contract, seats the four partners, posts their bonds and puts the
///         first money into the fund. Records the addresses in deployments/<chainId>.json.
/// @dev Everything goes through the CREATE2 factory that Foundry and most chains share, so an
///      address depends only on the contract's code and constructor arguments. Running the
///      script again deploys only what changed, and tops up only what is missing.
///
///      Reads OPERATOR_PRIVATE_KEY, the account that deploys and pays; PARTNER_KEYS, the four
///      partners' keys in seat order, of which only the addresses are used; INVESTOR, the
///      address that receives the shares of the first deposit; and optionally FIRST_DEPOSIT,
///      the size of that deposit in whole tokens.
contract Deploy is Script {
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 private constant SALT = keccak256("onchain-vc");

    /// @dev What the operator puts into the fund on the first deployment, in whole tokens,
    ///      unless FIRST_DEPOSIT names another amount.
    uint256 private constant DEFAULT_FIRST_DEPOSIT = 100_000;
    uint16 private constant QUORUM_BPS = 5000;
    uint32 private constant MOTION_PERIOD = 3 days;

    string private constant CONTRACTS = "contracts";
    /// @dev The JSON object of recorded addresses, as built so far.
    string private _recorded;

    function run() external {
        uint256 key = vm.envUint("OPERATOR_PRIVATE_KEY");
        address operator = vm.addr(key);
        address investor = vm.envAddress("INVESTOR");
        address[4] memory partners = _partners();
        uint256 startBlock = block.number;

        vm.startBroadcast(key);

        _deploy("Faucet", type(Faucet).creationCode);
        _deploy("BatchExecutor", type(BatchExecutor).creationCode);
        address forwarder = _deploy("Forwarder", type(Forwarder).creationCode);
        Token token = Token(
            _deploy("Token", abi.encodePacked(type(Token).creationCode, abi.encode("Test USD", "tUSD", operator)))
        );

        Committee committee = Committee(
            _deploy(
                "Committee",
                abi.encodePacked(
                    type(Committee).creationCode, abi.encode(token, forwarder, operator, _rules(), partners)
                )
            )
        );
        PortfolioBadge badge = PortfolioBadge(
            _deploy("PortfolioBadge", abi.encodePacked(type(PortfolioBadge).creationCode, abi.encode(committee)))
        );
        Fund fund = Fund(
            _deploy(
                "Fund",
                abi.encodePacked(
                    type(Fund).creationCode,
                    abi.encode(token, "Onchain VC Fund", "OVC", PERMIT2, committee, QUORUM_BPS, MOTION_PERIOD)
                )
            )
        );
        if (address(committee.fund()) == address(0)) {
            committee.bind(fund, badge);
        }

        if (fund.totalSupply() == 0) {
            uint256 first = vm.envOr("FIRST_DEPOSIT", DEFAULT_FIRST_DEPOSIT) * 1e18;
            token.mint(operator, first);
            token.approve(address(fund), first);
            fund.deposit(first, investor);
        }

        uint256 minBond = committee.minBond();
        for (uint256 i = 0; i < partners.length; ++i) {
            uint256 bond = committee.getPartner(partners[i]).bond;
            if (bond >= minBond) continue;
            token.mint(operator, minBond - bond);
            token.approve(address(committee), minBond - bond);
            committee.postBond(partners[i], minBond - bond);
        }

        vm.stopBroadcast();
        _record(startBlock);
    }

    function _rules() private pure returns (Committee.Rules memory) {
        return Committee.Rules({
            minBond: 1000e18,
            maxAsk: 1000e18,
            reviewPeriod: 1 days,
            acceptPeriod: 3 days,
            unbondingPeriod: 30 days,
            slashBps: 2000
        });
    }

    function _partners() private view returns (address[4] memory partners) {
        uint256[] memory keys = vm.envUint("PARTNER_KEYS", ",");
        require(keys.length == 4, "PARTNER_KEYS must hold four keys, one per seat.");
        for (uint256 i = 0; i < 4; ++i) {
            partners[i] = vm.addr(keys[i]);
        }
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
