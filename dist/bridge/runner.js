/**
 * Bridge CLI entry point.
 *
 * Usage:
 *   npm run bridge:replay -- --url URL --room ROOM --log replay.json --delay 2000
 *   npm run bridge:play   -- --url URL --room ROOM --players 3 --strategies balanced,aggressive
 */
import minimist from 'minimist';
import * as fs from 'fs';
import { BridgeClient } from './client.js';
import { ReplayController } from './replay.js';
import { StepController } from './step-controller.js';
import { PlayController } from './play.js';
import { strategyIds } from '../ai/strategies.js';
const DEFAULT_URL = 'https://bodoge-testplay-production.up.railway.app';
function printHelp() {
    console.log(`
ハゲタカの餌食 Bridge — bodoge_testplay Socket.io コントローラ

サブコマンド:
  replay    リプレイログをボードで再生
  play      人間 vs AI 対戦
  server    ブラウザベースのコントロールパネルサーバーを起動

共通オプション:
  --url URL       bodoge_testplay サーバーURL (デフォルト: ${DEFAULT_URL})
  --room ROOM     ルームID (デフォルト: hagetaka-bridge)
  --name NAME     プレイヤー名 (デフォルト: Bridge)
  --delay MS      アクション間の待機時間(ms) (デフォルト: 2000)

replay オプション:
  --log FILE      リプレイJSONファイルのパス (必須)

play オプション:
  --players N     総プレイヤー数 (デフォルト: 3, 最大: 5)
  --strategies    AIの戦略をカンマ区切りで指定
                  利用可能: ${strategyIds.join(', ')}

server オプション:
  --port N        コントロールパネルのポート (デフォルト: 3216)

例:
  npm run bridge:replay -- --room test1 --log game.json --delay 3000
  npm run bridge:play -- --room test2 --players 4 --strategies balanced,aggressive,chaotic
  npm run bridge:server
`);
}
async function runReplay(args) {
    const url = args['url'] ?? DEFAULT_URL;
    const roomId = args['room'] ?? 'hagetaka-bridge';
    const playerName = args['name'] ?? 'Bridge';
    const delay = args['delay'] ?? 2000;
    const logFile = args['log'];
    if (!logFile) {
        console.error('エラー: --log FILE を指定してください');
        process.exit(1);
    }
    if (!fs.existsSync(logFile)) {
        console.error(`エラー: ファイルが見つかりません: ${logFile}`);
        process.exit(1);
    }
    let replayLog;
    try {
        const raw = fs.readFileSync(logFile, 'utf-8');
        replayLog = JSON.parse(raw);
    }
    catch (e) {
        console.error(`エラー: JSONの解析に失敗しました: ${e.message}`);
        process.exit(1);
    }
    console.log(`[runner] Replay mode`);
    console.log(`[runner] Server: ${url}`);
    console.log(`[runner] Room: ${roomId || '(new room)'}`);
    console.log(`[runner] Log: ${logFile}`);
    const client = new BridgeClient({ url, roomId: roomId || undefined, playerName });
    const stepCtrl = new StepController(3216);
    console.log(`[replay] Controls: http://localhost:${stepCtrl.getPort()}`);
    try {
        const controller = new ReplayController(replayLog, client, { delay, stepController: stepCtrl });
        await controller.run();
    }
    finally {
        stepCtrl.destroy();
        client.disconnect();
    }
}
async function runPlay(args) {
    const url = args['url'] ?? DEFAULT_URL;
    const roomId = args['room'] ?? 'hagetaka-bridge';
    const playerName = args['name'] ?? '人間プレイヤー';
    const delay = args['delay'] ?? 1500;
    const playerCount = Math.min(Math.max(args['players'] ?? 3, 2), 5);
    const strategiesArg = args['strategies'];
    const aiStrategies = strategiesArg
        ? strategiesArg.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    // Validate strategies
    for (const sid of aiStrategies) {
        if (!strategyIds.includes(sid)) {
            console.error(`エラー: 戦略 "${sid}" は存在しません。利用可能: ${strategyIds.join(', ')}`);
            process.exit(1);
        }
    }
    console.log(`[runner] Play mode`);
    console.log(`[runner] Server: ${url}`);
    console.log(`[runner] Room: ${roomId}`);
    console.log(`[runner] Players: ${playerCount} (1 human + ${playerCount - 1} AI)`);
    if (aiStrategies.length > 0) {
        console.log(`[runner] AI strategies: ${aiStrategies.join(', ')}`);
    }
    const client = new BridgeClient({ url, roomId, playerName });
    try {
        const controller = new PlayController(client, {
            playerCount,
            aiStrategies,
            delay,
        });
        await controller.run();
    }
    finally {
        client.disconnect();
    }
}
async function runServer(args) {
    const port = args['port'] ?? parseInt(process.env.PORT || '3216', 10);
    const { startControlServer } = await import('./control-server.js');
    startControlServer(port);
    // サーバーは無限に動き続けるのでここでは何もしない
    await new Promise(() => { });
}
// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
    const args = minimist(process.argv.slice(2), {
        string: ['url', 'room', 'name', 'log', 'strategies'],
        boolean: ['help'],
    });
    const subcommand = args._[0];
    if (args.help || !subcommand) {
        printHelp();
        process.exit(0);
    }
    switch (subcommand) {
        case 'replay':
            await runReplay(args);
            break;
        case 'play':
            await runPlay(args);
            break;
        case 'server':
            await runServer(args);
            break;
        default:
            console.error(`エラー: 不明なサブコマンド "${subcommand}"`);
            printHelp();
            process.exit(1);
    }
}
main().catch((err) => {
    console.error('[runner] Fatal error:', err);
    process.exit(1);
});
