// 魔女ゲー パラメータ化戦略（遺伝的アルゴリズム用）

import type { MajoGameState, MajoAction, MajoAIStrategy, MajoPlayerState } from '../engine/majo-types.js';
import {
  getPlayer, getAvailableActions, getEffectiveMagicPower,
} from '../engine/majo.js';

// ── ヘルパー関数（majo-strategies.tsから再エクスポート用に公開） ──
// 注意: majo-strategies.tsのヘルパーは全てプライベートなので、ここで同等実装を提供

// 護符の戦闘ボーナスを効果テキストからパースする
function getAmuletCombatBonus(tool: { type: string; effect: string }): number {
  if (tool.type !== '護符') return 0;
  const m = tool.effect.match(/戦闘：魔力＋(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function selectToolsForCombat(player: MajoPlayerState, targetHP: number): string[] {
  const availableTools = player.magicTools
    .filter((t) => !player.tappedToolIds.includes(t.id))
    .map((t) => ({
      ...t,
      basePower: getEffectiveMagicPower(t, player.magicTools),
      amuletBonus: getAmuletCombatBonus(t),
    }));

  const nonAmulets = availableTools
    .filter((t) => t.amuletBonus === 0)
    .sort((a, b) => a.basePower - b.basePower);

  // 最小魔力セット：高い方から貪欲に選んで、不要なツールを除去/小さいものに置換
  const highFirst = [...nonAmulets].reverse();
  const greedy: typeof nonAmulets = [];
  let greedyPower = 0;

  for (const tool of highFirst) {
    if (greedyPower >= targetHP) break;
    greedy.push(tool);
    greedyPower += tool.basePower;
  }

  if (greedyPower >= targetHP) {
    const used = new Set(greedy.map((t) => t.id));
    for (let i = greedy.length - 1; i >= 0; i--) {
      const current = greedy[i];
      const powerWithout = greedyPower - current.basePower;
      if (powerWithout >= targetHP) {
        greedyPower = powerWithout;
        greedy.splice(i, 1);
        continue;
      }
      const deficit = targetHP - powerWithout;
      const smaller = nonAmulets.find(
        (t) => !used.has(t.id) && t.basePower >= deficit && t.basePower < current.basePower,
      );
      if (smaller) {
        used.delete(current.id);
        used.add(smaller.id);
        greedyPower = powerWithout + smaller.basePower;
        greedy[i] = smaller;
      }
    }
    return greedy.map((t) => t.id);
  }

  // 護符なしで足りない → 全投入 + 護符追加
  const selected = nonAmulets.map((t) => t.id);
  let currentPower = nonAmulets.reduce((s, t) => s + t.basePower, 0);

  const amulets = availableTools
    .filter((t) => t.amuletBonus > 0)
    .sort((a, b) => (b.basePower + b.amuletBonus) - (a.basePower + a.amuletBonus));

  for (const tool of amulets) {
    if (currentPower >= targetHP) break;
    selected.push(tool.id);
    currentPower += tool.basePower + tool.amuletBonus;
  }

  return selected;
}

function getAvailablePower(player: MajoPlayerState, round: number = 1): number {
  const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
  let power = 0;
  for (const t of availableTools) {
    power += getEffectiveMagicPower(t, player.magicTools);
    power += getAmuletCombatBonus(t);
  }
  // 魔女魔力モード：ラウンド数ぶんのボーナス
  if (player.witchTapped && player.witchMode === 'magic') {
    power += round;
  }
  return power;
}

function getCombatRelicPower(player: MajoPlayerState): { power: number; relicIds: string[] } {
  let power = 0;
  const relicIds: string[] = [];
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

function getKillableSaints(state: MajoGameState, player: MajoPlayerState) {
  const toolPower = getAvailablePower(player, state.round);
  const { power: relicPower } = getCombatRelicPower(player);
  const totalPower = toolPower + relicPower;

  return state.saintSupply
    .filter((s) => s.hp <= totalPower)
    .sort((a, b) => b.victoryPoints - a.victoryPoints || b.hp - a.hp);
}

function selectCombatRelics(player: MajoPlayerState, targetHP: number, toolPower: number): string[] {
  if (toolPower >= targetHP) return [];

  const needed = targetHP - toolPower;
  const relicIds: string[] = [];
  let gained = 0;

  for (const relic of player.relics) {
    if (gained >= needed) break;
    if (relic.timing === 'combat' && relic.isDisposable && relic.effect.includes('魔力＋2')) {
      relicIds.push(relic.id);
      gained += 2;
    }
  }

  return relicIds;
}

function selectExtraCombatTarget(state: MajoGameState, player: MajoPlayerState): { saintId: string; toolIds: string[] } | null {
  const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
  const toolPower = availableTools.reduce((sum, t) => {
    let p = getEffectiveMagicPower(t, player.magicTools);
    if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3')) p += 3;
    return sum + p;
  }, 0);
  const { power: relicPower } = getCombatRelicPower(player);

  const killable = state.saintSupply
    .filter((s) => s.hp <= toolPower + relicPower)
    .sort((a, b) => b.victoryPoints - a.victoryPoints);

  if (killable.length === 0) return null;

  const target = killable[0];
  const toolIds = selectToolsForCombat(player, target.hp);
  return { saintId: target.id, toolIds };
}

function getToolCombatPower(t: { id: string; type: string; magicPower: number; effect: string; cost: number }, allTools: { id: string; type: string; magicPower: number; effect: string; cost: number }[]): number {
  let power = getEffectiveMagicPower(t as any, allTools as any);
  if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3')) {
    power += 3;
  }
  return power;
}

function findViolenceAction(actions: MajoAction[], saintId: string, allowFamiliar = true): MajoAction | undefined {
  const normalCombat = actions.find((a) =>
    a.type === 'combat_select_saint' && a.fieldId === 'violence' && a.saintId === saintId && !a.useFamiliar
  );
  if (normalCombat) return normalCombat;
  if (allowFamiliar) {
    const familiarCombat = actions.find((a) =>
      a.type === 'combat_select_saint' && a.fieldId === 'violence' && a.saintId === saintId && a.useFamiliar
    );
    if (familiarCombat) return familiarCombat;
  }
  const normalOld = actions.find((a) =>
    a.type === 'field_action' &&
    'details' in a && (a.details as any).action === 'violence' && (a.details as any).saintId === saintId
  );
  if (normalOld) return normalOld;
  if (!allowFamiliar) return undefined;
  return actions.find((a) =>
    a.type === 'use_familiar' &&
    'details' in a && (a.details as any).action === 'violence' && (a.details as any).saintId === saintId
  );
}

function findResearchAction(actions: MajoAction[], toolId: string, allowFamiliar = true): MajoAction | undefined {
  // 通常のfield_actionを全て集め、割引が最大のものを選ぶ
  const normals = actions.filter((a) =>
    a.type === 'field_action' &&
    'details' in a && a.details.action === 'research' && a.details.toolId === toolId
  );
  if (normals.length > 0) {
    return normals.reduce((best, a) => {
      const bestDiscount = (best as any).details?.discountToolIds?.length ?? 0;
      const aDiscount = (a as any).details?.discountToolIds?.length ?? 0;
      return aDiscount > bestDiscount ? a : best;
    });
  }
  if (!allowFamiliar) return undefined;
  const familiars = actions.filter((a) =>
    a.type === 'use_familiar' &&
    'details' in a && a.details.action === 'research' && a.details.toolId === toolId
  );
  if (familiars.length === 0) return undefined;
  return familiars.reduce((best, a) => {
    const bestDiscount = (best as any).details?.discountToolIds?.length ?? 0;
    const aDiscount = (a as any).details?.discountToolIds?.length ?? 0;
    return aDiscount > bestDiscount ? a : best;
  });
}

function findFieldAction(actions: MajoAction[], actionName: string, allowFamiliar = true): MajoAction | undefined {
  const normal = actions.find((a) =>
    a.type === 'field_action' &&
    'details' in a && a.details.action === actionName
  );
  if (normal) return normal;
  if (!allowFamiliar) return undefined;
  return actions.find((a) =>
    a.type === 'use_familiar' &&
    'details' in a && a.details.action === actionName
  );
}

// 横暴（sacrifice）用: 5マナ無制限戦闘のアクションを探す
function findSacrificeAction(actions: MajoAction[], saintId: string, allowFamiliar = true): MajoAction | undefined {
  const normal = actions.find((a) =>
    a.type === 'combat_select_saint' && a.fieldId === 'sacrifice' && a.saintId === saintId && !a.useFamiliar
  );
  if (normal) return normal;
  if (allowFamiliar) {
    return actions.find((a) =>
      a.type === 'combat_select_saint' && a.fieldId === 'sacrifice' && a.saintId === saintId && a.useFamiliar
    );
  }
  return undefined;
}

// 生贄（prayer）用: 聖遺物を捨ててマナ獲得のアクションを探す
function findPrayerAction(actions: MajoAction[], relicId?: string): MajoAction | undefined {
  if (relicId) {
    return actions.find((a) =>
      (a.type === 'field_action' || a.type === 'use_familiar') &&
      'details' in a && a.details.action === 'prayer' && a.details.relicId === relicId
    );
  }
  return actions.find((a) =>
    (a.type === 'field_action' || a.type === 'use_familiar') &&
    'details' in a && a.details.action === 'prayer'
  );
}

// ── エクスポート用ヘルパー（majo-evolve.tsから利用） ──

/** 戦闘マルチステップ中の最適アクションを選ぶ */
export function selectCombatStepAction(
  state: MajoGameState,
  player: MajoPlayerState,
  playerId: string,
  actions: MajoAction[],
): { action: MajoAction; reasoning: string } | null {
  if (!state.combatState || state.combatState.playerId !== playerId) return null;

  const cs = state.combatState;
  const saint = state.saintSupply.find((s) => s.id === cs.saintId);
  if (!saint) return null;

  const alreadySelected = new Set(cs.selectedToolIds);
  const tempPlayer = { ...player, tappedToolIds: [...player.tappedToolIds, ...cs.selectedToolIds] };
  const optimalTools = selectToolsForCombat(tempPlayer, saint.hp);

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

  // 護符の戦闘効果発動判断：ボーナスなしで倒せるなら温存
  const amuletActions = actions.filter((a) => a.type === 'combat_activate_amulet');
  if (amuletActions.length > 0) {
    const powerWithoutAmulet = cs.selectedToolIds.reduce((sum, id) => {
      const t = player.magicTools.find((tt) => tt.id === id);
      if (!t) return sum;
      return sum + getEffectiveMagicPower(t, player.magicTools)
        + (cs.activatedAmuletIds.includes(id) ? getAmuletCombatBonus(t) : 0);
    }, 0);

    if (powerWithoutAmulet < saint.hp) {
      const amuletAction = amuletActions[0];
      if (amuletAction && 'toolId' in amuletAction) {
        const tool = player.magicTools.find((t) => t.id === amuletAction.toolId);
        return {
          action: amuletAction,
          reasoning: `魔力不足(${powerWithoutAmulet}<HP${saint.hp})、護符発動（魔力＋${tool ? getAmuletCombatBonus(tool) : '?'}、廃棄）`,
        };
      }
    }
  }

  const execAction = actions.find((a) => a.type === 'combat_execute');
  if (execAction) {
    const currentPower = cs.selectedToolIds.reduce((sum, id) => {
      const t = player.magicTools.find((tt) => tt.id === id);
      if (!t) return sum;
      return sum + getEffectiveMagicPower(t, player.magicTools)
        + (cs.activatedAmuletIds.includes(id) ? getAmuletCombatBonus(t) : 0);
    }, 0);
    if (currentPower >= saint.hp) {
      return {
        action: execAction,
        reasoning: `魔力${currentPower}で${saint.name}(HP${saint.hp})を撃破！`,
      };
    }
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

/** M67追加戦闘アクションを選ぶ */
export function selectExtraCombatAction(
  actions: MajoAction[],
  state: MajoGameState,
  player: MajoPlayerState,
): { action: MajoAction; reasoning: string } | null {
  const extraActions = actions.filter((a) => a.type === 'extra_combat');
  if (extraActions.length === 0) return null;

  const target = selectExtraCombatTarget(state, player);
  if (!target) return null;

  const act = extraActions.find((a) => a.type === 'extra_combat' && a.saintId === target.saintId);
  if (!act) return null;

  const saint = state.saintSupply.find((s) => s.id === target.saintId);
  if (!saint) return null;

  return {
    action: { ...act, tappedToolIds: target.toolIds } as MajoAction,
    reasoning: `M67追加戦闘！${saint.name}(HP${saint.hp}/★${saint.victoryPoints})を撃破！`,
  };
}

/** 手番聖遺物の最良選択 */
export function selectBestTurnRelic(
  state: MajoGameState,
  player: MajoPlayerState,
): { relicId: string; reasoning: string } | null {
  // タップマナが2以上ある場合、タップマナアンタップ聖遺物を最優先
  if (player.tappedMana >= 2) {
    for (const relic of player.relics) {
      if (!relic.isDisposable || relic.timing !== 'turn') continue;
      if (relic.effect.includes('タップマナをアンタップする')) {
        return { relicId: relic.id, reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ！` };
      }
    }
  }

  for (const relic of player.relics) {
    if (!relic.isDisposable || relic.timing !== 'turn') continue;
    const eff = relic.effect;

    if (eff.includes('タップ済みの魔導具をアンタップ')) {
      if (player.tappedToolIds.length > 0) {
        return { relicId: relic.id, reasoning: `聖遺物で魔導具${player.tappedToolIds.length}個をアンタップ！` };
      }
    } else if (eff.includes('タップマナをアンタップする')) {
      if (player.tappedMana >= 1) {
        return { relicId: relic.id, reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ` };
      }
    } else if (eff.includes('使い魔を未使用状態')) {
      if (player.familiarTapped) {
        return { relicId: relic.id, reasoning: `聖遺物で使い魔を復活！` };
      }
    } else if (eff.includes('魔導具をタダで')) {
      // selectFreeToolActionで処理するのでスキップ
    } else if (eff.includes('魔導具所持数')) {
      if (player.magicTools.length >= 3) {
        return { relicId: relic.id, reasoning: `聖遺物で${player.magicTools.length}タップマナ獲得！` };
      }
    } else if (eff.includes('マナをサプライに戻し')) {
      if (player.mana >= 2) {
        return { relicId: relic.id, reasoning: `聖遺物で2マナ→6タップマナに変換！` };
      }
    } else if (eff.includes('追加の手番を行う')) {
      if (player.mana >= 3 || player.tappedToolIds.length === 0) {
        return { relicId: relic.id, reasoning: `聖遺物で追加ターン獲得！` };
      }
    } else if (eff.includes('同じ数のマナを獲得')) {
      if (player.mana >= 3) {
        return { relicId: relic.id, reasoning: `聖遺物発動！マナ支払いが全額還元` };
      }
    } else if (eff.includes('魔導具を1つ捨て')) {
      if (player.magicTools.length > 0 && state.toolSupply.length > 0) {
        const minOwnCost = Math.min(...player.magicTools.map((t) => t.cost));
        const maxSupplyCost = Math.max(...state.toolSupply.map((t) => t.cost));
        if (maxSupplyCost > minOwnCost) {
          return { relicId: relic.id, reasoning: `聖遺物で魔導具交換！コスト${minOwnCost}→${maxSupplyCost}` };
        }
      }
    }
  }
  return null;
}

/** M53: タダで魔導具を獲得 */
export function selectFreeToolAction(
  state: MajoGameState,
  player: MajoPlayerState,
  _playerId: string,
  actions: MajoAction[],
): { action: MajoAction; reasoning: string } | null {
  const freeToolActions = actions.filter((a) => a.type === 'select_free_tool');
  if (freeToolActions.length === 0) return null;

  let best: { action: MajoAction; power: number } | null = null;
  for (const act of freeToolActions) {
    if (act.type !== 'select_free_tool') continue;
    const tool = state.toolSupply.find((t) => t.id === act.toolId);
    if (!tool) continue;
    const power = getToolCombatPower(tool, player.magicTools);
    if (!best || power > best.power) {
      best = { action: act, power };
    }
  }
  if (best) {
    const tool = state.toolSupply.find((t) => t.id === (best!.action as any).toolId);
    return {
      action: best.action,
      reasoning: `聖遺物M53で${tool?.name ?? '魔導具'}(魔力${best.power})をタダで獲得！`,
    };
  }
  return null;
}

/** M27: 水晶玉アンタップ */
export function selectUntapToolAction(
  actions: MajoAction[],
  _player: MajoPlayerState,
): { action: MajoAction; reasoning: string } | null {
  const untapAction = actions.find((a) => a.type === 'untap_tool');
  if (!untapAction) return null;
  return {
    action: untapAction,
    reasoning: `水晶玉(M27)をアンタップ → 再利用可能に`,
  };
}

// ── パラメータ定義 ──

/**
 * 遺伝的アルゴリズムで進化させるパラメータ群
 * 全て数値型のフラット構造にして突然変異・交叉を容易にする
 */
export interface MajoParams {
  // ── 聖者評価 ──
  /** 聖者のVP（勝利点）に対する重み（デフォルト: 2.0） */
  saintVPWeight: number;
  /** 聖者の聖遺物ドロー数に対する重み（デフォルト: 1.5） */
  saintRelicWeight: number;
  /** 聖者のHPが10未満の場合の1HP当たりボーナス（デフォルト: 0.3） */
  saintLowHPBonus: number;

  // ── 魔導具購入 ──
  /** この個数に達したら魔導具購入を停止（デフォルト: 4） */
  toolBuyMaxCount: number;
  /** 購入判断における魔力の重み（デフォルト: 1.0） */
  toolPowerWeight: number;
  /** 購入判断におけるコストの負の重み（デフォルト: 0.5） */
  toolCostWeight: number;

  // ── マナ管理 ──
  /** このマナ以下になったら魔具店に行く（デフォルト: 3） */
  manaShopThreshold: number;

  // ── 魔女の使用タイミング ──
  /** このラウンド以降でなければ魔女を使わない（デフォルト: 4） */
  witchRoundThreshold: number;
  /** 魔女を使う前に最低限必要な魔導具数（デフォルト: 2） */
  witchMinTools: number;

  // ── 使い魔の使用判断 ──
  /** 使い魔を使って戦闘する最低VP基準（デフォルト: 2） */
  familiarVPThreshold: number;

  // ── アクション優先度（高いほど優先） ──
  /** 戦闘アクションの基本優先度（デフォルト: 10） */
  combatPriority: number;
  /** 魔導具購入の基本優先度（デフォルト: 5） */
  purchasePriority: number;
  /** マナ収集の基本優先度（デフォルト: 3） */
  manaPriority: number;

  // ── 聖遺物プール認識による聖者評価 ──
  /**
   * 聖遺物デッキに強い聖遺物が残っている可能性が高い場合のボーナス重み
   * （ゲーム序盤 = 残り聖遺物枚数が多い = ボーナス大）（デフォルト: 1.0）
   */
  saintRelicPoolBonus: number;
  /**
   * VP=0の聖者に対する評価重み
   * （聖遺物ドロー目的で0VP聖者も価値がある）（デフォルト: 2.0）
   */
  saintZeroVPWeight: number;

  // ── アクション順序の柔軟性 ──
  /**
   * 戦闘と購入が両方可能な時、戦闘を優先する重み（0=購入優先, 1=戦闘優先）（デフォルト: 0.7）
   */
  combatBeforePurchase: number;
  /**
   * 購入とマナ補充が両方可能な時、購入を優先する重み（0=マナ優先, 1=購入優先）（デフォルト: 0.6）
   */
  purchaseBeforeShop: number;

  // ── 魔女モード選択 ──
  /**
   * マジックモード（永続魔力＋）を選ぶ重み（0=マナモード優先, 1=マジックモード優先）（デフォルト: 0.3）
   */
  witchMagicModeWeight: number;

  // ── 聖遺物使用タイミング ──
  /**
   * 使い捨て聖遺物を積極的に使う度合い（0=温存, 1=即座に使用）（デフォルト: 0.5）
   */
  relicAggressiveness: number;
  /**
   * アンタップ系聖遺物を使う前に必要な最低タップ済み魔導具数（デフォルト: 1）
   */
  untapRelicCombatThreshold: number;

  // ── 実績意識 ──
  /**
   * 聖遺物5個以上の実績達成に近づく行動へのボーナス重み（デフォルト: 1.0）
   */
  achievementRelicWeight: number;
  /**
   * 魔導具3種類以上の実績達成に近づく行動へのボーナス重み（デフォルト: 1.0）
   */
  achievementToolWeight: number;

  // ── 使い魔の購入活用 ──
  /**
   * 使い魔を魔導具購入（研究）に使う重み（0=戦闘のために温存, 1=積極的に購入活用）（デフォルト: 0.3）
   */
  familiarForPurchase: number;

  // ── 横暴（5マナ無制限戦闘） ──
  /** 横暴を使う最低聖者VP（高コストなので高VP聖者のみ）（デフォルト: 2） */
  violenceMinVP: number;
  /** 横暴を使う最低マナ（5マナ+残したいマナ）（デフォルト: 6） */
  violenceMinMana: number;

  // ── 祈祷（SPトークン+マナ1） ──
  /** 祈祷を戦闘・購入より優先するラウンド閾値（このラウンド以下なら先手確保を優先、0=無効）（デフォルト: 2） */
  prayerEarlyRound: number;

  // ── 生贄（聖遺物捨て→3マナ） ──
  /** 生贄で捨てる聖遺物の最低所持数（これ以上持ってる時だけ換金する）（デフォルト: 3） */
  sacrificeMinRelics: number;

  // ── ゲームフェーズ認識 ──
  /** 序盤→中盤の切り替えラウンド閾値（このラウンド以下が序盤）（デフォルト: 2） */
  phaseEarlyEnd: number;
  /** 中盤→終盤の切り替えラウンド閾値（このラウンド以上が終盤）（デフォルト: 4） */
  phaseLateStart: number;
  /** 終盤の戦闘優先度倍率（VP rushのため戦闘を強化）（デフォルト: 1.5） */
  combatPriorityLate: number;
  /** 序盤の購入優先度倍率（エンジン構築のため購入を強化）（デフォルト: 1.5） */
  purchasePriorityEarly: number;
  /** 終盤のマナ補充閾値（終盤はマナを溜め込まずに使う）（デフォルト: 4） */
  manaShopThresholdLate: number;

  // ── 魔導具効果評価 ──
  /** マナ生成効果（聖者撃破：マナ＋N）の重み（デフォルト: 0.5） */
  effectManaBonus: number;
  /** 戦闘力ブースト効果（戦闘：魔力＋N、廃棄）の重み（デフォルト: 0.5） */
  effectCombatBonus: number;
  /** コスト削減効果（コスト-N）の重み（デフォルト: 0.3） */
  effectDrawBonus: number;
  /** アンタップ効果（いつでもアンタップ）の重み（デフォルト: 1.0） */
  effectUntapBonus: number;
  /** VP付与効果（勝利点＋N）の重み（デフォルト: 1.0） */
  effectVPBonus: number;

  // ── 対戦相手認識 ──
  /** VP差で戦闘優先度をブーストする重み（vpDiff * この値を乗算）（デフォルト: 0.5） */
  vpDeficitCombatBoost: number;
  /** VP差でリード時に購入優先度をブーストする重み（デフォルト: 0.3） */
  vpLeadPurchaseBoost: number;
  /** 相手もSPを持っていない場合に祈祷の優先度を下げる度合い（デフォルト: 0.5） */
  opponentSPAwareness: number;
}

/** デフォルトパラメータ（手調整した合理的な初期値） */
export const DEFAULT_PARAMS: MajoParams = {
  saintVPWeight: 2.0,
  saintRelicWeight: 1.5,
  saintLowHPBonus: 0.3,

  toolBuyMaxCount: 4,
  toolPowerWeight: 1.0,
  toolCostWeight: 0.5,

  manaShopThreshold: 3,

  witchRoundThreshold: 4,
  witchMinTools: 2,

  familiarVPThreshold: 2,

  combatPriority: 10,
  purchasePriority: 5,
  manaPriority: 3,

  saintRelicPoolBonus: 1.0,
  saintZeroVPWeight: 2.0,

  combatBeforePurchase: 0.7,
  purchaseBeforeShop: 0.6,

  witchMagicModeWeight: 0.3,

  relicAggressiveness: 0.5,
  untapRelicCombatThreshold: 1,

  achievementRelicWeight: 1.0,
  achievementToolWeight: 1.0,

  familiarForPurchase: 0.3,

  violenceMinVP: 2,
  violenceMinMana: 6,

  prayerEarlyRound: 2,

  sacrificeMinRelics: 3,

  effectManaBonus: 0.5,
  effectCombatBonus: 0.5,
  effectDrawBonus: 0.3,
  effectUntapBonus: 1.0,
  effectVPBonus: 1.0,

  phaseEarlyEnd: 2,
  phaseLateStart: 4,
  combatPriorityLate: 1.5,
  purchasePriorityEarly: 1.5,
  manaShopThresholdLate: 4,

  vpDeficitCombatBoost: 0.5,
  vpLeadPurchaseBoost: 0.3,
  opponentSPAwareness: 0.5,
};

/** パラメータの変動範囲（最小値・最大値）：突然変異に使用 */
const PARAM_RANGES: Record<keyof MajoParams, [number, number]> = {
  saintVPWeight:        [0.5, 5.0],
  saintRelicWeight:     [0.0, 4.0],
  saintLowHPBonus:      [0.0, 2.0],

  toolBuyMaxCount:      [1, 6],
  toolPowerWeight:      [0.1, 3.0],
  toolCostWeight:       [0.0, 2.0],

  manaShopThreshold:    [1, 6],

  witchRoundThreshold:  [1, 8],
  witchMinTools:        [0, 5],

  familiarVPThreshold:  [0, 5],

  combatPriority:       [1, 20],
  purchasePriority:     [1, 15],
  manaPriority:         [1, 10],

  saintRelicPoolBonus:          [0, 3],
  saintZeroVPWeight:            [0, 5],

  combatBeforePurchase:         [0, 1],
  purchaseBeforeShop:           [0, 1],

  witchMagicModeWeight:         [0, 1],

  relicAggressiveness:          [0, 1],
  untapRelicCombatThreshold:    [0, 5],

  achievementRelicWeight:       [0, 3],
  achievementToolWeight:        [0, 3],

  violenceMinVP:                [0, 4],
  violenceMinMana:              [5, 10],

  prayerEarlyRound:             [0, 5],

  sacrificeMinRelics:           [1, 8],

  familiarForPurchase:          [0, 1],

  effectManaBonus:              [0, 2],
  effectCombatBonus:            [0, 2],
  effectDrawBonus:              [0, 2],
  effectUntapBonus:             [0, 3],
  effectVPBonus:                [0, 3],

  phaseEarlyEnd:                [1, 3],
  phaseLateStart:               [3, 6],
  combatPriorityLate:           [0.5, 3.0],
  purchasePriorityEarly:        [0.5, 3.0],
  manaShopThresholdLate:        [2, 8],

  vpDeficitCombatBoost:         [0, 2.0],
  vpLeadPurchaseBoost:          [0, 1.5],
  opponentSPAwareness:          [0, 1.0],
};

/**
 * ランダムなパラメータセットを生成
 * 遺伝的アルゴリズムの初期集団生成に使用
 */
export function randomizeParams(): MajoParams {
  const result = {} as MajoParams;
  for (const [key, [min, max]] of Object.entries(PARAM_RANGES) as [keyof MajoParams, [number, number]][]) {
    result[key] = min + Math.random() * (max - min) as any;
  }
  return result;
}

/**
 * パラメータを突然変異させる
 * @param params 元のパラメータ
 * @param rate 突然変異率（0〜1、各パラメータを変化させる確率）
 * @returns 突然変異後の新しいパラメータ
 */
export function mutateParams(params: MajoParams, rate: number = 0.2): MajoParams {
  const result = { ...params };
  for (const [key, [min, max]] of Object.entries(PARAM_RANGES) as [keyof MajoParams, [number, number]][]) {
    if (Math.random() < rate) {
      // ガウシアンノイズで変動（範囲の10%をσとして使用）
      const sigma = (max - min) * 0.1;
      const delta = (Math.random() + Math.random() + Math.random() - 1.5) * sigma * 2;
      const newVal = Math.min(max, Math.max(min, (result[key] as number) + delta));
      result[key] = newVal as any;
    }
  }
  return result;
}

/**
 * 二親のパラメータを交叉（一様交叉）
 * 各パラメータを確率1/2でどちらかの親から受け継ぐ
 */
export function crossoverParams(a: MajoParams, b: MajoParams): MajoParams {
  const result = {} as MajoParams;
  for (const key of Object.keys(PARAM_RANGES) as (keyof MajoParams)[]) {
    result[key] = (Math.random() < 0.5 ? a[key] : b[key]) as any;
  }
  return result;
}

// ── パラメータ化戦略 ──

/**
 * パラメータに基づいた魔女ゲーAI戦略を生成する
 * 遺伝的アルゴリズムで進化させるメイン関数
 */
export function createParameterizedStrategy(params: MajoParams): MajoAIStrategy {
  // 聖遺物プールの残量比率を計算（0〜1、1=全部残っている=ゲーム序盤）
  function getRelicPoolRatio(state: MajoGameState): number {
    // relicDeckがない場合はフォールバック: ラウンド数で推定
    if ('relicDeck' in state && Array.isArray((state as any).relicDeck)) {
      const total = (state as any).relicDeck.length + ((state as any).discardedRelics?.length ?? 0);
      if (total > 0) return (state as any).relicDeck.length / total;
    }
    // ラウンドベース推定: 序盤ほど残り多し（最大10ラウンドを想定）
    const estimatedRatio = Math.max(0, 1 - (state.round - 1) / 10);
    return estimatedRatio;
  }

  // 魔導具の所持種類数を数える
  function countToolTypes(player: MajoPlayerState): number {
    const types = new Set(player.magicTools.map((t) => t.type));
    return types.size;
  }

  // 聖者の総合スコアを計算（パラメータで重み付け）
  function evaluateSaint(
    saint: { victoryPoints: number; relicDraw: number; hp: number },
    state: MajoGameState,
    player: MajoPlayerState,
  ): number {
    const vpScore = saint.victoryPoints > 0
      ? saint.victoryPoints * params.saintVPWeight
      : params.saintZeroVPWeight; // 0VPでも聖遺物狙いで価値あり

    // 聖遺物評価: プール残量ボーナス付き（序盤ほど聖遺物が強い）
    const poolRatio = getRelicPoolRatio(state);
    const relicScore = saint.relicDraw * (params.saintRelicWeight + poolRatio * params.saintRelicPoolBonus);

    const hpBonus = Math.max(0, 10 - saint.hp) * params.saintLowHPBonus;

    // 実績ボーナス: 聖遺物5個以上が目標（relicDrawがある聖者を優先）
    const currentRelics = player.relics.length;
    const achievementRelicBonus = (currentRelics < 5 && saint.relicDraw > 0)
      ? params.achievementRelicWeight * (5 - currentRelics) / 5
      : 0;

    return vpScore + relicScore + hpBonus + achievementRelicBonus;
  }

  // 魔導具の購入スコアを計算
  function evaluateTool(
    tool: { id: string; type: string; magicPower: number; effect: string; cost: number },
    allTools: { id: string; type: string; magicPower: number; effect: string; cost: number }[],
    player: MajoPlayerState,
  ): number {
    const power = getToolCombatPower(tool, allTools);
    let score = power * params.toolPowerWeight - tool.cost * params.toolCostWeight;

    // ── 効果テキストに基づくボーナス ──
    const eff = tool.effect;

    // マナ生成効果: 「聖者撃破：マナ＋N」「聖者撃破：即時マナ＋N」
    if (eff.includes('マナ＋')) {
      const manaMatch = eff.match(/マナ＋(\d+)/);
      const manaGain = manaMatch ? parseInt(manaMatch[1], 10) : 1;
      const instantMultiplier = eff.includes('即時マナ') ? 1.5 : 1.0;
      score += params.effectManaBonus * manaGain * instantMultiplier;
    }

    // 戦闘力ブースト効果: 「戦闘：魔力＋N。廃棄」（護符の一時ブースト）
    if (eff.includes('戦闘：魔力＋')) {
      const combatMatch = eff.match(/戦闘：魔力＋(\d+)/);
      const combatBoost = combatMatch ? parseInt(combatMatch[1], 10) : 3;
      score += params.effectCombatBonus * (combatBoost / 3);
    }

    // コスト削減効果: 「コスト-1」「コスト-2」（他の魔導具購入を安くする）
    if (eff.includes('コスト-')) {
      const costMatch = eff.match(/コスト-(\d+)/);
      const costReduction = costMatch ? parseInt(costMatch[1], 10) : 1;
      score += params.effectDrawBonus * costReduction;
    }

    // アンタップ効果: 「いつでもアンタップしてよい」（M27水晶玉、アクション経済で強力）
    if (eff.includes('いつでもアンタップ')) {
      score += params.effectUntapBonus;
    }

    // VP付与効果: 「手番：勝利点＋1。廃棄」（M28護符、直接VPを生む）
    if (eff.includes('勝利点＋')) {
      const vpMatch = eff.match(/勝利点＋(\d+)/);
      const vpGain = vpMatch ? parseInt(vpMatch[1], 10) : 1;
      score += params.effectVPBonus * vpGain;
    }

    // スケーリング効果: 「最大魔力の魔導具の魔力+2」（M26杖、他の強い魔導具とシナジー）
    if (eff.includes('最大魔力の魔導具の魔力')) {
      const maxPower = allTools.length > 0
        ? Math.max(...allTools.map((t) => t.magicPower))
        : 0;
      score += params.effectUntapBonus * ((maxPower + 2) / 6);
    }

    // 実績ボーナス: 3種類以上の魔導具タイプを持つことへのボーナス
    const currentTypes = countToolTypes(player);
    const alreadyHasType = allTools.some((t) => t.type === tool.type);
    if (!alreadyHasType && currentTypes < 3) {
      score += params.achievementToolWeight * (3 - currentTypes) / 3;
    }

    return score;
  }

  return {
    id: 'majo_evolved',
    name: '進化型',
    description: '遺伝的アルゴリズムで最適化されたパラメータ戦略',
    personality: 'データ駆動の魔女。パラメータが示す最適解を追い求める',

    selectAction(state: MajoGameState, playerId: string) {
      const player = getPlayer(state, playerId);
      const actions = getAvailableActions(state, playerId);
      const fieldActions = actions.filter((a) => a.type === 'field_action' || a.type === 'use_familiar');
      const passAction = actions.find((a) => a.type === 'pass')!;

      // ── フェーズ判定 ──
      const isEarly = state.round <= params.phaseEarlyEnd;
      const isLate = state.round >= params.phaseLateStart;
      // フェーズ別倍率
      const combatMultiplier = isLate ? params.combatPriorityLate : 1.0;
      const purchaseMultiplier = isEarly ? params.purchasePriorityEarly : 1.0;
      // 終盤はマナを溜め込まない（閾値を上げてマナ補充に行きにくくする）
      const effectiveManaShopThreshold = isLate ? params.manaShopThresholdLate : params.manaShopThreshold;

      // ── 対戦相手認識 ──
      const opponents = state.players.filter(p => p.config.id !== playerId);
      const maxOpponentVP = opponents.length > 0 ? Math.max(...opponents.map(p => p.victoryPoints)) : 0;
      const vpDiff = maxOpponentVP - player.victoryPoints; // 正=負けてる、負=勝ってる
      const anyOpponentHasSP = opponents.some(p => {
        const opIdx = state.players.findIndex(pp => pp.config.id === p.config.id);
        return state.startPlayerIndex === opIdx;
      });

      // ── ステップ1: 戦闘マルチステップ中は戦闘を優先 ──
      const combatStep = selectCombatStepAction(state, player, playerId, actions);
      if (combatStep) return combatStep;

      // ── ステップ2: M67 追加戦闘 ──
      const extraCombat = selectExtraCombatAction(actions, state, player);
      if (extraCombat) return extraCombat;

      // ── ステップ2.5: 護符手番効果（VP+1など）は終盤で使う ──
      const toolTurnActions = actions.filter((a) => a.type === 'use_tool_turn');
      if (toolTurnActions.length > 0) {
        const vpTarget = 7;
        const gameNearEnd = player.victoryPoints >= vpTarget - 1
          || state.players.some((p) => p.config.id !== player.config.id && p.victoryPoints >= vpTarget);
        const onlyPassLeft = actions.filter((a) => a.type !== 'use_tool_turn').every((a) => a.type === 'pass');
        if (gameNearEnd && onlyPassLeft) {
          const act = toolTurnActions[0];
          if (act.type === 'use_tool_turn') {
            const tool = player.magicTools.find((t) => t.id === act.toolId);
            return {
              action: act,
              reasoning: `終盤：護符「${tool?.name ?? ''}」の手番効果を発動（${tool?.effect ?? ''})`,
            };
          }
        }
      }

      // ── ステップ3: 聖遺物使用 ──
      // アンタップ系: untapRelicCombatThreshold以上タップ済みなら使用
      if (player.tappedToolIds.length >= params.untapRelicCombatThreshold) {
        const untapRelic = player.relics.find((r) => r.effect.includes('タップ済みの魔導具をアンタップ') && r.isDisposable);
        if (untapRelic) {
          return {
            action: { type: 'use_relic', playerId, relicId: untapRelic.id } as MajoAction,
            reasoning: `聖遺物で魔導具アンタップ → 連続戦闘！（タップ数${player.tappedToolIds.length} >= 閾値${params.untapRelicCombatThreshold}）`,
          };
        }
      }

      // relicAggressivenessに基づく聖遺物使用判断
      // 積極度が高いほど使い捨て聖遺物を即座に使う
      if (Math.random() < params.relicAggressiveness) {
        const bestRelic = selectBestTurnRelic(state, player);
        if (bestRelic) {
          return {
            action: { type: 'use_relic', playerId, relicId: bestRelic.relicId } as MajoAction,
            reasoning: `${bestRelic.reasoning}（積極度${params.relicAggressiveness.toFixed(2)}）`,
          };
        }
      } else {
        // 保守的: 高価値な場面のみ聖遺物を使用（タップマナが多い時など優先）
        const bestRelic = selectBestTurnRelic(state, player);
        if (bestRelic && (player.tappedMana >= 2 || player.familiarTapped)) {
          return {
            action: { type: 'use_relic', playerId, relicId: bestRelic.relicId } as MajoAction,
            reasoning: bestRelic.reasoning,
          };
        }
      }

      // M53: タダで魔導具
      const freeTool = selectFreeToolAction(state, player, playerId, actions);
      if (freeTool) return freeTool;

      // M27: 水晶玉アンタップ
      const untapM27 = selectUntapToolAction(actions, player);
      if (untapM27) return untapM27;

      // ── ステップ4: パラメータに基づいてアクションを評価・選択 ──
      const killableSaints = getKillableSaints(state, player);

      // 倒せる聖者をパラメータで評価し、最もスコアが高いものを選ぶ
      let bestSaintScore = -Infinity;
      let bestSaintTarget: typeof killableSaints[0] | null = null;

      // VP差による戦闘ブースト: 負けてるほど戦闘を優先
      const vpDeficitBoost = vpDiff > 0 ? (1 + vpDiff * params.vpDeficitCombatBoost) : 1.0;

      for (const saint of killableSaints) {
        const score = evaluateSaint(saint, state, player) * params.combatPriority * combatMultiplier * vpDeficitBoost;
        if (score > bestSaintScore) {
          bestSaintScore = score;
          bestSaintTarget = saint;
        }
      }

      // 魔導具購入の評価
      // VP差によるリードブースト: 勝ってる時はエンジン構築を優先
      const vpLeadBoost = vpDiff < 0 ? (1 + Math.abs(vpDiff) * params.vpLeadPurchaseBoost) : 1.0;

      const toolCountOk = player.magicTools.length < params.toolBuyMaxCount;
      let bestPurchase: { tool: typeof state.toolSupply[0]; score: number } | null = null;
      if (toolCountOk) {
        const affordable = state.toolSupply
          .filter((t) => t.cost <= player.mana)
          .map((t) => ({
            tool: t,
            score: evaluateTool(t, player.magicTools, player) * params.purchasePriority * purchaseMultiplier * vpLeadBoost,
          }))
          .filter((t) => t.score > 0)
          .sort((a, b) => b.score - a.score);

        if (affordable.length > 0) {
          bestPurchase = affordable[0];
        }
      }

      // ── combatBeforePurchase で戦闘/購入の優先順序を決定 ──
      const hasCombatOption = bestSaintTarget !== null;
      const hasPurchaseOption = bestPurchase !== null;

      // 両方可能な場合は combatBeforePurchase の重みで確率的に決定
      // （決定論的にするため: combatBeforePurchase > 0.5 なら戦闘優先）
      const preferCombat = hasCombatOption && (
        !hasPurchaseOption || params.combatBeforePurchase > 0.5
      );

      if (preferCombat && bestSaintTarget) {
        const target = bestSaintTarget;
        // 使い魔使用の判断：VP閾値以上かつ未使用の場合のみ許可
        const allowFamiliar = !player.familiarTapped && target.victoryPoints >= params.familiarVPThreshold;
        const act = findViolenceAction(actions, target.id, allowFamiliar);
        if (act) {
          return {
            action: act,
            reasoning: `スコア${evaluateSaint(target, state, player).toFixed(1)}: ${target.name}(HP${target.hp}/★${target.victoryPoints}/聖遺物${target.relicDraw})を撃破（戦闘優先度${params.combatBeforePurchase.toFixed(2)}）`,
          };
        }
      }

      // 購入優先ケース（combatBeforePurchase <= 0.5 かつ購入可能）
      if (!preferCombat && hasPurchaseOption && bestPurchase) {
        const best = bestPurchase;
        // familiarForPurchase の重みで使い魔を購入に使うかを決定
        const allowFamiliarForPurchase = !player.familiarTapped && params.familiarForPurchase > 0.5;
        const act = findResearchAction(fieldActions, best.tool.id, allowFamiliarForPurchase);
        if (act) {
          return {
            action: act,
            reasoning: `スコア${best.score.toFixed(1)}: ${best.tool.name}(コスト${best.tool.cost}/魔力${best.tool.magicPower})を購入（購入優先、familiarForPurchase=${params.familiarForPurchase.toFixed(2)}）`,
          };
        }
      }

      // どちらかの残り: 戦闘（まだ試みていない場合）
      if (hasCombatOption && bestSaintTarget && preferCombat === false) {
        const target = bestSaintTarget;
        const allowFamiliar = !player.familiarTapped && target.victoryPoints >= params.familiarVPThreshold;
        const act = findViolenceAction(actions, target.id, allowFamiliar);
        if (act) {
          return {
            action: act,
            reasoning: `スコア${evaluateSaint(target, state, player).toFixed(1)}: ${target.name}(HP${target.hp}/★${target.victoryPoints})を撃破（購入後フォールバック）`,
          };
        }
      }

      // 購入（まだ試みていない場合）
      if (hasPurchaseOption && bestPurchase && preferCombat === true) {
        const best = bestPurchase;
        const allowFamiliarForPurchase = !player.familiarTapped && params.familiarForPurchase > 0.5;
        const act = findResearchAction(fieldActions, best.tool.id, allowFamiliarForPurchase);
        if (act) {
          return {
            action: act,
            reasoning: `スコア${best.score.toFixed(1)}: ${best.tool.name}(コスト${best.tool.cost}/魔力${best.tool.magicPower})を購入（戦闘後フォールバック）`,
          };
        }
      }

      // ── 横暴（5マナ無制限戦闘）: 大聖堂の枠が埋まってる時の代替戦闘手段 ──
      if (bestSaintTarget && player.mana >= params.violenceMinMana && bestSaintTarget.victoryPoints >= params.violenceMinVP) {
        const act = findSacrificeAction(actions, bestSaintTarget.id);
        if (act) {
          return {
            action: act,
            reasoning: `横暴で${bestSaintTarget.name}(★${bestSaintTarget.victoryPoints})を撃破（5マナ消費、VP>=${params.violenceMinVP}）`,
          };
        }
      }

      // ── 生贄（聖遺物捨て→3マナ）: 使い捨て聖遺物を換金 ──
      // 条件: 使い捨て聖遺物がsacrificeMinRelics以上ある時だけ（GA制御）
      // 優先的に捨てる聖遺物: パッシブ > 戦闘 > 手番（手番は最も有用なので温存）
      if (player.relics.filter((r) => r.isDisposable).length >= params.sacrificeMinRelics) {
        // 捨てる優先度: パッシブ聖遺物 > 戦闘聖遺物 > 手番聖遺物（手番は最も有用なので温存）
        const sacrificeCandidates = player.relics
          .filter((r) => r.isDisposable)
          .sort((a, b) => {
            const timingOrder = (t: string) => t === 'turn' ? 2 : t === 'combat' ? 1 : 0;
            return timingOrder(a.timing) - timingOrder(b.timing);
          });
        const weakRelic = sacrificeCandidates[0];
        if (weakRelic) {
          const act = findPrayerAction(actions, weakRelic.id);
          if (act) {
            return {
              action: act,
              reasoning: `生贄: ${weakRelic.id}(${weakRelic.timing})を捨てて3マナ（所持${player.relics.length}個 >= ${params.sacrificeMinRelics}）`,
            };
          }
        }
      }

      // ── 祈祷（SPトークン+マナ1）──
      // 戦闘・購入・横暴・生贄より下、マナ補充より上
      // SPは次ラウンドの先手権だが、今やれる生産的な行動があるならそっちが先
      // 対戦相手認識: 相手もSPを持っていないなら祈祷の緊急度を下げる
      {
        const myPlayerIndex = state.players.findIndex((p) => p.config.id === playerId);
        const hasStartPlayer = state.startPlayerIndex === myPlayerIndex;
        // opponentSPAwareness: 相手もSP持ってない場合、prayerEarlyRoundを実質的に下げて祈祷をスキップしやすくする
        const effectivePrayerRound = !anyOpponentHasSP
          ? params.prayerEarlyRound * (1 - params.opponentSPAwareness)
          : params.prayerEarlyRound;
        if (!hasStartPlayer && effectivePrayerRound > 0 && state.round <= effectivePrayerRound) {
          const cathedralAct = findFieldAction(fieldActions, 'cathedral');
          if (cathedralAct) {
            return {
              action: cathedralAct,
              reasoning: `祈祷: R${state.round}でSP確保（次R先手権、閾値R${params.prayerEarlyRound}${!anyOpponentHasSP ? `→実効${effectivePrayerRound.toFixed(1)}` : ''}）`,
            };
          }
        }
      }

      // ── purchaseBeforeShop でマナ補充との優先順序を決定 ──
      // マナ補充の評価（終盤はmanaShopThresholdLateを使用）
      const needsMana = player.mana <= effectiveManaShopThreshold;
      const shopAct = findFieldAction(fieldActions, 'magic_shop', false);

      if (needsMana && shopAct && (!hasPurchaseOption || params.purchaseBeforeShop <= 0.5)) {
        return {
          action: shopAct,
          reasoning: `マナ${player.mana} <= 閾値${effectiveManaShopThreshold}のため補充（マナ優先: purchaseBeforeShop=${params.purchaseBeforeShop.toFixed(2)}）`,
        };
      }

      // ── 魔女使用の判断（witchMagicModeWeight でモード選択） ──
      if (
        !player.witchTapped &&
        player.magicTools.length >= params.witchMinTools &&
        state.round >= params.witchRoundThreshold
      ) {
        // witchMagicModeWeight > 0.5 ならマジックモード優先
        if (params.witchMagicModeWeight > 0.5) {
          const witchMagicAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'magic');
          if (witchMagicAction) {
            return {
              action: witchMagicAction,
              reasoning: `魔女マジックモード(R${state.round} >= ${params.witchRoundThreshold}、魔導具${player.magicTools.length}個) → 魔力+${state.round}（witchMagicModeWeight=${params.witchMagicModeWeight.toFixed(2)}）`,
            };
          }
        }
        const witchManaAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'mana');
        if (witchManaAction) {
          return {
            action: witchManaAction,
            reasoning: `魔女マナモード(R${state.round} >= ${params.witchRoundThreshold}、魔導具${player.magicTools.length}個) → +${state.round}マナ`,
          };
        }
      }

      // 残りのマナがあればとにかく魔具店へ
      const shopActFallback = findFieldAction(fieldActions, 'magic_shop');
      if (shopActFallback) return { action: shopActFallback, reasoning: `パスよりマナ補充` };

      // 祈祷フォールバック（パスより良い: SPトークン+マナ1）
      const cathedralFallback = findFieldAction(fieldActions, 'cathedral');
      if (cathedralFallback) return { action: cathedralFallback, reasoning: `パスより祈祷（SPトークン+マナ1）` };

      // 生贄フォールバック（パスより良い: 使い捨て聖遺物があれば換金）
      const disposableRelic = player.relics.find((r) => r.isDisposable);
      if (disposableRelic) {
        const sacrificeAct = findPrayerAction(actions, disposableRelic.id);
        if (sacrificeAct) return { action: sacrificeAct, reasoning: `パスより生贄（聖遺物→3マナ）` };
      }

      return { action: passAction, reasoning: `やることなし(マナ:${player.mana})` };
    },
  };
}
