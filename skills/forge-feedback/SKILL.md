---
name: forge-feedback
description: Report a problem with the Forge MCP server, the agent bridge or these skills as a GitHub issue on olaservo/forge-mcp-server, filed under the user's own GitHub account with the gh CLI or a GitHub MCP server. Use when a forge_* tool fails in a way you cannot work around, answers something that contradicts its description or the game, or a skill sends you the wrong way, or when the user asks you to send feedback about the server.
---

# Feedback to the maintainers

Issues go to https://github.com/olaservo/forge-mcp-server. The server never posts anything itself. You file the issue with the user's own GitHub access, so it carries their name and their client asks before it is sent.

## When to report

- A tool returns an error you cannot get past by changing the arguments or waiting.
- A tool's answer contradicts its description, the game state, or the rules as Forge plays them.
- A skill tells you to do something that does not work.
- The user asks you to send feedback.

Report once per problem, not once per failed call. Finish the game or draft first unless the problem stops it. Ask the user before filing unless they already asked you to.

## Writing it

Title: `[agent feedback] ` and one line naming the problem, for example `[agent feedback] forge_draft_pick reports a pick that the pack does not show`.

Body, with every heading kept and "Not known" where you have nothing:

```markdown
Filed by an agent with the forge-feedback skill.

**Kind:** bug | tool | docs | idea
**Tool or skill:** forge_game_act

## What happened

What you did and what came back, with the error text or the relevant part of the answer.

## Expected

What you expected instead, and why: the tool description, the skill, or the card's rules text.

## Steps

The calls that led to it, in order, with their arguments. List only the calls you made; if you know just the one that failed, say so.

## Environment

- forge-mcp-server version: from the server's name and version at initialize, if your client shows it
- Client and model: your client's name and your model
- Game phase: lobby, draft or match, with the format
```

Write only what you saw or were told, and "Not known" for the rest. Kinds: `bug` is wrong behaviour, `tool` is a tool whose arguments or answer are hard to use, `docs` is a description or skill that is wrong or missing, `idea` is something to add.

The issue is public. Leave out player names other than your own seat's, chat lines, deck files the user did not ask to share, file paths with a user name in them, and anything personal. Write `@` names only in backticks, so no one is notified.

## Filing it

Search first, on the tool name and a few words of the error, and add a comment to an open issue that already covers the problem instead of opening another. Write the body to a file in a temporary folder for `--body-file`.

With the gh CLI:

```
gh issue list --repo olaservo/forge-mcp-server --state open --search "<tool name> <words from the error>"
gh issue create --repo olaservo/forge-mcp-server --title "<title>" --body-file <file holding the body>
```

With a GitHub MCP server: its issue search, then its issue-creating tool (`issue_write` with method `create` in GitHub's own server) with owner `olaservo`, repo `forge-mcp-server`, the title and the body.

With neither, give the user this link with the title filled in, and the body to paste:

```
https://github.com/olaservo/forge-mcp-server/issues/new?title=<title, URL-encoded>
```

Tell the user the issue's URL once it is filed.
