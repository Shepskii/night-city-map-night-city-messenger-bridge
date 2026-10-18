# Night City Map - Night City Messenger Bridge

Sends Night City Map gig briefings and completion payments through Night City Messenger.

## Requirements

- Foundry VTT v12
- Cyberpunk RED Core
- [Night City Map](https://github.com/samroaleksej-bit/night-city-map)
- Night City Messenger
- At least one Night City Messenger GM contact tagged `CREWFIXER`

## Installation

Install this folder as `Data/modules/night-city-map-night-city-messenger-bridge` and enable it with both required modules. 

## Features

- Existing gig state is captured as a startup baseline; only gig changes observed after Foundry is ready generate messages.
- When a player accepts a gig, the accepting character receives the gig email from a `CREWFIXER` contact.
- When more than one `CREWFIXER` is present, the sender is randomly selected for each pre-acceptance notice and screamsheet.
- When a GM 'hands out' a gig directly from Night City Map, every assigned player character receives the gig email.
- When a GM generates gigs for the map, players receive one combined screamsheet message for the player-visible gigs, including client, payout, and payout-based risk.
- A gig created manually by the GM via Night City Map's Gig menu **New** button is sent as a special request contract.
- When a player accepts a gig, its chosen `CREWFIXER` is saved and reused for that gig's completion or failure email. Before acceptance, notices use a randomly selected fixer; screamsheets remain randomly assigned and do not bind fixers to their gigs.
- When a gig is marked done, every assigned player character receives a completion email with an eddies attachment they can claim through Messenger.
- Failed gigs trigger a warning about botching the job and possible reputation damage. Deleted, hidden, or otherwise withdrawn gigs do not generate email.
- Screamsheet risk bands use the listed numeric payout: up to 200 eb is Low/Light, up to 500 is Moderate/Standard, up to 1,000 is High/Hard, and higher payouts are Extreme/Deadly. Rewards without a numeric eb amount are Unrated.
- The gig's player-facing details are included; GM-only notes are not sent.
- Generated rewards marked `eb × crew` are paid at the stated amount per character. Other numeric reward amounts are treated as a team total and split evenly; any remainder is distributed one eddie at a time. Non-numeric rewards are included in the completion email without a cash attachment.
- Player recipients are deduplicated by assigned character, so multiple users assigned to the same actor do not receive duplicate payments.

The active GM client sends all messages.

## Unofficial Content

Night City Map - Night City Messenger Bridge is unofficial content provided under the Homebrew Content Policy of R. Talsorian Games and is not approved or endorsed by RTG. This content references materials that are the property of R. Talsorian Games and its licensees.