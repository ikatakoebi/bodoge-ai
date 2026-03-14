/**
 * 魔女ゲー プレイコントローラー
 * 複数人間 vs AI の対戦を管理する
 */
import { createMajoGame, getCurrentPlayer, executeAction, getAvailableActions, isMajoGameOver, getMajoFinalScores, getPlayer, getEffectiveMagicPower, } from '../engine/majo.js';
import { getMajoStrategy, getRandomMajoStrategy } from '../ai/majo-strategies.js';
// ── コントローラー ──
export class MajoPlayController {
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
    cachedActions = [];
    finalScores = null;
    onUpdate = null;
    _strategyNames = [];
    constructor(opts = {}) {
        const humanIndices = opts.humanPlayerIndices ?? [opts.humanPlayerIndices !== undefined ? 0 : 0];
        this.opts = {
            humanPlayerIndices: humanIndices.length > 0 ? humanIndices : [0],
            humanNames: opts.humanNames ?? [],
            aiStrategies: opts.aiStrategies ?? [],
            aiDelay: opts.aiDelay ?? 800,
        };
        // プレイヤー設定
        const playerCount = 4;
        let aiIdx = 0;
        const strategyNames = [];
        const humanIdxSet = new Set(this.opts.humanPlayerIndices);
        for (let i = 0; i < playerCount; i++) {
            if (humanIdxSet.has(i)) {
                const humanIdx = this.opts.humanPlayerIndices.indexOf(i);
                const humanName = this.opts.humanNames[humanIdx] || 'あなた';
                this.players.push({
                    id: `p${i}`,
                    name: `P${i + 1} ${humanName}`,
                    type: 'human',
                });
                this.humanPlayerIds.add(`p${i}`);
                strategyNames.push(humanName);
            }
            else {
                const stratId = this.opts.aiStrategies[aiIdx] ?? getRandomMajoStrategy().id;
                const strategy = getMajoStrategy(stratId);
                this.players.push({
                    id: `p${i}`,
                    name: `P${i + 1} ${strategy.name}`,
                    type: 'ai',
                    strategyId: stratId,
                    personalityDesc: strategy.personality,
                });
                this.strategies.set(`p${i}`, strategy);
                strategyNames.push(strategy.name);
                aiIdx++;
            }
        }
        // state は initGame() で非同期初期化
        this.state = undefined;
        this._strategyNames = strategyNames;
    }
    // ── Public API ──
    setOnUpdate(cb) {
        this.onUpdate = cb;
    }
    isReady() {
        return !!this.state;
    }
    /** 人間プレイヤーかどうか */
    isHumanPlayer(playerId) {
        return this.humanPlayerIds.has(playerId);
    }
    /** 全人間プレイヤーIDを返す */
    getHumanPlayerIds() {
        return [...this.humanPlayerIds];
    }
    /** 現在アクション待ちの人間プレイヤーID（待ちでなければ空文字） */
    getWaitingPlayerId() {
        return this.waitingForHuman ? this.waitingPlayerId : '';
    }
    getGameInfo() {
        const humanIds = [...this.humanPlayerIds];
        const firstHumanId = humanIds[0] ?? 'p0';
        if (!this.state) {
            return {
                round: 0, phase: 'action',
                currentPlayerId: '', currentPlayerName: '',
                isHumanTurn: false,
                toolSupply: [], saintSupply: [],
                relicDeckCount: 0, toolDeckCount: 0, saintDeckCount: 0,
                fieldActions: [], players: [],
                humanPlayerId: firstHumanId,
                humanPlayerIds: humanIds,
                availableActions: [], lastEvents: [], log: [],
                gameOver: false, finalScores: null,
            };
        }
        const current = getCurrentPlayer(this.state);
        const isHumanTurn = this.humanPlayerIds.has(current.config.id) && !this.finished;
        // プレイヤー情報
        const players = this.state.players.map((p) => ({
            id: p.config.id,
            name: p.config.name,
            strategy: p.config.strategyId ?? '人間',
            isHuman: this.humanPlayerIds.has(p.config.id),
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
            hasStartPlayer: this.state.players.indexOf(p) === this.state.startPlayerIndex,
            achievements: this.state.achievements
                .filter((a) => a.holderId === p.config.id)
                .map((a) => ({ id: a.id, name: a.name, vp: a.victoryPoints })),
        }));
        // 選択肢
        let availableActions = [];
        if (isHumanTurn && this.waitingForHuman) {
            availableActions = this.cachedActions.map((a, i) => ({
                index: i,
                description: describeAction(a, this.state, getPlayer(this.state, current.config.id)),
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
                id: f.id, name: f.name, maxSlots: f.maxSlots, usedSlots: f.usedSlots, cost: f.cost,
            })),
            players,
            humanPlayerId: firstHumanId,
            humanPlayerIds: humanIds,
            availableActions,
            lastEvents: this.state.lastEvents,
            log: this.log.slice(-500),
            gameOver: this.finished,
            finalScores: this.finalScores,
        };
    }
    selectAction(index, playerId) {
        if (!this.waitingForHuman)
            return false;
        if (index < 0 || index >= this.cachedActions.length)
            return false;
        if (!this.resolveAction)
            return false;
        // playerIdが指定されてる場合、正しいプレイヤーかチェック
        if (playerId && playerId !== this.waitingPlayerId)
            return false;
        this.waitingForHuman = false;
        this.waitingPlayerId = '';
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
            this.waitingPlayerId = '';
            resolve(0); // パスを選択して終了
        }
    }
    /** スプレッドシートからカードデータを読み込みゲームを初期化 */
    async initGame() {
        this.state = await createMajoGame(this.players);
        this.addLog(`魔女ゲー開始！ ${this._strategyNames.join(' / ')}`);
    }
    /** フィールドアクション名をボードのカード定義から上書き */
    updateFieldActionNames(nameMap) {
        if (!this.state)
            return;
        this.state = {
            ...this.state,
            fieldActions: this.state.fieldActions.map((fa) => ({
                ...fa,
                name: nameMap[fa.id] ?? fa.name,
            })),
        };
    }
    // ── メインループ ──
    async run() {
        if (!this.state)
            await this.initGame();
        const MAX_TURNS = 300;
        let turnCount = 0;
        while (!isMajoGameOver(this.state) && !this.aborted) {
            try {
                turnCount++;
                if (turnCount > MAX_TURNS) {
                    this.addLog('⚠️ 最大ターン数超過 — ゲーム強制終了');
                    break;
                }
                const current = getCurrentPlayer(this.state);
                if (this.humanPlayerIds.has(current.config.id)) {
                    // 人間のターン
                    const actions = getAvailableActions(this.state, current.config.id);
                    this.cachedActions = actions;
                    this.waitingForHuman = true;
                    this.waitingPlayerId = current.config.id;
                    this.notifyUpdate();
                    const selectedIndex = await new Promise((resolve) => {
                        this.resolveAction = resolve;
                    });
                    if (this.aborted)
                        break;
                    const action = actions[selectedIndex];
                    this.addLog(`🎮 ${current.config.name}: ${describeAction(action, this.state, current)}`);
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
                        this.addLog(`\t\t💭 ${reasoning}`);
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
                    this.addLog(`\t\t📦 ${ev}`);
                }
                this.notifyUpdate();
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.addLog(`❌ エラー: ${msg}`);
                console.error('[majo] ゲームループエラー:', err);
                this.notifyUpdate();
                break;
            }
        }
        // ゲーム終了
        this.finished = true;
        this.finalScores = getMajoFinalScores(this.state);
        this.addLog('');
        this.addLog('━━━ ゲーム終了 ━━━');
        for (const s of this.finalScores) {
            const medal = s.rank === 1 ? '👑' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : '  ';
            const isHuman = this.humanPlayerIds.has(s.playerId) ? ' ← あなた' : '';
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
        if (this.onUpdate)
            this.onUpdate();
    }
}
// ── ユーティリティ ──
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function playerIcon(playerId) {
    const icons = ['🔴', '🟢', '🔵', '🟠', '🟣'];
    const idx = parseInt(playerId.replace('p', ''), 10);
    return icons[idx] ?? '⚪';
}
/** state.fieldActionsからフィールド名を取得（スプシ反映） */
function fieldName(state, fieldId) {
    const fa = state.fieldActions.find((f) => f.id === fieldId);
    return fa?.name ?? fieldId;
}
/** フィールド名＋コスト付き */
function fieldNameWithCost(state, fieldId) {
    const fa = state.fieldActions.find((f) => f.id === fieldId);
    if (!fa)
        return fieldId;
    const costStr = fa.cost === 'variable' ? '' : `(コスト${fa.cost})`;
    return `${fa.name}${costStr}`;
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
                    const rName = fieldName(state, 'research');
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
                            }, 0) + player.relics.reduce((s, r) => { const m = r.effect.match(/購入コストが(\d+)減る/); return m ? s + parseInt(m[1], 10) : s; }, 0);
                            const eCost = Math.max(1, tool.cost - totalDiscount);
                            return `${prefix}${rName} → ${tool.name}(魔力${tool.magicPower})を${eCost}マナで購入（${dNames}タップ）`;
                        }
                        return `${prefix}${rName} → ${tool.name}(コスト${tool.cost}, 魔力${tool.magicPower})を購入`;
                    }
                    return `${prefix}${rName} → ${details.toolId}を購入`;
                }
                case 'violence': {
                    const vName = fieldNameWithCost(state, 'violence');
                    const saint = state.saintSupply.find((s) => s.id === details.saintId);
                    const toolNames = details.tappedToolIds.map((id) => {
                        const t = player.magicTools.find((tool) => tool.id === id);
                        return t ? `${t.name}(${getEffectiveMagicPower(t, player.magicTools)})` : id;
                    }).join('+');
                    if (saint)
                        return `${prefix}${vName} → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦 [${toolNames}]`;
                    return `${prefix}${vName} → ${details.saintId}に挑戦`;
                }
                case 'sacrifice': {
                    const sName = fieldNameWithCost(state, 'sacrifice');
                    const saint = state.saintSupply.find((s) => s.id === details.saintId);
                    return `${prefix}${sName} → ${saint?.name || details.saintId}に挑戦`;
                }
                case 'magic_shop':
                    return `${prefix}${fieldName(state, 'magic_shop')} → マナ+2`;
                case 'cathedral':
                    return `${prefix}${fieldName(state, 'cathedral')} → SP獲得+マナ+1`;
                case 'prayer': {
                    const relic = player.relics.find((r) => r.id === details.relicId);
                    return `${prefix}${fieldName(state, 'prayer')} → 聖遺物(${relic?.id})を捨ててマナ+3`;
                }
            }
            return `${prefix}フィールドアクション`;
        }
        case 'use_witch':
            return action.choice === 'mana'
                ? `魔女(マナモード) → マナ+${state.round}`
                : `魔女(魔力モード) → 魔力+${state.round}`;
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
            const csFieldName = fieldNameWithCost(state, action.fieldId);
            const familiarPrefix = action.useFamiliar ? '【使い魔】' : '';
            if (saint)
                return `${familiarPrefix}${csFieldName} → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦開始`;
            return `${familiarPrefix}${csFieldName} → 聖者に挑戦開始`;
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
        case 'combat_activate_amulet': {
            const amulet = player.magicTools.find((t) => t.id === action.toolId);
            return `護符「${amulet?.name ?? action.toolId}」の戦闘効果発動: 魔力＋3（廃棄）`;
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
                        + (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') && cs.activatedAmuletIds.includes(id) ? 3 : 0);
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
        case 'untap_tool': {
            const tool = player.magicTools.find((t) => t.id === action.toolId);
            return `水晶玉「${tool?.name ?? action.toolId}」をアンタップ`;
        }
        case 'select_free_tool': {
            const tool = state.toolSupply.find((t) => t.id === action.toolId);
            if (tool)
                return `聖遺物M53 → ${tool.name}(コスト${tool.cost}, 魔力${tool.magicPower})をタダで獲得`;
            return `聖遺物M53 → 魔導具をタダで獲得`;
        }
        default:
            return `アクション: ${action.type}`;
    }
}
function categorizeAction(action) {
    switch (action.type) {
        case 'pass': return 'pass';
        case 'use_witch': return 'witch';
        case 'use_relic': return 'relic';
        case 'extra_combat': return 'extra_combat';
        case 'combat_select_saint':
        case 'combat_add_tool':
        case 'combat_activate_amulet':
        case 'combat_execute':
        case 'combat_retreat':
            return 'combat';
        default: return 'field';
    }
}
export { calculateCombatPower, getEffectiveMagicPower } from '../engine/majo.js';
