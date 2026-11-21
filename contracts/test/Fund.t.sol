// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Votes} from "@openzeppelin/contracts/governance/utils/Votes.sol";

import {Committee} from "../src/Committee.sol";
import {Fund} from "../src/Fund.sol";
import {FundSetup} from "./FundSetup.t.sol";

contract FundTest is FundSetup {
    function test_shares_countAsVotesWithoutDelegating() public {
        assertEq(fund.getVotes(investor), SEED);
        assertEq(fund.delegates(investor), investor);

        _invest(bob, 500e18);
        vm.prank(investor);
        assertTrue(fund.transfer(bob, 1000e18));
        assertEq(fund.getVotes(bob), 1500e18);
        assertEq(fund.getVotes(investor), SEED - 1000e18);

        vm.expectRevert(Fund.DelegationDisabled.selector);
        vm.prank(bob);
        fund.delegate(carol);
    }

    function test_draw_isOnlyForTheCommittee() public {
        vm.expectRevert(Fund.NotTheCommittee.selector);
        fund.draw(1);
    }

    function test_redeem_paysOutWhatIsNotTiedUpInDeals() public {
        _funded();
        // 400 was drawn for the deal, so the shares are now worth what is left.
        assertEq(fund.totalAssets(), SEED - 400e18);
        assertEq(fund.maxWithdraw(investor), SEED - 400e18);

        vm.prank(investor);
        fund.redeem(SEED, investor, investor);
        assertEq(token.balanceOf(investor), SEED - 400e18);
    }

    // ---------------------------------------------------------------- vetoes

    function test_proposeVeto_withMostSharesStopsTheDealAtOnce() public {
        uint256 dealId = _funded();
        vm.roll(block.number + 1);

        vm.expectEmit(address(fund));
        emit Fund.MotionCarried(1);
        vm.prank(investor);
        uint256 motionId = fund.proposeVeto(dealId);

        assertEq(motionId, 1);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Vetoed));
        Fund.Motion memory motion = fund.motion(motionId);
        assertTrue(motion.carried);
        assertEq(uint8(motion.kind), uint8(Fund.Kind.Veto));
        assertEq(motion.dealId, dealId);
        assertEq(motion.support, SEED);
        assertEq(motion.snapshot, committee.getDeal(dealId).approvedAt);
        // Tranche two came back, and the three approvers' slashed bonds came in.
        assertEq(fund.totalAssets(), SEED - 160e18 + 3 * (MIN_BOND * SLASH_BPS / 10_000));
    }

    function test_proposeVeto_needsTheQuorumAcrossInvestors() public {
        _invest(bob, SEED);
        _invest(carol, SEED / 2);
        vm.roll(block.number + 1);
        uint256 dealId = _funded();
        vm.roll(block.number + 1);

        // 100k of 250k is short of half.
        vm.prank(investor);
        uint256 motionId = fund.proposeVeto(dealId);
        assertEq(fund.quorumOf(motionId), 125_000e18);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Funded));

        vm.expectRevert(Fund.AlreadySupported.selector);
        vm.prank(investor);
        fund.support(motionId);
        vm.expectRevert(abi.encodeWithSelector(Fund.MotionPending.selector, motionId));
        vm.prank(bob);
        fund.proposeVeto(dealId);

        vm.prank(carol);
        fund.support(motionId);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Vetoed));
        assertTrue(fund.motion(motionId).carried);
        assertEq(fund.motion(motionId).support, 150_000e18);
    }

    function test_proposeVeto_readsWeightAtTheBlockTheDealWasApproved() public {
        uint256 dealId = _funded();
        vm.roll(block.number + 1);
        // Shares bought once the decision was known do not count.
        _invest(bob, 3 * SEED);
        vm.roll(block.number + 1);

        vm.expectRevert(Fund.NoWeight.selector);
        vm.prank(bob);
        fund.proposeVeto(dealId);

        // And the investor's weight is what it was then, not the smaller share it is now.
        vm.prank(investor);
        fund.proposeVeto(dealId);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Vetoed));
    }

    function test_proposeVeto_onlyForDealsStillRunning() public {
        uint256 dealId = _pitch(500e18);
        vm.expectRevert(Fund.NotVetoable.selector);
        vm.prank(investor);
        fund.proposeVeto(dealId);

        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Technology, dealId, false);
        vm.expectRevert(Fund.NotVetoable.selector);
        vm.prank(investor);
        fund.proposeVeto(dealId);
    }

    function test_proposeVeto_canStartAgainOnceTheLastMotionLapsed() public {
        _invest(bob, SEED / 2);
        vm.roll(block.number + 1);
        uint256 dealId = _funded();
        vm.roll(block.number + 1);

        vm.prank(bob);
        uint256 first = fund.proposeVeto(dealId);
        vm.warp(block.timestamp + MOTION_PERIOD + 1);

        vm.expectRevert(Fund.MotionClosed.selector);
        vm.prank(investor);
        fund.support(first);

        vm.prank(investor);
        uint256 second = fund.proposeVeto(dealId);
        assertEq(second, first + 1);
        assertEq(fund.vetoMotionOf(dealId), second);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Vetoed));
    }

    // ---------------------------------------------------------------- seats

    function test_proposeReplace_givesTheSeatToTheCandidate() public {
        vm.prank(carol);
        committee.setProfile("Carol", keccak256("carol"));
        _bond(carol, MIN_BOND);

        vm.prank(investor);
        uint256 motionId = fund.proposeReplace(Committee.Role.Tokenomics, carol);

        Fund.Motion memory motion = fund.motion(motionId);
        assertEq(uint8(motion.kind), uint8(Fund.Kind.Replace));
        assertEq(uint8(motion.role), uint8(Committee.Role.Tokenomics));
        assertEq(motion.candidate, carol);
        assertEq(motion.snapshot, block.number - 1);
        assertTrue(motion.carried);
        assertEq(committee.getSeats()[2], carol);
        assertFalse(committee.getPartner(partners[2]).seated);
    }

    function test_proposeReplace_failsWholeWhenTheCandidateIsUnfit() public {
        vm.expectRevert(Committee.CandidateUnfit.selector);
        vm.prank(investor);
        fund.proposeReplace(Committee.Role.Tokenomics, carol);
        assertEq(fund.motionCount(), 0);
    }

    function test_proposeReplace_ignoresSharesBoughtInTheSameBlock() public {
        _invest(bob, 10 * SEED);
        vm.expectRevert(Fund.NoWeight.selector);
        vm.prank(bob);
        fund.proposeReplace(Committee.Role.Risk, address(0));
    }

    function test_motion_rejectsUnknownIds() public {
        vm.expectRevert(Fund.UnknownMotion.selector);
        fund.motion(1);
        vm.expectRevert(Fund.UnknownMotion.selector);
        fund.support(1);
    }

    function test_getPastVotes_rejectsTheCurrentBlock() public {
        vm.expectRevert(abi.encodeWithSelector(Votes.ERC5805FutureLookup.selector, block.number, block.number));
        fund.getPastVotes(investor, block.number);
    }
}
