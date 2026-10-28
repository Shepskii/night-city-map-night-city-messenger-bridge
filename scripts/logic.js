// Pure decisions for the bridge: which gig and market changes need an email, how rewards are paid,
// and which players a Reputation change lets into a night market. No Foundry globals, so it can be
// tested on its own (tests/logic.test.mjs).

const playerVisible = (gig) => ["offer", "active"].includes(gig?.status);

// ── Rewards ──────────────────────────────────────────────────────────────────

// "eb × crew" (what Night City Map writes for generated gigs), "per player", "each" and the like.
export function isPerCharacterReward(reward) {
  return /(?:[×x*]\s*(?:team|crew(?:\s+members?)?)|\bper\s+(?:player|person|character)\b|\beach\b)/i.test(String(reward ?? ""));
}

// The eddies in a reward's text: "2,000 eb", "500 eddies", or a bare number. Null when there are none.
export function parseReward(reward) {
  const text = String(reward ?? "").trim();
  const currencyMatch = text.match(/(?:^|[^\d])([\d][\d,]*)\s*(?:eb\b|edd(?:y|ies)\b)/i);
  const numericMatch = text.match(/^([\d][\d,]*)$/);
  const amountText = currencyMatch?.[1] ?? numericMatch?.[1];
  if (!amountText) return null;
  const amount = Number.parseInt(amountText.replace(/,/g, ""), 10);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function riskLevel(reward) {
  const amount = parseReward(reward);
  if (amount === null) return "Unrated";
  if (amount <= 200) return "Low / Light";
  if (amount <= 500) return "Moderate / Standard";
  if (amount <= 1000) return "High / Hard";
  return "Extreme / Deadly";
}

// Each character's share: the full amount each for a per-character reward, else an even split with
// the remainder handed out one eddie at a time.
export function splitReward(amount, actors, perCharacter) {
  if (perCharacter) return actors.map((actor) => ({ actor, amount }));
  const base = Math.floor(amount / actors.length);
  const remainder = amount % actors.length;
  return actors.map((actor, index) => ({ actor, amount: base + (index < remainder ? 1 : 0) }));
}

// ── Gigs ─────────────────────────────────────────────────────────────────────

/**
 * Status changes that need an email, between two looks at the map's gigs (Maps of id -> gig).
 * A gig going from offer to active is an acceptance when a player was seen taking it (`takes`,
 * gig id -> user id, consumed here), or when the map's `takenBy` changed to a new name; otherwise
 * the GM handed it out, which is a briefing for the whole crew. New gigs are not included: what
 * they are depends on the GM's click (see `addedGigEvents`).
 */
export function statusTransitions(before, after, takes = new Map()) {
  const transitions = [];
  for (const [id, previous] of before) {
    const gig = after.get(id);
    if (!gig) continue;

    if (gig.status === "failed" && playerVisible(previous)) {
      transitions.push({ type: "failed", gig });
    } else if (gig.status === "done" && previous.status === "active") {
      transitions.push({ type: "completion", gig });
    } else if (gig.status === "active" && previous.status !== "active") {
      const takenByUserId = previous.status === "offer" ? takes.get(id) ?? null : null;
      const takenByName = previous.status === "offer" && !takenByUserId && gig.takenBy && gig.takenBy !== previous.takenBy
        ? gig.takenBy
        : null;
      if (takenByUserId) takes.delete(id);
      transitions.push(takenByUserId || takenByName
        ? { type: "acceptance", gig, acceptedByUserId: takenByUserId, acceptedByName: takenByName }
        : { type: "briefing", gig });
    }
  }
  return transitions;
}

/**
 * New gigs the GM's click added: a gig written with "New" is a special contract; generated gigs
 * the players can see go out together as one screamsheet.
 */
export function addedGigEvents(before, after, action) {
  const added = [...after.values()].filter((gig) => !before.has(gig.id));
  if (action === "new-quest") return added.map((gig) => ({ type: "special", gig }));
  if (action === "gen-gig" || action === "gen-gigs") {
    const visible = added.filter(playerVisible);
    return visible.length ? [{ type: "screamsheet", gigs: visible }] : [];
  }
  return [];
}

// ── Night markets ────────────────────────────────────────────────────────────

// Players let in or shut out between two looks at the markets (Maps of id -> market).
export function collectMarketAccessChanges(before, after) {
  const changes = [];
  for (const [marketId, market] of after) {
    const previous = before.get(marketId);
    if (!previous) continue;
    const previousAccess = new Set(previous.access ?? []);
    const currentAccess = new Set(market.access ?? []);
    for (const userId of currentAccess) {
      if (!previousAccess.has(userId)) changes.push({ marketId, userId, granted: true });
    }
    for (const userId of previousAccess) {
      if (!currentAccess.has(userId)) changes.push({ marketId, userId, granted: false });
    }
  }
  return changes;
}

// Changes when a market is added or its Reputation threshold is edited, but not when access is toggled.
export function marketEligibilitySignature(markets) {
  return JSON.stringify([...markets.values()]
    .map((market) => [market.id, market.rep ?? 0])
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)));
}

/**
 * Reputation-based access. A player whose Reputation reaches a market's threshold is let in; one
 * the bridge let in that way is shut out again when it drops below. Access the GM granted or
 * revoked by hand (`overrides`) always wins, and access the GM granted is never taken away.
 * @param {object[]} markets - the map's markets; not changed
 * @param {{id: string, rep: number}[]} players
 * @param {object} autoAccess - marketId -> userId -> true, for access the bridge granted; not changed
 * @param {object} overrides - marketId -> userId -> granted, for the GM's own decisions
 * @returns {{markets: object[], autoAccess: object, changes: object[], mapChanged: boolean, autoAccessChanged: boolean}}
 */
export function planMarketAccess({ markets, players, autoAccess, overrides }) {
  const auto = structuredClone(autoAccess ?? {});
  const changes = [];
  let mapChanged = false;
  let autoAccessChanged = false;

  const nextMarkets = (markets ?? []).map((market) => {
    if (!market?.id) return market;
    const access = new Set(market.access ?? []);
    const requiredRep = Number(market.rep ?? 0);
    const threshold = Number.isFinite(requiredRep) ? requiredRep : 0;
    const marketOverrides = overrides?.[market.id] ?? {};
    let marketChanged = false;
    auto[market.id] ??= {};

    const set = (userId, granted) => {
      if (granted) access.add(userId);
      else access.delete(userId);
      changes.push({ marketId: market.id, userId, granted, automatic: true });
      marketChanged = true;
    };

    for (const player of players) {
      const isAccessible = access.has(player.id);
      const wasAutoGranted = !!auto[market.id][player.id];

      if (Object.hasOwn(marketOverrides, player.id)) {
        const overrideAccess = !!marketOverrides[player.id];
        if (wasAutoGranted) {
          delete auto[market.id][player.id];
          autoAccessChanged = true;
        }
        if (isAccessible !== overrideAccess) set(player.id, overrideAccess);
        continue;
      }

      const qualifies = player.rep >= threshold;
      if (qualifies && !isAccessible) {
        set(player.id, true);
        auto[market.id][player.id] = true;
        autoAccessChanged = true;
      } else if (!qualifies && isAccessible && wasAutoGranted) {
        set(player.id, false);
        delete auto[market.id][player.id];
        autoAccessChanged = true;
      } else if (!isAccessible && wasAutoGranted) {
        delete auto[market.id][player.id];
        autoAccessChanged = true;
      }
    }

    if (!Object.keys(auto[market.id]).length) delete auto[market.id];
    if (!marketChanged) return market;
    mapChanged = true;
    return { ...market, access: [...access] };
  });

  return { markets: nextMarkets, autoAccess: auto, changes, mapChanged, autoAccessChanged };
}
