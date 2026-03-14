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

async function runGame(strategies: { name: string; params: MajoParams }[]): Promise<{ winner: string; scores: { name: string; vp: number; saints: number; tools: number; relics: number }[] }> {
  const players: PlayerConfig[] = strategies.map((s, i) => ({
    id: `p${i}`,
    name: s.name,
    type: 'ai' as const,
    strategyId: `evolved_${s.name}`,
  }));

  const aiStrategies = strategies.map((s) => createParameterizedStrategy(s.params));

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
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  const loaded = names.map((n) => {
    const data = loadParams(n);
    console.log(chalk.gray(`  ${n}: gen${data.generation} fitness=${data.fitness.toFixed(2)}`));
    return { name: n, ...data };
  });

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

    // 席順をランダムにシャッフル
    const shuffled = [...loaded].sort(() => Math.random() - 0.5);
    const strategies = shuffled.map((s) => ({ name: s.name, params: s.params }));

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

  // パラメータ比較
  console.log(chalk.bold('\n╔══ パラメータ比較 ══════════════════════════╗\n'));
  const paramKeys = Object.keys(loaded[0].params) as (keyof MajoParams)[];
  const important = [
    'saintVPWeight', 'saintRelicWeight', 'saintZeroVPWeight',
    'toolBuyMaxCount', 'toolPowerWeight',
    'combatPriority', 'purchasePriority', 'manaPriority',
    'witchRoundThreshold', 'witchMagicModeWeight',
    'manaReserveForCombat', 'relicAggressiveness',
    'familiarVPThreshold', 'familiarForPurchase',
    'combatBeforePurchase',
  ];
  console.log(chalk.bold(`  ${'パラメータ'.padEnd(26)} ${'alpha'.padStart(7)} ${'beta'.padStart(7)} ${'gamma'.padStart(7)} ${'delta'.padStart(7)}`));
  for (const key of important) {
    const vals = loaded.map((l) => ((l.params as unknown as Record<string, number>)[key]).toFixed(2).padStart(7));
    console.log(`  ${String(key).padEnd(26)} ${vals.join(' ')}`);
  }

  console.log(chalk.bold('\n╚══════════════════════════════════════════╝'));
}

main().catch(console.error);
