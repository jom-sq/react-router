import { createRequestHandler } from "../../lib/server-runtime/server";
import { mockServerBuild } from "./utils";

function fixture() {
  let build = mockServerBuild({
    root: { path: "", default: true },
    item: { parentId: "root", path: "items/:id", default: true },
    index: { parentId: "item", index: true, default: true },
    detail: { parentId: "item", path: "details", default: true },
    featured: { parentId: "root", path: "items/featured", default: true },
  });
  build.assets.version = "test-version";
  let item = build.routes.item;
  let reads = jest.fn(() => item);
  Object.defineProperty(build.routes, "item", { enumerable: true, get: reads });
  let handler = createRequestHandler(build, "test");
  let manifest = (path: string, version = build.assets.version) => {
    let url = new URL("http://example.com/__manifest");
    url.searchParams.set("version", version);
    url.searchParams.set("paths", path);
    return handler(new Request(url));
  };
  return { build, reads, handler, manifest };
}

describe("manifest route ID cache", () => {
  it("reuses matching while reading current assets", async () => {
    let { build, reads, manifest } = fixture();
    let first = await manifest("/items/a");
    expect(Object.keys(await first.json())).toEqual(["root", "item", "index"]);
    reads.mockClear();
    build.assets.routes.item!.module = "/assets/updated.js";
    let second = await manifest("/items/a");
    expect((await second.json()).item.module).toBe("/assets/updated.js");
    expect(reads).not.toHaveBeenCalled();
  });

  it("evicts the least recently used pathname after 256 entries", async () => {
    let { reads, manifest } = fixture();
    for (let i = 0; i < 256; i++) await manifest(`/items/${i}`);
    reads.mockClear();
    await manifest("/items/0");
    expect(reads).not.toHaveBeenCalled();
    await manifest("/items/256");
    reads.mockClear();
    await manifest("/items/0");
    expect(reads).not.toHaveBeenCalled();
    await manifest("/items/1");
    expect(reads).toHaveBeenCalled();
  });

  it.each([
    [1024, 0],
    [1025, 1],
  ])("bounds cache key length at %s", async (length, expectedReads) => {
    let { reads, manifest } = fixture();
    let path = "/items/" + "x".repeat(length - 7);
    let first = await (await manifest(path)).json();
    reads.mockClear();
    expect(await (await manifest(path)).json()).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(expectedReads);
  });

  it.each([
    ["/", ["root"]],
    ["/items/a", ["root", "item", "index"]],
    ["/items/a/details", ["root", "item", "detail"]],
    ["/items/featured", ["root", "featured"]],
    ["/items/a%2Fb", ["root", "item", "index"]],
    ["/missing", []],
  ])("preserves cold and warm responses for %s", async (path, ids) => {
    let { manifest } = fixture();
    let cold = await manifest(path as string);
    let body = await cold.text();
    expect(Object.keys(JSON.parse(body))).toEqual(ids);
    let warm = await manifest(path as string);
    expect(warm.status).toBe(cold.status);
    expect([...warm.headers]).toEqual([...cold.headers]);
    expect(await warm.text()).toBe(body);
  });

  it("preserves order, normalizes relative paths and omits missing assets", async () => {
    let { build, reads, manifest } = fixture();
    await manifest("/items/a");
    reads.mockClear();
    delete build.assets.routes.index;
    let response = await manifest("items/a,/items/a,/items/featured");
    expect(Object.keys(await response.json())).toEqual([
      "root",
      "item",
      "featured",
    ]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("keeps version and URL length guards ahead of cache access", async () => {
    let { reads, manifest } = fixture();
    await manifest("/items/a");
    reads.mockClear();
    let mismatch = await manifest("/items/cold", "other-version");
    expect(mismatch.status).toBe(204);
    expect(mismatch.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect((await manifest("/items/" + "x".repeat(8000))).status).toBe(400);
    expect(reads).not.toHaveBeenCalled();
    await manifest("/items/cold");
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("does not share entries across handlers or replacement builds", async () => {
    let first = fixture();
    await first.manifest("/items/a");
    let second = fixture();
    second.build.routes.item!.path = "different/:id";
    let secondHandler = createRequestHandler(second.build, "test");
    let request = new Request(
      "http://example.com/__manifest?version=test-version&paths=/items/a",
    );
    expect(await (await secondHandler(request.clone())).json()).toEqual({});
    let current = first.build;
    let dynamic = createRequestHandler(() => current, "test");
    expect(Object.keys(await (await dynamic(request.clone())).json())).toEqual([
      "root",
      "item",
      "index",
    ]);
    current = second.build;
    expect(await (await dynamic(request.clone())).json()).toEqual({});
  });

  it("respects a distinct basename", async () => {
    let original = fixture();
    await original.manifest("/items/a");
    let other = fixture();
    other.build.basename = "/app";
    let handler = createRequestHandler(other.build, "test");
    let response = await handler(
      new Request(
        "http://example.com/app/__manifest?version=test-version&paths=/app/items/a",
      ),
    );
    expect(Object.keys(await response.json())).toEqual([
      "root",
      "item",
      "index",
    ]);
    response = await handler(
      new Request(
        "http://example.com/app/__manifest?version=test-version&paths=/items/a",
      ),
    );
    expect(await response.json()).toEqual({});
  });
});
