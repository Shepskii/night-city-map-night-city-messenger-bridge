# Night City Map - Night City Messenger Bridge (NCM-NCM Bridge)

Sends Night City Map gig briefings, outcomes, completion payments and night market access messages to players through Night City Messenger.

## Requirements

- Foundry VTT v12
- Cyberpunk RED Core
- [Night City Map](https://github.com/samroaleksej-bit/night-city-map)
- [Night City Messenger](https://github.com/christinophrappuccino/night-city-messenger)
- At least one Night City Messenger GM contact tagged `CREWFIXER`

## Installation

Unzip the release folder to the `Data\Modules` folder in your Foundry instance - `Data/modules/night-city-map-night-city-messenger-bridge`. Enable the module . 

Or install through Foundry with the manifest: https://github.com/Shepskii/night-city-map-night-city-messenger-bridge/releases/latest/download/module.json

While loaded in your World, enable Night City Map - Night City Messenger Bridge in the Module Management.

## Features
The NCM to NCM Bridge monitors gig and night market events in Night City Map and generates automated messages to players through Night City Messenger for Gigs and Night Markets:
- New randomly generated gigs (screamsheet)
- GM created gigs (special contract)
- Assigned or accepted gigs
- Completion and failure
- Reward payouts (with currency attached)
- Night Market access granted or revoked by GM
- Automated Night Market access via player reputation
- Messages include location links to map pins on Night City Map
- The active GM client sends all messages.

### The Fixer Contact(s)
- Designate one or more contacts to be used as senders by applying the `CREWFIXER` tag to the GM contact in Night City Messenger
- Fixer voice follows the personality on the fixer's linked character sheet. If a `CREWFIXER` contact is linked to an actor, its `Lifepath > Personality` determines which of ten voices (Shy, Rebellious, Arrogant, Moody, Picky, Stable, Silly, Sneaky, Intellectual, Friendly) are used for greetings, sign-offs, gig notices, completion and payment emails, and night market messages. Contacts with no linked actor, no personality, or an unrecognised personality use a generic fallback voice. Edit `PERSONALITY_POOLS` in `scripts/messages.js` to change a voice; any pool a voice leaves out falls back to the generic one.
- When more than one `CREWFIXER` is present, the sender is randomly selected for each special contract, failed-job notice for an unassigned gig, and screamsheet.
- A gig's `CREWFIXER` is saved when a player accepts it or the GM hands it out, and is reused for that gig's acceptance, completion, payment and failure emails to maintain consistency.
- **Crew contact group (optional).** Create a Night City Messenger GM contact group (Admin Panel > Contacts) holding the player characters, then enter its name in the module setting **Crew contact group** (default `Crew`, not case-sensitive). Notices that go to the whole crew - GM-assigned gig briefings, special contracts, failed jobs, screamsheets and "Contract completed" emails - are then sent once from the `CREWFIXER` to that group as a single thread, so players can Reply All to the crew. Members must be resolvable by Messenger; any that are not are listed in the console. The sending fixer is skipped if it is in the group. Acceptance emails, "Payment settled" emails and night market emails always go to individual characters. If the setting is blank, no matching group exists, or the group has no reachable members, every assigned player character is emailed individually.

### Gigs
- Existing gig state is captured as a startup baseline; only gig changes observed after Foundry is ready generate messages.
- When a player accepts a gig, the accepting character receives the gig email from a Fixer contact, designated with the `CREWFIXER` tag in NC Messenger .
- When a GM 'hands out' a gig directly from Night City Map, every assigned player character receives the gig email from a `CREWFIXER`, and that fixer is saved for the gig.
- When a GM generates gigs for the map, players receive one combined screamsheet message for the player-visible gigs, including client, payout, and payout-based risk.
- A gig created manually by the GM via Night City Map's Gig menu **New** button is sent as a special request contract. Screamsheets use a randomly selected fixer and do not bind fixers to their gigs.
- When a gig is marked complete, every assigned player character receives a positive reponse 30–120 seconds later, noting that payment will be settled once the client's funds clear. A separate "Payment settled" email with the claimable eddies attachment follows 5–10 minutes after that. Both come from the gig's `CREWFIXER`.
- Pending completions are saved in world settings and resume after a reload. Only the active GM client sends them, and each email is sent at most once, so a payment interrupted mid-send is not repeated.
- Failed gigs trigger a negative response from the gigs `CREWFIXER`.
- The "Contract completed" and "Job failed" emails each carry a banner image from `assets/` (`contract-completed.svg`, `contract-failed.svg`); replace those files to change the artwork. Deleted, hidden, or otherwise withdrawn gigs do not generate email.
- Screamsheet risk bands use the listed numeric payout: up to 200 eb is Low/Light, up to 500 is Moderate/Standard, up to 1,000 is High/Hard, and higher payouts are Extreme/Deadly. Rewards without a numeric eb amount are Unrated.
- The gig's player-facing details are included (gig, fixer, client, pickup, target, reward and description); GM-only notes are not sent. "Job failed" and "Contract completed" emails leave out the description.
- Generated rewards marked `eb × crew` (`eb × команда` in the map's Russian locale) are paid at the stated amount per character. Other numeric reward amounts are treated as a team total and split evenly; any remainder is distributed one eddie at a time. Non-numeric rewards are included in the completion email without a cash attachment.
- "Payment settled" emails go to each assigned player character individually, not to the crew group, because each carries its own eddies attachment.
- Socket relays are accepted only from the expected sender: GM-originated gig and market-access events from a GM, market requests from the requesting player, and gig acceptances from the accepting player.
- Player recipients are deduplicated by assigned character, so multiple users assigned to the same actor do not receive duplicate payments.

### Night Markets
- When a player requests a Night Market invitation, their character emails a randomly selected `CREWFIXER` contact asking for access through the market's named fixer.
- If player reputation changes above or below a Night Market requirement, a randomly selected `CREWFIXER` will automatically arrange or revoke access and message the player.
- When the GM manually grants or revokes a player's Night Market access, the player receives an email from a randomly selected `CREWFIXER` contact confirming the change.
- Access granted or revoked by the GM overrides any automatic access granted or revoked by a players reputation changing.

## Unofficial Content

Night City Map - Night City Messenger Bridge is unofficial content provided under the Homebrew Content Policy of R. Talsorian Games and is not approved or endorsed by RTG. This content references materials that are the property of R. Talsorian Games and its licensees.