import { createGame, revealPointCard, submitSelection, resolveRound, isGameOver, getFinalScores, } from '../engine/game.js';
import { getStrategy, getRandomStrategy } from '../ai/strategies.js';
const DEFAULT_PLAYER_SLOTS = ['p0', 'p1', 'p2', 'p3', 'p4'];
const HUMAN_SLOT = 'p0';
const HUMAN_ID = 'human_p1';
// cards.csvのID体系と一致させる
const POINT_VALUES = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const POINT_VALUE_TO_DEF_ID = new Map(POINT_VALUES.map((v, i) => [v, `P${String(i + 1).padStart(2, '0')}`]));
const SLOT_TO_LABEL = { p0: 'A', p1: 'B', p2: 'C', p3: 'D', p4: 'E' };
/**
 * Human vs AI play mode, controlled via the bodoge_testplay board.
 *
 * The human selects a card via the browser control panel (setHumanSelection).
 * The card is then moved on the board automatically, keeping the browser
 * visualization in sync.
 */
export class PlayController {
    client;
    opts;
    players = [];
    /** Map: playerId → board slot */
    playerSlotMap = new Map();
    // Browser-input state
    _humanHand = [];
    _waitingForHuman = false;
    _humanSelectionResolve = null;
    _lastBoardState = null;
    _gameState = null;
    _finished = false;
    _aborted = false;
    _finalScores = null;
    _currentPointCard = null;
    _currentCarryOver = [];
    _lastRoundResult = '';
    _round = 0;
    _totalRounds = 0;
    constructor(client, opts = {}) {
        this.client = client;
        this.opts = {
            playerCount: opts.playerCount ?? 3,
            aiStrategies: opts.aiStrategies ?? [],
            delay: opts.delay ?? 1500,
            playerSlots: opts.playerSlots ?? DEFAULT_PLAYER_SLOTS,
        };
    }
    // ── Public API for browser control ─────────────────────────────────────────
    /** Returns the human's current hand (available cards). */
    getHumanHand() {
        return [...this._humanHand];
    }
    /** Returns current game info for browser display. */
    getGameInfo() {
        const scores = {};
        const playerNames = {};
        if (this._gameState) {
            for (const p of this._gameState.players) {
                const slot = this.playerSlotMap.get(p.config.id) ?? p.config.id;
                scores[slot] = p.score;
                playerNames[slot] = p.config.name;
            }
        }
        return {
            round: this._round,
            totalRounds: this._totalRounds,
            pointCard: this._currentPointCard,
            carryOver: [...this._currentCarryOver],
            humanHand: [...this._humanHand],
            waitingForHuman: this._waitingForHuman,
            finished: this._finished,
            finalScores: this._finalScores,
            scores,
            playerNames,
            lastRoundResult: this._lastRoundResult,
        };
    }
    /**
     * Called by the browser when the human selects a card.
     * Returns true if the selection was accepted, false if not valid.
     */
    setHumanSelection(card) {
        if (!this._waitingForHuman)
            return false;
        if (!this._humanHand.includes(card))
            return false;
        if (!this._humanSelectionResolve)
            return false;
        this._waitingForHuman = false;
        const resolve = this._humanSelectionResolve;
        this._humanSelectionResolve = null;
        resolve(card);
        return true;
    }
    /**
     * Force-stop the game (e.g. user clicked "中断").
     * Sets the abort flag and resolves any pending human-input promise.
     */
    abort() {
        this._aborted = true;
        this._finished = true;
        this.client.onBoardAction(null);
        this.client.onConfirmTurn(null);
        if (this._waitingForHuman && this._humanSelectionResolve) {
            const resolve = this._humanSelectionResolve;
            this._humanSelectionResolve = null;
            this._waitingForHuman = false;
            resolve(this._humanHand[0] ?? 1);
        }
    }
    // ── helpers ────────────────────────────────────────────────────────────────
    findHandCard(slot, value) {
        const label = SLOT_TO_LABEL[slot];
        if (!label)
            return null;
        const defId = `H${String(value).padStart(2, '0')}_${label}`;
        const cards = this.client.getCardsInArea(`p_hand_${slot}`);
        return cards.find((c) => c.definitionId === defId)?.instanceId ?? null;
    }
    findPointCardInDeck(value) {
        const defId = POINT_VALUE_TO_DEF_ID.get(value);
        if (!defId)
            return null;
        const cards = this.client.getCardsInArea('point_deck');
        return cards.find((c) => c.definitionId === defId)?.instanceId ?? null;
    }
    /**
     * definitionId (例: "H05_A") からカード番号を取り出す
     */
    defIdToCardNumber(defId) {
        const m = defId.match(/^H(\d+)_/);
        return m ? parseInt(m[1], 10) : null;
    }
    /**
     * Wait for the human to select a card via the browser control panel
     * OR by moving a card on the board (hand → played area).
     */
    waitForHumanCard(validHand) {
        this._humanHand = [...validHand].sort((a, b) => a - b);
        this._waitingForHuman = true;
        console.log(`\n[play] あなたの手札: ${this._humanHand.join(', ')}`);
        console.log('[play] ボード上でカードを動かすか、コントロールパネルから選択してください');
        // ボード操作検知: handエリアから消えたカードを検出
        const handAreaId = `p_hand_${HUMAN_SLOT}`;
        const beforeHandIds = new Set(this.client.getCardsInArea(handAreaId).map((c) => c.definitionId));
        // ボード状態の差分から動かされたカードを検出するヘルパー
        const detectMovedCard = (incomingState) => {
            const currentHandDefIds = new Set();
            for (const inst of Object.values(incomingState.cardInstances)) {
                if (beforeHandIds.has(inst.definitionId)) {
                    const bridgeInst = this.client.getState().cardInstances[inst.instanceId];
                    if (bridgeInst && (inst.x !== bridgeInst.x || inst.y !== bridgeInst.y)) {
                        const cardNum = this.defIdToCardNumber(inst.definitionId);
                        if (cardNum !== null && this._humanHand.includes(cardNum)) {
                            return cardNum;
                        }
                    }
                    currentHandDefIds.add(inst.definitionId);
                }
            }
            for (const defId of beforeHandIds) {
                if (!currentHandDefIds.has(defId)) {
                    const cardNum = this.defIdToCardNumber(defId);
                    if (cardNum !== null && this._humanHand.includes(cardNum)) {
                        return cardNum;
                    }
                }
            }
            return null;
        };
        // ボード状態を常に最新に保つ（確定ボタン押下時に参照する）
        this._lastBoardState = null;
        this.client.onBoardAction((incomingState) => {
            if (!this._waitingForHuman)
                return;
            this._lastBoardState = incomingState;
        });
        // ターン確定ボタン: ボードの現在状態を読み取って判定
        this.client.onConfirmTurn(() => {
            if (!this._waitingForHuman)
                return;
            console.log('[play] ターン確定シグナル受信');
            if (this._lastBoardState) {
                const cardNum = detectMovedCard(this._lastBoardState);
                if (cardNum !== null) {
                    console.log(`[play] 確定: カード ${cardNum}`);
                    this.setHumanSelection(cardNum);
                }
                else {
                    console.log('[play] 確定押されたが、手札から動かされたカードが検出できない');
                    this.client.setAnnouncement('⚠️ 手札からカードを動かしてから確定してください');
                    this.client.sendState();
                }
            }
        });
        return new Promise((resolve) => {
            this._humanSelectionResolve = (card) => {
                this.client.onBoardAction(null);
                this.client.onConfirmTurn(null);
                resolve(card);
            };
        });
    }
    findRoundCounter() {
        const state = this.client.getState();
        const counter = Object.values(state.counters).find((c) => c.name.toLowerCase().includes('round') || c.name.toLowerCase().includes('ラウンド'));
        return counter?.counterId ?? null;
    }
    // ── setup ──────────────────────────────────────────────────────────────────
    setupPlayers() {
        const aiCount = this.opts.playerCount - 1;
        const aiStrategies = this.opts.aiStrategies.length >= aiCount
            ? this.opts.aiStrategies.slice(0, aiCount)
            : Array.from({ length: aiCount }, (_, i) => this.opts.aiStrategies[i] ?? getRandomStrategy().id);
        this.players = [
            {
                id: HUMAN_ID,
                name: '人間プレイヤー',
                type: 'human',
            },
            ...aiStrategies.map((sid, i) => {
                const strategy = getStrategy(sid);
                return {
                    id: `ai_${i + 1}`,
                    name: `${strategy.name}AI`,
                    type: 'ai',
                    strategyId: sid,
                    personalityDesc: strategy.personality,
                };
            }),
        ];
        // Map to board slots
        for (let i = 0; i < this.players.length; i++) {
            this.playerSlotMap.set(this.players[i].id, this.opts.playerSlots[i]);
        }
        console.log('[play] ========================================');
        console.log('[play] ハゲタカの餌食 — 人間 vs AI');
        console.log('[play] ========================================');
        console.log(`[play] あなた: P1 (slot ${HUMAN_SLOT})`);
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            if (p.type === 'ai') {
                console.log(`[play] AI ${i}: ${p.name} (${p.strategyId})`);
            }
        }
        console.log('[play] ========================================');
    }
    // ── main loop ─────────────────────────────────────────────────────────────
    async run() {
        await this.client.waitForState();
        // プレイ中はBridgeがソースオブトゥルース — サーバーからのエコーを無視
        this.client.setSuppressIncoming(true);
        this.client.setHumanSlot(HUMAN_SLOT);
        this.setupPlayers();
        let gameState = createGame(this.players);
        this._gameState = gameState;
        this._totalRounds = gameState.totalRounds;
        const roundCounter = this.findRoundCounter();
        const scoreCounters = this.client.findScoreCounters();
        // Reposition score counters next to each player's won area.
        // Won areas: x=154, width=80 → end at x=234 grid units = 2340px.
        // Counter x = 2340 + 20 = 2360px (20px padding to the right).
        // Counter y = center of player row = rowY * 10 + 90 (half of 18 grid units * 10px).
        const SLOT_ROW_Y = { p0: 90, p1: 0, p2: 72, p3: 18, p4: 54 };
        for (const [slot, counterId] of scoreCounters) {
            const rowY = SLOT_ROW_Y[slot];
            if (rowY !== undefined) {
                this.client.repositionCounter(counterId, 2360, rowY * 10 + 90);
            }
        }
        this.client.sendState();
        while (!isGameOver(gameState)) {
            gameState = revealPointCard(gameState);
            if (gameState.currentPointCard === null)
                break;
            this._gameState = gameState;
            const pointCard = gameState.currentPointCard;
            this._currentPointCard = pointCard;
            this._currentCarryOver = [...gameState.carryOver];
            this._round = gameState.round;
            this._lastRoundResult = '';
            console.log(`\n[play] === ラウンド ${gameState.round} / ${gameState.totalRounds} ===`);
            console.log(`[play] 得点カード: ${pointCard > 0 ? '+' : ''}${pointCard}`);
            if (gameState.carryOver.length > 0) {
                const carryTotal = gameState.carryOver.reduce((s, c) => s + c, 0);
                console.log(`[play] キャリーオーバー: ${gameState.carryOver.join(', ')} (合計: ${carryTotal > 0 ? '+' : ''}${carryTotal})`);
            }
            // Update round counter on board
            if (roundCounter) {
                this.client.updateCounter(roundCounter, gameState.round);
                this.client.sendState();
            }
            // Reveal point card on board
            const pointInstanceId = this.findPointCardInDeck(pointCard);
            if (pointInstanceId) {
                this.client.moveCardToArea(pointInstanceId, 'point_current', true, 0);
                this.client.sendState();
            }
            // Handle carry-over: move any already-in-deck carry-over cards to current
            for (let i = 0; i < gameState.carryOver.length; i++) {
                const coId = this.findPointCardInDeck(gameState.carryOver[i]);
                if (coId) {
                    this.client.moveCardToArea(coId, 'point_current', true, i + 1);
                }
            }
            this.client.sendState();
            await this.client.delay(this.opts.delay);
            // Wait for human to select a card via browser
            const slotLabel = SLOT_TO_LABEL[HUMAN_SLOT] || 'A';
            this.client.setAnnouncement(`🎮 あなたはプレイヤー${slotLabel}（一番下の行）です！手札から1枚ドラッグで出してください（得点カード: ${pointCard > 0 ? '+' : ''}${pointCard}）`);
            this.client.sendState();
            const humanState = gameState.players.find((p) => p.config.id === HUMAN_ID);
            const humanCard = await this.waitForHumanCard(humanState.hand);
            this.client.setAnnouncement(null);
            // If aborted while waiting, exit loop
            if (this._aborted)
                break;
            // Move human's card on the board (face up)
            const humanSlot = this.playerSlotMap.get(HUMAN_ID);
            const humanCardId = this.findHandCard(humanSlot, humanCard);
            if (humanCardId) {
                this.client.moveCardToArea(humanCardId, `p_played_${humanSlot}`, true, 0);
                this.client.sendState();
            }
            gameState = submitSelection(gameState, HUMAN_ID, humanCard);
            this._gameState = gameState;
            // AI players select cards
            const reasoning = {};
            for (const player of gameState.players) {
                if (player.config.id === HUMAN_ID)
                    continue;
                const strategy = getStrategy(player.config.strategyId);
                const { card, reasoning: reason } = strategy.selectCard(gameState, player.config.id);
                reasoning[player.config.id] = reason;
                gameState = submitSelection(gameState, player.config.id, card);
                this._gameState = gameState;
                // Move AI card on board (face down during selection, then reveal)
                const slot = this.playerSlotMap.get(player.config.id);
                const aiCardId = this.findHandCard(slot, card);
                if (aiCardId) {
                    // Initially face down
                    this.client.moveCardToArea(aiCardId, `p_played_${slot}`, false, 0);
                    this.client.sendState();
                    await this.client.delay(this.opts.delay / 2);
                }
            }
            // Resolve round
            const { state: newState, result } = resolveRound(gameState, reasoning);
            gameState = newState;
            this._gameState = gameState;
            // Reveal all AI cards face up
            for (const player of gameState.players) {
                if (player.config.id === HUMAN_ID)
                    continue;
                const slot = this.playerSlotMap.get(player.config.id);
                const playedCards = this.client.getCardsInArea(`p_played_${slot}`);
                for (const card of playedCards) {
                    this.client.moveCardToPosition(card.instanceId, card.x, card.y, true);
                }
            }
            this.client.sendState();
            // Display round summary
            console.log('\n[play] ── カード公開 ──────────────────────────');
            const resultLines = [];
            for (const sel of result.selections) {
                const p = this.players.find((p) => p.id === sel.playerId);
                const isWinner = sel.playerId === result.winnerId;
                const tag = isWinner ? ' ← 勝利!' : '';
                console.log(`[play]   ${p.name}: ${sel.card}${tag}`);
                if (reasoning[sel.playerId]) {
                    console.log(`[play]     思考: ${reasoning[sel.playerId]}`);
                }
                resultLines.push(`${p.name}: ${sel.card}${tag}`);
            }
            if (result.winnerId) {
                const winner = this.players.find((p) => p.id === result.winnerId);
                const allPoints = [...result.carryOver, result.pointCard];
                const total = allPoints.reduce((s, c) => s + c, 0);
                console.log(`[play] 勝者: ${winner.name} → ${total > 0 ? '+' : ''}${total}点獲得`);
                this._lastRoundResult = `${winner.name}が${total > 0 ? '+' : ''}${total}点獲得！`;
                // Move point cards to winner's won area
                const winnerSlot = this.playerSlotMap.get(result.winnerId);
                const existingWonCards = this.client.getCardsInArea(`p_won_${winnerSlot}`);
                const baseOffset = existingWonCards.length;
                const pointCurrentCards = this.client.getCardsInArea('point_current');
                for (let i = 0; i < pointCurrentCards.length; i++) {
                    this.client.moveCardToArea(pointCurrentCards[i].instanceId, `p_won_${winnerSlot}`, true, baseOffset + i);
                }
            }
            else {
                console.log('[play] 引き分け — 得点カードは次のラウンドに持ち越し!');
                this._lastRoundResult = '引き分け — 次のラウンドに持ち越し！';
            }
            // Update all score counters on board
            for (const player of gameState.players) {
                const slot = this.playerSlotMap.get(player.config.id);
                if (slot) {
                    const counterId = scoreCounters.get(slot);
                    if (counterId) {
                        this.client.updateCounter(counterId, player.score);
                    }
                }
            }
            this.client.sendState();
            await this.client.delay(this.opts.delay);
            // Discard played hand cards
            for (const player of gameState.players) {
                const slot = this.playerSlotMap.get(player.config.id);
                const playedCards = this.client.getCardsInArea(`p_played_${slot}`);
                for (const card of playedCards) {
                    this.client.discardCard(card.instanceId);
                }
            }
            this.client.sendState();
            await this.client.delay(this.opts.delay / 2);
            // Current scores summary
            console.log('[play] ── 現在のスコア ──────────────────────────');
            const sortedPlayers = [...gameState.players].sort((a, b) => b.score - a.score);
            for (const p of sortedPlayers) {
                const isHuman = p.config.id === HUMAN_ID;
                const tag = isHuman ? ' ← あなた' : '';
                console.log(`[play]   ${p.config.name}: ${p.score > 0 ? '+' : ''}${p.score}点${tag}`);
            }
        }
        // Final scores
        const finalScores = getFinalScores(gameState);
        this._finalScores = finalScores;
        this._finished = true;
        this._waitingForHuman = false;
        this._humanHand = [];
        console.log('\n[play] ========================================');
        console.log('[play] ゲーム終了!');
        console.log('[play] ========================================');
        for (const s of finalScores) {
            const isHuman = s.playerId === HUMAN_ID;
            const tag = isHuman ? ' ← あなた' : '';
            console.log(`[play]   ${s.rank}位  ${s.name}: ${s.score}点${tag}`);
        }
        console.log('[play] ========================================');
        this.client.setHumanSlot(null);
        this.client.setSuppressIncoming(false);
    }
}
