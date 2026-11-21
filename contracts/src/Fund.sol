// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Committee} from "./Committee.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {Vault} from "./Vault.sol";

/// @title Fund
/// @notice The money the committee invests. Investors deposit the asset and receive shares
///         (ERC-4626); each share is a claim on an equal slice of what the fund holds and has not
///         put into a deal. Shares also carry the investors' say over the committee: by share
///         weight they can veto a deal before its last tranche is paid, and give a seat on the
///         committee to someone else.
/// @dev Weight is read from past checkpoints (ERC20Votes), so shares bought after the moment a
///      motion looks at do not count. Every holder's shares count for themselves: delegating is
///      turned off, and no one has to delegate to their own account first.
contract Fund is Vault, ERC20Votes {
    using SafeERC20 for IERC20;

    enum Kind {
        Veto,
        Replace
    }

    struct Motion {
        Kind kind;
        Committee.Role role;
        bool carried;
        /// @notice The block whose share balances count.
        uint48 snapshot;
        uint48 deadline;
        address proposer;
        /// @notice Who takes the seat, for a replacement. Zero leaves it vacant.
        address candidate;
        uint256 dealId;
        uint256 support;
    }

    Committee public immutable committee;
    /// @notice The share of all weight at the snapshot a motion needs, in basis points.
    uint16 public immutable quorumBps;
    /// @notice How long a motion stays open.
    uint32 public immutable motionPeriod;

    uint256 public motionCount;
    mapping(uint256 motionId => Motion) private _motions;
    mapping(uint256 motionId => mapping(address investor => bool)) public supported;
    /// @notice The latest veto motion against each deal.
    mapping(uint256 dealId => uint256 motionId) public vetoMotionOf;

    event Drawn(uint256 amount);
    event MotionOpened(
        uint256 indexed motionId,
        Kind kind,
        uint256 indexed dealId,
        Committee.Role role,
        address candidate,
        address indexed proposer,
        uint48 snapshot,
        uint48 deadline
    );
    event MotionSupported(uint256 indexed motionId, address indexed investor, uint256 weight, uint256 support);
    event MotionCarried(uint256 indexed motionId);

    error AlreadySupported();
    error DelegationDisabled();
    error InvalidRules();
    error MotionClosed();
    error MotionPending(uint256 motionId);
    error NoWeight();
    error NotTheCommittee();
    error NotVetoable();
    error UnknownMotion();

    constructor(
        IERC20 asset_,
        string memory name,
        string memory symbol,
        IPermit2 permit2,
        Committee committee_,
        uint16 quorumBps_,
        uint32 motionPeriod_
    ) Vault(asset_, name, symbol, permit2) EIP712(name, "1") {
        if (quorumBps_ == 0 || quorumBps_ > 10_000 || motionPeriod_ == 0) revert InvalidRules();
        committee = committee_;
        quorumBps = quorumBps_;
        motionPeriod = motionPeriod_;
    }

    /// @notice Hands money to the committee for a deal it has just set the terms of.
    function draw(uint256 amount) external {
        if (msg.sender != address(committee)) revert NotTheCommittee();
        emit Drawn(amount);
        IERC20(asset()).safeTransfer(address(committee), amount);
    }

    // ---------------------------------------------------------------- motions

    /// @notice Moves to stop a deal. Weight is read at the block the committee approved it.
    function proposeVeto(uint256 dealId) external returns (uint256 motionId) {
        (bool vetoable, uint48 approvedAt) = committee.vetoSnapshot(dealId);
        if (!vetoable) revert NotVetoable();
        uint256 latest = vetoMotionOf[dealId];
        if (latest != 0 && !_motions[latest].carried && block.timestamp <= _motions[latest].deadline) {
            revert MotionPending(latest);
        }
        motionId = _open(Kind.Veto, dealId, Committee.Role.Product, address(0), approvedAt);
        vetoMotionOf[dealId] = motionId;
        _support(motionId, msg.sender);
    }

    /// @notice Moves to give the seat for `role` to `candidate`, or to leave it vacant when
    ///         `candidate` is zero. Weight is read at the block before the motion.
    function proposeReplace(Committee.Role role, address candidate) external returns (uint256 motionId) {
        motionId = _open(Kind.Replace, 0, role, candidate, clock() - 1);
        _support(motionId, msg.sender);
    }

    /// @notice Adds the caller's weight to a motion. Once the support reaches the quorum the
    ///         motion is carried out in the same transaction.
    function support(uint256 motionId) external {
        _support(motionId, msg.sender);
    }

    function motion(uint256 motionId) external view returns (Motion memory) {
        if (motionId == 0 || motionId > motionCount) revert UnknownMotion();
        return _motions[motionId];
    }

    /// @notice The weight a motion needs to be carried.
    function quorumOf(uint256 motionId) public view returns (uint256) {
        if (motionId == 0 || motionId > motionCount) revert UnknownMotion();
        return (getPastTotalSupply(_motions[motionId].snapshot) * quorumBps + 9999) / 10_000;
    }

    function _open(Kind kind, uint256 dealId, Committee.Role role, address candidate, uint48 snapshot)
        private
        returns (uint256 motionId)
    {
        motionId = ++motionCount;
        uint48 deadline = SafeCast.toUint48(block.timestamp + motionPeriod);
        _motions[motionId] = Motion({
            kind: kind,
            role: role,
            carried: false,
            snapshot: snapshot,
            deadline: deadline,
            proposer: msg.sender,
            candidate: candidate,
            dealId: dealId,
            support: 0
        });
        emit MotionOpened(motionId, kind, dealId, role, candidate, msg.sender, snapshot, deadline);
    }

    function _support(uint256 motionId, address investor) private {
        if (motionId == 0 || motionId > motionCount) revert UnknownMotion();
        Motion storage current = _motions[motionId];
        if (current.carried || block.timestamp > current.deadline) revert MotionClosed();
        if (supported[motionId][investor]) revert AlreadySupported();
        uint256 weight = getPastVotes(investor, current.snapshot);
        if (weight == 0) revert NoWeight();

        supported[motionId][investor] = true;
        current.support += weight;
        emit MotionSupported(motionId, investor, weight, current.support);

        if (current.support < quorumOf(motionId)) return;
        current.carried = true;
        emit MotionCarried(motionId);
        if (current.kind == Kind.Veto) {
            committee.veto(current.dealId);
        } else {
            committee.replace(current.role, current.candidate);
        }
    }

    // ---------------------------------------------------------------- shares as votes

    /// @notice Every account's shares count for itself.
    function delegates(address account) public pure override returns (address) {
        return account;
    }

    function _delegate(address, address) internal pure override {
        revert DelegationDisabled();
    }

    function decimals() public view override(ERC20, ERC4626) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}
