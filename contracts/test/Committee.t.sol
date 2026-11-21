// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Committee} from "../src/Committee.sol";
import {FundSetup, Project} from "./FundSetup.t.sol";

contract CommitteeTest is FundSetup {
    // ---------------------------------------------------------------- set-up

    function test_constructor_seatsTheFoundingPartnersInRoleOrder() public view {
        address[4] memory seats = committee.getSeats();
        for (uint8 i = 0; i < 4; ++i) {
            assertEq(seats[i], partners[i]);
            Committee.Partner memory partner = committee.getPartner(partners[i]);
            assertTrue(partner.seated);
            assertEq(uint8(partner.role), i);
            assertEq(partner.bond, MIN_BOND);
        }
    }

    function test_constructor_refusesAMissingOrRepeatedPartner() public {
        address[4] memory repeated = partners;
        repeated[3] = partners[0];
        vm.expectRevert(Committee.InvalidRules.selector);
        new Committee(token, address(forwarder), admin, _rules(), repeated);

        address[4] memory missing = partners;
        missing[2] = address(0);
        vm.expectRevert(Committee.InvalidRules.selector);
        new Committee(token, address(forwarder), admin, _rules(), missing);

        vm.expectRevert(Committee.InvalidRules.selector);
        new Committee(token, address(forwarder), address(0), _rules(), partners);

        Committee.Rules memory rules = _rules();
        rules.slashBps = 10_001;
        vm.expectRevert(Committee.InvalidRules.selector);
        new Committee(token, address(forwarder), admin, rules, partners);
    }

    function test_bind_isForTheBinderAndOnlyOnce() public {
        Committee fresh = new Committee(token, address(forwarder), admin, _rules(), partners);
        vm.expectRevert(Committee.NotTheBinder.selector);
        fresh.bind(fund, badge);

        vm.startPrank(admin);
        fresh.bind(fund, badge);
        vm.expectRevert(Committee.AlreadyBound.selector);
        fresh.bind(fund, badge);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- partners

    function test_setProfile_publishesNameAndHash() public {
        vm.expectEmit(address(committee));
        emit Committee.ProfileSet(carol, "Carol", keccak256("carol"));
        vm.prank(carol);
        committee.setProfile("Carol", keccak256("carol"));

        Committee.Partner memory candidate = committee.getPartner(carol);
        assertEq(candidate.name, "Carol");
        assertEq(candidate.profileHash, keccak256("carol"));
        assertFalse(candidate.seated);
    }

    function test_setProfile_refusesTextThatWouldBreakJsonOrSvg() public {
        string[6] memory names = ["", 'Say "hi"', "a<b", "a&b", "back\\slash", "line\nbreak"];
        for (uint256 i = 0; i < names.length; ++i) {
            vm.expectRevert(Committee.InvalidText.selector);
            vm.prank(carol);
            committee.setProfile(names[i], keccak256("carol"));
        }
        vm.expectRevert(Committee.InvalidText.selector);
        vm.prank(carol);
        committee.setProfile("Carol", bytes32(0));
    }

    function test_postBond_letsAnyonePayIntoAPartnersBond() public {
        vm.prank(admin);
        token.mint(bob, 300e18);
        vm.startPrank(bob);
        token.approve(address(committee), 300e18);
        vm.expectEmit(address(committee));
        emit Committee.BondPosted(partners[1], bob, 300e18);
        committee.postBond(partners[1], 300e18);
        vm.stopPrank();

        assertEq(committee.getPartner(partners[1]).bond, MIN_BOND + 300e18);
        assertEq(committee.totalBonds(), 4 * MIN_BOND + 300e18);
        _assertHoldings();
    }

    function test_withdrawBond_waitsUntilThePartnerLeftAndTheUnbondingIsOver() public {
        vm.expectRevert(Committee.BondLocked.selector);
        vm.prank(partners[0]);
        committee.withdrawBond(1);

        vm.prank(address(fund));
        committee.replace(Committee.Role.Product, address(0));
        vm.expectRevert(Committee.BondLocked.selector);
        vm.prank(partners[0]);
        committee.withdrawBond(1);

        vm.warp(block.timestamp + UNBONDING_PERIOD);
        vm.startPrank(partners[0]);
        vm.expectRevert(Committee.AmountOutOfRange.selector);
        committee.withdrawBond(MIN_BOND + 1);
        committee.withdrawBond(MIN_BOND);
        vm.stopPrank();

        assertEq(token.balanceOf(partners[0]), MIN_BOND);
        assertEq(committee.getPartner(partners[0]).bond, 0);
        _assertHoldings();
    }

    function test_replace_isOnlyForTheFund() public {
        vm.expectRevert(Committee.NotTheFund.selector);
        committee.replace(Committee.Role.Risk, address(0));
    }

    function test_replace_unseatsTheIncumbentAndSeatsABondedCandidate() public {
        vm.prank(carol);
        committee.setProfile("Carol", keccak256("carol"));

        vm.expectRevert(Committee.CandidateUnfit.selector);
        vm.prank(address(fund));
        committee.replace(Committee.Role.Risk, carol);

        _bond(carol, MIN_BOND);
        vm.expectEmit(address(committee));
        emit Committee.Unseated(Committee.Role.Risk, partners[3]);
        vm.expectEmit(address(committee));
        emit Committee.Seated(Committee.Role.Risk, carol);
        vm.prank(address(fund));
        committee.replace(Committee.Role.Risk, carol);

        assertEq(committee.getSeats()[3], carol);
        assertFalse(committee.getPartner(partners[3]).seated);
        assertEq(committee.getPartner(partners[3]).releasesAt, block.timestamp + UNBONDING_PERIOD);
        assertEq(uint8(committee.getPartner(carol).role), uint8(Committee.Role.Risk));

        // A seated partner cannot take a second seat.
        vm.expectRevert(Committee.CandidateUnfit.selector);
        vm.prank(address(fund));
        committee.replace(Committee.Role.Product, carol);
    }

    function test_replace_canLeaveASeatVacant() public {
        vm.prank(address(fund));
        committee.replace(Committee.Role.Technology, address(0));
        assertEq(committee.getSeats()[1], address(0));

        uint256 dealId = _pitch(100e18);
        vm.expectRevert(Committee.NotAPartner.selector);
        vm.prank(partners[1]);
        committee.vote(dealId, true, 90, URI);
    }

    // ---------------------------------------------------------------- pitching

    function test_pitch_opensADealForReview() public {
        vm.expectEmit(address(committee));
        emit Committee.Pitched(1, founder, address(project), 500e18, "Demo Project", URI);
        vm.expectEmit(address(committee));
        emit Committee.StageChanged(1, Committee.Stage.Review);
        uint256 dealId = _pitch(500e18);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(dealId, 1);
        assertEq(deal.founder, founder);
        assertEq(deal.project, address(project));
        assertEq(deal.ask, 500e18);
        assertEq(deal.name, "Demo Project");
        assertEq(deal.pitchUri, URI);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Review));
        assertEq(deal.deadline, block.timestamp + REVIEW_PERIOD);
        assertEq(committee.openDealOf(founder), dealId);
        assertEq(committee.dealOfProject(address(project)), dealId);
    }

    function test_pitch_needsAContractThatIsNotJustADelegatingAccount() public {
        vm.expectRevert(Committee.NotAContract.selector);
        vm.prank(founder);
        committee.pitch(bob, 100e18, "Demo Project", URI);

        // An account delegating to code (EIP-7702) carries 0xef0100 and the code's address.
        vm.etch(bob, abi.encodePacked(hex"ef0100", address(project)));
        vm.expectRevert(Committee.NotAContract.selector);
        vm.prank(founder);
        committee.pitch(bob, 100e18, "Demo Project", URI);
    }

    function test_pitch_keepsTheAskWithinTheLimit() public {
        vm.startPrank(founder);
        vm.expectRevert(Committee.AskOutOfRange.selector);
        committee.pitch(address(project), 0, "Demo Project", URI);
        vm.expectRevert(Committee.AskOutOfRange.selector);
        committee.pitch(address(project), MAX_ASK + 1, "Demo Project", URI);
        vm.stopPrank();
    }

    function test_pitch_refusesNamesAndUrisOutsideTheLimits() public {
        vm.startPrank(founder);
        vm.expectRevert(Committee.InvalidText.selector);
        committee.pitch(address(project), 100e18, "A name far longer than thirty-two bytes", URI);
        vm.expectRevert(Committee.InvalidText.selector);
        committee.pitch(address(project), 100e18, "<script>", URI);
        vm.expectRevert(Committee.InvalidText.selector);
        committee.pitch(address(project), 100e18, "Demo Project", "");
        vm.stopPrank();
    }

    function test_pitch_acceptsANameInAnyScript() public {
        vm.prank(founder);
        uint256 dealId = committee.pitch(address(project), 100e18, unicode"链上留言板", URI);
        assertEq(committee.getDeal(dealId).name, unicode"链上留言板");
    }

    function test_pitch_allowsOneRunningDealPerFounderAndOneDecisionPerContract() public {
        uint256 dealId = _pitch(100e18);
        Project other = new Project();

        vm.expectRevert(Committee.FounderBusy.selector);
        vm.prank(founder);
        committee.pitch(address(other), 100e18, "Other", URI);

        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Risk, dealId, false);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Rejected));

        // The founder is free again, but the rejected contract stays decided.
        vm.expectRevert(Committee.ProjectTaken.selector);
        vm.prank(founder);
        committee.pitch(address(project), 100e18, "Demo Project", URI);
        vm.prank(bob);
        vm.expectRevert(Committee.ProjectTaken.selector);
        committee.pitch(address(project), 100e18, "Demo Project", URI);

        vm.prank(founder);
        assertEq(committee.pitch(address(other), 100e18, "Other", URI), 2);
    }

    function test_pitch_freesAContractWhoseReviewRanOutUndecided() public {
        uint256 dealId = _pitch(100e18);
        vm.warp(block.timestamp + REVIEW_PERIOD + 1);
        committee.close(dealId);

        uint256 again = _pitch(100e18);
        assertEq(again, dealId + 1);
        assertEq(committee.dealOfProject(address(project)), again);
    }

    function test_pitch_throughTheForwarderNamesTheSigner() public {
        bytes memory data = abi.encodeCall(Committee.pitch, (address(project), 200e18, "Demo Project", URI));
        forwarder.execute(_forwardRequest(founderKey, address(committee), data));

        assertEq(committee.getDeal(1).founder, founder);
        assertEq(committee.openDealOf(founder), 1);
    }

    // ---------------------------------------------------------------- voting

    function test_vote_approvesOnTheThirdVoteInFavour() public {
        uint256 dealId = _pitch(500e18);
        _vote(Committee.Role.Product, dealId, true);
        _vote(Committee.Role.Risk, dealId, false);
        _vote(Committee.Role.Technology, dealId, true);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Review));

        vm.expectEmit(address(committee));
        emit Committee.Voted(dealId, 0, Committee.Role.Tokenomics, partners[2], true, 80, URI);
        vm.expectEmit(address(committee));
        emit Committee.StageChanged(dealId, Committee.Stage.Approved);
        _vote(Committee.Role.Tokenomics, dealId, true);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Approved));
        assertEq(deal.approvedAt, block.number);
        assertEq(deal.inFavour, 3);
        assertEq(deal.against, 1);
        assertEq(deal.deadline, block.timestamp + REVIEW_PERIOD);

        Committee.Ballot[4] memory ballots = committee.getBallots(dealId, 0);
        assertEq(ballots[0].voter, partners[0]);
        assertTrue(ballots[0].inFavour);
        assertEq(ballots[0].score, 80);
        assertFalse(ballots[3].inFavour);
        assertTrue(ballots[3].cast);
    }

    function test_vote_rejectsOnTheSecondVoteAgainst() public {
        uint256 dealId = _pitch(500e18);
        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Technology, dealId, true);
        _vote(Committee.Role.Tokenomics, dealId, false);

        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Rejected));
        assertEq(committee.openDealOf(founder), 0);
    }

    function test_vote_afterTheDecisionGoesOnRecordWithoutChangingIt() public {
        uint256 dealId = _pitch(500e18);
        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Technology, dealId, false);

        vm.expectEmit(address(committee));
        emit Committee.Voted(dealId, 0, Committee.Role.Risk, partners[3], true, 80, URI);
        _vote(Committee.Role.Risk, dealId, true);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Rejected));
        assertEq(deal.inFavour, 1);
        assertEq(deal.against, 2);
        assertTrue(committee.getBallots(dealId, 0)[3].inFavour);
        vm.expectRevert(Committee.AlreadyVoted.selector);
        _vote(Committee.Role.Risk, dealId, true);
    }

    function test_vote_closesForGoodOnceTheTermsAreSet() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _offer(dealId, 400e18);

        vm.expectRevert(Committee.WrongStage.selector);
        _vote(Committee.Role.Risk, dealId, true);
    }

    function test_vote_onARejectedMilestoneStaysOpenUntilTheNextReport() public {
        uint256 dealId = _funded();
        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Technology, dealId, false);
        _vote(Committee.Role.Risk, dealId, true);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Funded));
        assertTrue(committee.getBallots(dealId, 1)[3].cast);

        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
        assertFalse(committee.getBallots(dealId, 2)[3].cast);
    }

    function test_vote_countsEachSeatOncePerRound() public {
        uint256 dealId = _pitch(500e18);
        _vote(Committee.Role.Product, dealId, true);
        vm.expectRevert(Committee.AlreadyVoted.selector);
        _vote(Committee.Role.Product, dealId, false);

        // The seat keeps its vote when someone else takes it.
        vm.prank(carol);
        committee.setProfile("Carol", keccak256("carol"));
        _bond(carol, MIN_BOND);
        vm.prank(address(fund));
        committee.replace(Committee.Role.Product, carol);
        vm.expectRevert(Committee.AlreadyVoted.selector);
        vm.prank(carol);
        committee.vote(dealId, false, 10, URI);
    }

    function test_vote_isForSeatedPartnersWithAFullBond() public {
        uint256 dealId = _pitch(500e18);
        vm.expectRevert(Committee.NotAPartner.selector);
        vm.prank(bob);
        committee.vote(dealId, true, 50, URI);

        Committee unbonded = new Committee(token, address(forwarder), admin, _rules(), [bob, carol, alice, admin]);
        vm.prank(admin);
        unbonded.bind(fund, badge);
        vm.prank(founder);
        uint256 other = unbonded.pitch(address(project), 100e18, "Demo Project", URI);
        vm.expectRevert(Committee.BondTooLow.selector);
        vm.prank(bob);
        unbonded.vote(other, true, 50, URI);
    }

    function test_vote_checksTheScoreAndTheDeadline() public {
        uint256 dealId = _pitch(500e18);
        vm.expectRevert(Committee.InvalidScore.selector);
        vm.prank(partners[0]);
        committee.vote(dealId, true, 101, URI);

        vm.warp(block.timestamp + REVIEW_PERIOD + 1);
        vm.expectRevert(Committee.DeadlinePassed.selector);
        _vote(Committee.Role.Product, dealId, true);

        vm.expectRevert(Committee.UnknownDeal.selector);
        _vote(Committee.Role.Product, 99, true);
    }

    // ---------------------------------------------------------------- first views

    function test_opine_recordsAPartnersFirstViewWithoutCountingIt() public {
        uint256 dealId = _pitch(500e18);
        vm.expectEmit(address(committee));
        emit Committee.Opined(dealId, Committee.Role.Technology, partners[1], true, 72, URI);
        vm.prank(partners[1]);
        committee.opine(dealId, true, 72, URI);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(deal.inFavour, 0);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Review));
        assertFalse(committee.getBallots(dealId, 0)[1].cast);
    }

    function test_opine_isForSeatedPartnersWhileThePitchIsUnderReview() public {
        uint256 dealId = _pitch(500e18);
        vm.expectRevert(Committee.NotAPartner.selector);
        vm.prank(bob);
        committee.opine(dealId, true, 50, URI);

        vm.expectRevert(Committee.InvalidScore.selector);
        vm.prank(partners[0]);
        committee.opine(dealId, true, 101, URI);

        vm.expectRevert(Committee.UnknownDeal.selector);
        vm.prank(partners[0]);
        committee.opine(99, true, 50, URI);

        _approve(dealId);
        vm.expectRevert(Committee.WrongStage.selector);
        vm.prank(partners[3]);
        committee.opine(dealId, false, 30, URI);
    }

    // ---------------------------------------------------------------- terms

    function test_offer_setsTheTermsAndDrawsTheMoneyFromTheFund() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);

        vm.expectEmit(address(committee));
        emit Committee.Offered(dealId, 400e18, 4000, 30, URI);
        _offer(dealId, 400e18);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Offered));
        assertEq(deal.amount, 400e18);
        assertEq(deal.firstTrancheBps, 4000);
        assertEq(deal.milestoneDays, 30);
        assertEq(deal.termsUri, URI);
        assertEq(deal.deadline, block.timestamp + ACCEPT_PERIOD);
        assertEq(committee.committed(), 400e18);
        assertEq(fund.totalAssets(), SEED - 400e18);
        _assertHoldings();
    }

    function test_offer_isForTheRiskPartnerOnAnApprovedDeal() public {
        uint256 dealId = _pitch(500e18);
        vm.expectRevert(Committee.WrongStage.selector);
        _offer(dealId, 400e18);

        _approve(dealId);
        vm.expectRevert(Committee.NotTheRiskPartner.selector);
        vm.prank(partners[0]);
        committee.offer(dealId, 400e18, 4000, 30, URI);
    }

    function test_offer_keepsTheTermsWithinBounds() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        address risk = _partner(Committee.Role.Risk);

        vm.startPrank(risk);
        vm.expectRevert(Committee.AmountOutOfRange.selector);
        committee.offer(dealId, 0, 4000, 30, URI);
        vm.expectRevert(Committee.AmountOutOfRange.selector);
        committee.offer(dealId, 500e18 + 1, 4000, 30, URI);
        vm.expectRevert(Committee.TrancheOutOfRange.selector);
        committee.offer(dealId, 400e18, 999, 30, URI);
        vm.expectRevert(Committee.TrancheOutOfRange.selector);
        committee.offer(dealId, 400e18, 9001, 30, URI);
        vm.expectRevert(Committee.MilestoneOutOfRange.selector);
        committee.offer(dealId, 400e18, 4000, 0, URI);
        vm.expectRevert(Committee.MilestoneOutOfRange.selector);
        committee.offer(dealId, 400e18, 4000, 366, URI);
        vm.stopPrank();

        vm.warp(block.timestamp + REVIEW_PERIOD + 1);
        vm.expectRevert(Committee.DeadlinePassed.selector);
        _offer(dealId, 400e18);
    }

    // ---------------------------------------------------------------- accepting and milestones

    function test_accept_paysTheFirstTrancheAndGivesTheBadge() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _offer(dealId, 400e18);

        vm.expectEmit(address(committee));
        emit Committee.Paid(dealId, founder, 1, 160e18);
        vm.prank(founder);
        committee.accept(dealId);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Funded));
        assertEq(deal.paid, 160e18);
        assertEq(deal.milestoneDue, block.timestamp + 30 days);
        assertEq(deal.deadline, deal.milestoneDue);
        assertEq(token.balanceOf(founder), 160e18);
        assertEq(badge.ownerOf(dealId), founder);
        assertEq(committee.committed(), 240e18);
        _assertHoldings();
    }

    function test_accept_isForTheFounderWithinTheTimeToAccept() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _offer(dealId, 400e18);

        vm.expectRevert(Committee.NotTheFounder.selector);
        vm.prank(bob);
        committee.accept(dealId);

        vm.warp(block.timestamp + ACCEPT_PERIOD + 1);
        vm.expectRevert(Committee.DeadlinePassed.selector);
        vm.prank(founder);
        committee.accept(dealId);
    }

    function test_accept_throughTheForwarderPaysTheSigner() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _offer(dealId, 400e18);

        forwarder.execute(_forwardRequest(founderKey, address(committee), abi.encodeCall(Committee.accept, (dealId))));

        assertEq(token.balanceOf(founder), 160e18);
        assertEq(badge.ownerOf(dealId), founder);
    }

    function test_milestone_acceptedPaysTheRestAndClosesTheDeal() public {
        uint256 dealId = _funded();

        vm.expectEmit(address(committee));
        emit Committee.MilestoneSubmitted(dealId, 1, URI);
        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Milestone));
        assertEq(deal.round, 1);
        assertEq(deal.proofUri, URI);

        _vote(Committee.Role.Product, dealId, true);
        _vote(Committee.Role.Risk, dealId, true);
        vm.expectEmit(address(committee));
        emit Committee.Paid(dealId, founder, 2, 240e18);
        _vote(Committee.Role.Technology, dealId, true);

        deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Completed));
        assertEq(deal.paid, 400e18);
        assertEq(token.balanceOf(founder), 400e18);
        assertEq(committee.openDealOf(founder), 0);
        assertEq(committee.committed(), 0);
        _assertHoldings();
    }

    function test_milestone_rejectedGoesBackToTheFounderUntilItIsDue() public {
        uint256 dealId = _funded();
        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
        _vote(Committee.Role.Product, dealId, false);
        _vote(Committee.Role.Tokenomics, dealId, false);

        Committee.Deal memory deal = committee.getDeal(dealId);
        assertEq(uint8(deal.stage), uint8(Committee.Stage.Funded));
        assertEq(deal.deadline, deal.milestoneDue);

        // A second report is a new round, with fresh votes from every seat.
        vm.prank(founder);
        committee.submitMilestone(dealId, "bafkreisecondreport");
        assertEq(committee.getDeal(dealId).round, 2);
        _approve(dealId);
        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Completed));
        assertTrue(committee.getBallots(dealId, 1)[0].cast);
        assertFalse(committee.getBallots(dealId, 1)[0].inFavour);
        assertTrue(committee.getBallots(dealId, 2)[0].inFavour);
    }

    function test_submitMilestone_isForTheFounderBeforeItIsDue() public {
        uint256 dealId = _funded();
        vm.expectRevert(Committee.NotTheFounder.selector);
        vm.prank(bob);
        committee.submitMilestone(dealId, URI);

        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert(Committee.DeadlinePassed.selector);
        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
    }

    // ---------------------------------------------------------------- closing

    function test_close_waitsForTheDeadline() public {
        uint256 dealId = _pitch(100e18);
        vm.expectRevert(Committee.DeadlineNotPassed.selector);
        committee.close(dealId);
    }

    function test_close_returnsAnUnacceptedOfferToTheFund() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _offer(dealId, 400e18);

        vm.warp(block.timestamp + ACCEPT_PERIOD + 1);
        vm.expectEmit(address(committee));
        emit Committee.Returned(dealId, 400e18);
        committee.close(dealId);

        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Expired));
        assertEq(fund.totalAssets(), SEED);
        assertEq(committee.committed(), 0);
        assertEq(committee.openDealOf(founder), 0);
        _assertHoldings();

        // A decided contract does not come back after its deal ran out.
        vm.expectRevert(Committee.ProjectTaken.selector);
        _pitch(100e18);
    }

    function test_close_returnsTheSecondTrancheOnceTheMilestoneIsOverdue() public {
        uint256 dealId = _funded();
        vm.warp(block.timestamp + 30 days + 1);
        committee.close(dealId);

        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Expired));
        assertEq(fund.totalAssets(), SEED - 160e18);
        assertEq(token.balanceOf(founder), 160e18);
        _assertHoldings();

        vm.expectRevert(Committee.WrongStage.selector);
        committee.close(dealId);
    }

    // ---------------------------------------------------------------- vetoes

    function test_veto_isOnlyForTheFund() public {
        uint256 dealId = _funded();
        vm.expectRevert(Committee.NotTheFund.selector);
        committee.veto(dealId);
    }

    function test_veto_returnsWhatWasNotPaidAndSlashesTheApprovers() public {
        uint256 dealId = _pitch(500e18);
        _vote(Committee.Role.Product, dealId, true);
        _vote(Committee.Role.Risk, dealId, false);
        _vote(Committee.Role.Technology, dealId, true);
        _vote(Committee.Role.Tokenomics, dealId, true);
        _offer(dealId, 400e18);
        vm.prank(founder);
        committee.accept(dealId);

        uint256 slashed = MIN_BOND * SLASH_BPS / 10_000;
        vm.expectEmit(address(committee));
        emit Committee.Returned(dealId, 240e18);
        vm.expectEmit(address(committee));
        emit Committee.Slashed(dealId, partners[0], slashed);
        vm.prank(address(fund));
        committee.veto(dealId);

        assertEq(uint8(_stage(dealId)), uint8(Committee.Stage.Vetoed));
        assertEq(committee.getPartner(partners[0]).bond, MIN_BOND - slashed);
        assertEq(committee.getPartner(partners[1]).bond, MIN_BOND - slashed);
        assertEq(committee.getPartner(partners[2]).bond, MIN_BOND - slashed);
        assertEq(committee.getPartner(partners[3]).bond, MIN_BOND);
        assertEq(fund.totalAssets(), SEED - 160e18 + 3 * slashed);
        assertEq(committee.openDealOf(founder), 0);
        _assertHoldings();

        // Below the minimum bond a partner's vote no longer counts until it is topped up.
        vm.prank(founder);
        uint256 next = committee.pitch(address(new Project()), 100e18, "Next", URI);
        vm.expectRevert(Committee.BondTooLow.selector);
        _vote(Committee.Role.Product, next, true);
        _bond(partners[0], slashed);
        _vote(Committee.Role.Product, next, true);
    }

    function test_veto_beforeTheTermsSlashesWithoutMovingMoney() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        vm.prank(address(fund));
        committee.veto(dealId);

        assertEq(fund.totalAssets(), SEED + 3 * (MIN_BOND * SLASH_BPS / 10_000));
        assertEq(committee.committed(), 0);
        _assertHoldings();
    }

    function test_veto_slashesAnApprovingVoteCastAfterTheDecision() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        _vote(Committee.Role.Risk, dealId, true);
        vm.prank(address(fund));
        committee.veto(dealId);

        uint256 slashed = MIN_BOND * SLASH_BPS / 10_000;
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(committee.getPartner(partners[i]).bond, MIN_BOND - slashed);
        }
    }

    function test_veto_cannotStopAFinishedDeal() public {
        uint256 dealId = _funded();
        vm.prank(founder);
        committee.submitMilestone(dealId, URI);
        _approve(dealId);

        (bool vetoable,) = committee.vetoSnapshot(dealId);
        assertFalse(vetoable);
        vm.expectRevert(Committee.WrongStage.selector);
        vm.prank(address(fund));
        committee.veto(dealId);
    }
}
