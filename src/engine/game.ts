import type { GameState, PlayerConfig, PlayerState, RoundResult, FinalScore } from './types.js';

const POINT_CARDS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const HAND_CARDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createGame(players: PlayerConfig[]): GameState {
  if (players.length < 2 || players.length > 5) {
    throw new Error('プレイヤー数は2〜5人にしてください');
  }

  const playerStates: PlayerState[] = players.map((config) => ({
    config,
    hand: [...HAND_CARDS],
    score: 0,
    wonCards: [],
    selectedCard: null,
  }));

  return {
    players: playerStates,
    pointCardDeck: shuffle(POINT_CARDS),
    currentPointCard: null,
    carryOver: [],
    round: 0,
    totalRounds: POINT_CARDS.length,
    phase: 'selecting',
    history: [],
  };
}

export function revealPointCard(state: GameState): GameState {
  if (state.pointCardDeck.length === 0) {
    return { ...state, phase: 'finished' };
  }

  const [currentPointCard, ...remainingDeck] = state.pointCardDeck;

  return {
    ...state,
    pointCardDeck: remainingDeck,
    currentPointCard,
    round: state.round + 1,
    phase: 'selecting',
    players: state.players.map((p) => ({ ...p, selectedCard: null })),
  };
}

export function submitSelection(state: GameState, playerId: string, card: number): GameState {
  const player = state.players.find((p) => p.config.id === playerId);
  if (!player) throw new Error(`プレイヤー ${playerId} が見つかりません`);
  if (!player.hand.includes(card)) throw new Error(`プレイヤー ${playerId} の手札に ${card} はありません`);

  const updatedPlayers = state.players.map((p) => {
    if (p.config.id !== playerId) return p;
    return {
      ...p,
      selectedCard: card,
      hand: p.hand.filter((c) => c !== card),
    };
  });

  return { ...state, players: updatedPlayers };
}

export function resolveRound(
  state: GameState,
  reasoning?: Record<string, string>
): { state: GameState; result: RoundResult } {
  if (state.currentPointCard === null) {
    throw new Error('得点カードがめくられていません');
  }

  const selections = state.players.map((p) => ({
    playerId: p.config.id,
    card: p.selectedCard!,
  }));

  const currentPointCard = state.currentPointCard;
  const isPositive = currentPointCard > 0;
  const allPointCards = [...state.carryOver, currentPointCard];

  // 勝者を決定
  let winnerId: string | null = null;

  if (isPositive) {
    // プラスカード: 最高値の人が取る（タイは無効）
    const maxCard = Math.max(...selections.map((s) => s.card));
    const maxPlayers = selections.filter((s) => s.card === maxCard);

    if (maxPlayers.length === 1) {
      winnerId = maxPlayers[0].playerId;
    } else {
      // タイの人は無効 → 次に高い人を探す
      const nonMaxSelections = selections.filter((s) => s.card !== maxCard);
      if (nonMaxSelections.length > 0) {
        const nextMax = Math.max(...nonMaxSelections.map((s) => s.card));
        const nextMaxPlayers = nonMaxSelections.filter((s) => s.card === nextMax);
        if (nextMaxPlayers.length === 1) {
          winnerId = nextMaxPlayers[0].playerId;
        } else {
          // 再帰的に続くが、ゲーム的には全員タイなら誰も取れない
          // シンプルに: タイを除外して残りから再度最高値を探す実装
          winnerId = findWinnerPositive(selections);
        }
      }
    }
  } else {
    // マイナスカード: 最低値の人が取る（タイは無効）
    const minCard = Math.min(...selections.map((s) => s.card));
    const minPlayers = selections.filter((s) => s.card === minCard);

    if (minPlayers.length === 1) {
      winnerId = minPlayers[0].playerId;
    } else {
      const nonMinSelections = selections.filter((s) => s.card !== minCard);
      if (nonMinSelections.length > 0) {
        const nextMin = Math.min(...nonMinSelections.map((s) => s.card));
        const nextMinPlayers = nonMinSelections.filter((s) => s.card === nextMin);
        if (nextMinPlayers.length === 1) {
          winnerId = nextMinPlayers[0].playerId;
        } else {
          winnerId = findWinnerNegative(selections);
        }
      }
    }
  }

  const totalPoints = allPointCards.reduce((sum, c) => sum + c, 0);

  const result: RoundResult = {
    round: state.round,
    pointCard: currentPointCard,
    carryOver: state.carryOver,
    selections,
    winnerId,
    reasoning,
  };

  // プレイヤー状態を更新
  const updatedPlayers = state.players.map((p) => {
    if (p.config.id !== winnerId) return { ...p, selectedCard: p.selectedCard };
    return {
      ...p,
      score: p.score + totalPoints,
      wonCards: [...p.wonCards, ...allPointCards],
      selectedCard: p.selectedCard,
    };
  });

  const newCarryOver = winnerId === null ? allPointCards : [];

  const newState: GameState = {
    ...state,
    players: updatedPlayers,
    currentPointCard: null,
    carryOver: newCarryOver,
    phase: state.pointCardDeck.length === 0 ? 'finished' : 'selecting',
    history: [...state.history, result],
  };

  return { state: newState, result };
}

// タイを除外しながら再帰的に勝者を見つける（プラスカード用）
function findWinnerPositive(selections: { playerId: string; card: number }[]): string | null {
  if (selections.length === 0) return null;

  const maxCard = Math.max(...selections.map((s) => s.card));
  const maxPlayers = selections.filter((s) => s.card === maxCard);

  if (maxPlayers.length === 1) return maxPlayers[0].playerId;

  // タイを除外して再帰
  const remaining = selections.filter((s) => s.card !== maxCard);
  return findWinnerPositive(remaining);
}

// タイを除外しながら再帰的に勝者を見つける（マイナスカード用）
function findWinnerNegative(selections: { playerId: string; card: number }[]): string | null {
  if (selections.length === 0) return null;

  const minCard = Math.min(...selections.map((s) => s.card));
  const minPlayers = selections.filter((s) => s.card === minCard);

  if (minPlayers.length === 1) return minPlayers[0].playerId;

  // タイを除外して再帰
  const remaining = selections.filter((s) => s.card !== minCard);
  return findWinnerNegative(remaining);
}

export function isGameOver(state: GameState): boolean {
  return state.phase === 'finished' || state.pointCardDeck.length === 0;
}

export function getFinalScores(state: GameState): FinalScore[] {
  const scores = state.players.map((p) => ({
    playerId: p.config.id,
    name: p.config.name,
    score: p.score,
    rank: 0,
  }));

  scores.sort((a, b) => b.score - a.score);

  let rank = 1;
  for (let i = 0; i < scores.length; i++) {
    if (i > 0 && scores[i].score < scores[i - 1].score) {
      rank = i + 1;
    }
    scores[i].rank = rank;
  }

  return scores;
}

// 各プレイヤーの残り手札を履歴から推定する
export function inferRemainingHands(state: GameState): Record<string, number[]> {
  const usedCards: Record<string, number[]> = {};

  for (const player of state.players) {
    usedCards[player.config.id] = [];
  }

  for (const round of state.history) {
    for (const sel of round.selections) {
      usedCards[sel.playerId].push(sel.card);
    }
  }

  const result: Record<string, number[]> = {};
  const allHands = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  for (const player of state.players) {
    result[player.config.id] = allHands.filter((c) => !usedCards[player.config.id].includes(c));
  }

  return result;
}
