// Bridge-specific types for bodoge_testplay Socket.io integration

export interface RemoteCardInstance {
  instanceId: string;
  definitionId: string;  // matches CSV IDs like "P01", "H01_A", hand cards like "H01"..
  x: number;
  y: number;
  zIndex: number;
  face: 'up' | 'down';
  visibility: 'hidden' | 'owner' | 'public';
  ownerId: string | null;
  stackId: string | null;
  locked: boolean;
  rotation: number;
}

export interface RemoteStack {
  stackId: string;
  x: number;
  y: number;
  zIndex: number;
  cardInstanceIds: string[];
}

export interface RemoteArea {
  areaId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visibility: string;
  bgColor?: string;
}

export interface RemoteCounter {
  counterId: string;
  name: string;
  value: number;
  min: number;
  max: number;
  x: number;
  y: number;
}

export interface RemoteGameState {
  cardInstances: Record<string, RemoteCardInstance>;
  cardStacks: Record<string, RemoteStack>;
  areas: RemoteArea[];
  counters: Record<string, RemoteCounter>;
}

export interface BridgeClientOptions {
  /** Server URL, e.g. https://bodoge-testplay-production.up.railway.app */
  url: string;
  /** Room ID to join (optional — if omitted, creates a new room) */
  roomId?: string;
  /** Player name shown in the room */
  playerName?: string;
}

export const CELL_SIZE = 10;        // 1 unit = 10 px
export const CARD_WIDTH = 88;       // mini card width in px
export const CARD_HEIGHT = 126;     // mini card height in px
export const COL_STEP = 100;        // horizontal offset for stacked cards

// Area IDs used in the game layout
export const AREA_IDS = {
  POINT_DECK: 'point_deck',
  POINT_CURRENT: 'point_current',
  // player areas are p_hand_p0 .. p_hand_p4, p_played_p0 .. etc.
} as const;

/** Offscreen discard position (far right, below the board) */
export const DISCARD_X = 9999;
export const DISCARD_Y = 9999;
