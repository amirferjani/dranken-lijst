import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog = JSON.parse(
  await readFile(new URL("../catalog.json", import.meta.url), "utf8")
);

test("the committed POS catalog snapshot is complete and traceable", () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.source?.repository, "amirferjani/DLL_Injector");
  assert.match(catalog.source?.revision || "", /^[0-9a-f]{40}$/);
  assert.equal(catalog.source?.activeParts, 7);
  assert.match(catalog.source?.syncedAt || "", /^\d{4}-\d{2}-\d{2}T/);

  assert.ok(Array.isArray(catalog.products));
  assert.equal(catalog.products.length, 260);

  const ids = catalog.products.map((product) => product.id);
  assert.equal(new Set(ids).size, catalog.products.length, "catalog ids must be unique");

  for (const product of catalog.products) {
    assert.match(product.id, /^p\d+$/);
    assert.equal(typeof product.name, "string");
    assert.ok(product.name.trim().length > 0);
    assert.equal(typeof product.category, "string");
    assert.ok(product.category.trim().length > 0);
    assert.ok(Array.isArray(product.aliases));
    assert.equal(typeof product.favorite, "boolean");
    assert.equal(new Set(product.aliases).size, product.aliases.length);
    assert.ok(product.aliases.every((alias) => typeof alias === "string" && alias.trim().length > 0));
  }
});

test("known bottle products keep the exact POS names", () => {
  const byId = new Map(catalog.products.map((product) => [product.id, product]));

  assert.equal(byId.get("p87")?.name, "Carlsberg Green Label");
  assert.ok(byId.get("p87")?.aliases.includes("carlsberg"));
  assert.equal(byId.get("p96")?.name, "Desperados");
  assert.equal(byId.get("p100")?.name, "Gulden Draak");
  assert.equal(byId.get("p101")?.name, "Westmalle Dubbel");
  assert.equal(byId.get("p102")?.name, "Westmalle Tripel");

  assert.equal(catalog.products.some((product) => product.name === "Carlsberg"), false);
  assert.equal(catalog.products.some((product) => product.name === "Desperados Original"), false);
  assert.equal(catalog.products.some((product) => product.name === "Gulden Draak Classic"), false);
});

test("the expected POS category shape is preserved", () => {
  const categories = new Set(catalog.products.map((product) => product.category));
  assert.equal(categories.size, 23);
  assert.equal(
    catalog.products.filter((product) => product.category === "Bieren op fles").length,
    21
  );

  const southernComfort = catalog.products.filter((product) => product.name === "Southern Comfort");
  assert.deepEqual(
    southernComfort.map((product) => product.id).sort(),
    ["p163", "p191", "p243"]
  );
});
