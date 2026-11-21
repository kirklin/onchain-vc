// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "./interfaces/IPermit2.sol";

/// @title Vault
/// @notice An ERC-4626 vault. Depositors receive shares, and each share is a claim on an
///         equal slice of whatever the vault holds.
/// @dev Shows the three ways a contract can be allowed to pull a user's tokens:
///      - `deposit` after an `approve` transaction,
///      - `depositWithPermit` with an ERC-2612 signature, for tokens that support it,
///      - `depositWithPermit2` with a Permit2 signature, for any token approved to Permit2.
contract Vault is ERC4626 {
    IPermit2 public immutable PERMIT2;

    constructor(IERC20 asset_, string memory name, string memory symbol, IPermit2 permit2)
        ERC20(name, symbol)
        ERC4626(asset_)
    {
        PERMIT2 = permit2;
    }

    function depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 shares)
    {
        // Anyone can submit a signed permit first. If that happened the allowance is already
        // in place, so a failing permit must not fail the deposit.
        try IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return deposit(assets, receiver);
    }

    function depositWithPermit2(
        uint256 assets,
        address receiver,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 shares) {
        uint256 maxAssets = maxDeposit(receiver);
        if (assets > maxAssets) revert ERC4626ExceededMaxDeposit(receiver, assets, maxAssets);

        // Priced before the tokens arrive, and shares minted only after they have, the order
        // ERC4626 itself uses: a token that calls back mid-transfer finds nothing to redeem yet.
        shares = previewDeposit(assets);
        PERMIT2.permitTransferFrom(
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({token: asset(), amount: assets}), nonce: nonce, deadline: deadline
            }),
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: assets}),
            msg.sender,
            signature
        );
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }
}
