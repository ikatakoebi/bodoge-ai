// 魔女ゲー CLIランナー（AI同士の自動対戦）
import chalk from 'chalk';
import { createMajoGame, getCurrentPlayer, isMajoGameOver, executeAction, getMajoFinalScores, getPlayer, getEffectiveMagicPower, calculatePassiveRelicVP, } from '../engine/majo.js';
import { getMajoStrategy, getRandomMajoStrategy } from '../ai/majo-strategies.js';
const MAX_TURNS = 200; // 無限ループ防止
// ── 表示ヘルパー ──
function playerColor(id) {
    switch (id) {
        case 'p0': return chalk.cyan;
        case 'p1': return chalk.magenta;
        case 'p2': return chalk.green;
        case 'p3': return chalk.yellow;
        default: return chalk.white;
    }
}
function playerIcon(id) {
    switch (id) {
        case 'p0': return '🔵';
        case 'p1': return '🟣';
        case 'p2': return '🟢';
        case 'p3': return '🟡';
        default: return '⬜';
    }
}
function showPlayerStatus(player) {
    const color = playerColor(player.config.id);
    const icon = playerIcon(player.config.id);
    const witch = player.witchTapped ? chalk.gray('使用済') : chalk.green('未使用');
    const familiar = player.familiarTapped ? chalk.gray('使用済') : chalk.green('未使用');
    console.log(color(`  ${icon} ${player.config.name}`));
    // タップマナがある場合は「マナ: 3 (タップ2)」形式で表示
    const manaDisplay = player.tappedMana > 0
        ? `${chalk.yellow(String(player.mana))} ${chalk.gray(`(タップ${player.tappedMana})`)}`
        : chalk.yellow(String(player.mana));
    console.log(`     マナ: ${manaDisplay}  VP: ${chalk.bold.yellow(`★${player.victoryPoints}`)}  魔女:${witch}  使い魔:${familiar}`);
    // 魔導具（効果付き）
    if (player.magicTools.length > 0) {
        console.log(`     魔導具[${player.magicTools.length}]:`);
        for (const t of player.magicTools) {
            const tapped = player.tappedToolIds.includes(t.id) ? chalk.gray(' (T)') : '';
            const effect = t.effect ? chalk.gray(` …${t.effect}`) : '';
            console.log(`       ${t.name}(魔力${t.magicPower})${tapped}${effect}`);
        }
    }
    else {
        console.log(`     魔導具[0]: なし`);
    }
    // 聖者
    const saintNames = player.saints.map((s) => `${s.name}(★${s.victoryPoints})`).join(', ') || 'なし';
    console.log(`     聖者[${player.saints.length}]: ${saintNames}`);
    // 聖遺物（効果付き）
    if (player.relics.length > 0) {
        console.log(`     聖遺物[${player.relics.length}]:`);
        for (const r of player.relics) {
            console.log(`       ${r.id} ${chalk.gray(r.effect)}`);
        }
    }
}
function showFieldStatus(state) {
    console.log(chalk.gray('  ── 場の状況 ──'));
    // 魔導具展示（効果付き）
    if (state.toolSupply.length > 0) {
        console.log(`  魔導具展示[${state.toolSupply.length}]:`);
        for (const t of state.toolSupply) {
            const effect = t.effect ? chalk.gray(` …${t.effect}`) : '';
            console.log(`    ${t.name}(コスト${t.cost}/魔力${t.magicPower})${effect}`);
        }
    }
    else {
        console.log(`  魔導具展示: なし`);
    }
    // 聖者展示
    const saints = state.saintSupply.map((s) => `${s.name}(HP${s.hp}/★${s.victoryPoints})`).join('  ');
    console.log(`  聖者展示: ${saints || 'なし'}`);
    // フィールドアクション空き状況
    const fields = state.fieldActions.map((f) => {
        const slots = f.maxSlots === -1 ? '∞' : `${f.usedSlots}/${f.maxSlots}`;
        const full = f.maxSlots !== -1 && f.usedSlots >= f.maxSlots;
        return full ? chalk.gray(`${f.name}[${slots}]`) : `${f.name}[${slots}]`;
    }).join('  ');
    console.log(`  フィールド: ${fields}`);
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
                    const relicBoost = details.combatRelicIds?.length
                        ? ` + 聖遺物${details.combatRelicIds.length}枚`
                        : '';
                    if (saint) {
                        return `${prefix}横暴 → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦！ [${toolNames}${relicBoost}]`;
                    }
                    return `${prefix}横暴 → ${details.saintId}に挑戦`;
                }
                case 'sacrifice': {
                    const saint = state.saintSupply.find((s) => s.id === details.saintId);
                    return `${prefix}生贄(コスト5) → ${saint?.name || details.saintId}(HP${saint?.hp}/★${saint?.victoryPoints})に挑戦！`;
                }
                case 'magic_shop':
                    return `${prefix}魔具店 → マナ+2`;
                case 'cathedral':
                    return `${prefix}大聖堂 → スタートプレイヤー獲得 + マナ+1`;
                case 'prayer': {
                    const relic = player.relics.find((r) => r.id === details.relicId);
                    return `${prefix}祈祷 → 聖遺物(${relic?.id || details.relicId})を捨ててマナ+3`;
                }
            }
            return `${prefix}フィールドアクション`;
        }
        case 'use_witch': {
            const bonus = state.witchUsageCount; // 今までの使用回数
            if (action.choice === 'mana') {
                return `魔女発動(マナモード) → マナ+${2 + bonus} 【ゲーム${bonus + 1}人目の魔女使用】`;
            }
            else {
                return `魔女発動(魔力モード) → 次の戦闘で魔力+${3 + bonus} 【ゲーム${bonus + 1}人目の魔女使用】`;
            }
        }
        case 'use_relic': {
            const relic = player.relics.find((r) => r.id === action.relicId);
            return `聖遺物使用 → ${relic?.effect || action.relicId}`;
        }
        case 'extra_combat': {
            const saint = state.saintSupply.find((s) => s.id === action.saintId);
            const toolNames = action.tappedToolIds.map((id) => {
                const t = player.magicTools.find((tool) => tool.id === id);
                return t ? `${t.name}(${getEffectiveMagicPower(t, player.magicTools)})` : id;
            }).join('+');
            if (saint) {
                return `⚔️追加戦闘(M67) → ${saint.name}(HP${saint.hp}/★${saint.victoryPoints})に挑戦！ [${toolNames}]`;
            }
            return `⚔️追加戦闘(M67) → ${action.saintId}に挑戦`;
        }
        default:
            return action.type;
    }
}
// ── メインループ ──
async function runAutoGame(verbose = true) {
    const strategy1 = getRandomMajoStrategy();
    const strategy2 = getRandomMajoStrategy();
    const strategy3 = getRandomMajoStrategy();
    const strategy4 = getRandomMajoStrategy();
    const players = [
        { id: 'p0', name: `${strategy1.name}`, type: 'ai', strategyId: strategy1.id },
        { id: 'p1', name: `${strategy2.name}`, type: 'ai', strategyId: strategy2.id },
        { id: 'p2', name: `${strategy3.name}`, type: 'ai', strategyId: strategy3.id },
        { id: 'p3', name: `${strategy4.name}`, type: 'ai', strategyId: strategy4.id },
    ];
    let state = await createMajoGame(players);
    let turnCount = 0;
    let lastRound = 0;
    if (verbose) {
        console.log(chalk.bold('\n╔══════════════════════════════════╗'));
        console.log(chalk.bold('║       魔女ゲー AI対戦（4人）     ║'));
        console.log(chalk.bold('╚══════════════════════════════════╝'));
        console.log(`  🔵 P1: ${chalk.cyan.bold(strategy1.name)} - ${chalk.gray(strategy1.personality)}`);
        console.log(`  🟣 P2: ${chalk.magenta.bold(strategy2.name)} - ${chalk.gray(strategy2.personality)}`);
        console.log(`  🟢 P3: ${chalk.green.bold(strategy3.name)} - ${chalk.gray(strategy3.personality)}`);
        console.log(`  🟡 P4: ${chalk.yellow.bold(strategy4.name)} - ${chalk.gray(strategy4.personality)}`);
        console.log(chalk.gray(`  ※ 後手番(P4)はマナ+1ボーナスあり`));
    }
    while (!isMajoGameOver(state) && turnCount < MAX_TURNS) {
        // ラウンド開始表示
        if (verbose && state.round !== lastRound) {
            lastRound = state.round;
            console.log(chalk.bold.yellow(`\n━━━ ラウンド ${state.round} ━━━`));
            showFieldStatus(state);
            console.log('');
            for (const p of state.players) {
                showPlayerStatus(p);
            }
            console.log('');
        }
        const current = getCurrentPlayer(state);
        const strategy = getMajoStrategy(current.config.strategyId);
        const { action, reasoning } = strategy.selectAction(state, current.config.id);
        if (verbose) {
            const color = playerColor(current.config.id);
            const icon = playerIcon(current.config.id);
            const actionText = describeAction(action, state, current);
            if (action.type === 'pass') {
                console.log(chalk.gray(`  ${icon} ${current.config.name}: パス`));
            }
            else {
                console.log(color(`  ${icon} ${current.config.name}: ${actionText}`));
                console.log(chalk.gray(`     💭 ${reasoning}`));
            }
        }
        try {
            const prevVP = current.victoryPoints;
            state = executeAction(state, action);
            const afterPlayer = getPlayer(state, current.config.id);
            // 重要イベントの追加表示
            if (verbose) {
                if (afterPlayer.victoryPoints > prevVP) {
                    console.log(chalk.bold.yellow(`     🌟 VP ${prevVP} → ${afterPlayer.victoryPoints}！`));
                }
                if ((afterPlayer.mana !== current.mana || afterPlayer.tappedMana !== current.tappedMana) && action.type !== 'pass') {
                    const diffUntapped = afterPlayer.mana - current.mana;
                    const diffTapped = afterPlayer.tappedMana - current.tappedMana;
                    const sign = diffUntapped >= 0 ? '+' : '';
                    const tappedInfo = diffTapped !== 0
                        ? chalk.gray(` (タップ${diffTapped >= 0 ? '+' : ''}${diffTapped})`)
                        : '';
                    console.log(chalk.gray(`     💰 マナ ${current.mana} → ${afterPlayer.mana} (${sign}${diffUntapped})${tappedInfo}`));
                }
                // サプライ補充・聖遺物獲得ログ
                for (const event of state.lastEvents) {
                    console.log(chalk.gray(`     📦 ${event}`));
                }
            }
        }
        catch (err) {
            if (verbose) {
                console.log(chalk.red(`     ❌ エラー: ${err.message}`));
            }
            state = executeAction(state, { type: 'pass', playerId: current.config.id });
        }
        turnCount++;
    }
    // ── 最終結果 ──
    const scores = getMajoFinalScores(state);
    if (verbose) {
        console.log(chalk.bold.yellow('\n━━━ ゲーム終了 ━━━'));
        console.log('');
        // 最終状態
        for (const p of state.players) {
            showPlayerStatus(p);
            const passiveVP = calculatePassiveRelicVP(p);
            if (passiveVP > 0) {
                console.log(chalk.gray(`     🔮 パッシブ聖遺物ボーナス ★+${passiveVP} (VP内に反映済み)`));
            }
            console.log('');
        }
        console.log(chalk.bold('╔══════════════════════════════════╗'));
        console.log(chalk.bold('║           最終結果               ║'));
        console.log(chalk.bold('╚══════════════════════════════════╝'));
        for (const score of scores) {
            const medal = score.rank === 1 ? '👑' : score.rank === 2 ? '🥈' : score.rank === 3 ? '🥉' : '  ';
            const color = playerColor(score.playerId);
            const icon = playerIcon(score.playerId);
            console.log(`  ${medal} ${score.rank}位 ${icon} ${color(score.name)}: ${chalk.bold.yellow(`★${score.victoryPoints}VP`)}  (聖者${score.saints}体 魔導具${score.tools}個 聖遺物${score.relics}枚)`);
        }
        console.log(chalk.gray(`\n  ${state.round}ラウンド / ${turnCount}ターンで決着`));
    }
    return { scores, turnCount, rounds: state.round };
}
async function runStats(games) {
    console.log(chalk.bold(`\n═══ 魔女ゲー 統計 (${games}ゲーム) ═══\n`));
    const wins = {};
    let totalTurns = 0;
    let totalRounds = 0;
    for (let i = 0; i < games; i++) {
        const { scores, turnCount, rounds } = await runAutoGame(false);
        totalTurns += turnCount;
        totalRounds += rounds;
        const winnerId = scores[0].name;
        wins[winnerId] = (wins[winnerId] || 0) + 1;
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`\r  ${i + 1}/${games} 完了`);
        }
    }
    console.log('\n');
    console.log(chalk.bold('勝率:'));
    for (const [name, count] of Object.entries(wins).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / games) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(count / games * 30));
        console.log(`  ${name.padEnd(10)} ${String(count).padStart(3)}勝 ${pct.padStart(5)}% ${chalk.green(bar)}`);
    }
    console.log(chalk.gray(`\n  平均ターン: ${(totalTurns / games).toFixed(1)}`));
    console.log(chalk.gray(`  平均ラウンド: ${(totalRounds / games).toFixed(1)}`));
}
// ── メイン ──
const args = process.argv.slice(2);
const mode = args.includes('--stats') ? 'stats' : 'auto';
const gameCount = parseInt(args.find((a) => a.startsWith('--games='))?.split('=')[1] || '20');
if (mode === 'stats') {
    runStats(gameCount);
}
else {
    runAutoGame(true);
}
