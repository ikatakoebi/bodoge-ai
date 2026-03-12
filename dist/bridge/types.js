// Bridge-specific types for bodoge_testplay Socket.io integration
export const CELL_SIZE = 10; // 1 unit = 10 px
export const CARD_WIDTH = 88; // mini card width in px
export const CARD_HEIGHT = 126; // mini card height in px
export const COL_STEP = 100; // horizontal offset for stacked cards
// Area IDs used in the game layout
export const AREA_IDS = {
    POINT_DECK: 'point_deck',
    POINT_CURRENT: 'point_current',
    // player areas are p_hand_p0 .. p_hand_p4, p_played_p0 .. etc.
};
/** Offscreen discard position (far right, below the board) */
export const DISCARD_X = 9999;
export const DISCARD_Y = 9999;
