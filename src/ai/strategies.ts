import type { AIStrategy, GameState } from '../engine/types.js';
import { inferRemainingHands } from '../engine/game.js';

// ========== ユーティリティ ==========

function getPlayer(state: GameState, playerId: string) {
  const p = state.players.find((p) => p.config.id === playerId);
  if (!p) throw new Error(`プレイヤー ${playerId} が見つかりません`);
  return p;
}

function getEffectivePointValue(state: GameState): number {
  const base = state.currentPointCard ?? 0;
  const carrySum = state.carryOver.reduce((s, c) => s + c, 0);
  return base + carrySum;
}

function getOtherPlayers(state: GameState, playerId: string) {
  return state.players.filter((p) => p.config.id !== playerId);
}

function sortAsc(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

function sortDesc(arr: number[]): number[] {
  return [...arr].sort((a, b) => b - a);
}

function median(arr: number[]): number {
  const sorted = sortAsc(arr);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ========== 戦略1: バランス型 ==========
const balanced: AIStrategy = {
  id: 'balanced',
  name: 'バランス型',
  description: '得点カードの価値に比例した手札を出す基本戦略',
  personality: '冷静沈着',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);
    const isPositive = pointValue > 0;

    // 得点の絶対値を0〜10のスケールでどの手札を出すか決める
    const absValue = Math.abs(pointValue);
    const ratio = Math.min(absValue / 10, 1); // 0.0〜1.0

    let card: number;
    if (isPositive) {
      // 高い得点 → 強い手札を出す
      const idx = Math.round(ratio * (hand.length - 1));
      card = hand[idx];
      return {
        card,
        reasoning: `得点カード${pointValue}点。価値${Math.round(ratio * 100)}%相当の手札${card}を出す。バランスを保ちながら適切な手を選択`,
      };
    } else {
      // マイナス → 中間くらいの手札で回避を狙う
      const midIdx = Math.floor(hand.length / 2);
      card = hand[midIdx];
      return {
        card,
        reasoning: `マイナス${pointValue}点カード。中間の手札${card}で押し付けを回避しつつ、強い手を温存する`,
      };
    }
  },
};

// ========== 戦略2: 攻撃型 ==========
const aggressive: AIStrategy = {
  id: 'aggressive',
  name: '攻撃型',
  description: '高得点カードに強い手札を集中投入するハイリスクハイリターン戦略',
  personality: '強気',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);
    const isPositive = pointValue > 0;

    if (isPositive && pointValue >= 5) {
      // 高得点には最強手を投入！
      const card = hand[hand.length - 1];
      return {
        card,
        reasoning: `${pointValue}点！こんな美味しいカード、絶対に俺が取る！最強の${card}でぶちかます！`,
      };
    } else if (isPositive && pointValue >= 2) {
      // 中得点には上位手を使う
      const idx = Math.floor(hand.length * 0.75);
      const card = hand[idx];
      return {
        card,
        reasoning: `${pointValue}点か。まあ取っておこう。${card}で勝負に出る`,
      };
    } else if (isPositive) {
      // 低得点は最弱手で
      const card = hand[0];
      return {
        card,
        reasoning: `たった${pointValue}点？強い手は温存だ。最弱の${card}で消化`,
      };
    } else {
      // マイナスカードには最強手を捨てる（押し付けを避けるより強手温存）
      // 実は最強手を出してマイナスを避ける方が合理的な場合も
      const card = hand[hand.length - 1];
      return {
        card,
        reasoning: `マイナス${pointValue}点なんて要らない！最強の${card}で押し付けを回避！力ずくで行くぜ！`,
      };
    }
  },
};

// ========== 戦略3: 慎重型 ==========
const conservative: AIStrategy = {
  id: 'conservative',
  name: '慎重型',
  description: 'マイナスカード回避を最優先する安定志向の戦略',
  personality: '心配性',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);
    const isPositive = pointValue > 0;

    if (!isPositive) {
      // マイナスカード: 最大手を出してマイナスを確実に回避
      const card = hand[hand.length - 1];
      return {
        card,
        reasoning: `マイナス${pointValue}点は絶対に取りたくない…！最大の${card}を出して絶対回避！これが最優先事項です`,
      };
    } else if (pointValue >= 7) {
      // 高得点は上位手で狙う
      const idx = Math.floor(hand.length * 0.8);
      const card = hand[idx];
      return {
        card,
        reasoning: `${pointValue}点は大きいので狙います。でも最大手は温存して${card}で様子見…`,
      };
    } else {
      // 低〜中得点は温存
      const card = hand[0];
      return {
        card,
        reasoning: `${pointValue}点は無理に取りに行かなくていいです。最小の${card}でリスク回避を優先`,
      };
    }
  },
};

// ========== 戦略4: カウンター型 ==========
const counter: AIStrategy = {
  id: 'counter',
  name: 'カウンター型',
  description: '他プレイヤーの残り手札を追跡し、裏をかく戦略',
  personality: '分析的',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);
    const isPositive = pointValue > 0;
    const inferredHands = inferRemainingHands(state);
    const others = getOtherPlayers(state, playerId);

    if (isPositive) {
      // 他プレイヤーの最大手の最小値を推定 → それより1上を出せれば勝てる
      const othersMaxCards = others.map((p) => {
        const theirHand = inferredHands[p.config.id];
        return theirHand.length > 0 ? Math.max(...theirHand) : 0;
      });
      const minOtherMax = Math.min(...othersMaxCards);

      // 相手の最大手より1だけ上のカードを出せれば効率的
      const efficientCard = hand.find((c) => c > minOtherMax);

      if (efficientCard !== undefined) {
        return {
          card: efficientCard,
          reasoning: `分析完了。相手の最大手は最小で${minOtherMax}と推定。${efficientCard}で過剰投資せずに勝負。${pointValue}点を効率的に取りに行く`,
        };
      } else {
        // 勝てないなら最小手を温存
        const card = hand[0];
        return {
          card,
          reasoning: `相手の手が強すぎる。今回は諦めて最小の${card}を消化。後のラウンドに備える`,
        };
      }
    } else {
      // マイナスカード: 他プレイヤーの最小手より1上を出す
      const othersMinCards = others.map((p) => {
        const theirHand = inferredHands[p.config.id];
        return theirHand.length > 0 ? Math.min(...theirHand) : 99;
      });
      const maxOtherMin = Math.max(...othersMinCards);

      // 相手の最小手より少し上のカードで回避
      const safeCard = hand.find((c) => c > maxOtherMin);

      if (safeCard !== undefined) {
        return {
          card: safeCard,
          reasoning: `マイナス回避。相手の最小手の最大は${maxOtherMin}と推定。${safeCard}で確実に回避を計画`,
        };
      } else {
        const card = hand[hand.length - 1];
        return {
          card,
          reasoning: `マイナス回避が困難な状況。最大手の${card}で少しでも可能性を上げる`,
        };
      }
    }
  },
};

// ========== 戦略5: 混沌型 ==========
const chaotic: AIStrategy = {
  id: 'chaotic',
  name: '混沌型',
  description: '予測困難な動き。読まれにくい',
  personality: '気まぐれ',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);

    const roll = Math.random();

    // 30%: 完全ランダム
    if (roll < 0.3) {
      const card = hand[Math.floor(Math.random() * hand.length)];
      return {
        card,
        reasoning: `フフフ…今日の気分はこれ！${card}！理由？ないよ！それが私！`,
      };
    }

    // 30%: 逆張り（プラスなのに最弱、マイナスなのに最強）
    if (roll < 0.6) {
      const card = pointValue > 0 ? hand[0] : hand[hand.length - 1];
      const action = pointValue > 0 ? '最弱' : '最強';
      return {
        card,
        reasoning: `あえて逆張り！プラスカードに${action}の${card}を出す！みんな驚くでしょ？うふふ`,
      };
    }

    // 40%: 普通にまあまあな手を出す
    const midIdx = Math.floor(hand.length / 2);
    const offset = Math.floor(Math.random() * 3) - 1;
    const idx = Math.max(0, Math.min(hand.length - 1, midIdx + offset));
    const card = hand[idx];
    return {
      card,
      reasoning: `んー…${card}かな。なんとなく！直感！`,
    };
  },
};

// ========== 戦略6: 経済学者型 ==========
const economist: AIStrategy = {
  id: 'economist',
  name: '経済学者型',
  description: '期待値計算に基づく戦略。各カードの限界効用を考慮',
  personality: '論理的',

  selectCard(state, playerId) {
    const player = getPlayer(state, playerId);
    const hand = sortAsc(player.hand);
    const pointValue = getEffectivePointValue(state);
    const isPositive = pointValue > 0;
    const remainingRounds = state.pointCardDeck.length + 1; // 現在のラウンドを含む
    const inferredHands = inferRemainingHands(state);
    const others = getOtherPlayers(state, playerId);

    // 各手札カードの「機会費用」を計算
    // 強い手を出すほど、将来の高得点ラウンドを取れなくなる
    const futureHighValueRounds = state.pointCardDeck.filter((c) => c >= 7).length;
    const futureLowValueRounds = state.pointCardDeck.filter((c) => c <= -3).length;

    // 現在の得点価値に対する適切な手の強度を計算
    const handStrength = isPositive
      ? Math.min(Math.max((pointValue / 10) * hand.length - 1, 0), hand.length - 1)
      : hand.length - 1; // マイナスは最大手で回避

    // 期待値補正: 将来の高得点ラウンドが多い場合は強手を温存
    let adjustedIdx = Math.round(handStrength);
    if (isPositive && futureHighValueRounds > remainingRounds * 0.3) {
      // 強い手を温存
      adjustedIdx = Math.max(0, adjustedIdx - 2);
    }

    // 競争状況を考慮: 相手全員の手が強そうなら諦める
    const avgOtherHandStrength =
      others.reduce((sum, p) => {
        const theirHand = inferredHands[p.config.id];
        return sum + (theirHand.length > 0 ? median(theirHand) : 8);
      }, 0) / others.length;

    const myMedian = median(hand);

    if (isPositive && myMedian < avgOtherHandStrength - 3) {
      // 相手が全体的に強い → 最弱手で温存
      const card = hand[0];
      return {
        card,
        reasoning: `期待値計算: 相手の平均手強度${avgOtherHandStrength.toFixed(1)}に対し自分の中央値${myMedian}。勝率低下を確認。最小投資の${card}で温存を選択。将来高得点ラウンド残り${futureHighValueRounds}回`,
      };
    }

    const card = hand[Math.min(adjustedIdx, hand.length - 1)];
    return {
      card,
      reasoning: `期待値最適化: ${pointValue}点カードに対し強度${adjustedIdx + 1}/${hand.length}の${card}を選択。将来ハイバリューラウンド${futureHighValueRounds}回、マイナスリスク${futureLowValueRounds}回を考慮した最適解`,
    };
  },
};

// ========== 戦略レジストリ ==========
export const strategies: Record<string, AIStrategy> = {
  balanced,
  aggressive,
  conservative,
  counter,
  chaotic,
  economist,
};

export const strategyIds = Object.keys(strategies);

export function getStrategy(id: string): AIStrategy {
  const strategy = strategies[id];
  if (!strategy) {
    throw new Error(`戦略 ${id} が見つかりません。利用可能: ${strategyIds.join(', ')}`);
  }
  return strategy;
}

export function getRandomStrategy(): AIStrategy {
  const id = strategyIds[Math.floor(Math.random() * strategyIds.length)];
  return strategies[id];
}
