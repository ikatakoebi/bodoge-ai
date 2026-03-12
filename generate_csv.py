"""
ハゲタカの餌食のCSVデータ生成

=== 計算根拠 ===
cellSize = 10px (bodoge_testplay default)
miniカード = 88x126px
colStep = ceil((88+8)/10)*10 = 100px (グリッド揃え)
rowStep = ceil((126+8)/10)*10 = 140px

15枚1列: 14 * 100 + 88 = 1488px = 149 units
カード高さ: 126px = 13 units → エリア高15 units
画面: 1920x1080 → 192x108 units
"""
import os
import math

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hagetaka-sheets')
os.makedirs(out_dir, exist_ok=True)

CELL = 10  # px per unit
CARD_W, CARD_H = 88, 126
COL_STEP = 100  # ceil((88+8)/10)*10
ROW_STEP = 140

# bodoge_testplayと同じロジックでエリアサイズを計算
def calc_area_height(area_width_units, card_count):
    """bodoge_testplayのカード配置ロジックを再現して必要な高さを算出"""
    area_width_px = area_width_units * CELL
    max_cols = max(1, math.floor(area_width_px / COL_STEP))
    rows = math.ceil(card_count / max_cols)
    # rows * rowStep(px) → units + ラベル/パディング用に+4
    return rows * ROW_STEP // CELL + 4

# 必要エリアサイズ
HAND_CARDS = 15
HAND_W = (HAND_CARDS - 1) * COL_STEP // CELL + CARD_W // CELL + 2  # 150 units
HAND_H = calc_area_height(HAND_W, HAND_CARDS)
POINT_W = CARD_W // CELL + 2  # 11 units
POINT_H = calc_area_height(POINT_W, 1)  # 得点エリアは1枚
WON_W = 80  # 15枚を50px間隔で収容: 14*50+88=788px ≈ 80 units

FIELD_W = 192  # @1920px
FIELD_H = 108  # @1080px

# === cards.csv ===
player_colors = ['#3498db', '#e74c3c', '#9b59b6', '#f39c12', '#1abc9c']
player_labels = ['A', 'B', 'C', 'D', 'E']

lines = ['id,name,type,value,count,color,template,tag,min_players']

point_values = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
for i, v in enumerate(point_values):
    pid = f'P{i+1:02d}'
    color = '#c0392b' if v < 0 else '#27ae60'
    sign = f'+{v}' if v > 0 else str(v)
    lines.append(f'{pid},{sign},得点,{v},1,{color},point,point,')

for p_idx in range(5):
    label = player_labels[p_idx]
    color = player_colors[p_idx]
    min_p = p_idx + 1
    for card_num in range(1, 16):
        cid = f'H{card_num:02d}_{label}'
        lines.append(f'{cid},{card_num},手札,{card_num},1,{color},hand,hand_{label.lower()},{min_p}')

with open(os.path.join(out_dir, 'cards.csv'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print(f"cards.csv: {len(lines)-1} cards")

# === templates.csv ===
templates = """template,size,size_width,size_height,back_color,back_text,back_image,border_color,border_radius,border_color_field,field,position,fontSize,bold,italic,shape,bgColor,height,textColor
default,mini,,,,,,,,,,,,,,,,,
point,mini,,,#555555,?,,#666,10,color,value,center,48,TRUE,,,,,#ffffff
,,,,,,,,,,name,top,9,,,,,,,#ffffff
hand,mini,,,#1a4a8a,★,,#2980b9,10,color,value,center,48,TRUE,,,,,#ffffff
,,,,,,,,,,name,top,9,,,,,,,#ffffff"""
with open(os.path.join(out_dir, 'templates.csv'), 'w', encoding='utf-8') as f:
    f.write(templates + '\n')

# === areas.csv ===
# 画面108 units, 各行HAND_H units → 6行(5プレイヤー+中央)でぴったり
# 上から: P2(0), P4(18), 中央(36), P5(54), P3(72), P1(90)
CENTER_Y = HAND_H * 2  # 中央行のY
player_y = [HAND_H * 5, 0, HAND_H * 4, HAND_H, HAND_H * 3]  # P1,P2,P3,P4,P5
hand_colors = ['#3498db20', '#e74c3c20', '#9b59b620', '#f39c1220', '#1abc9c20']
won_colors = ['#3498db15', '#e74c3c15', '#9b59b615', '#f39c1215', '#1abc9c15']
played_colors = ['#3498db30', '#e74c3c30', '#9b59b630', '#f39c1230', '#1abc9c30']

areas_lines = ['area_id,name,x,y,width,height,visibility,per_player,bg_color']

# 中央行: 得点山札 & 場の得点 & 出したカード（全て同じ行に横並び）
SLOT_W = POINT_W + 2  # 各スロット間隔
areas_lines.append(f'point_deck,得点山札,2,{CENTER_Y},{POINT_W},{POINT_H},hidden,false,#55555540')
areas_lines.append(f'point_current,場の得点,{2 + SLOT_W},{CENTER_Y},{POINT_W},{POINT_H},public,false,#f39c1230')

# 出したカード（中央横並び、得点の右側）
played_start_x = 2 + SLOT_W * 2 + 4  # 得点2つの右に間隔あけて
for i in range(5):
    x = played_start_x + i * SLOT_W
    areas_lines.append(f'p_played_p{i},P{i+1}出し,{x},{CENTER_Y},{POINT_W},{POINT_H},public,false,{played_colors[i]}')

# 各プレイヤー
WON_X = 2 + HAND_W + 2
for i in range(5):
    y = player_y[i]
    areas_lines.append(f'p_hand_p{i},P{i+1} 手札,2,{y},{HAND_W},{HAND_H},public,false,{hand_colors[i]}')
    areas_lines.append(f'p_won_p{i},P{i+1} 獲得,{WON_X},{y},{WON_W},{HAND_H},public,false,{won_colors[i]}')

with open(os.path.join(out_dir, 'areas.csv'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(areas_lines) + '\n')

# === counters.csv ===
counters = """id,name,min,max,default,step,per_player
score,スコア,-50,100,0,1,true
round,ラウンド,1,15,1,1,false"""
with open(os.path.join(out_dir, 'counters.csv'), 'w', encoding='utf-8') as f:
    f.write(counters + '\n')

# === setup.csv ===
# NOTE: shuffleアクションはpool全体をシャッフルするので使わない
# 得点カードのシャッフルはUI上で手動 or AIブリッジ層で行う
setup = """action,to,from,filter_tag,count,perPlayer,faceUp,when,component
remove,,,hand_b,,,,players < 2,
remove,,,hand_c,,,,players < 3,
remove,,,hand_d,,,,players < 4,
remove,,,hand_e,,,,players < 5,
deal,point_deck,,point,15,false,false,,cards
deal,p_hand_p0,,hand_a,15,false,true,,cards
deal,p_hand_p1,,hand_b,15,false,true,,cards
deal,p_hand_p2,,hand_c,15,false,true,,cards
deal,p_hand_p3,,hand_d,15,false,true,,cards
deal,p_hand_p4,,hand_e,15,false,true,,cards"""
with open(os.path.join(out_dir, 'setup.csv'), 'w', encoding='utf-8') as f:
    f.write(setup + '\n')

print(f"""
=== HAND_W={HAND_W}, HAND_H={HAND_H} ===
15 cards need: {(HAND_CARDS-1)*COL_STEP + CARD_W}px = {((HAND_CARDS-1)*COL_STEP + CARD_W)//CELL} units
Area provides: {HAND_W}*{CELL} = {HAND_W*CELL}px
WON_X = {WON_X}
""")
