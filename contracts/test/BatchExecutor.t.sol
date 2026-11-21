// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {BatchExecutor} from "../src/BatchExecutor.sol";
import {Token} from "../src/Token.sol";
import {Vault} from "../src/Vault.sol";
import {BaseTest} from "./Base.t.sol";

contract RejectsPayment {
    receive() external payable {
        revert();
    }
}

/// @dev Tokens whose mints call the receiver's hook, as a wallet's NFTs arrive.
contract SafeMinted721 is ERC721("Safe", "SAFE") {
    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

contract SafeMinted1155 is ERC1155("") {
    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

contract BatchExecutorTest is BaseTest {
    BatchExecutor private executor;
    Token private token;
    Vault private vault;

    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant PERMIT2_TRANSFER_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    function setUp() public {
        _installPermit2();
        executor = new BatchExecutor();
        token = new Token("Test USD", "tUSD", admin);
        vault = new Vault(token, "Test Vault", "vUSD", PERMIT2);

        vm.prank(admin);
        token.mint(alice, 1000e18);
        vm.deal(alice, 10 ether);

        // The authorisation rides on the next transaction, whatever that transaction does.
        // From then on alice's account runs the executor's code.
        vm.signAndAttachDelegation(address(executor), aliceKey);
        vm.prank(alice);
        token.approve(alice, 0);
        assertEq(alice.code, abi.encodePacked(hex"ef0100", address(executor)));
    }

    function _approveAndDeposit(uint256 approved, uint256 deposited)
        private
        view
        returns (BatchExecutor.Call[] memory calls)
    {
        calls = new BatchExecutor.Call[](2);
        calls[0] = BatchExecutor.Call(address(token), 0, abi.encodeCall(token.approve, (address(vault), approved)));
        calls[1] = BatchExecutor.Call(address(vault), 0, abi.encodeCall(vault.deposit, (deposited, alice)));
    }

    function test_execute_makesEveryCallAsTheAccount() public {
        vm.prank(alice);
        BatchExecutor(payable(alice)).execute(_approveAndDeposit(100e18, 100e18));

        assertEq(vault.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(alice), 900e18);
    }

    function test_execute_undoesEverythingWhenOneCallFails() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 50e18, 100e18)
        );
        vm.prank(alice);
        BatchExecutor(payable(alice)).execute(_approveAndDeposit(50e18, 100e18));

        assertEq(token.allowance(alice, address(vault)), 0);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_execute_namesTheCallThatFailedWithoutAReason() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);
        calls[0] = BatchExecutor.Call(bob, 1 ether, "");
        calls[1] = BatchExecutor.Call(address(new RejectsPayment()), 1 ether, "");

        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.CallFailed.selector, 1));
        vm.prank(alice);
        BatchExecutor(payable(alice)).execute(calls);

        assertEq(bob.balance, 0);
    }

    function test_execute_sendsNativeTokens() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);
        calls[0] = BatchExecutor.Call(bob, 1 ether, "");
        calls[1] = BatchExecutor.Call(carol, 2 ether, "");

        vm.prank(alice);
        BatchExecutor(payable(alice)).execute(calls);

        assertEq(bob.balance, 1 ether);
        assertEq(carol.balance, 2 ether);
        assertEq(alice.balance, 7 ether);
    }

    function test_execute_isOnlyForTheAccountItself() public {
        vm.expectRevert(BatchExecutor.Unauthorized.selector);
        vm.prank(bob);
        BatchExecutor(payable(alice)).execute(_approveAndDeposit(100e18, 100e18));
    }

    function test_account_stillReceivesNativeTokensAndSafeTransfers() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool sent,) = alice.call{value: 1 ether}("");
        assertTrue(sent);

        SafeMinted721 nft = new SafeMinted721();
        nft.safeMint(alice, 1);
        assertEq(nft.ownerOf(1), alice);

        SafeMinted1155 items = new SafeMinted1155();
        items.mint(alice, 1, 5);
        assertEq(items.balanceOf(alice, 1), 5);
    }

    function test_isValidSignature_acceptsOnlyTheAccountsOwnKey() public view {
        bytes32 digest = keccak256("message");

        assertEq(
            BatchExecutor(payable(alice)).isValidSignature(digest, _signature(aliceKey, digest)),
            IERC1271.isValidSignature.selector
        );
        assertEq(BatchExecutor(payable(alice)).isValidSignature(digest, _signature(bobKey, digest)), bytes4(0xffffffff));
        assertEq(BatchExecutor(payable(alice)).isValidSignature(digest, hex"1234"), bytes4(0xffffffff));
    }

    function test_account_signaturesKeepWorkingWithPermit2() public {
        vm.prank(alice);
        token.approve(address(PERMIT2), type(uint256).max);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 permissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(token), 100e18));
        bytes32 structHash = keccak256(abi.encode(PERMIT2_TRANSFER_TYPEHASH, permissions, address(vault), 0, deadline));
        bytes memory signature =
            _signature(aliceKey, keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), structHash)));

        // Permit2 sees code at alice's address and asks the account itself, through ERC-1271.
        vm.prank(alice);
        vault.depositWithPermit2(100e18, alice, 0, deadline, signature);

        assertEq(vault.balanceOf(alice), 100e18);
    }
}
