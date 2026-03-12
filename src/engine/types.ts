export interface PlayerConfig {
  id: string;
  name: string;
  type: 'ai' | 'human';
  strategyId?: string;  // AI用
  personalityDesc?: string;  // AI性格の説明
}

export interface GameState {
  players: PlayerState[];
  pointCardDeck: number[];      // 残りの得点カード
  currentPointCard: number | null;  // 今めくられた得点カード
  carryOver: number[];           // キャリーオーバー中の得点カード
  round: number;
  totalRounds: number;
  phase: 'selecting' | 'resolving' | 'finished';
  history: RoundResult[];
}

export interface PlayerState {
  config: PlayerConfig;
  hand: number[];          // 残りの手札
  score: number;           // 現在の合計得点
  wonCards: number[];       // 獲得した得点カード一覧
  selectedCard: number | null;  // このラウンドで選んだカード
}

export interface RoundResult {
  round: number;
  pointCard: number;
  carryOver: number[];      // このラウンドにキャリーオーバーされていたカード
  selections: { playerId: string; card: number }[];
  winnerId: string | null;  // null = 誰も取れなかった
  reasoning?: Record<string, string>;  // AIの思考理由（playerId → 理由テキスト）
}

export interface FinalScore {
  playerId: string;
  name: string;
  score: number;
  rank: number;
}

export interface ReplayLog {
  gameId: string;
  gameName: string;
  timestamp: string;
  players: PlayerConfig[];
  rounds: RoundResult[];
  finalScores: FinalScore[];
}

export interface AIStrategy {
  id: string;
  name: string;
  description: string;
  personality: string;  // AIの性格説明
  selectCard: (state: GameState, playerId: string) => { card: number; reasoning: string };
}
