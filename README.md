# Image Server
このサーバーコードは、`puk06/PicDrop`を使用した画像アップロードに使用できるサーバーを立てるためのコードです。

# 初回起動手順
1. `.env`ファイルを作成し、APIキーを作って入力する。
2. `npm i`でライブラリをインストール
3. `node ImageServer.js`で起動

# 通常時の起動手順
1. `node ImageServer.js`で起動するだけです。

# ライセンス
ライブラリのライセンスは[THIRD_PARTY_LICENSES](https://github.com/puk06/Image-Server/blob/main/THIRD_PARTY_LICENSES)を御覧ください

サーバーコードのライセンスは[LICENSE](https://github.com/puk06/Image-Server/blob/main/LICENSE)を御覧ください

# 主な機能

- **画像のアップロード・閲覧**
  - JPEG / PNG  形式に対応
  - アップロードされた画像は一意のURLで即時共有可能
  - アップロードされた画像は8日後に自動削除 (※本フォークでの変更)

- **自動リサイズ**
  - 幅または高さが 2024px を超える画像は、自動的に縮小され保存されます

- **APIキーによるアクセス制御**(※本フォークでの変更)
  - 複数APIキーを発行

- **トライアルAPI機能**(※本フォークでの変更)
  - `TRIAL=true` の環境下で有効化
  - トライアルAPIキーの使用回数を日別に制限し、自動カウント
  - MySQLを使用した日次の使用回数管理に対応

TRIAL DB構造
```
CREATE TABLE trial_usage (
  usage_date DATE PRIMARY KEY,
  usage_count INT NOT NULL DEFAULT 0
);
```