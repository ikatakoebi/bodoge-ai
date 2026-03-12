/**
 * 魔女ゲー プレイコントローラー
 * コントロールパネル経由で人間 vs AI の対戦を管理する
 */
import { createMajoGame, getCurrentPlayer, executeAction, getAvailableActions, isMajoGameOver, getMajoFinalScores, getPlayer, getEffectiveMagicPower, } from '../engine/majo.js';
import { getMajoStrategy, getRandomMajoStrategy } from '../ai/majo-strategies.js';
// ── コントローラー ──
export class MajoPlayController {
    state;
    strategies = new Map();
    humanPlayerId;
    opts;
    players = [];
    log = [];
    resolveAction = null;
    waitingForHuman = false;
    aborted = false;
    finished = false;
    cachedActions = [];
    finalScores = null;
    onUpdate = null;
    constructor(opts = {}) {
        this.opts = {
            humanPlayerIndex: opts.humanPlayerIndex ?? 0,
            aiStrategies: opts.aiStrategies ?? [],
            aiDelay: opts.aiDelay ?? 800,
        };
        // プレイヤー設定
        const playerCount = 4;
        let aiIdx = 0;
        const strategyNames = [];
        for (let i = 0; i < playerCount; i++) {
            if (i === this.opts.humanPlayerIndex) {
                this.players.push({
                    id: `p${i}`,
                    name: 'あなた',
                    type: 'human',
                });
                strategyNames.push('人間');
            }
            else {
                const stratId = this.opts.aiStrategies[aiIdx] ?? getRandomMajoStrategy().id;
                const strategy = getMajoStrategy(stratId);
                this.players.push({
                    id: `p${i}`,
                    name: `${strategy.name}`,
                    type: 'ai',
                    strategyId: stratId,
                    personalityDesc: strategy.personality,
                });
                this.strategies.set(`p${i}`, strategy);
                strategyNames.push(strategy.name);
                aiIdx++;
            }
        }
        this.humanPlayerId = `p${this.opts.humanPlayerIndex}`;
        this.state = createMajoGame(this.players);
        this.addLog(`魔女ゲー開始！ ${strategyNames.join(' / ')}`);
    }
    // ── Public API ──
    setOnUpdate(cb) {
        this.onUpdate = cb;
    }
    getGameInfo() {
        const current = getCurrentPlayer(this.state);
        const isHumanTurn = current.config.id === this.humanPlayerId && !this.finished;
        // プレイヤー情報
        const players = this.state.players.map((p) => ({
            id: p.config.id,
            name: p.config.name,
            strategy: p.config.strategyId ?? '人間',
            isHuman: p.config.id === this.humanPlayerId,
            mana: p.mana,
            tappedMana: p.tappedMana,
            vp: p.victoryPoints,
            tools: p.magicTools.map((t) => ({
                id: t.id,
                name: t.name,
                type: t.type,
                magicPower: t.magicPower,
                effect: t.effect,
                tapped: p.tappedToolIds.includes(t.id),
            })),
            saints: p.saints.map((s) => ({ id: s.id, name: s.name, vp: s.victoryPoints })),
            relics: p.relics.map((r) => ({ id: r.id, effect: r.effect, timing: r.timing })),
            witchUsed: p.witchTapped,
            familiarUsed: p.familiarTapped,
            passed: p.passed,
        }));
        // 選択肢
        let availableActions = [];
        if (isHumanTurn && this.waitingForHuman) {
            availableActions = this.cachedActions.map((a, i) => ({
                index: i,
                description: describeAction(a, this.state, getPlayer(this.state, this.humanPlayerId)),
                category: categorizeAction(a),
            }));
        }
        return {
            round: this.state.round,
            phase: this.state.phase,
            currentPlayerId: current.config.id,
            currentPlayerName: current.config.name,
            isHumanTurn,
            toolSupply: this.state.toolSupply.map((t) => ({
                id: t.id, name: t.name, type: t.type, cost: t.cost,
                magicPower: t.magicPower, effect: t.effect,
            })),
            saintSupply: this.state.saintSupply.map((s) => ({
                id: s.id, name: s.name, hp: s.hp, vp: s.victoryPoints,
                manaReward: s.manaReward, relicDraw: s.relicDraw,
            })),
            relicDeckCount: this.state.relicDeck.length,
            toolDeckCount: this.state.toolDeck.length,
            saintDeckCount: this.state.saintDeck.length,
            fieldActions: this.state.fieldActions.map((f) => ({
                id: f.id, name: f.name, maxSlots: f.maxSlots, usedSlots: f.usedSlots,
            })),
            players,
            humanPlayerId: this.humanPlayerId,
            availableActions,
            lastEvents: this.state.lastEvents,
            log: this.log.slice(-100),
            gameOver: this.finished,
            finalScores: this.finalScores,
        };
    }
    selectAction(index) {
        if (!this.waitingForHuman)
            return false;
        if (index < 0 || index >= this.cachedActions.length)
            return false;
        if (!this.resolveAction)
            return false;
        this.waitingForHuman = false;
        const resolve = this.resolveAction;
        this.resolveAction = null;
        resolve(index);
        return true;
    }
    abort() {
        this.aborted = true;
        this.finished = true;
        if (this.waitingForHuman && this.resolveAction) {
            const resolve = this.resolveAction;
            this.resolveAction = null;
            this.waitingForHuman = false;
            resolve(0); // パスを選択して終了
        }
    }
    // ── メインループ ──
    async run() {
        const MAX_TURNS = 300;
        let turnCount = 0;
        while (!isMajoGameOver(this.state) && !this.aborted) {
            turnCount++;
            if (turnCount > MAX_TURNS) {
                this.addLog('⚠️ 最大ターン数超過 — ゲーム強制終了');
                break;
            }
            const current = getCurrentPlayer(this.state);
            if (current.config.id === this.humanPlayerId) {
                // 人間のターン
                const actions = getAvailableActions(this.state, this.humanPlayerId);
                this.cachedActions = actions;
                this.waitingForHuman = true;
                this.notifyUpdate();
                const selectedIndex = await new Promise((resolve) => {
                    this.resolveAction = resolve;
                });
                if (this.aborted)
                    break;
                const action = actions[selectedIndex];
                this.addLog(`🎮 あなた: ${describeAction(action, this.state, getPlayer(this.state, this.humanPlayerId))}`);
                this.state = executeAction(this.state, action);
                this.cachedActions = [];
            }
            else {
                // AIのターン
                const strategy = this.strategies.get(current.config.id);
                if (!strategy) {
                    this.addLog(`⚠️ 戦略が見つからない: ${current.config.id}`);
                    break;
                }
                const { action, reasoning } = strategy.selectAction(this.state, current.config.id);
                const desc = describeAction(action, this.state, current);
                this.addLog(`${playerIcon(current.config.id)} ${current.config.name}: ${desc}`);
                if (reasoning) {
                    this.addLog(`  💭 ${reasoning}`);
                }
                this.state = executeAction(this.state, action);
                // AIのアクション説明をlastEventsの先頭に追加（オーバーレイ表示用）
                this.state = {
                    ...this.state,
                    lastEvents: [desc, ...this.state.lastEvents],
                };
                // AIアクション後のディレイ
                await delay(this.opts.aiDelay);
            }
            // イベントログ追加
            for (const ev of this.state.lastEvents) {
                this.addLog(`  📦 ${ev}`);
            }
            this.notifyUpdate();
        }
        // ゲーム終了
        this.finished = true;
        this.finalScores = getMajoFinalScores(this.state);
        this.addLog('');
        this.addLog('━━━ ゲーム終了 ━━━');
        for (const s of this.finalScores) {
            const medal = s.rank === 1 ? '👑' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : '  ';
            const isHuman = s.playerId === this.humanPlayerId ? ' ← あなた' : '';
            this.addLog(`${medal} ${s.rank}位 ${s.name}: ★${s.victoryPoints}VP${isHuman}`);
        }
        this.notifyUpdate();
    }
    // ── ヘルパー ──
    addLog(msg) {
        this.log.push(msg);
        if (this.log.length > 500)
            this.log.shift();
    }
    notifyUpdate() {
        this.onUpdate?.();
    }
}
// ── ユーティリティ ──
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function playerIcon(id) {
    switch (id) {
        case 'p0': return '🔵';
        case 'p1': return '🟣';
        case 'p2': return '🟢';
        case 'p3': return '🟡';
        default: return '⚪';
    }
}
function categorizeAction(action) {
    switch (action.type) {
        case 'use_relic': return 'relic';
        case 'extra_combat': return 'extra_combat';
        case 'use_witch': return 'witch';
        case 'pass': return 'pass';
        case 'combat_select_saint': return 'field';
        case 'combat_add_tool': return 'field';
        case 'combat_execute': return 'field';
        case 'combat_retreat': return 'pass';
        case 'use_tool_turn': return 'field';
        case 'select_saint_discard': return 'relic';
        default: return 'field';
    }
}
function describeAction(action, state, player) {
    switch (action.type) {
        case 'pass':
            return 'パス';
        case 'field_action':
        case 'use_familiar': {
            const prefix = action.type === 'use_familiar' ? '【使い魔】' : '';
            const details = action.details;
            switch (details.action) {
                case 'research': {
                    const tool = state.toolSupply.find((t) => t.id === details.toolId);
                    if (tool) {
                        const dIds = details.discountToolIds || [];
                        if (dIds.length > 0) {
                            const dNames = dIds.map((id) => {
                                const dt = player.magicTools.find((t) => t.id === id);
                                return dt ? dt.name : id;
                            }).join('+');
                            const totalDiscount = dIds.reduce((s, id) => {
                                const dt = player.magicTools.find((t) => t.id === id);
                                if (dt?.effect.includes('コスト-2'))
                                    return s + 2;
                                if (dt?.effect.includes('コスト-1'))
                                    return s + 1;
                                return s;
                            }, 0) + (player.relics.some((r) => r.id === 'M54') ? 1 : 0);
                            const eCost = Math.max(1, tool.cost - totalDiscount);
                            return `${prefix}研究 → ${tool.name}(魔力${tool.magicPower})を${eCost}マナで購入（${dNames}タップ）`;
                        }
                        return `${prefix}研究 → ${tool.name}(コスト${tool.cost}, 魔力${tool.magicPower})を購入`;
                    }
                    return `${prefix}研究 → ${details.toolId}を購入`;
                }
                case 'violence': {
                    const saint = state.saintSupply.find((s) => s.id === details.saintId);
                    const toolNames = details.tappedToolIds.map((id) => {
                        const t = player.magicTools.find((tool) => tool.id === id);
                        return t ? `${t.name}(${getEffectiveMagicPower(t, player.magicTools)})` : id;
                    }).join('+');
                    if (saint)
                        return `${prefix}横暴 → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦 [${toolNames}]`;
                    return `${prefix}横暴 → ${details.saintId}に挑戦`;
                }
                case 'sacrifice': {
                    const saint = state.saintSupply.find((s) => s.id === details.saintId);
                    return `${prefix}生贄(コスト5) → ${saint?.name || details.saintId}に挑戦`;
                }
                case 'magic_shop':
                    return `${prefix}魔具店 → マナ+2`;
                case 'cathedral':
                    return `${prefix}大聖堂 → SP獲得+マナ+1`;
                case 'prayer': {
                    const relic = player.relics.find((r) => r.id === details.relicId);
                    return `${prefix}祈祷 → 聖遺物(${relic?.id})を捨ててマナ+3`;
                }
            }
            return `${prefix}フィールドアクション`;
        }
        case 'use_witch':
            return action.choice === 'mana'
                ? `魔女(マナモード) → マナ+${2 + state.witchUsageCount}`
                : `魔女(魔力モード) → 魔力+${3 + state.witchUsageCount}`;
        case 'use_relic': {
            const relic = player.relics.find((r) => r.id === action.relicId);
            return `聖遺物使用 → ${relic?.effect || action.relicId}`;
        }
        case 'extra_combat': {
            const saint = state.saintSupply.find((s) => s.id === action.saintId);
            if (saint)
                return `⚔️追加戦闘(M67) → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦`;
            return `⚔️追加戦闘(M67)`;
        }
        case 'combat_select_saint': {
            const saint = state.saintSupply.find((s) => s.id === action.saintId);
            const fieldName = action.fieldId === 'violence' ? '横暴(コスト2)' : '生贄(コスト5)';
            const familiarPrefix = action.useFamiliar ? '【使い魔】' : '';
            if (saint)
                return `${familiarPrefix}${fieldName} → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦開始`;
            return `${familiarPrefix}${fieldName} → 聖者に挑戦開始`;
        }
        case 'combat_add_tool': {
            const tool = player.magicTools.find((t) => t.id === action.toolId);
            if (!tool)
                return `魔導具(${action.toolId})を追加`;
            const toolPower = getEffectiveMagicPower(tool, player.magicTools)
                + (tool.type === '護符' && tool.effect.includes('戦闘：魔力＋3') ? 3 : 0);
            const cs = state.combatState;
            const currentSelectedIds = cs ? cs.selectedToolIds : [];
            const currentPower = currentSelectedIds.reduce((sum, id) => {
                const t = player.magicTools.find((tt) => tt.id === id);
                if (!t)
                    return sum;
                return sum + getEffectiveMagicPower(t, player.magicTools)
                    + (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') ? 3 : 0);
            }, 0);
            const saint = cs ? state.saintSupply.find((s) => s.id === cs.saintId) : null;
            const saintInfo = saint ? ` (vs ${saint.name} HP${saint.hp})` : '';
            return `${tool.name}(魔力${toolPower})をタップ → 合計魔力${currentPower + toolPower}${saintInfo}`;
        }
        case 'combat_execute': {
            const cs = state.combatState;
            if (cs) {
                const saint = state.saintSupply.find((s) => s.id === cs.saintId);
                const totalPower = cs.selectedToolIds.reduce((sum, id) => {
                    const t = player.magicTools.find((tt) => tt.id === id);
                    if (!t)
                        return sum;
                    return sum + getEffectiveMagicPower(t, player.magicTools)
                        + (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') ? 3 : 0);
                }, 0);
                if (saint)
                    return `戦闘実行（合計魔力${totalPower} vs ${saint.name} HP${saint.hp}）`;
            }
            return `戦闘実行`;
        }
        case 'combat_retreat':
            return `撤退（マナ消費済み、手番終了）`;
        case 'use_tool_turn': {
            const tool = player.magicTools.find((t) => t.id === action.toolId);
            if (tool)
                return `護符「${tool.name}」の手番効果を使用（${tool.effect}）`;
            return `護符の手番効果を使用`;
        }
        case 'select_saint_discard': {
            const saint = player.saints.find((s) => s.id === action.saintId);
            if (saint)
                return `聖者「${saint.name}」(HP${saint.hp}/★${saint.victoryPoints})を捨てて4マナ獲得`;
            return `聖者を捨てて4マナ獲得`;
        }
        default:
            return action.type;
    }
}
