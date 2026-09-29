// ============================================================
// カラオケリスト - Google Apps Script バックエンド
// ============================================================
//
// 画面は GitHub Pages に置いてあり、ここは保存係（スプレッドシートの読み書き）だけを担当する。
// 「カラオケリスト」スプレッドシートに紐づいたスクリプトとして動かす前提。
//
// 初回の準備（手順の詳細は SETUP.md）:
//   1. プロジェクトの設定 → スクリプト プロパティに SETUP_PASSWORD = パスワード を追加
//   2. エディタで setup を実行（シートの列追加・フリガナ整理・パスワード設定をまとめて行う）

const SHEET_NAME = '曲リスト';
const HEADERS = ['ID', '曲名', '歌手名', 'フリガナ', 'ジャンル', 'キー', '最終タップ日', '登録日', '更新日時'];
const COL = { id: 0, title: 1, singer: 2, furigana: 3, genre: 4, key: 5, lastSungAt: 6, createdAt: 7, updatedAt: 8 };
const GENRES = ['JPOP', '演歌', '中国歌謡', 'ボカロ', 'アニソン', 'キッズ', '洋楽', '懐メロ'];
const TZ = 'Asia/Tokyo';
const MAX_TEXT = 200;

function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  let ws = ss.getSheetByName(SHEET_NAME);
  if (!ws) {
    ws = ss.insertSheet(SHEET_NAME);
    ws.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    ws.setFrozenRows(1);
  }
  return ws;
}

/** 初回に1回だけエディタから実行する。何度実行しても壊れない。 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_SETUP) && !props.getProperty(PROP_HASH)) {
    throw new Error('スクリプト プロパティに SETUP_PASSWORD を追加してから実行してください。');
  }
  upgradeSheet_();
  if (props.getProperty(PROP_SETUP)) setupPassword();
  Logger.log('準備が完了しました。');
}

/** 旧版（8列）のシートに「更新日時」列を足し、フリガナをカタカナに揃える。 */
function upgradeSheet_() {
  const ws = getSheet_();
  ws.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  ws.getRange(1, HEADERS.length).setBackground('#C4B5FD').setFontColor('#3B0764').setFontWeight('bold');
  ws.setFrozenRows(1);
  // 曲名などが数字や日付っぽい文字（例: 1984、1/2）でも勝手に変換されないよう、文字の列は「書式なしテキスト」にする
  ws.getRange('B:E').setNumberFormat('@');
  ws.getRange('I:I').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  ws.setColumnWidth(HEADERS.length, 150);

  const lastRow = ws.getLastRow();
  if (lastRow < 2) return;
  const range = ws.getRange(2, COL.furigana + 1, lastRow - 1, 1);
  const values = range.getValues().map(function (r) { return [toKatakana_(String(r[0] || ''))]; });
  range.setValues(values);
}

// ============================================================
// 認証（出勤カレンダーと同じ方式）
// ============================================================
//
// 画面のコードは公開されているので、秘密は画面側に一切置かない。
// 鍵は本人が覚えるパスワードだけで、スクリプトプロパティにはそのハッシュだけを保存する。
// ログインに成功した端末にはトークンを発行し、以降の同期はトークンで認証する。

const PWD_ITERATIONS = 2000;
const MAX_TOKENS = 10;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const PROP_SALT = 'PWD_SALT';
const PROP_HASH = 'PWD_HASH';
const PROP_TOKENS = 'TOKENS';
const PROP_FAILS = 'LOGIN_FAILS';
const PROP_LOCKED_UNTIL = 'LOGIN_LOCKED_UNTIL';
const PROP_SETUP = 'SETUP_PASSWORD';

function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sha256Hex_(text) {
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

function hashPassword_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < PWD_ITERATIONS; i++) h = sha256Hex_(salt + h);
  return h;
}

/** パスワードの変更。実行すると全端末がログアウトされる。 */
function setupPassword() {
  const props = PropertiesService.getScriptProperties();
  const password = props.getProperty(PROP_SETUP);
  if (!password) {
    throw new Error('スクリプト プロパティに SETUP_PASSWORD を追加してから実行してください。');
  }
  const salt = Utilities.getUuid();
  const next = {};
  next[PROP_SALT] = salt;
  next[PROP_HASH] = hashPassword_(password, salt);
  next[PROP_TOKENS] = '[]';
  next[PROP_FAILS] = '0';
  next[PROP_LOCKED_UNTIL] = '0';
  props.setProperties(next);
  props.deleteProperty(PROP_SETUP);
  Logger.log('パスワードを設定しました。全端末がログアウトされています。');
}

/** 締め出されたときにエディタから実行して、ログイン失敗の回数をリセットする。 */
function resetLoginLock() {
  const next = {};
  next[PROP_FAILS] = '0';
  next[PROP_LOCKED_UNTIL] = '0';
  PropertiesService.getScriptProperties().setProperties(next);
  Logger.log('ログインのロックを解除しました。');
}

function readTokens_(props) {
  try {
    return JSON.parse(props.getProperty(PROP_TOKENS) || '[]');
  } catch (e) {
    return [];
  }
}

function login_(password) {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty(PROP_SALT);
  const hash = props.getProperty(PROP_HASH);
  if (!salt || !hash) return { error: 'not_configured' };

  const lockedUntil = Number(props.getProperty(PROP_LOCKED_UNTIL)) || 0;
  if (Date.now() < lockedUntil) return { error: 'locked' };

  if (typeof password !== 'string' || hashPassword_(password, salt) !== hash) {
    const fails = (Number(props.getProperty(PROP_FAILS)) || 0) + 1;
    const next = {};
    if (fails >= MAX_FAILED_LOGINS) {
      next[PROP_FAILS] = '0';
      next[PROP_LOCKED_UNTIL] = String(Date.now() + LOGIN_LOCK_MS);
      props.setProperties(next);
      return { error: 'locked' };
    }
    props.setProperty(PROP_FAILS, String(fails));
    return { error: 'wrong_password' };
  }

  const token = Utilities.getUuid() + Utilities.getUuid();
  const tokens = readTokens_(props);
  tokens.push(sha256Hex_(token));
  const next = {};
  next[PROP_TOKENS] = JSON.stringify(tokens.slice(-MAX_TOKENS));
  next[PROP_FAILS] = '0';
  props.setProperties(next);
  return { token: token };
}

function isValidToken_(token) {
  if (typeof token !== 'string' || !token) return false;
  const tokens = readTokens_(PropertiesService.getScriptProperties());
  return tokens.indexOf(sha256Hex_(token)) !== -1;
}

// ============================================================
// エントリポイント
// ============================================================
//
// doGet は置かない（URLをブラウザで開いただけでデータが読めてしまうため）。

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 同時に来た同期が互いの書き込みを上書きしないよう、1件ずつ順番に処理する
    lock.waitLock(20000);
    const data = JSON.parse(e.postData.contents);
    let result;
    switch (data.action) {
      case 'login':
        result = login_(data.password);
        break;
      case 'sync':
        result = isValidToken_(data.token) ? syncSongs_(data.changes) : { error: 'unauthorized' };
        break;
      default:
        result = { error: 'unknown_action' };
    }
    return json_(result);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 同期（Last-Write-Wins）
// ============================================================
//
// changes: [{ id, title, singer, furigana, genre, key, lastSungAt, updatedAt, deleted? }, ...]
// 曲ごとに、シート側の更新日時より新しい変更だけを反映する。
// 「歌手＋曲名」が別の曲と重複する追加・変更は反映せず rejected で返す。
// 戻り値は常にシート全体の最新状態（画面側はこれで丸ごと置き換える）。

function syncSongs_(changes) {
  const ws = getSheet_();
  const lastRow = ws.getLastRow();
  const originalCount = lastRow > 1 ? lastRow - 1 : 0;
  let rows = originalCount > 0 ? ws.getRange(2, 1, originalCount, HEADERS.length).getValues() : [];
  rows = rows.filter(function (r) { return String(r[COL.id]).trim() !== ''; });

  const indexById = {};
  rows.forEach(function (r, i) { indexById[String(r[COL.id])] = i; });

  const rejected = [];
  const deletedIds = {};
  let changed = rows.length !== originalCount;

  (Array.isArray(changes) ? changes : []).forEach(function (c) {
    if (!c || typeof c.id !== 'string' || !c.id) return;
    const incomingAt = Number(c.updatedAt) || 0;
    const idx = indexById[c.id];

    if (c.deleted) {
      if (idx !== undefined && incomingAt >= toMillis_(rows[idx][COL.updatedAt])) {
        deletedIds[c.id] = true;
        changed = true;
      }
      return;
    }

    const song = sanitize_(c);
    if (!song) {
      rejected.push({ id: c.id, reason: 'invalid' });
      return;
    }
    if (idx !== undefined && incomingAt <= toMillis_(rows[idx][COL.updatedAt])) return;
    if (hasDuplicate_(rows, song, c.id, deletedIds)) {
      rejected.push({ id: c.id, reason: 'duplicate', title: song.title, singer: song.singer });
      return;
    }

    if (idx !== undefined) {
      rows[idx] = toRow_(c.id, song, rows[idx][COL.createdAt], incomingAt);
    } else {
      rows.push(toRow_(c.id, song, new Date(), incomingAt));
      indexById[c.id] = rows.length - 1;
    }
    changed = true;
  });

  if (changed) {
    const kept = rows.filter(function (r) { return !deletedIds[String(r[COL.id])]; });
    if (kept.length > 0) ws.getRange(2, 1, kept.length, HEADERS.length).setValues(kept);
    const leftover = originalCount - kept.length;
    if (leftover > 0) ws.getRange(2 + kept.length, 1, leftover, HEADERS.length).clearContent();
    SpreadsheetApp.flush();
    rows = kept;
  }

  return { songs: rows.map(rowToSong_), rejected: rejected };
}

function hasDuplicate_(rows, song, selfId, deletedIds) {
  const key = normalize_(song.title) + '\u0000' + normalize_(song.singer);
  return rows.some(function (r) {
    const id = String(r[COL.id]);
    if (id === selfId || deletedIds[id]) return false;
    return normalize_(r[COL.title]) + '\u0000' + normalize_(r[COL.singer]) === key;
  });
}

function sanitize_(c) {
  const title = cleanText_(c.title);
  const singer = cleanText_(c.singer);
  if (!title || !singer) return null;
  const key = Math.round(Number(c.key) || 0);
  return {
    title: title,
    singer: singer,
    furigana: toKatakana_(cleanText_(c.furigana)),
    genre: GENRES.indexOf(c.genre) !== -1 ? c.genre : '',
    key: Math.max(-6, Math.min(6, key)),
    lastSungAt: /^\d{4}-\d{2}-\d{2}$/.test(String(c.lastSungAt || '')) ? String(c.lastSungAt) : '',
  };
}

function cleanText_(v) {
  return String(v == null ? '' : v).trim().slice(0, MAX_TEXT);
}

// 更新日時はシートを開いたときに読めるよう日時として保存し、読み出すときにミリ秒の数字へ戻す
function toRow_(id, song, createdAt, updatedAt) {
  const stamp = updatedAt > 0 ? new Date(updatedAt) : '';
  return [id, song.title, song.singer, song.furigana, song.genre, song.key, song.lastSungAt, createdAt, stamp];
}

function toMillis_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  return Number(v) || 0;
}

function rowToSong_(r) {
  return {
    id: String(r[COL.id]),
    title: String(r[COL.title]),
    singer: String(r[COL.singer]),
    furigana: toKatakana_(String(r[COL.furigana] || '')),
    genre: GENRES.indexOf(String(r[COL.genre])) !== -1 ? String(r[COL.genre]) : '',
    key: Number(r[COL.key]) || 0,
    lastSungAt: toDateString_(r[COL.lastSungAt]),
    createdAt: toDateString_(r[COL.createdAt]),
    updatedAt: toMillis_(r[COL.updatedAt]),
  };
}

// スプレッドシートは "2026-09-29" のような文字列を自動で日付に変換するので、読み出し時は必ず文字列に戻す。
// doPost の中では `instanceof Date` が効かないことがあるため、Object.prototype.toString で判定する。
function toDateString_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  const m = String(v || '').match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/** 表記ゆれ（前後空白・全角半角・大文字小文字・ひらがなカタカナ）を無視して比べるための形 */
function normalize_(v) {
  return toKatakana_(String(v == null ? '' : v).normalize('NFKC').toLowerCase().replace(/\s+/g, ''));
}

function toKatakana_(s) {
  return String(s).replace(/[ぁ-ゖ]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) + 0x60);
  });
}
