// Modern Art ゲーム型定義

import type { PlayerConfig } from './types.js';

// ── 基本型 ──

export type ArtistName = 'Lite Metal' | 'Yoko' | 'Christin P' | 'Karl Gitter' | 'Krypto';
export type AuctionType = 'open' | 'once_around' | 'sealed' | 'fixed_price' | 'double';

export const ARTIST_NAMES: ArtistName[] = ['Lite Metal', 'Yoko', 'Christin P', 'Karl Gitter', 'Krypto'];
export const AUCTION_TYPES: AuctionType[] = ['open', 'once_around', 'sealed', 'fixed_price', 'double'];

// ── カード ──

export interface ModernArtCard {
  id: string;              // MA01, MA02, ...
  artist: ArtistName;
  auctionType: AuctionType;
}

// ── プレイヤー ──

export interface ModernArtPlayerState {
  config: PlayerConfig;
  money: number;
  hand: ModernArtCard[];
  paintings: ModernArtCard[];  // 購入した絵画（ラウンドごとにリセットしない、得点計算用）
}

// ── オークション ──

export interface AuctionState {
  card: ModernArtCard;
  doubleCard?: ModernArtCard;     // ダブルオークション時の2枚目
  sellerId: string;
  auctionType: AuctionType;       // 実際のオークション種別（doubleの場合は2枚目の種別）
  // 公開競り
  currentBid: number;
  currentBidderId: string | null;
  biddingPlayerIndex: number;
  passedPlayerIds: string[];
  // 一巡競り
  onceAroundBids: Record<string, number>;  // playerId -> bid (未入札は未登録)
  // 密封入札
  sealedBids: Record<string, number>;
  // 固定価格
  fixedPrice: number;
  fixedAskPlayerIndex: number;
  fixedResolved: boolean;
}

// ── ラウンド結果 ──

export interface RoundResult {
  round: number;
  cardCounts: Record<ArtistName, number>;
  ranking: ArtistName[];   // 上位3名（1位, 2位, 3位）
  values: Record<ArtistName, number>;  // このラウンドの価値（30/20/10/0/0）
}

// ── ゲーム状態 ──

export interface ModernArtGameState {
  players: ModernArtPlayerState[];
  deck: ModernArtCard[];
  round: number;                   // 1-4
  currentPlayerIndex: number;
  startPlayerIndex: number;
  phase: 'play_card' | 'choose_double_pair' | 'auction' | 'set_fixed_price' | 'round_scoring' | 'finished';
  auctionState: AuctionState | null;
  artistValues: Record<ArtistName, number>;  // 累積価値
  roundResults: RoundResult[];
  playedCardsThisRound: Record<ArtistName, number>;
  lastEvents: string[];
}

// ── アクション ──

export type ModernArtAction =
  | { type: 'play_card'; playerId: string; cardId: string }
  | { type: 'play_double'; playerId: string; cardId: string; pairCardId: string }
  | { type: 'bid'; playerId: string; amount: number }
  | { type: 'pass_bid'; playerId: string }
  | { type: 'set_fixed_price'; playerId: string; price: number }
  | { type: 'accept_fixed_price'; playerId: string }
  | { type: 'decline_fixed_price'; playerId: string }
  | { type: 'submit_sealed_bid'; playerId: string; amount: number };

// ── 選択肢（UI表示用） ──

export interface ModernArtActionChoice {
  index: number;
  description: string;
  category: 'play_card' | 'bid' | 'pass' | 'fixed_price' | 'accept' | 'decline';
  action: ModernArtAction;
}

// ── AI戦略 ──

export interface ModernArtAIStrategy {
  id: string;
  name: string;
  description: string;
  personality: string;
  selectCardToPlay: (state: ModernArtGameState, playerId: string) => { action: ModernArtAction; reasoning: string };
  selectBid: (state: ModernArtGameState, playerId: string) => { action: ModernArtAction; reasoning: string };
}

// ── 最終スコア ──

export interface ModernArtFinalScore {
  playerId: string;
  name: string;
  money: number;
  paintingValue: number;
  rank: number;
}

// ── UI用情報 ──

export interface ModernArtPlayerInfo {
  id: string;
  name: string;
  isHuman: boolean;
  money: number;
  handCount: number;
  paintingCounts: Record<ArtistName, number>;
}

export interface ModernArtGameInfo {
  round: number;
  phase: ModernArtGameState['phase'];
  currentPlayerId: string;
  currentPlayerName: string;
  isHumanTurn: boolean;
  players: ModernArtPlayerInfo[];
  humanPlayerId: string;
  humanPlayerIds: string[];
  artistValues: Record<ArtistName, number>;
  playedCardsThisRound: Record<ArtistName, number>;
  roundResults: RoundResult[];
  auctionState: {
    artist: ArtistName;
    auctionType: AuctionType;
    sellerName: string;
    sellerId: string;
    currentBid: number;
    currentBidderName: string | null;
    isDouble: boolean;
    fixedPrice: number;
    waitingForPlayerId: string | null;
    waitingForPlayerName: string | null;
  } | null;
  // 自分の手札（人間プレイヤー用）
  myHand: ModernArtCard[];
  availableActions: ModernArtActionChoice[];
  needsBidInput: boolean;       // 金額入力が必要か
  minBid: number;
  maxBid: number;
  log: string[];
  gameOver: boolean;
  finalScores: ModernArtFinalScore[] | null;
}
