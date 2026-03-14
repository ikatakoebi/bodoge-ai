// 魔女ゲー カードデータ：Google Sheetsから直接読み込み
const SHEET_ID = '1h7iwwlbE6_QBd3ClFFAW-PrgVx0quFWJgSb0MKrkbfc';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
// キャッシュ（同一プロセス内で1回だけfetch）
let cachedCards = null;
/** スプレッドシートからカードデータを読み込む */
export async function loadCardsFromSheet() {
    if (cachedCards)
        return cachedCards;
    const res = await fetch(SHEET_CSV_URL, { redirect: 'follow' });
    if (!res.ok)
        throw new Error(`スプレッドシート取得失敗: ${res.status}`);
    const csv = await res.text();
    cachedCards = parseCardsCsv(csv);
    return cachedCards;
}
/** キャッシュをクリア（スプシ更新後に再読み込みしたい場合） */
export function clearCardCache() {
    cachedCards = null;
}
// ── CSVパース ──
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += ch;
            }
        }
        else {
            if (ch === '"') {
                inQuotes = true;
            }
            else if (ch === ',') {
                fields.push(current);
                current = '';
            }
            else {
                current += ch;
            }
        }
    }
    fields.push(current);
    return fields;
}
function parseCardsCsv(csv) {
    const lines = csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
    if (lines.length < 2)
        throw new Error('CSVが空');
    const headers = parseCsvLine(lines[0]);
    const col = (name) => headers.indexOf(name);
    const tools = [];
    const saints = [];
    const relics = [];
    const achievements = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        let id = fields[col('id')]?.trim();
        if (!id || id.startsWith('#'))
            continue; // コメント行・トークン行はスキップ
        // スプシの数式が残っている場合、IDを抽出（例: "M1=TRIM(...)" → "M1"）
        const idMatch = id.match(/^(M\d+)/);
        if (!idMatch)
            continue;
        id = idMatch[1];
        const type = fields[col('type')]?.trim();
        const name = fields[col('name')]?.trim() ?? '';
        const cost = parseInt(fields[col('cost')] ?? '0', 10) || 0;
        const effect = fields[col('effect')]?.trim() ?? '';
        const hp = parseInt(fields[col('hp')] ?? '0', 10) || 0;
        const vp = parseInt(fields[col('vp')] ?? '0', 10) || 0;
        const mp = parseInt(fields[col('mp')] ?? '0', 10) || 0;
        const seal = fields[col('seal')]?.trim() ?? '';
        if (type === '魔導具') {
            const toolType = name;
            tools.push({
                id, name: toolType, type: toolType, cost,
                magicPower: mp,
                effect,
                sealed: seal === '封',
            });
        }
        else if (type === '聖者') {
            // costカラム = 聖遺物引き枚数(relicDraw)
            // manaReward: effect列の「マナ＋X」から読み取る
            const manaMatch = effect.match(/マナ＋(\d+)/);
            const manaReward = manaMatch ? parseInt(manaMatch[1], 10) : 0;
            saints.push({
                id, name,
                hp,
                manaReward,
                victoryPoints: vp,
                relicDraw: cost,
            });
        }
        else if (type === '聖遺物') {
            let timing = 'passive';
            if (effect.startsWith('戦闘'))
                timing = 'combat';
            else if (effect.startsWith('手番'))
                timing = 'turn';
            // 売り場〜 も手番用
            else if (effect.startsWith('売り場'))
                timing = 'turn';
            relics.push({
                id, effect,
                timing,
                isDisposable: effect.includes('廃棄'),
            });
        }
        else if (type === '実績') {
            achievements.push({
                id, name,
                condition: effect,
                victoryPoints: 2,
            });
        }
        // 魔女、使い魔、基本（フィールド）、トークンはスキップ
    }
    return { tools, saints, relics, achievements };
}
