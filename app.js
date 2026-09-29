(function () {
  'use strict';

  // ============================================================
  // 設定
  // ============================================================
  var LS = {
    songs: 'karaoke:songs:v1', // 端末に覚えておく曲一覧（開いた瞬間に表示するため）
    pending: 'karaoke:pending:v1', // まだスプレッドシートに届いていない変更
    token: 'karaoke:token:v1',
  };
  var UNSUNG_DAYS = 182; // 約半年
  var PICK_COUNT = 10;
  var RECENT_COUNT = 5;
  var GENRES = ['JPOP', '演歌', '中国歌謡', 'ボカロ', 'アニソン', 'キッズ', '洋楽', '懐メロ'];
  var GENRE_COLORS = {
    'JPOP': { bg: '#EDE9FE', text: '#5B21B6' },
    '演歌': { bg: '#FCE7F3', text: '#9D174D' },
    '中国歌謡': { bg: '#FEE2E2', text: '#B91C1C' },
    'ボカロ': { bg: '#CFFAFE', text: '#0E7490' },
    'アニソン': { bg: '#ECFCCB', text: '#3F6212' },
    'キッズ': { bg: '#FEF9C3', text: '#854D0E' },
    '洋楽': { bg: '#DBEAFE', text: '#1D4ED8' },
    '懐メロ': { bg: '#FFEDD5', text: '#9A3412' },
  };

  function $(id) { return document.getElementById(id); }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 保存できない環境でも画面は動かす */ }
  }

  function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  var songs = asObject(load(LS.songs, {}));
  var pending = asObject(load(LS.pending, {}));
  var token = String(load(LS.token, '') || '');

  var syncState = { running: false, again: false, error: '', timer: null, loaded: false };
  var picks = null; // 「しばらく歌ってない曲」に出す曲のID。再抽選するまで並びを固定する
  var showAll = false;

  // ============================================================
  // 小道具
  // ============================================================
  function gasUrl() { return (window.KARAOKE_CONFIG && window.KARAOKE_CONFIG.GAS_URL) || ''; }

  function toKatakana(s) {
    return String(s == null ? '' : s).replace(/[ぁ-ゖ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
  }

  /** 表記ゆれ（前後空白・全角半角・大文字小文字・ひらがなカタカナ）を無視して比べるための形。GAS側と同じ規則 */
  function normalize(v) {
    return toKatakana(String(v == null ? '' : v).normalize('NFKC').toLowerCase().replace(/\s+/g, ''));
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    var p = String(dateStr).split('-');
    var then = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((now - then) / 86400000);
  }

  function agoLabel(dateStr) {
    if (!dateStr) return 'まだ歌ってない';
    var d = daysSince(dateStr);
    if (d <= 0) return '今日';
    if (d === 1) return '昨日';
    if (d < 30) return d + '日前';
    if (d < 365) return Math.floor(d / 30) + 'ヶ月前';
    return Math.floor(d / 365) + '年前';
  }

  function formatKey(k) {
    k = Number(k) || 0;
    return k > 0 ? '+' + k : k < 0 ? String(k) : '±0';
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  var collator = new Intl.Collator('ja');
  function bySinger(a, b) {
    return collator.compare(a.furigana || a.singer, b.furigana || b.singer) || collator.compare(a.title, b.title);
  }

  function allSongs() { return Object.keys(songs).map(function (id) { return songs[id]; }); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /** 登録済みの歌手（同じ人は1つにまとめる）。曲数とフリガナ付き */
  function singerList() {
    var map = {};
    allSongs().forEach(function (s) {
      var k = normalize(s.singer);
      if (!map[k]) map[k] = { name: s.singer, furigana: '', count: 0 };
      map[k].count++;
      if (!map[k].furigana && s.furigana) map[k].furigana = s.furigana;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function findSinger(name) {
    var k = normalize(name);
    return singerList().filter(function (x) { return normalize(x.name) === k; })[0] || null;
  }

  function findDuplicate(title, singer, exceptId) {
    var key = normalize(title) + '\u0000' + normalize(singer);
    return allSongs().filter(function (s) {
      return s.id !== exceptId && normalize(s.title) + '\u0000' + normalize(s.singer) === key;
    })[0] || null;
  }

  // ============================================================
  // 変更：まず端末に保存し、そのあとスプレッドシートへ送る
  // ============================================================
  function persist() {
    save(LS.songs, songs);
    save(LS.pending, pending);
  }

  function putSongs(list) {
    list.forEach(function (song) {
      var prev = songs[song.id];
      song.updatedAt = Math.max(Date.now(), (prev && prev.updatedAt || 0) + 1);
      songs[song.id] = song;
      pending[song.id] = clone(song);
    });
    persist();
    render();
    scheduleSync();
  }

  function removeSong(id) {
    var s = songs[id];
    if (!s) return;
    delete songs[id];
    pending[id] = { id: id, deleted: true, updatedAt: Math.max(Date.now(), (s.updatedAt || 0) + 1) };
    persist();
    render();
    scheduleSync();
  }

  // ============================================================
  // スプレッドシートとの同期
  // ============================================================
  function post(body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 25000) : null;
    return fetch(gasUrl(), {
      method: 'POST',
      // text/plain にすると、Google 側に余計な事前確認の通信が飛ばない
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('http_' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function scheduleSync(delay) {
    clearTimeout(syncState.timer);
    syncState.timer = setTimeout(sync, delay == null ? 800 : delay);
  }

  function sync() {
    if (!gasUrl() || !token) { renderStatus(); return; }
    if (syncState.running) { syncState.again = true; return; }
    syncState.running = true;
    renderStatus();

    var sentAt = {};
    var changes = Object.keys(pending).map(function (id) {
      sentAt[id] = pending[id].updatedAt;
      return pending[id];
    });

    post({ action: 'sync', token: token, changes: changes })
      .then(function (res) {
        if (res && res.error === 'unauthorized') {
          setToken('');
          syncState.error = '';
          return;
        }
        if (!res || res.error || !Array.isArray(res.songs)) throw new Error((res && res.error) || 'bad_response');

        // 送った変更のうち、送信中に書き換えられていないものは「届いた」扱いにする
        Object.keys(sentAt).forEach(function (id) {
          if (pending[id] && pending[id].updatedAt === sentAt[id]) delete pending[id];
        });
        var next = {};
        res.songs.forEach(function (s) { next[s.id] = s; });
        Object.keys(pending).forEach(function (id) {
          if (pending[id].deleted) delete next[id];
          else next[id] = pending[id];
        });
        songs = next;
        persist();
        syncState.error = '';

        var dup = (res.rejected || []).filter(function (r) { return r.reason === 'duplicate'; })[0];
        if (dup) showToast('「' + dup.title + '」は同じ曲がすでにあったので保存しませんでした');
        render();
      })
      .catch(function (err) {
        syncState.error = navigator.onLine === false ? 'offline' : 'error';
        if (window.console) console.warn('sync failed', err);
      })
      .then(function () {
        syncState.running = false;
        if (!syncState.loaded) {
          syncState.loaded = true;
          render(); // 「読み込み中…」を消す
        }
        renderStatus();
        if (syncState.again) {
          syncState.again = false;
          scheduleSync(0);
        }
      });
  }

  function setToken(t) {
    token = t;
    save(LS.token, t);
    renderStatus();
  }

  function renderStatus() {
    var n = Object.keys(pending).length;
    var text;
    var warn = false;
    if (!gasUrl()) { text = 'この端末だけに保存中'; warn = true; }
    else if (!token) { text = n ? '未保存 ' + n + '件' : 'ログイン前'; warn = true; }
    else if (syncState.running) text = '保存中…';
    else if (syncState.error === 'offline') { text = n ? '電波待ち ' + n + '件' : 'オフライン'; warn = n > 0; }
    else if (syncState.error) { text = n ? '未保存 ' + n + '件' : '更新できませんでした'; warn = true; }
    else text = n ? '未保存 ' + n + '件' : '保存済み';

    var status = $('syncStatus');
    status.textContent = text;
    status.classList.toggle('warn', warn);

    var band = $('loginBand');
    band.hidden = !gasUrl() || !!token;
    band.textContent = n
      ? 'タップしてログインすると、未保存の' + n + '件がスプレッドシートに保存されます'
      : 'タップしてログインすると、スプレッドシートの曲が表示されます';
  }

  // ============================================================
  // 一覧の表示
  // ============================================================
  function render() {
    var q = $('q').value.trim();
    $('clearQ').hidden = !q;
    var root = $('list');
    root.textContent = '';
    if (q) renderSearch(root, q);
    else renderHome(root);
  }

  function sectionHead(text, actionText, onAction) {
    var head = el('div', 'section-head');
    head.appendChild(el('span', null, text));
    if (actionText) head.appendChild(button('pill-btn', actionText, onAction));
    return head;
  }

  function renderHome(root) {
    var all = allSongs();
    if (!all.length) {
      var msg = gasUrl() && !token
        ? 'ログインすると、スプレッドシートに入っている曲が表示されます。'
        : gasUrl() && !syncState.loaded
          ? '読み込み中…'
          : syncState.error
            ? '曲を読み込めませんでした。\n電波を確認して、右上の表示をタップしてください。'
            : 'まだ曲がありません。\n下の＋から追加できます。';
      var empty = el('div', 'empty', msg);
      empty.style.whiteSpace = 'pre-line';
      root.appendChild(empty);
      return;
    }

    var candidates = all.filter(function (s) { return daysSince(s.lastSungAt) >= UNSUNG_DAYS; });
    topUpPicks(candidates);
    var pickSongs = picks.map(function (id) { return songs[id]; }).filter(Boolean);

    root.appendChild(sectionHead('しばらく歌ってない曲', candidates.length > 1 ? '再抽選' : null, function () {
      picks = shuffle(candidates.map(function (s) { return s.id; })).slice(0, PICK_COUNT);
      render();
    }));
    if (pickSongs.length) pickSongs.forEach(function (s) { root.appendChild(rowEl(s)); });
    else root.appendChild(el('p', 'note', '半年以上歌ってない曲はありません。'));

    var recent = all.filter(function (s) { return s.lastSungAt; }).sort(function (a, b) {
      return b.lastSungAt.localeCompare(a.lastSungAt) || (b.updatedAt || 0) - (a.updatedAt || 0);
    }).slice(0, RECENT_COUNT);
    if (recent.length) {
      root.appendChild(sectionHead('最近歌った曲'));
      recent.forEach(function (s) { root.appendChild(rowEl(s)); });
    }

    if (showAll) {
      root.appendChild(sectionHead('すべての曲（' + all.length + '曲）', 'たたむ', function () {
        showAll = false;
        render();
      }));
      all.sort(bySinger).forEach(function (s) { root.appendChild(rowEl(s)); });
    } else {
      root.appendChild(button('show-all', 'すべての曲を見る（' + all.length + '曲）', function () {
        showAll = true;
        render();
      }));
    }
  }

  /** おすすめ枠を最大10曲まで埋める（すでに出ている曲は並びを変えない） */
  function topUpPicks(candidates) {
    if (!picks) picks = [];
    picks = picks.filter(function (id) { return songs[id]; });
    if (picks.length >= PICK_COUNT) return;
    var rest = candidates.filter(function (s) { return picks.indexOf(s.id) === -1; }).map(function (s) { return s.id; });
    picks = picks.concat(shuffle(rest).slice(0, PICK_COUNT - picks.length));
  }

  function matches(s, nq) {
    return [s.title, s.singer, s.furigana, s.genre].some(function (v) { return normalize(v).indexOf(nq) !== -1; });
  }

  function renderSearch(root, q) {
    var nq = normalize(q);
    var hits = allSongs().filter(function (s) { return matches(s, nq); }).sort(bySinger);
    var prefill = queryPrefill(q, hits);

    if (hits.length) {
      root.appendChild(sectionHead(hits.length + '曲見つかりました'));
      hits.forEach(function (s) { root.appendChild(rowEl(s)); });
      var label = prefill.singer ? '＋ ' + prefill.singer + ' の曲を追加' : '見つからない？ ＋「' + q + '」を追加';
      root.appendChild(button('add-row small', label, function () { openSheet('add', null, prefill); }));
    } else {
      root.appendChild(el('p', 'note', 'まだ登録されていない曲です。'));
      root.appendChild(button('add-row', '＋「' + q + '」を追加', function () { openSheet('add', null, prefill); }));
    }
  }

  /** 検索語から追加フォームの下書きを作る。歌手名で探していたなら歌手欄に、そうでなければ曲名欄に入れる */
  function queryPrefill(q, hits) {
    var nq = normalize(q);
    var singers = {};
    hits.forEach(function (s) {
      if (normalize(s.singer).indexOf(nq) !== -1 || normalize(s.furigana).indexOf(nq) !== -1) singers[normalize(s.singer)] = s.singer;
    });
    var names = Object.keys(singers);
    if (names.length === 1) return { singer: singers[names[0]] };
    return { title: q };
  }

  function rowEl(song) {
    var row = el('div', 'row');
    var main = el('div', 'row-main');
    main.appendChild(el('p', 'row-title', song.title));
    var sub = el('p', 'row-sub');
    sub.appendChild(el('span', 'row-sub-text', song.singer + '・キー' + formatKey(song.key) + '・' + agoLabel(song.lastSungAt)));
    if (song.genre && GENRE_COLORS[song.genre]) {
      var badge = el('span', 'badge', song.genre);
      badge.style.background = GENRE_COLORS[song.genre].bg;
      badge.style.color = GENRE_COLORS[song.genre].text;
      sub.appendChild(badge);
    }
    main.appendChild(sub);
    row.appendChild(main);

    var done = song.lastSungAt === todayStr();
    var sung = button('sung' + (done ? ' done' : ''), done ? '今日\n済み' : '歌った', function () { markSung(song.id); });
    sung.style.whiteSpace = 'pre-line';
    sung.setAttribute('aria-label', done ? '今日歌った（記録済み）' : '「' + song.title + '」を歌った');
    row.appendChild(sung);

    var more = button('more', '⋮', function (e) {
      e.stopPropagation();
      openMenu(song.id, more);
    });
    more.setAttribute('aria-label', 'メニュー');
    row.appendChild(more);
    return row;
  }

  // ============================================================
  // 歌った！
  // ============================================================
  function markSung(id) {
    var s = songs[id];
    if (!s) return;
    var today = todayStr();
    if (s.lastSungAt === today) {
      showToast('今日の分は記録済みです');
      return;
    }
    var previous = s.lastSungAt || '';
    var next = clone(s);
    next.lastSungAt = today;
    putSongs([next]);
    showToast('「' + s.title + '」を歌った日を記録しました', '取り消す', function () {
      var cur = songs[id];
      if (!cur) return;
      var back = clone(cur);
      back.lastSungAt = previous;
      putSongs([back]);
    });
  }

  // ============================================================
  // ⋮ メニュー
  // ============================================================
  var menuEl = null;

  function openMenu(id, anchor) {
    closeMenu();
    menuEl = el('div', 'menu');
    menuEl.appendChild(button(null, '編集', function () {
      closeMenu();
      if (songs[id]) openSheet('edit', songs[id]);
    }));
    menuEl.appendChild(button('danger', '削除', function () {
      closeMenu();
      confirmDelete(id);
    }));
    document.body.appendChild(menuEl);

    var r = anchor.getBoundingClientRect();
    var h = menuEl.offsetHeight;
    var w = menuEl.offsetWidth;
    var roomBelow = window.innerHeight - r.bottom - $('bottombar').offsetHeight;
    menuEl.style.top = (roomBelow > h + 8 ? r.bottom + 4 : r.top - h - 4) + 'px';
    menuEl.style.left = Math.max(8, r.right - w) + 'px';
  }

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }

  function confirmDelete(id) {
    var s = songs[id];
    if (!s) return;
    if (!window.confirm('「' + s.title + '」（' + s.singer + '）を削除しますか？\nスプレッドシートからも消えます。')) return;
    removeSong(id);
    showToast('削除しました');
  }

  // ============================================================
  // 追加・編集シート
  // ============================================================
  var form = { mode: 'add', id: null, key: 0, genre: '', furiganaTouched: false, readingDraft: '', compBuf: '' };

  function openSheet(mode, song, prefill) {
    closeMenu();
    prefill = prefill || {};
    form.mode = mode;
    form.id = song ? song.id : null;
    form.key = song ? Number(song.key) || 0 : 0;
    form.genre = song ? song.genre || '' : '';
    form.furiganaTouched = !!(song && song.furigana);
    form.readingDraft = '';
    form.compBuf = '';

    $('sheetTitle').textContent = mode === 'edit' ? '曲を編集' : '曲を追加';
    $('fTitle').value = song ? song.title : prefill.title || '';
    $('fSinger').value = song ? song.singer : prefill.singer || '';
    $('fFurigana').value = song ? song.furigana || '' : '';
    $('sungTodayRow').hidden = mode === 'edit';
    $('fSungToday').checked = true;
    $('lastSungRow').hidden = mode !== 'edit';
    $('fLastSung').value = song ? song.lastSungAt || '' : '';
    $('sheetSubmit').textContent = mode === 'edit' ? '保存する' : '追加する';
    $('sheetContinue').hidden = mode === 'edit';
    hideFormError();
    renderKey();
    renderGenres();
    updateSingerUi();
    $('sheet').hidden = false;

    if (mode === 'add') {
      setTimeout(function () {
        var target = !$('fTitle').value ? $('fTitle') : !$('fSinger').value ? $('fSinger') : null;
        if (target) target.focus();
      }, 60);
    }
  }

  function closeSheet() {
    $('sheet').hidden = true;
  }

  function renderKey() {
    $('fKey').textContent = formatKey(form.key);
  }

  function renderGenres() {
    var box = $('genreChips');
    box.textContent = '';
    GENRES.forEach(function (g) {
      var on = form.genre === g;
      var chip = button('chip', g, function () {
        form.genre = on ? '' : g;
        renderGenres();
      });
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        chip.style.background = GENRE_COLORS[g].bg;
        chip.style.color = GENRE_COLORS[g].text;
        chip.style.borderColor = GENRE_COLORS[g].text;
      }
      box.appendChild(chip);
    });
  }

  function updateSingerUi() {
    var value = $('fSinger').value.trim();
    var nv = normalize(value);
    var exact = value ? findSinger(value) : null;
    var singers = singerList();
    var candidates = value
      ? singers.filter(function (x) {
        var n = normalize(x.name);
        return n !== nv && (n.indexOf(nv) !== -1 || normalize(x.furigana).indexOf(nv) !== -1);
      })
      : singers.sort(function (a, b) { return b.count - a.count; });

    var chips = $('singerChips');
    chips.textContent = '';
    candidates.slice(0, 6).forEach(function (x) {
      chips.appendChild(button('chip', x.name, function () {
        $('fSinger').value = x.name;
        $('fFurigana').value = x.furigana || '';
        form.furiganaTouched = !!x.furigana;
        form.readingDraft = '';
        updateSingerUi();
        if (!$('fTitle').value) $('fTitle').focus();
      }));
    });

    var isNew = !!value && !exact;
    $('furiganaField').hidden = !(form.mode === 'edit' || isNew);
    $('furiganaLabel').textContent = form.mode === 'edit'
      ? 'フリガナ（並び順に使います）'
      : '新しい歌手です。フリガナ（違っていたら直してください）';
  }

  function showFormError(text) {
    $('formError').textContent = text;
    $('formError').hidden = false;
  }

  function hideFormError() { $('formError').hidden = true; }

  function submitSheet(keepOpen) {
    var title = $('fTitle').value.trim();
    var singer = $('fSinger').value.trim();
    if (!title || !singer) {
      showFormError('曲名と歌手を入れてください');
      return;
    }
    if (form.mode === 'edit' && !songs[form.id]) {
      closeSheet();
      showToast('この曲は削除されていました');
      return;
    }

    var exact = findSinger(singer);
    if (form.mode === 'add' && exact) singer = exact.name; // 「yoasobi」と打っても登録済みの「YOASOBI」にそろえる

    var dup = findDuplicate(title, singer, form.id);
    if (dup) {
      showFormError('「' + dup.title + '」（' + dup.singer + '）はもう登録されています');
      return;
    }

    var furigana;
    if (form.mode === 'add' && exact) furigana = exact.furigana;
    else furigana = toKatakana($('fFurigana').value.trim());
    // 歌手名がかなだけなら、そのままフリガナにする
    if (!furigana && /^[ぁ-ヿー・\s]+$/.test(singer)) furigana = toKatakana(singer.replace(/\s+/g, ''));

    var song = form.mode === 'edit'
      ? clone(songs[form.id])
      : { id: uuid(), createdAt: todayStr(), updatedAt: 0 };
    song.title = title;
    song.singer = singer;
    song.furigana = furigana || '';
    song.genre = form.genre;
    song.key = form.key;
    song.lastSungAt = form.mode === 'add'
      ? ($('fSungToday').checked ? todayStr() : '')
      : $('fLastSung').value || '';

    var changed = [song];
    // 編集でフリガナを直したら、同じ歌手の他の曲もそろえる（並び順がばらけないように）
    if (form.mode === 'edit' && song.furigana) {
      allSongs().forEach(function (s) {
        if (s.id !== song.id && normalize(s.singer) === normalize(singer) && s.furigana !== song.furigana) {
          var fixed = clone(s);
          fixed.furigana = song.furigana;
          changed.push(fixed);
        }
      });
    }
    putSongs(changed);

    if (form.mode === 'add' && keepOpen) {
      $('fTitle').value = '';
      form.key = 0;
      renderKey();
      hideFormError();
      updateSingerUi();
      $('fTitle').focus();
      showToast('「' + title + '」を追加しました');
      return;
    }
    if (form.mode === 'add') {
      $('q').value = '';
      render();
    }
    closeSheet();
    showToast(form.mode === 'edit' ? '保存しました' : '「' + title + '」を追加しました');
  }

  // ============================================================
  // ログイン
  // ============================================================
  function openLogin() {
    if (!gasUrl()) return;
    $('loginError').hidden = true;
    $('loginPassword').value = '';
    $('loginModal').hidden = false;
    setTimeout(function () { $('loginPassword').focus(); }, 60);
  }

  function submitLogin() {
    var pw = $('loginPassword').value;
    if (!pw) return;
    var btn = $('loginSubmit');
    btn.disabled = true;
    btn.textContent = 'ログイン中…';
    $('loginError').hidden = true;
    post({ action: 'login', password: pw })
      .then(function (res) {
        if (res && res.token) {
          setToken(res.token);
          syncState.loaded = false;
          render(); // 読み込みが終わるまで「読み込み中…」を出す
          $('loginModal').hidden = true;
          showToast('ログインしました');
          scheduleSync(0);
          return;
        }
        var messages = {
          wrong_password: 'パスワードが違います',
          locked: '何度も間違えたので、15分ほど待ってからもう一度試してください',
          not_configured: 'まだパスワードが設定されていません（SETUP.md の手順を確認してください）',
        };
        showLoginError(messages[res && res.error] || 'ログインできませんでした（' + (res && res.error) + '）');
      })
      .catch(function () {
        showLoginError('通信できませんでした。電波を確認してもう一度試してください');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'ログイン';
      });
  }

  function showLoginError(text) {
    $('loginError').textContent = text;
    $('loginError').hidden = false;
  }

  // ============================================================
  // お知らせ（下から出る黒い帯）
  // ============================================================
  var toastTimer = null;

  function showToast(text, actionLabel, action) {
    $('toastText').textContent = text;
    var btn = $('toastAction');
    btn.hidden = !action;
    if (action) {
      btn.textContent = actionLabel;
      btn.onclick = function () {
        hideToast();
        action();
      };
    }
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
  }

  function hideToast() { $('toast').hidden = true; }

  // ============================================================
  // スマホのキーボードが出たとき、下の検索バーを隠さない（iPhone 用）
  // ============================================================
  function updateKeyboardOffset() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', kb + 'px');
  }

  // ============================================================
  // つなぎこみ
  // ============================================================
  function bind() {
    $('q').addEventListener('input', render);
    $('q').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = $('q').value.trim();
      if (!q) return;
      var nq = normalize(q);
      var hits = allSongs().filter(function (s) { return matches(s, nq); });
      if (!hits.length) openSheet('add', null, queryPrefill(q, hits));
      else $('q').blur();
    });
    $('clearQ').addEventListener('click', function () {
      $('q').value = '';
      render();
      $('q').focus();
    });
    $('addBtn').addEventListener('click', function () {
      var q = $('q').value.trim();
      if (!q) { openSheet('add'); return; }
      var nq = normalize(q);
      openSheet('add', null, queryPrefill(q, allSongs().filter(function (s) { return matches(s, nq); })));
    });

    $('syncStatus').addEventListener('click', function () {
      if (gasUrl() && !token) openLogin();
      else scheduleSync(0);
    });
    $('loginBand').addEventListener('click', openLogin);

    $('sheetForm').addEventListener('submit', function (e) {
      e.preventDefault();
      submitSheet(false);
    });
    $('sheetContinue').addEventListener('click', function () { submitSheet(true); });
    $('sheetCancel').addEventListener('click', closeSheet);
    $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });

    Array.prototype.forEach.call(document.querySelectorAll('.step'), function (b) {
      b.addEventListener('click', function () {
        form.key = Math.max(-6, Math.min(6, form.key + Number(b.getAttribute('data-step'))));
        renderKey();
      });
    });

    var singerInput = $('fSinger');
    // 漢字に変換する前の読み（ひらがな）を拾って、フリガナの下書きにする
    singerInput.addEventListener('compositionupdate', function (e) {
      if (/^[ぁ-ゖー]+$/.test(e.data || '')) form.compBuf = e.data;
    });
    singerInput.addEventListener('compositionend', function () {
      if (form.compBuf && !form.furiganaTouched) {
        form.readingDraft += toKatakana(form.compBuf);
        $('fFurigana').value = form.readingDraft;
      }
      form.compBuf = '';
    });
    singerInput.addEventListener('input', function () {
      if (!singerInput.value.trim()) {
        form.readingDraft = '';
        if (!form.furiganaTouched) $('fFurigana').value = '';
      }
      hideFormError();
      updateSingerUi();
    });
    $('fTitle').addEventListener('input', hideFormError);
    $('fFurigana').addEventListener('input', function () { form.furiganaTouched = true; });

    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      submitLogin();
    });
    $('loginCancel').addEventListener('click', function () { $('loginModal').hidden = true; });

    document.addEventListener('click', function (e) {
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    });
    window.addEventListener('scroll', closeMenu, { passive: true });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      closeMenu();
      closeSheet();
      $('loginModal').hidden = true;
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      render(); // 日付が変わっていたら「今日」の表示を更新する
      scheduleSync(0);
    });
    window.addEventListener('online', function () { scheduleSync(0); });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateKeyboardOffset);
      window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
    }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* なくても動く */ });
    }
  }

  bind();
  render();
  renderStatus();
  scheduleSync(0);

  // 動作確認用（ブラウザの開発者ツールから中身を覗くため）
  window.__karaoke = {
    state: function () { return { songs: songs, pending: pending, token: token, picks: picks }; },
    sync: sync,
  };
})();
