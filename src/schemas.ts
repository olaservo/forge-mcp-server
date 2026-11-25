import { z } from "zod";

/**
 * Output schemas for the bridge payloads the tools return as `structuredContent`. The bridge
 * serialises nulls, so every field is nullish, and objects are loose so a new bridge field
 * never fails validation on the MCP side.
 */
const str = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();
const strings = z.array(z.string()).nullish();

export const PaperCard = z.looseObject({
  index: num,
  name: str,
  set: str,
  collectorNumber: str,
  rarity: str,
  manaCost: str,
  type: str,
  colors: str,
  power: str,
  toughness: str,
  oracle: str,
  section: str,
});

/** A card or player a game object refers to. */
const EntityRef = z.looseObject({ type: str, id: num, name: str });

export const BoardCard = z.looseObject({
  id: num,
  name: str,
  zone: str,
  controller: str,
  tapped: bool,
  sick: bool,
  attacking: bool,
  blocking: bool,
  damage: num,
  token: bool,
  faceDown: bool,
  /** The other face of a face-down card the seat may look at, such as its own morph. Needs a bridge newer than 0.1.10. */
  faceUpName: str,
  phasedOut: bool,
  attachedTo: EntityRef.nullish(),
  type: str,
  manaCost: str,
  power: num,
  toughness: num,
  text: str,
});

export const Connection = z.looseObject({
  connected: bool,
  host: str,
  port: num,
  name: str,
  reconnectState: str,
  closeReason: str,
});

export const LobbySlot = z.looseObject({
  index: num,
  type: str,
  name: str,
  ready: bool,
  avatar: num,
  team: num,
  deckName: str,
  hasDeck: bool,
});

export const Avatars = z.looseObject({ count: num, page: num, pages: num, first: num, last: num });

export const EventView = z.looseObject({
  eventId: str,
  format: str,
  phase: str,
  product: str,
  podSize: num,
  numRounds: num,
  pickTimerSeconds: num,
  participants: z.array(z.looseObject({ name: str, type: str, seat: num, lobbySlot: num })).nullish(),
});

export const Lobby = z.looseObject({
  mySlot: num,
  limitedMode: bool,
  activeEventId: str,
  formatName: str,
  slots: z.array(LobbySlot).nullish(),
  /** The deck the seat last sent to the host. Bridge 0.1.6. */
  myDeck: z.looseObject({ name: str, mainSize: num, sideboardSize: num }).nullish(),
  event: EventView.nullish(),
});

export const Draft = z.looseObject({
  seatIndex: num,
  packNumber: num,
  pickNumber: num,
  /** Names the pack waiting for a pick, as `pack:pick`. Null when none is waiting. Bridge 0.1.11. */
  at: str,
  timerSeconds: num,
  /** Left on the pick clock. Sent while a pick is pending and the host set a clock. Bridge 0.1.6. */
  secondsLeft: num,
  pickPending: bool,
  packSize: num,
  pack: z.array(PaperCard).nullish(),
  seatQueueDepths: z.array(z.number()).nullish(),
  picks: strings,
  autoPicks: strings,
  poolReceived: bool,
  poolEventId: str,
  poolPath: str,
});

export const Pool = z.looseObject({
  poolReceived: bool,
  eventId: str,
  name: str,
  path: str,
  tags: strings,
  landSet: str,
  size: num,
  mainSize: num,
  sideboardSize: num,
  cards: z.array(PaperCard).nullish(),
});

export const PendingDecision = z.looseObject({
  id: num,
  kind: str,
  prompt: str,
  options: strings,
  min: num,
  max: num,
  default: str,
  amount: num,
});

export const Player = z.looseObject({
  id: num,
  name: str,
  life: num,
  hasPriority: bool,
  isMe: bool,
  handSize: num,
  librarySize: num,
  graveyardSize: num,
  exileSize: num,
  /** Mana floating in the pool, by colour letter. Bridge 0.1.10. */
  mana: z.record(z.string(), z.number()).nullish(),
  battlefield: z.array(BoardCard).nullish(),
  graveyard: z.array(BoardCard).nullish(),
  hand: z.array(BoardCard).nullish(),
  /** The top card of the seat's own library, while an effect lets the player look at it. Needs a bridge newer than 0.1.10. */
  libraryTop: BoardCard.nullish(),
});

/** A card, player or stack entry in a selection: `type` is `card`, `player` or `stack`. */
const Chosen = z.looseObject({ type: str, id: num, name: str });

/**
 * Where the match stands. `game` counts from 1, `wins` is games won by player name, and `over` says whether the
 * game that just ended decided the match. `sideboarding` is true after a game that did not, for a seat with
 * cards it may move between its main deck and sideboard. Bridge 0.1.11.
 */
const Match = z.looseObject({ gamesPerMatch: num, game: num, wins: z.record(z.string(), z.number()).nullish(), over: bool, sideboarding: bool });

/** A card name in a deck list, with how many copies. The sideboard's entries say what the card is. */
const Counted = z.looseObject({ count: num, name: str, manaCost: str, type: str, power: z.union([z.string(), z.number()]).nullish(), toughness: z.union([z.string(), z.number()]).nullish(), text: str });

/** `GET /game/sideboard`: the seat's decks as they stand in the match, and the limits a change has to keep. Bridge 0.1.11. */
export const Sideboard = z.looseObject({
  open: bool,
  minMain: num,
  maxSideboard: num,
  main: z.array(z.looseObject({ count: num, name: str })).nullish(),
  sideboard: z.array(Counted).nullish(),
});

export const Game = z.looseObject({
  inGame: bool,
  finished: bool,
  prompt: str,
  promptCount: num,
  waiting: bool,
  priorityPrompt: bool,
  promptCard: str,
  buttons: z.looseObject({ ok: str, okEnabled: bool, cancel: str, cancelEnabled: bool }).nullish(),
  incorrectActions: num,
  pendingDecision: PendingDecision.nullish(),
  messages: strings,
  /** Counts of the game's messages and game log lines. Bridge 0.1.10. */
  messageCount: num,
  logCount: num,
  /** The log lines there were when this game opened: the lines of earlier games of the match. Bridge 0.1.11. */
  logStart: num,
  /** Goes up each time the host opens a game for the seat: a new match, or the next game of one. Bridge 0.1.11. */
  gamesOpened: num,
  turn: num,
  phase: str,
  activePlayer: str,
  hasPriority: bool,
  autoPass: str,
  autoPassNow: bool,
  /** Where the host stops for the seat on an empty stack: `default` or `all`. Bridge 0.1.10. */
  stops: str,
  /** True when an action named a prompt count that was no longer current, and was not sent. Bridge 0.1.10. */
  stale: bool,
  /** True when a `selectCard`, `selectPlayer` or `selectStack` was sent and nothing in the game but the prompt count differs. Bridge after 0.1.10. */
  unchanged: bool,
  gameOver: bool,
  winner: str,
  match: Match.nullish(),
  me: str,
  players: z.array(Player).nullish(),
  stack: z.array(z.looseObject({ id: num, source: str, by: str, text: str, targets: strings })).nullish(),
  /** `blocked` is true once the block is final. While it is false, `blocksFinal` is true for an unblocked attacker and false while blockers are still being declared. `blocksFinal`: bridge after 0.1.10. */
  combat: z
    .array(z.looseObject({ attacker: str, attackerId: num, defender: str, blockers: strings, blocked: bool, blocksFinal: bool }))
    .nullish(),
  selection: z
    .looseObject({
      min: num,
      max: num,
      cards: z.array(BoardCard).nullish(),
      players: z.array(Chosen).nullish(),
      /** Spells and abilities on the stack that the prompt takes as a target, answered with `selectStack`. Bridge 0.1.10. */
      stack: z.array(z.looseObject({ id: num, source: str, by: str, text: str })).nullish(),
      chosen: z.array(Chosen).nullish(),
    })
    .nullish(),
  actionable: z.array(z.looseObject({ id: num, name: str })).nullish(),
});

/** What has happened since the seat's last game tool result. */
export const Since = z.looseObject({
  /** Game log lines, without phase changes and mana. The last 15, with the number of older ones in `earlier`. */
  log: strings,
  earlier: num,
  newInHand: strings,
  messages: strings,
});

/** The steps where a player gets priority and a stop can be set, by Forge's names. The untap step has none. */
export const PHASES = [
  "UPKEEP",
  "DRAW",
  "MAIN1",
  "COMBAT_BEGIN",
  "COMBAT_DECLARE_ATTACKERS",
  "COMBAT_DECLARE_BLOCKERS",
  "COMBAT_FIRST_STRIKE_DAMAGE",
  "COMBAT_DAMAGE",
  "COMBAT_END",
  "MAIN2",
  "END_OF_TURN",
  "CLEANUP",
] as const;

/** `GET /game/stops` and `POST /game/stops`: where the host asks the seat on an empty stack. Bridge 0.1.10. */
export const Stops = z.looseObject({
  /** `default`, `all` or `custom`. */
  stops: z.string(),
  own: z.array(z.string()),
  opponent: z.array(z.string()),
});

/** What forge_game_state returns: the game with rules text by card name in `cardText`, unless asked for in full. */
export const GameState = Game.extend({ cardText: z.record(z.string(), z.string()).nullish(), since: Since.nullish() });

/**
 * What forge_game_act and forge_game_decide return, and what `forge.your_move` carries: the ask, what is needed
 * to answer it, and what is new. A field is left out when it has nothing to say.
 */
export const View = z.looseObject({
  prompt: str,
  promptCount: num,
  turn: num,
  phase: str,
  activePlayer: str,
  /** Nothing is asked of the seat. */
  waiting: bool,
  /** The labels of the enabled buttons. */
  buttons: z.looseObject({ ok: str, cancel: str }).nullish(),
  /** The host flagged the action as incorrect. Forge 2.0.16 does not do this for a card click it ignores. */
  refused: bool,
  stale: bool,
  /** The click was sent and changed nothing in the game. */
  unchanged: bool,
  inGame: bool,
  gameOver: bool,
  winner: str,
  /** With `gameOver`: where the match stands. */
  match: Game.shape.match,
  /** After a game that did not end the match: the seat may change its deck with its `continue`, and the cards in its sideboard. */
  sideboarding: bool,
  sideboard: z.array(Counted).nullish(),
  life: z.record(z.string(), z.number().nullable()).nullish(),
  hand: z.array(BoardCard).nullish(),
  /** The top card of the seat's library, at a priority prompt while an effect lets the player look at it. */
  libraryTop: BoardCard.nullish(),
  /** From the top down. `id` is what `selectStack` takes. */
  stack: z.array(z.looseObject({ id: num, source: str, by: str, text: str, targets: strings })).nullish(),
  mana: z.record(z.string(), z.number()).nullish(),
  combat: Game.shape.combat,
  selection: Game.shape.selection,
  actionable: Game.shape.actionable,
  pendingDecision: PendingDecision.nullish(),
  board: z
    .array(z.looseObject({ name: str, handSize: num, librarySize: num, graveyardSize: num, battlefield: z.array(BoardCard).nullish() }))
    .nullish(),
  cardText: z.record(z.string(), z.string()).nullish(),
  since: Since.nullish(),
  /** After `quit`: the seat is back in the lobby. */
  left: bool,
  lobby: Lobby.nullish(),
});

/** `from` is null for a line from the host itself. Before forge-agent-bridge 0.1.5 a line was the text `from: text`. */
export const ChatLine = z.looseObject({ from: str, text: str });

export const Status = z.looseObject({
  revision: num,
  connection: Connection.nullish(),
  lobby: Lobby.nullish(),
  draft: Draft.nullish(),
  game: Game.nullish(),
  chat: z.array(z.union([ChatLine, z.string()])).nullish(),
  chatCount: num,
});

export const StatusWithBridge = Status.extend({
  bridge: z.looseObject({ url: str, startup: str }).nullish(),
  events: z.looseObject({ source: str, http: bool, url: str, registry: str }).nullish(),
});

/** `stale` with `at`, the pack waiting now, when the pick named another pack and was not sent. Bridge 0.1.11. */
export const PickResult = z.looseObject({ picked: PaperCard.nullish(), packNumber: num, pickNumber: num, stale: bool, at: str });
/** A card of the deck the seat set: what Forge's card scripts say of it. */
export const DeckCard = z.looseObject({ count: num, name: str, manaCost: str, type: str, pt: str, text: str });
export const DeckResult = z.looseObject({ deck: str, size: num });
/** What forge_lobby_deck returns: the bridge's answer and, from Forge's card scripts, the deck's description and main deck. */
export const DeckSet = DeckResult.extend({ description: str, cards: z.array(DeckCard).nullish() });
export const BuiltDeck = z.looseObject({ deck: str, size: num, lands: num, sideboardSize: num, path: str, problem: str });

/** Counts of the cards drafted, in a pool or in a deck: `colors` and `curve` count the spells, not the lands. */
export const DraftTally = z.looseObject({
  count: num,
  colors: z.record(z.string(), z.number()).nullish(),
  creatures: num,
  other: num,
  lands: num,
  /** Picks whose card the server never saw in a pack. */
  unknown: num,
  curve: z.record(z.string(), z.number()).nullish(),
});
/** A pack or pool card as the draft tools show it: copies of the card, and power and toughness as one field. */
const DraftCard = PaperCard.extend({ count: num, pt: str });
const CardText = z.record(z.string(), z.string()).nullish();
/**
 * What forge_draft_pack returns and `forge.your_move` carries for a pick: the pack, rules text for card names not
 * sent before in this draft, and counts of the picks. `waiting` when no pack is waiting and no pool has arrived.
 */
export const PackView = Draft.extend({
  pack: z.array(DraftCard).nullish(),
  waiting: bool,
  /** Packs waiting for the seat behind the one shown, when there are any. */
  queued: num,
  cardText: CardText,
  drafted: DraftTally.nullish(),
});
/** What forge_draft_pool returns and `forge.your_move` carries for a pool: one entry per card name, with counts. */
export const PoolView = Pool.extend({ cards: z.array(DraftCard).nullish(), cardText: CardText, counts: DraftTally.nullish() });
/** What forge_draft_pick returns: the pick, then the pack view of what the seat is asked next, with the pool once it has arrived. */
export const PickAnswer = PackView.extend({
  picked: z.looseObject({ name: str, packNumber: num, pickNumber: num }).nullish(),
  pool: PoolView.nullish(),
  /** The pick named a pack that is no longer the one waiting, and was not sent. */
  stale: bool,
  /** The bridge does not check `at` itself, so the server compared it just before sending the pick. */
  weakCheck: bool,
});
/** What forge_draft_deck returns: the bridge's answer, the seat's ready flag, and the main deck's pool cards with counts. */
export const DraftDeck = BuiltDeck.extend({ ready: bool, cards: z.array(DeckCard).nullish(), counts: DraftTally.nullish() });
export const OkResult = z.looseObject({ ok: bool });
export const LogResult = z.looseObject({ log: strings });

export const DeckSummary = z.looseObject({
  id: str,
  folder: str,
  name: str,
  main: num,
  sideboard: num,
  commander: strings,
  colors: str,
  description: str,
  tags: str,
});
export const Host = z.looseObject({
  running: z.boolean(),
  port: z.number().optional(),
  seats: z.number().optional(),
  limited: z.boolean().optional(),
  games: z.number().optional(),
  ai: z.number().optional(),
  aiSeats: z.array(z.looseObject({ slot: z.number(), name: z.string(), deck: z.string() })).optional(),
  addresses: z.array(z.string()),
});

export const Names = z.looseObject({ type: z.string(), names: z.array(z.string()), source: z.string() });

export const DeckList = z.looseObject({
  folders: z.array(z.looseObject({ folder: str, decks: num, writable: bool, about: str })).nullish(),
  total: num,
  decks: z.array(DeckSummary).nullish(),
  deck: DeckSummary.extend({
    cards: z.record(z.string(), z.array(z.looseObject({ count: num, name: str }))).nullish(),
    dck: str,
  }).nullish(),
});
export const DeckSearch = z.looseObject({
  query: z.string(),
  sites: z.array(
    z.looseObject({
      site: z.string(),
      total: num,
      results: z.array(z.looseObject({ name: z.string(), url: z.string(), format: str, colors: str, author: str, event: str, date: str, note: str })),
      note: str,
    }),
  ),
});
export const DeckSaved = DeckSummary.extend({ saved: bool, path: str, unknown: strings, notes: strings, source: str });
