// 魔女ゲー 型定義

import type { PlayerConfig } from './types.js';

// ── カードデータ（CSV由来） ──

export interface MajoToolCard {
  id: string;         // M1, M2, ...
  name: string;       // 魔剣, 杖, etc.
  type: '魔剣' | '杖' | '魔導書' | '水晶玉' | '護符';
  cost: number;       // マナコスト
  magicPower: number; // 魔力値
  effect: string;     // カードテキスト
  sealed: boolean;    // 封：trueならラウンド終了時にマナを生まない
}

export interface MajoSaintCard {
  id: string;         // M71, M72, ...
  name: string;       // セラフィム, ガブリエル, etc.
  hp: number;         // 体力
  manaReward: number; // 撃破時マナ報酬
  victoryPoints: number; // 勝利点（星）
  relicDraw: number;  // 撃破時に引ける聖遺物の数
}

export interface MajoRelicCard {
  id: string;         // M41, M42, ...
  effect: string;     // カードテキスト
  timing: 'combat' | 'turn' | 'passive'; // 使用タイミング
  isDisposable: boolean; // 廃棄（使い切り）かどうか
}

export interface MajoAchievementCard {
  id: string;
  name: string;
  condition: string;
  victoryPoints: number;
  holderId?: string;  // 現在の保持者プレイヤーID（未達成ならundefined）
}

// ── フィールドアクション ──

export type FieldActionId = 'research' | 'violence' | 'magic_shop' | 'cathedral' | 'sacrifice' | 'prayer';

export interface FieldAction {
  id: FieldActionId;
  name: string;
  maxSlots: number;      // 枠数（-1 = 無制限）
  cost: number | 'variable'; // マナコスト（variableは研究用）
  usedSlots: number;     // 現在使用済み枠数
}

// ── プレイヤーステート ──

export interface MajoPlayerState {
  config: PlayerConfig;
  mana: number;               // アンタップ状態のマナ（支払いに使える）
  tappedMana: number;         // タップ状態のマナ（ラウンド中に獲得したもの、支払い不可）
  magicTools: MajoToolCard[];
  tappedToolIds: string[];    // タップ済みの魔導具ID
  saints: MajoSaintCard[];
  relics: MajoRelicCard[];
  witchTapped: boolean;       // 魔女使用済み（ゲーム中1回）
  witchMode?: 'magic' | 'mana'; // 魔女の使用モード（魔力 or マナ）
  familiarTapped: boolean;    // 使い魔使用済み（ゲーム中1回）
  victoryPoints: number;
  lastPassiveVP: number;      // 前回計算時のパッシブ聖遺物VP（差分管理用）
  passed: boolean;            // 現在のパスサイクルでパスしたか
}

// ── 戦闘中間状態 ──

export interface MajoCombatState {
  playerId: string;
  fieldId: 'violence' | 'sacrifice';
  saintId: string;
  selectedToolIds: string[];
  useFamiliar: boolean;
  activatedAmuletIds: string[];  // 戦闘効果を発動した護符ID（選択式）
}

// ── ゲームステート ──

export interface MajoGameState {
  players: MajoPlayerState[];

  // サプライ
  toolSupply: MajoToolCard[];     // 魔導具展示（3枚）
  toolDeck: MajoToolCard[];       // 魔導具デッキ（裏向き）
  saintSupply: MajoSaintCard[];   // 聖者展示（3枚）
  saintDeck: MajoSaintCard[];     // 聖者デッキ（裏向き）
  relicDeck: MajoRelicCard[];     // 聖遺物デッキ（山札から直接引く）
  achievements: MajoAchievementCard[];

  // フィールド
  fieldActions: FieldAction[];

  // ゲーム進行
  round: number;
  currentPlayerIndex: number;
  startPlayerIndex: number;
  consecutivePasses: number;      // 連続パス数（全員パスでラウンド終了）
  phase: 'action' | 'finished';

  // ログ
  history: MajoAction[];

  // アクション後のイベントメッセージ（補充・聖遺物獲得など）
  lastEvents: string[];

  // M64聖遺物：この手番中マナ支払い分を還元するプレイヤーID（undefinedなら無効）
  manaRefundPlayerId?: string;
  // M67聖遺物：追加戦闘可能フラグ（combatで消費、次のviolence/sacrificeをコスト0で追加実行可能）
  extraCombatPlayerId?: string;
  // 戦闘マルチステップ：聖者選択→魔道具追加→実行 の途中状態
  combatState?: MajoCombatState;
}

// ── アクション ──

export type MajoAction =
  | { type: 'pass'; playerId: string }
  | { type: 'field_action'; playerId: string; fieldId: FieldActionId; details: FieldActionDetails }
  | { type: 'use_witch'; playerId: string; choice: 'magic' | 'mana' }
  | { type: 'use_familiar'; playerId: string; fieldId: FieldActionId; details: FieldActionDetails }
  | { type: 'use_relic'; playerId: string; relicId: string }
  | { type: 'extra_combat'; playerId: string; saintId: string; tappedToolIds: string[]; combatRelicIds?: string[] }
  | { type: 'round_end' }
  | { type: 'game_end' }
  | { type: 'combat_select_saint'; playerId: string; fieldId: 'violence' | 'sacrifice'; saintId: string; useFamiliar: boolean }
  | { type: 'combat_add_tool'; playerId: string; toolId: string }
  | { type: 'combat_activate_amulet'; playerId: string; toolId: string }
  | { type: 'combat_execute'; playerId: string; combatRelicIds?: string[] }
  | { type: 'combat_retreat'; playerId: string }
  | { type: 'use_tool_turn'; playerId: string; toolId: string }
  | { type: 'select_saint_discard'; playerId: string; relicId: string; saintId: string }
  | { type: 'untap_tool'; playerId: string; toolId: string }
  | { type: 'select_free_tool'; playerId: string; relicId: string; toolId: string };

export type FieldActionDetails =
  | { action: 'research'; toolId: string; discountToolIds?: string[] } // 研究：買う魔導具のID + 割引用タップする魔導具
  | { action: 'violence'; saintId: string; tappedToolIds: string[]; combatRelicIds?: string[] } // 横暴：戦う聖者＋タップする魔導具＋戦闘聖遺物
  | { action: 'magic_shop' }                          // 魔具店：マナ2個
  | { action: 'cathedral' }                           // 大聖堂：SPトークン＋マナ1
  | { action: 'sacrifice'; saintId: string; tappedToolIds: string[]; combatRelicIds?: string[] } // 生贄：聖者と戦う＋戦闘聖遺物
  | { action: 'prayer'; relicId: string };            // 祈祷：聖遺物捨ててマナ3

// ── AI戦略 ──

export interface MajoAIStrategy {
  id: string;
  name: string;
  description: string;
  personality: string;
  selectAction: (state: MajoGameState, playerId: string) => { action: MajoAction; reasoning: string };
}

// ── 最終スコア ──

export interface MajoFinalScore {
  playerId: string;
  name: string;
  victoryPoints: number;
  saints: number;
  tools: number;
  relics: number;
  rank: number;
}
