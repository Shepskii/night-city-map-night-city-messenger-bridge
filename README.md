# Night City Map - Night City Messenger Bridge

Sends Night City Map gig briefings and completion payments through Night City Messenger.

## Requirements

- Foundry VTT v12
- [Night City Map](https://github.com/samroaleksej-bit/night-city-map)
- Night City Messenger
- At least one Night City Messenger GM contact tagged `CREWFIXER`

Install this folder as `Data/modules/night-city-map-night-city-messenger-bridge` and enable it with both required modules. The active GM client sends all messages.

Existing gig state is captured as a startup baseline; it does not trigger emails. Only gig changes observed after Foundry is ready generate messages.

## Behavior

- When a player accepts a gig, the accepting character receives the gig email from a `CREWFIXER` contact.
- When a GM 'hands out' a gig directly from Night City Map, every assigned player character receives the gig email.
- When a GM generates gigs for the map, players receive one combined screamsheet message for the player-visible gigs, including client, payout, and payout-based risk.
- A gig created with the map's **New** button is sent as a special request contract.
- When a gig is marked done, every assigned player character receives a completion email with an eddies attachment they can claim through Messenger.
- Failed gigs trigger a warning about botching the job and possible reputation damage. Deleted, hidden, or otherwise withdrawn player-visible gigs trigger a withdrawal notice.
- When more than one `CREWFIXER` is present, the sender is randomly selected for each message.
- Screamsheet risk bands use the listed numeric payout: up to 200 eb is Low/Light, up to 500 is Moderate/Standard, up to 1,000 is High/Hard, and higher payouts are Extreme/Deadly. Rewards without a numeric eb amount are Unrated.
- The gig's player-facing details are included; GM-only notes are not sent.
- Generated rewards marked `eb × crew` are paid at the stated amount per character. Other numeric reward amounts are treated as a team total and split evenly; any remainder is distributed one eddie at a time. Non-numeric rewards are included in the completion email without a cash attachment.

Player recipients are deduplicated by assigned character, so multiple users assigned to the same actor do not receive duplicate payments.

## Unofficial content

Pneuma's Combat Tools is unofficial content provided under the Homebrew Content Policy of R. Talsorian Games and is not approved or endorsed by RTG. This content references materials that are the property of R. Talsorian Games and its licensees.