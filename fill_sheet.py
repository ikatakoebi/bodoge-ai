"""既に作成済みのスプレッドシートにデータを書き込む"""
import csv
import os
import google.auth
from googleapiclient.discovery import build

SPREADSHEET_ID = '1gSmBMs2MuG5pay4p-RIOb8KNftSmmWQ0azj-NARdYNc'

def get_credentials():
    creds, project = google.auth.default(
        scopes=[
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file',
        ]
    )
    return creds

def read_csv(filepath):
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        for row in reader:
            rows.append(row)
    return rows

def main():
    creds = get_credentials()
    service = build('sheets', 'v4', credentials=creds)

    base_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hagetaka-sheets')

    sheets_data = {
        'cards': read_csv(os.path.join(base_path, 'cards.csv')),
        'templates': read_csv(os.path.join(base_path, 'templates.csv')),
        'areas': read_csv(os.path.join(base_path, 'areas.csv')),
        'counters': read_csv(os.path.join(base_path, 'counters.csv')),
        'setup': read_csv(os.path.join(base_path, 'setup.csv')),
    }

    # 全シートをクリア
    for sheet_name in sheets_data:
        service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{sheet_name}!A:Z',
        ).execute()
    print("全シートクリア完了")

    batch_data = []
    for sheet_name, rows in sheets_data.items():
        if rows:
            batch_data.append({
                'range': f'{sheet_name}!A1',
                'values': rows,
            })

    service.spreadsheets().values().batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={
            'valueInputOption': 'RAW',
            'data': batch_data,
        }
    ).execute()
    print("全シートにデータ書き込み完了!")

    # 共有設定（Sheets APIで公開）
    try:
        drive_service = build('drive', 'v3', credentials=creds)
        drive_service.permissions().create(
            fileId=SPREADSHEET_ID,
            body={
                'type': 'anyone',
                'role': 'reader',
            }
        ).execute()
        print("共有設定完了")
    except Exception as e:
        print(f"共有設定はGUIで行ってください: {e}")
    print(f"\nURL: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit")

if __name__ == '__main__':
    main()
