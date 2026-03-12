// 魔女ゲー パラメータ化戦略（遺伝的アルゴリズム用）

import type { MajoGameState, MajoAction, MajoAIStrategy, MajoPlayerState } from '../engine/majo-types.js';
import {
  getPlayer, getAvailableActions, getEffectiveMagicPower,
} from '../engine/majo.js';

// ── ヘルパー関数（majo-strategies.tsから再エクスポート用に公開） ──
// 注意: majo-strategies.tsのヘルパーは全てプライベートなので、ここで同等実装を提供

function selectToolsForCombat(player: MajoPlayerState, targetHP: number): string[] {
  const availableTools = player.magicTools
    .filter((t) => !player.tappedToolIds.includes(t.id))
    .map((t) => ({
      ...t,
      effectivePower: getEffectiveMagicPower(t, player.magicTools) +
        (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') ? 3 : 0),
    }))
    .sort((a, b) => b.effectivePower - a.effectivePower);

  const selected: string[] = [];
  let currentPower = 0;

  for (const tool of availableTools) {
    if (currentPower >= targetHP) break;
    selected.push(tool.id);
    currentPower += tool.effectivePower;
  }

  return selected;
}

function getAvailablePower(player: MajoPlayerState, witchUsageCount: number = 0): number {
  const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
  let power = 0;
  for (const t of availableTools) {
    power += getEffectiveMagicPower(t, player.magicTools);
    if (t.type === '護符' && t.effect.includes('戦闘：魔力＋3')) {
      power += 3;
    }
  }
  if (player.witchTapped && player.witchMode === 'magic') {
    power += 3 + witchUsageCount;
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
  const toolPower = getAvailablePower(player, state.witchUsageCount);
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
  const normal = actions.find((a) =>
    a.type === 'field_action' &&
    'details' in a && a.details.action === 'research' && a.details.toolId === toolId
  );
  if (normal) return normal;
  if (!allowFamiliar) return undefined;
  return actions.find((a) =>
    a.type === 'use_familiar' &&
    'details' in a && a.details.action === 'research' && a.details.toolId === toolId
  );
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

  const amuletAction = actions.find((a) => a.type === 'combat_activate_amulet');
  if (amuletAction && 'toolId' in amuletAction) {
    const tool = player.magicTools.find((t) => t.id === amuletAction.toolId);
    return {
      action: amuletAction,
      reasoning: `護符「${tool?.name ?? ''}」の戦闘効果を発動（魔力＋3、廃棄）`,
    };
  }

  const execAction = actions.find((a) => a.type === 'combat_execute');
  if (execAction) {
    const currentPower = cs.selectedToolIds.reduce((sum, id) => {
      const t = player.magicTools.find((tt) => tt.id === id);
      if (!t) return sum;
      return sum + getEffectiveMagicPower(t, player.magicTools)
        + (t.type === '護符' && t.effect.includes('戦闘：魔力＋3') && cs.activatedAmuletIds.includes(id) ? 3 : 0);
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
  if (player.tappedMana >= 2) {
    for (const relic of player.relics) {
      if (!relic.isDisposable || relic.timing !== 'turn') continue;
      if (['M56', 'M57', 'M58', 'M59'].includes(relic.id)) {
        return {
          relicId: relic.id,
          reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ！`,
        };
      }
    }
  }

  for (const relic of player.relics) {
    if (!relic.isDisposable || relic.timing !== 'turn') continue;

    switch (relic.id) {
      case 'M43':
      case 'M44':
        if (player.tappedToolIds.length > 0) {
          return { relicId: relic.id, reasoning: `聖遺物で魔導具${player.tappedToolIds.length}個をアンタップ！` };
        }
        break;
      case 'M56':
      case 'M57':
      case 'M58':
      case 'M59':
        if (player.tappedMana >= 1) {
          return { relicId: relic.id, reasoning: `聖遺物でタップマナ${player.tappedMana}をアンタップ` };
        }
        break;
      case 'M52':
        if (player.familiarTapped) {
          return { relicId: relic.id, reasoning: `聖遺物で使い魔を復活！` };
        }
        break;
      case 'M53':
        break; // selectFreeToolActionで処理
      case 'M61':
        if (player.magicTools.length >= 3) {
          return { relicId: relic.id, reasoning: `聖遺物で${player.magicTools.length}タップマナ獲得！` };
        }
        break;
      case 'M63':
        if (player.mana >= 2) {
          return { relicId: relic.id, reasoning: `聖遺物で2マナ→6タップマナに変換！` };
        }
        break;
      case 'M60':
        if (player.mana >= 3 || player.tappedToolIds.length === 0) {
          return { relicId: relic.id, reasoning: `聖遺物で追加ターン獲得！` };
        }
        break;
      case 'M64':
        if (player.mana >= 3) {
          return { relicId: relic.id, reasoning: `聖遺物M64発動！マナ支払いが全額還元` };
        }
        break;
      case 'M65':
        if (player.magicTools.length > 0 && state.toolSupply.length > 0) {
          const minOwnCost = Math.min(...player.magicTools.map((t) => t.cost));
          const maxSupplyCost = Math.max(...state.toolSupply.map((t) => t.cost));
          if (maxSupplyCost > minOwnCost) {
            return { relicId: relic.id, reasoning: `聖遺物M65で魔導具交換！コスト${minOwnCost}→${maxSupplyCost}` };
          }
        }
        break;
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
  /** 戦闘のために確保しておきたいマナ量（デフォルト: 2） */
  manaReserveForCombat: number;

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
  manaReserveForCombat: 2,

  witchRoundThreshold: 4,
  witchMinTools: 2,

  familiarVPThreshold: 2,

  combatPriority: 10,
  purchasePriority: 5,
  manaPriority: 3,
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
  manaReserveForCombat: [0, 5],

  witchRoundThreshold:  [1, 8],
  witchMinTools:        [0, 5],

  familiarVPThreshold:  [0, 5],

  combatPriority:       [1, 20],
  purchasePriority:     [1, 15],
  manaPriority:         [1, 10],
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
  // 聖者の総合スコアを計算（パラメータで重み付け）
  function evaluateSaint(saint: { victoryPoints: number; relicDraw: number; hp: number }): number {
    const vpScore = saint.victoryPoints * params.saintVPWeight;
    const relicScore = saint.relicDraw * params.saintRelicWeight;
    const hpBonus = Math.max(0, 10 - saint.hp) * params.saintLowHPBonus;
    return vpScore + relicScore + hpBonus;
  }

  // 魔導具の購入スコアを計算
  function evaluateTool(
    tool: { id: string; type: string; magicPower: number; effect: string; cost: number },
    allTools: { id: string; type: string; magicPower: number; effect: string; cost: number }[],
  ): number {
    const power = getToolCombatPower(tool, allTools);
    return power * params.toolPowerWeight - tool.cost * params.toolCostWeight;
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

      // ── ステップ1: 戦闘マルチステップ中は戦闘を優先 ──
      const combatStep = selectCombatStepAction(state, player, playerId, actions);
      if (combatStep) return combatStep;

      // ── ステップ2: M67 追加戦闘 ──
      const extraCombat = selectExtraCombatAction(actions, state, player);
      if (extraCombat) return extraCombat;

      // ── ステップ3: 聖遺物使用 ──
      // タップ系優先（攻撃後アンタップで再戦闘）
      if (player.tappedToolIds.length > 0) {
        const untapRelic = player.relics.find((r) => (r.id === 'M43' || r.id === 'M44') && r.isDisposable);
        if (untapRelic) {
          return {
            action: { type: 'use_relic', playerId, relicId: untapRelic.id } as MajoAction,
            reasoning: `聖遺物で魔導具アンタップ → 連続戦闘！`,
          };
        }
      }

      const bestRelic = selectBestTurnRelic(state, player);
      if (bestRelic) {
        return {
          action: { type: 'use_relic', playerId, relicId: bestRelic.relicId } as MajoAction,
          reasoning: bestRelic.reasoning,
        };
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

      for (const saint of killableSaints) {
        const score = evaluateSaint(saint) * params.combatPriority;
        if (score > bestSaintScore) {
          bestSaintScore = score;
          bestSaintTarget = saint;
        }
      }

      // 倒せる聖者がいて、マナが十分な場合
      if (bestSaintTarget && player.mana >= params.manaReserveForCombat) {
        const target = bestSaintTarget;
        // 使い魔使用の判断：VP閾値以上かつ未使用の場合のみ許可
        const allowFamiliar = !player.familiarTapped && target.victoryPoints >= params.familiarVPThreshold;
        const act = findViolenceAction(actions, target.id, allowFamiliar);
        if (act) {
          return {
            action: act,
            reasoning: `スコア${evaluateSaint(target).toFixed(1)}: ${target.name}(HP${target.hp}/★${target.victoryPoints}/聖遺物${target.relicDraw})を撃破`,
          };
        }
      }

      // 魔導具購入の評価
      const toolCountOk = player.magicTools.length < params.toolBuyMaxCount;
      if (toolCountOk) {
        const affordable = state.toolSupply
          .filter((t) => t.cost <= player.mana)
          .map((t) => ({
            tool: t,
            score: evaluateTool(t, player.magicTools) * params.purchasePriority,
          }))
          .filter((t) => t.score > 0)
          .sort((a, b) => b.score - a.score);

        if (affordable.length > 0) {
          const best = affordable[0];
          const act = findResearchAction(fieldActions, best.tool.id, false);
          if (act) {
            return {
              action: act,
              reasoning: `スコア${best.score.toFixed(1)}: ${best.tool.name}(コスト${best.tool.cost}/魔力${best.tool.magicPower})を購入`,
            };
          }
        }
      }

      // マナ補充の判断
      if (player.mana <= params.manaShopThreshold) {
        const shopAct = findFieldAction(fieldActions, 'magic_shop', false);
        if (shopAct) {
          return {
            action: shopAct,
            reasoning: `マナ${player.mana} <= 閾値${params.manaShopThreshold}のため補充`,
          };
        }
      }

      // 魔女使用の判断（マナモード）
      if (
        !player.witchTapped &&
        player.magicTools.length >= params.witchMinTools &&
        state.round >= params.witchRoundThreshold
      ) {
        const witchAction = actions.find((a) => a.type === 'use_witch' && a.choice === 'mana');
        if (witchAction) {
          const gain = 2 + state.witchUsageCount;
          return {
            action: witchAction,
            reasoning: `魔女マナモード(R${state.round} >= ${params.witchRoundThreshold}、魔導具${player.magicTools.length}個) → +${gain}マナ`,
          };
        }
      }

      // 残りのマナがあればとにかく魔具店へ
      const shopAct = findFieldAction(fieldActions, 'magic_shop');
      if (shopAct) return { action: shopAct, reasoning: `パスよりマナ補充` };

      return { action: passAction, reasoning: `やることなし(マナ:${player.mana})` };
    },
  };
}
