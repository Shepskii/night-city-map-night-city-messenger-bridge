const MODULE_ID = "night-city-map-night-city-messenger-bridge";
const MAP_ID = "night-city-map";
const MAP_SOCKET = `module.${MAP_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const WRAPPED_HANDLER_FLAG = "__nightCityMessengerBridge";
const FIXER_TAG = "CREWFIXER";

console.info(`${MODULE_ID} | Runtime build 0.1.3 loaded.`);

let initialized = false;
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

function snapshotGigs() {
  return new Map(gigList().filter((gig) => gig?.id).map((gig) => [
    gig.id,
    foundry.utils.deepClone(gig),
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

function fixerContact() {
  const contacts = game.nightcity?.masterContactService?.filterByTag?.(FIXER_TAG) ?? [];
  if (!contacts.length) return null;
  return contacts[Math.floor(Math.random() * contacts.length)];
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

async function sendBriefing(gig, recipientActors, acceptedBy = null) {
  if (!recipientActors.length) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this gig.`);
    return;
  }

  const fixer = fixerContact();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; gig email was not sent.`);
    return;
  }

  const prefix = acceptedBy ? `${html(acceptedBy)} accepted this gig.` : "A new gig is available.";
  const body = `<p>${prefix}</p>${await gigDetails(gig, fixer)}`;
  await sendToEach(recipientActors, (actor) => ({
    fixer,
    actor,
    subject: `${acceptedBy ? "Gig accepted" : "New gig"}: ${gig.title || "Untitled gig"}`,
    body,
  }));
}

async function sendPlayerNotice(gig, { subject, intro }) {
  const recipients = playerCharacters();
  if (!recipients.length) return;

  const fixer = fixerContact();
  if (!fixer) {
    ui.notifications.warn(`${MODULE_ID} | No Messenger contact is tagged ${FIXER_TAG}; gig email was not sent.`);
    return;
  }

  const body = `<p>${intro}</p>${await gigDetails(gig, fixer)}`;
  await sendToEach(recipients, (actor) => ({ fixer, actor, subject, body }));
}

async function sendScreamsheet(gigs) {
  const recipients = playerCharacters();
  if (!recipients.length || !gigs.length) return;

  const fixer = fixerContact();
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
  const body = `<p>Fresh work is circulating across Night City. Review the available contracts below.</p><ul>${listings.join("")}</ul>`;
  await sendToEach(recipients, (actor) => ({
    fixer,
    actor,
    subject: `Night City screamsheet: ${gigs.length} new gig${gigs.length === 1 ? "" : "s"}`,
    body,
  }));
}

async function sendCompletion(gig) {
  const recipients = playerCharacters();
  if (!recipients.length) {
    ui.notifications.warn(`${MODULE_ID} | No player characters are assigned to receive this payment.`);
    return;
  }

  const fixer = fixerContact();
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
    const body = `<p>Gig completed. ${completionNote}</p>${await gigDetails(gig, fixer)}${
      share.amount ? `<p><strong>Your attached payment:</strong> ${share.amount.toLocaleString()} eb</p>` : ""
    }`;
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
  if (!activeGM() || isRecentDuplicate(transition.type, transition.gig ?? transition.gigs?.[0])) return;
  if (transition.type === "screamsheet") return sendScreamsheet(transition.gigs);
  if (transition.type === "special") {
    return sendPlayerNotice(transition.gig, {
      subject: `Special request contract: ${transition.gig.title || "Untitled gig"}`,
      intro: "A CREWFIXER has a special job request for your crew. This contract is being offered directly to you.",
    });
  }
  if (transition.type === "failed") {
    return sendPlayerNotice(transition.gig, {
      subject: `Job failed: ${transition.gig.title || "Untitled gig"}`,
      intro: "The crew botched this job. The fixer is aware of the failure; it may damage your reputation with clients and contacts.",
    });
  }
  if (transition.type === "withdrawn") {
    return sendPlayerNotice(transition.gig, {
      subject: `Job withdrawn: ${transition.gig.title || "Untitled gig"}`,
      intro: "This contract has been withdrawn. Stand down; the job was neither completed nor recorded as a failure.",
    });
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
    return sendBriefing(transition.gig, recipients, transition.acceptedByName);
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
      if (["offer", "active"].includes(previous.status)) {
        transitions.push({ type: "withdrawn", gig: previous });
      }
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
    } else if (
      ["offer", "active"].includes(previous.status) &&
      !["active", "done", "failed"].includes(gig.status)
    ) {
      transitions.push({ type: "withdrawn", gig });
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

  for (const [id, gig] of after) {
    if (!before.has(id) && !addedIds.has(id) && gig.status === "active") {
      transitions.push({ type: "briefing", gig });
    }
  }
  return transitions;
}

function dispatchTransitions(transitions) {
  if (!transitions.length || !game.user?.isGM) return;
  if (activeGM()) {
    for (const transition of transitions) enqueueDelivery(() => processTransition(transition));
  } else {
    game.socket.emit(SOCKET, { action: "transitions", transitions });
  }
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
    const action = args[0]?.target?.closest?.("[data-act]")?.dataset.act;
    try {
      return await onClick.apply(this, args);
    } finally {
      const after = snapshotGigs();
      lastObservedGigs = after;
      dispatchTransitions(collectTransitions(before, after, action));
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
  lastObservedGigs = snapshotGigs();
  wrapMapActions();

  game.socket.on(SOCKET, (data) => {
    if (!activeGM() || data?.action !== "transitions") return;
    for (const transition of data.transitions ?? []) {
      enqueueDelivery(() => processTransition(transition));
    }
  });

  game.socket.on(MAP_SOCKET, (data) => {
    if (activeGM() && data?.action === "op" && data.op === "take" && data.data?.id && data.user) {
      enqueueDelivery(() => waitForAcceptedGig(data.data.id, data.user));
    }
  });
});

setInterval(() => {
  if (initialized) wrapMapActions();
  if (!initialized || !activeGM()) return;

  const current = snapshotGigs();
  if (!lastObservedGigs) {
    lastObservedGigs = current;
    return;
  }
  const transitions = collectTransitions(lastObservedGigs, current);
  lastObservedGigs = current;
  dispatchTransitions(transitions);
}, 1000);
