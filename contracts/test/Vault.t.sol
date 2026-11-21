// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {Token} from "../src/Token.sol";
import {Vault} from "../src/Vault.sol";
import {BaseTest} from "./Base.t.sol";

contract VaultTest is BaseTest {
    Token private token;
    Vault private vault;

    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant PERMIT2_TRANSFER_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    function setUp() public {
        _installPermit2();
        token = new Token("Test USD", "tUSD", admin);
        vault = new Vault(token, "Test Vault", "vUSD", PERMIT2);

        vm.prank(admin);
        token.mint(alice, 1000e18);
    }

    function test_deposit_needsAnAllowanceFirst() public {
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 100e18)
        );
        vault.deposit(100e18, alice);

        token.approve(address(vault), 100e18);
        uint256 shares = vault.deposit(100e18, alice);
        vm.stopPrank();

        assertEq(shares, 100e18);
        assertEq(vault.balanceOf(alice), 100e18);
        assertEq(vault.totalAssets(), 100e18);
        assertEq(token.allowance(alice, address(vault)), 0);
    }

    function test_redeem_returnsAssetsIncludingYield() public {
        vm.startPrank(alice);
        token.approve(address(vault), 100e18);
        vault.deposit(100e18, alice);
        vm.stopPrank();

        // Anything sent to the vault belongs to the share holders.
        vm.prank(admin);
        token.mint(address(vault), 50e18);

        vm.prank(alice);
        uint256 assets = vault.redeem(100e18, alice, alice);

        assertApproxEqAbs(assets, 150e18, 1);
        assertApproxEqAbs(token.balanceOf(alice), 1050e18, 1);
    }

    function _permitSignature(uint256 amount, uint256 deadline) private view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                alice,
                address(vault),
                amount,
                token.nonces(alice),
                deadline
            )
        );
        return vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_depositWithPermit_needsNoApproveTransaction() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSignature(100e18, deadline);

        vm.prank(alice);
        vault.depositWithPermit(100e18, alice, deadline, v, r, s);

        assertEq(vault.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(alice), 900e18);
    }

    function test_depositWithPermit_survivesThePermitBeingSubmittedFirst() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSignature(100e18, deadline);

        // Someone watching the mempool submits the same permit ahead of the deposit.
        vm.prank(carol);
        token.permit(alice, address(vault), 100e18, deadline, v, r, s);

        vm.prank(alice);
        vault.depositWithPermit(100e18, alice, deadline, v, r, s);
        assertEq(vault.balanceOf(alice), 100e18);
    }

    function test_depositWithPermit_rejectsSignatureForAnotherAmount() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSignature(50e18, deadline);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 100e18)
        );
        vm.prank(alice);
        vault.depositWithPermit(100e18, alice, deadline, v, r, s);
    }

    function _permit2Signature(uint256 amount, uint256 nonce, uint256 deadline) private view returns (bytes memory) {
        bytes32 permissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(token), amount));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT2_TRANSFER_TYPEHASH, permissions, address(vault), nonce, deadline));
        return _signature(aliceKey, keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_depositWithPermit2_pullsThroughPermit2() public {
        // One approval to Permit2 serves every app that uses it from then on.
        vm.prank(alice);
        token.approve(address(PERMIT2), type(uint256).max);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _permit2Signature(100e18, 0, deadline);

        vm.prank(alice);
        vault.depositWithPermit2(100e18, alice, 0, deadline, signature);

        assertEq(vault.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(address(vault)), 100e18);
    }

    function test_depositWithPermit2_rejectsReusedNonce() public {
        vm.prank(alice);
        token.approve(address(PERMIT2), type(uint256).max);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _permit2Signature(100e18, 7, deadline);

        vm.startPrank(alice);
        vault.depositWithPermit2(100e18, alice, 7, deadline, signature);
        vm.expectRevert();
        vault.depositWithPermit2(100e18, alice, 7, deadline, signature);
        vm.stopPrank();
    }

    function test_depositWithPermit2_rejectsSignatureMadeForAnotherSpender() public {
        Vault other = new Vault(token, "Other Vault", "vOTHER", PERMIT2);
        vm.prank(alice);
        token.approve(address(PERMIT2), type(uint256).max);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _permit2Signature(100e18, 0, deadline);

        vm.expectRevert();
        vm.prank(alice);
        other.depositWithPermit2(100e18, alice, 0, deadline, signature);
    }

    function testFuzz_depositThenRedeem_neverReturnsMoreThanDeposited(uint96 amount) public {
        uint256 assets = bound(amount, 1, 1000e18);
        vm.startPrank(alice);
        token.approve(address(vault), assets);
        uint256 shares = vault.deposit(assets, alice);
        uint256 returned = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertLe(returned, assets);
        assertApproxEqAbs(returned, assets, 1);
    }
}
