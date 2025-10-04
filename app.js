// =====================
// [boot] 設定読み取り & ガード
// =====================
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content?.trim() || "";
const GOOGLE_CLIENT_ID = meta("mofu:google-client-id");
const ALLOWED_ORIGINS  = meta("mofu:allowed-origins").split(",").map(s=>s.trim()).filter(Boolean);

const ORIGIN_ALLOWED = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(location.origin);
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_ID.endsWith(".apps.googleusercontent.com")) {
  console.warn("[mofu] Google Client ID が未設定です。Drive同期は無効になります。");
}

// =====================
// [config] データ取得先
// =====================
const RIDERS_URL = 'https://keirinjingle.github.io/keirin-links/senshuID.json';
const RACES_URL  = (ymd) => `https://keirinjingle.github.io/date/keirin_race_list_${ymd}.json`;

// =====================
// [util]
//
// JST互換のYYYYMMDD/ISO、ULID風ID、HTMLエスケープ
// =====================
const jst = () => new Date();
const ymd = (d=jst()) => new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10).replace(/-/g,'');
const ymd_dash = (d=jst()) => new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const ulid = () => Date.now().toString(36)+crypto.getRandomValues(new Uint8Array(10)).reduce((a,b)=>a+b.toString(16).padStart(2,'0'),'');
const esc = (s="") => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// =====================
// [state]
//
// RIDERS: {id(登録番号), name, region, ki, grade, profile}
// DAYCARDS: venues
// Google: token等
// =====================
let RIDERS = [];
let DAYCARDS = [];
let googleToken = null; // {access_token, expires_at}

// =====================
// [status badge]
// =====================
function setStatus(kind, ok){
  const el = kind==='riders' ? document.getElementById('riderStatus') : document.getElementById('raceStatus');
  const mark = el.querySelector('.mark');
  mark.textContent = ok ? '✅' : '✖';
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('ng', !ok);
  if(kind==='races'){
    document.getElementById('raceNotice').style.display = ok ? 'none' : 'block';
  }
}

// =====================
// [storage] LocalStorage
// =====================
const KEY_ENTRIES = 'mofu:entries:v1';
const KEY_DRAFT   = 'mofu:draft:v1';
const KEY_USER    = 'mofu:user:v1'; // {access_token, expires_at}

const loadEntries = ()=> JSON.parse(localStorage.getItem(KEY_ENTRIES)||'[]');
const saveEntries = (a)=> localStorage.setItem(KEY_ENTRIES, JSON.stringify(a));
const loadDraft   = ()=> JSON.parse(localStorage.getItem(KEY_DRAFT)||'null');
const saveDraft   = (d)=> localStorage.setItem(KEY_DRAFT, JSON.stringify(d));
const clearDraft  = ()=> localStorage.removeItem(KEY_DRAFT);
const saveUser    = (u)=> localStorage.setItem(KEY_USER, JSON.stringify(u));
const loadUser    = ()=> JSON.parse(localStorage.getItem(KEY_USER)||'null');

// =====================
// [fetch] 選手/当日レース
// =====================
function extractKi(kiText){ const m=(kiText||'').match(/(\d+)期/); return m? `${m[1]}期` : (kiText||''); }

async function fetchRiders(){
  try{
    const res = await fetch(RIDERS_URL, {cache:'no-cache'});
    const arr = await res.json();
    RIDERS = arr.map(r=>({
      name: r['選手名'],
      ki: extractKi(r['期']),
      region: r['地域']||'',
      grade: r['級']||'',
      id: r['登録番号']||'', // ✅ 固有ID
      profile: (r['プロフィールURL']||'').replace('https://keirin.netkeiba.comhttps://','https://')
    }));
    setStatus('riders', true);
  }catch(e){ console.warn('選手DB取得失敗', e); setStatus('riders', false); }
}

async function fetchRaces(){
  try{
    const url = RACES_URL(ymd());
    const res = await fetch(url, {cache:'no-cache'});
    DAYCARDS = await res.json();
    setStatus('races', true);
  }catch(e){ console.warn('当日レース取得失敗', e); setStatus('races', false); }
}

// =====================
// [slash complete] 「/」補完
// =====================
const TACTICS = ['三分戦','二分戦','単騎','先行一車','捲り','差し','カマシ'];
function getSlashToken(text, caret){
  const m = text.slice(0, caret).match(/(^|\s)\/(\S*)$/);
  if(!m) return null; return { token:m[2], start: caret - m[2].length - 1, end: caret };
}
const norm = (s)=> (s||'').toLowerCase();

function findCandidates(q){
  const n = norm(q);
  const items = [];
  // 選手
  if(RIDERS.length && q){
    const list = RIDERS.filter(r=> `${r.name} ${r.region} ${r.ki}`.toLowerCase().includes(n)).slice(0,6);
    items.push(...list.map(r=>({type:'rider', r})));
  }
  // レース（会場名+数字）
  if(DAYCARDS && DAYCARDS.length){
    const numM = n.match(/(\d{1,2})$/); const maybeNo = numM? parseInt(numM[1],10): null;
    for(const v of DAYCARDS){
      const aliases = [v.venue];
      if(aliases.some(a => norm(a).includes(n) || n.includes(norm(a)))){
        for(const rr of v.races){
          if(maybeNo==null || rr.race_number===maybeNo){
            items.push({type:'race', v, r: rr});
            if(items.length>=8) break;
          }
        }
      }
      if(items.length>=8) break;
    }
  }
  // 戦法
  items.push(...TACTICS.filter(t=>t.includes(q)).map(t=>({type:'tactic', t})));
  // タグ
  if(q) items.push({type:'tag', tag:q});
  return items.slice(0,8);
}

function renderDropdown(items){
  const dd = document.getElementById('dropdown');
  if(!items.length){ dd.style.display='none'; return; }
  dd.innerHTML = items.map((it,i)=>{
    if(it.type==='rider'){
      const right = it.r.region ? `${it.r.region}／${it.r.ki}` : it.r.ki;
      return `<div class="item" data-i="${i}"><span class="type">選手</span> @${esc(it.r.name)}（${esc(right)}）</div>`;
    }
    if(it.type==='race'){
      return `<div class="item" data-i="${i}"><span class="type">レース</span> - ${esc(it.v.venue)}${it.r.race_number}R</div>`;
    }
    if(it.type==='tactic'){
      return `<div class="item" data-i="${i}"><span class="type">戦法</span> #${esc(it.t)}</div>`;
    }
    return `<div class="item" data-i="${i}"><span class="type">タグ</span> +${esc(it.tag)}</div>`;
  }).join('');
  const ta = document.getElementById('ta');
  const rect = ta.getBoundingClientRect();
  dd.style.left = (rect.left + 12) + 'px';
  dd.style.top  = (rect.top + 44) + 'px';
  dd.style.display='block';
}

// IME合成フラグ
let composing = false;
let curItems = [];
function updateDropdown(){
  const ta = document.getElementById('ta');
  const tok = getSlashToken(ta.value, ta.selectionStart);
  if(!tok){ document.getElementById('dropdown').style.display='none'; return; }
  curItems = findCandidates(tok.token);
  renderDropdown(curItems);
}
function commitDropdown(idx){
  if(!curItems.length) return;
  const it = curItems[idx];
  const ta = document.getElementById('ta');
  const tok = getSlashToken(ta.value, ta.selectionStart); if(!tok) return;
  let ins='';
  if(it.type==='rider'){
    const r = it.r; const right = r.region ? `${r.region}／${r.ki}` : r.ki; ins = `@${r.name}（${right}）`;
  } else if(it.type==='race'){
    ins = `- ${it.v.venue}${it.r.race_number}R`;
  } else if(it.type==='tactic'){
    ins = `#${it.t}`;
  } else if(it.type==='tag'){
    ins = `+${it.tag}`;
  }
  const before = ta.value.slice(0, tok.start);
  const after  = ta.value.slice(tok.end);
  ta.value = before + ins + after;
  const caret = (before + ins).length; ta.setSelectionRange(caret, caret);
  document.getElementById('dropdown').style.display='none';
  scheduleDraftSave();
}

// =====================
// [parse] エンティティ抽出（選手IDは登録番号で保持）
// =====================
function raceFromRaw(raw){
  const m = raw.match(/-\s*([\u3040-\u30ff\u4e00-\u9fafA-Za-z]+)(\d{1,2})R/);
  if(!m) return null;
  const venue = m[1]; const raceNo = parseInt(m[2],10);
  let resultUrl=null, entryUrl=null;
  const v = (DAYCARDS||[]).find(x=> x.venue===venue);
  if(v){
    const r = v.races.find(x=> x.race_number===raceNo);
    if(r && r.url){
      entryUrl = r.url;
      resultUrl = r.url.replace('/entry/', '/result/');
    }
  }
  return { date: ymd_dash(), venue, raceNo, links: resultUrl? {result: resultUrl, entry: entryUrl} : null };
}
function parseEntities(raw){
  // @名前（…） → name拾いつつ、RIDERSで一意ならidを解決
  const riderNames = Array.from(raw.matchAll(/@([^\s@#\+（）()]+)(?:（[^）]*）)?/g)).map(m=> m[1]);
  const riders = riderNames.map(n=>{
    const cand = RIDERS.filter(r=> r.name===n);
    if(cand.length===1) return {id:cand[0].id, name:n, region:cand[0].region, ki:cand[0].ki};
    return {id:null, name:n};
  });

  const tactics = Array.from(raw.matchAll(/#(\S+)/g)).map(m=>m[1]);
  const tags = Array.from(raw.matchAll(/\+("[^"]+"|\S+)/g)).map(m=> m[1].replace(/^"|"$/g,''));
  return {race: raceFromRaw(raw), riders, tactics, tags};
}

// =====================
// [entries] CRUD & 表示
// =====================
function addEntry(raw){
  const entry = { id: ulid(), at: new Date().toISOString(), raw, ...parseEntities(raw) };
  const arr = loadEntries(); arr.push(entry); saveEntries(arr); clearDraft();
  renderList();
}
function updateEntry(id, newRaw){
  const arr = loadEntries();
  const idx = arr.findIndex(e=>e.id===id);
  if(idx<0) return;
  const updated = { ...arr[idx], raw: newRaw, ...parseEntities(newRaw) };
  arr[idx] = updated;
  saveEntries(arr);
  renderList();
}
function deleteEntry(id){
  const arr = loadEntries().filter(e=> e.id!==id);
  saveEntries(arr);
  renderList();
}

function linkifyRaw(html){
  // @選手（data-rider-id） と +タグ をリンク化（ID優先解決）
  html = html.replace(/@([^\s@#\+（）()]+)([^@#\+\n]*)/g, (m, n, rest)=> {
    const rid = (RIDERS.find(r=> r.name===n)?.id) || "";
    const dataAttr = rid ? ` data-rider-id="${rid}"` : "";
    return `<a href="#" class="riderLink"${dataAttr} data-name="${esc(n)}">@${esc(n)}</a>${esc(rest)}`;
  });
  html = html.replace(/\+("[^"]+"|[\w\u3040-\u30ff\u4e00-\u9faf]+)/g, (m)=> `<a href="#" class="tagLink" data-tag="${esc(m.substring(1))}">${esc(m)}</a>`);
  return html;
}

function renderList(){
  const el = document.getElementById('cards');
  const list = loadEntries().slice().reverse();
  el.innerHTML = list.map(e=>{
    const headLeft = e.race && e.race.venue ? `${e.race.date} ${e.race.venue}${e.race.raceNo}R` : (e.at||'').slice(0,10);
    const resultLink = e.race && e.race.links && e.race.links.result ? `<a href="${e.race.links.result}" target="_blank" rel="noopener">[結果]</a>` : '';
    const raw = linkifyRaw((e.raw||'').replace(/</g,'&lt;'));
    const actions = `
      <div class="card-actions">
        <button class="linklike editBtn" data-id="${e.id}">編集</button>
        <button class="linklike delBtn" data-id="${e.id}">削除</button>
      </div>`;
    return `<div class="card" data-eid="${e.id}">
      <div class="head"><span class="date">${headLeft}</span> ${resultLink} ${actions}</div>
      <div class="raw">${raw}</div>
    </div>`;
  }).join('') || '<div class="card" style="color:#9ca3af">（まだメモがありません）</div>';
}

// =====================
// [search] 全文検索（AND + フレーズ）＋ ハイライト＆ジャンプ
// =====================
const fullSearchDlg = document.getElementById('fullSearchDlg');
const searchInput = document.getElementById('searchInput');
const searchList = document.getElementById('searchList');
const searchMeta = document.getElementById('searchResultMeta');

const tokenizeQuery = (q)=>{
  // "フレーズ" と 通常語を分離。空白はAND扱い
  const phrases = [];
  const rest = q.replace(/"([^"]+)"/g, (_,p)=>{ phrases.push(p.trim()); return " "; });
  const words = rest.split(/\s+/).map(s=>s.trim()).filter(Boolean);
  return {phrases, words};
};
const escReg = (s)=> s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hlSnippet(text, terms, maxLen=120){
  if(!terms.length) return esc(text);
  // 最初のヒット位置を見つける
  const re = new RegExp(terms.map(escReg).join("|"), "i");
  const m = text.match(re);
  const start = Math.max(0, (m?.index ?? 0) - Math.floor((maxLen-terms[0].length)/2));
  const snip = text.slice(start, start+maxLen);
  // すべての用語をハイライト
  let out = esc(snip);
  for(const t of terms.sort((a,b)=>b.length-a.length)){
    const r = new RegExp(escReg(t), "gi");
    out = out.replace(r, (x)=>`<span class="hl">${esc(x)}</span>`);
  }
  return (start>0?"…":"") + out + (start+maxLen<text.length?"…":"");
}

function searchEntries(q){
  const {phrases, words} = tokenizeQuery(q);
  const terms = [...phrases, ...words];
  if(!terms.length) return [];
  const list = loadEntries().slice().reverse(); // 新しい順
  const hits = [];
  for(const e of list){
    const txt = e.raw || "";
    // AND判定：全て含む
    const ok = phrases.every(p=> txt.includes(p)) && words.every(w=> txt.toLowerCase().includes(w.toLowerCase()));
    if(!ok) continue;
    hits.push({
      id: e.id,
      date: e.race && e.race.venue ? `${e.race.date} ${e.race.venue}${e.race.raceNo}R` : (e.at||'').slice(0,10),
      snippet: hlSnippet(txt, terms)
    });
    if(hits.length>=100) break;
  }
  return hits;
}

function renderSearchResults(q){
  const hits = searchEntries(q);
  searchMeta.textContent = q ? `${hits.length} 件` : '';
  searchList.innerHTML = hits.map(h=> `
    <div class="card result-item" data-eid="${h.id}" style="cursor:pointer">
      <div class="head"><span class="date">${esc(h.date)}</span></div>
      <div class="raw result-snippet">${h.snippet}</div>
    </div>
  `).join('') || (q ? '<div class="muted">該当メモがありません。</div>' : '<div class="muted">キーワードを入力してください。</div>');
}

// =====================
// [google sync] GIS + Drive App Folder（単純LWW/単一ファイル）
// =====================
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const APPDATA_FILENAME = 'mofu_entries.ndjson';

// トークン取得（ユーザー操作で取得。許可オリジン外は無効）
function getGoogleTokenInteractive(){
  return new Promise((resolve, reject)=>{
    if(!GOOGLE_CLIENT_ID || !ORIGIN_ALLOWED){
      return reject(new Error('Drive同期は無効（ClientID未設定 or 許可外オリジン）'));
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (resp)=>{
        if(resp && resp.access_token){
          const expires_at = Date.now() + (resp.expires_in ? (resp.expires_in*1000) : 3600*1000) - 5000;
          googleToken = { access_token: resp.access_token, expires_at };
          saveUser(googleToken);
          resolve(googleToken);
        }else{
          reject(new Error('トークン取得失敗'));
        }
      }
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}
function validToken(){
  const t = googleToken || loadUser();
  if(t && t.access_token && t.expires_at && t.expires_at > Date.now()){
    googleToken = t; return t;
  }
  return null;
}
async function ensureToken(){
  const v = validToken(); if(v) return v;
  return await getGoogleTokenInteractive();
}

// Drive helpers
async function gfetch(path, init={}){
  const tok = await ensureToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${tok.access_token}`,
      ...(init.headers||{})
    }
  });
  if(!res.ok) throw new Error(`Drive API error: ${res.status} ${await res.text()}`);
  return res;
}
async function gupload(mime, body, fileId=null){
  const tok = await ensureToken();
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  if(fileId){
    const res = await fetch(url, {
      method:'PATCH',
      headers:{ 'Authorization':`Bearer ${tok.access_token}`, 'Content-Type': mime },
      body
    });
    if(!res.ok) throw new Error(`upload(update) failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }else{
    // multipart: metadata + media
    const boundary = 'xxx' + Math.random().toString(16).slice(2);
    const meta = { name: APPDATA_FILENAME, parents: ['appDataFolder'] };
    const multiBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mime}\r\n\r\n` +
      `${body}\r\n` +
      `--${boundary}--`;
    const res = await fetch(url, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${tok.access_token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multiBody
    });
    if(!res.ok) throw new Error(`upload(create) failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }
}

async function listAppdataFileId(){
  const res = await gfetch(`files?q=name='${encodeURIComponent(APPDATA_FILENAME).replace(/'/g,"%27")}' and 'appDataFolder' in parents&spaces=appDataFolder&fields=files(id,name,modifiedTime)&pageSize=1`, {method:'GET'});
  const js = await res.json();
  return js.files?.[0]?.id || null;
}
async function downloadNdjson(fileId){
  const res = await gfetch(`files/${fileId}?alt=media`, {method:'GET'});
  return await res.text();
}
function mergeNdjson(remoteNd){
  const cur = loadEntries();
  const seen = new Map(cur.map(x=> [x.id, x]));
  const lines = remoteNd.split(/\r?\n/).filter(Boolean);
  let updated = false;
  for(const l of lines){
    try{
      const obj = JSON.parse(l);
      if(!seen.has(obj.id)){ seen.set(obj.id, obj); updated=true; }
      else {
        // LWW: at が新しい方を採用（無ければ現地維持）
        const a = seen.get(obj.id);
        if ((obj.at||"") > (a.at||"")) { seen.set(obj.id, obj); updated=true; }
      }
    }catch{}
  }
  if(updated){
    const merged = Array.from(seen.values());
    saveEntries(merged);
    renderList();
  }
  return updated;
}
function dumpNdjson(){
  const nd = loadEntries().map(x=> JSON.stringify(x)).join('\n');
  return nd;
}
async function syncDriveLWW(){
  if(!ORIGIN_ALLOWED) { alert('このオリジンではDrive同期は無効化されています'); return; }
  await ensureToken();
  let fileId = await listAppdataFileId();
  if(fileId){
    // pull
    const remote = await downloadNdjson(fileId);
    const changed = mergeNdjson(remote);
    // push
    const nd = dumpNdjson();
    await gupload('application/x-ndjson', nd, fileId);
    alert(`Drive同期 完了（マージ:${changed?'あり':'なし'}）`);
  }else{
    const nd = dumpNdjson();
    await gupload('application/x-ndjson', nd, null);
    alert('Driveに新規作成しました');
  }
}

// =====================
// [ui events] 入力・検索・編集・削除・エクスポート/インポート・Google接続など
// =====================
const ta = document.getElementById('ta');
ta.addEventListener('compositionstart', ()=>{ composing = true; });
ta.addEventListener('compositionend', ()=>{ composing = false; updateDropdown(); });
ta.addEventListener('input', ()=>{ updateDropdown(); scheduleDraftSave(); });
ta.addEventListener('keydown', (e)=>{
  const dd = document.getElementById('dropdown');
  if(e.key==='Enter' && !e.shiftKey){
    if (e.isComposing || composing) return;
    if(dd.style.display==='block' && curItems.length){
      commitDropdown(0);
      e.preventDefault();
    }
    return;
  }
  if(e.key==='Escape'){ dd.style.display='none'; }
});
document.getElementById('dropdown').addEventListener('mousedown', (e)=>{
  const node = e.target.closest('.item'); if(!node) return; commitDropdown(parseInt(node.dataset.i,10)); e.preventDefault();
});
document.getElementById('slashBtn').addEventListener('click', ()=>{ ta.focus(); const st=ta.selectionStart; ta.setRangeText('/', st, st, 'end'); updateDropdown(); });
document.getElementById('inlineSlash').addEventListener('click', ()=>{ ta.focus(); const st=ta.selectionStart; ta.setRangeText('/', st, st, 'end'); updateDropdown(); });

// ドラフト
let draftTimer=null; function scheduleDraftSave(){ clearTimeout(draftTimer); draftTimer=setTimeout(()=>{ saveDraft({text:ta.value, caret:ta.selectionStart, ts:Date.now()}); }, 500); }
function restoreDraft(){ const d=loadDraft(); if(!d) return; ta.value=d.text||''; const c=d.caret||ta.value.length; ta.setSelectionRange(c,c); }

// 登録
document.getElementById('addBtn').addEventListener('click', ()=>{
  const raw = ta.value.trim();
  if(!raw){ alert('テキストが空です'); return; }
  addEntry(raw);
  ta.value='';
  renderList();
});

// エクスポート/インポート
document.getElementById('exportBtn').addEventListener('click', ()=>{
  const nd = dumpNdjson();
  const blob = new Blob([nd], {type:'application/x-ndjson'});
  const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download: `mofu_${ymd()}.ndjson`});
  a.click(); URL.revokeObjectURL(a.href);
});
document.getElementById('importBtn').addEventListener('click', ()=>{
  const inp = Object.assign(document.createElement('input'), {type:'file', accept:'.ndjson,.jsonl'});
  inp.onchange = async ()=>{
    const text = await inp.files[0].text();
    mergeNdjson(text);
    renderList();
  };
  inp.click();
});

// 編集／削除／リンク検索
document.body.addEventListener('click', (e)=>{
  // 編集
  const editBtn = e.target.closest('.editBtn');
  if(editBtn){
    const id = editBtn.dataset.id;
    const entry = loadEntries().find(x=>x.id===id);
    if(!entry) return;
    const dlg = document.getElementById('editDlg');
    const editTa = document.getElementById('editTa');
    editTa.value = entry.raw || '';
    dlg.dataset.id = id;
    dlg.showModal();
    return;
  }
  // 削除
  const delBtn  = e.target.closest('.delBtn');
  if(delBtn){
    const id = delBtn.dataset.id;
    if(confirm('このメモを削除しますか？')){
      deleteEntry(id);
    }
    return;
  }
  // @選手 / +タグ → 既存の簡易串刺しではなく全文検索へ誘導
  const r = e.target.closest('a.riderLink');
  if(r){
    e.preventDefault();
    openFullSearch(r.dataset.riderId ? `rider:${r.dataset.riderId}` : r.dataset.name);
    return;
  }
  const t = e.target.closest('a.tagLink');
  if(t){
    e.preventDefault();
    openFullSearch(t.dataset.tag);
    return;
  }
});

// 編集保存
document.getElementById('editSaveBtn').addEventListener('click', (e)=>{
  e.preventDefault();
  const dlg = document.getElementById('editDlg');
  const id  = dlg.dataset.id;
  const newRaw = document.getElementById('editTa').value;
  updateEntry(id, newRaw);
  dlg.close();
});

// 全文検索UI
document.getElementById('openSearchBtn').addEventListener('click', ()=> openFullSearch(""));
document.getElementById('searchClose').addEventListener('click', ()=> fullSearchDlg.close());

let searchTimer=null;
searchInput.addEventListener('input', ()=>{
  clearTimeout(searchTimer);
  searchTimer = setTimeout(()=> renderSearchResults(searchInput.value), 300);
});
searchList.addEventListener('click', (e)=>{
  const item = e.target.closest('.result-item'); if(!item) return;
  const eid = item.dataset.eid;
  fullSearchDlg.close();
  jumpToEntry(eid);
});
function openFullSearch(seed){
  fullSearchDlg.showModal();
  searchInput.value = seed || "";
  renderSearchResults(searchInput.value);
  setTimeout(()=> searchInput.focus(), 0);
}
function jumpToEntry(eid){
  const card = document.querySelector(`.card[data-eid="${eid}"]`);
  if(card){
    card.scrollIntoView({behavior:'smooth', block:'center'});
    card.classList.add('pulse');
    setTimeout(()=> card.classList.remove('pulse'), 1500);
  }
}

// Google接続
document.getElementById('connectGoogleBtn').addEventListener('click', async ()=>{
  try{
    if(!GOOGLE_CLIENT_ID) return alert('GoogleクライアントIDが未設定です。index.htmlの<meta>を設定してください。');
    if(!ORIGIN_ALLOWED) return alert('このオリジンは許可されていないため、Drive同期は無効です。');
    await ensureToken();
    await sync
