// 魔女ゲー AI戦略
import { getPlayer, getAvailableActions, getEffectiveMagicPower, } from '../engine/majo.js';
// ── 共通ヘルパー ──
function selectToolsForCombat(player, targetHP) {
    const availableTools = player.magicTools
        .filter((t) => !player.tappedToolIds.includes(t.id))
        .map((t) => ({
        ...t,
        effectivePower: getEffectiveMagicPower(t, player.magicTools) +
            (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') ? 3 : 0),
    }))
        .sort((a, b) => b.effectivePower - a.effectivePower);
    const selected = [];
    let currentPower = 0;
    for (const tool of availableTools) {
        if (currentPower >= targetHP)
            break;
        selected.push(tool.id);
        currentPower += tool.effectivePower;
    }
    return selected;
}
function getAvailablePower(player) {
    const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
    let power = 0;
    for (const t of availableTools) {
        power += getEffectiveMagicPower(t, player.magicTools);
        if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3')) {
            power += 3;
        }
    }
    return power;
}
// 戦闘聖遺物で追加できる魔力
function getCombatRelicPower(player) {
    let power = 0;
    const relicIds = [];
    for (const relic of player.relics) {
        if (relic.timing === 'combat' && relic.isDisposable) {
            if (relic.effect.includes('魔力＋2')) {
                power += 2;
                relicIds.push(relic.id);
            }
        }
    }
    return { power, relicIds };
}
// 倒せる聖者リスト（戦闘聖遺物の魔力ブーストも考慮）
function getKillableSaints(state, player) {
    const toolPower = getAvailablePower(player);
    const { power: relicPower } = getCombatRelicPower(player);
    const totalPower = toolPower + relicPower;
    return state.saintSupply
        .filter((s) => s.hp <= totalPower)
        .sort((a, b) => b.victoryPoints - a.victoryPoints || b.hp - a.hp);
}
// 戦闘に必要な聖遺物を選ぶ（魔導具だけで足りない場合）
function selectCombatRelics(player, targetHP, toolPower) {
    if (toolPower >= targetHP)
        return []; // 聖遺物不要
    const needed = targetHP - toolPower;
    const relicIds = [];
    let gained = 0;
    for (const relic of player.relics) {
        if (gained >= needed)
            break;
        if (relic.timing === 'combat' && relic.isDisposable && relic.effect.includes('魔力＋2')) {
            relicIds.push(relic.id);
            gained += 2;
        }
    }
    return relicIds;
}
// M67（追加戦闘）を使うべきか判断：未タップ魔導具が残っていて倒せる聖者がいるなら使う
function shouldUseM67(state, player, currentSaintId) {
    const m67 = player.relics.find((r) => r.id === 'M67');
    if (!m67)
        return false;
    // 現在の戦闘で使う魔導具をタップした後、残りの魔導具で倒せる聖者がいるか
    // 簡易判定：倒せる聖者が2体以上いるなら追加戦闘の価値あり
    const killable = getKillableSaints(state, player);
    return killable.length >= 2;
}
// 追加戦闘で倒せる聖者を選ぶ
function selectExtraCombatTarget(state, player) {
    const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
    const toolPower = availableTools.reduce((sum, t) => {
        let p = getEffectiveMagicPower(t, player.magicTools);
        if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3'))
            p += 3;
        return sum + p;
    }, 0);
    const { power: relicPower } = getCombatRelicPower(player);
    const killable = state.saintSupply
        .filter((s) => s.hp <= toolPower + relicPower)
        .sort((a, b) => b.victoryPoints - a.victoryPoints);
    if (killable.length === 0)
        return null;
    const target = killable[0];
    const toolIds = selectToolsForCombat({ ...player, tappedToolIds: player.tappedToolIds }, // 現在のタップ状態を使う
    target.hp);
    return { saintId: target.id, toolIds };
}
function findResearchAction(actions, toolId) {
    return actions.find((a) => (a.type === 'field_action' || a.type === 'use_familiar') &&
        'details' in a && a.details.action === 'research' && a.details.toolId === toolId);
}
function findViolenceAction(actions, saintId) {
    // 新方式: combat_select_saint (violence)
    const newStyle = actions.find((a) => a.type === 'combat_select_saint' && a.fieldId === 'violence' && a.saintId === saintId);
    if (newStyle)
        return newStyle;
    // 旧方式フォールバック（使われないが念のため）
    return actions.find((a) => (a.type === 'field_action' || a.type === 'use_familiar') &&
        'details' in a && a.details.action === 'violence' && a.details.saintId === saintId);
}
function findFieldAction(actions, actionName) {
    return actions.find((a) => (a.type === 'field_action' || a.type === 'use_familiar') &&
        'details' in a && a.details.action === actionName);
}
function getToolCombatPower(t, allTools) {
    let power = getEffectiveMagicPower(t, allTools);
    // 護符の戦闘ボーナス（使い捨てだが即戦力）
    if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3')) {
        power += 3;
    }
    return power;
}
function getBestToolToBuy(state, player) {
    const affordable = state.toolSupply
        .filter((t) => t.cost <= player.mana)
        .map((t) => {
        const power = getToolCombatPower(t, player.magicTools);
        return {
            toolId: t.id,
            name: t.name,
            cost: t.cost,
            power,
            ratio: power / t.cost,
        };
    })
        .filter((t) => t.power > 0)
        .sort((a, b) => b.ratio - a.ratio);
    return affordable[0] || null;
}
// 戦闘アクションを最適化（combat_select_saint対応）
// 注意: マルチステップ方式では、combat_select_saintを返すだけでよい
// ツール選択はselectCombatStepActionが担当する
function buildCombatAction(state, baseAction, player, targetHP) {
    // combat_select_saint の場合はそのまま返す（ツール選択はマルチステップで実施）
    if (baseAction.type === 'combat_select_saint') {
        return baseAction;
    }
    // 旧方式（field_action/use_familiar）のフォールバック
    const toolsToTap = selectToolsForCombat(player, targetHP);
    const toolPower = toolsToTap.reduce((sum, id) => {
        const t = player.magicTools.find((tool) => tool.id === id);
        if (!t)
            return sum;
        let p = getEffectiveMagicPower(t, player.magicTools);
        if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3'))
            p += 3;
        return sum + p;
    }, 0);
    const combatRelics = selectCombatRelics(player, targetHP, toolPower);
    if ('details' in baseAction && (baseAction.details.action === 'violence' || baseAction.details.action === 'sacrifice')) {
        const saintId = baseAction.details.saintId;
        if (shouldUseM67(state, player, saintId)) {
            const remainingUntapped = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id) && !toolsToTap.includes(t.id));
            if (remainingUntapped.length > 0) {
                combatRelics.push('M67');
            }
        }
        return {
            ...baseAction,
            details: { ...baseAction.details, tappedToolIds: toolsToTap, combatRelicIds: combatRelics },
        };
    }
    return baseAction;
}
// 使える手番聖遺物の中で最も有効なものを選ぶ
function selectBestTurnRelic(state, player) {
    // タップマナが大量にある場合、アンタップ聖遺物（M56-M59）を最優先
    // タップマナが2以上あれば即使う価値がある
    if (player.tappedMana >= 2) {
        for (const relic of player.relics) {
            if (!relic.isDisposable || relic.timing !== 'turn')
                continue;
            if (relic.id === 'M56' || relic.id === 'M57' || relic.id === 'M58' || relic.id === 'M59') {
                return {
                    relicId: relic.id,
                    reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ！即座に使えるマナに変換`,
                };
            }
        }
    }
    for (const relic of player.relics) {
        if (!relic.isDisposable || relic.timing !== 'turn')
            continue;
        switch (relic.id) {
            case 'M43':
            case 'M44': {
                // タップ済み魔導具がある場合にアンタップ
                if (player.tappedToolIds.length > 0) {
                    return { relicId: relic.id, reasoning: `聖遺物で魔導具${player.tappedToolIds.length}個をアンタップ！` };
                }
                break;
            }
            case 'M56':
            case 'M57':
            case 'M58':
            case 'M59': {
                // タップマナが1でもあれば使う価値あり
                if (player.tappedMana >= 1) {
                    return {
                        relicId: relic.id,
                        reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ`,
                    };
                }
                break;
            }
            case 'M52': {
                // 使い魔リセット
                if (player.familiarTapped) {
                    return { relicId: relic.id, reasoning: `聖遺物で使い魔を復活！` };
                }
                break;
            }
            case 'M53': {
                // 3コスト以下の魔導具をタダで獲得
                if (state.toolSupply.some((t) => t.cost <= 3)) {
                    return { relicId: relic.id, reasoning: `聖遺物で魔導具をタダで獲得！` };
                }
                break;
            }
            case 'M61': {
                // 魔導具所持数分のタップマナ獲得（次ラウンドで使える）
                if (player.magicTools.length >= 3) {
                    return { relicId: relic.id, reasoning: `聖遺物で${player.magicTools.length}タップマナ獲得（次ラウンドで使用可）！` };
                }
                break;
            }
            case 'M63': {
                // 2アンタップマナ→6タップマナ（次ラウンドで使える大量マナ）
                if (player.mana >= 2) {
                    return { relicId: relic.id, reasoning: `聖遺物で2マナ→6タップマナに変換（次ラウンドで使用可）！` };
                }
                break;
            }
            case 'M60': {
                // 追加ターン（何かやることがある時に）
                if (player.mana >= 3 || player.tappedToolIds.length === 0) {
                    return { relicId: relic.id, reasoning: `聖遺物で追加ターン獲得！` };
                }
                break;
            }
            case 'M64': {
                // マナ支払い分還元（高コスト魔導具購入や戦闘前に使うと最大効率）
                if (player.mana >= 3) {
                    return { relicId: relic.id, reasoning: `聖遺物M64発動！この手番のマナ支払いが全額還元` };
                }
                break;
            }
            case 'M65': {
                // 魔導具交換（売り場にコストが高い魔導具があるなら交換の価値あり）
                if (player.magicTools.length > 0 && state.toolSupply.length > 0) {
                    const minOwnCost = Math.min(...player.magicTools.map((t) => t.cost));
                    const maxSupplyCost = Math.max(...state.toolSupply.map((t) => t.cost));
                    if (maxSupplyCost > minOwnCost) {
                        return { relicId: relic.id, reasoning: `聖遺物M65で魔導具交換！コスト${minOwnCost}→コスト${Math.min(minOwnCost + 3, maxSupplyCost)}にアップグレード` };
                    }
                }
                break;
            }
        }
    }
    return null;
}
// 戦闘マルチステップ中の最適アクションを選ぶ
function selectCombatStepAction(state, player, playerId, actions) {
    if (!state.combatState || state.combatState.playerId !== playerId)
        return null;
    const cs = state.combatState;
    const saint = state.saintSupply.find((s) => s.id === cs.saintId);
    if (!saint)
        return null;
    // 最適ツール選択リストを計算（現在選択済みを除く）
    const alreadySelected = new Set(cs.selectedToolIds);
    const tempPlayer = { ...player, tappedToolIds: [...player.tappedToolIds, ...cs.selectedToolIds] };
    const optimalTools = selectToolsForCombat(tempPlayer, saint.hp);
    // まだ最適リストに含まれるツールで未追加のものがあれば追加
    const nextTool = optimalTools.find((id) => !alreadySelected.has(id));
    if (nextTool) {
        const addAction = actions.find((a) => a.type === 'combat_add_tool' && a.toolId === nextTool);
        if (addAction) {
            const tool = player.magicTools.find((t) => t.id === nextTool);
            return {
                action: addAction,
                reasoning: `${saint.name}(HP${saint.hp})に向けて${tool?.name ?? nextTool}を追加`,
            };
        }
    }
    // 全最適ツールを追加済み → 戦闘実行
    const execAction = actions.find((a) => a.type === 'combat_execute');
    if (execAction) {
        const currentPower = cs.selectedToolIds.reduce((sum, id) => {
            const t = player.magicTools.find((tt) => tt.id === id);
            if (!t)
                return sum;
            return sum + getEffectiveMagicPower(t, player.magicTools)
                + (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') ? 3 : 0);
        }, 0);
        if (currentPower >= saint.hp) {
            return {
                action: execAction,
                reasoning: `魔力${currentPower}で${saint.name}(HP${saint.hp})を撃破！`,
            };
        }
        // 魔力不足でも最大限追加したので撤退
        const retreatAction = actions.find((a) => a.type === 'combat_retreat');
        if (retreatAction) {
            return {
                action: retreatAction,
                reasoning: `魔力不足(${currentPower} < HP${saint.hp})のため撤退`,
            };
        }
    }
    return null;
}
// 追加戦闘アクションがあれば選択
function selectExtraCombatAction(actions, state, player) {
    const extraActions = actions.filter((a) => a.type === 'extra_combat');
    if (extraActions.length === 0)
        return null;
    // 倒せる聖者の中で最もVPが高いものを狙う
    const target = selectExtraCombatTarget(state, player);
    if (!target)
        return null;
    const act = extraActions.find((a) => a.type === 'extra_combat' && a.saintId === target.saintId);
    if (!act)
        return null;
    const saint = state.saintSupply.find((s) => s.id === target.saintId);
    if (!saint)
        return null;
    // 必要な魔導具だけを選択
    return {
        action: { ...act, tappedToolIds: target.toolIds },
        reasoning: `⚔️ M67追加戦闘！${saint.name}(HP${saint.hp}/★${saint.victoryPoints})を撃破！`,
    };
}
// ── バランス型 ──
const balanced = {
    id: 'majo_balanced',
    name: 'バランス型',
    description: '序盤は魔導具で基盤を作り、中盤以降に聖者を狙う堅実な戦略',
    personality: '冷静沈着で計算高い魔女。無駄なく効率的に動く',
    selectAction(state, playerId) {
        const player = getPlayer(state, playerId);
        const actions = getAvailableActions(state, playerId);
        const fieldActions = actions.filter((a) => a.type === 'field_action' || a.type === 'use_familiar');
        const passAction = actions.find((a) => a.type === 'pass');
        // 戦闘マルチステップ中の処理
        const combatStep = selectCombatStepAction(state, player, playerId, actions);
        if (combatStep)
            return combatStep;
        // 追加戦闘（M67）が可能なら最優先で実行
        const extraCombat = selectExtraCombatAction(actions, state, player);
        if (extraCombat)
            return extraCombat;
        const killableSaints = getKillableSaints(state, player);
        // 0. 有効な手番聖遺物があれば使う
        const bestRelic = selectBestTurnRelic(state, player);
        if (bestRelic) {
            return {
                action: { type: 'use_relic', playerId, relicId: bestRelic.relicId },
                reasoning: bestRelic.reasoning,
            };
        }
        // 1. VP持ちの聖者を倒せるなら最優先
        if (killableSaints.length > 0 && killableSaints[0].victoryPoints > 0 && player.mana >= 2) {
            const target = killableSaints[0];
            const act = findViolenceAction(actions, target.id);
            if (act) {
                const optimized = buildCombatAction(state, act, player, target.hp);
                return { action: optimized, reasoning: `${target.name}(HP${target.hp}/★${target.victoryPoints})を撃破！` };
            }
        }
        // 2. 魔導具が足りない → 買う
        if (player.magicTools.length < 3) {
            const best = getBestToolToBuy(state, player);
            if (best) {
                const act = findResearchAction(fieldActions, best.toolId);
                if (act)
                    return { action: act, reasoning: `${best.name}(コスト${best.cost}/魔力${best.power})を購入` };
            }
            // 買えないならマナを貯める
            if (player.mana <= 3) {
                const shopAct = findFieldAction(fieldActions, 'magic_shop');
                if (shopAct)
                    return { action: shopAct, reasoning: `魔導具購入のためマナ補充` };
            }
        }
        // 3. 0星でも倒せる聖者がいれば倒す（聖遺物が手に入る）
        if (killableSaints.length > 0 && player.mana >= 2) {
            const target = killableSaints[0];
            const act = findViolenceAction(actions, target.id);
            if (act) {
                const optimized = buildCombatAction(state, act, player, target.hp);
                return { action: optimized, reasoning: `${target.name}(HP${target.hp})を倒して聖遺物${target.relicDraw}枚獲得` };
            }
        }
        // 4. 魔導具を追加購入
        const best = getBestToolToBuy(state, player);
        if (best) {
            const act = findResearchAction(fieldActions, best.toolId);
            if (act)
                return { action: act, reasoning: `${best.name}(魔力${best.power})を追加購入` };
        }
        // 5. マナ補充
        if (player.mana <= 3) {
            const shopAct = findFieldAction(fieldActions, 'magic_shop');
            if (shopAct)
                return { action: shopAct, reasoning: `マナ補充(現在${player.mana})` };
        }
        // 6. 魔女（マナモード、魔導具揃ってから）
        if (!player.witchTapped && player.magicTools.length >= 2) {
            const witchAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'mana');
            if (witchAction) {
                const gain = 2 + state.witchUsageCount;
                return { action: witchAction, reasoning: `魔女マナモード → +${gain}マナ` };
            }
        }
        // 7. マナがあるなら魔具店（パスするよりマシ）
        const shopAct = findFieldAction(fieldActions, 'magic_shop');
        if (shopAct)
            return { action: shopAct, reasoning: `パスよりマナ補充` };
        return { action: passAction, reasoning: 'やることなし' };
    },
};
// ── 攻撃型 ──
const aggressive = {
    id: 'majo_aggressive',
    name: '攻撃型',
    description: '高魔力の魔導具を優先し、早期に聖者を倒しまくる',
    personality: '好戦的で野心家の魔女。最短ルートで勝利を目指す',
    selectAction(state, playerId) {
        const player = getPlayer(state, playerId);
        const actions = getAvailableActions(state, playerId);
        const fieldActions = actions.filter((a) => a.type === 'field_action' || a.type === 'use_familiar');
        const passAction = actions.find((a) => a.type === 'pass');
        // 戦闘マルチステップ中の処理
        const combatStep = selectCombatStepAction(state, player, playerId, actions);
        if (combatStep)
            return combatStep;
        // 追加戦闘（M67）が可能なら最優先で実行
        const extraCombat = selectExtraCombatAction(actions, state, player);
        if (extraCombat)
            return extraCombat;
        const killableSaints = getKillableSaints(state, player);
        // 0. アンタップ系聖遺物を最優先（戦闘後に使って再戦闘！）
        if (player.tappedToolIds.length > 0) {
            const untapRelic = player.relics.find((r) => (r.id === 'M43' || r.id === 'M44') && r.isDisposable);
            if (untapRelic) {
                return {
                    action: { type: 'use_relic', playerId, relicId: untapRelic.id },
                    reasoning: `聖遺物で魔導具アンタップ → 連続戦闘！`,
                };
            }
        }
        // 0.5. その他有効な聖遺物
        const bestRelic = selectBestTurnRelic(state, player);
        if (bestRelic) {
            return {
                action: { type: 'use_relic', playerId, relicId: bestRelic.relicId },
                reasoning: bestRelic.reasoning,
            };
        }
        // 1. 倒せる聖者がいればとにかく倒す
        if (killableSaints.length > 0 && player.mana >= 2) {
            const target = killableSaints[0];
            const act = findViolenceAction(actions, target.id);
            if (act) {
                const optimized = buildCombatAction(state, act, player, target.hp);
                return { action: optimized, reasoning: `攻撃！${target.name}(HP${target.hp}/★${target.victoryPoints})を撃破！` };
            }
        }
        // 2. 魔導具を買う（高魔力優先）
        const affordable = state.toolSupply
            .filter((t) => t.cost <= player.mana)
            .map((t) => ({ ...t, ep: getEffectiveMagicPower(t, player.magicTools) }))
            .filter((t) => t.ep > 0)
            .sort((a, b) => b.ep - a.ep);
        if (affordable.length > 0) {
            const tool = affordable[0];
            const act = findResearchAction(fieldActions, tool.id);
            if (act)
                return { action: act, reasoning: `高魔力の${tool.name}(魔力${tool.ep})を購入` };
        }
        // 3. マナ補充
        if (player.mana <= 2) {
            const shopAct = findFieldAction(fieldActions, 'magic_shop');
            if (shopAct)
                return { action: shopAct, reasoning: `マナ補充して攻撃に備える` };
        }
        // 4. 魔女（マナモード）
        if (!player.witchTapped && player.magicTools.length >= 1) {
            const witchAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'mana');
            if (witchAction) {
                const gain = 2 + state.witchUsageCount;
                return { action: witchAction, reasoning: `魔女マナモード → +${gain}マナ` };
            }
        }
        // 5. マナ稼ぎ（パスより良い）
        const shopAct = findFieldAction(fieldActions, 'magic_shop');
        if (shopAct)
            return { action: shopAct, reasoning: `マナを貯めて次に備える` };
        return { action: passAction, reasoning: '力を溜める' };
    },
};
// ── 経済型 ──
const economist = {
    id: 'majo_economist',
    name: '経済型',
    description: 'マナ効率を最大化し、聖遺物エンジンで回す',
    personality: '計算高い商人気質の魔女。聖遺物の使い方が上手い',
    selectAction(state, playerId) {
        const player = getPlayer(state, playerId);
        const actions = getAvailableActions(state, playerId);
        const fieldActions = actions.filter((a) => a.type === 'field_action' || a.type === 'use_familiar');
        const passAction = actions.find((a) => a.type === 'pass');
        // 戦闘マルチステップ中の処理
        const combatStep = selectCombatStepAction(state, player, playerId, actions);
        if (combatStep)
            return combatStep;
        // 追加戦闘（M67）が可能なら最優先で実行
        const extraCombat = selectExtraCombatAction(actions, state, player);
        if (extraCombat)
            return extraCombat;
        const killableSaints = getKillableSaints(state, player);
        // 0. 聖遺物を積極的に使う（経済型の特徴）
        // マナ生成系を優先
        const manaRelic = player.relics.find((r) => r.isDisposable && r.timing === 'turn' &&
            (r.id === 'M63' && player.mana >= 2 || r.id === 'M61' && player.magicTools.length >= 2));
        if (manaRelic) {
            const gain = manaRelic.id === 'M63' ? 4 : player.magicTools.length;
            return {
                action: { type: 'use_relic', playerId, relicId: manaRelic.id },
                reasoning: `聖遺物でマナ+${gain}！`,
            };
        }
        // その他の手番聖遺物
        const bestRelic = selectBestTurnRelic(state, player);
        if (bestRelic) {
            return {
                action: { type: 'use_relic', playerId, relicId: bestRelic.relicId },
                reasoning: bestRelic.reasoning,
            };
        }
        // 1. VP聖者を倒す
        if (killableSaints.length > 0 && killableSaints[0].victoryPoints > 0 && player.mana >= 2) {
            const target = killableSaints[0];
            const act = findViolenceAction(actions, target.id);
            if (act) {
                const optimized = buildCombatAction(state, act, player, target.hp);
                return { action: optimized, reasoning: `${target.name}(★${target.victoryPoints})を撃破` };
            }
        }
        // 2. コスト削減の魔導具を優先
        const discountTools = state.toolSupply.filter((t) => t.effect.includes('コスト-') && t.cost <= player.mana);
        if (discountTools.length > 0 && player.magicTools.length < 4) {
            const tool = discountTools[0];
            const act = findResearchAction(fieldActions, tool.id);
            if (act)
                return { action: act, reasoning: `コスト削減の${tool.name}を購入` };
        }
        // 3. コスパ良い魔導具
        const best = getBestToolToBuy(state, player);
        if (best && player.magicTools.length < 4) {
            const act = findResearchAction(fieldActions, best.toolId);
            if (act)
                return { action: act, reasoning: `${best.name}(魔力${best.power}/コスト${best.cost})を購入` };
        }
        // 4. 0星聖者も聖遺物目当てで倒す（経済型の特徴：聖遺物エンジン）
        if (killableSaints.length > 0 && player.mana >= 2) {
            const target = killableSaints[0];
            const act = findViolenceAction(actions, target.id);
            if (act) {
                const optimized = buildCombatAction(state, act, player, target.hp);
                return { action: optimized, reasoning: `${target.name}を倒して聖遺物${target.relicDraw}枚獲得（エンジン構築）` };
            }
        }
        // 5. マナ補充
        if (player.mana <= 3) {
            const shopAct = findFieldAction(fieldActions, 'magic_shop');
            if (shopAct)
                return { action: shopAct, reasoning: `マナ補充` };
        }
        // 6. 魔女（遅めに使ってスタック最大化）
        if (!player.witchTapped && player.magicTools.length >= 2 && state.round >= 3) {
            const witchAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'mana');
            if (witchAction) {
                const gain = 2 + state.witchUsageCount;
                return { action: witchAction, reasoning: `魔女マナモード → +${gain}マナ` };
            }
        }
        // 7. まだ買えるなら買う
        if (best) {
            const act = findResearchAction(fieldActions, best.toolId);
            if (act)
                return { action: act, reasoning: `追加の${best.name}を購入` };
        }
        // 8. マナ稼ぎ
        const shopAct = findFieldAction(fieldActions, 'magic_shop');
        if (shopAct)
            return { action: shopAct, reasoning: `パスよりマナ補充` };
        return { action: passAction, reasoning: 'マナ温存' };
    },
};
// ── エクスポート ──
export const majoStrategies = {
    majo_balanced: balanced,
    majo_aggressive: aggressive,
    majo_economist: economist,
};
export const majoStrategyIds = Object.keys(majoStrategies);
export function getMajoStrategy(id) {
    const s = majoStrategies[id];
    if (!s)
        throw new Error(`魔女ゲー戦略 ${id} が見つからない`);
    return s;
}
export function getRandomMajoStrategy() {
    const ids = majoStrategyIds;
    return majoStrategies[ids[Math.floor(Math.random() * ids.length)]];
}
