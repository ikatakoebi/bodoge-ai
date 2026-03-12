"""
ハゲタカの餌食のスプレッドシートをGoogle Sheets APIで作成する
"""
import csv
import subprocess
import json
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

def get_credentials():
    """application default credentials を使用"""
    import google.auth
    creds, project = google.auth.default(
        scopes=[
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file',
        ]
    )
    return creds

def read_csv(filepath):
    """CSVファイルを2次元配列として読み込む"""
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        for row in reader:
            rows.append(row)
    return rows

def main():
    creds = get_credentials()
    service = build('sheets', 'v4', credentials=creds)

    # スプレッドシート作成
    spreadsheet_body = {
        'properties': {
            'title': 'ハゲタカの餌食 - テストプレイデータ'
        },
        'sheets': [
            {'properties': {'title': 'cards'}},
            {'properties': {'title': 'templates'}},
            {'properties': {'title': 'areas'}},
            {'properties': {'title': 'counters'}},
            {'properties': {'title': 'setup'}},
        ]
    }

    spreadsheet = service.spreadsheets().create(
        body=spreadsheet_body
    ).execute()

    spreadsheet_id = spreadsheet['spreadsheetId']
    spreadsheet_url = spreadsheet['spreadsheetUrl']
    print(f"スプレッドシート作成完了!")
    print(f"ID: {spreadsheet_id}")
    print(f"URL: {spreadsheet_url}")

    # 各シートにデータを書き込む
    import os
    base_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hagetaka-sheets')
    sheets_data = {
        'cards': read_csv(f'{base_path}/cards.csv'),
        'templates': read_csv(f'{base_path}/templates.csv'),
        'areas': read_csv(f'{base_path}/areas.csv'),
        'counters': read_csv(f'{base_path}/counters.csv'),
        'setup': read_csv(f'{base_path}/setup.csv'),
    }

    batch_data = []
    for sheet_name, rows in sheets_data.items():
        if rows:
            batch_data.append({
                'range': f'{sheet_name}!A1',
                'values': rows,
            })

    service.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            'valueInputOption': 'RAW',
            'data': batch_data,
        }
    ).execute()
    print("全シートにデータ書き込み完了!")

    # 共有設定: リンクを知っている全員が閲覧可能
    drive_service = build('drive', 'v3', credentials=creds)
    drive_service.permissions().create(
        fileId=spreadsheet_id,
        body={
            'type': 'anyone',
            'role': 'reader',
        }
    ).execute()
    print("共有設定完了（リンクを知っている全員が閲覧可能）")

    print(f"\n=== 完了 ===")
    print(f"URL: {spreadsheet_url}")
    print(f"bodoge_testplayにこのURLを入力してください")

if __name__ == '__main__':
    main()
