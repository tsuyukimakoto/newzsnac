import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { DiscoveryService, extractCandidateInputs } from "../src/discovery/service.js";
import { SourceResolver } from "../src/sources/resolver.js";
import { SourceService } from "../src/sources/service.js";

test("unverified candidate URLs are rejected and never auto-subscribe", async () => {
  const database=openDatabase(":memory:");
  try {
    const resolver=new SourceResolver(async()=>new Response("missing",{status:404}));
    const sources=new SourceService(database,resolver);
    const discovery=new DiscoveryService(database,resolver,sources);
    const inputs=extractCandidateInputs(1,"Read https://invalid.example and discuss", "alice.bsky.social", ["typescript"]);
    assert.equal(inputs.length,3);
    assert.equal(await discovery.verifyAndSave(inputs[0]!,"linked article"),null);
    assert.equal(database.prepare("SELECT count(*) count FROM source_candidates").get()?.count,0);
    assert.equal(database.prepare("SELECT count(*) count FROM sources").get()?.count,0);
  } finally { database.close(); }
});
