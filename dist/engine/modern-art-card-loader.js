// Modern Art カードデータ：Google Sheetsから読み込み
const VALID_ARTISTS = new Set(['Lite Metal', 'Yoko', 'Christin P', 'Karl Gitter', 'Krypto']);
const VALID_AUCTION_TYPES = new Set(['open', 'once_around', 'sealed', 'fixed_price', 'double']);
// キャッシュ（同一プロセス内で1回だけfetch）
let cachedCards = null;
let sheetUrl = null;
/** スプレッドシートIDを設定 */
export function setModernArtSheetId(sheetId) {
    sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    cachedCards = null; // ID変更時はキャッシュクリア
}
/** スプレッドシートからカードデータを読み込む */
export async function loadModernArtCards() {
    if (cachedCards)
        return cachedCards;
    if (!sheetUrl)
        throw new Error('Modern ArtのスプレッドシートIDが設定されていません。setModernArtSheetId()を呼んでください');
    const res = await fetch(sheetUrl, { redirect: 'follow' });
    if (!res.ok)
        throw new Error(`スプレッドシート取得失敗: ${res.status}`);
    const csv = await res.text();
    cachedCards = parseModernArtCsv(csv);
    return cachedCards;
}
/** キャッシュクリア */
export function clearModernArtCardCache() {
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
function parseModernArtCsv(csv) {
    const lines = csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
    if (lines.length < 2)
        throw new Error('CSVが空');
    const headers = parseCsvLine(lines[0]);
    const col = (name) => headers.indexOf(name);
    const idCol = col('id');
    const artistCol = col('artist');
    const auctionCol = col('auctionType');
    if (idCol < 0 || artistCol < 0 || auctionCol < 0) {
        throw new Error(`CSV列不足。必要: id, artist, auctionType。実際: ${headers.join(', ')}`);
    }
    const cards = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const id = fields[idCol]?.trim();
        if (!id || id.startsWith('#'))
            continue;
        const artist = fields[artistCol]?.trim();
        const auctionType = fields[auctionCol]?.trim();
        if (!VALID_ARTISTS.has(artist)) {
            console.warn(`[modern-art-card-loader] 不明な画家 "${artist}" (行${i + 1}) — スキップ`);
            continue;
        }
        if (!VALID_AUCTION_TYPES.has(auctionType)) {
            console.warn(`[modern-art-card-loader] 不明なオークション種別 "${auctionType}" (行${i + 1}) — スキップ`);
            continue;
        }
        cards.push({
            id,
            artist: artist,
            auctionType: auctionType,
        });
    }
    if (cards.length === 0)
        throw new Error('有効なカードが0枚');
    console.log(`[modern-art-card-loader] ${cards.length}枚のカードを読み込み`);
    return cards;
}
