// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Reception} from "../src/Reception.sol";
import {FundSetup} from "./FundSetup.t.sol";

contract ReceptionTest is FundSetup {
    uint256 internal constant SHARES = 1000e18;
    uint256 internal constant GAS_MONEY = 0.1 ether;

    Reception internal reception;

    function setUp() public override {
        super.setUp();
        reception = new Reception(fund, admin);
        vm.prank(admin);
        token.mint(address(reception), 1_000_000e18);
        vm.deal(admin, 10 ether);
    }

    function _visitors() private view returns (address[] memory visitors) {
        visitors = new address[](3);
        visitors[0] = alice;
        visitors[1] = bob;
        visitors[2] = carol;
    }

    function test_admit_givesEveryVisitorTheSameSharesAndGasMoney() public {
        uint256 before = admin.balance;
        vm.prank(admin);
        reception.admit{value: 1 ether}(_visitors(), SHARES, GAS_MONEY);

        assertEq(fund.balanceOf(alice), SHARES);
        assertEq(fund.balanceOf(bob), SHARES);
        assertEq(fund.balanceOf(carol), SHARES);
        assertEq(fund.getVotes(alice), SHARES);
        assertEq(alice.balance, GAS_MONEY);
        assertEq(carol.balance, GAS_MONEY);
        // What the visitors did not need went back to the host.
        assertEq(admin.balance, before - 3 * GAS_MONEY);
        assertEq(address(reception).balance, 0);
    }

    function test_admit_takesAVisitorInOnlyOnce() public {
        vm.startPrank(admin);
        reception.admit{value: 1 ether}(_visitors(), SHARES, GAS_MONEY);
        reception.admit{value: 1 ether}(_visitors(), SHARES, GAS_MONEY);
        vm.stopPrank();

        assertEq(fund.balanceOf(alice), SHARES);
        assertEq(alice.balance, GAS_MONEY);
    }

    function test_admit_isForTheHost() public {
        vm.expectRevert(Reception.NotTheHost.selector);
        vm.prank(alice);
        reception.admit(_visitors(), SHARES, 0);
    }
}
