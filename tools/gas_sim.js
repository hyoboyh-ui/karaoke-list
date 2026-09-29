// gas/Code.gs を Google の部品をまねた環境で丸ごと動かして確かめる（node tools/gas_sim.js）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.log('NG: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
}

// ---------------- スプレッドシートのまね ----------------
// 文字列の日付（2026-09-29 等）は、書式なしテキストでない列では Date に化ける（本物と同じ罠）
function makeSheet(initialRows) {
  const data = initialRows.map((r) => r.slice());
  const textCols = new Set();
  const sheet = {
    data,
    textCols,
    frozen: 0,
    getLastRow() {
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i].some((v) => v !== '' && v != null)) return i + 1;
      }
      return 0;
    },
    setFrozenRows(n) { this.frozen = n; },
    setColumnWidth() {},
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z]):([A-Z])$/);
        const c0 = m[1].charCodeAt(0) - 64;
        return makeRange(1, c0, Math.max(data.length, 1), m[2].charCodeAt(0) - 64 - c0 + 1, true);
      }
      return makeRange(a, b, c || 1, d || 1, false);
    },
  };
  function rowAt(r, c) {
    while (data.length < r) data.push([]);
    const row = data[r - 1];
    while (row.length < c) row.push('');
    return row;
  }
  function convert(v, col) {
    if (typeof v === 'string' && !textCols.has(col) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, dd] = v.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, dd) - 9 * 3600 * 1000); // 東京の0時
    }
    if (typeof v === 'string' && !textCols.has(col) && /^-?\d+$/.test(v)) return Number(v);
    return v;
  }
  function makeRange(r0, c0, nr, nc, wholeCols) {
    const range = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = data[r0 - 1 + i] || [];
          const row = [];
          for (let j = 0; j < nc; j++) row.push(src[c0 - 1 + j] !== undefined ? src[c0 - 1 + j] : '');
          out.push(row);
        }
        return out;
      },
      setValues(values) {
        if (values.length !== nr || values.some((row) => row.length !== nc)) {
          throw new Error('setValues size mismatch ' + nr + 'x' + nc);
        }
        values.forEach((row, i) => row.forEach((v, j) => {
          rowAt(r0 + i, c0 + j)[c0 - 1 + j] = convert(v, c0 + j);
        }));
        return range;
      },
      clearContent() {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) rowAt(r0 + i, c0 + j)[c0 - 1 + j] = '';
        return range;
      },
      setNumberFormat(fmt) {
        if (wholeCols && fmt === '@') for (let j = 0; j < nc; j++) textCols.add(c0 + j);
        return range;
      },
      setBackground() { return range; },
      setFontColor() { return range; },
      setFontWeight() { return range; },
    };
    return range;
  }
  return sheet;
}

function makeEnv(sheetRows) {
  const sheets = {};
  if (sheetRows) sheets['曲リスト'] = makeSheet(sheetRows);
  const props = {};
  const env = {
    sheets,
    props,
    SpreadsheetApp: {
      getActive() {
        return {
          getSheetByName(n) { return sheets[n] || null; },
          insertSheet(n) { sheets[n] = makeSheet([]); return sheets[n]; },
        };
      },
      flush() {},
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty(k, v) { props[k] = String(v); },
          setProperties(o) { Object.keys(o).forEach((k) => { props[k] = String(o[k]); }); },
          deleteProperty(k) { delete props[k]; },
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest(alg, text) {
        return Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b));
      },
      getUuid() { return crypto.randomUUID(); },
      formatDate(d, tz, fmt) {
        if (fmt !== 'yyyy-MM-dd') throw new Error('fmt ' + fmt);
        const t = new Date(d.getTime() + 9 * 3600 * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
      },
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(s) { return { content: s, setMimeType() { return this; } }; },
    },
    Logger: { log() {} },
  };
  vm.createContext(env);
  vm.runInContext(code, env);
  return env;
}

function call(env, body) {
  return JSON.parse(env.doPost({ postData: { contents: JSON.stringify(body) } }).content);
}

// 外の世界で作った Date（doPost の中で instanceof Date が効かない状況を再現）
const outerDate = (y, m, d, hh = 0) => new Date(Date.UTC(y, m - 1, d, hh) - 9 * 3600 * 1000);

function oldSheet() {
  return [
    ['ID', '曲名', '歌手名', 'フリガナ', 'ジャンル', 'キー', '最終タップ日', '登録日'],
    ['a1', '夜に駆ける', 'YOASOBI', 'ヨアソビ', 'JPOP', -3, outerDate(2026, 8, 7), outerDate(2026, 8, 7, 19)],
    ['a2', 'YONA YONA DANCE', '和田アキ子', 'わだあきこ', 'JPOP', 0, '', outerDate(2026, 8, 7, 21)],
    ['a3', '津軽海峡・冬景色', '石川さゆり', '', '演歌', 5, '', outerDate(2026, 8, 28, 21)],
  ];
}

// ---------------- 準備（setup） ----------------
{
  const env = makeEnv(oldSheet());
  let threw = false;
  try { env.setup(); } catch (e) { threw = /SETUP_PASSWORD/.test(e.message); }
  check('パスワード未設定で setup するとエラーで止まる', threw);
  check('そのときシートには手を付けない', env.sheets['曲リスト'].data[0].length === 8);

  env.props.SETUP_PASSWORD = 'utau-2026';
  env.setup();
  const ws = env.sheets['曲リスト'];
  check('見出しが9列になる', JSON.stringify(ws.data[0]) === JSON.stringify(['ID', '曲名', '歌手名', 'フリガナ', 'ジャンル', 'キー', '最終タップ日', '登録日', '更新日時']), ws.data[0]);
  check('ひらがなのフリガナがカタカナになる', ws.data[2][3] === 'ワダアキコ', ws.data[2][3]);
  check('既存データの他の列は変わらない', ws.data[1][1] === '夜に駆ける' && ws.data[1][5] === -3);
  check('SETUP_PASSWORD は消える', !('SETUP_PASSWORD' in env.props));
  check('パスワードそのものは保存されない', !Object.values(env.props).includes('utau-2026'));
  check('曲名などの列が書式なしテキストになる', [2, 3, 4, 5].every((c) => ws.textCols.has(c)));

  env.setup();
  check('setup を2回実行しても壊れない', ws.data.length === 4 && ws.data[0].length === 9);
}

// ---------------- ログイン ----------------
const env = makeEnv(oldSheet());
env.props.SETUP_PASSWORD = 'utau-2026';
env.setup();

check('知らない命令は unknown_action', call(env, { action: 'hack' }).error === 'unknown_action');
check('doGet は存在しない（URLを開いただけでは何も読めない）', typeof env.doGet === 'undefined');
check('トークンなしの同期は unauthorized', call(env, { action: 'sync', changes: [] }).error === 'unauthorized');
check('でたらめなトークンは unauthorized', call(env, { action: 'sync', token: 'x', changes: [] }).error === 'unauthorized');
check('違うパスワードは wrong_password', call(env, { action: 'login', password: 'nope' }).error === 'wrong_password');

for (let i = 0; i < 3; i++) call(env, { action: 'login', password: 'nope' });
check('5回間違えるとロック', call(env, { action: 'login', password: 'nope' }).error === 'locked');
check('ロック中は正しいパスワードでも入れない', call(env, { action: 'login', password: 'utau-2026' }).error === 'locked');
env.resetLoginLock();
const loginRes = call(env, { action: 'login', password: 'utau-2026' });
check('正しいパスワードでトークンがもらえる', typeof loginRes.token === 'string' && loginRes.token.length > 40, loginRes);
const token = loginRes.token;
check('トークンはハッシュで保存される（生のまま残らない）', !env.props.TOKENS.includes(token));

// ---------------- 同期 ----------------
function sync(changes) { return call(env, { action: 'sync', token, changes }); }
const ws = env.sheets['曲リスト'];
const byId = (res, id) => res.songs.find((s) => s.id === id);

let res = sync([]);
check('空の同期で3曲が返る', res.songs.length === 3, res.songs.length);
check('日付は yyyy-MM-dd の文字列で返る', byId(res, 'a1').lastSungAt === '2026-08-07', byId(res, 'a1'));
check('登録日も文字列で返る', byId(res, 'a1').createdAt === '2026-08-07');
check('未タップは空文字', byId(res, 'a3').lastSungAt === '');
check('旧データの更新日時は0扱い', byId(res, 'a1').updatedAt === 0);
check('キーは数字で返る', byId(res, 'a1').key === -3);

res = sync([{ id: 'n1', title: '怪獣', singer: 'サカナクション', furigana: 'さかなくしょん', genre: '', key: 2, lastSungAt: '2026-09-29', updatedAt: 1000 }]);
check('新しい曲が追加される', !!byId(res, 'n1') && ws.getLastRow() === 5);
check('追加した曲の歌った日が保存される', byId(res, 'n1').lastSungAt === '2026-09-29', byId(res, 'n1'));
check('追加時にフリガナがカタカナになる', byId(res, 'n1').furigana === 'サカナクション');
check('追加した曲に登録日が付く', /^\d{4}-\d{2}-\d{2}$/.test(byId(res, 'n1').createdAt));
check('ジャンルなしで追加できる', byId(res, 'n1').genre === '');
check('更新日時はシート上では読める日時として保存される', Object.prototype.toString.call(ws.data.find((r) => r[0] === 'n1')[8]) === '[object Date]');
check('更新日時は画面側にはミリ秒の数字で返る', byId(res, 'n1').updatedAt === 1000, byId(res, 'n1').updatedAt);

res = sync([{ id: 'n1', title: '怪獣', singer: 'サカナクション', furigana: 'サカナクション', genre: '', key: 2, lastSungAt: '2026-09-29', updatedAt: 1000 }]);
check('同じ追加を2回送っても1行のまま（電波切れの再送対策）', ws.getLastRow() === 5 && res.rejected.length === 0);

res = sync([{ id: 'n2', title: ' 夜に駆ける ', singer: 'ｙｏａｓｏｂｉ', key: 0, updatedAt: 1001 }]);
check('空白・全角・大小文字の違いだけの重複は追加されない', ws.getLastRow() === 5 && !byId(res, 'n2'));
check('重複は rejected で理由付きで返る', res.rejected.length === 1 && res.rejected[0].reason === 'duplicate' && res.rejected[0].title === '夜に駆ける', res.rejected);

res = sync([{ id: 'n9', title: '怪獣', singer: 'さかなくしょん', key: 0, updatedAt: 1002 }]);
check('ひらがなとカタカナの違いだけの重複も追加されない', !byId(res, 'n9') && res.rejected[0].reason === 'duplicate');

res = sync([{ id: 'n3', title: 'よるにかける', singer: 'よあそび', key: 0, updatedAt: 1003 }]);
check('漢字とかな書きは別の曲として扱う', !!byId(res, 'n3'));
res = sync([{ id: 'n3', deleted: true, updatedAt: 1004 }]);
check('削除が反映される', !byId(res, 'n3') && ws.getLastRow() === 5);
check('削除後に空いた行が残らない', ws.data.slice(1, 5).every((r) => r[0] !== ''));

res = sync([{ id: 'a3', title: '津軽海峡・冬景色', singer: '石川さゆり', furigana: 'イシカワサユリ', genre: '演歌', key: 4, lastSungAt: '', updatedAt: 2000 }]);
check('新しい変更で既存の曲が更新される', byId(res, 'a3').key === 4 && byId(res, 'a3').furigana === 'イシカワサユリ');
check('更新しても登録日は変わらない', byId(res, 'a3').createdAt === '2026-08-28');

res = sync([{ id: 'a3', title: '津軽海峡・冬景色', singer: '石川さゆり', furigana: 'イシカワサユリ', genre: '演歌', key: -6, lastSungAt: '', updatedAt: 1500 }]);
check('古い変更は無視される（後から書いた方が勝つ）', byId(res, 'a3').key === 4);

res = sync([{ id: 'a3', title: '夜に駆ける', singer: 'YOASOBI', key: 4, updatedAt: 3000 }]);
check('他の曲と同じ名前への変更は弾かれる', byId(res, 'a3').title === '津軽海峡・冬景色' && res.rejected[0].reason === 'duplicate');

res = sync([
  { id: 'a1', deleted: true, updatedAt: 4000 },
  { id: 'n4', title: '夜に駆ける', singer: 'YOASOBI', key: 1, updatedAt: 4001 },
]);
check('同じ送信の中で消した曲と同じ名前なら追加できる', !byId(res, 'a1') && !!byId(res, 'n4'));

res = sync([{ id: 'a1', title: '夜に駆ける', singer: 'YOASOBI', key: 0, updatedAt: 100 }]);
check('削除済みの曲に古い変更が届いても重複は作られない', res.songs.filter((s) => s.title === '夜に駆ける').length === 1);

res = sync([{ id: 'n5', title: '1984', singer: 'x', key: 9, genre: 'ロック', lastSungAt: 'きのう', updatedAt: 5000 }]);
const n5 = byId(res, 'n5');
check('キーは±6に収まる', n5.key === 6, n5);
check('知らないジャンルは空になる', n5.genre === '');
check('変な日付は空になる', n5.lastSungAt === '');
check('数字だけの曲名も文字のまま保存される', n5.title === '1984' && typeof ws.data.find((r) => r[0] === 'n5')[1] === 'string');

res = sync([{ id: 'n6', title: '', singer: 'x', updatedAt: 6000 }, { id: 'n7', title: 'y', singer: '  ', updatedAt: 6001 }]);
check('曲名や歌手が空の曲は保存されない', !byId(res, 'n6') && !byId(res, 'n7') && res.rejected.filter((r) => r.reason === 'invalid').length === 2);

res = sync([{ id: 'n8', title: 'あ'.repeat(500), singer: 'z', updatedAt: 7000 }]);
check('長すぎる文字は200文字で切る', byId(res, 'n8').title.length === 200);

check('changes が配列でなくても落ちない', Array.isArray(call(env, { action: 'sync', token, changes: 'nope' }).songs));
const broken = env.doPost({ postData: { contents: '{oops' } });
check('JSON が壊れていても落ちずにエラーを返す', !!JSON.parse(broken.content).error);

console.log(`${passed}項目OK / ${failed}項目NG`);
process.exit(failed ? 1 : 0);
