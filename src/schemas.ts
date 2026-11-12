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
  event: EventView.nullish(),
});

export const Draft = z.looseObject({
  seatIndex: num,
  packNumber: num,
  pickNumber: num,
  timerSeconds: num,
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
  battlefield: z.array(BoardCard).nullish(),
  graveyard: z.array(BoardCard).nullish(),
  hand: z.array(BoardCard).nullish(),
});

export const Game = z.looseObject({
  inGame: bool,
  finished: bool,
  prompt: str,
  promptCard: str,
  buttons: z.looseObject({ ok: str, okEnabled: bool, cancel: str, cancelEnabled: bool }).nullish(),
  incorrectActions: num,
  pendingDecision: PendingDecision.nullish(),
  messages: strings,
  turn: num,
  phase: str,
  activePlayer: str,
  hasPriority: bool,
  autoPass: str,
  autoPassNow: bool,
  gameOver: bool,
  winner: str,
  me: str,
  players: z.array(Player).nullish(),
  stack: z.array(z.looseObject({ id: num, source: str, by: str, text: str })).nullish(),
  combat: z
    .array(z.looseObject({ attacker: str, attackerId: num, defender: str, blockers: strings }))
    .nullish(),
  selection: z.looseObject({ min: num, max: num, cards: z.array(BoardCard).nullish() }).nullish(),
});

export const Status = z.looseObject({
  revision: num,
  connection: Connection.nullish(),
  lobby: Lobby.nullish(),
  draft: Draft.nullish(),
  game: Game.nullish(),
  chat: strings,
});

export const StatusWithBridge = Status.extend({
  bridge: z.looseObject({ url: str, startup: str }).nullish(),
});

export const PickResult = z.looseObject({ picked: PaperCard.nullish(), packNumber: num, pickNumber: num });
export const DeckResult = z.looseObject({ deck: str, size: num });
export const OkResult = z.looseObject({ ok: bool });
export const LogResult = z.looseObject({ log: strings });
