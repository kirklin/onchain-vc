// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Token} from "../src/Token.sol";
import {BaseTest} from "./Base.t.sol";

contract TokenTest is BaseTest {
    Token private token;

    event Claimed(address indexed account, uint256 amount);

    function setUp() public {
        vm.warp(1_000_000);
        token = new Token("Test USD", "tUSD", admin);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Test USD");
        assertEq(token.symbol(), "tUSD");
        assertEq(token.decimals(), 18);
        assertEq(token.owner(), admin);
    }

    function test_claim_mintsFixedAmountOncePerInterval() public {
        vm.expectEmit();
        emit Claimed(alice, 100e18);
        vm.startPrank(alice);
        token.claim();

        vm.warp(1_000_000 + 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(Token.ClaimTooSoon.selector, 1_000_000 + 1 days));
        token.claim();

        vm.warp(1_000_000 + 1 days);
        token.claim();
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 200e18);
    }

    function test_mint_isOwnerOnly() public {
        vm.prank(admin);
        token.mint(bob, 5e18);
        assertEq(token.balanceOf(bob), 5e18);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);
    }

    function test_permit_setsAllowanceFromSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                alice,
                bob,
                25e18,
                token.nonces(alice),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);

        token.permit(alice, bob, 25e18, deadline, v, r, s);

        assertEq(token.allowance(alice, bob), 25e18);
        assertEq(token.nonces(alice), 1);
    }
}
