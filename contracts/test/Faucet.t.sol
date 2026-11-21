// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {Faucet} from "../src/Faucet.sol";

contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }
}

contract GasBurningRecipient {
    uint256 private sink;

    receive() external payable {
        while (true) ++sink;
    }
}

contract RefundRejectingCaller {
    function drip(Faucet faucet, address[] calldata recipients, uint256 target) external payable {
        faucet.drip{value: msg.value}(recipients, target);
    }
}

contract FaucetTest is Test {
    Faucet private faucet;

    address private operator = makeAddr("operator");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    event Dripped(address indexed to, uint256 amount);

    function setUp() public {
        faucet = new Faucet();
        vm.deal(operator, 100 ether);
    }

    function _recipients(address a, address b) private pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }

    function test_drip_raisesBalancesToTarget() public {
        vm.deal(bob, 0.3 ether);

        vm.expectEmit();
        emit Dripped(alice, 1 ether);
        vm.expectEmit();
        emit Dripped(bob, 0.7 ether);
        vm.prank(operator);
        faucet.drip{value: 2 ether}(_recipients(alice, bob), 1 ether);

        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 1 ether);
    }

    function test_drip_refundsUnspentValue() public {
        vm.deal(bob, 0.3 ether);

        vm.prank(operator);
        faucet.drip{value: 2 ether}(_recipients(alice, bob), 1 ether);

        assertEq(operator.balance, 100 ether - 1.7 ether);
        assertEq(address(faucet).balance, 0);
    }

    function test_drip_skipsRecipientsAtOrAboveTarget() public {
        vm.deal(alice, 1 ether);
        vm.deal(bob, 5 ether);

        vm.recordLogs();
        vm.prank(operator);
        faucet.drip{value: 2 ether}(_recipients(alice, bob), 1 ether);

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 5 ether);
        assertEq(operator.balance, 100 ether);
    }

    function test_drip_isIdempotent() public {
        vm.startPrank(operator);
        faucet.drip{value: 2 ether}(_recipients(alice, bob), 1 ether);
        faucet.drip{value: 2 ether}(_recipients(alice, bob), 1 ether);
        vm.stopPrank();

        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 1 ether);
        assertEq(operator.balance, 98 ether);
    }

    function test_drip_skipsRecipientThatRejectsTransfer() public {
        address rejecting = address(new RejectingRecipient());

        vm.prank(operator);
        faucet.drip{value: 2 ether}(_recipients(rejecting, alice), 1 ether);

        assertEq(rejecting.balance, 0);
        assertEq(alice.balance, 1 ether);
        assertEq(operator.balance, 99 ether);
    }

    function test_drip_skipsRecipientThatBurnsItsGasStipend() public {
        address burning = address(new GasBurningRecipient());

        vm.prank(operator);
        faucet.drip{value: 2 ether, gas: 200_000}(_recipients(burning, alice), 1 ether);

        assertEq(burning.balance, 0);
        assertEq(alice.balance, 1 ether);
    }

    function test_drip_skipsRecipientsOnceValueRunsOut() public {
        vm.prank(operator);
        faucet.drip{value: 1.5 ether}(_recipients(alice, bob), 1 ether);

        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 0);
        assertEq(operator.balance, 99 ether);
    }

    function test_drip_revertsWhenCallerRejectsRefund() public {
        RefundRejectingCaller caller = new RefundRejectingCaller();
        vm.deal(address(this), 2 ether);

        vm.expectRevert(Faucet.RefundFailed.selector);
        caller.drip{value: 2 ether}(faucet, _recipients(alice, alice), 1 ether);
    }

    function testFuzz_drip_neverKeepsFunds(uint96 target, uint96 value, uint96 aliceBalance) public {
        vm.deal(operator, value);
        vm.deal(alice, aliceBalance);

        vm.prank(operator);
        faucet.drip{value: value}(_recipients(alice, bob), target);

        assertEq(address(faucet).balance, 0);
        assertEq(uint256(alice.balance) + bob.balance + operator.balance, uint256(value) + aliceBalance);
    }
}
