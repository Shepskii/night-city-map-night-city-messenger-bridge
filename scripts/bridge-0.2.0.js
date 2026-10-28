// The ?v= queries bust the browser cache for these files on each release, like this file's versioned name.
import { messagePool, resolvePersonality } from "./messages.js?v=0.2.0";
import {
  isPerCharacterReward, parseReward, riskLevel, splitReward,
  statusTransitions, addedGigEvents, collectMarketAccessChanges, marketEligibilitySignature, planMarketAccess,
} from "./logic.js?v=0.2.0";

const MODULE_ID = "night-city-map-night-city-messenger-bridge";
const MAP_ID = "night-city-map";
const MAP_SOCKET = `module.${MAP_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const WRAPPED_HANDLER_FLAG = "__nightCityMessengerBridge";
const FIXER_TAG = "CREWFIXER";
const CREW_GROUP_SETTING = "crewGroupName";

// Register world-level state used by follow-up messages and market access.
Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Runtime build ${game.modules.get(MODULE_ID)?.version} loaded.`);
  game.settings.register(MODULE_ID, CREW_GROUP_SETTING, {
    name: "NCM_MAP_BRIDGE.CrewGroupName",
    hint: "NCM_MAP_BRIDGE.CrewGroupHint",
    scope: "world",
    config: true,
    type: String,
    default: "Crew",
  });
  for (const key of ["gigFixers", "marketAccessFixers", "marketAccessOverrides", "marketAutoAccess", "pendingCompletions"]) {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: Object,
      default: {},
    });
  }
});

let liveEventsReady = false;
let deliveryQueue = Promise.resolve();
// The map's gigs and markets as of its last save, so each save can be compared with the one before.
let lastObservedGigs = null;
let lastObservedMarkets = null;
let poiDataPromise = null;
const recentEvents = new Map();
// Gigs a player was seen taking (gig id -> user id), until the map's save shows them active.
const pendingTakes = new Map();

// Read map state and resolve the fixer associated with each message.
function activeGM() {
  return game.user?.isGM && game.user.id === game.users.activeGM?.id;
}

function gigList() {
  return game.settings.get(MAP_ID, "state")?.quests ?? [];
}

function marketList() {
  return game.settings.get(MAP_ID, "state")?.markets ?? [];
}

function snapshot(list) {
  return new Map(list.filter((entry) => entry?.id).map((entry) => [
    entry.id,
    foundry.utils.deepClone(entry),
  ]));
}

function snapshotGigs() {
  return snapshot(gigList());
}

function snapshotMarkets() {
  return snapshot(marketList());
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
  return contacts.length ? randomChoice(contacts) : null;
}

// Return a CREWFIXER contact, or warn the GM that `unsent` was not delivered.
function requireFixer(pick, unsent) {
  const fixer = pick();
  if (!fixer) ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; ${unsent} was not sent.`);
  return fixer;
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

// Set (or, when value is null, remove) settings[key][outerId][innerId], pruning empty branches.
async function updateNestedSetting(key, outerId, innerId, value) {
  const data = foundry.utils.deepClone(game.settings.get(MODULE_ID, key) ?? {});
  data[outerId] ??= {};
  if (value == null) {
    delete data[outerId][innerId];
    if (!Object.keys(data[outerId]).length) delete data[outerId];
  } else {
    data[outerId][innerId] = value;
  }
  await game.settings.set(MODULE_ID, key, data);
}

function updateMarketAccessFixer(marketId, userId, fixerId) {
  return updateNestedSetting("marketAccessFixers", marketId, userId, fixerId);
}

// Persist an explicit GM grant or revocation separately from automatic access.
function updateMarketAccessOverride(marketId, userId, granted) {
  return updateNestedSetting("marketAccessOverrides", marketId, userId, granted);
}

// Record grants managed by Reputation so only those are automatically revoked.
function updateMarketAutoAccess(marketId, userId, autoGranted) {
  return updateNestedSetting("marketAutoAccess", marketId, userId, autoGranted || null);
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

// Resolve map locations and build reusable gig details.
function html(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// Pins, shops and markets the GM created in the map's saved state.
function customLocation(id) {
  const state = game.settings.get(MAP_ID, "state") ?? {};
  return [
    ...(state.pins ?? []),
    ...(state.shops ?? []),
    ...(state.markets ?? []),
  ].find((location) => location.id === id);
}

// Built-in map POI, or null when it does not exist or the map's data cannot be loaded.
async function builtinPoi(id) {
  try {
    poiDataPromise ??= import(`/modules/${MAP_ID}/scripts/data.js`);
    const { POIS } = await poiDataPromise;
    return POIS.find((poi) => poi.id === id) ?? null;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not load map location ${id}.`, error);
    return null;
  }
}

async function poiName(id) {
  if (!id) return "—";

  const custom = customLocation(id);
  if (custom?.name) return custom.name;

  const override = game.settings.get(MAP_ID, "state")?.poi?.[id];
  if (override?.name) return override.name;

  return (await builtinPoi(id))?.name ?? id;
}

// Build data-only links for map locations embedded in Messenger email.
function mapLocationLink(id, name) {
  if (!id) return html(name);
  // A span, not an anchor: browsers and other modules' link handlers can open any <a> in a new tab.
  return `<span role="button" tabindex="0" data-ncm-map-location="${html(id)}" title="Open in Night City Map" style="cursor:pointer;text-decoration:underline;">${html(name)}</span>`;
}

// Check that a location ID still belongs to the map before navigating to it.
async function mapLocationExists(id) {
  if (!id) return false;
  return !!customLocation(id) || !!(await builtinPoi(id));
}

// Open the map and focus the validated POI referenced by an email link.
async function openMapLocation(id) {
  const mapUI = game.modules.get(MAP_ID)?.api?.ui;
  if (!mapUI || typeof mapUI.open !== "function" || typeof mapUI.select !== "function") {
    ui.notifications.warn(`${MODULE_ID} | Night City Map is unavailable.`);
    return;
  }
  if (!await mapLocationExists(id)) {
    ui.notifications.warn(`${MODULE_ID} | This map location is no longer available.`);
    return;
  }

  await mapUI.open();
  setTimeout(() => mapUI.select(id, true), 120);
}

function handleMapLocationClick(event) {
  const link = event.target?.closest?.("[data-ncm-map-location]");
  if (!link) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  openMapLocation(link.dataset.ncmMapLocation).catch((error) => {
    console.error(`${MODULE_ID} | Could not open map location from email.`, error);
  });
}

async function gigDetails(gig, fixer, { includeDescription = true } = {}) {
  const [pickup, target] = await Promise.all([
    poiName(gig.giver),
    poiName(gig.target),
  ]);
  const lines = [
    `<p><strong>Gig:</strong> ${html(gig.title || "Untitled gig")}</p>`,
    `<p><strong>Fixer:</strong> ${html(fixer.name)}</p>`,
    `<p><strong>Client:</strong> ${html(gig.client)}</p>`,
    `<p><strong>Pickup:</strong> ${mapLocationLink(gig.giver, pickup)}</p>`,
    `<p><strong>Target:</strong> ${mapLocationLink(gig.target, target)}</p>`,
    `<p><strong>Reward:</strong> ${html(gig.reward)}</p>`,
  ];
  if (includeDescription && gig.desc) lines.push(`<p><strong>Details:</strong><br>${html(gig.desc).replace(/\n/g, "<br>")}</p>`);
  return lines.join("\n");
}

function randomChoice(options) {
  return options[Math.floor(Math.random() * options.length)];
}

// Personality of the character sheet linked to a fixer contact, or null to use the standard messages.
function fixerPersonality(fixer) {
  const actor = fixer?.actorId ? game.actors.get(fixer.actorId) : null;
  return resolvePersonality(actor?.system?.lifepath?.personality);
}

// Pick a random line from the pool `key` in the fixer's voice.
function say(key, fixer) {
  return randomChoice(messagePool(key, fixerPersonality(fixer)));
}

// Banner image for gig outcome emails; NCM applies no image styling, so size it inline.
function outcomeImage(outcome) {
  const label = outcome === "failed" ? "Contract failed" : "Contract completed";
  return `<p><img src="modules/${MODULE_ID}/assets/contract-${outcome}.svg" alt="${label}" style="max-width:100%;height:auto;border:none;"></p>`;
}

// Shared body for the "Job failed" and "Contract completed" emails so both keep the same layout and fields.
async function outcomeBody(gig, fixer, { greetingKey, outcome, introKey, noteKey, signoffKey, includeDescription = false }) {
  return `<p>${say(greetingKey, fixer)}</p>${outcomeImage(outcome)}`
    + `<p>${say(introKey, fixer)}</p>${await gigDetails(gig, fixer, { includeDescription })}`
    + (noteKey ? `<p>${say(noteKey, fixer)}</p>` : "")
    + `<p>${say(signoffKey, fixer)}<br><strong>${html(fixer.name)}</strong></p>`;
}

async function gigContractBody(gig, fixer, intro, signoffKey = "gigSignoffs") {
  const introLines = Array.isArray(intro) ? intro : [intro];
  const introHtml = introLines.map((line) => `<p>${line}</p>`).join("");
  return `${introHtml}${await gigDetails(gig, fixer)}`
    + `<p>Payment will be delivered upon proof of completion</p>`
    + `<p>${say(signoffKey, fixer)}<br><strong>${html(fixer.name)}</strong></p>`;
}

function playerForCharacterName(name) {
  const matches = game.users.contents.filter((user) =>
    !user.isGM && user.character?.name === name,
  );
  return matches.length === 1 ? matches[0] : null;
}

// Send mail through Messenger; throws with `failure` if it is not delivered.
async function deliver(message, failure) {
  const service = game.nightcity?.messageService;
  if (typeof service?.sendMessage !== "function") {
    throw new Error("Night City Messenger MessageService is unavailable.");
  }

  const result = await service.sendMessage({ priority: "normal", ...message });
  if (!result?.success) throw new Error(result?.error || failure);
  return result;
}

// The GM-defined Messenger contact group named in the module settings, or null when unavailable.
function crewGroup() {
  const name = String(game.settings.get(MODULE_ID, CREW_GROUP_SETTING) ?? "").trim().toLowerCase();
  const service = game.nightcity?.contactGroupService;
  if (!name || typeof service?.getMasterGroups !== "function" || typeof service.recipientsFor !== "function") return null;
  return service.getMasterGroups().find((group) => group.name.toLowerCase() === name) ?? null;
}

// Crew group recipients for a fan-out email, excluding the sending fixer; null means "email each character".
function crewRecipients(fixer) {
  const group = crewGroup();
  if (!group) return null;

  const { recipients, unresolved } = game.nightcity.contactGroupService.recipientsFor(group);
  if (unresolved.length) {
    console.warn(`${MODULE_ID} | Crew group "${group.name}" has members that could not be resolved: ${unresolved.join(", ")}`);
  }
  const reachable = recipients.filter((recipient) =>
    recipient.contactId !== fixer.id && !(fixer.actorId && recipient.actorId === fixer.actorId));
  if (!reachable.length) {
    console.warn(`${MODULE_ID} | Crew group "${group.name}" has no reachable members; emailing characters individually.`);
    return null;
  }
  return reachable;
}

// A CREWFIXER contact emails a player character.
function sendEmail({ fixer, actor, subject, body, eddies = 0 }) {
  return deliver(
    { fromContactId: fixer.id, toActorId: actor.id, subject, body, eddies },
    `Messenger failed to deliver to ${actor.name}.`,
  );
}

async function sendMarketRequest({ marketId, userId, characterId }) {
  const user = game.users.get(userId);
  const actor = user?.character;
  const market = marketList().find((entry) => entry.id === marketId);
  if (!user || user.isGM || !actor || actor.id !== characterId || !market) return;

  const fixer = requireFixer(randomFixer, "night market request email");
  if (!fixer) return;

  await deliver({
    fromActorId: actor.id,
    toContactId: fixer.id,
    subject: `Night Market Access Request: ${market.name}`,
    body: `<p>I'd like access to the night market <strong>${mapLocationLink(market.id, market.name)}</strong>. `
      + `Could you ask <strong>${html(market.fixer || "the named fixer")}</strong> to vouch for me?</p>`
      + `<p>My Reputation is ${html(playerReputation(user))}; the market requires ${html(market.rep ?? 0)}+.</p>`,
  }, `Messenger failed to deliver the night market request from ${actor.name}.`);
}

async function sendMarketAccessChange({ marketId, userId, granted, automatic = false }) {
  const market = marketList().find((entry) => entry.id === marketId);
  const user = game.users.get(userId);
  const actor = user?.character;
  if (!market || !!market.access?.includes(userId) !== granted || !actor) return;
  if (!automatic) {
    await updateMarketAutoAccess(marketId, userId, false);
    await updateMarketAccessOverride(marketId, userId, granted);
  }
  if (isRecent(`market:${marketId}:${userId}:${granted ? "granted" : "revoked"}`)) return;

  const fixer = requireFixer(
    () => (granted ? randomFixer() : marketAccessFixer(marketId, userId) ?? randomFixer()),
    "night market access update email",
  );
  if (!fixer) return;

  const marketMessage = say(granted ? "marketGranted" : "marketRevoked", fixer)(
    html(market.fixer || "The fixer"),
    mapLocationLink(market.id, market.name),
  );
  await sendEmail({
    fixer,
    actor,
    subject: `Night Market Access ${granted ? "Granted" : "Revoked"}: ${market.name}`,
    body: granted
      ? `<p>${say("greetings", fixer)}</p>`
        + `<p>${marketMessage}</p>`
        + `<p>${say("positiveSignoffs", fixer)}<br><strong>${html(fixer.name)}</strong></p>`
      : `<p>${say("negativeGreetings", fixer)}</p>`
        + `<p>${marketMessage}</p>`
        + `<p>${say("negativeSignoffs", fixer)}<br><strong>${html(fixer.name)}</strong></p>`,
  });
  await updateMarketAccessFixer(marketId, userId, granted ? fixer.id : null);
}

// Read Reputation from the player's assigned character.
function playerReputation(user) {
  const reputation = Number(user.character?.system?.reputation?.value ?? 0);
  return Number.isFinite(reputation) ? reputation : 0;
}

// Reconcile Reputation-based access while honoring explicit GM overrides (see planMarketAccess).
// This writes the map's own state setting, as the map has no API for market access.
async function reconcileMarketAccess() {
  if (!liveEventsReady || !activeGM()) return;

  const state = foundry.utils.deepClone(game.settings.get(MAP_ID, "state") ?? {});
  const plan = planMarketAccess({
    markets: state.markets ?? [],
    players: game.users.contents.filter((user) => !user.isGM && user.character).map((user) => ({ id: user.id, rep: playerReputation(user) })),
    autoAccess: game.settings.get(MODULE_ID, "marketAutoAccess") ?? {},
    overrides: game.settings.get(MODULE_ID, "marketAccessOverrides") ?? {},
  });

  if (plan.mapChanged) await game.settings.set(MAP_ID, "state", { ...state, markets: plan.markets });
  if (plan.autoAccessChanged) await game.settings.set(MODULE_ID, "marketAutoAccess", plan.autoAccess);
  for (const change of plan.changes) {
    try {
      await sendMarketAccessChange(change);
    } catch (error) {
      console.error(`${MODULE_ID} | Could not send automatic night market access update.`, error);
    }
  }
}

async function sendToEach(recipients, buildEmail) {
  let failures = 0;
  for (const [index, actor] of recipients.entries()) {
    try {
      await sendEmail(await buildEmail(actor, index));
    } catch (error) {
      failures += 1;
      console.error(`${MODULE_ID} | Could not email ${actor.name}.`, error);
    }
  }
  if (failures) {
    ui.notifications.warn(`${MODULE_ID} | ${failures} gig email(s) failed. See the console for details.`);
  }
}

// Identical mail for the whole crew: one fan-out thread to the Crew group when configured, else one email per character.
async function sendToCrew(actors, { fixer, subject, body }) {
  const recipients = crewRecipients(fixer);
  if (!recipients) {
    return sendToEach(actors, (actor) => ({ fixer, actor, subject, body }));
  }

  try {
    const result = await deliver(
      { fromContactId: fixer.id, recipients, subject, body },
      "Messenger failed to deliver to the crew group.",
    );
    const failed = result.failed ?? [];
    if (failed.length) {
      console.error(`${MODULE_ID} | Crew email was not delivered to some members.`, failed);
      ui.notifications.warn(`${MODULE_ID} | ${failed.length} crew email(s) failed. See the console for details.`);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Could not email the crew group.`, error);
    ui.notifications.warn(`${MODULE_ID} | The crew group email failed. See the console for details.`);
  }
}

function enqueueDelivery(task) {
  deliveryQueue = deliveryQueue.then(task).catch((error) => {
    console.error(`${MODULE_ID} | Message delivery failed.`, error);
  });
  return deliveryQueue;
}

// True if the same market access email was already sent in the last two seconds.
function isRecent(key, windowMs = 2000) {
  const previous = recentEvents.get(key);
  if (previous && Date.now() - previous < windowMs) return true;
  recentEvents.set(key, Date.now());
  setTimeout(() => recentEvents.delete(key), windowMs);
  return false;
}

// Build and deliver gig briefings, notices, and completion payments.
async function sendBriefing(gig, recipientActors, accepted = false) {
  if (!recipientActors.length && (accepted || !crewGroup())) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this gig.`);
    return;
  }

  const fixer = await assignFixer(gig);
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; gig email was not sent.`);
    return;
  }

  const body = await gigContractBody(
    gig,
    fixer,
    accepted
      ? [
        say("greetings", fixer),
        say("acceptanceOpenings", fixer),
        "You have accepted the following gig contract:",
      ]
      : [
        say("greetings", fixer),
        say("openings", fixer),
        "You have been assigned the following gig contract:",
      ],
    accepted ? "acceptanceSignoffs" : undefined,
  );
  const subject = accepted
    ? `Gig contract accepted: ${gig.title || "Untitled gig"}`
    : `New gig: ${gig.title || "Untitled gig"}`;
  // Acceptance goes only to the accepting character, so it never uses the crew group.
  if (accepted) {
    await sendToEach(recipientActors, (actor) => ({ fixer, actor, subject, body }));
  } else {
    await sendToCrew(recipientActors, { fixer, subject, body });
  }
}

// `body` is a function of the fixer so its wording can follow that fixer's personality.
async function sendPlayerNotice(gig, { subject, body: buildBody }, reuseAssignment = false) {
  const recipients = playerCharacters();
  if (!recipients.length && !crewGroup()) return;

  const fixer = requireFixer(() => (reuseAssignment ? fixerForFollowup(gig) : randomFixer()), "gig email");
  if (!fixer) return;

  await sendToCrew(recipients, { fixer, subject, body: await buildBody(fixer) });
}

async function sendScreamsheet(gigs) {
  const recipients = playerCharacters();
  if ((!recipients.length && !crewGroup()) || !gigs.length) return;

  const fixer = requireFixer(randomFixer, "screamsheet");
  if (!fixer) return;

  const listings = await Promise.all(gigs.map(async (gig) => {
    const [pickup, target] = await Promise.all([poiName(gig.giver), poiName(gig.target)]);
    return `<li><strong>${html(gig.title || "Untitled gig")}</strong>`
      + `<br>Client: ${html(gig.client)}`
      + `<br>Payout: ${html(gig.reward)}`
      + `<br>Risk: ${riskLevel(gig.reward)}`
      + `<br>Pickup: ${mapLocationLink(gig.giver, pickup)} | Target: ${mapLocationLink(gig.target, target)}`
      + (gig.desc ? `<br>${html(gig.desc).replace(/\n/g, "<br>")}` : "")
      + "</li>";
  }));
  const body = `<p>${say("greetings", fixer)}</p><p>${say("screamsheetIntros", fixer)}</p><ul>${listings.join("")}</ul>`
    + `<p>${say("gigSignoffs", fixer)}<br><strong>${html(fixer.name)}</strong></p>`;
  await sendToCrew(recipients, {
    fixer,
    subject: `Night City Screamsheet: ${gigs.length} new gig${gigs.length === 1 ? "" : "s"}`,
    body,
  });
}

const COMPLETION_NOTICE_DELAY_MS = [30_000, 120_000];
const PAYMENT_DELAY_MS = [5 * 60_000, 10 * 60_000];
let processingCompletions = false;

function randomBetween([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pendingCompletions() {
  return game.settings.get(MODULE_ID, "pendingCompletions") ?? {};
}

// Set (or, when entry is null, remove) one pending completion without clobbering the rest.
async function savePendingCompletion(gigId, entry) {
  const data = foundry.utils.deepClone(pendingCompletions());
  if (entry) data[gigId] = entry;
  else delete data[gigId];
  await game.settings.set(MODULE_ID, "pendingCompletions", data);
}

// Fix the fixer, recipients and both delivery times now; the due-checker sends the emails later.
async function sendCompletion(gig) {
  if (pendingCompletions()[gig.id]) return;

  const recipients = playerCharacters();
  if (!recipients.length) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this payment.`);
    return;
  }

  const fixer = requireFixer(() => fixerForFollowup(gig), "completion email");
  if (!fixer) return;

  const noticeAt = Date.now() + randomBetween(COMPLETION_NOTICE_DELAY_MS);
  await savePendingCompletion(gig.id, {
    gig: foundry.utils.deepClone(gig),
    fixerId: fixer.id,
    actorIds: recipients.map((actor) => actor.id),
    noticeAt,
    payAt: noticeAt + randomBetween(PAYMENT_DELAY_MS),
    noticeSent: false,
  });
}

function completionFixer(entry) {
  const fixer = game.nightcity?.masterContactService?.getContact?.(entry.fixerId) ?? fixerForFollowup(entry.gig);
  if (!fixer) ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; completion email was not sent.`);
  return fixer;
}

async function sendCompletionNotice(entry, actors, fixer) {
  const { gig } = entry;
  const body = await outcomeBody(gig, fixer, {
    greetingKey: "greetings",
    outcome: "completed",
    introKey: "completionNotices",
    noteKey: "fundsPending",
    signoffKey: "completionNoticeSignoffs",
  });
  await sendToCrew(actors, { fixer, subject: `Contract completed: ${gig.title || "Untitled gig"}`, body });
}

async function sendCompletionPayment(entry, actors, fixer) {
  const { gig } = entry;
  const total = parseReward(gig.reward);
  const perCharacter = total !== null && isPerCharacterReward(String(gig.reward));
  const shares = total === null ? actors.map((actor) => ({ actor, amount: 0 }))
    : splitReward(total, actors, perCharacter);
  const paymentNote = total === null
    ? "The agreed compensation will be delivered separately."
    : perCharacter
      ? `Your payment is ${shares[0]?.amount.toLocaleString()} eb, as listed for this team gig.`
      : `The ${total.toLocaleString()} eb reward has been disbursed to the crew.`;
  const details = `<p><strong>Gig:</strong> ${html(gig.title || "Untitled gig")}</p>\n`
    + `<p><strong>Fixer:</strong> ${html(fixer.name)}</p>\n`
    + `<p><strong>Client:</strong> ${html(gig.client)}</p>`;

  await sendToEach(actors, (actor, index) => {
    const { amount } = shares[index];
    return {
      fixer,
      actor,
      subject: `Payment settled: ${gig.title || "Untitled gig"}`,
      body: `<p>${say("paymentOpenings", fixer)} ${paymentNote}</p>${details}`
        + (amount ? `<p><strong>Your attached payment:</strong> ${amount.toLocaleString()} eb</p>` : "")
        + `<p>${say("positiveSignoffs", fixer)}<br><strong>${html(fixer.name)}</strong></p>`,
      eddies: amount,
    };
  });
}

// Send whichever completion emails have come due. Each stage is recorded before sending so it can never repeat.
async function processDueCompletions() {
  if (processingCompletions || !liveEventsReady || !activeGM()) return;
  processingCompletions = true;
  try {
    for (const [gigId, entry] of Object.entries(pendingCompletions())) {
      const now = Date.now();
      const stage = !entry.noticeSent && now >= entry.noticeAt ? "notice"
        : entry.noticeSent && now >= entry.payAt ? "payment"
          : null;
      if (!stage) continue;

      await savePendingCompletion(gigId, stage === "notice" ? { ...entry, noticeSent: true } : null);
      const fixer = completionFixer(entry);
      const actors = entry.actorIds.map((id) => game.actors.get(id)).filter(Boolean);
      if (!fixer || !actors.length) continue;
      try {
        await (stage === "notice" ? sendCompletionNotice : sendCompletionPayment)(entry, actors, fixer);
      } catch (error) {
        console.error(`${MODULE_ID} | Could not send gig ${stage} email.`, error);
      }
    }
  } finally {
    processingCompletions = false;
  }
}

// Route each detected gig transition to its notification workflow.
async function processTransition(transition) {
  if (!liveEventsReady || !activeGM()) return;
  if (transition.type === "screamsheet") return sendScreamsheet(transition.gigs);
  if (transition.type === "special") {
    return sendPlayerNotice(transition.gig, {
      subject: `Special contract: ${transition.gig.title || "Untitled gig"}`,
      body: (fixer) => gigContractBody(
        transition.gig,
        fixer,
        [say("greetings", fixer), say("openings", fixer)],
        "specialSignoffs",
      ),
    });
  }
  if (transition.type === "failed") {
    return sendPlayerNotice(transition.gig, {
      subject: `Job failed: ${transition.gig.title || "Untitled gig"}`,
      body: (fixer) => outcomeBody(transition.gig, fixer, {
        greetingKey: "negativeGreetings",
        outcome: "failed",
        introKey: "failedOutcomes",
        signoffKey: "negativeSignoffs",
      }),
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

// Each kind of gig event has exactly one detector, so none is ever sent twice:
//  - status changes (handed out, accepted, completed, failed) come from the map's saves, on the active GM;
//  - which new gigs are special contracts or a screamsheet comes from the GM's click (wrapMapActions);
//  - who accepted a gig comes from the map's "take" request (recorded in pendingTakes).
function enqueueTransitions(transitions) {
  for (const transition of transitions) enqueueDelivery(() => processTransition(transition));
}

// Compare the map's state with its last save. Every GM keeps the baseline, so a new active GM
// continues where the last one left off; only the active GM acts on what changed.
function onMapStateChanged() {
  if (!game.user?.isGM) return;
  const gigs = snapshotGigs();
  const markets = snapshotMarkets();
  const beforeGigs = lastObservedGigs;
  const beforeMarkets = lastObservedMarkets;
  lastObservedGigs = gigs;
  lastObservedMarkets = markets;
  if (!liveEventsReady || !activeGM() || !beforeGigs) return;

  enqueueTransitions(statusTransitions(beforeGigs, gigs, pendingTakes));
  if (marketEligibilitySignature(beforeMarkets) !== marketEligibilitySignature(markets)) {
    enqueueDelivery(() => reconcileMarketAccess());
  }
}

// GM-only events found by a click go to the active GM.
function relayToActiveGM(action, payload, handle) {
  if (activeGM()) handle();
  else game.socket.emit(SOCKET, { action, ...payload });
}

// Observe map clicks for what only the click tells: whether new gigs were written or generated,
// which market access the GM toggled, and a player asking for a night market.
function wrapMapActions() {
  const mapUI = game.modules.get(MAP_ID)?.api?.ui;
  if (!mapUI || typeof mapUI.onClick !== "function") return false;
  if (mapUI.onClick[WRAPPED_HANDLER_FLAG]) return true;

  const onClick = mapUI.onClick;
  const wrapped = async function (...args) {
    const button = args[0]?.target?.closest?.("[data-act]");
    const action = button?.dataset.act;
    const before = game.user.isGM ? snapshotGigs() : null;
    const beforeMarkets = game.user.isGM && action === "market-grant" ? snapshotMarkets() : null;
    const requester = action === "market-ask" && !game.user.isGM && game.user.character
      ? { marketId: button?.dataset.id, userId: game.user.id, characterId: game.user.character.id }
      : null;
    try {
      return await onClick.apply(this, args);
    } finally {
      if (before && liveEventsReady) {
        const added = addedGigEvents(before, snapshotGigs(), action);
        if (added.length) relayToActiveGM("transitions", { transitions: added }, () => enqueueTransitions(added));
      }
      if (beforeMarkets && liveEventsReady) {
        const changes = collectMarketAccessChanges(beforeMarkets, snapshotMarkets());
        if (changes.length) {
          relayToActiveGM("market-access-changes", { changes }, () => {
            for (const change of changes) enqueueDelivery(() => sendMarketAccessChange(change));
          });
        }
      }
      if (requester) game.socket.emit(SOCKET, { action: "market-request", ...requester });
    }
  };
  Object.defineProperty(wrapped, WRAPPED_HANDLER_FLAG, { value: true });
  mapUI.onClick = wrapped;
  if (mapUI.onClick !== wrapped) {
    console.error(`${MODULE_ID} | Could not attach the Night City Map gig listener.`);
    return false;
  }
  console.info(`${MODULE_ID} | Attached the Night City Map gig listener.`);
  return true;
}

const COMPLETION_CHECK_MS = 5000;

Hooks.once("ready", () => {
  document.addEventListener("click", handleMapLocationClick, true);

  // The map's API may be published after this hook runs, so keep trying until the click wrapper attaches.
  if (!wrapMapActions()) {
    const retry = setInterval(() => { if (wrapMapActions()) clearInterval(retry); }, 1000);
  }

  // The baseline is taken now; changes are acted on once Foundry has settled.
  onMapStateChanged();
  setTimeout(() => {
    liveEventsReady = true;
    onMapStateChanged();
    enqueueDelivery(() => reconcileMarketAccess());
  }, 5000);

  // Every change the map makes is saved to its world setting; this fires on every client as soon as it is.
  // The very first save in a world creates the setting instead of updating it.
  const onSetting = (setting) => { if (setting?.key === `${MAP_ID}.state`) onMapStateChanged(); };
  Hooks.on("updateSetting", onSetting);
  Hooks.on("createSetting", onSetting);

  // Completion notices and payments fall due minutes apart, so a check every few seconds is enough.
  setInterval(() => {
    if (liveEventsReady && activeGM() && Object.keys(pendingCompletions()).length) enqueueDelivery(() => processDueCompletions());
  }, COMPLETION_CHECK_MS);

  Hooks.on("updateActor", (actor, changes) => {
    // Only Reputation affects market access; skip combat-time HP/ammo updates.
    if (!foundry.utils.hasProperty(changes, "system.reputation")) return;
    if (activeGM() && playerCharacters().some((userActor) => userActor.id === actor.id)) {
      enqueueDelivery(() => reconcileMarketAccess());
    }
  });

  Hooks.on("updateUser", (user) => {
    if (activeGM() && !user.isGM) enqueueDelivery(() => reconcileMarketAccess());
  });

  // Foundry passes the sending user's id as the second argument; relays that trigger emails or payments must come from the right user.
  game.socket.on(SOCKET, (data, senderId) => {
    if (!liveEventsReady || !activeGM()) return;
    const sender = game.users.get(senderId);
    if (!sender) return;
    if (data?.action === "transitions" && sender.isGM) {
      // Only new-gig events are relayed; status changes the active GM reads from the map's saves itself.
      enqueueTransitions((data.transitions ?? []).filter((t) => t?.type === "special" || t?.type === "screamsheet"));
    } else if (data?.action === "market-request" && data.userId === sender.id) {
      enqueueDelivery(() => sendMarketRequest(data));
    } else if (data?.action === "market-access-changes" && sender.isGM) {
      for (const change of data.changes ?? []) {
        enqueueDelivery(() => sendMarketAccessChange(change));
      }
    }
  });

  // A player taking a gig asks the GM through the map's socket. Note who, so the map's save that
  // follows is read as their acceptance rather than the GM handing the gig out.
  game.socket.on(MAP_SOCKET, (data, senderId) => {
    if (activeGM() && data?.action === "op" && data.op === "take" && data.data?.id && data.user === senderId) {
      const gigId = data.data.id;
      pendingTakes.set(gigId, senderId);
      setTimeout(() => { if (pendingTakes.get(gigId) === senderId) pendingTakes.delete(gigId); }, 60_000);
    }
  });
});
