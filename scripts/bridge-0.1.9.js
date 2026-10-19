const MODULE_ID = "night-city-map-night-city-messenger-bridge";
const MAP_ID = "night-city-map";
const MAP_SOCKET = `module.${MAP_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const WRAPPED_HANDLER_FLAG = "__nightCityMessengerBridge";
const FIXER_TAG = "CREWFIXER";
const SPECIAL_GREETINGS = [
  "Chooms,",
  "Evening chooms,",
  "Eyes up, edgerunners,",
  "Hey operators,",
  "Night City's calling,",
  "Listen up screwheads,",
];
const SPECIAL_OPENINGS = [
  "A priority contract just hit my encrypted box.",
  "Fresh job request came in over the wire.",
  "New gig just surfaced on the screamsheets.",
  "A client routed a special request through the 'NET.",
  "This contract came in on a private channel.",
  "A spicy piece of work just landed in my queue.",
];
const SPECIAL_SIGNOFFS = [
  "Don't be fuckups,",
  "Stay off the scanners,",
  "Run quiet,",
  "Leave no loose ends,",
  "Keep your 'wares clean,",
  "I'll be in touch,",
];
const POSITIVE_SIGNOFFS = [
  "Good work out there,",
  "Make the most of it,",
  "Enjoy, choom,",
  "Keep the crew rolling,",
  "See you around the city,",
  "Stay sharp and spend wisely,",
];
const ACCEPTANCE_OPENINGS = [
  "Your reply just landed in my inbox.",
  "Got your signal. The contract is yours.",
  "Copy that. Your name is on the job.",
  "Your response came through over the wire.",
  "That's a go. The client is expecting results.",
  "Contract confirmed. I'll let the client know you're moving.",
];
const ACCEPTANCE_SIGNOFFS = [
  "Let me know when the job's done,",
  "Keep me posted,",
  "I'll be waiting on the completion signal,",
  "Send word when it's wrapped,",
  "Ping me when the dust settles,",
  "I expect an update when it's finished,",
];
const NEGATIVE_GREETINGS = [
  "Bad news, chooms,",
  "This one's ugly, crew,",
  "Listen up, screwups,",
  "The city's done being patient,",
  "Read this carefully,",
  "No good news on this channel,",
];
const NEGATIVE_SIGNOFFS = [
  "Don't make this worse,",
  "Fix this before it spreads,",
  "Keep your heads down,",
  "I'm watching this closely,",
  "Don't test my patience,",
  "Try not to disappoint me twice,",
];
const FAILED_OUTCOMES = [
  "The client knows you blew it. You just made the whole crew look like amateurs.",
  "You botched the job, and now the client thinks we're a bunch of incompetent fuckups.",
  "That was a shitshow. The client knows you failed, and our reputation is paying for it.",
  "Congratulations, chooms: you turned a paying gig into a reputation problem.",
  "You dropped the ball hard. The client knows, and this screwup may cost us future work.",
  "That job went sideways because you screwed it up. Don't expect the client to forget.",
];
const COMPLETION_OUTCOMES = [
  "Clean work, crew. Another contract closed without a loose end.",
  "You got it done. The client is satisfied, and the crew's name carries a little more weight.",
  "That's how professionals operate. The job is complete and the payout is secured.",
  "Night City keeps moving, and so do you. Another successful gig is in the books.",
  "Well played, chooms. You delivered what you promised and earned every eddie.",
  "The client got results, the crew got paid, and the street has a new story to tell.",
];
const MARKET_ACCESS_GRANTED_MESSAGES = [
  (fixer, market) => `Access to <strong>${html(market)}</strong> is approved. <strong>${html(fixer)}</strong> has put you on the list.`,
  (fixer, market) => `<strong>${html(fixer)}</strong> has vouched for you. You're cleared to enter <strong>${html(market)}</strong>.`,
  (fixer, market) => `You're in: <strong>${html(market)}</strong> has approved your access. <strong>${html(fixer)}</strong> will be expecting you.`,
  (fixer, market) => `Your request came through. <strong>${html(fixer)}</strong> has opened the doors to <strong>${html(market)}</strong>.`,
  (fixer, market) => `<strong>${html(fixer)}</strong> added you to the guest list for <strong>${html(market)}</strong>. Don't waste the favor.`,
  (fixer, market) => `Consider yourself cleared for <strong>${html(market)}</strong>. <strong>${html(fixer)}</strong> confirmed your access.`,
];
const MARKET_ACCESS_REVOKED_MESSAGES = [
  (fixer, market) => `<strong>${html(fixer)}</strong> pulled your access to <strong>${html(market)}</strong>. You're off the list. Don't show up.`,
  (fixer, market) => `Your access to <strong>${html(market)}</strong> is revoked. <strong>${html(fixer)}</strong> withdrew the favor; don't be a dumbass and test the door.`,
  (fixer, market) => `You're no longer welcome at <strong>${html(market)}</strong>. <strong>${html(fixer)}</strong> made sure your name is off the list.`,
  (fixer, market) => `Market access is dead. <strong>${html(fixer)}</strong> closed that door; stay out unless you want to make this worse.`,
  (fixer, market) => `<strong>${html(fixer)}</strong> blacklisted you from <strong>${html(market)}</strong>. Showing up now would make you look like an absolute fuckup.`,
  (fixer, market) => `That invitation is gone. <strong>${html(fixer)}</strong> revoked your access to <strong>${html(market)}</strong>. Take the hint, choom.`,
];

console.info(`${MODULE_ID} | Runtime build 0.1.9 loaded.`);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "gigFixers", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
  game.settings.register(MODULE_ID, "marketAccessFixers", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
});

let initialized = false;
let liveEventsReady = false;
let deliveryQueue = Promise.resolve();
let lastObservedGigs = null;
let poiDataPromise = null;
const recentTransitions = new Map();

function activeGM() {
  return game.user?.isGM && game.user.id === game.users.activeGM?.id;
}

function gigList() {
  return game.settings.get(MAP_ID, "state")?.quests ?? [];
}

function marketList() {
  return game.settings.get(MAP_ID, "state")?.markets ?? [];
}

function snapshotGigs() {
  return new Map(gigList().filter((gig) => gig?.id).map((gig) => [
    gig.id,
    foundry.utils.deepClone(gig),
  ]));
}

function snapshotMarkets() {
  return new Map(marketList().filter((market) => market?.id).map((market) => [
    market.id,
    foundry.utils.deepClone(market),
  ]));
}

function playerCharacters() {
  const actors = new Map();
  for (const user of game.users.contents) {
    const actor = !user.isGM ? user.character : null;
    if (actor) actors.set(actor.id, actor);
  }
  return [...actors.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function fixerContacts() {
  return game.nightcity?.masterContactService?.filterByTag?.(FIXER_TAG) ?? [];
}

function randomFixer() {
  const contacts = fixerContacts();
  if (!contacts.length) return null;
  return contacts[Math.floor(Math.random() * contacts.length)];
}

function assignedFixer(gig) {
  if (!gig?.id) return null;
  const service = game.nightcity?.masterContactService;
  const fixerId = game.settings.get(MODULE_ID, "gigFixers")?.[gig.id];
  return fixerId ? service?.getContact?.(fixerId) ?? null : null;
}

function marketAccessFixer(marketId, userId) {
  const service = game.nightcity?.masterContactService;
  const fixerId = game.settings.get(MODULE_ID, "marketAccessFixers")?.[marketId]?.[userId];
  return fixerId ? service?.getContact?.(fixerId) ?? null : null;
}

async function updateMarketAccessFixer(marketId, userId, fixerId) {
  const assignments = foundry.utils.deepClone(
    game.settings.get(MODULE_ID, "marketAccessFixers") ?? {},
  );
  assignments[marketId] ??= {};
  if (fixerId) {
    assignments[marketId][userId] = fixerId;
  } else {
    delete assignments[marketId][userId];
    if (!Object.keys(assignments[marketId]).length) delete assignments[marketId];
  }
  await game.settings.set(MODULE_ID, "marketAccessFixers", assignments);
}

async function assignFixer(gig) {
  const existing = assignedFixer(gig);
  if (existing) return existing;

  const fixer = randomFixer();
  if (!fixer || !gig?.id) return fixer;

  const assignments = foundry.utils.deepClone(game.settings.get(MODULE_ID, "gigFixers") ?? {});
  assignments[gig.id] = fixer.id;
  await game.settings.set(MODULE_ID, "gigFixers", assignments);
  return fixer;
}

function fixerForFollowup(gig) {
  return assignedFixer(gig) ?? randomFixer();
}

function html(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function poiName(id) {
  if (!id) return "—";

  const state = game.settings.get(MAP_ID, "state") ?? {};
  const custom = [
    ...(state.pins ?? []),
    ...(state.shops ?? []),
    ...(state.markets ?? []),
  ].find((poi) => poi.id === id);
  if (custom?.name) return custom.name;

  const override = state.poi?.[id];
  if (override?.name) return override.name;

  try {
    poiDataPromise ??= import(`/modules/${MAP_ID}/scripts/data.js`);
    const { POIS } = await poiDataPromise;
    return POIS.find((poi) => poi.id === id)?.name ?? id;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not resolve map marker ${id}.`, error);
    return id;
  }
}

async function gigDetails(gig, fixer) {
  const [pickup, target] = await Promise.all([
    poiName(gig.giver),
    poiName(gig.target),
  ]);
  const lines = [
    `<p><strong>Gig:</strong> ${html(gig.title || "Untitled gig")}</p>`,
    `<p><strong>Fixer:</strong> ${html(fixer.name)}</p>`,
    `<p><strong>Client:</strong> ${html(gig.client)}</p>`,
    `<p><strong>Pickup:</strong> ${html(pickup)}</p>`,
    `<p><strong>Target:</strong> ${html(target)}</p>`,
    `<p><strong>Reward:</strong> ${html(gig.reward)}</p>`,
  ];
  if (gig.desc) lines.push(`<p><strong>Details:</strong><br>${html(gig.desc).replace(/\n/g, "<br>")}</p>`);
  return lines.join("\n");
}

function randomChoice(options) {
  return options[Math.floor(Math.random() * options.length)];
}

async function gigContractBody(gig, fixer, intro, signoffs) {
  const availableSignoffs = signoffs ?? [
    "Stay sharp,",
    "Keep your head down,",
    "Make it clean,",
    "Don't make me regret this,",
    "The city is watching,",
    "Until the next one,",
  ];
  const introLines = Array.isArray(intro) ? intro : [intro];
  const introHtml = introLines.map((line) => `<p>${line}</p>`).join("");
  const signoff = randomChoice(availableSignoffs);
  return `${introHtml}${await gigDetails(gig, fixer)}`
    + `<p>Payment will be delivered upon proof of completion</p>`
    + `<p>${signoff}<br><strong>${html(fixer.name)}</strong></p>`;
}

function isPerCharacterReward(reward) {
  return /(?:[×x*]\s*(?:team|команд)|\bper\s+(?:player|person|character)\b|\beach\b|на каждого|каждому)/iu.test(reward);
}

function parseReward(reward) {
  const match = String(reward ?? "").match(/(?:^|[^\d])([\d][\d,]*)\s*(?:eb\b|edd(?:y|ies)\b|эдди(?:й|и|ев)?)/iu);
  if (!match) return null;
  const amount = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function riskLevel(reward) {
  const amount = parseReward(reward);
  if (amount === null) return "Unrated";
  if (amount <= 200) return "Low / Light";
  if (amount <= 500) return "Moderate / Standard";
  if (amount <= 1000) return "High / Hard";
  return "Extreme / Deadly";
}

function splitReward(amount, actors, perCharacter) {
  if (perCharacter) return actors.map((actor) => ({ actor, amount }));
  const base = Math.floor(amount / actors.length);
  const remainder = amount % actors.length;
  return actors.map((actor, index) => ({ actor, amount: base + (index < remainder ? 1 : 0) }));
}

function playerForCharacterName(name) {
  const matches = game.users.contents.filter((user) =>
    !user.isGM && user.character?.name === name,
  );
  return matches.length === 1 ? matches[0] : null;
}

async function sendEmail({ fixer, actor, subject, body, eddies = 0 }) {
  const service = game.nightcity?.messageService;
  if (typeof service?.sendMessage !== "function") {
    throw new Error("Night City Messenger MessageService is unavailable.");
  }

  const result = await service.sendMessage({
    fromContactId: fixer.id,
    toActorId: actor.id,
    subject,
    body,
    priority: "normal",
    eddies,
  });
  if (!result?.success) {
    throw new Error(result?.error || `Messenger failed to deliver to ${actor.name}.`);
  }
}

async function sendMarketRequest({ marketId, userId, characterId }) {
  const user = game.users.get(userId);
  const actor = user?.character;
  const market = marketList().find((entry) => entry.id === marketId);
  if (!user || user.isGM || !actor || actor.id !== characterId || !market) return;

  const fixer = randomFixer();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; night market request email was not sent.`);
    return;
  }

  const result = await game.nightcity.messageService.sendMessage({
    fromActorId: actor.id,
    toContactId: fixer.id,
    subject: `Night Market Access Request: ${market.name}`,
    body: `<p>I'd like access to the night market <strong>${html(market.name)}</strong>. `
      + `Could you ask <strong>${html(market.fixer || "the named fixer")}</strong> to vouch for me?</p>`
      + `<p>My Reputation is ${html(market.rep ?? 0)}; the market requires ${html(market.rep ?? 0)}+.</p>`,
    priority: "normal",
  });
  if (!result?.success) {
    throw new Error(result?.error || `Messenger failed to deliver the night market request from ${actor.name}.`);
  }
}

async function sendMarketAccessChange({ marketId, userId, granted }) {
  const market = marketList().find((entry) => entry.id === marketId);
  const user = game.users.get(userId);
  const actor = user?.character;
  if (!market || !!market.access?.includes(userId) !== granted || !actor) return;

  const fixer = granted
    ? randomFixer()
    : marketAccessFixer(marketId, userId);
  if (!fixer) {
    ui.notifications.warn(granted
      ? `${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; night market access update email was not sent.`
      : `${MODULE_ID} | No recorded grant fixer is available; night market revocation email was not sent.`);
    return;
  }

  const marketFixer = market.fixer || "The fixer";
  const marketMessage = randomChoice(
    granted ? MARKET_ACCESS_GRANTED_MESSAGES : MARKET_ACCESS_REVOKED_MESSAGES,
  )(marketFixer, market.name);
  await sendEmail({
    fixer,
    actor,
    subject: `Night Market Access ${granted ? "Granted" : "Revoked"}: ${market.name}`,
    body: granted
      ? `<p>${randomChoice(SPECIAL_GREETINGS)}</p>`
        + `<p>${marketMessage}</p>`
        + `<p>${randomChoice(POSITIVE_SIGNOFFS)}<br><strong>${html(fixer.name)}</strong></p>`
      : `<p>${randomChoice(NEGATIVE_GREETINGS)}</p>`
        + `<p>${marketMessage}</p>`
        + `<p>${randomChoice(NEGATIVE_SIGNOFFS)}<br><strong>${html(fixer.name)}</strong></p>`,
  });
  await updateMarketAccessFixer(marketId, userId, granted ? fixer.id : null);
}

async function sendToEach(recipients, buildEmail) {
  let failures = 0;
  for (const actor of recipients) {
    try {
      await sendEmail(await buildEmail(actor));
    } catch (error) {
      failures += 1;
      console.error(`${MODULE_ID} | Could not email ${actor.name}.`, error);
    }
  }
  if (failures) {
    ui.notifications.warn(`${MODULE_ID} | ${failures} gig email(s) failed. See the console for details.`);
  }
}

function enqueueDelivery(task) {
  deliveryQueue = deliveryQueue.then(task).catch((error) => {
    console.error(`${MODULE_ID} | Gig email delivery failed.`, error);
  });
  return deliveryQueue;
}

function transitionKey(type, gig) {
  return `${type}:${gig.id}:${gig.status}`;
}

function isRecentDuplicate(type, gig) {
  const key = transitionKey(type, gig);
  const previous = recentTransitions.get(key);
  if (previous && Date.now() - previous < 2000) return true;
  recentTransitions.set(key, Date.now());
  setTimeout(() => recentTransitions.delete(key), 2000);
  return false;
}

async function sendBriefing(gig, recipientActors, accepted = false) {
  if (!recipientActors.length) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this gig.`);
    return;
  }

  const fixer = accepted ? await assignFixer(gig) : randomFixer();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; gig email was not sent.`);
    return;
  }

  const body = await gigContractBody(
    gig,
    fixer,
    accepted
      ? [
        randomChoice(SPECIAL_GREETINGS),
        randomChoice(ACCEPTANCE_OPENINGS),
        "You have accepted the following gig contract:",
      ]
      : "You have been assigned the following gig contract:",
    accepted ? ACCEPTANCE_SIGNOFFS : undefined,
  );
  await sendToEach(recipientActors, (actor) => ({
    fixer,
    actor,
    subject: accepted
      ? `Gig contract accepted: ${gig.title || "Untitled gig"}`
      : `New gig: ${gig.title || "Untitled gig"}`,
    body,
  }));
}

async function sendPlayerNotice(gig, {
  subject,
  intro,
  contract = false,
  signoffs,
  greetings,
}, reuseAssignment = false) {
  const recipients = playerCharacters();
  if (!recipients.length) return;

  const fixer = reuseAssignment ? fixerForFollowup(gig) : randomFixer();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; gig email was not sent.`);
    return;
  }

  const body = contract
    ? await gigContractBody(gig, fixer, intro, signoffs)
    : `${greetings ? `<p>${randomChoice(greetings)}</p>` : ""}`
      + `<p>${intro}</p>${await gigDetails(gig, fixer)}`
      + `${signoffs ? `<p>${randomChoice(signoffs)}<br><strong>${html(fixer.name)}</strong></p>` : ""}`;
  await sendToEach(recipients, (actor) => ({ fixer, actor, subject, body }));
}

async function sendScreamsheet(gigs) {
  const recipients = playerCharacters();
  if (!recipients.length || !gigs.length) return;

  const fixer = randomFixer();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; screamsheet was not sent.`);
    return;
  }

  const listings = await Promise.all(gigs.map(async (gig) => {
    const [pickup, target] = await Promise.all([poiName(gig.giver), poiName(gig.target)]);
    return `<li><strong>${html(gig.title || "Untitled gig")}</strong>`
      + `<br>Client: ${html(gig.client)}`
      + `<br>Payout: ${html(gig.reward)}`
      + `<br>Risk: ${riskLevel(gig.reward)}`
      + `<br>Pickup: ${html(pickup)} | Target: ${html(target)}`
      + (gig.desc ? `<br>${html(gig.desc).replace(/\n/g, "<br>")}` : "")
      + "</li>";
  }));
  const body = `<p>Fresh work is circulating across Night City, check out the available contracts below.</p><ul>${listings.join("")}</ul>`;
  await sendToEach(recipients, (actor) => ({
    fixer,
    actor,
    subject: `Night City Screamsheet: ${gigs.length} new gig${gigs.length === 1 ? "" : "s"}`,
    body,
  }));
}

async function sendCompletion(gig) {
  const recipients = playerCharacters();
  if (!recipients.length) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this payment.`);
    return;
  }

  const fixer = fixerForFollowup(gig);
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; payment email was not sent.`);
    return;
  }

  const total = parseReward(gig.reward);
  const perCharacter = total !== null && isPerCharacterReward(String(gig.reward));
  const shares = total === null ? recipients.map((actor) => ({ actor, amount: 0 }))
    : splitReward(total, recipients, perCharacter);
  const completionNote = total === null
    ? `The listed reward was ${html(gig.reward || "not specified")}; no numeric eddies amount could be attached.`
    : perCharacter
      ? `Your payment is ${shares[0]?.amount.toLocaleString()} eb, as listed for this team gig.`
      : `The ${total.toLocaleString()} eb reward has been disbursed to the crew.`;

  await sendToEach(shares.map((share) => share.actor), async (actor) => {
    const share = shares.find((entry) => entry.actor.id === actor.id);
    const body = `<p>${randomChoice(COMPLETION_OUTCOMES)} ${completionNote}</p>${await gigDetails(gig, fixer)}${
      share.amount ? `<p><strong>Your attached payment:</strong> ${share.amount.toLocaleString()} eb</p>` : ""
    }<p>${randomChoice(POSITIVE_SIGNOFFS)}<br><strong>${html(fixer.name)}</strong></p>`;
    return {
      fixer,
      actor,
      subject: `Gig complete: ${gig.title || "Untitled gig"}`,
      body,
      eddies: share.amount,
    };
  });
}

async function processTransition(transition) {
  if (!liveEventsReady || !activeGM() || isRecentDuplicate(transition.type, transition.gig ?? transition.gigs?.[0])) return;
  if (transition.type === "screamsheet") return sendScreamsheet(transition.gigs);
  if (transition.type === "special") {
    return sendPlayerNotice(transition.gig, {
      subject: `Special contract: ${transition.gig.title || "Untitled gig"}`,
      intro: [randomChoice(SPECIAL_GREETINGS), randomChoice(SPECIAL_OPENINGS)],
      contract: true,
      signoffs: SPECIAL_SIGNOFFS,
    });
  }
  if (transition.type === "failed") {
    return sendPlayerNotice(transition.gig, {
      subject: `Job failed: ${transition.gig.title || "Untitled gig"}`,
      intro: randomChoice(FAILED_OUTCOMES),
      greetings: NEGATIVE_GREETINGS,
      signoffs: NEGATIVE_SIGNOFFS,
    }, true);
  }
  if (transition.type === "briefing" || transition.type === "acceptance") {
    const acceptedUser = transition.acceptedByUserId
      ? game.users.get(transition.acceptedByUserId)
      : playerForCharacterName(transition.acceptedByName);
    const recipients = transition.type === "acceptance"
      ? [acceptedUser?.character].filter(Boolean)
      : playerCharacters();
    if (transition.type === "acceptance" && !recipients.length) {
      ui.notifications.warn(`${MODULE_ID} | Could not identify the character who accepted "${transition.gig.title}".`);
      return;
    }
    return sendBriefing(transition.gig, recipients, transition.type === "acceptance");
  }
  if (transition.type === "completion") return sendCompletion(transition.gig);
}

function collectTransitions(before, after, action = null) {
  const transitions = [];
  const added = [...after.entries()]
    .filter(([id]) => !before.has(id))
    .map(([, gig]) => gig);
  const addedIds = new Set(added.map((gig) => gig.id));
  const playerVisible = (gig) => ["offer", "active"].includes(gig.status);

  if (action === "new-quest") {
    for (const gig of added) transitions.push({ type: "special", gig });
  } else if (["gen-gig", "gen-gigs"].includes(action)) {
    const visibleGigs = added.filter(playerVisible);
    if (visibleGigs.length) transitions.push({ type: "screamsheet", gigs: visibleGigs });
  }

  for (const [id, previous] of before) {
    const gig = after.get(id);
    if (!gig) {
      continue;
    }
    if (addedIds.has(id)) continue;

    if (
      gig.status === "failed" &&
      ["offer", "active"].includes(previous.status)
    ) {
      transitions.push({ type: "failed", gig });
    } else if (gig.status === "done" && previous.status === "active") {
      transitions.push({ type: "completion", gig });
    } else if (gig.status === "active" && previous.status !== "active") {
      const acceptedByName = previous.status === "offer" && gig.takenBy && gig.takenBy !== previous.takenBy
        ? gig.takenBy
        : null;
      transitions.push({
        type: acceptedByName ? "acceptance" : "briefing",
        gig,
        acceptedByName,
      });
    }
  }
  return transitions;
}

function dispatchTransitions(transitions) {
  if (!liveEventsReady || !transitions.length || !game.user?.isGM) return;
  if (activeGM()) {
    for (const transition of transitions) enqueueDelivery(() => processTransition(transition));
  } else {
    game.socket.emit(SOCKET, { action: "transitions", transitions });
  }
}

function dispatchMarketAccessChanges(changes) {
  if (!changes.length || !game.user?.isGM) return;
  if (activeGM()) {
    for (const change of changes) enqueueDelivery(() => sendMarketAccessChange(change));
  } else {
    game.socket.emit(SOCKET, { action: "market-access-changes", changes });
  }
}

function collectMarketAccessChanges(before, after) {
  const changes = [];
  for (const [marketId, market] of after) {
    const previous = before.get(marketId);
    if (!previous) continue;
    const previousAccess = new Set(previous.access ?? []);
    const currentAccess = new Set(market.access ?? []);
    for (const userId of market.access ?? []) {
      if (!previousAccess.has(userId)) changes.push({ marketId, userId, granted: true });
    }
    for (const userId of previousAccess) {
      if (!currentAccess.has(userId)) changes.push({ marketId, userId, granted: false });
    }
  }
  return changes;
}

async function waitForAcceptedGig(gigId, userId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const gig = gigList().find((entry) => entry.id === gigId);
    if (gig?.status === "active") {
      return processTransition({
        type: "acceptance",
        gig: foundry.utils.deepClone(gig),
        acceptedByUserId: userId,
        acceptedByName: game.users.get(userId)?.character?.name || game.users.get(userId)?.name,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function wrapMapActions() {
  const mapUI = game.modules.get(MAP_ID)?.api?.ui;
  if (!mapUI || typeof mapUI.onClick !== "function" || mapUI.onClick[WRAPPED_HANDLER_FLAG]) return;

  const onClick = mapUI.onClick;
  const wrapped = async function (...args) {
    const before = snapshotGigs();
    const beforeMarkets = snapshotMarkets();
    const button = args[0]?.target?.closest?.("[data-act]");
    const action = button?.dataset.act;
    const marketId = button?.dataset.id;
    const requester = !game.user.isGM && game.user.character
      ? { userId: game.user.id, characterId: game.user.character.id }
      : null;
    try {
      return await onClick.apply(this, args);
    } finally {
      const after = snapshotGigs();
      lastObservedGigs = after;
      dispatchTransitions(collectTransitions(before, after, action));
      if (action === "market-grant") {
        dispatchMarketAccessChanges(collectMarketAccessChanges(beforeMarkets, snapshotMarkets()));
      } else if (action === "market-ask" && requester) {
        game.socket.emit(SOCKET, { action: "market-request", marketId, ...requester });
      }
    }
  };
  Object.defineProperty(wrapped, WRAPPED_HANDLER_FLAG, { value: true });
  mapUI.onClick = wrapped;
  if (mapUI.onClick === wrapped) {
    console.info(`${MODULE_ID} | Attached the Night City Map gig listener.`);
  } else {
    console.error(`${MODULE_ID} | Could not attach the Night City Map gig listener.`);
  }
}

Hooks.once("ready", () => {
  initialized = true;
  setTimeout(() => {
    lastObservedGigs = snapshotGigs();
    liveEventsReady = true;
  }, 5000);
  wrapMapActions();

  game.socket.on(SOCKET, (data) => {
    if (!liveEventsReady || !activeGM()) return;
    if (data?.action === "transitions") {
      for (const transition of data.transitions ?? []) {
        enqueueDelivery(() => processTransition(transition));
      }
    } else if (data?.action === "market-request") {
      enqueueDelivery(() => sendMarketRequest(data));
    } else if (data?.action === "market-access-changes") {
      for (const change of data.changes ?? []) {
        enqueueDelivery(() => sendMarketAccessChange(change));
      }
    }
  });

  game.socket.on(MAP_SOCKET, (data) => {
    if (liveEventsReady && activeGM() && data?.action === "op" && data.op === "take" && data.data?.id && data.user) {
      enqueueDelivery(() => waitForAcceptedGig(data.data.id, data.user));
    }
  });
});

setInterval(() => {
  if (initialized) wrapMapActions();
  if (!initialized || !liveEventsReady || !activeGM()) return;

  const current = snapshotGigs();
  if (!lastObservedGigs) {
    lastObservedGigs = current;
    return;
  }
  const transitions = collectTransitions(lastObservedGigs, current);
  lastObservedGigs = current;
  dispatchTransitions(transitions);
}, 1000);
