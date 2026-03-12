const DEFAULT_PLAYER_SLOTS = ['p0', 'p1', 'p2', 'p3', 'p4'];
// cards.csvのID体系:
//   ポイントカード: P01(-5), P02(-4), ..., P05(-1), P06(1), ..., P15(10)
//   手札カード: H01_A(P1の1), H02_A(P1の2), ..., H15_E(P5の15)
const POINT_VALUES = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const POINT_VALUE_TO_DEF_ID = new Map(POINT_VALUES.map((v, i) => [v, `P${String(i + 1).padStart(2, '0')}`]));
const SLOT_TO_LABEL = { p0: 'A', p1: 'B', p2: 'C', p3: 'D', p4: 'E' };
export class ReplayController {
    client;
    log;
    opts;
    stepCtrl;
    /** Map: playerId → board slot (p0, p1, ...) */
    playerSlotMap = new Map();
    /** Map: slot → cumulative score */
    playerScores = new Map();
    /** Snapshots saved at the start of each round for rewind support */
    stateSnapshots = [];
    constructor(log, client, opts = {}) {
        this.log = log;
        this.client = client;
        this.opts = {
            delay: opts.delay ?? 2000,
            cardDelay: opts.cardDelay ?? 400,
            playerSlots: opts.playerSlots ?? DEFAULT_PLAYER_SLOTS,
            stepController: opts.stepController,
        };
        this.stepCtrl = opts.stepController;
        // Map players in log order → slots
        for (let i = 0; i < log.players.length; i++) {
            this.playerSlotMap.set(log.players[i].id, this.opts.playerSlots[i]);
        }
    }
    // ── helpers ────────────────────────────────────────────────────────────────
    /** Find the instance ID of a point card with a given numeric value. */
    findPointCardInDeck(value) {
        const defId = POINT_VALUE_TO_DEF_ID.get(value);
        if (!defId)
            return null;
        const cards = this.client.getCardsInArea('point_deck');
        return cards.find((c) => c.definitionId === defId)?.instanceId ?? null;
    }
    /** Find a hand card instance for a specific player slot and numeric value. */
    findHandCard(slot, value) {
        const label = SLOT_TO_LABEL[slot];
        if (!label)
            return null;
        const defId = `H${String(value).padStart(2, '0')}_${label}`;
        const cards = this.client.getCardsInArea(`p_hand_${slot}`);
        return cards.find((c) => c.definitionId === defId)?.instanceId ?? null;
    }
    /** Find the current round counter (if any). */
    findRoundCounter() {
        const state = this.client.getState();
        const counter = Object.values(state.counters).find((c) => c.name.toLowerCase().includes('round') || c.name.toLowerCase().includes('ラウンド'));
        return counter?.counterId ?? null;
    }
    /**
     * Returns true when we are in step mode (paused, waiting for user to click step).
     * In step mode, small inter-card delays should be skipped.
     */
    isStepMode() {
        if (!this.stepCtrl)
            return false;
        return this.stepCtrl.isPaused === true;
    }
    /**
     * Unified delay helper for MAJOR step points. When a StepController is active,
     * hands off to it so the user can pause/step; otherwise falls back to a plain timer.
     * Returns false if the user requested quit.
     */
    async waitOrDelay(ms) {
        if (this.stepCtrl) {
            return this.stepCtrl.delayOrStep(ms);
        }
        await this.client.delay(ms);
        return true;
    }
    /**
     * Small delay used between individual card plays (animation).
     * Skipped entirely in step mode so multiple card plays don't each require a click.
     */
    async quickDelay(ms) {
        if (this.isStepMode())
            return; // Skip small delays in step mode
        if (this.stepCtrl) {
            // In auto-play mode with a stepCtrl, respect quit
            await new Promise((r) => setTimeout(r, ms));
            return;
        }
        await this.client.delay(ms);
    }
    // ── snapshot / rewind ──────────────────────────────────────────────────────
    /** Save a deep-copy snapshot of current board state (called at start of each round). */
    saveSnapshot() {
        const snapshot = JSON.parse(JSON.stringify(this.client.getState()));
        this.stateSnapshots.push(snapshot);
    }
    /**
     * Restore the previous round's board state.
     * Returns true if successful, false if already at the beginning.
     */
    async stepBack() {
        if (this.stateSnapshots.length <= 1)
            return false;
        this.stateSnapshots.pop(); // Remove current round snapshot
        const prev = this.stateSnapshots[this.stateSnapshots.length - 1];
        this.client.restoreState(prev);
        this.client.sendState();
        return true;
    }
    // ── main replay ─────────────────────────────────────────────────────────────
    async run() {
        console.log(`[replay] Starting replay: ${this.log.gameName} (${this.log.gameId})`);
        console.log(`[replay] ${this.log.players.length} players, ${this.log.rounds.length} rounds`);
        // Wait for initial state
        await this.client.waitForState();
        console.log('[replay] State synced, beginning replay...');
        // リプレイ中はBridgeがソースオブトゥルース — サーバーからのエコーを無視
        this.client.setSuppressIncoming(true);
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
        // 初期配置のスナップショットを保存（ここまで戻れるようにする）
        this.saveSnapshot();
        // Initialize per-player scores to 0
        for (const slot of this.opts.playerSlots.slice(0, this.log.players.length)) {
            this.playerScores.set(slot, 0);
        }
        try {
            for (const round of this.log.rounds) {
                const ok = await this.replayRound(round, roundCounter, scoreCounters);
                if (!ok) {
                    console.log('[replay] Quit requested — stopping replay.');
                    return;
                }
            }
            // Show final scores
            await this.showFinalScores(this.log.finalScores);
            console.log('[replay] Replay complete!');
        }
        finally {
            this.client.setSuppressIncoming(false);
        }
    }
    /** Returns false if quit was requested mid-round. */
    async replayRound(round, roundCounterId, scoreCounters) {
        console.log(`[replay] Round ${round.round}: point card ${round.pointCard}`);
        this.stepCtrl?.setRoundInfo(round.round, this.log.rounds.length);
        this.stepCtrl?.setStatus(`ラウンド ${round.round} 開始`);
        // Update round counter (no step pause — just a quick visual update)
        if (roundCounterId !== null) {
            this.client.updateCounter(roundCounterId, round.round);
            this.client.sendState();
        }
        // ── STEP 1: Reveal point card (+ carry-over) ──────────────────────────────
        const pointInstanceId = this.findPointCardInDeck(round.pointCard);
        if (pointInstanceId) {
            this.client.moveCardToArea(pointInstanceId, 'point_current', true, 0);
            this.client.sendState();
            console.log(`[replay]   Point card revealed: ${round.pointCard}`);
            this.stepCtrl?.setStatus(`得点カード公開: ${round.pointCard > 0 ? '+' : ''}${round.pointCard}`);
        }
        else {
            console.warn(`[replay]   Could not find point card ${round.pointCard} in deck`);
        }
        // Also move carry-over cards to point_current if not already there
        for (let i = 0; i < round.carryOver.length; i++) {
            const coInstanceId = this.findPointCardInDeck(round.carryOver[i]);
            if (coInstanceId) {
                this.client.moveCardToArea(coInstanceId, 'point_current', true, i + 1);
            }
        }
        this.client.sendState();
        // Major step pause after point card reveal
        this.saveSnapshot();
        if (!await this.waitOrDelay(this.opts.delay))
            return false;
        // ── STEP 2: All players reveal their selections (hand → played area) ──────
        for (const sel of round.selections) {
            const slot = this.playerSlotMap.get(sel.playerId);
            if (!slot) {
                console.warn(`[replay]   No slot for player ${sel.playerId}`);
                continue;
            }
            const handInstanceId = this.findHandCard(slot, sel.card);
            if (handInstanceId) {
                this.client.moveCardToArea(handInstanceId, `p_played_${slot}`, true, 0);
                this.client.sendState();
                console.log(`[replay]   Player ${sel.playerId} (slot ${slot}) plays card ${sel.card}`);
                this.stepCtrl?.setStatus(`${sel.playerId}が${sel.card}を出した`);
                // Use quickDelay — skipped in step mode so all cards appear at once per step
                await this.quickDelay(this.opts.cardDelay);
            }
            else {
                console.warn(`[replay]   Could not find hand card ${sel.card} for slot ${slot}`);
            }
        }
        // Major step pause after all players have played
        this.saveSnapshot();
        if (!await this.waitOrDelay(this.opts.delay))
            return false;
        // ── STEP 3: Resolve — move point card(s) to winner, discard played cards ──
        if (round.winnerId) {
            const winnerSlot = this.playerSlotMap.get(round.winnerId);
            if (winnerSlot) {
                console.log(`[replay]   Winner: ${round.winnerId} (slot ${winnerSlot})`);
                // Count existing cards in won area for offset (accumulates across rounds)
                const existingWonCards = this.client.getCardsInArea(`p_won_${winnerSlot}`);
                const baseOffset = existingWonCards.length;
                // Collect all cards currently in point_current
                const pointCurrentCards = this.client.getCardsInArea('point_current');
                for (let i = 0; i < pointCurrentCards.length; i++) {
                    this.client.moveCardToArea(pointCurrentCards[i].instanceId, `p_won_${winnerSlot}`, true, baseOffset + i);
                    // Use quickDelay — skipped in step mode
                    await this.quickDelay(this.opts.cardDelay);
                }
                this.client.sendState();
                // Update winner's score counter
                const roundTotal = round.pointCard + round.carryOver.reduce((s, v) => s + v, 0);
                const prevScore = this.playerScores.get(winnerSlot) ?? 0;
                const newScore = prevScore + roundTotal;
                this.playerScores.set(winnerSlot, newScore);
                const scoreCounterId = scoreCounters.get(winnerSlot);
                if (scoreCounterId) {
                    this.client.updateCounter(scoreCounterId, newScore);
                    this.client.sendState();
                    console.log(`[replay]   Score update: slot ${winnerSlot} = ${newScore}`);
                }
                // スコアをステップコントローラに通知（オプション）
                if (this.stepCtrl && typeof this.stepCtrl.setScores === 'function') {
                    this.stepCtrl.setScores(Object.fromEntries(this.playerScores));
                }
                // Round result announcement
                const winnerName = this.log.players.find((p) => p.id === round.winnerId)?.name ?? round.winnerId;
                const roundResultMsg = `🏆 ${winnerName} の勝利！ (${roundTotal > 0 ? '+' : ''}${roundTotal}点)`;
                this.stepCtrl?.setStatus(roundResultMsg);
                if (this.stepCtrl && typeof this.stepCtrl.setRoundResult === 'function') {
                    this.stepCtrl.setRoundResult(roundResultMsg);
                }
            }
        }
        else {
            console.log('[replay]   No winner — carry-over to next round');
            const drawMsg = '引き分け — 持ち越し！';
            this.stepCtrl?.setStatus(drawMsg);
            if (this.stepCtrl && typeof this.stepCtrl.setRoundResult === 'function') {
                this.stepCtrl.setRoundResult(drawMsg);
            }
            // Cards stay in point_current; they'll be found as carry-over next round
        }
        // Discard played hand cards offscreen (no individual delay needed)
        for (const sel of round.selections) {
            const slot = this.playerSlotMap.get(sel.playerId);
            if (!slot)
                continue;
            const playedCards = this.client.getCardsInArea(`p_played_${slot}`);
            for (const card of playedCards) {
                this.client.discardCard(card.instanceId);
            }
        }
        this.client.sendState();
        // Major step pause after resolving (winner gets cards, played cards discarded)
        this.saveSnapshot();
        if (!await this.waitOrDelay(this.opts.delay))
            return false;
        return true;
    }
    async showFinalScores(finalScores) {
        console.log('[replay] === FINAL SCORES ===');
        for (const s of finalScores) {
            const slot = this.playerSlotMap.get(s.playerId) ?? '?';
            console.log(`[replay]   ${s.rank}位  ${s.name} (slot ${slot}): ${s.score}点`);
        }
        // Give viewers time to see the board
        await this.waitOrDelay(this.opts.delay * 2);
    }
}
