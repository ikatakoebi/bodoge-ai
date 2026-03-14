/**
 * Modern Art プレイコントローラー
 * 人間 vs AI の対戦を管理
 */
import { createModernArtGame, getCurrentPlayer, executeAction, getAvailableActions, isModernArtGameOver, getModernArtFinalScores, getPlayer, auctionTypeName, artistEmoji, } from '../engine/modern-art.js';
import { getModernArtStrategy, getRandomModernArtStrategy, aiSetFixedPrice } from '../ai/modern-art-strategies.js';
import { ARTIST_NAMES } from '../engine/modern-art-types.js';
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ── コントローラー ──
export class ModernArtPlayController {
    state;
    strategies = new Map();
    humanPlayerIds = new Set();
    opts;
    players = [];
    log = [];
    resolveAction = null;
    waitingForHuman = false;
    waitingPlayerId = '';
    aborted = false;
    finished = false;
    finalScores = null;
    onUpdate = null;
    _strategyNames = [];
    constructor(opts = {}) {
        const humanIndices = opts.humanPlayerIndices ?? [0];
        const playerCount = opts.playerCount ?? Math.max(3, humanIndices.length + (opts.aiStrategies?.length ?? 2));
        this.opts = {
            humanPlayerIndices: humanIndices.length > 0 ? humanIndices : [0],
            humanNames: opts.humanNames ?? [],
            aiStrategies: opts.aiStrategies ?? [],
            aiDelay: opts.aiDelay ?? 1500,
            playerCount: Math.min(5, Math.max(3, playerCount)),
        };
        const strategyNames = [];
        const humanIdxSet = new Set(this.opts.humanPlayerIndices);
        let aiIdx = 0;
        for (let i = 0; i < this.opts.playerCount; i++) {
            if (humanIdxSet.has(i)) {
                const humanIdx = this.opts.humanPlayerIndices.indexOf(i);
                const humanName = this.opts.humanNames[humanIdx] || 'あなた';
                this.players.push({ id: `p${i}`, name: humanName, type: 'human' });
                this.humanPlayerIds.add(`p${i}`);
                strategyNames.push(humanName);
            }
            else {
                const stratId = this.opts.aiStrategies[aiIdx] ?? getRandomModernArtStrategy().id;
                const strategy = getModernArtStrategy(stratId);
                this.players.push({
                    id: `p${i}`, name: strategy.name, type: 'ai',
                    strategyId: stratId, personalityDesc: strategy.personality,
                });
                this.strategies.set(`p${i}`, strategy);
                strategyNames.push(strategy.name);
                aiIdx++;
            }
        }
        this.state = undefined;
        this._strategyNames = strategyNames;
    }
    // ── Public API ──
    setOnUpdate(cb) { this.onUpdate = cb; }
    initGame() {
        this.state = createModernArtGame(this.players);
        this.addLog(`モダンアート開始！ ${this._strategyNames.join(' / ')}`);
    }
    getHumanPlayerIds() { return [...this.humanPlayerIds]; }
    selectAction(index, playerId) {
        if (!this.waitingForHuman)
            return false;
        if (!this.resolveAction)
            return false;
        if (playerId && playerId !== this.waitingPlayerId)
            return false;
        const actions = getAvailableActions(this.state, this.waitingPlayerId);
        if (index < 0 || index >= actions.length)
            return false;
        this.waitingForHuman = false;
        const action = actions[index];
        const resolve = this.resolveAction;
        this.resolveAction = null;
        resolve(action);
        return true;
    }
    submitBid(amount, playerId) {
        if (!this.waitingForHuman)
            return false;
        if (!this.resolveAction)
            return false;
        if (playerId && playerId !== this.waitingPlayerId)
            return false;
        const auction = this.state.auctionState;
        if (!auction)
            return false;
        const player = getPlayer(this.state, this.waitingPlayerId);
        if (amount > player.money)
            return false;
        let action;
        if (auction.auctionType === 'sealed') {
            action = { type: 'submit_sealed_bid', playerId: this.waitingPlayerId, amount };
        }
        else if (this.state.phase === 'set_fixed_price') {
            action = { type: 'set_fixed_price', playerId: this.waitingPlayerId, price: amount };
        }
        else {
            if (amount <= auction.currentBid)
                return false;
            action = { type: 'bid', playerId: this.waitingPlayerId, amount };
        }
        this.waitingForHuman = false;
        const resolve = this.resolveAction;
        this.resolveAction = null;
        resolve(action);
        return true;
    }
    abort() { this.aborted = true; this.resolveAction?.(null); }
    getGameInfo() {
        const current = this.state ? getCurrentPlayer(this.state) : null;
        const firstHumanId = this.humanPlayerIds.values().next().value || 'p0';
        const humanIds = [...this.humanPlayerIds];
        const players = this.state?.players.map(p => ({
            id: p.config.id,
            name: p.config.name,
            isHuman: this.humanPlayerIds.has(p.config.id),
            money: p.money,
            handCount: p.hand.length,
            paintingCounts: ARTIST_NAMES.reduce((acc, a) => {
                acc[a] = p.paintings.filter(pt => pt.artist === a).length;
                return acc;
            }, {}),
        })) ?? [];
        // 人間プレイヤーの手札
        const humanPlayer = this.state?.players.find(p => p.config.id === firstHumanId);
        // 利用可能アクション
        const actions = this.waitingForHuman
            ? getAvailableActions(this.state, this.waitingPlayerId)
            : [];
        const actionChoices = actions.map((a, i) => ({
            index: i,
            description: describeAction(a, this.state),
            category: categorizeAction(a),
            action: a,
        }));
        // 入札入力が必要か
        const needsBidInput = this.waitingForHuman && this.state?.auctionState != null && (this.state.auctionState.auctionType === 'open' ||
            this.state.auctionState.auctionType === 'once_around' ||
            this.state.auctionState.auctionType === 'sealed' ||
            this.state.phase === 'set_fixed_price');
        const minBid = this.state?.auctionState
            ? (this.state.phase === 'set_fixed_price' ? 1 : (this.state.auctionState.currentBid || 0) + 1)
            : 1;
        const maxBid = humanPlayer?.money ?? 100;
        // オークション状態
        let auctionInfo = null;
        if (this.state?.auctionState) {
            const a = this.state.auctionState;
            const seller = getPlayer(this.state, a.sellerId);
            let waitingId = null;
            let waitingName = null;
            if (a.auctionType === 'open' || a.auctionType === 'once_around') {
                const wp = this.state.players[a.biddingPlayerIndex];
                waitingId = wp.config.id;
                waitingName = wp.config.name;
            }
            else if (a.auctionType === 'fixed_price') {
                const wp = this.state.players[a.fixedAskPlayerIndex];
                waitingId = wp.config.id;
                waitingName = wp.config.name;
            }
            auctionInfo = {
                artist: a.card.artist,
                auctionType: a.auctionType,
                sellerName: seller.config.name,
                sellerId: a.sellerId,
                currentBid: a.currentBid,
                currentBidderName: a.currentBidderId ? getPlayer(this.state, a.currentBidderId).config.name : null,
                isDouble: !!a.doubleCard,
                fixedPrice: a.fixedPrice,
                waitingForPlayerId: waitingId,
                waitingForPlayerName: waitingName,
            };
        }
        return {
            round: this.state?.round ?? 1,
            phase: this.state?.phase ?? 'play_card',
            currentPlayerId: current?.config.id ?? 'p0',
            currentPlayerName: current?.config.name ?? '',
            isHumanTurn: this.waitingForHuman && this.humanPlayerIds.has(this.waitingPlayerId),
            players,
            humanPlayerId: firstHumanId,
            humanPlayerIds: humanIds,
            artistValues: this.state?.artistValues ?? { 'Lite Metal': 0, 'Yoko': 0, 'Christin P': 0, 'Karl Gitter': 0, 'Krypto': 0 },
            playedCardsThisRound: this.state?.playedCardsThisRound ?? { 'Lite Metal': 0, 'Yoko': 0, 'Christin P': 0, 'Karl Gitter': 0, 'Krypto': 0 },
            roundResults: this.state?.roundResults ?? [],
            auctionState: auctionInfo,
            myHand: humanPlayer?.hand ?? [],
            availableActions: actionChoices,
            needsBidInput: needsBidInput ?? false,
            minBid,
            maxBid,
            log: this.log.slice(-100),
            gameOver: this.finished,
            finalScores: this.finalScores,
        };
    }
    // ── メインループ ──
    async run() {
        if (!this.state)
            this.initGame();
        while (!isModernArtGameOver(this.state) && !this.aborted) {
            try {
                const current = getCurrentPlayer(this.state);
                const isHuman = this.humanPlayerIds.has(current.config.id);
                if (this.state.phase === 'play_card') {
                    if (isHuman) {
                        const action = await this.waitForHumanAction(current.config.id);
                        if (this.aborted)
                            break;
                        this.addLog(`🎮 ${current.config.name}: ${describeAction(action, this.state)}`);
                        this.state = executeAction(this.state, action);
                    }
                    else {
                        const strategy = this.strategies.get(current.config.id);
                        const { action, reasoning } = strategy.selectCardToPlay(this.state, current.config.id);
                        this.addLog(`${artistEmoji(this.state.players.find(p => p.config.id === current.config.id).hand[0]?.artist ?? 'Krypto')} ${current.config.name}: ${describeAction(action, this.state)}`);
                        if (reasoning)
                            this.addLog(`  💭 ${reasoning}`);
                        this.state = executeAction(this.state, action);
                        await delay(this.opts.aiDelay);
                    }
                    for (const ev of this.state.lastEvents) {
                        this.addLog(`  📦 ${ev}`);
                    }
                    this.notifyUpdate();
                }
                // オークションループ
                while ((this.state.phase === 'auction' || this.state.phase === 'set_fixed_price') && !this.aborted) {
                    await this.processAuctionStep();
                    if (this.aborted)
                        break;
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.addLog(`❌ エラー: ${msg}`);
                console.error('[modern-art] ゲームループエラー:', err);
                this.notifyUpdate();
                break;
            }
        }
        this.finished = true;
        this.finalScores = getModernArtFinalScores(this.state);
        this.addLog('');
        this.addLog('━━━ 最終結果 ━━━');
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        for (const s of this.finalScores) {
            const isHuman = this.humanPlayerIds.has(s.playerId) ? ' 👤' : '';
            this.addLog(`${medals[s.rank - 1]} ${s.rank}位 ${s.name}: 💰${s.money}${isHuman}`);
        }
        this.notifyUpdate();
    }
    // ── オークション処理 ──
    async processAuctionStep() {
        const auction = this.state.auctionState;
        if (!auction)
            return;
        // 固定価格設定フェーズ
        if (this.state.phase === 'set_fixed_price') {
            const seller = getPlayer(this.state, auction.sellerId);
            if (this.humanPlayerIds.has(seller.config.id)) {
                const action = await this.waitForHumanAction(seller.config.id);
                if (this.aborted)
                    return;
                this.state = executeAction(this.state, action);
            }
            else {
                const strategy = this.strategies.get(seller.config.id);
                const { price, reasoning } = aiSetFixedPrice(this.state, seller.config.id, strategy);
                this.state = executeAction(this.state, { type: 'set_fixed_price', playerId: seller.config.id, price });
                this.addLog(`  💭 ${reasoning}`);
                await delay(this.opts.aiDelay / 2);
            }
            for (const ev of this.state.lastEvents)
                this.addLog(`  📦 ${ev}`);
            this.notifyUpdate();
            return;
        }
        // 密封入札: 全員同時
        if (auction.auctionType === 'sealed') {
            const nonSellers = this.state.players.filter(p => p.config.id !== auction.sellerId);
            for (const p of nonSellers) {
                if (auction.sealedBids[p.config.id] !== undefined)
                    continue;
                if (this.humanPlayerIds.has(p.config.id)) {
                    const action = await this.waitForHumanAction(p.config.id);
                    if (this.aborted)
                        return;
                    this.state = executeAction(this.state, action);
                }
                else {
                    const strategy = this.strategies.get(p.config.id);
                    const { action, reasoning } = strategy.selectBid(this.state, p.config.id);
                    this.state = executeAction(this.state, action);
                    this.addLog(`  💭 ${p.config.name}: ${reasoning}`);
                    await delay(this.opts.aiDelay / 3);
                }
                for (const ev of this.state.lastEvents)
                    this.addLog(`  📦 ${ev}`);
                this.notifyUpdate();
            }
            return;
        }
        // 公開競り / 一巡競り / 固定価格
        const waitingPlayer = this.state.phase === 'auction' && auction.auctionType === 'fixed_price'
            ? this.state.players[auction.fixedAskPlayerIndex]
            : this.state.players[auction.biddingPlayerIndex];
        if (this.humanPlayerIds.has(waitingPlayer.config.id)) {
            const action = await this.waitForHumanAction(waitingPlayer.config.id);
            if (this.aborted)
                return;
            this.state = executeAction(this.state, action);
        }
        else {
            const strategy = this.strategies.get(waitingPlayer.config.id);
            const { action, reasoning } = strategy.selectBid(this.state, waitingPlayer.config.id);
            this.state = executeAction(this.state, action);
            if (reasoning)
                this.addLog(`  💭 ${waitingPlayer.config.name}: ${reasoning}`);
            await delay(this.opts.aiDelay / 2);
        }
        for (const ev of this.state.lastEvents)
            this.addLog(`  📦 ${ev}`);
        this.notifyUpdate();
    }
    // ── ヘルパー ──
    async waitForHumanAction(playerId) {
        this.waitingForHuman = true;
        this.waitingPlayerId = playerId;
        this.notifyUpdate();
        return new Promise((resolve) => {
            this.resolveAction = resolve;
        });
    }
    addLog(msg) {
        this.log.push(msg);
        if (this.log.length > 500)
            this.log.shift();
    }
    notifyUpdate() { this.onUpdate?.(); }
}
// ── 表示ヘルパー ──
function describeAction(action, state) {
    switch (action.type) {
        case 'play_card': {
            const player = getPlayer(state, action.playerId);
            const card = player.hand.find(c => c.id === action.cardId);
            if (!card)
                return '出品';
            return `${card.artist}(${auctionTypeName(card.auctionType)})を出品`;
        }
        case 'play_double': {
            const player = getPlayer(state, action.playerId);
            const card = player.hand.find(c => c.id === action.cardId);
            return `${card?.artist ?? '?'}をダブル出品`;
        }
        case 'bid': return `${action.amount}で入札`;
        case 'pass_bid': return 'パス';
        case 'set_fixed_price': return `固定価格${action.price}に設定`;
        case 'accept_fixed_price': return '購入';
        case 'decline_fixed_price': return '辞退';
        case 'submit_sealed_bid': return `密封入札: ${action.amount}`;
    }
}
function categorizeAction(action) {
    switch (action.type) {
        case 'play_card':
        case 'play_double':
            return 'play_card';
        case 'bid':
        case 'submit_sealed_bid':
            return 'bid';
        case 'pass_bid':
            return 'pass';
        case 'set_fixed_price':
            return 'fixed_price';
        case 'accept_fixed_price':
            return 'accept';
        case 'decline_fixed_price':
            return 'decline';
    }
}
