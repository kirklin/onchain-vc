// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

import {Committee} from "../src/Committee.sol";
import {Forwarder} from "../src/Forwarder.sol";
import {Fund} from "../src/Fund.sol";
import {PortfolioBadge} from "../src/PortfolioBadge.sol";
import {Token} from "../src/Token.sol";
import {BaseTest} from "./Base.t.sol";

/// @dev A deployed project contract for founders to pitch.
contract Project {
    uint256 public value;

    function set(uint256 value_) external {
        value = value_;
    }
}

/// @notice A committee, its fund and badge, wired the way script/Deploy.s.sol wires them, with
///         four bonded partners, an investor holding every share, and a founder.
abstract contract FundSetup is BaseTest {
    uint128 internal constant MIN_BOND = 1000e18;
    uint128 internal constant MAX_ASK = 1000e18;
    uint32 internal constant REVIEW_PERIOD = 1 days;
    uint32 internal constant ACCEPT_PERIOD = 3 days;
    uint32 internal constant UNBONDING_PERIOD = 30 days;
    uint16 internal constant SLASH_BPS = 2000;
    uint16 internal constant QUORUM_BPS = 5000;
    uint32 internal constant MOTION_PERIOD = 3 days;
    uint256 internal constant SEED = 100_000e18;

    string internal constant URI = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    Token internal token;
    Forwarder internal forwarder;
    Committee internal committee;
    Fund internal fund;
    PortfolioBadge internal badge;

    address[4] internal partners;
    uint256 internal founderKey = 0xF0;
    address internal founder = vm.addr(founderKey);
    address internal investor = makeAddr("investor");
    Project internal project;

    function setUp() public virtual {
        _installPermit2();
        for (uint256 i = 0; i < 4; ++i) {
            partners[i] = makeAddr(string.concat("partner", vm.toString(i)));
        }

        token = new Token("Test USD", "tUSD", admin);
        forwarder = new Forwarder();
        committee = new Committee(token, address(forwarder), admin, _rules(), partners);
        badge = new PortfolioBadge(committee);
        fund = new Fund(token, "Onchain VC Fund", "OVC", PERMIT2, committee, QUORUM_BPS, MOTION_PERIOD);
        vm.prank(admin);
        committee.bind(fund, badge);

        _invest(investor, SEED);
        for (uint256 i = 0; i < 4; ++i) {
            _bond(partners[i], MIN_BOND);
            vm.prank(partners[i]);
            committee.setProfile(string.concat("Partner ", vm.toString(i)), keccak256(abi.encode(i)));
        }

        project = new Project();
        vm.roll(block.number + 1);
    }

    function _rules() internal pure returns (Committee.Rules memory) {
        return Committee.Rules({
            minBond: MIN_BOND,
            maxAsk: MAX_ASK,
            reviewPeriod: REVIEW_PERIOD,
            acceptPeriod: ACCEPT_PERIOD,
            unbondingPeriod: UNBONDING_PERIOD,
            slashBps: SLASH_BPS
        });
    }

    function _invest(address account, uint256 amount) internal {
        vm.prank(admin);
        token.mint(account, amount);
        vm.startPrank(account);
        token.approve(address(fund), amount);
        fund.deposit(amount, account);
        vm.stopPrank();
    }

    function _bond(address partner, uint256 amount) internal {
        vm.prank(admin);
        token.mint(admin, amount);
        vm.startPrank(admin);
        token.approve(address(committee), amount);
        committee.postBond(partner, amount);
        vm.stopPrank();
    }

    function _partner(Committee.Role role) internal view returns (address) {
        return partners[uint8(role)];
    }

    function _pitch(uint128 ask) internal returns (uint256 dealId) {
        vm.prank(founder);
        dealId = committee.pitch(address(project), ask, "Demo Project", URI);
    }

    function _vote(Committee.Role role, uint256 dealId, bool inFavour) internal {
        vm.prank(_partner(role));
        committee.vote(dealId, inFavour, inFavour ? 80 : 20, URI);
    }

    /// @dev Product, technology and tokenomics vote for it, which carries it.
    function _approve(uint256 dealId) internal {
        _vote(Committee.Role.Product, dealId, true);
        _vote(Committee.Role.Technology, dealId, true);
        _vote(Committee.Role.Tokenomics, dealId, true);
    }

    function _offer(uint256 dealId, uint128 amount) internal {
        vm.prank(_partner(Committee.Role.Risk));
        committee.offer(dealId, amount, 4000, 30, URI);
    }

    /// @dev A deal pitched for 500, approved, offered at 400 with 40% up front, and accepted.
    function _funded() internal returns (uint256 dealId) {
        dealId = _pitch(500e18);
        _approve(dealId);
        vm.roll(block.number + 1);
        _offer(dealId, 400e18);
        vm.prank(founder);
        committee.accept(dealId);
    }

    function _stage(uint256 dealId) internal view returns (Committee.Stage) {
        return committee.getDeal(dealId).stage;
    }

    /// @dev Whatever the committee holds is either a bond or money set aside for a deal.
    function _assertHoldings() internal view {
        assertEq(token.balanceOf(address(committee)), committee.totalBonds() + committee.committed());
    }

    /// @dev Signs `data` for the forwarder as `key`'s account, the way the relayer receives it.
    function _forwardRequest(uint256 key, address to, bytes memory data)
        internal
        view
        returns (ERC2771Forwarder.ForwardRequestData memory request)
    {
        address from = vm.addr(key);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
                ),
                from,
                to,
                0,
                500_000,
                forwarder.nonces(from),
                deadline,
                keccak256(data)
            )
        );
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            forwarder.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        request = ERC2771Forwarder.ForwardRequestData({
            from: from,
            to: to,
            value: 0,
            gas: 500_000,
            deadline: deadline,
            data: data,
            signature: _signature(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)))
        });
    }
}
