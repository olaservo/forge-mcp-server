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
});

/** A card or player in a selection: `type` is `card` or `player`. */
const Chosen = z.looseObject({ type: str, id: num, name: str });

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
  gameOver: bool,
  winner: str,
  me: str,
  players: z.array(Player).nullish(),
  stack: z.array(z.looseObject({ id: num, source: str, by: str, text: str, targets: strings })).nullish(),
  combat: z
    .array(z.looseObject({ attacker: str, attackerId: num, defender: str, blockers: strings, blocked: bool }))
    .nullish(),
  selection: z
    .looseObject({ min: num, max: num, cards: z.array(BoardCard).nullish(), players: z.array(Chosen).nullish(), chosen: z.array(Chosen).nullish() })
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
  /** The host refused the action. */
  refused: bool,
  stale: bool,
  inGame: bool,
  gameOver: bool,
  winner: str,
  life: z.record(z.string(), z.number().nullable()).nullish(),
  hand: z.array(BoardCard).nullish(),
  stack: z.array(z.looseObject({ source: str, by: str, text: str, targets: strings })).nullish(),
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

export const PickResult = z.looseObject({ picked: PaperCard.nullish(), packNumber: num, pickNumber: num });
/** A card of the deck the seat set: what Forge's card scripts say of it. */
export const DeckCard = z.looseObject({ count: num, name: str, manaCost: str, type: str, pt: str, text: str });
export const DeckResult = z.looseObject({ deck: str, size: num });
/** What forge_lobby_deck returns: the bridge's answer and, from Forge's card scripts, the deck's description and main deck. */
export const DeckSet = DeckResult.extend({ description: str, cards: z.array(DeckCard).nullish() });
export const BuiltDeck = z.looseObject({ deck: str, size: num, lands: num, sideboardSize: num, path: str, problem: str });
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
export const Host = z.looseObject({ running: z.boolean(), port: z.number().optional(), seats: z.number().optional(), limited: z.boolean().optional(), addresses: z.array(z.string()) });

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
