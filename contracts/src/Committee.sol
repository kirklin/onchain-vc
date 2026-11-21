// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Fund} from "./Fund.sol";
import {PortfolioBadge} from "./PortfolioBadge.sol";

/// @title Committee
/// @notice The investment committee of a fund. Four partners hold one seat each, every one with
///         its own account, a published profile and a bond. Founders pitch a contract they have
///         deployed; three votes in favour approve the deal, two against reject it. The partner
///         on the risk seat then sets the terms, and the founder accepts them to receive the
///         first tranche. The second follows once three partners accept the milestone the founder
///         reports. Until it is paid, the fund's investors can veto the deal: what was not paid
///         out goes back to the fund, and every partner who approved the deal loses part of
///         their bond to it.
/// @dev Founders sign their calls and a relayer sends them through the trusted forwarder
///      (ERC-2771), so they need no native tokens. Partners send their own transactions.
contract Committee is ERC2771Context, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Role {
        Product,
        Technology,
        Tokenomics,
        Risk
    }

    enum Stage {
        Review,
        Approved,
        Rejected,
        Offered,
        Funded,
        Milestone,
        Completed,
        Vetoed,
        Expired
    }

    struct Rules {
        /// @notice A partner votes only while their bond is at least this much.
        uint128 minBond;
        /// @notice The most a founder may ask for.
        uint128 maxAsk;
        /// @notice How long the partners have to decide on a pitch or a milestone, and the risk
        ///         partner to set terms.
        uint32 reviewPeriod;
        /// @notice How long a founder has to accept the terms.
        uint32 acceptPeriod;
        /// @notice How long an unseated partner's bond stays answerable for their votes.
        uint32 unbondingPeriod;
        /// @notice The share of an approving partner's bond a veto takes, in basis points.
        uint16 slashBps;
    }

    struct Partner {
        string name;
        /// @notice keccak256 of the partner's published profile: who they are, the instructions
        ///         they follow and the model that runs them.
        bytes32 profileHash;
        uint256 bond;
        /// @notice When an unseated partner may take their bond back.
        uint48 releasesAt;
        bool seated;
        Role role;
    }

    struct Ballot {
        address voter;
        bool cast;
        bool inFavour;
        uint8 score;
    }

    struct Deal {
        address founder;
        /// @notice When the current stage runs out: the end of a review, of the time to accept,
        ///         or the milestone's due date.
        uint48 deadline;
        Stage stage;
        /// @notice 0 for the decision to invest, then one round per milestone report.
        uint8 round;
        uint8 inFavour;
        uint8 against;
        uint16 firstTrancheBps;
        address project;
        uint48 pitchedAt;
        /// @notice The block the deal was approved in, where investors' weight for a veto is read.
        uint48 approvedAt;
        uint128 ask;
        uint128 amount;
        uint128 paid;
        uint48 milestoneDue;
        uint16 milestoneDays;
        string name;
        string pitchUri;
        string termsUri;
        string proofUri;
    }

    uint8 public constant SEATS = 4;
    uint8 public constant QUORUM = 3;
    uint16 public constant MIN_FIRST_TRANCHE_BPS = 1000;
    uint16 public constant MAX_FIRST_TRANCHE_BPS = 9000;
    uint16 public constant MAX_MILESTONE_DAYS = 365;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_URI_BYTES = 128;

    IERC20 public immutable asset;
    /// @notice The account allowed to connect the fund and the badge, once.
    address private immutable _binder;

    Fund public fund;
    PortfolioBadge public badge;

    uint128 public immutable minBond;
    uint128 public immutable maxAsk;
    uint32 public immutable reviewPeriod;
    uint32 public immutable acceptPeriod;
    uint32 public immutable unbondingPeriod;
    uint16 public immutable slashBps;

    /// @notice Who holds each seat, by role. Empty while a seat is vacant.
    address[SEATS] private _seats;
    mapping(address account => Partner) private _partners;

    uint256 public dealCount;
    mapping(uint256 dealId => Deal) private _deals;
    mapping(uint256 dealId => mapping(uint256 round => Ballot[SEATS])) private _ballots;
    /// @notice The founder's deal that is still running, if any.
    mapping(address founder => uint256 dealId) public openDealOf;
    /// @notice The last deal pitched for a contract.
    mapping(address project => uint256 dealId) public dealOfProject;

    /// @notice Money drawn from the fund for deals and not yet paid out or returned.
    uint256 public committed;
    uint256 public totalBonds;

    event Bound(address indexed fund, address indexed badge);
    event ProfileSet(address indexed partner, string name, bytes32 profileHash);
    event BondPosted(address indexed partner, address indexed from, uint256 amount);
    event BondWithdrawn(address indexed partner, uint256 amount);
    event Seated(Role indexed role, address indexed partner);
    event Unseated(Role indexed role, address indexed partner);
    event Pitched(
        uint256 indexed dealId, address indexed founder, address indexed project, uint128 ask, string name, string uri
    );
    event StageChanged(uint256 indexed dealId, Stage stage);
    event Voted(
        uint256 indexed dealId, uint8 round, Role role, address indexed partner, bool inFavour, uint8 score, string uri
    );
    event Offered(uint256 indexed dealId, uint128 amount, uint16 firstTrancheBps, uint16 milestoneDays, string uri);
    event Paid(uint256 indexed dealId, address indexed founder, uint8 tranche, uint128 amount);
    event MilestoneSubmitted(uint256 indexed dealId, uint8 round, string uri);
    event Returned(uint256 indexed dealId, uint128 amount);
    event Slashed(uint256 indexed dealId, address indexed partner, uint256 amount);

    error AlreadyBound();
    error AlreadyVoted();
    error AmountOutOfRange();
    error AskOutOfRange();
    error BondLocked();
    error BondTooLow();
    error CandidateUnfit();
    error DeadlineNotPassed();
    error DeadlinePassed();
    error FounderBusy();
    error InvalidRules();
    error InvalidScore();
    error InvalidText();
    error MilestoneOutOfRange();
    error NotAContract();
    error NotAPartner();
    error NotTheBinder();
    error NotTheFounder();
    error NotTheFund();
    error NotTheRiskPartner();
    error ProjectTaken();
    error TrancheOutOfRange();
    error UnknownDeal();
    error WrongStage();

    modifier onlyFund() {
        if (msg.sender != address(fund)) revert NotTheFund();
        _;
    }

    /// @param founding The partners who take the seats, in the order of `Role`. They vote once
    ///        their bonds are posted and their profiles published.
    constructor(IERC20 asset_, address forwarder, address binder, Rules memory rules, address[SEATS] memory founding)
        ERC2771Context(forwarder)
    {
        if (binder == address(0)) revert InvalidRules();
        bool valid = rules.minBond > 0 && rules.maxAsk > 0 && rules.reviewPeriod > 0 && rules.acceptPeriod > 0
            && rules.slashBps <= 10_000;
        for (uint8 i = 0; i < SEATS; ++i) {
            for (uint8 j = 0; j < i; ++j) {
                valid = valid && founding[i] != founding[j];
            }
            valid = valid && founding[i] != address(0);
        }
        if (!valid) revert InvalidRules();

        asset = asset_;
        _binder = binder;
        minBond = rules.minBond;
        maxAsk = rules.maxAsk;
        reviewPeriod = rules.reviewPeriod;
        acceptPeriod = rules.acceptPeriod;
        unbondingPeriod = rules.unbondingPeriod;
        slashBps = rules.slashBps;

        for (uint8 i = 0; i < SEATS; ++i) {
            _seat(Role(i), founding[i]);
        }
    }

    /// @notice Connects the fund the committee invests from and the badge it gives founders.
    function bind(Fund fund_, PortfolioBadge badge_) external {
        if (msg.sender != _binder) revert NotTheBinder();
        if (address(fund) != address(0)) revert AlreadyBound();
        fund = fund_;
        badge = badge_;
        emit Bound(address(fund_), address(badge_));
    }

    // ---------------------------------------------------------------- partners

    /// @notice Publishes who the caller is as a partner, or a candidate for a seat.
    function setProfile(string calldata name, bytes32 profileHash) external {
        _checkText(name, MAX_NAME_BYTES);
        if (profileHash == bytes32(0)) revert InvalidText();
        address partner = _msgSender();
        _partners[partner].name = name;
        _partners[partner].profileHash = profileHash;
        emit ProfileSet(partner, name, profileHash);
    }

    /// @notice Adds to a partner's bond. Anyone may pay it.
    function postBond(address partner, uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountOutOfRange();
        _partners[partner].bond += amount;
        totalBonds += amount;
        emit BondPosted(partner, _msgSender(), amount);
        // The payer is the caller, read through the forwarder when it relays the call.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        asset.safeTransferFrom(_msgSender(), address(this), amount);
    }

    /// @notice Takes back part of the caller's bond, once they have left their seat and the
    ///         unbonding period is over.
    function withdrawBond(uint256 amount) external nonReentrant {
        address account = _msgSender();
        Partner storage partner = _partners[account];
        if (partner.seated || block.timestamp < partner.releasesAt) revert BondLocked();
        if (amount == 0 || amount > partner.bond) revert AmountOutOfRange();
        partner.bond -= amount;
        totalBonds -= amount;
        emit BondWithdrawn(account, amount);
        asset.safeTransfer(account, amount);
    }

    /// @notice Gives the seat for `role` to `candidate`, or leaves it vacant when `candidate` is
    ///         zero. Only the fund calls it, once its investors have decided.
    function replace(Role role, address candidate) external onlyFund {
        address incumbent = _seats[uint8(role)];
        if (incumbent != address(0)) {
            Partner storage leaving = _partners[incumbent];
            leaving.seated = false;
            leaving.releasesAt = SafeCast.toUint48(block.timestamp + unbondingPeriod);
            _seats[uint8(role)] = address(0);
            emit Unseated(role, incumbent);
        }
        if (candidate != address(0)) {
            Partner storage joining = _partners[candidate];
            if (joining.seated || joining.bond < minBond || joining.profileHash == bytes32(0)) revert CandidateUnfit();
            _seat(role, candidate);
        }
    }

    function _seat(Role role, address account) private {
        _seats[uint8(role)] = account;
        Partner storage partner = _partners[account];
        partner.seated = true;
        partner.role = role;
        emit Seated(role, account);
    }

    // ---------------------------------------------------------------- deals

    /// @notice Asks the fund to invest `ask` in `project`, a contract the caller deployed.
    /// @param name The project's name, as it appears on the founder's badge.
    /// @param uri Where the full pitch is kept, as an IPFS content identifier.
    function pitch(address project, uint128 ask, string calldata name, string calldata uri)
        external
        returns (uint256 dealId)
    {
        address founder = _msgSender();
        if (!_isContract(project)) revert NotAContract();
        if (ask == 0 || ask > maxAsk) revert AskOutOfRange();
        _checkText(name, MAX_NAME_BYTES);
        _checkText(uri, MAX_URI_BYTES);
        if (openDealOf[founder] != 0) revert FounderBusy();
        uint256 previous = dealOfProject[project];
        // A contract gets one decision. A pitch that ran out before the partners decided frees it.
        if (previous != 0 && !(_deals[previous].stage == Stage.Expired && _deals[previous].approvedAt == 0)) {
            revert ProjectTaken();
        }

        dealId = ++dealCount;
        Deal storage deal = _deals[dealId];
        deal.founder = founder;
        deal.project = project;
        deal.ask = ask;
        deal.name = name;
        deal.pitchUri = uri;
        deal.pitchedAt = SafeCast.toUint48(block.timestamp);
        deal.deadline = SafeCast.toUint48(block.timestamp + reviewPeriod);
        openDealOf[founder] = dealId;
        dealOfProject[project] = dealId;

        emit Pitched(dealId, founder, project, ask, name, uri);
        emit StageChanged(dealId, Stage.Review);
    }

    /// @notice Casts the caller's seat's vote on a pitch, or on a milestone report.
    /// @dev A seat that had not voted when the round was decided may still put its vote on
    ///      record until the deal moves on: before the terms are set, or before the founder
    ///      reports again. Such a vote changes nothing, but an approving one counts for a veto.
    /// @param score How the partner rates the deal, from 0 to 100.
    /// @param uri Where the partner's written opinion is kept.
    function vote(uint256 dealId, bool inFavour, uint8 score, string calldata uri) external nonReentrant {
        address voter = _msgSender();
        Partner storage partner = _partners[voter];
        if (!partner.seated) revert NotAPartner();
        if (partner.bond < minBond) revert BondTooLow();
        if (score > 100) revert InvalidScore();
        _checkText(uri, MAX_URI_BYTES);
        Deal storage deal = _deal(dealId);
        bool open = deal.stage == Stage.Review || deal.stage == Stage.Milestone;
        if (!open && !_decided(deal)) revert WrongStage();
        if (open && block.timestamp > deal.deadline) revert DeadlinePassed();

        Ballot storage ballot = _ballots[dealId][deal.round][uint8(partner.role)];
        if (ballot.cast) revert AlreadyVoted();
        ballot.voter = voter;
        ballot.cast = true;
        ballot.inFavour = inFavour;
        ballot.score = score;
        emit Voted(dealId, deal.round, partner.role, voter, inFavour, score, uri);

        if (inFavour) {
            deal.inFavour += 1;
        } else {
            deal.against += 1;
        }
        if (!open) return;

        if (deal.inFavour >= QUORUM) {
            _carry(dealId, deal);
        } else if (deal.against > SEATS - QUORUM) {
            _defeat(dealId, deal);
        }
    }

    /// @notice Sets the terms of an approved deal and sets the money aside for it. Only the
    ///         partner on the risk seat does this.
    /// @param amount What the fund invests, at most what the founder asked for.
    /// @param firstTrancheBps The share paid when the founder accepts, in basis points. The
    ///        rest is paid once the milestone is accepted.
    /// @param milestoneDays How long the founder has to reach the milestone after accepting.
    /// @param uri Where the terms are written out, the milestone included.
    function offer(uint256 dealId, uint128 amount, uint16 firstTrancheBps, uint16 milestoneDays, string calldata uri)
        external
        nonReentrant
    {
        address sender = _msgSender();
        if (sender != _seats[uint8(Role.Risk)]) revert NotTheRiskPartner();
        if (_partners[sender].bond < minBond) revert BondTooLow();
        Deal storage deal = _deal(dealId);
        if (deal.stage != Stage.Approved) revert WrongStage();
        if (block.timestamp > deal.deadline) revert DeadlinePassed();
        if (amount == 0 || amount > deal.ask) revert AmountOutOfRange();
        if (firstTrancheBps < MIN_FIRST_TRANCHE_BPS || firstTrancheBps > MAX_FIRST_TRANCHE_BPS) {
            revert TrancheOutOfRange();
        }
        if (milestoneDays == 0 || milestoneDays > MAX_MILESTONE_DAYS) revert MilestoneOutOfRange();
        _checkText(uri, MAX_URI_BYTES);

        deal.amount = amount;
        deal.firstTrancheBps = firstTrancheBps;
        deal.milestoneDays = milestoneDays;
        deal.termsUri = uri;
        _move(dealId, deal, Stage.Offered, block.timestamp + acceptPeriod);
        committed += amount;
        emit Offered(dealId, amount, firstTrancheBps, milestoneDays, uri);

        fund.draw(amount);
    }

    /// @notice Accepts the terms on offer. The first tranche and the portfolio badge go to the
    ///         founder at once.
    function accept(uint256 dealId) external nonReentrant {
        Deal storage deal = _deal(dealId);
        if (_msgSender() != deal.founder) revert NotTheFounder();
        if (deal.stage != Stage.Offered) revert WrongStage();
        if (block.timestamp > deal.deadline) revert DeadlinePassed();

        uint256 due = block.timestamp + uint256(deal.milestoneDays) * 1 days;
        deal.milestoneDue = SafeCast.toUint48(due);
        _move(dealId, deal, Stage.Funded, due);
        _pay(dealId, deal, 1, uint128(uint256(deal.amount) * deal.firstTrancheBps / 10_000));
        badge.mint(deal.founder, dealId);
    }

    /// @notice Reports the milestone as reached, for the partners to check.
    /// @param uri Where the evidence is kept.
    function submitMilestone(uint256 dealId, string calldata uri) external {
        Deal storage deal = _deal(dealId);
        if (_msgSender() != deal.founder) revert NotTheFounder();
        if (deal.stage != Stage.Funded) revert WrongStage();
        if (block.timestamp > deal.milestoneDue) revert DeadlinePassed();
        _checkText(uri, MAX_URI_BYTES);

        deal.round += 1;
        deal.inFavour = 0;
        deal.against = 0;
        deal.proofUri = uri;
        emit MilestoneSubmitted(dealId, deal.round, uri);
        _move(dealId, deal, Stage.Milestone, block.timestamp + reviewPeriod);
    }

    /// @notice Stops a deal the fund's investors voted down. Only the fund calls it.
    function veto(uint256 dealId) external nonReentrant onlyFund {
        Deal storage deal = _deal(dealId);
        if (!_vetoable(deal.stage)) revert WrongStage();
        _end(dealId, deal, Stage.Vetoed);

        Ballot[SEATS] storage ballots = _ballots[dealId][0];
        for (uint8 i = 0; i < SEATS; ++i) {
            Ballot storage ballot = ballots[i];
            if (!ballot.cast || !ballot.inFavour) continue;
            Partner storage partner = _partners[ballot.voter];
            uint256 slashed = partner.bond * slashBps / 10_000;
            if (slashed == 0) continue;
            partner.bond -= slashed;
            totalBonds -= slashed;
            emit Slashed(dealId, ballot.voter, slashed);
            asset.safeTransfer(address(fund), slashed);
        }
    }

    /// @notice Ends a deal whose current stage ran out. What was set aside for it and not paid
    ///         goes back to the fund. Anyone may call it.
    function close(uint256 dealId) external nonReentrant {
        Deal storage deal = _deal(dealId);
        if (!_running(deal.stage)) revert WrongStage();
        if (block.timestamp <= deal.deadline) revert DeadlineNotPassed();
        _end(dealId, deal, Stage.Expired);
    }

    // ---------------------------------------------------------------- views

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _deal(dealId);
    }

    /// @notice How each seat voted in a round, in the order of `Role`.
    function getBallots(uint256 dealId, uint256 round) external view returns (Ballot[SEATS] memory) {
        _deal(dealId);
        return _ballots[dealId][round];
    }

    function getPartner(address account) external view returns (Partner memory) {
        return _partners[account];
    }

    /// @notice Who holds each seat, in the order of `Role`. Zero for a vacant seat.
    function getSeats() external view returns (address[SEATS] memory) {
        return _seats;
    }

    /// @notice Whether investors can still veto the deal, and the block to read their weight at.
    function vetoSnapshot(uint256 dealId) external view returns (bool vetoable, uint48 approvedAt) {
        Deal storage deal = _deal(dealId);
        return (_vetoable(deal.stage), deal.approvedAt);
    }

    // ---------------------------------------------------------------- internals

    function _deal(uint256 dealId) private view returns (Deal storage deal) {
        if (dealId == 0 || dealId > dealCount) revert UnknownDeal();
        return _deals[dealId];
    }

    function _move(uint256 dealId, Deal storage deal, Stage stage, uint256 deadline) private {
        deal.stage = stage;
        deal.deadline = SafeCast.toUint48(deadline);
        emit StageChanged(dealId, stage);
    }

    /// @dev Three votes in favour: the deal is approved, or its milestone accepted and the rest paid.
    function _carry(uint256 dealId, Deal storage deal) private {
        if (deal.round == 0) {
            deal.approvedAt = SafeCast.toUint48(block.number);
            _move(dealId, deal, Stage.Approved, block.timestamp + reviewPeriod);
            return;
        }
        _move(dealId, deal, Stage.Completed, block.timestamp);
        delete openDealOf[deal.founder];
        _pay(dealId, deal, 2, deal.amount - deal.paid);
    }

    /// @dev Two votes against: the pitch is rejected, or the milestone report sent back.
    function _defeat(uint256 dealId, Deal storage deal) private {
        if (deal.round == 0) {
            _move(dealId, deal, Stage.Rejected, block.timestamp);
            delete openDealOf[deal.founder];
            return;
        }
        // The founder may report again until the milestone is due.
        _move(dealId, deal, Stage.Funded, deal.milestoneDue);
    }

    /// @dev Finishes a deal early, returning whatever was set aside for it and not paid. Before
    ///      terms are offered nothing is set aside.
    function _end(uint256 dealId, Deal storage deal, Stage stage) private {
        uint128 unpaid = deal.amount - deal.paid;
        _move(dealId, deal, stage, block.timestamp);
        delete openDealOf[deal.founder];
        if (unpaid == 0) return;
        committed -= unpaid;
        emit Returned(dealId, unpaid);
        asset.safeTransfer(address(fund), unpaid);
    }

    function _pay(uint256 dealId, Deal storage deal, uint8 tranche, uint128 amount) private {
        deal.paid += amount;
        committed -= amount;
        emit Paid(dealId, deal.founder, tranche, amount);
        asset.safeTransfer(deal.founder, amount);
    }

    /// @dev Whether the deal's current round has just been decided and nothing has happened since.
    function _decided(Deal storage deal) private view returns (bool) {
        if (deal.round == 0) return deal.stage == Stage.Approved || deal.stage == Stage.Rejected;
        return deal.stage == Stage.Completed || deal.stage == Stage.Funded;
    }

    function _vetoable(Stage stage) private pure returns (bool) {
        return stage == Stage.Approved || stage == Stage.Offered || stage == Stage.Funded || stage == Stage.Milestone;
    }

    function _running(Stage stage) private pure returns (bool) {
        return stage == Stage.Review || _vetoable(stage);
    }

    /// @dev Deployed code, excluding an account that only delegates to code (EIP-7702), whose
    ///      code is the 3-byte prefix 0xef0100 followed by an address.
    function _isContract(address account) private view returns (bool) {
        bytes memory code = account.code;
        if (code.length == 0) return false;
        return !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
    }

    /// @dev Text that ends up inside JSON and SVG: 1 to `maxBytes` bytes, with no control
    ///      characters and none of the characters those formats would need escaped.
    function _checkText(string calldata text, uint256 maxBytes) private pure {
        bytes calldata raw = bytes(text);
        bool valid = raw.length > 0 && raw.length <= maxBytes;
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 char = raw[i];
            valid = valid && char >= 0x20 && char != 0x7f && char != '"' && char != "\\" && char != "<" && char != ">"
                && char != "&";
        }
        if (!valid) revert InvalidText();
    }
}
