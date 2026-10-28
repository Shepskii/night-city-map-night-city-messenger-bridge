import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPerCharacterReward, parseReward, riskLevel, splitReward,
  statusTransitions, addedGigEvents, collectMarketAccessChanges, marketEligibilitySignature, planMarketAccess,
} from "../scripts/logic.js";

const gig = (id, status, extra = {}) => ({ id, status, title: `Gig ${id}`, ...extra });
const byId = (...list) => new Map(list.map((entry) => [entry.id, entry]));
const summary = (transitions) => transitions.map((t) => [t.type, t.gig?.id ?? t.gigs.map((g) => g.id).join(",")]);

// ── Rewards ──────────────────────────────────────────────────────────────────

test("rewards: eddies are read from the text, and anything else pays nothing", () => {
  assert.equal(parseReward("2,000 eb"), 2000);
  assert.equal(parseReward("Pays 500 eddies on delivery"), 500);
  assert.equal(parseReward("1 eddy"), 1);
  assert.equal(parseReward("750"), 750);
  assert.equal(parseReward("1500 eb × crew (hard)"), 1500);
  assert.equal(parseReward("A favour"), null);
  assert.equal(parseReward("0 eb"), null);
  assert.equal(parseReward(""), null);
  assert.equal(parseReward(undefined), null);
});

test("rewards: a crew reward is paid to each character, anything else is a team total", () => {
  for (const text of ["500 eb × crew (easy)", "500 eb x team", "500 eb * crew members", "500 eb per player", "500 eb each"]) {
    assert.equal(isPerCharacterReward(text), true, text);
  }
  for (const text of ["500 eb", "500 eb for the crew", "Teamwork pays 500 eb"]) {
    assert.equal(isPerCharacterReward(text), false, text);
  }
});

test("rewards: a team total splits evenly, the remainder one eddie at a time", () => {
  assert.deepEqual(splitReward(1000, ["a", "b", "c"], false).map((s) => s.amount), [334, 333, 333]);
  assert.deepEqual(splitReward(500, ["a", "b"], true).map((s) => s.amount), [500, 500]);
});

test("rewards: the risk band follows the payout", () => {
  assert.deepEqual(["150 eb", "200 eb", "400 eb", "1,000 eb", "1,001 eb", "A favour"].map(riskLevel),
    ["Low / Light", "Low / Light", "Moderate / Standard", "High / Hard", "Extreme / Deadly", "Unrated"]);
});

// ── Gig status changes ──────────────────────────────────────────────────────

test("a gig that fails, completes, or is handed out needs an email", () => {
  const before = byId(gig("a", "active"), gig("b", "offer"), gig("c", "active"), gig("d", "hidden"), gig("e", "offer"));
  const after = byId(gig("a", "done"), gig("b", "failed"), gig("c", "failed"), gig("d", "active"), gig("e", "active"));
  assert.deepEqual(summary(statusTransitions(before, after)),
    [["completion", "a"], ["failed", "b"], ["failed", "c"], ["briefing", "d"], ["briefing", "e"]]);
});

test("changes that are not news send nothing", () => {
  const before = byId(gig("a", "hidden"), gig("b", "offer"), gig("c", "done"), gig("gone", "active"), gig("d", "active"));
  const after = byId(gig("a", "failed"), gig("b", "done"), gig("c", "failed"), gig("d", "active", { title: "Renamed" }), gig("new", "active"));
  assert.deepEqual(statusTransitions(before, after), [], "a hidden gig failing, a gig finished without being run, a reversal, a deletion, an edit, a new gig");
});

test("a gig a player was seen taking is their acceptance", () => {
  const takes = new Map([["a", "user-v"]]);
  const [t] = statusTransitions(byId(gig("a", "offer")), byId(gig("a", "active", { takenBy: "V" })), takes);
  assert.deepEqual([t.type, t.acceptedByUserId, t.acceptedByName], ["acceptance", "user-v", null]);
  assert.equal(takes.size, 0, "the take is used up");
});

test("a player taking a gig again is still an acceptance, not a briefing for the whole crew", () => {
  // The map keeps `takenBy` when the GM puts a taken gig back on offer, so the name does not change.
  const before = byId(gig("a", "offer", { takenBy: "V" }));
  const after = byId(gig("a", "active", { takenBy: "V" }));
  assert.deepEqual(summary(statusTransitions(before, after, new Map([["a", "user-v"]]))), [["acceptance", "a"]]);
  assert.deepEqual(summary(statusTransitions(before, after)), [["briefing", "a"]], "with no take seen, the GM handed it out");
});

test("a new taker's name is an acceptance even when the take itself was not seen", () => {
  const [t] = statusTransitions(byId(gig("a", "offer", { takenBy: "Jackie" })), byId(gig("a", "active", { takenBy: "V" })));
  assert.deepEqual([t.type, t.acceptedByUserId, t.acceptedByName], ["acceptance", null, "V"]);
});

// ── New gigs ─────────────────────────────────────────────────────────────────

test("a gig the GM writes is a special contract; generated gigs players can see are one screamsheet", () => {
  const before = byId(gig("old", "offer"));
  const after = byId(gig("old", "offer"), gig("n1", "hidden"), gig("n2", "offer"), gig("n3", "active"));
  assert.deepEqual(summary(addedGigEvents(before, after, "new-quest")), [["special", "n1"], ["special", "n2"], ["special", "n3"]]);
  assert.deepEqual(summary(addedGigEvents(before, after, "gen-gigs")), [["screamsheet", "n2,n3"]]);
  assert.deepEqual(addedGigEvents(before, byId(gig("old", "offer"), gig("n1", "hidden")), "gen-gig"), [], "only hidden gigs: no screamsheet");
  assert.deepEqual(addedGigEvents(before, after, "quest-status"), [], "other clicks add nothing");
});

// ── Night markets ────────────────────────────────────────────────────────────

test("access changes list who was let in and who was shut out", () => {
  const before = byId({ id: "m", access: ["u1", "u2"] }, { id: "old", access: [] });
  const after = byId({ id: "m", access: ["u2", "u3"] }, { id: "new", access: ["u1"] });
  assert.deepEqual(collectMarketAccessChanges(before, after), [
    { marketId: "m", userId: "u3", granted: true },
    { marketId: "m", userId: "u1", granted: false },
  ]);
});

test("the eligibility signature changes with a new market or threshold, not with access", () => {
  const sig = marketEligibilitySignature(byId({ id: "b", rep: 2, access: [] }, { id: "a", rep: 0 }));
  assert.equal(sig, marketEligibilitySignature(byId({ id: "a", rep: 0 }, { id: "b", rep: 2, access: ["u1"] })));
  assert.notEqual(sig, marketEligibilitySignature(byId({ id: "a", rep: 0 }, { id: "b", rep: 3 })));
  assert.notEqual(sig, marketEligibilitySignature(byId({ id: "a", rep: 0 }, { id: "b", rep: 2 }, { id: "c" })));
});

test("Reputation lets a player in, and shuts them out again only if it let them in", () => {
  const markets = [{ id: "m", rep: 3, access: ["gmGranted"] }];
  const players = [{ id: "rich", rep: 4 }, { id: "poor", rep: 1 }, { id: "gmGranted", rep: 0 }];
  const first = planMarketAccess({ markets, players, autoAccess: {}, overrides: {} });
  assert.deepEqual(first.changes, [{ marketId: "m", userId: "rich", granted: true, automatic: true }]);
  assert.deepEqual(first.markets[0].access.sort(), ["gmGranted", "rich"]);
  assert.deepEqual(first.autoAccess, { m: { rich: true } });
  assert.deepEqual(markets[0].access, ["gmGranted"], "the input is not changed");

  const dropped = planMarketAccess({
    markets: first.markets, players: [{ id: "rich", rep: 2 }, { id: "gmGranted", rep: 0 }], autoAccess: first.autoAccess, overrides: {},
  });
  assert.deepEqual(dropped.changes, [{ marketId: "m", userId: "rich", granted: false, automatic: true }]);
  assert.deepEqual(dropped.markets[0].access, ["gmGranted"], "access the GM gave is never taken away");
  assert.deepEqual(dropped.autoAccess, {});
});

test("the GM's own decision beats Reputation either way", () => {
  const out = planMarketAccess({
    markets: [{ id: "m", rep: 3, access: ["banned"] }],
    players: [{ id: "banned", rep: 9 }, { id: "invited", rep: 0 }],
    autoAccess: { m: { banned: true } },
    overrides: { m: { banned: false, invited: true } },
  });
  assert.deepEqual(out.changes.map((c) => [c.userId, c.granted]), [["banned", false], ["invited", true]]);
  assert.deepEqual(out.autoAccess, {}, "an overridden player is no longer counted as the bridge's");
  assert.equal(out.mapChanged, true);

  const quiet = planMarketAccess({ markets: out.markets, players: [{ id: "invited", rep: 0 }], autoAccess: {}, overrides: { m: { invited: true } } });
  assert.deepEqual([quiet.changes, quiet.mapChanged, quiet.autoAccessChanged], [[], false, false], "nothing to do once settled");
});
