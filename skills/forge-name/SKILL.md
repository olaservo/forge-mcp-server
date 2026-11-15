---
name: forge-name
description: Pick a fantasy name for a Forge seat from donjon's name generator and set it with forge_lobby_name. Use when asked to choose, generate or change a player name for the lobby, or when a persona has no fixed name and wants one that suits its character or deck.
---

# A fantasy name for the seat

A seat taken by auto-join sits in the lobby under a placeholder name such as "Agent". `forge_lobby_name` renames it while the seat is in the lobby. This skill is for when you want a generated name. If your persona or the other player already gave you a name, use that and skip this.

## Getting names

donjon's name generator answers a plain HTTP GET with one name per line. No key.

```
https://donjon.bin.sh/name/rpc-name.fcgi?type=Elvish+Female&n=5
```

`type` is the kind of name, with `+` for spaces. `n` is how many. Ask for five and choose one. Fetch it with whatever your client gives you: a web fetch tool, or `curl` in a shell. This server has no tool for it.

Types that answered on 2026-11-14:

| Kind | `type` values |
|---|---|
| Peoples, each with `Male` and `Female` | `Human`, `Elvish`, `Dwarvish`, `Halfling`, `Draconic`, `Drow`, `Orcish` |
| Old-world styles, each with `Male` and `Female` | `Norse`, `Celtic`, `Greek`, `Roman`, `Egyptian`, `Saxon` and the others listed at https://donjon.bin.sh/fantasy/name/ |
| Single words | `Wizard`, `Celestial`, `Fiendish`, `Air Elemental`, `Earth Elemental`, `Fire Elemental`, `Water Elemental` |
| Longer titles | `Party` (an adventuring band), `Ship`, `Inn`, `Deity` |

An unknown `type` returns empty lines, not an error. If you get nothing back, try a type from the table.

## Choosing

- Match the type to your character or your deck: `Draconic` for a dragon deck, `Elvish` for green elves, `Fire Elemental` for burn, `Wizard` for a spell deck.
- Take a name that reads well in a chat line. Skip ones that are hard to say or that match another seat's name.
- `forge_lobby_name` takes up to 40 characters. `Party`, `Ship`, `Inn` and `Deity` results can run longer; shorten or pick another.
- You may add a short title of your own, such as "Thilorfin the Patient", when it suits the persona.

## Setting it

1. `forge_lobby_name` with the name. Do it in the lobby, before the game starts.
2. Say who you are in one `forge_chat` line, so the other player knows which seat changed.

## When the generator does not answer

donjon is someone else's free site and may be slow or down. Make one request per naming, and do not retry in a loop. If it fails, or you have no way to fetch a URL, make up a name in the same spirit and carry on. Send the site nothing except the `type` and `n`.
