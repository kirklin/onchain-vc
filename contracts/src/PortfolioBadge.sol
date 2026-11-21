// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Committee} from "./Committee.sol";

/// @title PortfolioBadge
/// @notice A non-transferable ERC-721 (ERC-5192) the committee gives a founder when they accept
///         its terms. The token id is the deal's id, and the card it shows is drawn on chain from
///         the deal itself.
contract PortfolioBadge is ERC721 {
    using Strings for uint256;

    Committee public immutable committee;

    /// @dev ERC-5192.
    event Locked(uint256 tokenId);

    error NotTheCommittee();
    error Soulbound();

    constructor(Committee committee_) ERC721("Onchain VC Portfolio", "OVCP") {
        committee = committee_;
    }

    function mint(address founder, uint256 dealId) external {
        if (msg.sender != address(committee)) revert NotTheCommittee();
        emit Locked(dealId);
        // A founder's account may be a contract that never registered as an ERC-721 receiver,
        // and the badge must not stand between it and the money it accepted.
        // forge-lint: disable-next-line(unsafe-oz-erc721-mint)
        _mint(founder, dealId);
    }

    /// @dev ERC-5192.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @notice A data URI holding the token's JSON metadata, with the card embedded as SVG.
    /// @dev The deal's name is safe to place in both: the committee only accepts names without
    ///      control characters, quotes, backslashes, angle brackets or ampersands.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Committee.Deal memory deal = committee.getDeal(tokenId);
        string memory id = tokenId.toString();
        string memory amount = _amount(deal.amount);

        string memory json = string.concat(
            '{"name":"',
            deal.name,
            '","description":"Deal #',
            id,
            " of the Onchain VC committee: ",
            amount,
            ' invested.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_card(id, deal.name, amount))),
            '","attributes":[{"trait_type":"Deal","value":',
            id,
            '},{"trait_type":"Project","value":"',
            Strings.toHexString(deal.project),
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        // 0xb45a3c0e is the ERC-5192 interface id.
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId);
    }

    /// @dev Minting is the only movement allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) revert Soulbound();
    }

    /// @dev The amount in whole units of the asset with up to two decimals, and its symbol.
    function _amount(uint128 value) private view returns (string memory) {
        IERC20Metadata asset = IERC20Metadata(address(committee.asset()));
        uint256 cents = uint256(value) * 100 / 10 ** asset.decimals();
        string memory text = (cents / 100).toString();
        uint256 fraction = cents % 100;
        if (fraction != 0) {
            text = string.concat(
                text, fraction < 10 ? ".0" : ".", (fraction % 10 == 0 ? fraction / 10 : fraction).toString()
            );
        }
        return string.concat(text, " ", asset.symbol());
    }

    function _card(string memory id, string memory name, string memory amount) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">',
            '<rect width="480" height="480" rx="32" fill="#141414"/>',
            '<text x="40" y="72" fill="#8a8a8a" font-family="system-ui,sans-serif" font-size="18" letter-spacing="2">ONCHAIN VC PORTFOLIO</text>',
            '<text x="40" y="250" fill="#ffffff" font-family="system-ui,sans-serif" font-size="30" font-weight="600">',
            name,
            '</text><text x="40" y="294" fill="#b5b5b5" font-family="system-ui,sans-serif" font-size="20">',
            amount,
            '</text><text x="40" y="432" fill="#6b6b6b" font-family="ui-monospace,monospace" font-size="18">#',
            id,
            "</text></svg>"
        );
    }
}
