// 魔女ゲー ゲームエンジン
import { ALL_TOOLS, ALL_SAINTS, ALL_RELICS, ALL_ACHIEVEMENTS } from './majo-cards.js';
import { loadCardsFromSheet } from './majo-card-loader.js';
const INITIAL_MANA = 3;
const VICTORY_POINT_TARGET = 7;
function shuffle(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
// ── 初期化 ──
function createFieldActions() {
    return [
        { id: 'research', name: '研究', maxSlots: 3, cost: 'variable', usedSlots: 0 },
        { id: 'violence', name: '横暴', maxSlots: 3, cost: 2, usedSlots: 0 },
        { id: 'magic_shop', name: '魔具店', maxSlots: 3, cost: 1, usedSlots: 0 },
        { id: 'cathedral', name: '大聖堂', maxSlots: 1, cost: 1, usedSlots: 0 },
        { id: 'sacrifice', name: '生贄', maxSlots: -1, cost: 5, usedSlots: 0 }, // 無制限
        { id: 'prayer', name: '祈祷', maxSlots: 3, cost: 1, usedSlots: 0 },
    ];
}
export async function createMajoGame(players) {
    if (players.length < 2 || players.length > 5) {
        throw new Error('プレイヤー数は2〜5人');
    }
    // スプレッドシートからカードデータを読み込み（失敗時はハードコードにフォールバック）
    let tools = ALL_TOOLS;
    let saints = ALL_SAINTS;
    let relics = ALL_RELICS;
    let achievements = ALL_ACHIEVEMENTS;
    try {
        const cards = await loadCardsFromSheet();
        tools = cards.tools;
        saints = cards.saints;
        relics = cards.relics;
        achievements = cards.achievements;
    }
    catch (e) {
        console.warn('スプレッドシート読み込み失敗、ハードコードデータを使用:', e.message);
    }
    const shuffledSaints = shuffle([...saints]);
    const shuffledRelics = shuffle([...relics]);
    const playerStates = players.map((config) => ({
        config,
        mana: INITIAL_MANA,
        tappedMana: 0, // ゲーム開始時のマナはアンタップ状態
        magicTools: [],
        tappedToolIds: [],
        saints: [],
        relics: [],
        witchTapped: false,
        familiarTapped: false,
        victoryPoints: 0,
        lastPassiveVP: 0,
        passed: false,
    }));
    const shuffledTools = shuffle([...tools]);
    const initialState = {
        players: playerStates,
        toolDeck: shuffledTools.slice(3), // 残りデッキ
        toolSupply: shuffledTools.slice(0, 3), // 展示3枚
        saintSupply: shuffledSaints.splice(0, 3),
        saintDeck: shuffledSaints,
        relicDeck: shuffledRelics,
        achievements: [...achievements],
        fieldActions: createFieldActions(),
        round: 1,
        currentPlayerIndex: 0,
        startPlayerIndex: 0,
        witchUsageCount: 0,
        consecutivePasses: 0,
        phase: 'action',
        history: [],
        lastEvents: [],
    };
    // 最後のプレイヤー（後手番補正）：マナ+1ボーナス
    const lastIndex = players.length - 1;
    initialState.players = initialState.players.map((p, i) => i === lastIndex ? { ...p, mana: p.mana + 1 } : p);
    return initialState;
}
// ── ユーティリティ ──
export function getCurrentPlayer(state) {
    return state.players[state.currentPlayerIndex];
}
export function getPlayer(state, playerId) {
    const p = state.players.find((p) => p.config.id === playerId);
    if (!p)
        throw new Error(`プレイヤー ${playerId} が見つからない`);
    return p;
}
function updatePlayer(state, playerId, update) {
    return {
        ...state,
        players: state.players.map((p) => p.config.id === playerId ? { ...p, ...update } : p),
    };
}
function getField(state, fieldId) {
    const f = state.fieldActions.find((f) => f.id === fieldId);
    if (!f)
        throw new Error(`フィールド ${fieldId} が見つからない`);
    return f;
}
function updateField(state, fieldId, update) {
    return {
        ...state,
        fieldActions: state.fieldActions.map((f) => f.id === fieldId ? { ...f, ...update } : f),
    };
}
// 魔導具の実効魔力（M26の杖の特殊効果考慮）
export function getEffectiveMagicPower(tool, allTools) {
    if (tool.id === 'M26') {
        // 手持ちの最大魔力の魔導具の魔力+3
        const maxPower = Math.max(0, ...allTools.filter((t) => t.id !== 'M26').map((t) => t.magicPower));
        return maxPower + 3;
    }
    return tool.magicPower;
}
// 戦闘魔力の計算
export function calculateCombatPower(player, tappedToolIds, useCombatRelics = [], useWitch = false, witchUsageCount = 0) {
    let power = 0;
    // タップした魔導具の魔力合計
    for (const toolId of tappedToolIds) {
        const tool = player.magicTools.find((t) => t.id === toolId);
        if (tool) {
            power += getEffectiveMagicPower(tool, player.magicTools);
            // 護符の戦闘ボーナス
            if (tool.type === '護符' && tool.effect.includes('戦闘：魔力＋3')) {
                power += 3;
            }
        }
    }
    // 戦闘用聖遺物のボーナス
    for (const relicId of useCombatRelics) {
        const relic = player.relics.find((r) => r.id === relicId);
        if (relic && relic.effect.includes('魔力＋2')) {
            power += 2;
        }
    }
    // 魔女ボーナス（魔力モード）
    if (useWitch) {
        power += 3 + witchUsageCount;
    }
    return power;
}
// コスト削減計算（魔導書・水晶玉のタップ効果 + 聖遺物M54）
export function calculateCostReduction(player, toolIdsToTapForDiscount) {
    let reduction = 0;
    for (const toolId of toolIdsToTapForDiscount) {
        const tool = player.magicTools.find((t) => t.id === toolId);
        if (tool) {
            if (tool.effect.includes('コスト-2'))
                reduction += 2;
            else if (tool.effect.includes('コスト-1'))
                reduction += 1;
        }
    }
    // 聖遺物M54: 魔導具の購入コストが1減る
    if (player.relics.some((r) => r.id === 'M54')) {
        reduction += 1;
    }
    return reduction;
}
// ── アクション可能チェック ──
export function canUseField(state, fieldId, useFamiliar = false) {
    const field = getField(state, fieldId);
    if (field.maxSlots !== -1 && field.usedSlots >= field.maxSlots && !useFamiliar) {
        return false;
    }
    return true;
}
export function getAvailableActions(state, playerId) {
    const player = getPlayer(state, playerId);
    const actions = [];
    // 戦闘マルチステップ中の場合：戦闘専用アクションのみ返す
    if (state.combatState && state.combatState.playerId === playerId) {
        const cs = state.combatState;
        const totalPower = calculateCombatPower(player, cs.selectedToolIds);
        // 未タップかつ未選択の魔導具を追加できる
        for (const tool of player.magicTools) {
            if (!player.tappedToolIds.includes(tool.id) && !cs.selectedToolIds.includes(tool.id)) {
                const toolPower = getEffectiveMagicPower(tool, player.magicTools)
                    + (tool.type === '護符' && tool.effect.includes('戦闘：魔力＋3') ? 3 : 0);
                actions.push({
                    type: 'combat_add_tool',
                    playerId,
                    toolId: tool.id,
                });
            }
        }
        // 戦闘実行
        const saint = state.saintSupply.find((s) => s.id === cs.saintId);
        const saintHp = saint?.hp ?? 0;
        actions.push({
            type: 'combat_execute',
            playerId,
        });
        // 撤退
        actions.push({ type: 'combat_retreat', playerId });
        return actions;
    }
    // パスは常に可能
    actions.push({ type: 'pass', playerId });
    // 魔女使用
    if (!player.witchTapped) {
        actions.push({ type: 'use_witch', playerId, choice: 'magic' });
        actions.push({ type: 'use_witch', playerId, choice: 'mana' });
    }
    // 使い切り聖遺物の使用（手番タイミング）
    for (const relic of player.relics) {
        if (relic.timing === 'turn' && relic.isDisposable) {
            // M66（聖者捨て→マナ）: 聖者選択が必要
            if (relic.id === 'M66' && player.saints.length > 0) {
                for (const saint of player.saints) {
                    actions.push({ type: 'select_saint_discard', playerId, relicId: relic.id, saintId: saint.id });
                }
            }
            else if (relic.id === 'M53') {
                // M53: 3コスト以下の魔導具を選んでタダで獲得
                for (const tool of state.toolSupply) {
                    if (tool.cost <= 3) {
                        actions.push({ type: 'select_free_tool', playerId, relicId: relic.id, toolId: tool.id });
                    }
                }
            }
            else {
                actions.push({ type: 'use_relic', playerId, relicId: relic.id });
            }
        }
    }
    // 護符の手番効果（M28: 手番：勝利点＋1。廃棄）
    for (const tool of player.magicTools) {
        if (tool.type === '護符' && tool.effect.includes('手番：')) {
            actions.push({ type: 'use_tool_turn', playerId, toolId: tool.id });
        }
    }
    // M27 水晶玉「いつでもアンタップしてよい」：タップ中ならアンタップアクションを生成
    for (const tool of player.magicTools) {
        if (tool.id === 'M27' && player.tappedToolIds.includes(tool.id)) {
            actions.push({ type: 'untap_tool', playerId, toolId: tool.id });
        }
    }
    // M67追加戦闘（フィールド枠・マナコスト不要、魔導具は通常通りタップ必要）
    if (state.extraCombatPlayerId === playerId) {
        const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
        const allToolIds = availableTools.map((t) => t.id);
        for (const saint of state.saintSupply) {
            // 魔力チェックなし：足りなければ戦闘中に撤退可能
            actions.push({ type: 'extra_combat', playerId, saintId: saint.id, tappedToolIds: allToolIds });
        }
    }
    // フィールドアクション
    for (const field of state.fieldActions) {
        const canUse = canUseField(state, field.id);
        const canUseFamiliar = !player.familiarTapped && !canUse && field.usedSlots >= field.maxSlots && field.maxSlots !== -1;
        if (!canUse && !canUseFamiliar)
            continue;
        const useFamiliar = !canUse && canUseFamiliar;
        switch (field.id) {
            case 'research': {
                // 割引可能な魔導具（未タップの魔導書・水晶玉でコスト-効果を持つもの）
                const discountTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id) && (t.effect.includes('コスト-1') || t.effect.includes('コスト-2')));
                // 割引パターンを全列挙（空=タップなし, 各1個, 各2個の組み合わせ）
                const discountPatterns = [[]]; // まずタップなしパターン
                for (let i = 0; i < discountTools.length; i++) {
                    const current = discountPatterns.length;
                    for (let j = 0; j < current; j++) {
                        discountPatterns.push([...discountPatterns[j], discountTools[i].id]);
                    }
                }
                const addedKeys = new Set(); // 重複排除用
                for (const pattern of discountPatterns) {
                    const reduction = calculateCostReduction(player, pattern);
                    for (const tool of state.toolSupply) {
                        const effectiveCost = Math.max(1, tool.cost - reduction);
                        if (player.mana >= effectiveCost) {
                            // 同じツールで同じコストのパターンは重複排除
                            const key = `${tool.id}:${effectiveCost}`;
                            if (addedKeys.has(key))
                                continue;
                            addedKeys.add(key);
                            const details = {
                                action: 'research',
                                toolId: tool.id,
                                discountToolIds: pattern.length > 0 ? pattern : undefined,
                            };
                            if (useFamiliar) {
                                actions.push({ type: 'use_familiar', playerId, fieldId: 'research', details });
                            }
                            else {
                                actions.push({ type: 'field_action', playerId, fieldId: 'research', details });
                            }
                        }
                    }
                }
                break;
            }
            case 'violence': {
                if (player.mana >= 2) {
                    // 各聖者に対してcombat_select_saintアクションを生成
                    for (const saint of state.saintSupply) {
                        actions.push({
                            type: 'combat_select_saint',
                            playerId,
                            fieldId: 'violence',
                            saintId: saint.id,
                            useFamiliar,
                        });
                    }
                }
                break;
            }
            case 'magic_shop': {
                if (player.mana >= 1) {
                    const details = { action: 'magic_shop' };
                    if (useFamiliar) {
                        actions.push({ type: 'use_familiar', playerId, fieldId: 'magic_shop', details });
                    }
                    else {
                        actions.push({ type: 'field_action', playerId, fieldId: 'magic_shop', details });
                    }
                }
                break;
            }
            case 'cathedral': {
                if (player.mana >= 1) {
                    const details = { action: 'cathedral' };
                    if (useFamiliar) {
                        actions.push({ type: 'use_familiar', playerId, fieldId: 'cathedral', details });
                    }
                    else {
                        actions.push({ type: 'field_action', playerId, fieldId: 'cathedral', details });
                    }
                }
                break;
            }
            case 'sacrifice': {
                if (player.mana >= 5) {
                    // 各聖者に対してcombat_select_saintアクションを生成
                    for (const saint of state.saintSupply) {
                        actions.push({
                            type: 'combat_select_saint',
                            playerId,
                            fieldId: 'sacrifice',
                            saintId: saint.id,
                            useFamiliar,
                        });
                    }
                }
                break;
            }
            case 'prayer': {
                if (player.mana >= 1 && player.relics.some((r) => r.isDisposable)) {
                    for (const relic of player.relics.filter((r) => r.isDisposable)) {
                        const details = { action: 'prayer', relicId: relic.id };
                        if (useFamiliar) {
                            actions.push({ type: 'use_familiar', playerId, fieldId: 'prayer', details });
                        }
                        else {
                            actions.push({ type: 'field_action', playerId, fieldId: 'prayer', details });
                        }
                    }
                }
                break;
            }
        }
    }
    return actions;
}
// ── アクション実行 ──
export function executeAction(state, action) {
    // アクション開始時にイベントログをリセット
    let newState = { ...state, history: [...state.history, action], lastEvents: [] };
    switch (action.type) {
        case 'pass':
            newState = executePass(newState, action.playerId);
            break;
        case 'field_action':
            newState = executeFieldAction(newState, action.playerId, action.fieldId, action.details, false);
            newState.consecutivePasses = 0;
            // M67追加戦闘フラグが立っていたら、同じプレイヤーの手番を続ける
            if (!newState.extraCombatPlayerId) {
                newState = advanceTurn(newState);
            }
            break;
        case 'use_witch':
            newState = executeWitch(newState, action.playerId, action.choice);
            break;
        case 'use_familiar':
            newState = executeFieldAction(newState, action.playerId, action.fieldId, action.details, true);
            newState.consecutivePasses = 0;
            if (!newState.extraCombatPlayerId) {
                newState = advanceTurn(newState);
            }
            break;
        case 'use_relic':
            newState = executeRelic(newState, action.playerId, action.relicId);
            break;
        case 'extra_combat': {
            // M67追加戦闘：フィールド枠・マナコスト不要、魔導具は通常通りタップ必要
            newState.extraCombatPlayerId = undefined;
            newState = executeCombat(newState, action.playerId, action.saintId, action.tappedToolIds, action.combatRelicIds || []);
            newState.consecutivePasses = 0;
            newState = advanceTurn(newState);
            break;
        }
        case 'combat_select_saint': {
            // マナを消費し、combatStateをセット。手番は進めない
            const manaCost = action.fieldId === 'violence' ? 2 : 5;
            const p = getPlayer(newState, action.playerId);
            if (p.mana < manaCost)
                throw new Error(`マナが足りない（必要:${manaCost}, 所持:${p.mana}）`);
            // フィールド枠の消費（使い魔の場合は枠を消費しない）
            if (!action.useFamiliar) {
                newState = updateField(newState, action.fieldId, {
                    usedSlots: getField(newState, action.fieldId).usedSlots + 1,
                });
            }
            // 使い魔使用フラグ
            if (action.useFamiliar) {
                newState = updatePlayer(newState, action.playerId, { familiarTapped: true });
            }
            newState = updatePlayer(newState, action.playerId, {
                mana: p.mana - manaCost,
                passed: false,
            });
            newState = {
                ...newState,
                combatState: {
                    playerId: action.playerId,
                    fieldId: action.fieldId,
                    saintId: action.saintId,
                    selectedToolIds: [],
                    useFamiliar: action.useFamiliar,
                },
            };
            break;
        }
        case 'combat_add_tool': {
            // combatState.selectedToolIdsにツールを追加。手番は進めない
            if (!newState.combatState)
                throw new Error('戦闘状態がない');
            newState = {
                ...newState,
                combatState: {
                    ...newState.combatState,
                    selectedToolIds: [...newState.combatState.selectedToolIds, action.toolId],
                },
            };
            break;
        }
        case 'combat_execute': {
            // combatStateの情報でexecuteCombatを呼ぶ。combatStateをクリア。手番を進める
            if (!newState.combatState)
                throw new Error('戦闘状態がない');
            const cs = newState.combatState;
            newState = { ...newState, combatState: undefined };
            newState = executeCombat(newState, cs.playerId, cs.saintId, cs.selectedToolIds, action.combatRelicIds || []);
            newState.consecutivePasses = 0;
            // M67追加戦闘フラグが立っていたら、同じプレイヤーの手番を続ける
            if (!newState.extraCombatPlayerId) {
                newState = advanceTurn(newState);
            }
            break;
        }
        case 'combat_retreat': {
            // combatStateをクリア。マナは消費済みなので戻さない。手番を進める
            if (!newState.combatState)
                throw new Error('戦闘状態がない');
            newState = {
                ...newState,
                combatState: undefined,
                lastEvents: [...newState.lastEvents, `撤退: 戦闘を取りやめました（マナは消費済み）`],
            };
            newState.consecutivePasses = 0;
            newState = advanceTurn(newState);
            break;
        }
        case 'use_tool_turn': {
            // 護符の手番効果（M28: 勝利点＋1。廃棄→山札の一番下へ）
            const p = getPlayer(newState, action.playerId);
            const tool = p.magicTools.find((t) => t.id === action.toolId);
            if (!tool)
                throw new Error(`魔導具 ${action.toolId} を所持していない`);
            if (tool.effect.includes('勝利点＋1')) {
                newState = updatePlayer(newState, action.playerId, {
                    victoryPoints: p.victoryPoints + 1,
                    magicTools: p.magicTools.filter((t) => t.id !== action.toolId),
                });
                // 廃棄：山札の一番下に戻す
                newState = { ...newState, toolDeck: [...newState.toolDeck, tool] };
                newState = {
                    ...newState,
                    lastEvents: [...newState.lastEvents, `護符「${tool.name}」を使用: 勝利点＋1（廃棄→山札へ）`],
                };
            }
            newState.consecutivePasses = 0;
            newState = advanceTurn(newState);
            break;
        }
        case 'select_saint_discard': {
            // M66: 指定した聖者を捨てて4マナ獲得、聖遺物を廃棄
            const p = getPlayer(newState, action.playerId);
            const saint = p.saints.find((s) => s.id === action.saintId);
            if (!saint)
                throw new Error(`聖者 ${action.saintId} を所持していない`);
            newState = updatePlayer(newState, action.playerId, {
                saints: p.saints.filter((s) => s.id !== action.saintId),
                victoryPoints: p.victoryPoints - saint.victoryPoints,
                tappedMana: p.tappedMana + 4,
                relics: p.relics.filter((r) => r.id !== action.relicId),
            });
            // 聖者を山札の一番下に戻す
            newState = { ...newState, saintDeck: [...newState.saintDeck, saint] };
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `聖遺物M66使用: 聖者「${saint.name}」を捨て、4マナ獲得`],
            };
            break;
        }
        case 'untap_tool': {
            // M27 水晶玉: いつでもアンタップしてよい
            const p = getPlayer(newState, action.playerId);
            if (!p.tappedToolIds.includes(action.toolId))
                throw new Error(`魔導具 ${action.toolId} はタップされていない`);
            const tool = p.magicTools.find((t) => t.id === action.toolId);
            newState = updatePlayer(newState, action.playerId, {
                tappedToolIds: p.tappedToolIds.filter((id) => id !== action.toolId),
            });
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `水晶玉「${tool?.name ?? action.toolId}」をアンタップ`],
            };
            break;
        }
        case 'select_free_tool': {
            // M53: 指定した魔導具をタダで獲得、聖遺物を廃棄
            const p = getPlayer(newState, action.playerId);
            const tool = newState.toolSupply.find((t) => t.id === action.toolId);
            if (!tool)
                throw new Error(`魔導具 ${action.toolId} が売り場にない`);
            if (tool.cost > 3)
                throw new Error(`魔導具 ${action.toolId} はコスト${tool.cost}で3コスト以下ではない`);
            newState = updatePlayer(newState, action.playerId, {
                magicTools: [...p.magicTools, tool],
                relics: p.relics.filter((r) => r.id !== action.relicId),
            });
            newState = {
                ...newState,
                toolSupply: newState.toolSupply.filter((t) => t.id !== action.toolId),
                lastEvents: [...newState.lastEvents, `聖遺物M53使用: ${tool.name}(コスト${tool.cost})をタダで獲得`],
            };
            // 売り場補充
            if (newState.toolDeck.length > 0) {
                const replenished = newState.toolDeck[0];
                newState = {
                    ...newState,
                    toolSupply: [...newState.toolSupply, replenished],
                    toolDeck: newState.toolDeck.slice(1),
                    lastEvents: [...newState.lastEvents, `魔導具補充: ${replenished.name}(コスト${replenished.cost}) が展示に追加されました`],
                };
            }
            // 廃棄した聖遺物を山札の一番下へ
            const relic = p.relics.find((r) => r.id === action.relicId);
            if (relic) {
                newState = { ...newState, relicDeck: [...newState.relicDeck, relic] };
            }
            // 実績チェック
            newState = checkAchievements(newState, action.playerId);
            break;
        }
    }
    // 全プレイヤーのパッシブ聖遺物VPを再計算
    newState = recalcAllPassiveVP(newState);
    return newState;
}
function executePass(state, playerId) {
    let newState = updatePlayer(state, playerId, { passed: true });
    newState.consecutivePasses++;
    // 全員パスしたらラウンド終了
    if (newState.consecutivePasses >= newState.players.length) {
        return endRound(newState);
    }
    return advanceTurn(newState);
}
function executeFieldAction(state, playerId, fieldId, details, useFamiliar) {
    let newState = { ...state };
    const player = getPlayer(newState, playerId);
    // 使い魔使用
    if (useFamiliar) {
        newState = updatePlayer(newState, playerId, { familiarTapped: true });
    }
    // フィールドの枠を消費（使い魔の場合も枠は消費しない＝既に埋まった枠に入る）
    if (!useFamiliar) {
        newState = updateField(newState, fieldId, {
            usedSlots: getField(newState, fieldId).usedSlots + 1,
        });
    }
    // パスフラグリセット（アクションを取ったので）
    newState = updatePlayer(newState, playerId, { passed: false });
    switch (details.action) {
        case 'research': {
            const tool = newState.toolSupply.find((t) => t.id === details.toolId);
            if (!tool)
                throw new Error(`魔導具 ${details.toolId} が売り場にない`);
            const discountIds = details.discountToolIds || [];
            const reduction = calculateCostReduction(getPlayer(newState, playerId), discountIds);
            const cost = Math.max(1, tool.cost - reduction);
            const p = getPlayer(newState, playerId);
            if (p.mana < cost)
                throw new Error(`マナが足りない（必要:${cost}, 所持:${p.mana}）`);
            // 割引ツールをタップ
            const newTapped = [...new Set([...p.tappedToolIds, ...discountIds])];
            newState = updatePlayer(newState, playerId, {
                mana: p.mana - cost,
                magicTools: [...p.magicTools, tool],
                tappedToolIds: newTapped,
            });
            newState.toolSupply = newState.toolSupply.filter((t) => t.id !== details.toolId);
            // 即補充：デッキから1枚展示に追加
            if (newState.toolDeck.length > 0) {
                const replenished = newState.toolDeck[0];
                newState = {
                    ...newState,
                    toolSupply: [...newState.toolSupply, replenished],
                    toolDeck: newState.toolDeck.slice(1),
                    lastEvents: [...newState.lastEvents, `魔導具補充: ${replenished.name}(コスト${replenished.cost}, 魔力${replenished.magicPower}) が展示に追加されました`],
                };
            }
            // 魔導具購入後に実績チェック（M126: 5つ以上、M129: 同種3つ以上）
            newState = checkAchievements(newState, playerId);
            break;
        }
        case 'violence':
        case 'sacrifice': {
            const manaCost = details.action === 'violence' ? 2 : 5;
            const p = getPlayer(newState, playerId);
            if (p.mana < manaCost)
                throw new Error(`マナが足りない`);
            newState = updatePlayer(newState, playerId, { mana: p.mana - manaCost });
            newState = executeCombat(newState, playerId, details.saintId, details.tappedToolIds, details.combatRelicIds || []);
            break;
        }
        case 'magic_shop': {
            const p = getPlayer(newState, playerId);
            if (p.mana < 1)
                throw new Error('マナが足りない');
            // コスト1はアンタップマナから支払い、報酬2はタップマナとして獲得
            newState = updatePlayer(newState, playerId, {
                mana: p.mana - 1,
                tappedMana: p.tappedMana + 2,
            });
            break;
        }
        case 'cathedral': {
            const p = getPlayer(newState, playerId);
            if (p.mana < 1)
                throw new Error('マナが足りない');
            // コスト1はアンタップマナから支払い、報酬1はタップマナとして獲得
            newState = updatePlayer(newState, playerId, {
                mana: p.mana - 1,
                tappedMana: p.tappedMana + 1,
            });
            // スタートプレイヤートークン移動
            const playerIndex = newState.players.findIndex((pp) => pp.config.id === playerId);
            newState.startPlayerIndex = playerIndex;
            // 聖遺物M55ボーナス：ラウンド中獲得なのでタップマナに追加
            const pUpdated = getPlayer(newState, playerId);
            if (pUpdated.relics.some((r) => r.id === 'M55')) {
                newState = updatePlayer(newState, playerId, { tappedMana: pUpdated.tappedMana + 1 });
            }
            break;
        }
        case 'prayer': {
            const p = getPlayer(newState, playerId);
            if (p.mana < 1)
                throw new Error('マナが足りない');
            const relic = p.relics.find((r) => r.id === details.relicId);
            if (!relic)
                throw new Error(`聖遺物 ${details.relicId} を持っていない`);
            // コスト1はアンタップマナから支払い、報酬3はタップマナとして獲得
            newState = updatePlayer(newState, playerId, {
                mana: p.mana - 1,
                tappedMana: p.tappedMana + 3,
                relics: p.relics.filter((r) => r.id !== details.relicId),
            });
            break;
        }
    }
    // M64聖遺物：この手番中のマナ支払い分を還元（タップマナとして）
    if (newState.manaRefundPlayerId === playerId) {
        const beforeMana = player.mana; // アクション前のマナ
        const afterPlayer = getPlayer(newState, playerId);
        const spent = beforeMana - afterPlayer.mana;
        if (spent > 0) {
            newState = updatePlayer(newState, playerId, {
                tappedMana: afterPlayer.tappedMana + spent,
            });
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `💎 M64効果：支払った${spent}マナがタップマナとして還元！`],
            };
        }
        // 手番終了後にフラグクリア（advanceTurnで次のプレイヤーに移るので）
        newState.manaRefundPlayerId = undefined;
    }
    return newState;
}
function executeCombat(state, playerId, saintId, tappedToolIds, combatRelicIds = []) {
    let newState = { ...state };
    const player = getPlayer(newState, playerId);
    const saint = newState.saintSupply.find((s) => s.id === saintId);
    if (!saint)
        throw new Error(`聖者 ${saintId} が展示にいない`);
    // 魔力計算（戦闘聖遺物のブーストを含む、魔女魔力モードも考慮）
    const useWitchMagic = player.witchTapped && player.witchMode === 'magic';
    const power = calculateCombatPower(player, tappedToolIds, combatRelicIds, useWitchMagic, newState.witchUsageCount);
    if (power < saint.hp) {
        // 魔力不足 → 撤退（マナは既に消費済み、ツール・聖者はそのまま）
        newState = {
            ...newState,
            lastEvents: [...newState.lastEvents, `撤退: 魔力不足（魔力${power} < 聖者HP${saint.hp}）`],
        };
        return newState;
    }
    // 魔導具をタップ
    const newTappedIds = [...new Set([...player.tappedToolIds, ...tappedToolIds])];
    // 護符は戦闘で廃棄
    const usedAmulets = tappedToolIds
        .map((id) => player.magicTools.find((t) => t.id === id))
        .filter((t) => t && t.type === '護符' && t.effect.includes('戦闘：魔力＋3'));
    const amuletIds = usedAmulets.map((t) => t.id);
    // 戦闘聖遺物のマナボーナス（M41/M42: 魔力+2, マナ+1）
    let combatRelicMana = 0;
    for (const relicId of combatRelicIds) {
        const relic = player.relics.find((r) => r.id === relicId);
        if (relic && relic.effect.includes('マナ＋1')) {
            combatRelicMana += 1;
        }
    }
    // 聖者撃破報酬（通常マナ報酬はタップ、即時マナはアンタップ）
    let tappedManaGain = saint.manaReward + combatRelicMana;
    let untappedManaGain = 0;
    // 魔剣・杖の効果
    for (const toolId of tappedToolIds) {
        const tool = player.magicTools.find((t) => t.id === toolId);
        if (tool && tool.effect.includes('聖者撃破：即時マナ＋1')) {
            untappedManaGain += 1; // 即時 = アンタップ
        }
        else if (tool && tool.effect.includes('聖者撃破：マナ＋1')) {
            tappedManaGain += 1; // 通常 = タップ
        }
        if (tool && tool.effect.includes('聖者撃破：即時マナ＋2')) {
            untappedManaGain += 2; // 即時 = アンタップ
        }
    }
    // 聖遺物を山札から引く（展示なし）
    const drawnRelics = [];
    for (let i = 0; i < saint.relicDraw; i++) {
        if (newState.relicDeck.length > 0) {
            const drawnRelic = newState.relicDeck[0];
            drawnRelics.push(drawnRelic);
            newState = {
                ...newState,
                relicDeck: newState.relicDeck.slice(1),
                lastEvents: [...newState.lastEvents, `聖遺物獲得: ${drawnRelic.id}「${drawnRelic.effect}」`],
            };
        }
    }
    // 聖者展示の補充
    newState = {
        ...newState,
        saintSupply: newState.saintSupply.filter((s) => s.id !== saintId),
    };
    if (newState.saintDeck.length > 0) {
        const replenishedSaint = newState.saintDeck[0];
        newState = {
            ...newState,
            saintSupply: [...newState.saintSupply, replenishedSaint],
            saintDeck: newState.saintDeck.slice(1),
            lastEvents: [...newState.lastEvents, `聖者補充: ${replenishedSaint.name}(HP${replenishedSaint.hp}/★${replenishedSaint.victoryPoints}) が展示に追加されました`],
        };
    }
    // プレイヤー更新（戦闘聖遺物も廃棄→山札の一番下へ）
    // 聖者撃破マナ報酬はラウンド中に獲得するのでタップマナとして追加
    const updatedPlayer = getPlayer(newState, playerId);
    const allDiscardedRelicIds = new Set(combatRelicIds);
    newState = updatePlayer(newState, playerId, {
        tappedToolIds: newTappedIds.filter((id) => !amuletIds.includes(id)),
        magicTools: updatedPlayer.magicTools.filter((t) => !amuletIds.includes(t.id)),
        saints: [...updatedPlayer.saints, saint],
        relics: [...updatedPlayer.relics.filter((r) => !allDiscardedRelicIds.has(r.id)), ...drawnRelics],
        mana: updatedPlayer.mana + untappedManaGain, // 即時マナはアンタップ
        tappedMana: updatedPlayer.tappedMana + tappedManaGain, // 通常報酬はタップ
        victoryPoints: updatedPlayer.victoryPoints + saint.victoryPoints,
    });
    // 廃棄した護符を魔導具デッキの一番下に戻す
    for (const amulet of usedAmulets) {
        if (amulet) {
            newState = { ...newState, toolDeck: [...newState.toolDeck, amulet] };
        }
    }
    // 廃棄した戦闘聖遺物を聖遺物デッキの一番下に戻す
    for (const relicId of combatRelicIds) {
        const relic = updatedPlayer.relics.find((r) => r.id === relicId);
        if (relic) {
            newState = { ...newState, relicDeck: [...newState.relicDeck, relic] };
        }
    }
    // M67聖遺物：追加戦闘フラグ
    for (const relicId of combatRelicIds) {
        if (relicId === 'M67') {
            newState.extraCombatPlayerId = playerId;
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `⚔️ 聖遺物M67発動！追加戦闘が可能に`],
            };
        }
    }
    // 実績チェック
    newState = checkAchievements(newState, playerId, power);
    return newState;
}
function executeWitch(state, playerId, choice) {
    const player = getPlayer(state, playerId);
    if (player.witchTapped)
        throw new Error('魔女は既に使用済み');
    const bonus = state.witchUsageCount; // 0, 1, 2, 3...
    let newState = {
        ...state,
        witchUsageCount: state.witchUsageCount + 1,
    };
    if (choice === 'mana') {
        // 魔女マナモード：即時使用可能なアンタップマナとして追加
        newState = updatePlayer(newState, playerId, {
            witchTapped: true,
            witchMode: 'mana',
            mana: player.mana + 2 + bonus,
        });
    }
    else {
        // 魔力モード：以降の全戦闘で魔力+(3+bonus)のボーナス（ゲーム終了まで永続）
        newState = updatePlayer(newState, playerId, {
            witchTapped: true,
            witchMode: 'magic',
        });
    }
    return newState;
}
function executeRelic(state, playerId, relicId) {
    const player = getPlayer(state, playerId);
    const relic = player.relics.find((r) => r.id === relicId);
    if (!relic)
        throw new Error(`聖遺物 ${relicId} を持っていない`);
    let newState = { ...state };
    // 効果適用
    switch (relicId) {
        case 'M43':
        case 'M44': {
            // タップ済み魔導具をアンタップ
            newState = updatePlayer(newState, playerId, {
                tappedToolIds: [],
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
        case 'M56':
        case 'M57':
        case 'M58':
        case 'M59': {
            // 手番：タップマナをアンタップする。廃棄
            // タップマナを全てアンタップマナに変換する
            newState = updatePlayer(newState, playerId, {
                mana: player.mana + player.tappedMana,
                tappedMana: 0,
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
        case 'M52': {
            // 使い魔を未使用状態に
            newState = updatePlayer(newState, playerId, {
                familiarTapped: false,
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
        case 'M53': {
            // M53は select_free_tool アクションで処理するため、ここには来ない
            // フォールバック: 旧方式で呼ばれた場合の互換処理
            const freeTool = newState.toolSupply.find((t) => t.cost <= 3);
            if (freeTool) {
                newState = updatePlayer(newState, playerId, {
                    magicTools: [...player.magicTools, freeTool],
                    relics: player.relics.filter((r) => r.id !== relicId),
                });
                newState = {
                    ...newState,
                    toolSupply: newState.toolSupply.filter((t) => t.id !== freeTool.id),
                };
                // 売り場補充
                if (newState.toolDeck.length > 0) {
                    const replenished = newState.toolDeck[0];
                    newState = {
                        ...newState,
                        toolSupply: [...newState.toolSupply, replenished],
                        toolDeck: newState.toolDeck.slice(1),
                    };
                }
            }
            break;
        }
        case 'M60': {
            // 追加の手番（簡易：ターン巻き戻し）
            newState = updatePlayer(newState, playerId, {
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            // 次のadvanceTurnでこのプレイヤーのまま
            const idx = newState.players.findIndex((p) => p.config.id === playerId);
            newState.currentPlayerIndex = idx;
            break;
        }
        case 'M61': {
            // 魔導具所持数分のマナ：ラウンド中獲得なのでタップマナに追加
            newState = updatePlayer(newState, playerId, {
                tappedMana: player.tappedMana + player.magicTools.length,
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
        case 'M62': {
            // 勝利点分のマナ：ラウンド中獲得なのでタップマナに追加
            newState = updatePlayer(newState, playerId, {
                tappedMana: player.tappedMana + player.victoryPoints,
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
        case 'M63': {
            // 2アンタップマナを支払い、6タップマナを獲得
            if (player.mana >= 2) {
                newState = updatePlayer(newState, playerId, {
                    mana: player.mana - 2,
                    tappedMana: player.tappedMana + 6,
                    relics: player.relics.filter((r) => r.id !== relicId),
                });
            }
            break;
        }
        case 'M64': {
            // 手番：この手番中にマナを支払うなら、同じ数のマナを獲得。廃棄
            newState = updatePlayer(newState, playerId, {
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            newState.manaRefundPlayerId = playerId;
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `💎 聖遺物M64発動！この手番中のマナ支払いが全額還元される`],
            };
            break;
        }
        case 'M65': {
            // 手番：魔導具を1つ捨て、捨てた魔導具のコスト+3コストまでの魔導具を売り場から獲得。廃棄
            // コスト差が最大になる交換を探す（捨てる魔導具は自由に選べる）
            if (player.magicTools.length > 0 && newState.toolSupply.length > 0) {
                let bestExchange = null;
                for (const ownTool of player.magicTools) {
                    const maxCost = ownTool.cost + 3;
                    const candidates = newState.toolSupply.filter((t) => t.cost <= maxCost);
                    for (const candidate of candidates) {
                        const diff = candidate.cost - ownTool.cost;
                        if (!bestExchange || diff > bestExchange.diff) {
                            bestExchange = { discard: ownTool, gain: candidate, diff };
                        }
                    }
                }
                if (bestExchange) {
                    newState = updatePlayer(newState, playerId, {
                        magicTools: [...player.magicTools.filter((t) => t.id !== bestExchange.discard.id), bestExchange.gain],
                        relics: player.relics.filter((r) => r.id !== relicId),
                    });
                    newState = {
                        ...newState,
                        toolSupply: newState.toolSupply.filter((t) => t.id !== bestExchange.gain.id),
                        // 捨てた魔導具を山札の一番下に戻す
                        toolDeck: [...newState.toolDeck, bestExchange.discard],
                        lastEvents: [...newState.lastEvents, `🔄 聖遺物M65発動！${bestExchange.discard.name}(コスト${bestExchange.discard.cost})を捨てて${bestExchange.gain.name}(コスト${bestExchange.gain.cost})を獲得`],
                    };
                    // 魔導具補充
                    if (newState.toolDeck.length > 0) {
                        const replenished = newState.toolDeck[0];
                        newState = {
                            ...newState,
                            toolSupply: [...newState.toolSupply, replenished],
                            toolDeck: newState.toolDeck.slice(1),
                            lastEvents: [...newState.lastEvents, `魔導具補充: ${replenished.name}(コスト${replenished.cost}, 魔力${replenished.magicPower}) が展示に追加されました`],
                        };
                    }
                }
            }
            break;
        }
        case 'M66': {
            // 聖者を1つ捨てて4マナ：ラウンド中獲得なのでタップマナに追加
            if (player.saints.length > 0) {
                const discardedSaint = player.saints[player.saints.length - 1]; // 最後の聖者を捨てる
                newState = updatePlayer(newState, playerId, {
                    saints: player.saints.slice(0, -1),
                    victoryPoints: player.victoryPoints - discardedSaint.victoryPoints,
                    tappedMana: player.tappedMana + 4,
                    relics: player.relics.filter((r) => r.id !== relicId),
                });
            }
            break;
        }
        default: {
            // 未実装の聖遺物は廃棄のみ
            newState = updatePlayer(newState, playerId, {
                relics: player.relics.filter((r) => r.id !== relicId),
            });
            break;
        }
    }
    // 廃棄した聖遺物を聖遺物デッキの一番下に戻す
    const playerAfter = getPlayer(newState, playerId);
    if (!playerAfter.relics.some((r) => r.id === relicId) && relic) {
        newState = { ...newState, relicDeck: [...newState.relicDeck, relic] };
    }
    return newState;
}
// ── 実績チェック ──
function getAchievementScore(player, achievementId, combatPower) {
    switch (achievementId) {
        case 'M126': return player.magicTools.length; // 魔導具数
        case 'M127': return combatPower; // 戦闘魔力
        case 'M128': return player.saints.length; // 聖者数
        case 'M129': { // 同種魔導具の最大数
            const typeCounts = {};
            for (const tool of player.magicTools) {
                typeCounts[tool.type] = (typeCounts[tool.type] || 0) + 1;
            }
            return Math.max(0, ...Object.values(typeCounts));
        }
        case 'M130': return player.relics.length; // 聖遺物数
        default: return 0;
    }
}
function getAchievementThreshold(achievementId) {
    switch (achievementId) {
        case 'M126': return 5; // 魔導具5つ以上
        case 'M127': return 14; // 14以上の魔力
        case 'M128': return 5; // 聖者5つ以上
        case 'M129': return 3; // 同種3つ以上
        case 'M130': return 5; // 聖遺物5つ以上
        default: return 999;
    }
}
function checkAchievements(state, playerId, combatPower = 0) {
    let newState = { ...state };
    const player = getPlayer(newState, playerId);
    for (let i = 0; i < newState.achievements.length; i++) {
        const achievement = newState.achievements[i];
        const threshold = getAchievementThreshold(achievement.id);
        const playerScore = getAchievementScore(player, achievement.id, combatPower);
        if (playerScore < threshold)
            continue;
        // 条件達成: 保持者がいない場合 → 獲得
        if (!achievement.holderId) {
            newState = updatePlayer(newState, playerId, {
                victoryPoints: getPlayer(newState, playerId).victoryPoints + achievement.victoryPoints,
            });
            newState.achievements = newState.achievements.map((a) => a.id === achievement.id ? { ...a, holderId: playerId } : a);
            newState = {
                ...newState,
                lastEvents: [...newState.lastEvents, `🏆 実績達成「${achievement.name}」★+${achievement.victoryPoints}！（${achievement.condition}）`],
            };
        }
        else if (achievement.holderId !== playerId) {
            // 保持者が別のプレイヤー → 上回っていたら奪取
            const holderPlayer = getPlayer(newState, achievement.holderId);
            const holderScore = getAchievementScore(holderPlayer, achievement.id, 0);
            if (playerScore > holderScore) {
                // 旧保持者からVPを引く
                newState = updatePlayer(newState, achievement.holderId, {
                    victoryPoints: getPlayer(newState, achievement.holderId).victoryPoints - achievement.victoryPoints,
                });
                // 新保持者にVPを付与
                newState = updatePlayer(newState, playerId, {
                    victoryPoints: getPlayer(newState, playerId).victoryPoints + achievement.victoryPoints,
                });
                newState.achievements = newState.achievements.map((a) => a.id === achievement.id ? { ...a, holderId: playerId } : a);
                newState = {
                    ...newState,
                    lastEvents: [...newState.lastEvents, `🏆 実績奪取「${achievement.name}」！${holderPlayer.config.name}から${player.config.name}へ（★${achievement.victoryPoints}）`],
                };
            }
        }
    }
    return newState;
}
// ── パッシブ聖遺物によるVP計算（ゲーム終了時） ──
export function calculatePassiveRelicVP(player) {
    let vp = 0;
    for (const relic of player.relics) {
        if (relic.timing !== 'passive')
            continue;
        switch (relic.id) {
            case 'M45': // セラフィムかガブリエル所持
                if (player.saints.some((s) => s.name === 'セラフィム' || s.name === 'ガブリエル'))
                    vp++;
                break;
            case 'M46': // ウリエルかメタトロン所持
                if (player.saints.some((s) => s.name === 'ウリエル' || s.name === 'メタトロン'))
                    vp++;
                break;
            case 'M47': // ケルビムかアズラエル所持
                if (player.saints.some((s) => s.name === 'ケルビム' || s.name === 'アズラエル'))
                    vp++;
                break;
            case 'M48': { // 魔導具4種類以上
                const types = new Set(player.magicTools.map((t) => t.type));
                if (types.size >= 4)
                    vp++;
                break;
            }
            case 'M49': // 体力10以上の聖者所持
                if (player.saints.some((s) => s.hp >= 10))
                    vp++;
                break;
            case 'M50': // 護符所持
                if (player.magicTools.some((t) => t.type === '護符'))
                    vp++;
                break;
            case 'M51': // 勝利点0の聖者所持
                if (player.saints.some((s) => s.victoryPoints === 0))
                    vp++;
                break;
        }
    }
    return vp;
}
// パッシブ聖遺物VPの差分を全プレイヤーに適用
function recalcAllPassiveVP(state) {
    let newState = { ...state };
    for (const player of newState.players) {
        const currentPassive = calculatePassiveRelicVP(player);
        const diff = currentPassive - player.lastPassiveVP;
        if (diff !== 0) {
            newState = updatePlayer(newState, player.config.id, {
                victoryPoints: player.victoryPoints + diff,
                lastPassiveVP: currentPassive,
            });
            if (diff > 0) {
                newState = {
                    ...newState,
                    lastEvents: [...newState.lastEvents, `🔮 ${player.config.name}: パッシブ聖遺物ボーナス ★+${diff}`],
                };
            }
        }
    }
    return newState;
}
// ── ターン/ラウンド管理 ──
function advanceTurn(state) {
    // 勝利条件チェック
    if (state.players.some((p) => p.victoryPoints >= VICTORY_POINT_TARGET)) {
        // 誰かが7VPに到達 → ラウンド最後の人まで続ける
        // 最後の人 = startPlayerIndexの1つ前のプレイヤー
        const lastPlayerIndex = (state.startPlayerIndex - 1 + state.players.length) % state.players.length;
        if (state.currentPlayerIndex === lastPlayerIndex) {
            return endGame(state);
        }
    }
    const next = (state.currentPlayerIndex + 1) % state.players.length;
    return { ...state, currentPlayerIndex: next, manaRefundPlayerId: undefined };
}
function endRound(state) {
    // 勝利条件チェック
    if (state.players.some((p) => p.victoryPoints >= VICTORY_POINT_TARGET)) {
        return endGame(state);
    }
    // フィールドリセット
    let newState = {
        ...state,
        fieldActions: createFieldActions(),
        round: state.round + 1,
        consecutivePasses: 0,
        currentPlayerIndex: state.startPlayerIndex,
    };
    // 全プレイヤーの状態リセット
    newState = {
        ...newState,
        players: newState.players.map((p) => ({
            ...p,
            tappedToolIds: [], // 魔導具アンタップ
            passed: false,
            mana: p.mana + p.tappedMana + 1 // タップマナをアンタップ + ラウンド開始ボーナス+1
                + p.magicTools.filter((t) => !t.sealed).length, // 封なし魔導具1枚につき即時マナ+1
            tappedMana: 0, // タップマナリセット
        })),
    };
    // M27 水晶玉は「いつでもアンタップ」なので実質的に上記で処理済み
    return newState;
}
function endGame(state) {
    return { ...state, phase: 'finished' };
}
// ── 最終スコア ──
export function getMajoFinalScores(state) {
    const scores = state.players.map((p) => ({
        playerId: p.config.id,
        name: p.config.name,
        victoryPoints: p.victoryPoints,
        saints: p.saints.length,
        tools: p.magicTools.length,
        relics: p.relics.length,
        rank: 0,
    }));
    // タイブレーカー: 勝利点 → 聖者数 → 魔導具数 → マナ(アンタップ+タップ)
    scores.sort((a, b) => {
        if (b.victoryPoints !== a.victoryPoints)
            return b.victoryPoints - a.victoryPoints;
        if (b.saints !== a.saints)
            return b.saints - a.saints;
        if (b.tools !== a.tools)
            return b.tools - a.tools;
        const manaA = state.players.find(p => p.config.id === a.playerId);
        const manaB = state.players.find(p => p.config.id === b.playerId);
        return (manaB.mana + manaB.tappedMana) - (manaA.mana + manaA.tappedMana);
    });
    let rank = 1;
    for (let i = 0; i < scores.length; i++) {
        if (i > 0) {
            const prev = scores[i - 1];
            const curr = scores[i];
            const prevPlayer = state.players.find(p => p.config.id === prev.playerId);
            const currPlayer = state.players.find(p => p.config.id === curr.playerId);
            if (curr.victoryPoints < prev.victoryPoints ||
                curr.saints < prev.saints ||
                curr.tools < prev.tools ||
                (currPlayer.mana + currPlayer.tappedMana) < (prevPlayer.mana + prevPlayer.tappedMana)) {
                rank = i + 1;
            }
        }
        scores[i].rank = rank;
    }
    return scores;
}
export function isMajoGameOver(state) {
    return state.phase === 'finished';
}
