import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { fetchNftMetadata, parseNftMetadata, resolveUri, withTokenId } from "~/chain/metadata";

const CID = "bafkreibrnkckjiiszmfjxdvmwzjx6reahiahkrfyfep3qwwy6ygkzppdf4";

describe("resolveUri", () => {
  it("routes ipfs addresses through this site, keeping any path", () => {
    expect(resolveUri(`ipfs://${CID}`)).toBe(`/api/ipfs/${CID}`);
    expect(resolveUri(`ipfs://${CID}/images/1.png`)).toBe(`/api/ipfs/${CID}/images/1.png`);
    expect(resolveUri(`ipfs://ipfs/${CID}/1.json`)).toBe(`/api/ipfs/${CID}/1.json`);
  });

  it("sends arweave addresses to its gateway", () => {
    expect(resolveUri("ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U")).toBe("https://arweave.net/bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U");
    expect(resolveUri("ar://abc/1.png")).toBe("https://arweave.net/abc/1.png");
  });

  it("keeps https addresses and data uris of json or images", () => {
    expect(resolveUri("https://example.com/1.json")).toBe("https://example.com/1.json");
    expect(resolveUri("data:application/json;base64,e30=")).toBe("data:application/json;base64,e30=");
    expect(resolveUri("data:image/svg+xml;base64,PHN2Zy8+")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  });

  it("refuses anything a page should not load", () => {
    expect(resolveUri("http://example.com/1.json")).toBeUndefined();
    expect(resolveUri("javascript:alert(1)")).toBeUndefined();
    expect(resolveUri("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(resolveUri("file:///etc/passwd")).toBeUndefined();
    expect(resolveUri("")).toBeUndefined();
  });
});

describe("withTokenId", () => {
  it("fills in the id as 64 lowercase hex digits", () => {
    expect(withTokenId("https://example.com/{id}.json", 314_592n)).toBe(`https://example.com/${"0".repeat(59)}4cce0.json`);
    expect(withTokenId("https://example.com/static.json", 1n)).toBe("https://example.com/static.json");
  });
});

describe("parseNftMetadata", () => {
  it("reads the standard fields and resolves the image", () => {
    expect(parseNftMetadata({
      name: "Work #1",
      description: "A first work.",
      image: `ipfs://${CID}`,
      attributes: [{ trait_type: "Colour", value: "Blue" }, { value: 7 }],
      external_url: "https://example.com",
    })).toEqual({
      name: "Work #1",
      description: "A first work.",
      image: `/api/ipfs/${CID}`,
      attributes: [{ trait: "Colour", value: "Blue" }, { trait: undefined, value: 7 }],
    });
  });

  it("accepts the older image fields", () => {
    expect(parseNftMetadata({ image_url: "https://example.com/1.png" }).image).toBe("https://example.com/1.png");
    expect(parseNftMetadata({ image_data: "<svg xmlns='http://www.w3.org/2000/svg'/>" }).image)
      .toBe("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%2F%3E");
  });

  it("drops an image that cannot be loaded safely, and tolerates empty metadata", () => {
    expect(parseNftMetadata({ name: "X", image: "javascript:alert(1)" })).toEqual({ name: "X", description: undefined, image: undefined, attributes: [] });
    expect(parseNftMetadata({})).toEqual({ name: undefined, description: undefined, image: undefined, attributes: [] });
  });

  it("rejects metadata of the wrong shape", () => {
    expect(() => parseNftMetadata("not an object")).toThrow();
    expect(() => parseNftMetadata({ name: 42 })).toThrow();
  });
});

describe("fetchNftMetadata", () => {
  it("reads metadata a contract keeps on chain as a data uri", async () => {
    const json = JSON.stringify({ name: "On chain", image: "data:image/svg+xml;base64,PHN2Zy8+" });
    const metadata = await fetchNftMetadata(`data:application/json;base64,${Buffer.from(json).toString("base64")}`);

    expect(metadata).toMatchObject({ name: "On chain", image: "data:image/svg+xml;base64,PHN2Zy8+" });
  });

  it("refuses an address it will not load", async () => {
    await expect(fetchNftMetadata("http://example.com/1.json")).rejects.toThrow("Cannot load metadata");
  });
});
