// 魔女ゲー ゲームエンジン

import type { PlayerConfig } from './types.js';
import type {
  MajoGameState, MajoPlayerState, MajoAction, FieldActionDetails,
  FieldAction, FieldActionId, MajoToolCard, MajoSaintCard, MajoRelicCard,
  MajoFinalScore, MajoAchievementCard, MajoCombatState,
} from './majo-types.js';
import { loadCardsFromSheet } from './majo-card-loader.js';

const INITIAL_MANA = 3;
const VICTORY_POINT_TARGET = 7;

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── 初期化 ──

function createFieldActions(): FieldAction[] {
  return [
    { id: 'research',    name: '魔具店', maxSlots: 3,  cost: 'variable', usedSlots: 0 },
    { id: 'violence',    name: '大聖堂', maxSlots: 3,  cost: 2,          usedSlots: 0 },
    { id: 'magic_shop',  name: '研究',   maxSlots: 3,  cost: 1,          usedSlots: 0 },
    { id: 'cathedral',   name: '祈祷',   maxSlots: 1,  cost: 1,          usedSlots: 0 },
    { id: 'sacrifice',   name: '横暴',   maxSlots: -1, cost: 5,          usedSlots: 0 }, // 無制限
    { id: 'prayer',      name: '生贄',   maxSlots: 3,  cost: 1,          usedSlots: 0 },
  ];
}

export async function createMajoGame(players: PlayerConfig[]): Promise<MajoGameState> {
  if (players.length < 2 || players.length > 5) {
    throw new Error('プレイヤー数は2〜5人');
  }

  // スプレッドシートからカードデータを読み込み（キャッシュ済みなら即座）
  const cards = await loadCardsFromSheet();
  const { tools, saints, relics, achievements } = cards;

  const shuffledSaints = shuffle([...saints]);
  const shuffledRelics = shuffle([...relics]);

  const playerStates: MajoPlayerState[] = players.map((config) => ({
    config,
    mana: INITIAL_MANA,
    tappedMana: 0,          // ゲーム開始時のマナはアンタップ状態
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

  const initialState: MajoGameState = {
    players: playerStates,
    toolDeck: shuffledTools.slice(3),       // 残りデッキ
    toolSupply: shuffledTools.slice(0, 3),  // 展示3枚
    saintSupply: shuffledSaints.splice(0, 3),
    saintDeck: shuffledSaints,
    relicDeck: shuffledRelics,
    achievements: [...achievements],
    fieldActions: createFieldActions(),
    round: 1,
    currentPlayerIndex: 0,
    startPlayerIndex: 0,
    consecutivePasses: 0,
    phase: 'action',
    history: [],
    lastEvents: [],
  };

  // 最後のプレイヤー（後手番補正）：マナ+1ボーナス
  const lastIndex = players.length - 1;
  initialState.players = initialState.players.map((p, i) =>
    i === lastIndex ? { ...p, mana: p.mana + 1 } : p
  );

  return initialState;
}

// ── ユーティリティ ──

export function getCurrentPlayer(state: MajoGameState): MajoPlayerState {
  return state.players[state.currentPlayerIndex];
}

export function getPlayer(state: MajoGameState, playerId: string): MajoPlayerState {
  const p = state.players.find((p) => p.config.id === playerId);
  if (!p) throw new Error(`プレイヤー ${playerId} が見つからない`);
  return p;
}

function updatePlayer(state: MajoGameState, playerId: string, update: Partial<MajoPlayerState>): MajoGameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.config.id === playerId ? { ...p, ...update } : p
    ),
  };
}

function getField(state: MajoGameState, fieldId: FieldActionId): FieldAction {
  const f = state.fieldActions.find((f) => f.id === fieldId);
  if (!f) throw new Error(`フィールド ${fieldId} が見つからない`);
  return f;
}

function updateField(state: MajoGameState, fieldId: FieldActionId, update: Partial<FieldAction>): MajoGameState {
  return {
    ...state,
    fieldActions: state.fieldActions.map((f) =>
      f.id === fieldId ? { ...f, ...update } : f
    ),
  };
}

// 魔導具の実効魔力（M26の杖の特殊効果考慮）
export function getEffectiveMagicPower(tool: MajoToolCard, allTools: MajoToolCard[]): number {
  // M26のような「最大魔力+N」効果をパース
  const maxPowerMatch = tool.effect.match(/最大魔力の魔導具の魔力\+(\d+)/);
  if (maxPowerMatch) {
    const bonus = parseInt(maxPowerMatch[1], 10);
    const maxPower = Math.max(0, ...allTools.filter((t) => t.id !== tool.id).map((t) => t.magicPower));
    return maxPower + bonus;
  }
  return tool.magicPower;
}

// 戦闘魔力の計算
export function calculateCombatPower(
  player: MajoPlayerState,
  tappedToolIds: string[],
  useCombatRelics: string[] = [],
  useWitch: boolean = false,
  round: number = 1,
  activatedAmuletIds: string[] = [],
): number {
  let power = 0;

  // タップした魔導具の魔力合計
  for (const toolId of tappedToolIds) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool) {
      power += getEffectiveMagicPower(tool, player.magicTools);
      // 護符の戦闘ボーナス（選択式: activatedAmuletIdsに含まれる場合のみ）
      if (tool.type === '護符' && activatedAmuletIds.includes(toolId)) {
        const amuletMatch = tool.effect.match(/戦闘：魔力＋(\d+)/);
        if (amuletMatch) {
          power += parseInt(amuletMatch[1], 10);
        }
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

  // 魔女ボーナス（魔力モード）— ラウンド数がそのままボーナス値
  if (useWitch) {
    power += round;
  }

  return power;
}

// コスト削減計算（魔導書・水晶玉のタップ効果 + 聖遺物M54）
export function calculateCostReduction(player: MajoPlayerState, toolIdsToTapForDiscount: string[]): number {
  let reduction = 0;

  for (const toolId of toolIdsToTapForDiscount) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool) {
      if (tool.effect.includes('コスト-2')) reduction += 2;
      else if (tool.effect.includes('コスト-1')) reduction += 1;
    }
  }

  // 聖遺物：購入コスト減少（effect文字列で判定）
  for (const r of player.relics) {
    const costRedMatch = r.effect.match(/購入コストが(\d+)減る/);
    if (costRedMatch) reduction += parseInt(costRedMatch[1], 10);
  }

  return reduction;
}

// ── アクション可能チェック ──

export function canUseField(state: MajoGameState, fieldId: FieldActionId, useFamiliar: boolean = false): boolean {
  const field = getField(state, fieldId);
  if (field.maxSlots !== -1 && field.usedSlots >= field.maxSlots && !useFamiliar) {
    return false;
  }
  return true;
}

export function getAvailableActions(state: MajoGameState, playerId: string): MajoAction[] {
  const player = getPlayer(state, playerId);
  const actions: MajoAction[] = [];

  // 戦闘マルチステップ中の場合：戦闘専用アクションのみ返す
  if (state.combatState && state.combatState.playerId === playerId) {
    const cs = state.combatState;
    const totalPower = calculateCombatPower(player, cs.selectedToolIds, [], false, 0, cs.activatedAmuletIds);

    // 未タップかつ未選択の魔導具を追加できる
    for (const tool of player.magicTools) {
      if (!player.tappedToolIds.includes(tool.id) && !cs.selectedToolIds.includes(tool.id)) {
        actions.push({
          type: 'combat_add_tool',
          playerId,
          toolId: tool.id,
        });
      }
    }

    // 護符の戦闘効果発動（選択式: タップ済み護符で未発動のもの）
    for (const toolId of cs.selectedToolIds) {
      const tool = player.magicTools.find((t) => t.id === toolId);
      if (tool && tool.type === '護符' && tool.effect.includes('戦闘：魔力＋') && !cs.activatedAmuletIds.includes(toolId)) {
        actions.push({
          type: 'combat_activate_amulet',
          playerId,
          toolId,
        });
      }
    }

    // 戦闘実行
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
      // 聖者捨て→マナ系: 聖者選択が必要
      if (relic.effect.includes('聖者を1つ捨て') && player.saints.length > 0) {
        for (const saint of player.saints) {
          actions.push({ type: 'select_saint_discard', playerId, relicId: relic.id, saintId: saint.id });
        }
      } else if (relic.effect.includes('魔導具をタダで')) {
        // Nコスト以下の魔導具を選んでタダで獲得
        const costMatch = relic.effect.match(/(\d+)コスト以下/);
        const maxCost = costMatch ? parseInt(costMatch[1], 10) : 3;
        for (const tool of state.toolSupply) {
          if (tool.cost <= maxCost) {
            actions.push({ type: 'select_free_tool', playerId, relicId: relic.id, toolId: tool.id });
          }
        }
      } else {
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

  // 「いつでもアンタップしてよい」効果：タップ中ならアンタップアクションを生成
  for (const tool of player.magicTools) {
    if (tool.effect.includes('いつでもアンタップ') && player.tappedToolIds.includes(tool.id)) {
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

    if (!canUse && !canUseFamiliar) continue;

    const useFamiliar = !canUse && canUseFamiliar;

    switch (field.id) {
      case 'research': {
        // 割引可能な魔導具（未タップの魔導書・水晶玉でコスト-効果を持つもの）
        const discountTools = player.magicTools.filter(
          (t) => !player.tappedToolIds.includes(t.id) && (t.effect.includes('コスト-1') || t.effect.includes('コスト-2')),
        );
        // 割引パターンを全列挙（空=タップなし, 各1個, 各2個の組み合わせ）
        const discountPatterns: string[][] = [[]]; // まずタップなしパターン
        for (let i = 0; i < discountTools.length; i++) {
          const current = discountPatterns.length;
          for (let j = 0; j < current; j++) {
            discountPatterns.push([...discountPatterns[j], discountTools[i].id]);
          }
        }

        const addedKeys = new Set<string>(); // 重複排除用
        for (const pattern of discountPatterns) {
          const reduction = calculateCostReduction(player, pattern);
          for (const tool of state.toolSupply) {
            const effectiveCost = Math.max(1, tool.cost - reduction);
            if (player.mana >= effectiveCost) {
              // 同じツールで同じコストのパターンは重複排除
              const key = `${tool.id}:${effectiveCost}`;
              if (addedKeys.has(key)) continue;
              addedKeys.add(key);

              const details: FieldActionDetails = {
                action: 'research',
                toolId: tool.id,
                discountToolIds: pattern.length > 0 ? pattern : undefined,
              };
              if (useFamiliar) {
                actions.push({ type: 'use_familiar', playerId, fieldId: 'research', details });
              } else {
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
          const details: FieldActionDetails = { action: 'magic_shop' };
          if (useFamiliar) {
            actions.push({ type: 'use_familiar', playerId, fieldId: 'magic_shop', details });
          } else {
            actions.push({ type: 'field_action', playerId, fieldId: 'magic_shop', details });
          }
        }
        break;
      }

      case 'cathedral': {
        if (player.mana >= 1) {
          const details: FieldActionDetails = { action: 'cathedral' };
          if (useFamiliar) {
            actions.push({ type: 'use_familiar', playerId, fieldId: 'cathedral', details });
          } else {
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
            const details: FieldActionDetails = { action: 'prayer', relicId: relic.id };
            if (useFamiliar) {
              actions.push({ type: 'use_familiar', playerId, fieldId: 'prayer', details });
            } else {
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

export function executeAction(state: MajoGameState, action: MajoAction): MajoGameState {
  // アクション開始時にイベントログをリセット
  let newState: MajoGameState = { ...state, history: [...state.history, action], lastEvents: [] };

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
      newState = executeCombat(newState, action.playerId, action.saintId, action.tappedToolIds, action.combatRelicIds || [], []);
      newState.consecutivePasses = 0;
      newState = advanceTurn(newState);
      break;
    }

    case 'combat_select_saint': {
      // マナを消費し、combatStateをセット。手番は進めない
      const manaCost = action.fieldId === 'violence' ? 2 : 5;
      const p = getPlayer(newState, action.playerId);
      if (p.mana < manaCost) throw new Error(`マナが足りない（必要:${manaCost}, 所持:${p.mana}）`);

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
          activatedAmuletIds: [],
        },
      };
      break;
    }

    case 'combat_add_tool': {
      // combatState.selectedToolIdsにツールを追加。手番は進めない
      if (!newState.combatState) throw new Error('戦闘状態がない');
      newState = {
        ...newState,
        combatState: {
          ...newState.combatState,
          selectedToolIds: [...newState.combatState.selectedToolIds, action.toolId],
        },
      };
      break;
    }

    case 'combat_activate_amulet': {
      // 護符の戦闘効果を発動（選択式）
      if (!newState.combatState) throw new Error('戦闘状態がない');
      newState = {
        ...newState,
        combatState: {
          ...newState.combatState,
          activatedAmuletIds: [...newState.combatState.activatedAmuletIds, action.toolId],
        },
      };
      const amulet = getPlayer(newState, action.playerId).magicTools.find((t) => t.id === action.toolId);
      if (amulet) {
        const bonusMatch = amulet.effect.match(/戦闘：魔力＋(\d+)/);
        const bonus = bonusMatch ? bonusMatch[1] : '?';
        newState = {
          ...newState,
          lastEvents: [...newState.lastEvents, `護符「${amulet.name}」の戦闘効果を発動: 魔力＋${bonus}（廃棄）`],
        };
      }
      break;
    }

    case 'combat_execute': {
      // combatStateの情報でexecuteCombatを呼ぶ。combatStateをクリア。手番を進める
      if (!newState.combatState) throw new Error('戦闘状態がない');
      const cs = newState.combatState;
      newState = { ...newState, combatState: undefined };
      newState = executeCombat(newState, cs.playerId, cs.saintId, cs.selectedToolIds, action.combatRelicIds || [], cs.activatedAmuletIds);
      newState.consecutivePasses = 0;
      // M67追加戦闘フラグが立っていたら、同じプレイヤーの手番を続ける
      if (!newState.extraCombatPlayerId) {
        newState = advanceTurn(newState);
      }
      break;
    }

    case 'combat_retreat': {
      // combatStateをクリア。マナは消費済みなので戻さない。手番を進める
      if (!newState.combatState) throw new Error('戦闘状態がない');
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
      if (!tool) throw new Error(`魔導具 ${action.toolId} を所持していない`);

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
      // M66: 指定した聖者を捨ててNマナ獲得、聖遺物を廃棄
      const p = getPlayer(newState, action.playerId);
      const saint = p.saints.find((s) => s.id === action.saintId);
      if (!saint) throw new Error(`聖者 ${action.saintId} を所持していない`);
      const relic = p.relics.find((r) => r.id === action.relicId);
      const manaMatch = relic?.effect.match(/(\d+)マナを獲得/);
      const manaGain = manaMatch ? parseInt(manaMatch[1], 10) : 5;

      newState = updatePlayer(newState, action.playerId, {
        saints: p.saints.filter((s) => s.id !== action.saintId),
        victoryPoints: p.victoryPoints - saint.victoryPoints,
        tappedMana: p.tappedMana + manaGain,
        relics: p.relics.filter((r) => r.id !== action.relicId),
      });
      // 聖者を山札の一番下に戻す
      newState = { ...newState, saintDeck: [...newState.saintDeck, saint] };
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `聖遺物M66使用: 聖者「${saint.name}」を捨て、${manaGain}マナ獲得`],
      };
      break;
    }

    case 'untap_tool': {
      // M27 水晶玉: いつでもアンタップしてよい
      const p = getPlayer(newState, action.playerId);
      if (!p.tappedToolIds.includes(action.toolId)) throw new Error(`魔導具 ${action.toolId} はタップされていない`);
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
      if (!tool) throw new Error(`魔導具 ${action.toolId} が売り場にない`);
      const freeRelic = p.relics.find((r) => r.id === action.relicId);
      const freeCostMatch = freeRelic?.effect.match(/(\d+)コスト以下/);
      const freeMaxCost = freeCostMatch ? parseInt(freeCostMatch[1], 10) : 3;
      if (tool.cost > freeMaxCost) throw new Error(`魔導具 ${action.toolId} はコスト${tool.cost}で${freeMaxCost}コスト以下ではない`);

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

function executePass(state: MajoGameState, playerId: string): MajoGameState {
  let newState = updatePlayer(state, playerId, { passed: true });
  newState.consecutivePasses++;

  // 全員パスしたらラウンド終了
  if (newState.consecutivePasses >= newState.players.length) {
    return endRound(newState);
  }

  return advanceTurn(newState);
}

function executeFieldAction(
  state: MajoGameState,
  playerId: string,
  fieldId: FieldActionId,
  details: FieldActionDetails,
  useFamiliar: boolean,
): MajoGameState {
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
      if (!tool) throw new Error(`魔導具 ${details.toolId} が売り場にない`);
      const discountIds = details.discountToolIds || [];
      const reduction = calculateCostReduction(getPlayer(newState, playerId), discountIds);
      const cost = Math.max(1, tool.cost - reduction);
      const p = getPlayer(newState, playerId);
      if (p.mana < cost) throw new Error(`マナが足りない（必要:${cost}, 所持:${p.mana}）`);

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
      if (p.mana < manaCost) throw new Error(`マナが足りない`);

      newState = updatePlayer(newState, playerId, { mana: p.mana - manaCost });
      newState = executeCombat(newState, playerId, details.saintId, details.tappedToolIds, details.combatRelicIds || []);
      break;
    }

    case 'magic_shop': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      // コスト1はアンタップマナから支払い、報酬2はタップマナとして獲得
      newState = updatePlayer(newState, playerId, {
        mana: p.mana - 1,
        tappedMana: p.tappedMana + 2,
      });
      break;
    }

    case 'cathedral': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      // コスト1はアンタップマナから支払い、報酬1はタップマナとして獲得
      newState = updatePlayer(newState, playerId, {
        mana: p.mana - 1,
        tappedMana: p.tappedMana + 1,
      });

      // スタートプレイヤートークン移動
      const playerIndex = newState.players.findIndex((pp) => pp.config.id === playerId);
      newState.startPlayerIndex = playerIndex;

      // スタートプレイヤートークン獲得時のマナボーナス聖遺物
      const pUpdated = getPlayer(newState, playerId);
      for (const r of pUpdated.relics) {
        const spMatch = r.effect.match(/スタートプレイヤートークン獲得時、マナ＋(\d+)/);
        if (spMatch) {
          newState = updatePlayer(newState, playerId, { tappedMana: getPlayer(newState, playerId).tappedMana + parseInt(spMatch[1], 10) });
        }
      }
      break;
    }

    case 'prayer': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      const relic = p.relics.find((r) => r.id === details.relicId);
      if (!relic) throw new Error(`聖遺物 ${details.relicId} を持っていない`);

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

function executeCombat(
  state: MajoGameState,
  playerId: string,
  saintId: string,
  tappedToolIds: string[],
  combatRelicIds: string[] = [],
  activatedAmuletIds: string[] = [],
): MajoGameState {
  let newState = { ...state };
  const player = getPlayer(newState, playerId);
  const saint = newState.saintSupply.find((s) => s.id === saintId);
  if (!saint) throw new Error(`聖者 ${saintId} が展示にいない`);

  // 魔力計算（戦闘聖遺物のブーストを含む、魔女魔力モードも考慮、護符は選択式）
  const useWitchMagic = player.witchTapped && player.witchMode === 'magic';
  const power = calculateCombatPower(player, tappedToolIds, combatRelicIds, useWitchMagic, newState.round, activatedAmuletIds);

  // 魔女魔力モードは1回の戦闘でのみ有効 → 使用後にクリア
  if (useWitchMagic) {
    newState = updatePlayer(newState, playerId, { witchMode: undefined });
  }

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

  // 護符は戦闘効果を発動した場合のみ廃棄（選択式）
  const usedAmulets = activatedAmuletIds
    .map((id) => player.magicTools.find((t) => t.id === id))
    .filter((t) => t && t.type === '護符' && t.effect.includes('戦闘：魔力＋'));
  const amuletIds = usedAmulets.map((t) => t!.id);

  // 戦闘聖遺物のマナボーナス（M41/M42: 魔力+2, マナ+2）
  let combatRelicMana = 0;
  for (const relicId of combatRelicIds) {
    const relic = player.relics.find((r) => r.id === relicId);
    if (relic) {
      const manaMatch = relic.effect.match(/マナ＋(\d+)/);
      if (manaMatch) {
        combatRelicMana += parseInt(manaMatch[1], 10);
      }
    }
  }

  // 聖者撃破報酬（通常マナ報酬はタップ、即時マナはアンタップ）
  let tappedManaGain = saint.manaReward + combatRelicMana;
  let untappedManaGain = 0;

  // 魔剣・杖の聖者撃破効果（effect文字列から動的にパース）
  for (const toolId of tappedToolIds) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (!tool) continue;
    // 即時マナ＋N（アンタップマナとして獲得）
    const instantMatch = tool.effect.match(/聖者撃破：即時マナ＋(\d+)/);
    if (instantMatch) {
      untappedManaGain += parseInt(instantMatch[1], 10);
    }
    // 通常マナ＋N（タップマナとして獲得） ※「即時」でないマナ＋N
    const normalMatch = tool.effect.match(/聖者撃破：マナ＋(\d+)/);
    if (normalMatch && !tool.effect.includes('即時マナ')) {
      tappedManaGain += parseInt(normalMatch[1], 10);
    }
  }

  // 聖者撃破：聖遺物＋N 効果（タップしたツールの効果を反映）
  let bonusRelicDraw = 0;
  for (const toolId of tappedToolIds) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool) {
      const relicMatch = tool.effect.match(/聖者撃破：聖遺物＋(\d+)/);
      if (relicMatch) bonusRelicDraw += parseInt(relicMatch[1], 10);
    }
  }

  // 聖遺物を山札から引く（展示なし）
  const drawnRelics: MajoRelicCard[] = [];
  for (let i = 0; i < saint.relicDraw + bonusRelicDraw; i++) {
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

  // 追加戦闘聖遺物フラグ（effect文字列で判定）
  for (const relicId of combatRelicIds) {
    const combatRelic = updatedPlayer.relics.find((r) => r.id === relicId);
    if (combatRelic && combatRelic.effect.includes('追加で戦闘')) {
      newState.extraCombatPlayerId = playerId;
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `⚔️ 聖遺物発動！追加戦闘が可能に`],
      };
    }
  }

  // 実績チェック
  newState = checkAchievements(newState, playerId, power);

  return newState;
}

function executeWitch(state: MajoGameState, playerId: string, choice: 'magic' | 'mana'): MajoGameState {
  const player = getPlayer(state, playerId);
  if (player.witchTapped) throw new Error('魔女は既に使用済み');

  const bonus = state.round; // ラウンド数 = ボーナス値（R1=1, R2=2, R3=3...）

  if (choice === 'mana') {
    // 魔女マナモード：ラウンド数ぶんのマナを獲得
    return updatePlayer(state, playerId, {
      witchTapped: true,
      witchMode: 'mana',
      mana: player.mana + bonus,
    });
  } else {
    // 魔力モード：次の1回の戦闘でのみ魔力+ラウンド数のボーナス
    return updatePlayer(state, playerId, {
      witchTapped: true,
      witchMode: 'magic',
    });
  }
}

function executeRelic(state: MajoGameState, playerId: string, relicId: string): MajoGameState {
  const player = getPlayer(state, playerId);
  const relic = player.relics.find((r) => r.id === relicId);
  if (!relic) throw new Error(`聖遺物 ${relicId} を持っていない`);

  let newState = { ...state };

  // 効果適用（effect文字列で判定、IDハードコードなし）
  const effect = relic.effect;
  const removeRelic = () => player.relics.filter((r) => r.id !== relicId);

  if (effect.includes('タップ済みの魔導具をアンタップ')) {
    newState = updatePlayer(newState, playerId, {
      tappedToolIds: [],
      relics: removeRelic(),
    });
  } else if (effect.includes('タップマナをアンタップする')) {
    newState = updatePlayer(newState, playerId, {
      mana: player.mana + player.tappedMana,
      tappedMana: 0,
      relics: removeRelic(),
    });
  } else if (effect.includes('使い魔を未使用状態')) {
    newState = updatePlayer(newState, playerId, {
      familiarTapped: false,
      relics: removeRelic(),
    });
  } else if (effect.includes('魔導具をタダで')) {
    // select_free_tool で処理するのが通常。フォールバック
    const costMatch = effect.match(/(\d+)コスト以下/);
    const maxCost = costMatch ? parseInt(costMatch[1], 10) : 3;
    const freeTool = newState.toolSupply.find((t) => t.cost <= maxCost);
    if (freeTool) {
      newState = updatePlayer(newState, playerId, {
        magicTools: [...player.magicTools, freeTool],
        relics: removeRelic(),
      });
      newState = { ...newState, toolSupply: newState.toolSupply.filter((t) => t.id !== freeTool.id) };
      if (newState.toolDeck.length > 0) {
        const replenished = newState.toolDeck[0];
        newState = { ...newState, toolSupply: [...newState.toolSupply, replenished], toolDeck: newState.toolDeck.slice(1) };
      }
    }
  } else if (effect.includes('追加の手番を行う')) {
    newState = updatePlayer(newState, playerId, { relics: removeRelic() });
    const idx = newState.players.findIndex((p) => p.config.id === playerId);
    newState.currentPlayerIndex = idx;
  } else if (effect.includes('魔導具所持数')) {
    const bonusMatch = effect.match(/魔導具所持数\+(\d+)/);
    const bonus = bonusMatch ? parseInt(bonusMatch[1], 10) : 0;
    newState = updatePlayer(newState, playerId, {
      tappedMana: player.tappedMana + player.magicTools.length + bonus,
      relics: removeRelic(),
    });
  } else if (effect.includes('勝利点所持数と同じ数だけマナ')) {
    newState = updatePlayer(newState, playerId, {
      tappedMana: player.tappedMana + player.victoryPoints,
      relics: removeRelic(),
    });
  } else if (effect.includes('マナをサプライに戻し')) {
    const costMatch = effect.match(/(\d+)マナをサプライに戻し/);
    const gainMatch = effect.match(/(\d+)マナを獲得/);
    const manaCost = costMatch ? parseInt(costMatch[1], 10) : 2;
    const manaGain = gainMatch ? parseInt(gainMatch[1], 10) : 6;
    if (player.mana >= manaCost) {
      newState = updatePlayer(newState, playerId, {
        mana: player.mana - manaCost,
        tappedMana: player.tappedMana + manaGain,
        relics: removeRelic(),
      });
    }
  } else if (effect.includes('同じ数のマナを獲得')) {
    newState = updatePlayer(newState, playerId, { relics: removeRelic() });
    newState.manaRefundPlayerId = playerId;
    newState = { ...newState, lastEvents: [...newState.lastEvents, `💎 聖遺物発動！この手番中のマナ支払いが全額還元される`] };
  } else if (effect.includes('魔導具を1つ捨て')) {
    const costBonusMatch = effect.match(/コスト\+(\d+)/);
    const costBonus = costBonusMatch ? parseInt(costBonusMatch[1], 10) : 3;
    if (player.magicTools.length > 0 && newState.toolSupply.length > 0) {
      let bestExchange: { discard: MajoToolCard; gain: MajoToolCard; diff: number } | null = null;
      for (const ownTool of player.magicTools) {
        const maxCost = ownTool.cost + costBonus;
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
          magicTools: [...player.magicTools.filter((t) => t.id !== bestExchange!.discard.id), bestExchange.gain],
          relics: removeRelic(),
        });
        newState = {
          ...newState,
          toolSupply: newState.toolSupply.filter((t) => t.id !== bestExchange!.gain.id),
          toolDeck: [...newState.toolDeck, bestExchange.discard],
          lastEvents: [...newState.lastEvents, `🔄 聖遺物発動！${bestExchange.discard.name}(コスト${bestExchange.discard.cost})を捨てて${bestExchange.gain.name}(コスト${bestExchange.gain.cost})を獲得`],
        };
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
  } else if (effect.includes('聖者を1つ捨て')) {
    if (player.saints.length > 0) {
      const manaMatch = effect.match(/(\d+)マナを獲得/);
      const manaGain = manaMatch ? parseInt(manaMatch[1], 10) : 5;
      const discardedSaint = player.saints[player.saints.length - 1];
      newState = updatePlayer(newState, playerId, {
        saints: player.saints.slice(0, -1),
        victoryPoints: player.victoryPoints - discardedSaint.victoryPoints,
        tappedMana: player.tappedMana + manaGain,
        relics: removeRelic(),
      });
    }
  } else {
    // 未知の聖遺物は廃棄のみ
    newState = updatePlayer(newState, playerId, { relics: removeRelic() });
  }

  // 廃棄した聖遺物を聖遺物デッキの一番下に戻す
  const playerAfter = getPlayer(newState, playerId);
  if (!playerAfter.relics.some((r) => r.id === relicId) && relic) {
    newState = { ...newState, relicDeck: [...newState.relicDeck, relic] };
  }

  return newState;
}

// ── 実績チェック ──

function getAchievementScore(player: MajoPlayerState, achievement: MajoAchievementCard, combatPower: number): number {
  const cond = achievement.condition;
  // 「魔力で聖者を撃破」→ 戦闘魔力
  if (cond.includes('魔力') && cond.includes('撃破')) return combatPower;
  // 「任意の種類の魔導具をNつ以上」→ 同種の最大数
  if (cond.includes('種類') && cond.includes('魔導具')) {
    const typeCounts: Record<string, number> = {};
    for (const tool of player.magicTools) {
      typeCounts[tool.type] = (typeCounts[tool.type] || 0) + 1;
    }
    return Math.max(0, ...Object.values(typeCounts));
  }
  // 「聖遺物をNつ以上」
  if (cond.includes('聖遺物')) return player.relics.length;
  // 「聖者をNつ以上」（聖遺物より後に判定）
  if (cond.includes('聖者')) return player.saints.length;
  // 「魔導具をNつ以上」
  if (cond.includes('魔導具')) return player.magicTools.length;
  return 0;
}

function getAchievementThreshold(achievement: MajoAchievementCard): number {
  const numMatch = achievement.condition.match(/(\d+)/);
  return numMatch ? parseInt(numMatch[1], 10) : 999;
}

function checkAchievements(state: MajoGameState, playerId: string, combatPower: number = 0): MajoGameState {
  let newState = { ...state };
  const player = getPlayer(newState, playerId);

  for (let i = 0; i < newState.achievements.length; i++) {
    const achievement = newState.achievements[i];
    const threshold = getAchievementThreshold(achievement);
    const playerScore = getAchievementScore(player, achievement, combatPower);

    if (playerScore < threshold) continue;

    // 条件達成: 保持者がいない場合 → 獲得
    if (!achievement.holderId) {
      newState = updatePlayer(newState, playerId, {
        victoryPoints: getPlayer(newState, playerId).victoryPoints + achievement.victoryPoints,
      });
      newState.achievements = newState.achievements.map((a) =>
        a.id === achievement.id ? { ...a, holderId: playerId } : a,
      );
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `🏆 実績達成「${achievement.name}」★+${achievement.victoryPoints}！（${achievement.condition}）`],
      };
    } else if (achievement.holderId !== playerId) {
      // 保持者が別のプレイヤー → 上回っていたら奪取
      const holderPlayer = getPlayer(newState, achievement.holderId);
      const holderScore = getAchievementScore(holderPlayer, achievement, 0);
      if (playerScore > holderScore) {
        // 旧保持者からVPを引く
        newState = updatePlayer(newState, achievement.holderId, {
          victoryPoints: getPlayer(newState, achievement.holderId).victoryPoints - achievement.victoryPoints,
        });
        // 新保持者にVPを付与
        newState = updatePlayer(newState, playerId, {
          victoryPoints: getPlayer(newState, playerId).victoryPoints + achievement.victoryPoints,
        });
        newState.achievements = newState.achievements.map((a) =>
          a.id === achievement.id ? { ...a, holderId: playerId } : a,
        );
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

export function calculatePassiveRelicVP(player: MajoPlayerState): number {
  let vp = 0;

  for (const relic of player.relics) {
    if (relic.timing !== 'passive') continue;
    const eff = relic.effect;

    // 「XXかYYを所持していたら勝利点＋N」— 聖者名ペアチェック
    const saintPairMatch = eff.match(/(.+?)か(.+?)を所持していたら勝利点＋(\d+)/);
    if (saintPairMatch) {
      const [, name1, name2, vpStr] = saintPairMatch;
      if (player.saints.some((s) => s.name === name1 || s.name === name2)) vp += parseInt(vpStr, 10);
      continue;
    }

    // 「魔導具をN種類以上所持している場合、勝利点＋M」
    const toolTypesMatch = eff.match(/魔導具を(\d+)種類以上.*勝利点＋(\d+)/);
    if (toolTypesMatch) {
      const required = parseInt(toolTypesMatch[1], 10);
      const bonus = parseInt(toolTypesMatch[2], 10);
      const types = new Set(player.magicTools.map((t) => t.type));
      if (types.size >= required) vp += bonus;
      continue;
    }

    // 「体力Nの聖者を所持していたら勝利点＋M」
    const hpMatch = eff.match(/体力(\d+).*聖者.*勝利点＋(\d+)/);
    if (hpMatch) {
      const requiredHP = parseInt(hpMatch[1], 10);
      const bonus = parseInt(hpMatch[2], 10);
      if (player.saints.some((s) => s.hp >= requiredHP)) vp += bonus;
      continue;
    }

    // 「護符を所持していたら勝利点＋N」
    const amuletMatch = eff.match(/護符を所持.*勝利点＋(\d+)/);
    if (amuletMatch) {
      if (player.magicTools.some((t) => t.type === '護符')) vp += parseInt(amuletMatch[1], 10);
      continue;
    }

    // 「勝利点0の聖者」を所持している場合、勝利点＋N
    const zeroVPMatch = eff.match(/勝利点0の聖者.*勝利点＋(\d+)/);
    if (zeroVPMatch) {
      if (player.saints.some((s) => s.victoryPoints === 0)) vp += parseInt(zeroVPMatch[1], 10);
      continue;
    }
  }

  return vp;
}

// パッシブ聖遺物VPの差分を全プレイヤーに適用
function recalcAllPassiveVP(state: MajoGameState): MajoGameState {
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

function advanceTurn(state: MajoGameState): MajoGameState {
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

function endRound(state: MajoGameState): MajoGameState {
  // 勝利条件チェック
  if (state.players.some((p) => p.victoryPoints >= VICTORY_POINT_TARGET)) {
    return endGame(state);
  }

  // ラウンド終了をhistoryに記録
  const stateWithHistory: MajoGameState = {
    ...state,
    history: [...state.history, { type: 'round_end' } as MajoAction],
  };

  // フィールドリセット
  let newState: MajoGameState = {
    ...stateWithHistory,
    fieldActions: createFieldActions(),
    round: stateWithHistory.round + 1,
    consecutivePasses: 0,
    currentPlayerIndex: state.startPlayerIndex,
  };

  // 全プレイヤーの状態リセット
  newState = {
    ...newState,
    players: newState.players.map((p) => ({
      ...p,
      tappedToolIds: [],                       // 魔導具アンタップ
      passed: false,
      mana: p.mana + p.tappedMana + 1           // タップマナをアンタップ + ラウンド開始ボーナス+1
        + p.magicTools.filter((t) => !t.sealed).length,  // 封なし魔導具1枚につき即時マナ+1
      tappedMana: 0,                           // タップマナリセット
    })),
  };

  // M27 水晶玉は「いつでもアンタップ」なので実質的に上記で処理済み

  return newState;
}

function endGame(state: MajoGameState): MajoGameState {
  return { ...state, phase: 'finished' };
}

// ── 最終スコア ──

export function getMajoFinalScores(state: MajoGameState): MajoFinalScore[] {
  const scores: MajoFinalScore[] = state.players.map((p) => ({
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
    if (b.victoryPoints !== a.victoryPoints) return b.victoryPoints - a.victoryPoints;
    if (b.saints !== a.saints) return b.saints - a.saints;
    if (b.tools !== a.tools) return b.tools - a.tools;
    const manaA = state.players.find(p => p.config.id === a.playerId)!;
    const manaB = state.players.find(p => p.config.id === b.playerId)!;
    return (manaB.mana + manaB.tappedMana) - (manaA.mana + manaA.tappedMana);
  });

  let rank = 1;
  for (let i = 0; i < scores.length; i++) {
    if (i > 0) {
      const prev = scores[i - 1];
      const curr = scores[i];
      const prevPlayer = state.players.find(p => p.config.id === prev.playerId)!;
      const currPlayer = state.players.find(p => p.config.id === curr.playerId)!;
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

export function isMajoGameOver(state: MajoGameState): boolean {
  return state.phase === 'finished';
}
