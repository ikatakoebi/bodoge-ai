// 魔女ゲー カードデータ（CSVから変換）
// ── 魔導具（28枚） ──
export const ALL_TOOLS = [
    // コスト2（6枚）
    { id: 'M1', name: '魔剣', type: '魔剣', cost: 2, magicPower: 3, effect: '聖者撃破：マナ＋1' },
    { id: 'M2', name: '杖', type: '杖', cost: 2, magicPower: 3, effect: '聖者撃破：マナ＋1' },
    { id: 'M3', name: '杖', type: '杖', cost: 2, magicPower: 3, effect: '聖者撃破：マナ＋1' },
    { id: 'M4', name: '魔導書', type: '魔導書', cost: 2, magicPower: 2, effect: '' },
    { id: 'M5', name: '魔導書', type: '魔導書', cost: 2, magicPower: 1, effect: '支払いの際、タップでコスト-1' },
    { id: 'M6', name: '護符', type: '護符', cost: 2, magicPower: 0, effect: '戦闘：魔力＋3。廃棄' },
    // コスト3（6枚）
    { id: 'M7', name: '魔剣', type: '魔剣', cost: 3, magicPower: 4, effect: '聖者撃破：マナ＋1' },
    { id: 'M8', name: '杖', type: '杖', cost: 3, magicPower: 4, effect: '聖者撃破：マナ＋1' },
    { id: 'M9', name: '杖', type: '杖', cost: 3, magicPower: 4, effect: '聖者撃破：マナ＋1' },
    { id: 'M10', name: '魔導書', type: '魔導書', cost: 3, magicPower: 3, effect: '' },
    { id: 'M11', name: '魔導書', type: '魔導書', cost: 3, magicPower: 2, effect: '支払いの際、タップでコスト-1' },
    { id: 'M12', name: '護符', type: '護符', cost: 3, magicPower: 1, effect: '戦闘：魔力＋3。廃棄' },
    // コスト4（7枚）
    { id: 'M13', name: '魔剣', type: '魔剣', cost: 4, magicPower: 5, effect: '聖者撃破：マナ＋1' },
    { id: 'M14', name: '杖', type: '杖', cost: 4, magicPower: 5, effect: '聖者撃破：マナ＋1' },
    { id: 'M15', name: '杖', type: '杖', cost: 4, magicPower: 5, effect: '聖者撃破：マナ＋1' },
    { id: 'M16', name: '杖', type: '杖', cost: 4, magicPower: 4, effect: '' },
    { id: 'M17', name: '水晶玉', type: '水晶玉', cost: 4, magicPower: 4, effect: '' },
    { id: 'M18', name: '水晶玉', type: '水晶玉', cost: 4, magicPower: 3, effect: '支払いの際、タップでコスト-1' },
    { id: 'M19', name: '護符', type: '護符', cost: 4, magicPower: 2, effect: '戦闘：魔力＋3。廃棄' },
    // コスト5（5枚）
    { id: 'M20', name: '魔剣', type: '魔剣', cost: 5, magicPower: 5, effect: '聖者撃破：即時マナ＋1' },
    { id: 'M21', name: '魔剣', type: '魔剣', cost: 5, magicPower: 5, effect: '聖者撃破：即時マナ＋1' },
    { id: 'M22', name: '魔剣', type: '魔剣', cost: 5, magicPower: 5, effect: '聖者撃破：即時マナ＋1' },
    { id: 'M23', name: '水晶玉', type: '水晶玉', cost: 5, magicPower: 3, effect: '支払いの際、タップでコスト-2' },
    { id: 'M24', name: '護符', type: '護符', cost: 5, magicPower: 3, effect: '戦闘：魔力＋3。廃棄' },
    // コスト6（4枚）
    { id: 'M25', name: '魔剣', type: '魔剣', cost: 6, magicPower: 5, effect: '聖者撃破：即時マナ＋2' },
    { id: 'M26', name: '杖', type: '杖', cost: 6, magicPower: 0, effect: '手持ちの最大魔力の魔導具の魔力+3として扱う' },
    { id: 'M27', name: '水晶玉', type: '水晶玉', cost: 6, magicPower: 4, effect: 'いつでもアンタップしてよい' },
    { id: 'M28', name: '護符', type: '護符', cost: 6, magicPower: 3, effect: '手番：勝利点＋1。廃棄' },
];
// ── 聖者（24枚） ──
export const ALL_SAINTS = [
    // 体力3 / マナ+1報酬 / 0星（5枚）
    { id: 'M71', name: 'セラフィム', hp: 3, manaReward: 1, victoryPoints: 0, relicDraw: 1 },
    { id: 'M72', name: 'ガブリエル', hp: 3, manaReward: 1, victoryPoints: 0, relicDraw: 1 },
    { id: 'M73', name: 'ウリエル', hp: 3, manaReward: 1, victoryPoints: 0, relicDraw: 1 },
    { id: 'M74', name: 'メタトロン', hp: 3, manaReward: 1, victoryPoints: 0, relicDraw: 1 },
    { id: 'M75', name: 'ケルビム', hp: 3, manaReward: 1, victoryPoints: 0, relicDraw: 1 },
    // 体力4 / マナ+1報酬 / 0星（5枚）
    { id: 'M76', name: 'アズラエル', hp: 4, manaReward: 1, victoryPoints: 0, relicDraw: 2 },
    { id: 'M77', name: 'セラフィム', hp: 4, manaReward: 1, victoryPoints: 0, relicDraw: 2 },
    { id: 'M78', name: 'ガブリエル', hp: 4, manaReward: 1, victoryPoints: 0, relicDraw: 2 },
    { id: 'M79', name: 'ウリエル', hp: 4, manaReward: 1, victoryPoints: 0, relicDraw: 2 },
    { id: 'M80', name: 'メタトロン', hp: 4, manaReward: 1, victoryPoints: 0, relicDraw: 2 },
    // 体力5 / 1星（4枚）
    { id: 'M81', name: 'ケルビム', hp: 5, manaReward: 0, victoryPoints: 1, relicDraw: 1 },
    { id: 'M82', name: 'アズラエル', hp: 5, manaReward: 0, victoryPoints: 1, relicDraw: 1 },
    { id: 'M83', name: 'セラフィム', hp: 5, manaReward: 0, victoryPoints: 1, relicDraw: 1 },
    { id: 'M84', name: 'ガブリエル', hp: 5, manaReward: 0, victoryPoints: 1, relicDraw: 1 },
    // 体力6 / 1星（4枚）
    { id: 'M85', name: 'ウリエル', hp: 6, manaReward: 0, victoryPoints: 1, relicDraw: 2 },
    { id: 'M86', name: 'メタトロン', hp: 6, manaReward: 0, victoryPoints: 1, relicDraw: 2 },
    { id: 'M87', name: 'ケルビム', hp: 6, manaReward: 0, victoryPoints: 1, relicDraw: 2 },
    { id: 'M88', name: 'アズラエル', hp: 6, manaReward: 0, victoryPoints: 1, relicDraw: 2 },
    // 体力8-13 / 2-3星（6枚）
    { id: 'M89', name: 'セラフィム', hp: 8, manaReward: 0, victoryPoints: 2, relicDraw: 1 },
    { id: 'M90', name: 'ガブリエル', hp: 9, manaReward: 0, victoryPoints: 2, relicDraw: 1 },
    { id: 'M91', name: 'ウリエル', hp: 10, manaReward: 0, victoryPoints: 2, relicDraw: 1 },
    { id: 'M92', name: 'メタトロン', hp: 11, manaReward: 0, victoryPoints: 2, relicDraw: 2 },
    { id: 'M93', name: 'ケルビム', hp: 12, manaReward: 0, victoryPoints: 2, relicDraw: 2 },
    { id: 'M94', name: 'アズラエル', hp: 13, manaReward: 0, victoryPoints: 3, relicDraw: 2 },
];
// ── 聖遺物（27枚） ──
export const ALL_RELICS = [
    // 戦闘用
    { id: 'M41', effect: '戦闘：魔力＋2。マナ＋1。廃棄', timing: 'combat', isDisposable: true },
    { id: 'M42', effect: '戦闘：魔力＋2。マナ＋1。廃棄', timing: 'combat', isDisposable: true },
    { id: 'M67', effect: '戦闘：戦闘終了後、追加で戦闘してもよい。廃棄', timing: 'combat', isDisposable: true },
    // 手番用
    { id: 'M43', effect: '手番：タップ済みの魔導具をアンタップ。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M44', effect: '手番：タップ済みの魔導具をアンタップ。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M52', effect: '手番：使い魔を未使用状態にする。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M53', effect: '売り場の3コスト以下の魔導具をタダで1枚獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M56', effect: '手番：タップマナをアンタップする。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M57', effect: '手番：タップマナをアンタップする。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M58', effect: '手番：タップマナをアンタップする。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M59', effect: '手番：タップマナをアンタップする。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M60', effect: '手番：手番終了後、追加の手番を行う。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M61', effect: '手番：魔導具所持数と同じ数だけマナを獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M62', effect: '手番：勝利点所持数と同じ数だけマナを獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M63', effect: '手番：2マナをサプライに戻し、6マナを獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M64', effect: '手番：この手番中にマナを支払うなら、同じ数のマナを獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M65', effect: '手番：魔導具を1つ捨て、捨てた魔導具のコスト+3コストまでの魔導具を売り場から獲得。廃棄', timing: 'turn', isDisposable: true },
    { id: 'M66', effect: '手番：聖者を1つ捨て、4マナを獲得。廃棄', timing: 'turn', isDisposable: true },
    // パッシブ（持ってるだけでゲーム終了時にVP）
    { id: 'M45', effect: 'セラフィムかガブリエルを所持していたら勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M46', effect: 'ウリエルかメタトロンを所持していたら勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M47', effect: 'ケルビムかアズラエルを所持していたら勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M48', effect: '魔導具を4種類以上所持している場合、勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M49', effect: '体力10の聖者を所持していたら勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M50', effect: '護符を所持していたら勝利点＋1', timing: 'passive', isDisposable: false },
    { id: 'M51', effect: '勝利点0の聖者を所持している場合、勝利点＋1', timing: 'passive', isDisposable: false },
    // 永続効果
    { id: 'M54', effect: '魔導具の購入コストが1減る。（最低1）', timing: 'passive', isDisposable: false },
    { id: 'M55', effect: 'スタートプレイヤートークン獲得時、マナ＋1', timing: 'passive', isDisposable: false },
];
// ── 実績（5枚） ──
export const ALL_ACHIEVEMENTS = [
    { id: 'M126', name: '魔導具コレクター', condition: '魔導具を5つ以上所持する', victoryPoints: 2 },
    { id: 'M127', name: '最大火力', condition: '14以上の魔力で聖者を撃破する', victoryPoints: 2 },
    { id: 'M128', name: '撃破王', condition: '聖者を5つ以上所持する', victoryPoints: 2 },
    { id: 'M129', name: 'スペシャリスト', condition: '任意の種類の魔導具を3つ以上所持する', victoryPoints: 2 },
    { id: 'M130', name: '探求者', condition: '聖遺物を5つ以上所持する', victoryPoints: 2 },
];
