// 魔女ゲー トーナメント：異なる進化パラメータのAI同士を直接対決させる

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createMajoGame, getCurrentPlayer, isMajoGameOver,
  executeAction, getMajoFinalScores,
} from '../engine/majo.js';
import {
  createParameterizedStrategy,
  type MajoParams,
} from '../ai/majo-params.js';
import type { PlayerConfig } from '../engine/types.js';
import type { MajoGameState } from '../engine/majo-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const MAX_TURNS = 300;

interface TournamentResult {
  name: string;
  games: number;
  wins: number;
  totalVP: number;
  avgVP: number;
  winRate: number;
  totalSaints: number;
  totalTools: number;
  totalRelics: number;
}

function loadParams(name: string): { params: MajoParams; fitness: number; generation: number } {
  const filePath = path.join(DATA_DIR, `evolved-params-${name}.json`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return { params: data.params, fitness: data.fitness, generation: data.generation };
}

async function runGame(strategies: { name: string; strategy: any }[]): Promise<{ winner: string; scores: { name: string; vp: number; saints: number; tools: number; relics: number }[] }> {
  const players: PlayerConfig[] = strategies.map((s, i) => ({
    id: `p${i}`,
    name: s.name,
    type: 'ai' as const,
    strategyId: `evolved_${s.name}`,
  }));

  const aiStrategies = strategies.map((s) => s.strategy);

  let state = await createMajoGame(players);
  let turns = 0;

  while (!isMajoGameOver(state) && turns < MAX_TURNS) {
    const current = getCurrentPlayer(state);
    const strategy = aiStrategies[state.currentPlayerIndex];
    const { action } = strategy.selectAction(state, current.config.id);
    state = executeAction(state, action);
    turns++;
  }

  const finalScores = getMajoFinalScores(state);
  const scores = finalScores.map((s) => {
    const p = state.players.find((pp) => pp.config.id === s.playerId)!;
    return {
      name: s.name,
      vp: s.victoryPoints,
      saints: p.saints.length,
      tools: p.magicTools.length,
      relics: p.relics.length,
    };
  });

  const winner = finalScores.sort((a, b) => b.victoryPoints - a.victoryPoints)[0].name;
  return { winner, scores };
}

async function main() {
  // 全進化世代を読み込み
  const evolvedNames = ['beta', 'gamma', 'delta'];
  const strategyMap: Record<string, any> = {};
  const names: string[] = [];

  // 最新進化型
  const latestPath = path.join(DATA_DIR, 'evolved-params.json');
  const latestData = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
  console.log(chalk.gray(`  v3(latest): gen${latestData.generation} fitness=${latestData.fitness.toFixed(2)}`));
  strategyMap['v3_latest'] = createParameterizedStrategy(latestData.params);
  names.push('v3_latest');

  // 新パラメータのデフォルト値（旧世代に補完用）
  const newParamDefaults: Record<string, number> = {
    violenceMinVP: 2, violenceMinMana: 6, prayerEarlyRound: 2, sacrificeMinRelics: 3,
    effectManaBonus: 0.5, effectCombatBonus: 0.5, effectDrawBonus: 0.3,
    effectUntapBonus: 1.0, effectVPBonus: 1.0,
    phaseEarlyEnd: 2, phaseLateStart: 4, combatPriorityLate: 1.5,
    purchasePriorityEarly: 1.5, manaShopThresholdLate: 4,
    vpDeficitCombatBoost: 0.5, vpLeadPurchaseBoost: 0.3, opponentSPAwareness: 0.5,
  };

  // 過去の進化世代（不足パラメータはデフォルトで補完）
  for (const n of evolvedNames) {
    try {
      const data = loadParams(n);
      const filled = { ...newParamDefaults, ...data.params };
      console.log(chalk.gray(`  ${n}: gen${data.generation} fitness=${data.fitness.toFixed(2)} (params: ${Object.keys(data.params).length}→${Object.keys(filled).length})`));
      strategyMap[n] = createParameterizedStrategy(filled as MajoParams);
      names.push(n);
    } catch { /* skip missing */ }
  }

  const numGames = 2000;

  console.log(chalk.bold(`\n╔══════════════════════════════════════════╗`));
  console.log(chalk.bold(`║  魔女ゲー トーナメント (${numGames}ゲーム)       ║`));
  console.log(chalk.bold(`╚══════════════════════════════════════════╝\n`));

  const results: Record<string, TournamentResult> = {};
  for (const n of names) {
    results[n] = { name: n, games: 0, wins: 0, totalVP: 0, avgVP: 0, winRate: 0, totalSaints: 0, totalTools: 0, totalRelics: 0 };
  }

  for (let i = 0; i < numGames; i++) {
    if ((i + 1) % 100 === 0 || i === 0) {
      process.stdout.write(`\r  対戦中... ${i + 1}/${numGames}`);
    }

    // 全員参加、席順だけシャッフル
    const shuffled = [...names].sort(() => Math.random() - 0.5);
    const strategies = shuffled.map((n) => ({ name: n, strategy: strategyMap[n] }));

    const { winner, scores } = await runGame(strategies);

    for (const score of scores) {
      const r = results[score.name];
      r.games++;
      r.totalVP += score.vp;
      r.totalSaints += score.saints;
      r.totalTools += score.tools;
      r.totalRelics += score.relics;
      if (score.name === winner) r.wins++;
    }
  }

  // 結果計算
  for (const r of Object.values(results)) {
    r.avgVP = r.totalVP / r.games;
    r.winRate = r.wins / r.games;
  }

  // 勝率順にソート
  const sorted = Object.values(results).sort((a, b) => b.winRate - a.winRate);

  console.log(chalk.bold(`\n\n╔══ トーナメント結果 (${numGames}ゲーム) ══════════╗\n`));

  console.log(chalk.bold('  順位  名前     勝率      平均VP   勝数    平均聖者  平均魔導  平均聖遺'));
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const winPct = (r.winRate * 100).toFixed(1).padStart(5);
    const avgVP = r.avgVP.toFixed(2).padStart(6);
    const wins = String(r.wins).padStart(5);
    const avgS = (r.totalSaints / r.games).toFixed(1).padStart(5);
    const avgT = (r.totalTools / r.games).toFixed(1).padStart(5);
    const avgR = (r.totalRelics / r.games).toFixed(1).padStart(5);
    console.log(`  ${medal} ${(i + 1)}位  ${r.name.padEnd(8)} ${winPct}%   ${avgVP}VP  ${wins}勝  ${avgS}   ${avgT}   ${avgR}`);
  }

  // パラメータ比較は省略（固定戦略はパラメータベースではない）

  console.log(chalk.bold('\n╚══════════════════════════════════════════╝'));
}

main().catch(console.error);
