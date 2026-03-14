// Modern Art AI戦略
import { ARTIST_NAMES } from '../engine/modern-art-types.js';
import { getPlayer } from '../engine/modern-art.js';
// ── 共通ユーティリティ ──
function estimateArtistValue(state, artist) {
    const played = state.playedCardsThisRound;
    const cumulative = state.artistValues[artist];
    // 今ラウンドの予想価値
    const sorted = [...ARTIST_NAMES].sort((a, b) => (played[b] || 0) - (played[a] || 0));
    const rank = sorted.indexOf(artist);
    const roundValue = rank === 0 ? 30 : rank === 1 ? 20 : rank === 2 ? 10 : 0;
    return cumulative + roundValue;
}
function getMyPaintingCount(state, playerId, artist) {
    const player = getPlayer(state, playerId);
    return player.paintings.filter(p => p.artist === artist).length;
}
// ── 保守的戦略 ──
const conservativeStrategy = {
    id: 'ma_conservative',
    name: '堅実派',
    description: '控えめな入札、手堅い運用',
    personality: '慎重に絵画の価値を見極め、割安な絵だけを狙う堅実な画商',
    selectCardToPlay(state, playerId) {
        const player = getPlayer(state, playerId);
        // 自分が絵を持っている画家のカードを優先（価値を上げる）
        const myArtists = new Map();
        for (const p of player.paintings) {
            myArtists.set(p.artist, (myArtists.get(p.artist) || 0) + 1);
        }
        // 枚数が多い画家のカードを優先
        const sorted = [...player.hand].sort((a, b) => {
            const aCount = myArtists.get(a.artist) || 0;
            const bCount = myArtists.get(b.artist) || 0;
            return bCount - aCount;
        });
        const card = sorted[0];
        // ダブルカードで同じ画家がもう1枚あればダブルで出す
        if (card.auctionType === 'double') {
            const pair = player.hand.find(c => c.id !== card.id && c.artist === card.artist);
            if (pair) {
                return {
                    action: { type: 'play_double', playerId, cardId: card.id, pairCardId: pair.id },
                    reasoning: `${card.artist}のダブル出品で価値を上げる`,
                };
            }
        }
        return {
            action: { type: 'play_card', playerId, cardId: card.id },
            reasoning: `${card.artist}を出品`,
        };
    },
    selectBid(state, playerId) {
        const auction = state.auctionState;
        const estimatedValue = estimateArtistValue(state, auction.card.artist);
        const player = getPlayer(state, playerId);
        const isDouble = !!auction.doubleCard;
        const multiplier = isDouble ? 2 : 1;
        const maxWilling = Math.floor(estimatedValue * 0.6 * multiplier); // 60%まで
        if (auction.auctionType === 'sealed') {
            const bid = Math.min(maxWilling, player.money);
            return {
                action: { type: 'submit_sealed_bid', playerId, amount: Math.max(0, bid) },
                reasoning: `密封入札: ${bid}（推定価値${estimatedValue}の60%）`,
            };
        }
        if (auction.auctionType === 'fixed_price') {
            if (auction.fixedPrice <= maxWilling && player.money >= auction.fixedPrice) {
                return { action: { type: 'accept_fixed_price', playerId }, reasoning: `${auction.fixedPrice}は割安` };
            }
            return { action: { type: 'decline_fixed_price', playerId }, reasoning: '高すぎる' };
        }
        // open / once_around
        const minBid = (auction.currentBid || 0) + 1;
        if (minBid <= maxWilling && minBid <= player.money) {
            const bidAmount = Math.min(minBid + Math.floor(Math.random() * 3), maxWilling, player.money);
            return {
                action: { type: 'bid', playerId, amount: bidAmount },
                reasoning: `${bidAmount}で入札（推定価値${estimatedValue}）`,
            };
        }
        return { action: { type: 'pass_bid', playerId }, reasoning: '割高なのでパス' };
    },
};
// ── 攻撃的戦略 ──
const aggressiveStrategy = {
    id: 'ma_aggressive',
    name: '攻め派',
    description: '積極的な入札で市場を支配',
    personality: '大胆に高値で入札し、特定の画家を独占して価値を釣り上げる攻めの画商',
    selectCardToPlay(state, playerId) {
        const player = getPlayer(state, playerId);
        // 場に最も多く出ている画家のカードを出す（価値を上げる）
        const sorted = [...player.hand].sort((a, b) => {
            const aPlayed = state.playedCardsThisRound[a.artist] || 0;
            const bPlayed = state.playedCardsThisRound[b.artist] || 0;
            return bPlayed - aPlayed;
        });
        const card = sorted[0];
        if (card.auctionType === 'double') {
            const pair = player.hand.find(c => c.id !== card.id && c.artist === card.artist);
            if (pair) {
                return {
                    action: { type: 'play_double', playerId, cardId: card.id, pairCardId: pair.id },
                    reasoning: `${card.artist}ダブル出品で一気に場を支配`,
                };
            }
        }
        return {
            action: { type: 'play_card', playerId, cardId: card.id },
            reasoning: `${card.artist}を攻めの出品`,
        };
    },
    selectBid(state, playerId) {
        const auction = state.auctionState;
        const estimatedValue = estimateArtistValue(state, auction.card.artist);
        const player = getPlayer(state, playerId);
        const isDouble = !!auction.doubleCard;
        const multiplier = isDouble ? 2 : 1;
        const maxWilling = Math.floor(estimatedValue * 0.85 * multiplier); // 85%まで
        if (auction.auctionType === 'sealed') {
            const bid = Math.min(Math.floor(maxWilling * 0.7), player.money);
            return {
                action: { type: 'submit_sealed_bid', playerId, amount: Math.max(0, bid) },
                reasoning: `密封入札: ${bid}`,
            };
        }
        if (auction.auctionType === 'fixed_price') {
            if (auction.fixedPrice <= maxWilling && player.money >= auction.fixedPrice) {
                return { action: { type: 'accept_fixed_price', playerId }, reasoning: '即買い' };
            }
            return { action: { type: 'decline_fixed_price', playerId }, reasoning: '見送り' };
        }
        const minBid = (auction.currentBid || 0) + 1;
        if (minBid <= maxWilling && minBid <= player.money) {
            const bidAmount = Math.min(minBid + Math.floor(Math.random() * 5) + 2, maxWilling, player.money);
            return {
                action: { type: 'bid', playerId, amount: bidAmount },
                reasoning: `攻めの${bidAmount}入札`,
            };
        }
        return { action: { type: 'pass_bid', playerId }, reasoning: 'さすがにパス' };
    },
};
// ── バランス戦略 ──
const balancedStrategy = {
    id: 'ma_balanced',
    name: 'バランス派',
    description: '状況に応じた柔軟な戦略',
    personality: '市場の流れを読み、適切なタイミングで売買する老練な画商',
    selectCardToPlay(state, playerId) {
        const player = getPlayer(state, playerId);
        // 累積価値 + 場の枚数のバランスで選ぶ
        const scored = player.hand.map(card => {
            const cumValue = state.artistValues[card.artist];
            const played = state.playedCardsThisRound[card.artist] || 0;
            const myPaintings = getMyPaintingCount(state, playerId, card.artist);
            return { card, score: cumValue * 0.5 + played * 10 + myPaintings * 15 };
        });
        scored.sort((a, b) => b.score - a.score);
        const card = scored[0].card;
        if (card.auctionType === 'double') {
            const pair = player.hand.find(c => c.id !== card.id && c.artist === card.artist);
            if (pair) {
                return {
                    action: { type: 'play_double', playerId, cardId: card.id, pairCardId: pair.id },
                    reasoning: `${card.artist}ダブルでバランスよく`,
                };
            }
        }
        return {
            action: { type: 'play_card', playerId, cardId: card.id },
            reasoning: `${card.artist}を出品（スコア${Math.round(scored[0].score)}）`,
        };
    },
    selectBid(state, playerId) {
        const auction = state.auctionState;
        const estimatedValue = estimateArtistValue(state, auction.card.artist);
        const player = getPlayer(state, playerId);
        const myPaintings = getMyPaintingCount(state, playerId, auction.card.artist);
        const isDouble = !!auction.doubleCard;
        const multiplier = isDouble ? 2 : 1;
        // 既に持っている絵が多ければ高く入札する価値がある
        const bonus = myPaintings > 0 ? 1.1 : 1.0;
        const maxWilling = Math.floor(estimatedValue * 0.7 * multiplier * bonus);
        if (auction.auctionType === 'sealed') {
            const bid = Math.min(Math.floor(maxWilling * 0.65), player.money);
            return {
                action: { type: 'submit_sealed_bid', playerId, amount: Math.max(0, bid) },
                reasoning: `密封入札: ${bid}`,
            };
        }
        if (auction.auctionType === 'fixed_price') {
            if (auction.fixedPrice <= maxWilling && player.money >= auction.fixedPrice) {
                return { action: { type: 'accept_fixed_price', playerId }, reasoning: '適正価格で購入' };
            }
            return { action: { type: 'decline_fixed_price', playerId }, reasoning: '割高' };
        }
        const minBid = (auction.currentBid || 0) + 1;
        if (minBid <= maxWilling && minBid <= player.money) {
            const bidAmount = Math.min(minBid + Math.floor(Math.random() * 3), maxWilling, player.money);
            return {
                action: { type: 'bid', playerId, amount: bidAmount },
                reasoning: `${bidAmount}で入札`,
            };
        }
        return { action: { type: 'pass_bid', playerId }, reasoning: 'パス' };
    },
};
// ── エクスポート ──
const strategies = new Map([
    ['ma_conservative', conservativeStrategy],
    ['ma_aggressive', aggressiveStrategy],
    ['ma_balanced', balancedStrategy],
]);
export function getModernArtStrategy(id) {
    const s = strategies.get(id);
    if (!s)
        throw new Error(`Unknown strategy: ${id}`);
    return s;
}
export function getRandomModernArtStrategy() {
    const ids = [...strategies.keys()];
    return strategies.get(ids[Math.floor(Math.random() * ids.length)]);
}
export const modernArtStrategyIds = [...strategies.keys()];
// 固定価格設定用（売主AI向け）
export function aiSetFixedPrice(state, playerId, strategy) {
    const auction = state.auctionState;
    const estimatedValue = estimateArtistValue(state, auction.card.artist);
    const isDouble = !!auction.doubleCard;
    const multiplier = isDouble ? 2 : 1;
    let price;
    switch (strategy.id) {
        case 'ma_conservative':
            price = Math.floor(estimatedValue * 0.8 * multiplier);
            break;
        case 'ma_aggressive':
            price = Math.floor(estimatedValue * 0.95 * multiplier);
            break;
        default:
            price = Math.floor(estimatedValue * 0.85 * multiplier);
    }
    price = Math.max(1, price);
    return { price, reasoning: `固定価格 ${price} に設定` };
}
