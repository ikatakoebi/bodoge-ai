// Modern Art ゲームエンジン

import type { PlayerConfig } from './types.js';
import type {
  ModernArtGameState, ModernArtCard, ModernArtAction,
  ModernArtPlayerState, ModernArtFinalScore, AuctionState,
  ArtistName, AuctionType, RoundResult,
} from './modern-art-types.js';
import { ARTIST_NAMES } from './modern-art-types.js';
import { loadModernArtGameData } from './modern-art-card-loader.js';
import type { ModernArtConfig, ModernArtDeal, ModernArtValues } from './modern-art-card-loader.js';

// スプシから読み込んだデータ（createModernArtGameで設定）
let gameConfig: ModernArtConfig | null = null;
let gameDeal: ModernArtDeal | null = null;
let gameValues: ModernArtValues | null = null;

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function emptyArtistRecord(): Record<ArtistName, number> {
  return { 'Lite Metal': 0, 'Yoko': 0, 'Christin P': 0, 'Karl Gitter': 0, 'Krypto': 0 };
}

// ── 初期化 ──

export async function createModernArtGame(players: PlayerConfig[]): Promise<ModernArtGameState> {
  // スプレッドシートから全データを読み込み
  const data = await loadModernArtGameData();
  gameConfig = data.config;
  gameDeal = data.deal;
  gameValues = data.values;

  const n = players.length;
  if (n < gameConfig.playerMin || n > gameConfig.playerMax) {
    throw new Error(`プレイヤー数は${gameConfig.playerMin}〜${gameConfig.playerMax}人`);
  }

  const deck = shuffle([...data.cards]);
  const dealRounds = gameDeal[n];
  if (!dealRounds) throw new Error(`${n}人用の配布データがスプシにない`);
  const dealCount = dealRounds[0];

  const playerStates: ModernArtPlayerState[] = players.map((config) => ({
    config,
    money: gameConfig!.initialMoney,
    hand: [],
    paintings: [],
  }));

  // 初期手札配布
  for (let i = 0; i < dealCount; i++) {
    for (const p of playerStates) {
      if (deck.length > 0) p.hand.push(deck.pop()!);
    }
  }

  return {
    players: playerStates,
    deck,
    round: 1,
    currentPlayerIndex: 0,
    startPlayerIndex: 0,
    phase: 'play_card',
    auctionState: null,
    artistValues: emptyArtistRecord(),
    roundResults: [],
    playedCardsThisRound: emptyArtistRecord(),
    lastEvents: [],
  };
}

// ── ユーティリティ ──

export function getCurrentPlayer(state: ModernArtGameState): ModernArtPlayerState {
  return state.players[state.currentPlayerIndex];
}

export function getPlayer(state: ModernArtGameState, playerId: string): ModernArtPlayerState {
  const p = state.players.find((p) => p.config.id === playerId);
  if (!p) throw new Error(`プレイヤー ${playerId} が見つかりません`);
  return p;
}

function nextPlayerIndex(state: ModernArtGameState, from: number): number {
  return (from + 1) % state.players.length;
}

export function isModernArtGameOver(state: ModernArtGameState): boolean {
  return state.phase === 'finished';
}

// ── 利用可能アクション ──

export function getAvailableActions(state: ModernArtGameState, playerId: string): ModernArtAction[] {
  const player = getPlayer(state, playerId);
  const actions: ModernArtAction[] = [];

  if (state.phase === 'play_card') {
    if (state.players[state.currentPlayerIndex].config.id !== playerId) return [];
    // 手札から1枚選んでプレイ
    for (const card of player.hand) {
      if (card.auctionType === 'double') {
        // ダブルカード: 同じ画家のカードがもう1枚あればダブルとしてプレイ可
        const pairCards = player.hand.filter(c => c.id !== card.id && c.artist === card.artist);
        if (pairCards.length > 0) {
          for (const pair of pairCards) {
            actions.push({ type: 'play_double', playerId, cardId: card.id, pairCardId: pair.id });
          }
        }
        // ダブルカードを単独でも出せる（通常の公開競りとして扱う）
        actions.push({ type: 'play_card', playerId, cardId: card.id });
      } else {
        actions.push({ type: 'play_card', playerId, cardId: card.id });
      }
    }
    return actions;
  }

  if (state.phase === 'auction' && state.auctionState) {
    const auction = state.auctionState;

    if (auction.auctionType === 'open') {
      // 公開競り: 現在の入札者の番か確認
      const biddingPlayer = state.players[auction.biddingPlayerIndex];
      if (biddingPlayer.config.id !== playerId) return [];
      // パス
      actions.push({ type: 'pass_bid', playerId });
      // 入札（現在のbid+1 ～ 所持金）
      // UI側で金額入力させるので、ここではbidアクション1つだけ返す
      if (player.money > auction.currentBid) {
        actions.push({ type: 'bid', playerId, amount: auction.currentBid + 1 });
      }
      return actions;
    }

    if (auction.auctionType === 'once_around') {
      const biddingPlayer = state.players[auction.biddingPlayerIndex];
      if (biddingPlayer.config.id !== playerId) return [];
      if (auction.onceAroundBids[playerId] !== undefined) return []; // 既に入札済み
      actions.push({ type: 'pass_bid', playerId });
      if (player.money > (auction.currentBid || 0)) {
        actions.push({ type: 'bid', playerId, amount: (auction.currentBid || 0) + 1 });
      }
      return actions;
    }

    if (auction.auctionType === 'sealed') {
      if (playerId === auction.sellerId) return [];
      if (auction.sealedBids[playerId] !== undefined) return []; // 既に入札済み
      // 密封入札: 金額を入力（0=パス）
      actions.push({ type: 'submit_sealed_bid', playerId, amount: 0 });
      return actions;
    }
  }

  if (state.phase === 'set_fixed_price' && state.auctionState) {
    if (state.auctionState.sellerId !== playerId) return [];
    // 固定価格を設定
    actions.push({ type: 'set_fixed_price', playerId, price: 1 });
    return actions;
  }

  if (state.phase === 'auction' && state.auctionState?.auctionType === 'fixed_price') {
    const auction = state.auctionState;
    const askPlayer = state.players[auction.fixedAskPlayerIndex];
    if (askPlayer.config.id !== playerId) return [];
    if (player.money >= auction.fixedPrice) {
      actions.push({ type: 'accept_fixed_price', playerId });
    }
    actions.push({ type: 'decline_fixed_price', playerId });
    return actions;
  }

  return actions;
}

// ── アクション実行 ──

export function executeAction(state: ModernArtGameState, action: ModernArtAction): ModernArtGameState {
  let newState = { ...state, lastEvents: [] as string[] };

  switch (action.type) {
    case 'play_card':
      return executePlayCard(newState, action.playerId, action.cardId);
    case 'play_double':
      return executePlayDouble(newState, action.playerId, action.cardId, action.pairCardId);
    case 'bid':
      return executeBid(newState, action.playerId, action.amount);
    case 'pass_bid':
      return executePassBid(newState, action.playerId);
    case 'set_fixed_price':
      return executeSetFixedPrice(newState, action.playerId, action.price);
    case 'accept_fixed_price':
      return executeAcceptFixed(newState, action.playerId);
    case 'decline_fixed_price':
      return executeDeclineFixed(newState, action.playerId);
    case 'submit_sealed_bid':
      return executeSubmitSealed(newState, action.playerId, action.amount);
    default:
      return newState;
  }
}

// ── カードプレイ ──

function executePlayCard(state: ModernArtGameState, playerId: string, cardId: string): ModernArtGameState {
  const playerIdx = state.players.findIndex(p => p.config.id === playerId);
  const player = state.players[playerIdx];
  const cardIdx = player.hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) throw new Error(`カード ${cardId} が手札にない`);

  const card = player.hand[cardIdx];
  const newHand = [...player.hand];
  newHand.splice(cardIdx, 1);

  const newPlayed = { ...state.playedCardsThisRound };
  newPlayed[card.artist] = (newPlayed[card.artist] || 0) + 1;

  // 5枚目チェック → ラウンド終了
  if (newPlayed[card.artist] >= gameConfig!.roundEndCardCount) {
    return endRound({
      ...state,
      players: updatePlayerAt(state.players, playerIdx, { hand: newHand }),
      playedCardsThisRound: newPlayed,
      lastEvents: [`🎨 ${player.config.name} が ${card.artist} を出した → 5枚目！ラウンド終了`],
    });
  }

  // オークション開始
  const auctionType = card.auctionType === 'double' ? 'open' : card.auctionType;
  const auction = createAuction(state, card, playerId, auctionType);

  const newPhase = auctionType === 'fixed_price' ? 'set_fixed_price' as const : 'auction' as const;

  return {
    ...state,
    players: updatePlayerAt(state.players, playerIdx, { hand: newHand }),
    playedCardsThisRound: newPlayed,
    phase: newPhase,
    auctionState: auction,
    lastEvents: [`🎨 ${player.config.name} が ${card.artist}(${auctionTypeName(auctionType)})を出品`],
  };
}

function executePlayDouble(state: ModernArtGameState, playerId: string, cardId: string, pairCardId: string): ModernArtGameState {
  const playerIdx = state.players.findIndex(p => p.config.id === playerId);
  const player = state.players[playerIdx];

  const card = player.hand.find(c => c.id === cardId);
  const pairCard = player.hand.find(c => c.id === pairCardId);
  if (!card || !pairCard) throw new Error('カードが手札にない');
  if (card.artist !== pairCard.artist) throw new Error('ダブルオークションは同じ画家のカードが必要');

  const newHand = player.hand.filter(c => c.id !== cardId && c.id !== pairCardId);

  const newPlayed = { ...state.playedCardsThisRound };
  newPlayed[card.artist] = (newPlayed[card.artist] || 0) + 2;

  // 5枚目チェック
  if (newPlayed[card.artist] >= gameConfig!.roundEndCardCount) {
    // ダブルで5枚以上 → ラウンド終了（2枚とも無効）
    return endRound({
      ...state,
      players: updatePlayerAt(state.players, playerIdx, { hand: newHand }),
      playedCardsThisRound: newPlayed,
      lastEvents: [`🎨🎨 ${player.config.name} が ${card.artist} をダブル出品 → 5枚超え！ラウンド終了`],
    });
  }

  // ペアカードのオークション種別を使用（ダブルカード自体は種別指定しない）
  const auctionType = pairCard.auctionType === 'double' ? 'open' : pairCard.auctionType;
  const auction = createAuction(state, card, playerId, auctionType);
  auction.doubleCard = pairCard;

  const newPhase = auctionType === 'fixed_price' ? 'set_fixed_price' as const : 'auction' as const;

  return {
    ...state,
    players: updatePlayerAt(state.players, playerIdx, { hand: newHand }),
    playedCardsThisRound: newPlayed,
    phase: newPhase,
    auctionState: auction,
    lastEvents: [`🎨🎨 ${player.config.name} が ${card.artist} をダブル出品(${auctionTypeName(auctionType)})`],
  };
}

// ── オークション処理 ──

function createAuction(state: ModernArtGameState, card: ModernArtCard, sellerId: string, auctionType: AuctionType): AuctionState {
  const sellerIdx = state.players.findIndex(p => p.config.id === sellerId);
  return {
    card,
    sellerId,
    auctionType,
    currentBid: 0,
    currentBidderId: null,
    biddingPlayerIndex: nextPlayerIndex(state, sellerIdx),
    passedPlayerIds: [],
    onceAroundBids: {},
    sealedBids: {},
    fixedPrice: 0,
    fixedAskPlayerIndex: nextPlayerIndex(state, sellerIdx),
    fixedResolved: false,
  };
}

function executeBid(state: ModernArtGameState, playerId: string, amount: number): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);

  if (amount > player.money) throw new Error('所持金が足りない');

  if (auction.auctionType === 'open') {
    if (amount <= auction.currentBid) throw new Error('現在の入札額より高くする必要がある');
    auction.currentBid = amount;
    auction.currentBidderId = playerId;
    // 次のプレイヤーへ（パス済みをスキップ）
    auction.biddingPlayerIndex = findNextBidder(state, auction);
    return {
      ...state,
      auctionState: auction,
      lastEvents: [`💰 ${player.config.name} が ${amount} で入札`],
    };
  }

  if (auction.auctionType === 'once_around') {
    if (amount <= (auction.currentBid || 0)) throw new Error('現在の最高額より高くする必要がある');
    auction.onceAroundBids[playerId] = amount;
    auction.currentBid = amount;
    auction.currentBidderId = playerId;
    // 次のプレイヤーへ
    auction.biddingPlayerIndex = nextPlayerIndex(state, auction.biddingPlayerIndex);
    // 全員入札完了チェック
    return checkOnceAroundComplete(state, auction);
  }

  return state;
}

function executePassBid(state: ModernArtGameState, playerId: string): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);

  if (auction.auctionType === 'open') {
    auction.passedPlayerIds = [...auction.passedPlayerIds, playerId];
    // 残りの入札者チェック
    const activeBidders = state.players.filter(
      p => p.config.id !== auction.sellerId && !auction.passedPlayerIds.includes(p.config.id)
    );
    if (activeBidders.length === 0) {
      // 全員パス → オークション解決
      return resolveAuction(state, auction);
    }
    auction.biddingPlayerIndex = findNextBidder(state, auction);
    return {
      ...state,
      auctionState: auction,
      lastEvents: [`  ⏭️ ${player.config.name} パス`],
    };
  }

  if (auction.auctionType === 'once_around') {
    auction.onceAroundBids[playerId] = 0;
    auction.biddingPlayerIndex = nextPlayerIndex(state, auction.biddingPlayerIndex);
    return checkOnceAroundComplete({
      ...state,
      lastEvents: [`  ⏭️ ${player.config.name} パス`],
    }, auction);
  }

  return state;
}

function executeSetFixedPrice(state: ModernArtGameState, playerId: string, price: number): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);
  auction.fixedPrice = price;
  return {
    ...state,
    phase: 'auction',
    auctionState: auction,
    lastEvents: [`💲 ${player.config.name} が ${price} の固定価格を設定`],
  };
}

function executeAcceptFixed(state: ModernArtGameState, playerId: string): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);
  auction.currentBid = auction.fixedPrice;
  auction.currentBidderId = playerId;
  auction.fixedResolved = true;
  return resolveAuction({
    ...state,
    lastEvents: [`✅ ${player.config.name} が ${auction.fixedPrice} で購入`],
  }, auction);
}

function executeDeclineFixed(state: ModernArtGameState, playerId: string): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);

  // 次のプレイヤーへ
  auction.fixedAskPlayerIndex = nextPlayerIndex(state, auction.fixedAskPlayerIndex);
  const nextPlayer = state.players[auction.fixedAskPlayerIndex];

  // 売主に戻った → 売主が自分で買う
  if (nextPlayer.config.id === auction.sellerId) {
    auction.currentBid = auction.fixedPrice;
    auction.currentBidderId = auction.sellerId;
    auction.fixedResolved = true;
    return resolveAuction({
      ...state,
      lastEvents: [`  ⏭️ ${player.config.name} 辞退 → 売主が自分で購入`],
    }, auction);
  }

  return {
    ...state,
    auctionState: auction,
    lastEvents: [`  ⏭️ ${player.config.name} 辞退`],
  };
}

function executeSubmitSealed(state: ModernArtGameState, playerId: string, amount: number): ModernArtGameState {
  if (!state.auctionState) throw new Error('オークション中ではない');
  const auction = { ...state.auctionState };
  const player = getPlayer(state, playerId);

  if (amount > player.money) throw new Error('所持金が足りない');
  auction.sealedBids = { ...auction.sealedBids, [playerId]: amount };

  // 全員入札完了チェック
  const nonSellers = state.players.filter(p => p.config.id !== auction.sellerId);
  const allSubmitted = nonSellers.every(p => auction.sealedBids[p.config.id] !== undefined);

  if (allSubmitted) {
    // 最高入札者を決定
    let highestBid = 0;
    let highestBidder: string | null = null;
    for (const [pid, bid] of Object.entries(auction.sealedBids)) {
      if (bid > highestBid) {
        highestBid = bid;
        highestBidder = pid;
      }
    }
    auction.currentBid = highestBid;
    auction.currentBidderId = highestBidder;
    return resolveAuction({
      ...state,
      lastEvents: [`🔒 密封入札完了 → 最高額 ${highestBid}`],
    }, auction);
  }

  return {
    ...state,
    auctionState: auction,
    lastEvents: [`🔒 ${player.config.name} が入札完了`],
  };
}

// ── オークション解決 ──

function resolveAuction(state: ModernArtGameState, auction: AuctionState): ModernArtGameState {
  const newPlayers = state.players.map(p => ({ ...p }));
  const cards = auction.doubleCard ? [auction.card, auction.doubleCard] : [auction.card];
  const events = [...state.lastEvents];

  if (auction.currentBidderId && auction.currentBid > 0) {
    const buyer = newPlayers.find(p => p.config.id === auction.currentBidderId)!;
    const seller = newPlayers.find(p => p.config.id === auction.sellerId)!;

    buyer.money -= auction.currentBid;
    // 自分で買った場合は銀行に払う
    if (buyer.config.id !== seller.config.id) {
      seller.money += auction.currentBid;
    }
    buyer.paintings = [...buyer.paintings, ...cards];
    events.push(`  🖼️ ${buyer.config.name} が ${cards.map(c => c.artist).join('+')} を ${auction.currentBid} で落札`);
  } else {
    // 入札者なし → 売主が無料で獲得
    const seller = newPlayers.find(p => p.config.id === auction.sellerId)!;
    seller.paintings = [...seller.paintings, ...cards];
    events.push(`  🖼️ 入札なし → ${seller.config.name} が無料で獲得`);
  }

  // 次のプレイヤーへ
  const nextIdx = nextPlayerIndex(state, state.currentPlayerIndex);

  // 手札チェック: 全員手札が空ならラウンド終了
  const allEmpty = newPlayers.every(p => p.hand.length === 0);
  if (allEmpty) {
    return endRound({
      ...state,
      players: newPlayers,
      auctionState: null,
      lastEvents: events,
    });
  }

  return {
    ...state,
    players: newPlayers,
    phase: 'play_card',
    auctionState: null,
    currentPlayerIndex: nextIdx,
    lastEvents: events,
  };
}

// ── ラウンド終了・得点計算 ──

function endRound(state: ModernArtGameState): ModernArtGameState {
  const played = state.playedCardsThisRound;

  // ランキング計算（枚数降順、同数ならインデックス昇順）
  const sorted = [...ARTIST_NAMES].sort((a, b) => {
    const diff = (played[b] || 0) - (played[a] || 0);
    if (diff !== 0) return diff;
    return ARTIST_NAMES.indexOf(a) - ARTIST_NAMES.indexOf(b);
  });

  const ranking = sorted.filter(a => (played[a] || 0) > 0).slice(0, 3);
  const roundValues: Record<ArtistName, number> = emptyArtistRecord();
  for (let i = 0; i < ranking.length; i++) {
    roundValues[ranking[i]] = gameValues!.rankValues[i];
  }

  // 累積価値に加算
  const newArtistValues = { ...state.artistValues };
  for (const artist of ARTIST_NAMES) {
    newArtistValues[artist] += roundValues[artist];
  }

  const roundResult: RoundResult = {
    round: state.round,
    cardCounts: { ...played },
    ranking,
    values: roundValues,
  };

  const events = [...state.lastEvents];
  events.push(`━━━ ラウンド${state.round} 結果 ━━━`);
  for (let i = 0; i < ranking.length; i++) {
    events.push(`  ${['🥇', '🥈', '🥉'][i]} ${ranking[i]}: +${gameValues!.rankValues[i]} (累計${newArtistValues[ranking[i]]})`);
  }

  // 絵画の売却（所持絵画を現金化）
  const newPlayers = state.players.map(p => {
    let paintingMoney = 0;
    for (const painting of p.paintings) {
      paintingMoney += newArtistValues[painting.artist];
    }
    if (paintingMoney > 0) {
      events.push(`  💰 ${p.config.name}: 絵画売却 +${paintingMoney} (${p.paintings.length}枚)`);
    }
    return {
      ...p,
      money: p.money + paintingMoney,
      paintings: [], // 売却後クリア
    };
  });

  // 次のラウンドへ
  if (state.round >= gameConfig!.roundCount) {
    return finishGame({
      ...state,
      players: newPlayers,
      round: state.round,
      roundResults: [...state.roundResults, roundResult],
      artistValues: newArtistValues,
      auctionState: null,
      lastEvents: events,
    });
  }

  // 手札配布
  const newRound = state.round + 1;
  const deck = [...state.deck];
  const n = state.players.length;
  const dealRounds = gameDeal![n];
  if (!dealRounds) throw new Error(`${n}人用の配布データがスプシにない`);
  const dealCount = dealRounds[newRound - 1];

  for (let i = 0; i < dealCount; i++) {
    for (const p of newPlayers) {
      if (deck.length > 0) p.hand.push(deck.pop()!);
    }
  }

  const newStart = nextPlayerIndex(state, state.startPlayerIndex);

  events.push(`━━━ ラウンド${newRound} 開始 ━━━`);

  return {
    ...state,
    players: newPlayers,
    deck,
    round: newRound,
    currentPlayerIndex: newStart,
    startPlayerIndex: newStart,
    phase: 'play_card',
    auctionState: null,
    artistValues: newArtistValues,
    roundResults: [...state.roundResults, roundResult],
    playedCardsThisRound: emptyArtistRecord(),
    lastEvents: events,
  };
}

// ── ゲーム終了 ──

function finishGame(state: ModernArtGameState): ModernArtGameState {
  return {
    ...state,
    phase: 'finished',
    lastEvents: [...state.lastEvents, '━━━ ゲーム終了 ━━━'],
  };
}

export function getModernArtFinalScores(state: ModernArtGameState): ModernArtFinalScore[] {
  const scores = state.players.map(p => ({
    playerId: p.config.id,
    name: p.config.name,
    money: p.money,
    paintingValue: 0, // 最終ラウンドで既に売却済み
    rank: 0,
  }));

  scores.sort((a, b) => b.money - a.money);
  scores.forEach((s, i) => { s.rank = i + 1; });
  return scores;
}

// ── ヘルパー ──

function updatePlayerAt(players: ModernArtPlayerState[], index: number, updates: Partial<ModernArtPlayerState>): ModernArtPlayerState[] {
  return players.map((p, i) => i === index ? { ...p, ...updates } : p);
}

function findNextBidder(state: ModernArtGameState, auction: AuctionState): number {
  let idx = nextPlayerIndex(state, auction.biddingPlayerIndex);
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    const p = state.players[idx];
    if (p.config.id !== auction.sellerId && !auction.passedPlayerIds.includes(p.config.id)) {
      return idx;
    }
    idx = nextPlayerIndex(state, idx);
  }
  return auction.biddingPlayerIndex;
}

function checkOnceAroundComplete(state: ModernArtGameState, auction: AuctionState): ModernArtGameState {
  const nonSellers = state.players.filter(p => p.config.id !== auction.sellerId);
  const allBid = nonSellers.every(p => auction.onceAroundBids[p.config.id] !== undefined);

  if (allBid) {
    return resolveAuction({ ...state, auctionState: auction }, auction);
  }

  return { ...state, auctionState: auction };
}

export function auctionTypeName(type: AuctionType): string {
  switch (type) {
    case 'open': return '公開競り';
    case 'once_around': return '一巡競り';
    case 'sealed': return '密封入札';
    case 'fixed_price': return '固定価格';
    case 'double': return 'ダブル';
  }
}

export function artistEmoji(artist: ArtistName): string {
  switch (artist) {
    case 'Lite Metal': return '🟡';
    case 'Yoko': return '🔴';
    case 'Christin P': return '🔵';
    case 'Karl Gitter': return '🟢';
    case 'Krypto': return '🟣';
  }
}
