// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Committee} from "../src/Committee.sol";
import {PortfolioBadge} from "../src/PortfolioBadge.sol";
import {FundSetup} from "./FundSetup.t.sol";

contract PortfolioBadgeTest is FundSetup {
    function test_mint_isOnlyForTheCommittee() public {
        vm.expectRevert(PortfolioBadge.NotTheCommittee.selector);
        badge.mint(founder, 1);
    }

    function test_badge_staysWithTheFounder() public {
        uint256 dealId = _funded();
        assertTrue(badge.locked(dealId));
        assertTrue(badge.supportsInterface(0xb45a3c0e));
        assertTrue(badge.supportsInterface(0x80ac58cd));

        vm.expectRevert(PortfolioBadge.Soulbound.selector);
        vm.prank(founder);
        badge.transferFrom(founder, bob, dealId);
    }

    function test_tokenURI_describesTheDealOnChain() public {
        uint256 dealId = _funded();
        string memory uri = badge.tokenURI(dealId);
        string memory prefix = "data:application/json;base64,";
        assertEq(_slice(uri, 0, bytes(prefix).length), prefix);

        string memory json = string(Base64.decode(_slice(uri, bytes(prefix).length, bytes(uri).length)));
        assertEq(vm.parseJsonString(json, ".name"), "Demo Project");
        assertEq(vm.parseJsonString(json, ".description"), "Deal #1 of the Onchain VC committee: 400 tUSD invested.");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), dealId);
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), Strings.toHexString(address(project)));

        string memory image = vm.parseJsonString(json, ".image");
        string memory svgPrefix = "data:image/svg+xml;base64,";
        string memory svg = string(Base64.decode(_slice(image, bytes(svgPrefix).length, bytes(image).length)));
        assertTrue(vm.contains(svg, ">Demo Project</text>"));
        assertTrue(vm.contains(svg, ">400 tUSD</text>"));
        assertTrue(vm.contains(svg, ">#1</text>"));
    }

    function test_tokenURI_writesFractionsWithUpToTwoDecimals() public {
        uint256 dealId = _pitch(500e18);
        _approve(dealId);
        vm.prank(_partner(Committee.Role.Risk));
        committee.offer(dealId, 250.5e18, 4000, 30, URI);
        vm.prank(founder);
        committee.accept(dealId);

        string memory json = _json(dealId);
        assertTrue(vm.contains(json, "250.5 tUSD invested"));
    }

    function test_tokenURI_refusesTokensNotMinted() public {
        vm.expectRevert();
        badge.tokenURI(1);
    }

    function _json(uint256 tokenId) private view returns (string memory) {
        string memory uri = badge.tokenURI(tokenId);
        return string(Base64.decode(_slice(uri, 29, bytes(uri).length)));
    }

    function _slice(string memory text, uint256 start, uint256 end) private pure returns (string memory) {
        bytes memory raw = bytes(text);
        bytes memory part = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            part[i - start] = raw[i];
        }
        return string(part);
    }
}
