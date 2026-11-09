/* 오프닝 법정 — 단일 페이지 앱 (빌드 도구 없음, 바닐라 JS)
 * 백엔드 두 가지:
 *   - SupaBackend : config.js 에 Supabase 주소/키가 있으면 사용 (온라인, 친구들과 공유)
 *   - DemoBackend : 비어 있으면 사용 (이 브라우저 localStorage 에만 저장)
 * 화면 라우팅은 location.hash (#tiers, #opening-12, #board, #post-5, #write-12, #court, #me, #admin)
 */
(() => {
  'use strict';

  // ================================================================ 설정·상수
  const CFG = Object.assign({
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SITE_NAME: '오프닝 법정',
    PRIOR_STRENGTH: 5, EMAIL_DOMAIN: 'opening-court.app'
  }, window.OC_CONFIG || {});
  const SEED = window.OC_SEED || { categories: [], openings: [] };
  const C = Number(CFG.PRIOR_STRENGTH) > 0 ? Number(CFG.PRIOR_STRENGTH) : 5;
  const NEUTRAL_PRIOR = 50; // AI 점수가 없는 분야(멘탈 파괴력 등)의 사전값

  // 1 = 최상위 … 11 = 최하위. lo 이상이면 그 티어. mid 는 투표를 점수로 바꿀 때 쓰는 구간 중앙값.
  const TIERS = [
    { n: 1, name: '안 두면 직무유기', short: '직무유기', desc: '이걸 모르고 체스를 둔다고?', lo: 97, mid: 98.5 },
    { n: 2, name: 'SS', short: 'SS', desc: '그랜드마스터의 비밀 노트', lo: 92, mid: 94.5 },
    { n: 3, name: 'S', short: 'S', desc: '레이팅 엘리베이터', lo: 85, mid: 88.5 },
    { n: 4, name: 'A', short: 'A', desc: '대회 단골손님', lo: 75, mid: 80 },
    { n: 5, name: 'B', short: 'B', desc: '교내 대회 우승각', lo: 65, mid: 70 },
    { n: 6, name: 'C', short: 'C', desc: '동네 공원 체스', lo: 55, mid: 60 },
    { n: 7, name: 'D', short: 'D', desc: '5수 두고 후회', lo: 45, mid: 50 },
    { n: 8, name: 'E', short: 'E', desc: '상대가 속으로 환호', lo: 35, mid: 40 },
    { n: 9, name: 'F', short: 'F', desc: '레이팅 자선 단체', lo: 25, mid: 30 },
    { n: 10, name: '기보 소각 대상', short: '소각', desc: '남은 기록까지 태워야 함', lo: 12, mid: 18.5 },
    { n: 11, name: '인류의 수치', short: '수치', desc: '외계인이 보면 지구 침공함', lo: -Infinity, mid: 6 }
  ];
  const GROUPS = { main: '오프닝·디펜스', sicilian: '시실리안', variation: '변화·갬빗', unofficial: '비공식' };
  const CHESSJS_URL = 'https://cdn.jsdelivr.net/npm/chess.js@0.10.3/chess.js';
  const MODES = { final: '최종', vote: '투표', ai: 'AI' };
  const BAD_WORDS = ['시발', '씨발', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '존나', '개새끼', '새끼', '지랄', '염병', '닥쳐', '꺼져라', '미친놈', '미친년', 'fuck', 'shit', 'bitch'];

  // ================================================================ 유틸
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = (o, c) => o + '|' + c;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const tierOf = (score) => TIERS.find((t) => score >= t.lo) || TIERS[TIERS.length - 1];
  const tierByN = (n) => TIERS[n - 1];
  const fmt = (x) => (x == null || !isFinite(x) ? '–' : (Math.round(x * 10) / 10).toFixed(1));
  const normNick = (s) => String(s || '').trim().normalize('NFC');

  async function sha256hex(text) {
    const bytes = new TextEncoder().encode(text);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256js(bytes); // file:// 처럼 보안 컨텍스트가 아닐 때 (결과는 같음)
  }
  function sha256js(msg) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = msg.length, nBlocks = ((l + 9 + 63) >> 6), buf = new Uint8Array(nBlocks * 64);
    buf.set(msg); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(buf.length - 4, (l * 8) >>> 0); dv.setUint32(buf.length - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < buf.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  function hash32(str) { // 데모 데이터용 결정적 난수
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
  }
  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return '방금';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    if (s < 86400 * 7) return Math.floor(s / 86400) + '일 전';
    const d = new Date(iso);
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  }
  function badWord(text) {
    const t = String(text).toLowerCase().replace(/\s+/g, '');
    return BAD_WORDS.find((w) => t.includes(w));
  }
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } }
  };
  let toastTimer = 0;
  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg; el.className = bad ? 'bad' : ''; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  class UserError extends Error {}

  // ================================================================ Supabase 백엔드
  class SupaBackend {
    constructor() {
      this.demo = false;
      this.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    }
    async q(p) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data; }
    async emailFor(nick) { return 'u' + (await sha256hex(normNick(nick).toLowerCase())).slice(0, 32) + '@' + CFG.EMAIL_DOMAIN; }
    async session() {
      const { data } = await this.sb.auth.getSession();
      const s = data && data.session;
      if (!s) return null;
      const p = await this.q(this.sb.from('profiles').select('id,nickname,role,banned').eq('id', s.user.id).maybeSingle());
      return p || null;
    }
    async signUp(nick, pw, invite) {
      nick = normNick(nick);
      if (!(await this.q(this.sb.rpc('check_invite', { code: invite })))) throw new UserError('초대 코드가 틀렸어요.');
      if (!(await this.q(this.sb.rpc('nickname_available', { nick })))) throw new UserError('이미 누가 쓰는 닉네임이에요.');
      const { data, error } = await this.sb.auth.signUp({
        email: await this.emailFor(nick), password: pw, options: { data: { nickname: nick, invite: invite.trim() } }
      });
      if (error) {
        if (/registered/i.test(error.message)) throw new UserError('이미 누가 쓰는 닉네임이에요.');
        if (/password/i.test(error.message)) throw new UserError('비밀번호는 6자 이상이어야 해요.');
        throw new UserError('가입하지 못했어요: ' + error.message);
      }
      if (!data.session) throw new UserError('가입은 됐지만 바로 로그인되지 않았어요. 관리자가 Supabase에서 "Confirm email"을 꺼야 해요 (README 참고).');
      return this.session();
    }
    async signIn(nick, pw) {
      const { error } = await this.sb.auth.signInWithPassword({ email: await this.emailFor(nick), password: pw });
      if (error) throw new UserError('닉네임 또는 비밀번호가 틀렸어요.');
      return this.session();
    }
    async signOut() { await this.sb.auth.signOut(); }
    async loadCore() {
      const [openings, categories, ai, stats] = await Promise.all([
        this.q(this.sb.from('openings').select('id,slug,name,grp,side,san,uci,fens,sort').order('sort')),
        this.q(this.sb.from('categories').select('*').order('sort')),
        this.q(this.sb.from('ai_scores').select('opening_id,category_id,score,se').limit(5000)),
        this.loadStats()
      ]);
      return { openings, categories, ai, aiPlaceholder: false, stats };
    }
    loadStats() { return this.q(this.sb.from('vote_stats').select('opening_id,category_id,n,mean,sd').limit(5000)); }
    myVotes(uid) { return this.q(this.sb.from('votes').select('opening_id,category_id,tier').eq('user_id', uid).limit(5000)); }
    async vote(uid, o, c, tier) {
      if (tier == null) return this.q(this.sb.from('votes').delete().match({ user_id: uid, opening_id: o, category_id: c }));
      return this.q(this.sb.from('votes').upsert({ user_id: uid, opening_id: o, category_id: c, tier }, { onConflict: 'user_id,opening_id,category_id' }));
    }
    voteDist(o) { return this.q(this.sb.from('vote_dist').select('category_id,tier,n').eq('opening_id', o)); }
    listPosts({ openingId = null, kind = 'all' } = {}) {
      let q = this.sb.from('posts_view').select('*').eq('deleted', false).order('created_at', { ascending: false }).limit(100);
      if (openingId != null) q = q.eq('opening_id', openingId);
      else if (kind === 'free') q = q.is('opening_id', null);
      else if (kind === 'opening') q = q.not('opening_id', 'is', null);
      return this.q(q);
    }
    getPost(id) { return this.q(this.sb.from('posts_view').select('*').eq('id', id).eq('deleted', false).maybeSingle()); }
    async createPost(uid, { title, body, openingId }) {
      const r = await this.q(this.sb.from('posts').insert({ author: uid, title, body, opening_id: openingId || null }).select('id').single());
      return r.id;
    }
    deletePost(id) { return this.q(this.sb.from('posts').update({ deleted: true }).eq('id', id)); }
    listComments(postId) { return this.q(this.sb.from('comments_view').select('*').eq('post_id', postId).eq('deleted', false).order('created_at')); }
    createComment(uid, postId, body) { return this.q(this.sb.from('comments').insert({ author: uid, post_id: postId, body })); }
    deleteComment(id) { return this.q(this.sb.from('comments').update({ deleted: true }).eq('id', id)); }
    async myLikes(uid) {
      const rows = await this.q(this.sb.from('likes').select('target_type,target_id').eq('user_id', uid).limit(5000));
      return new Set(rows.map((r) => r.target_type + '|' + r.target_id));
    }
    like(uid, type, id, on) {
      if (on) return this.q(this.sb.from('likes').upsert({ user_id: uid, target_type: type, target_id: id }, { onConflict: 'user_id,target_type,target_id', ignoreDuplicates: true }));
      return this.q(this.sb.from('likes').delete().match({ user_id: uid, target_type: type, target_id: id }));
    }
    report(uid, type, id, reason) { return this.q(this.sb.from('reports').insert({ reporter: uid, target_type: type, target_id: id, reason })); }
    listReports() { return this.q(this.sb.from('reports').select('*').eq('resolved', false).order('created_at', { ascending: false }).limit(100)); }
    resolveReport(id) { return this.q(this.sb.from('reports').update({ resolved: true }).eq('id', id)); }
    listUsers() { return this.q(this.sb.from('profiles').select('id,nickname,role,banned,created_at').order('created_at')); }
    setRole(id, role) { return this.q(this.sb.from('profiles').update({ role }).eq('id', id)); }
    setBanned(id, banned) { return this.q(this.sb.from('profiles').update({ banned }).eq('id', id)); }
    async updateOpening(id, patch) { await this.q(this.sb.from('openings').update(patch).eq('id', id)); }
    getInvite() { return this.q(this.sb.rpc('get_invite_code')); }
    setInvite(code) { return this.q(this.sb.rpc('set_invite_code', { code })); }
  }

  // ================================================================ 데모 백엔드 (localStorage)
  class DemoBackend {
    constructor() {
      this.demo = true;
      this.K = 'oc_demo_v2';
      store.del('oc_demo_v1'); // 예전 버전의 예시 데이터(가짜 투표자·글) 정리
      this.db = store.get(this.K);
      if (!this.db || !Array.isArray(this.db.users)) this.db = this.freshDb();
    }
    freshDb() {
      // 처음엔 아무것도 없는 상태 (예시 투표자·예시 글 없음). 첫 가입자가 관리자.
      return { users: [], votes: [], posts: [], comments: [], likes: [], reports: [], openingEdits: {}, invite: 'DEMO', seq: 1 };
    }
    save() { store.set(this.K, this.db); }
    aiRows() {
      if (Array.isArray(window.OC_AI)) return window.OC_AI;
      // 데모용 임의 점수: 그룹별 기본값 + 분야별 보정 + 결정적 잡음. 실제 AI 점수 아님.
      const base = { main: 58, sicilian: 70, variation: 52, unofficial: 20 };
      const adj = {
        trap: { variation: 14, unofficial: 25, sicilian: -6 }, attack: { variation: 16, unofficial: 12, sicilian: 8 },
        beginner: { sicilian: -28, unofficial: 18, main: 10 }, stability: { unofficial: -12, sicilian: -4 }, engine: { unofficial: -8 }
      };
      const rows = [];
      for (const o of SEED.openings) {
        let zsum = 0, wsum = 0;
        if (!o.uci.length) continue; // 수순 미입력 오프닝은 AI 점수 없음
        for (const c of SEED.categories) {
          if (!c.ai) continue;
          const s = clamp(base[o.grp] + ((adj[c.id] || {})[o.grp] || 0) + (hash32(o.slug + c.id) - 0.5) * 22, 1, 99);
          rows.push({ opening_id: o.id, category_id: c.id, score: s, se: null });
          zsum += c.weight * s; wsum += c.weight;
        }
        rows.push({ opening_id: o.id, category_id: 'overall', raw: zsum / wsum, score: 0, se: null });
      }
      // 실제 배치와 같은 방식으로 종합 원점수를 강건 표준화 → Φ (가운데로 몰리지 않게)
      const ov = rows.filter((r) => r.category_id === 'overall');
      const med = (xs) => { const t = xs.slice().sort((x, y) => x - y), m = t.length >> 1; return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };
      const m = med(ov.map((r) => r.raw)), mad = 1.4826 * med(ov.map((r) => Math.abs(r.raw - m))) || 1;
      const phi = (z) => { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return 0.5 * (1 + Math.sign(z) * e); };
      ov.forEach((r) => { r.score = clamp(100 * phi((r.raw - m) / mad), 0, 100); });
      return rows;
    }
    sessionUser() { const id = store.get('oc_demo_session'); return this.db.users.find((u) => u.id === id) || null; }
    pub(u) { return u && { id: u.id, nickname: u.nickname, role: u.role, banned: u.banned }; }
    async session() { return this.pub(this.sessionUser()); }
    async signUp(nick, pw, invite) {
      nick = normNick(nick);
      if (invite.trim() !== this.db.invite) throw new UserError('초대 코드가 틀렸어요. (데모 초대 코드: ' + this.db.invite + ')');
      if (nick.length < 2 || nick.length > 16) throw new UserError('닉네임은 2~16자로 정해 주세요.');
      if (this.db.users.some((u) => u.nickname.toLowerCase() === nick.toLowerCase())) throw new UserError('이미 누가 쓰는 닉네임이에요.');
      if (pw.length < 6) throw new UserError('비밀번호는 6자 이상이어야 해요.');
      const u = { id: 'u' + Date.now().toString(36), nickname: nick, pw: await sha256hex(pw), role: this.db.users.length ? 'user' : 'admin', banned: false, created_at: new Date().toISOString() };
      this.db.users.push(u); this.save(); store.set('oc_demo_session', u.id);
      return this.pub(u);
    }
    async signIn(nick, pw) {
      const u = this.db.users.find((x) => x.nickname.toLowerCase() === normNick(nick).toLowerCase());
      if (!u || !u.pw || u.pw !== (await sha256hex(pw))) throw new UserError('닉네임 또는 비밀번호가 틀렸어요.');
      store.set('oc_demo_session', u.id); return this.pub(u);
    }
    async signOut() { store.del('oc_demo_session'); }
    openingsWithEdits() {
      const ed = this.db.openingEdits || {};
      return SEED.openings.map((o) => (ed[o.id] ? { ...o, ...ed[o.id] } : o));
    }
    async updateOpening(id, patch) { this.db.openingEdits = this.db.openingEdits || {}; this.db.openingEdits[id] = patch; this.save(); }
    async loadCore() {
      return { openings: this.openingsWithEdits(), categories: SEED.categories, ai: this.aiRows(), aiPlaceholder: !Array.isArray(window.OC_AI), stats: await this.loadStats() };
    }
    async loadStats() {
      const m = new Map();
      for (const v of this.db.votes) {
        const k = key(v.opening_id, v.category_id);
        if (!m.has(k)) m.set(k, { opening_id: v.opening_id, category_id: v.category_id, xs: [] });
        m.get(k).xs.push(tierByN(v.tier).mid);
      }
      return [...m.values()].map((r) => {
        const n = r.xs.length, mean = r.xs.reduce((a, b) => a + b, 0) / n;
        const sd = n > 1 ? Math.sqrt(r.xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
        return { opening_id: r.opening_id, category_id: r.category_id, n, mean, sd };
      });
    }
    async myVotes(uid) { return this.db.votes.filter((v) => v.user_id === uid); }
    guard(uid) { const u = this.db.users.find((x) => x.id === uid); if (!u || u.banned) throw new UserError('차단된 계정이에요.'); }
    async vote(uid, o, c, tier) {
      this.guard(uid);
      this.db.votes = this.db.votes.filter((v) => !(v.user_id === uid && v.opening_id === o && v.category_id === c));
      if (tier != null) this.db.votes.push({ user_id: uid, opening_id: o, category_id: c, tier, updated_at: new Date().toISOString() });
      this.save();
    }
    async voteDist(o) {
      const m = new Map();
      for (const v of this.db.votes) if (v.opening_id === o) { const k = key(v.category_id, v.tier); m.set(k, (m.get(k) || 0) + 1); }
      return [...m].map(([k, n]) => { const [category_id, tier] = k.split('|'); return { category_id, tier: Number(tier), n }; });
    }
    postView(p) {
      const u = this.db.users.find((x) => x.id === p.author);
      const o = SEED.openings.find((x) => x.id === p.opening_id);
      return {
        ...p, nickname: u ? u.nickname : '(탈퇴)', opening_name: o ? o.name : null,
        likes: this.db.likes.filter((l) => l.target_type === 'post' && l.target_id === p.id).length,
        ncomments: this.db.comments.filter((c) => c.post_id === p.id && !c.deleted).length
      };
    }
    async listPosts({ openingId = null, kind = 'all' } = {}) {
      return this.db.posts.filter((p) => !p.deleted
        && (openingId != null ? p.opening_id === openingId : kind === 'free' ? p.opening_id == null : kind === 'opening' ? p.opening_id != null : true))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).map((p) => this.postView(p));
    }
    async getPost(id) { const p = this.db.posts.find((x) => x.id === id && !x.deleted); return p ? this.postView(p) : null; }
    async createPost(uid, { title, body, openingId }) {
      this.guard(uid);
      const p = { id: this.db.seq++, author: uid, opening_id: openingId || null, title, body, created_at: new Date().toISOString(), deleted: false };
      this.db.posts.push(p); this.save(); return p.id;
    }
    async deletePost(id) { const p = this.db.posts.find((x) => x.id === id); if (p) p.deleted = true; this.save(); }
    async listComments(postId) {
      return this.db.comments.filter((c) => c.post_id === postId && !c.deleted).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => {
        const u = this.db.users.find((x) => x.id === c.author);
        return { ...c, nickname: u ? u.nickname : '(탈퇴)', likes: this.db.likes.filter((l) => l.target_type === 'comment' && l.target_id === c.id).length };
      });
    }
    async createComment(uid, postId, body) { this.guard(uid); this.db.comments.push({ id: this.db.seq++, post_id: postId, author: uid, body, created_at: new Date().toISOString(), deleted: false }); this.save(); }
    async deleteComment(id) { const c = this.db.comments.find((x) => x.id === id); if (c) c.deleted = true; this.save(); }
    async myLikes(uid) { return new Set(this.db.likes.filter((l) => l.user_id === uid).map((l) => l.target_type + '|' + l.target_id)); }
    async like(uid, type, id, on) {
      this.db.likes = this.db.likes.filter((l) => !(l.user_id === uid && l.target_type === type && l.target_id === id));
      if (on) this.db.likes.push({ user_id: uid, target_type: type, target_id: id });
      this.save();
    }
    async report(uid, type, id, reason) { this.db.reports.push({ id: this.db.seq++, reporter: uid, target_type: type, target_id: id, reason, created_at: new Date().toISOString(), resolved: false }); this.save(); }
    async listReports() { return this.db.reports.filter((r) => !r.resolved).slice().reverse(); }
    async resolveReport(id) { const r = this.db.reports.find((x) => x.id === id); if (r) r.resolved = true; this.save(); }
    async listUsers() { return this.db.users.map((u) => this.pub(u)); }
    async setRole(id, role) { const u = this.db.users.find((x) => x.id === id); if (u) u.role = role; this.save(); }
    async setBanned(id, b) { const u = this.db.users.find((x) => x.id === id); if (u) u.banned = b; this.save(); }
    async getInvite() { return this.db.invite; }
    async setInvite(code) { if (code.trim().length < 4) throw new UserError('초대 코드는 4자 이상이어야 해요.'); this.db.invite = code.trim(); this.save(); }
    reset() { store.del(this.K); store.del('oc_demo_session'); }
  }

  // ================================================================ 상태
  const api = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase ? new SupaBackend() : new DemoBackend();
  const S = {
    loading: true, user: null, openings: [], byId: new Map(), categories: [], aiCats: [],
    ai: new Map(), stats: new Map(), my: new Map(), likes: new Set(), aiPlaceholder: false,
    ui: { cat: 'overall', mode: 'final', grp: 'all', search: '', ply: {}, flip: {}, boardKind: 'all', reportOpen: null },
    cache: { dist: new Map() }
  };
  const ui0 = store.get('oc_ui');
  if (ui0) Object.assign(S.ui, { cat: ui0.cat || 'overall', mode: ui0.mode || 'final', grp: ui0.grp || 'all' });
  const saveUi = () => store.set('oc_ui', { cat: S.ui.cat, mode: S.ui.mode, grp: S.ui.grp });

  function setCore(core) {
    S.openings = core.openings.slice().sort((a, b) => a.sort - b.sort);
    S.byId = new Map(S.openings.map((o) => [o.id, o]));
    S.categories = core.categories.slice().sort((a, b) => a.sort - b.sort);
    S.aiCats = S.categories.filter((c) => c.weight > 0);
    S.ai = new Map(core.ai.map((r) => [key(r.opening_id, r.category_id), r]));
    S.aiPlaceholder = core.aiPlaceholder;
    setStats(core.stats);
  }
  function setStats(rows) { S.stats = new Map(rows.map((r) => [key(r.opening_id, r.category_id), { n: r.n, mean: Number(r.mean), sd: Number(r.sd) }])); }
  async function refreshStats() { setStats(await api.loadStats()); }

  // ================================================================ 점수 계산 (계획서 10번 식)
  function catScore(o, c, mode) {
    const ai = S.ai.get(key(o, c));
    const st = S.stats.get(key(o, c));
    if (mode === 'ai') return ai ? ai.score : null;
    if (mode === 'vote') return st && st.n ? st.mean : null;
    const prior = ai ? ai.score : NEUTRAL_PRIOR;
    const n = st ? st.n : 0;
    return (C * prior + n * (st ? st.mean : 0)) / (C + n);
  }
  // 종합: 투표는 분야 투표 평균의 가중 평균. 최종은 AI 종합 점수(재표준화된 값)를 사전값으로 두고
  // 가중 평균 투표 수 n_eff = Σ w_j n_j / Σ w_j 만큼 투표 쪽으로 당긴다.
  // (분야별 최종 점수를 그냥 평균하면 분산이 줄어 모두 가운데 티어로 몰리므로 그렇게 하지 않음)
  function overallVote(o) {
    let num = 0, den = 0, nw = 0, wAll = 0;
    for (const c of S.aiCats) {
      wAll += c.weight;
      const st = S.stats.get(key(o, c.id));
      if (!st || !st.n) continue;
      num += c.weight * st.mean; den += c.weight; nw += c.weight * st.n;
    }
    return den ? { mean: num / den, nEff: nw / wAll } : null;
  }
  function overallScore(o, mode) {
    const a = S.ai.get(key(o, 'overall'));
    if (mode === 'ai') return a ? a.score : null;
    const v = overallVote(o);
    if (mode === 'vote') return v ? v.mean : null;
    const prior = a ? a.score : NEUTRAL_PRIOR;
    if (!v) return prior;
    return (C * prior + v.nEff * v.mean) / (C + v.nEff);
  }
  const score = (o, cat, mode) => (cat === 'overall' ? overallScore(o, mode) : catScore(o, cat, mode));
  function voteCount(o) { let n = 0; for (const c of S.categories) { const st = S.stats.get(key(o, c.id)); if (st) n += st.n; } return n; }

  // ================================================================ 화면 공통
  const tierBadge = (t, big = false) => t ? `<span class="badge t${t.n}${big ? ' big' : ''}">${esc(t.name)}</span>` : `<span class="badge t0${big ? ' big' : ''}">미정</span>`;
  const scoreBadge = (s, big = false) => (s == null ? tierBadge(null, big) : tierBadge(tierOf(s), big));
  const route = () => {
    const h = location.hash.replace(/^#/, '');
    const m = h.match(/^([a-z]+)(?:-(\d+|[a-z]+))?$/);
    return m ? { name: m[1], arg: m[2] } : { name: 'tiers' };
  };
  function shell(inner, active) {
    const nav = [['tiers', '티어', '▦'], ['court', '법정', '⚖'], ['board', '토론', '✎'], ['me', '나', '♟']];
    const banners = [];
    if (api.demo) banners.push(`<div class="banner"><b>데모 모드</b> · 이 브라우저에만 저장돼요. 친구들과 같이 쓰려면 README대로 Supabase를 연결하세요. 데모 초대 코드는 <span class="mono">DEMO</span>.</div>`);
    if (S.aiPlaceholder) banners.push(`<div class="banner"><b>AI 점수 미산출</b> · 지금 AI 칸은 데모용 임의 값이에요. C++ 배치를 돌리면 진짜 점수로 바뀝니다.</div>`);
    return `<header class="appbar"><div class="appbar-inner">
        <a class="brand" href="#tiers">${esc(CFG.SITE_NAME)}<small>${S.openings.length} OPENINGS</small></a>
        ${S.user ? `<nav class="nav">${nav.map(([r, l, i]) => `<a href="#${r}" class="${active === r ? 'on' : ''}"><span class="ico" aria-hidden="true">${i}</span>${l}</a>`).join('')}</nav>` : ''}
      </div></header>
      <main>${banners.join('')}${inner}</main>`;
  }

  // ---------------------------------------------------------------- 로그인
  function viewLogin(tab = 'in') {
    return `<div class="auth">
      <div class="hero"><h1>${esc(CFG.SITE_NAME)}</h1>
        <p class="muted">체스 오프닝 ${S.openings.length || 100}개를 분야별로 재판합니다. 판결은 AI 공식과 우리 반 투표가 함께 내려요.</p>
        <div class="mini-ladder" aria-hidden="true">${TIERS.map((t) => `<span class="t${t.n}"></span>`).join('')}</div></div>
      <div class="seg" role="tablist"><button data-act="auth-tab" data-tab="in" class="${tab === 'in' ? 'on' : ''}">로그인</button><button data-act="auth-tab" data-tab="up" class="${tab === 'up' ? 'on' : ''}">가입</button></div>
      <form class="card stack" id="auth-form" data-mode="${tab}">
        <div class="field"><label for="f-nick">닉네임</label><input class="input" id="f-nick" name="nick" autocomplete="username" maxlength="16" required></div>
        <div class="field"><label for="f-pw">비밀번호</label><input class="input" id="f-pw" name="pw" type="password" autocomplete="${tab === 'in' ? 'current-password' : 'new-password'}" minlength="6" required></div>
        ${tab === 'up' ? `<div class="field"><label for="f-invite">초대 코드</label><input class="input" id="f-invite" name="invite" autocomplete="off" required><span class="small muted">반장(관리자)에게 받은 코드. 실명 말고 닉네임을 쓰세요.</span></div>` : ''}
        <div class="err" id="auth-err"></div>
        <button class="btn primary" type="submit">${tab === 'in' ? '입장' : '가입하고 입장'}</button>
      </form></div>`;
  }

  // ---------------------------------------------------------------- 티어리스트
  function viewTiers() {
    const { cat, mode, grp, search } = S.ui;
    const catBtns = [['overall', '종합']].concat(S.categories.map((c) => [c.id, c.name]));
    const q = search.toLowerCase();
    const list = S.openings.filter((o) => (grp === 'all' || o.grp === grp) && (!q || o.name.toLowerCase().includes(q) || o.slug.includes(q)));
    const rows = TIERS.map(() => []); const none = [];
    for (const o of list) {
      const s = score(o.id, cat, mode);
      if (s == null) none.push({ o, s }); else rows[tierOf(s).n - 1].push({ o, s });
    }
    rows.forEach((r) => r.sort((a, b) => b.s - a.s));
    const catObj = S.categories.find((c) => c.id === cat);
    const myKey = cat === 'overall' ? null : cat;
    const chip = ({ o, s }) => `<a class="chip g-${o.grp}${myKey && S.my.has(key(o.id, myKey)) ? ' mine' : ''}" href="#opening-${o.id}"><span class="nm">${esc(o.name)}</span>${s != null ? `<span class="sc">${fmt(s)}</span>` : ''}</a>`;
    const modeNote = mode === 'final' ? `AI 점수를 ${C}표 분량의 출발점으로 두고 투표로 갱신한 점수` : mode === 'vote' ? '우리 반 투표 평균 (표가 없으면 빠짐)' : 'Lichess 대국 통계와 엔진 평가로 계산한 점수';
    return shell(`
      <div class="spread"><h1>${cat === 'overall' ? '종합 티어' : esc(catObj ? catObj.name : '')}</h1>
        <div class="seg tight" role="tablist">${Object.entries(MODES).map(([k, l]) => `<button data-act="mode" data-v="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <p class="muted small" style="margin:-8px 0 0">${esc(catObj ? catObj.description + ' · ' : '')}${modeNote}. 밑줄 표시는 내가 이 분야에 투표한 오프닝.</p>
      <div class="toolbar">
        <div class="seg" role="tablist">${catBtns.map(([k, l]) => `<button data-act="cat" data-v="${k}" class="${cat === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
        <div class="spread">
          <div class="seg tight">${[['all', '전체']].concat(Object.entries(GROUPS)).map(([k, l]) => `<button data-act="grp" data-v="${k}" class="${grp === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <input class="input search" id="f-search" type="search" placeholder="오프닝 검색" value="${esc(search)}">
        </div>
      </div>
      <div class="ladder">
        ${TIERS.map((t, i) => `<div class="tier-row"><div class="tier-label t${t.n}${t.name.length > 3 ? ' long' : ''}">${esc(t.name)}<span class="tdesc">${esc(t.desc)}</span></div>
          <div class="tier-cards">${rows[i].length ? rows[i].map(chip).join('') : '<span class="tier-empty">비어 있음</span>'}</div></div>`).join('')}
        ${none.length ? `<div class="tier-row"><div class="tier-label t0">${mode === 'ai' ? 'AI 미산출' : '투표 없음'}</div><div class="tier-cards">${none.map(chip).join('')}</div></div>` : ''}
      </div>`, 'tiers');
  }

  // ---------------------------------------------------------------- 오프닝 상세
  // FEN 파싱 결과 캐시 (같은 국면을 여러 번 그려도 한 번만 파싱)
  const fenCache = new Map();
  function fenGrid(fen) {
    let g = fenCache.get(fen);
    if (g) return g;
    g = fen.split(' ')[0].split('/').map((r) => { const out = []; for (const ch of r) { if (ch >= '1' && ch <= '8') for (let i = 0; i < +ch; i++) out.push(null); else out.push(ch); } return out; });
    fenCache.set(fen, g);
    return g;
  }
  function boardHtml(fen, flip, lastUci) {
    const grid = fenGrid(fen);
    const from = lastUci ? lastUci.slice(0, 2) : '', to = lastUci ? lastUci.slice(2, 4) : '';
    let html = '';
    for (let ri = 0; ri < 8; ri++) {
      for (let fi = 0; fi < 8; fi++) {
        const r = flip ? 7 - ri : ri, f = flip ? 7 - fi : fi;
        const file = 'abcdefgh'[f], rank = 8 - r, name = file + rank;
        const p = grid[r][f];
        const cls = ((r + f) % 2 === 0 ? 'l' : 'd') + (name === from || name === to ? ' hl' : '');
        const coords = (ri === 7 ? `<span class="coord f">${file}</span>` : '') + (fi === 0 ? `<span class="coord r">${rank}</span>` : '');
        const piece = p ? `<span class="pc ${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}"></span>` : '';
        html += `<div class="sq ${cls}">${coords}${piece}</div>`;
      }
    }
    return `<div class="board" role="img" aria-label="체스판 · ${esc(fen.split(' ')[0])}">${html}</div>`;
  }
  function movesHtml(o, ply) {
    let h = `<button data-act="ply" data-v="0" class="${ply === 0 ? 'on' : ''}">시작</button>`;
    o.san.forEach((m, i) => {
      if (i % 2 === 0) h += `<span class="num">${i / 2 + 1}.</span>`;
      h += `<button data-act="ply" data-v="${i + 1}" class="${ply === i + 1 ? 'on' : ''}">${esc(m)}</button>`;
    });
    return `<div class="moves">${h}</div>`;
  }
  const boardPly = (o) => clamp(S.ui.ply[o.id] ?? o.san.length, 0, o.san.length);
  const boardFlip = (o) => S.ui.flip[o.id] ?? (o.side === 'b');
  function boardBlockHtml(o) {
    const ply = boardPly(o), flip = boardFlip(o), n = o.san.length;
    return `${boardHtml(o.fens[ply], flip, ply > 0 ? o.uci[ply - 1] : null)}
      <div class="spread"><div class="row">
        <button class="btn sm" data-act="ply" data-v="0" aria-label="처음"${ply === 0 ? ' disabled' : ''}>⏮</button>
        <button class="btn sm" data-act="ply" data-v="${Math.max(0, ply - 1)}" aria-label="이전 수"${ply === 0 ? ' disabled' : ''}>◀</button>
        <button class="btn sm" data-act="ply" data-v="${Math.min(n, ply + 1)}" aria-label="다음 수"${ply === n ? ' disabled' : ''}>▶</button>
        <button class="btn sm" data-act="ply" data-v="${n}" aria-label="끝"${ply === n ? ' disabled' : ''}>⏭</button></div>
        <span class="mono small muted">${ply} / ${n}</span>
        <button class="btn sm" data-act="flip" data-o="${o.id}">판 뒤집기</button></div>
      ${movesHtml(o, ply)}`;
  }
  // 수 넘기기·뒤집기는 페이지 전체가 아니라 체스판 영역만 다시 그림 (깜빡임·스크롤 튐 없음)
  function updateBoard(o) {
    const box = document.getElementById('board-wrap');
    if (!box || Number(box.dataset.o) !== o.id) { render(); return; }
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    box.innerHTML = boardBlockHtml(o);
    if (focused) { const b = box.querySelector(`[aria-label="${focused}"]`); if (b && !b.disabled) b.focus(); }
  }
  function histHtml(dist, catId) {
    const counts = TIERS.map((t) => (dist.find((d) => d.category_id === catId && d.tier === t.n) || { n: 0 }).n);
    const max = Math.max(1, ...counts);
    return `<div class="hist" aria-label="티어별 투표 수">${counts.map((n, i) => `<span class="t${i + 1}" style="height:${n ? 8 + (n / max) * 92 : 0}%" title="${esc(TIERS[i].name)}: ${n}표"></span>`).join('')}</div>`;
  }
  function viewOpening(id) {
    const o = S.byId.get(id);
    if (!o) return shell(`<div class="card">그런 오프닝이 없어요. <a href="#tiers">티어로 돌아가기</a></div>`, 'tiers');
    const dist = S.cache.dist.get(id) || [];
    const posts = S.cache.posts && S.cache.posts.id === id ? S.cache.posts.rows : null;
    const fo = overallScore(id, 'final'), ao = overallScore(id, 'ai'), vo = overallScore(id, 'vote');
    const cards = S.categories.map((c) => {
      const a = catScore(id, c.id, 'ai'), v = catScore(id, c.id, 'vote'), f = catScore(id, c.id, 'final');
      const st = S.stats.get(key(id, c.id));
      const mine = S.my.get(key(id, c.id));
      const ai = S.ai.get(key(id, c.id));
      return `<div class="card cat-card">
        <div><h3>${esc(c.name)}</h3><div class="small muted">${esc(c.description)}</div></div>
        <div class="cat-nums">
          <div><span class="muted">AI${ai && ai.se ? ` ±${Math.round(ai.se)}` : ''}</span>${c.ai ? scoreBadge(a) : '<span class="badge t0">투표 전용</span>'}<span class="mono">${fmt(a)}</span></div>
          <div><span class="muted">투표 ${st ? st.n : 0}표</span>${scoreBadge(v)}<span class="mono">${fmt(v)}</span></div>
          <div><span class="muted">최종</span>${scoreBadge(f)}<span class="mono">${fmt(f)}</span></div>
        </div>
        ${histHtml(dist, c.id)}
        <div class="vote-grid" role="group" aria-label="${esc(c.name)} 투표">${TIERS.map((t) => `<button class="t${t.n}${mine === t.n ? ' on' : ''}" data-act="vote" data-o="${id}" data-c="${esc(c.id)}" data-t="${t.n}" aria-pressed="${mine === t.n}" title="${esc(t.name + ' · ' + t.desc)}">${esc(t.short)}</button>`).join('')}</div>
        <div class="small muted">${mine ? `내 표: <b>${esc(tierByN(mine).name)}</b> · 같은 칸을 다시 누르면 취소` : '아직 투표 안 함'}</div>
      </div>`;
    }).join('');
    return shell(`
      <div class="row small"><a href="#tiers">← 티어</a></div>
      <div class="op-head">
        <div class="board-wrap" id="board-wrap" data-o="${id}">${boardBlockHtml(o)}</div>
        <div class="stack">
          <div class="row"><span class="grp">${esc(GROUPS[o.grp] || o.grp)}</span><span class="small muted">${o.side === 'w' ? '백' : '흑'}이 고르는 오프닝 · ${o.san.length ? `정의 수순 ${o.san.length}수` : '<b>수순 미입력</b>'}</span></div>
          <h1>${esc(o.name)}</h1>
          <div class="verdict">
            <div><span class="lab">최종 판결</span>${scoreBadge(fo, true)}<span class="mono small">${fmt(fo)}</span></div>
            <div><span class="lab">AI</span>${scoreBadge(ao)}<span class="mono small">${fmt(ao)}</span></div>
            <div><span class="lab">우리 반 (${voteCount(id)}표)</span>${scoreBadge(vo)}<span class="mono small">${fmt(vo)}</span></div>
          </div>
          <p class="small muted">분야마다 아래 11칸 중 하나를 눌러 투표하세요. 종합은 AI 종합 점수를 출발점으로, 분야 투표의 가중 평균만큼 움직여요 (멘탈 파괴력은 종합에 안 들어감).</p>
        </div>
      </div>
      ${o.san.length ? '' : `<div class="banner"><b>수순이 아직 없어요.</b> 투표와 토론은 지금도 할 수 있고, AI 점수는 수순이 들어간 뒤 계산돼요.${S.user.role === 'admin' ? ' 아래 "수순 편집"에서 넣어 주세요.' : ' 관리자에게 수순을 알려 주세요.'}</div>`}
      ${S.user.role === 'admin' ? editorHtml(o) : ''}
      <div class="cat-grid">${cards}</div>
      <div class="card stack">
        <div class="spread"><h2>이 오프닝 토론</h2><a class="btn primary sm" href="#write-${id}">글쓰기</a></div>
        ${posts == null ? '<div class="muted small">불러오는 중…</div>' : postListHtml(posts, false)}
      </div>`, 'tiers');
  }

  // ---------------------------------------------------------------- 관리자: 수순 편집
  function editorHtml(o) {
    const open = S.ui.editOpen === o.id;
    const tsv = o.uci.length ? `${o.id}\t${o.slug}\t${o.side}\t${o.uci.join(' ')}` : '';
    if (!open) return `<div class="row"><button class="btn sm" data-act="edit-open" data-o="${o.id}">수순 편집 (관리자)</button></div>`;
    return `<form class="card stack" id="edit-form" data-o="${o.id}">
      <div class="spread"><h3>수순 편집</h3><button class="btn sm" type="button" data-act="edit-open" data-o="">닫기</button></div>
      <div class="field"><label for="f-san">수순 (SAN, 수 번호는 있어도 되고 없어도 됨)</label>
        <textarea class="textarea mono" id="f-san" name="san" style="min-height:70px" placeholder="1. e4 e5 2. Nf3 Nc6">${esc(o.san.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m).join(' '))}</textarea></div>
      <div class="field"><label for="f-side">이 오프닝을 고르는 쪽</label>
        <select class="select" id="f-side" name="side" style="max-width:200px"><option value="w"${o.side === 'w' ? ' selected' : ''}>백</option><option value="b"${o.side === 'b' ? ' selected' : ''}>흑</option></select></div>
      <div class="err" id="edit-err"></div>
      <div class="row"><button class="btn primary" type="submit">검사하고 저장</button></div>
      ${tsv ? `<div class="small muted">AI 배치용 줄 (batch/openings.tsv 에 붙여 넣기)</div><pre class="mono small" style="margin:0;overflow-x:auto;background:var(--surface-2);padding:8px;border-radius:6px">${esc(tsv)}</pre>` : ''}
    </form>`;
  }
  let chessJsPromise = null;
  function loadChessJs() {
    if (window.Chess) return Promise.resolve(window.Chess);
    if (!chessJsPromise) chessJsPromise = new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = CHESSJS_URL;
      sc.onload = () => (window.Chess ? res(window.Chess) : rej(new Error('체스 규칙 모듈을 읽지 못했어요.')));
      sc.onerror = () => { chessJsPromise = null; rej(new UserError('체스 규칙 모듈을 내려받지 못했어요. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(sc);
    });
    return chessJsPromise;
  }
  async function parseLine(text) {
    const Chess = await loadChessJs();
    const g = new Chess(); const san = [], uci = [], fens = [g.fen()];
    const tokens = text.replace(/\{[^}]*\}/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
    if (tokens.length > 40) throw new UserError('수순은 40수(반수)까지만 넣을 수 있어요.');
    for (const t of tokens) {
      const m = g.move(t.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O'), { sloppy: true });
      if (!m) throw new UserError(`${san.length + 1}번째 수 "${t}" 는 둘 수 없는 수예요.`);
      san.push(m.san); uci.push(m.from + m.to + (m.promotion || '')); fens.push(g.fen());
    }
    return { san, uci, fens };
  }

  // ---------------------------------------------------------------- 게시판
  function postListHtml(rows, showOpening = true) {
    if (!rows.length) return '<div class="muted small">아직 글이 없어요. 첫 판결문을 써 보세요.</div>';
    return `<div class="post-list">${rows.map((p) => `<a class="post-item" href="#post-${p.id}">
      <span class="t">${esc(p.title)}</span>
      <span class="meta"><span>${esc(p.nickname)}</span><span>${timeAgo(p.created_at)}</span>${showOpening && p.opening_name ? `<span>♟ ${esc(p.opening_name)}</span>` : ''}<span>♥ ${p.likes}</span><span>댓글 ${p.ncomments}</span></span></a>`).join('')}</div>`;
  }
  function viewBoard() {
    const kind = S.ui.boardKind;
    const rows = S.cache.board && S.cache.board.kind === kind ? S.cache.board.rows : null;
    return shell(`
      <div class="spread"><h1>토론 게시판</h1><a class="btn primary" href="#write">글쓰기</a></div>
      <div class="seg">${[['all', '전체'], ['free', '자유'], ['opening', '오프닝별']].map(([k, l]) => `<button data-act="board-kind" data-v="${k}" class="${kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="card">${rows == null ? '<div class="muted small">불러오는 중…</div>' : postListHtml(rows)}</div>`, 'board');
  }
  function reportBox(type, id) {
    const open = S.ui.reportOpen === type + '|' + id;
    if (!open) return `<button class="btn sm" data-act="report-open" data-type="${type}" data-id="${id}">신고</button>`;
    return `<span class="row">${['욕설·비하', '도배·광고', '기타'].map((r) => `<button class="btn sm danger" data-act="report" data-type="${type}" data-id="${id}" data-reason="${r}">${r}</button>`).join('')}<button class="btn sm" data-act="report-open" data-type="" data-id="">닫기</button></span>`;
  }
  function viewPost(id) {
    const d = S.cache.post && S.cache.post.id === id ? S.cache.post : null;
    if (!d) return shell('<div class="card muted">불러오는 중…</div>', 'board');
    const p = d.post;
    if (!p) return shell('<div class="card">삭제됐거나 없는 글이에요. <a href="#board">게시판으로</a></div>', 'board');
    const canDel = (uid) => uid === S.user.id || S.user.role === 'admin';
    const liked = S.likes.has('post|' + p.id);
    return shell(`
      <div class="row small"><a href="${p.opening_id ? '#opening-' + p.opening_id : '#board'}">← ${p.opening_id ? esc(p.opening_name) : '게시판'}</a></div>
      <article class="card stack">
        <h1>${esc(p.title)}</h1>
        <div class="small muted row"><span>${esc(p.nickname)}</span><span>${timeAgo(p.created_at)}</span>${p.opening_id ? `<a href="#opening-${p.opening_id}">♟ ${esc(p.opening_name)}</a>` : ''}</div>
        <div class="body-text">${esc(p.body)}</div>
        <div class="row">
          <button class="btn sm like${liked ? ' on' : ''}" data-act="like" data-type="post" data-id="${p.id}">♥ ${p.likes}</button>
          ${reportBox('post', p.id)}
          ${canDel(p.author) ? `<button class="btn sm danger" data-act="del-post" data-id="${p.id}">삭제</button>` : ''}
        </div>
      </article>
      <section class="card stack">
        <h2>댓글 ${d.comments.length}</h2>
        <div>${d.comments.map((c) => `<div class="comment">
          <div class="small muted row"><b style="color:var(--ink)">${esc(c.nickname)}</b><span>${timeAgo(c.created_at)}</span></div>
          <div class="body-text">${esc(c.body)}</div>
          <div class="row"><button class="btn sm like${S.likes.has('comment|' + c.id) ? ' on' : ''}" data-act="like" data-type="comment" data-id="${c.id}">♥ ${c.likes}</button>${reportBox('comment', c.id)}${canDel(c.author) ? `<button class="btn sm danger" data-act="del-comment" data-id="${c.id}">삭제</button>` : ''}</div>
        </div>`).join('') || '<div class="muted small">첫 댓글을 달아 보세요.</div>'}</div>
        <form id="comment-form" class="stack" data-post="${p.id}">
          <textarea class="textarea" id="f-comment" name="body" maxlength="2000" placeholder="반론, 증거, 판결 불복…" required style="min-height:80px"></textarea>
          <div class="row"><button class="btn primary" type="submit">댓글 달기</button></div>
        </form>
      </section>`, 'board');
  }
  function viewWrite(openingId) {
    return shell(`
      <div class="row small"><a href="${openingId ? '#opening-' + openingId : '#board'}">← 돌아가기</a></div>
      <h1>판결문 쓰기</h1>
      <form id="post-form" class="card stack">
        <div class="field"><label for="f-op">어떤 오프닝 이야기?</label>
          <select class="select" id="f-op" name="opening"><option value="">자유 주제</option>${S.openings.map((o) => `<option value="${o.id}"${o.id === openingId ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="f-title">제목</label><input class="input" id="f-title" name="title" maxlength="80" required></div>
        <div class="field"><label for="f-body">내용</label><textarea class="textarea" id="f-body" name="body" maxlength="5000" required></textarea></div>
        <div class="err" id="post-err"></div>
        <div class="row"><button class="btn primary" type="submit">올리기</button></div>
      </form>`, 'board');
  }

  // ---------------------------------------------------------------- 오늘의 법정
  function viewCourt() {
    const disputes = [], gaps = [], popular = [];
    for (const o of S.openings) {
      for (const c of S.categories) {
        const st = S.stats.get(key(o.id, c.id));
        if (!st || st.n < 3) continue;
        disputes.push({ o, c, v: st.sd, st });
        const a = S.ai.get(key(o.id, c.id));
        if (a) gaps.push({ o, c, v: st.mean - a.score, st, a });
      }
      popular.push({ o, v: voteCount(o.id) });
    }
    disputes.sort((a, b) => b.v - a.v); gaps.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)); popular.sort((a, b) => b.v - a.v);
    const myN = S.my.size, total = S.openings.length * S.categories.length;
    const empty = '<div class="muted small">투표가 3표 이상 모인 항목이 아직 없어요.</div>';
    return shell(`
      <h1>오늘의 법정</h1>
      <p class="muted small" style="margin-top:-8px">의견이 가장 갈린 사건, AI와 우리 반이 가장 다르게 본 사건을 모았어요. 투표 3표 이상인 항목만 나와요.</p>
      <div class="card stack"><div class="spread"><h3>내 재판 참여율</h3><span class="mono small">${myN} / ${total}</span></div><div class="bar"><span style="width:${(100 * myN / total).toFixed(1)}%"></span></div></div>
      <div class="card stack"><h2>논쟁 사건 TOP 10</h2><p class="small muted">투표 점수의 표준편차가 클수록 의견이 갈린 것</p>
        <div class="rank">${disputes.slice(0, 10).map((d, i) => `<a class="rank-item" href="#opening-${d.o.id}"><span class="no">${i + 1}</span><span><b>${esc(d.o.name)}</b> <span class="muted small">· ${esc(d.c.name)}</span></span><span class="mono small">σ ${fmt(d.v)} · ${d.st.n}표</span></a>`).join('') || empty}</div></div>
      <div class="card stack"><h2>AI vs 우리 반</h2><p class="small muted">+면 우리가 AI보다 후하게, −면 박하게 봤다는 뜻</p>
        <div class="rank">${gaps.slice(0, 10).map((d, i) => `<a class="rank-item" href="#opening-${d.o.id}"><span class="no">${i + 1}</span><span><b>${esc(d.o.name)}</b> <span class="muted small">· ${esc(d.c.name)}</span><br><span class="small">${tierBadge(tierOf(d.a.score))} → ${tierBadge(tierOf(d.st.mean))}</span></span><span class="mono small">${d.v > 0 ? '+' : ''}${fmt(d.v)}</span></a>`).join('') || empty}</div></div>
      <div class="card stack"><h2>가장 많이 재판받은 오프닝</h2>
        <div class="rank">${popular.slice(0, 5).filter((p) => p.v > 0).map((p, i) => `<a class="rank-item" href="#opening-${p.o.id}"><span class="no">${i + 1}</span><span><b>${esc(p.o.name)}</b></span><span class="mono small">${p.v}표</span></a>`).join('') || '<div class="muted small">아직 투표가 없어요.</div>'}</div></div>`, 'court');
  }

  // ---------------------------------------------------------------- 나
  function viewMe() {
    const total = S.openings.length * S.categories.length;
    const per = S.categories.map((c) => ({ c, n: [...S.my.keys()].filter((k) => k.endsWith('|' + c.id)).length }));
    return shell(`
      <h1>${esc(S.user.nickname)}</h1>
      <div class="row"><span class="grp">${S.user.role === 'admin' ? '관리자' : '배심원'}</span>${S.user.banned ? '<span class="badge t11">차단됨</span>' : ''}</div>
      <div class="card stack"><div class="spread"><h3>투표 진행률</h3><span class="mono small">${S.my.size} / ${total}</span></div>
        <div class="bar"><span style="width:${(100 * S.my.size / total).toFixed(1)}%"></span></div>
        <div class="table-wrap"><table class="plain"><thead><tr><th>분야</th><th>투표한 오프닝</th></tr></thead><tbody>${per.map((p) => `<tr><td>${esc(p.c.name)}</td><td class="mono">${p.n} / ${S.openings.length}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card stack"><h3>티어 이름표</h3>
        <div class="table-wrap"><table class="plain"><thead><tr><th>티어</th><th>설명</th><th>점수</th></tr></thead><tbody>${TIERS.map((t, i) => `<tr><td>${tierBadge(t)}</td><td>${esc(t.desc)}</td><td class="mono">${i === 0 ? '97 이상' : i === 10 ? '12 미만' : `${t.lo}~${TIERS[i - 1].lo}`}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="row">
        ${S.user.role === 'admin' ? '<a class="btn" href="#admin">관리자 도구</a>' : ''}
        <button class="btn" data-act="logout">로그아웃</button>
        ${api.demo ? '<button class="btn danger" data-act="demo-reset">데모 데이터 초기화</button>' : ''}
      </div>`, 'me');
  }

  // ---------------------------------------------------------------- 관리자
  function viewAdmin() {
    if (S.user.role !== 'admin') return shell('<div class="card">관리자만 볼 수 있어요.</div>', 'me');
    const d = S.cache.admin;
    if (!d) return shell('<div class="card muted">불러오는 중…</div>', 'me');
    return shell(`
      <div class="row small"><a href="#me">← 나</a></div>
      <h1>관리자 도구</h1>
      <form class="card stack" id="invite-form"><h3>초대 코드</h3>
        <p class="small muted">이 코드를 아는 사람만 가입할 수 있어요. 바꿔도 이미 가입한 사람은 그대로예요.</p>
        <div class="row"><input class="input" id="f-inv" name="code" value="${esc(d.invite)}" style="max-width:240px" minlength="4" required><button class="btn primary" type="submit">저장</button></div></form>
      <div class="card stack"><h3>처리 안 된 신고 ${d.reports.length}건</h3>
        ${d.reports.length ? `<div class="table-wrap"><table class="plain"><thead><tr><th>대상</th><th>사유</th><th>언제</th><th></th></tr></thead><tbody>${d.reports.map((r) => `<tr>
          <td>${r.target_type === 'post' ? `<a href="#post-${r.target_id}">글 #${r.target_id}</a>` : `댓글 #${r.target_id}`}</td><td>${esc(r.reason)}</td><td>${timeAgo(r.created_at)}</td>
          <td class="row">${r.target_type === 'post' ? `<button class="btn sm danger" data-act="del-post" data-id="${r.target_id}" data-report="${r.id}">글 삭제</button>` : `<button class="btn sm danger" data-act="del-comment" data-id="${r.target_id}" data-report="${r.id}">댓글 삭제</button>`}<button class="btn sm" data-act="resolve" data-id="${r.id}">문제없음</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">신고가 없어요.</div>'}</div>
      <div class="card stack"><h3>사용자 ${d.users.length}명</h3>
        <div class="table-wrap"><table class="plain"><thead><tr><th>닉네임</th><th>역할</th><th>상태</th><th></th></tr></thead><tbody>${d.users.map((u) => `<tr>
          <td>${esc(u.nickname)}</td><td>${u.role === 'admin' ? '관리자' : '배심원'}</td><td>${u.banned ? '차단' : '정상'}</td>
          <td class="row">${u.id === S.user.id ? '<span class="small muted">나</span>' : `<button class="btn sm" data-act="role" data-id="${u.id}" data-v="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? '관리자 해제' : '관리자 지정'}</button><button class="btn sm ${u.banned ? '' : 'danger'}" data-act="ban" data-id="${u.id}" data-v="${u.banned ? '0' : '1'}">${u.banned ? '차단 해제' : '차단'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`, 'me');
  }

  // ================================================================ 렌더·라우팅
  let lastRouteKey = '';
  function render() {
    const app = $('#app');
    if (S.loading) { app.innerHTML = '<div class="boot">법정 여는 중…</div>'; return; }
    const r = route();
    const rk = r.name + '-' + (r.arg || '');
    const keepScroll = rk === lastRouteKey ? window.scrollY : 0;
    const focusId = document.activeElement && document.activeElement.id;
    let html;
    if (!S.user) html = shell(viewLogin(S.ui.authTab || 'in'), '');
    else switch (r.name) {
      case 'opening': html = viewOpening(Number(r.arg)); break;
      case 'board': html = viewBoard(); break;
      case 'post': html = viewPost(Number(r.arg)); break;
      case 'write': html = viewWrite(r.arg ? Number(r.arg) : null); break;
      case 'court': html = viewCourt(); break;
      case 'me': html = viewMe(); break;
      case 'admin': html = viewAdmin(); break;
      default: html = viewTiers();
    }
    app.innerHTML = html;
    document.title = (r.name === 'opening' && S.byId.get(Number(r.arg)) ? S.byId.get(Number(r.arg)).name + ' · ' : '') + CFG.SITE_NAME;
    if (focusId === 'f-search') { const el = $('#f-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    window.scrollTo(0, keepScroll);
    lastRouteKey = rk;
  }

  // 화면 진입 시 필요한 데이터 비동기 로드
  async function onRoute() {
    render();
    if (!S.user) return;
    const r = route();
    try {
      if (r.name === 'opening') {
        const id = Number(r.arg);
        const [dist, rows] = await Promise.all([api.voteDist(id), api.listPosts({ openingId: id })]);
        S.cache.dist.set(id, dist); S.cache.posts = { id, rows };
      } else if (r.name === 'board') {
        S.cache.board = { kind: S.ui.boardKind, rows: await api.listPosts({ kind: S.ui.boardKind }) };
      } else if (r.name === 'post') {
        const id = Number(r.arg);
        const [post, comments] = await Promise.all([api.getPost(id), api.listComments(id)]);
        S.cache.post = { id, post, comments };
      } else if (r.name === 'admin' && S.user.role === 'admin') {
        const [invite, reports, users] = await Promise.all([api.getInvite(), api.listReports(), api.listUsers()]);
        S.cache.admin = { invite, reports, users };
      } else if (r.name === 'court' || r.name === 'tiers' || !r.name) {
        await refreshStats();
      } else return;
    } catch (e) { toast(errMsg(e), true); }
    if (route().name === r.name && route().arg === r.arg) render();
  }
  const errMsg = (e) => {
    if (e instanceof UserError) return e.message;
    const m = e && e.message ? e.message : String(e);
    if (/failed to fetch|networkerror|load failed/i.test(m)) return '서버에 연결하지 못했어요. 인터넷 연결이나 config.js 의 주소를 확인하세요.';
    if (/row-level security/i.test(m)) return '권한이 없어요. 차단된 계정이거나 다시 로그인해야 할 수 있어요.';
    return '문제가 생겼어요: ' + m;
  };

  async function afterLogin() {
    const [mine, likes] = await Promise.all([api.myVotes(S.user.id), api.myLikes(S.user.id)]);
    S.my = new Map(mine.map((v) => [key(v.opening_id, v.category_id), v.tier]));
    S.likes = likes;
  }

  // ================================================================ 이벤트
  const armed = new WeakMap();
  function confirmTwice(btn) { // confirm() 대신 두 번 누르기
    if (armed.get(btn)) return true;
    armed.set(btn, true); const old = btn.textContent;
    btn.classList.add('armed'); btn.textContent = '한 번 더 누르면 삭제';
    setTimeout(() => { if (btn.isConnected) { armed.delete(btn); btn.classList.remove('armed'); btn.textContent = old; } }, 3000);
    return false;
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const d = b.dataset;
    try {
      switch (d.act) {
        case 'auth-tab': S.ui.authTab = d.tab; render(); break;
        case 'mode': S.ui.mode = d.v; saveUi(); render(); break;
        case 'cat': S.ui.cat = d.v; saveUi(); render(); break;
        case 'grp': S.ui.grp = d.v; saveUi(); render(); break;
        case 'ply': { const o = S.byId.get(Number(route().arg)); if (!o) break; S.ui.ply[o.id] = clamp(Number(d.v), 0, o.san.length); updateBoard(o); break; }
        case 'flip': { const o = S.byId.get(Number(d.o)); if (!o) break; S.ui.flip[o.id] = !boardFlip(o); updateBoard(o); break; }
        case 'vote': {
          if (S.user.banned) throw new UserError('차단된 계정은 투표할 수 없어요.');
          const o = Number(d.o), c = d.c, t = Number(d.t), k = key(o, c);
          const prev = S.my.get(k);
          const next = prev === t ? null : t;
          if (next == null) S.my.delete(k); else S.my.set(k, next);
          render();
          try { await api.vote(S.user.id, o, c, next); }
          catch (e) { if (prev == null) S.my.delete(k); else S.my.set(k, prev); render(); throw e; }
          const [, dist] = await Promise.all([refreshStats(), api.voteDist(o)]);
          S.cache.dist.set(o, dist); render();
          toast(next == null ? '투표를 취소했어요' : `${tierByN(next).name} 판결 완료`);
          break;
        }
        case 'edit-open': S.ui.editOpen = d.o ? Number(d.o) : null; render(); break;
        case 'board-kind': S.ui.boardKind = d.v; S.cache.board = null; onRoute(); break;
        case 'like': {
          const k = d.type + '|' + d.id, on = !S.likes.has(k);
          await api.like(S.user.id, d.type, Number(d.id), on);
          if (on) S.likes.add(k); else S.likes.delete(k);
          await onRoute(); break;
        }
        case 'report-open': S.ui.reportOpen = d.type ? d.type + '|' + d.id : null; render(); break;
        case 'report': await api.report(S.user.id, d.type, Number(d.id), d.reason); S.ui.reportOpen = null; render(); toast('신고했어요. 관리자가 확인할게요.'); break;
        case 'del-post':
          if (!confirmTwice(b)) break;
          await api.deletePost(Number(d.id)); if (d.report) await api.resolveReport(Number(d.report));
          toast('글을 삭제했어요');
          if (route().name === 'post') location.hash = '#board'; else onRoute();
          break;
        case 'del-comment':
          if (!confirmTwice(b)) break;
          await api.deleteComment(Number(d.id)); if (d.report) await api.resolveReport(Number(d.report));
          toast('댓글을 삭제했어요'); onRoute(); break;
        case 'resolve': await api.resolveReport(Number(d.id)); onRoute(); break;
        case 'role': await api.setRole(d.id, d.v); toast('역할을 바꿨어요'); onRoute(); break;
        case 'ban': await api.setBanned(d.id, d.v === '1'); toast(d.v === '1' ? '차단했어요' : '차단을 풀었어요'); onRoute(); break;
        case 'logout': await api.signOut(); S.user = null; S.my = new Map(); S.likes = new Set(); location.hash = '#tiers'; render(); break;
        case 'demo-reset':
          if (!confirmTwice(b)) break;
          api.reset(); location.hash = '#tiers'; location.reload(); break;
      }
    } catch (e) { toast(errMsg(e), true); }
  });

  let searchTimer = 0;
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'f-search') {
      clearTimeout(searchTimer);
      const v = ev.target.value;
      searchTimer = setTimeout(() => { S.ui.search = v.trim(); render(); }, 180);
    }
  });

  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    ev.preventDefault();
    const btn = f.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (f.id === 'auth-form') {
        const nick = f.nick.value, pw = f.pw.value;
        $('#auth-err').textContent = '';
        if (normNick(nick).length < 2) throw new UserError('닉네임은 2자 이상이어야 해요.');
        if (badWord(nick)) throw new UserError('닉네임에 쓸 수 없는 말이 있어요.');
        S.user = f.dataset.mode === 'up' ? await api.signUp(nick, pw, f.invite.value) : await api.signIn(nick, pw);
        if (!S.user) throw new UserError('로그인 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
        if (!api.demo) setCore(await api.loadCore());
        await afterLogin();
        toast(`${S.user.nickname} 배심원 입장`);
        onRoute();
      } else if (f.id === 'post-form') {
        const title = f.title.value.trim(), body = f.body.value.trim(), openingId = f.opening.value ? Number(f.opening.value) : null;
        const w = badWord(title + body);
        if (w) throw new UserError('쓸 수 없는 말이 들어 있어요. 고쳐서 다시 올려 주세요.');
        if (!title || !body) throw new UserError('제목과 내용을 모두 써 주세요.');
        const id = await api.createPost(S.user.id, { title, body, openingId });
        toast('올렸어요'); location.hash = '#post-' + id;
      } else if (f.id === 'comment-form') {
        const body = f.body.value.trim();
        if (!body) throw new UserError('내용을 써 주세요.');
        if (badWord(body)) throw new UserError('쓸 수 없는 말이 들어 있어요.');
        await api.createComment(S.user.id, Number(f.dataset.post), body);
        await onRoute();
      } else if (f.id === 'edit-form') {
        const id = Number(f.dataset.o), o = S.byId.get(id);
        const line = await parseLine(f.san.value);
        const patch = { san: line.san, uci: line.uci, fens: line.fens, side: f.side.value };
        await api.updateOpening(id, patch);
        const next = { ...o, ...patch };
        S.openings = S.openings.map((x) => (x.id === id ? next : x)); S.byId.set(id, next);
        S.ui.ply[id] = line.san.length;
        toast(line.san.length ? `수순 ${line.san.length}수 저장` : '수순을 비웠어요');
        render();
      } else if (f.id === 'invite-form') {
        await api.setInvite(f.code.value); toast('초대 코드를 바꿨어요'); onRoute();
      }
    } catch (e) {
      const msg = errMsg(e);
      const box = f.querySelector('.err');
      if (box) box.textContent = msg; else toast(msg, true);
    } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '')) return;
    const r = route(); if (r.name !== 'opening' || !S.user) return;
    const o = S.byId.get(Number(r.arg)); if (!o) return;
    const ply = boardPly(o), map = { ArrowLeft: ply - 1, ArrowRight: ply + 1, Home: 0, End: o.san.length };
    if (!(ev.key in map)) return;
    ev.preventDefault(); S.ui.ply[o.id] = clamp(map[ev.key], 0, o.san.length); updateBoard(o);
  });

  window.addEventListener('hashchange', onRoute);

  // ================================================================ 시작
  (async function boot() {
    try {
      setCore(await (async () => {
        // 로그인 전에는 Supabase가 오프닝을 안 보여 주므로(RLS) 시드 데이터로 먼저 띄움
        if (!api.demo) return { openings: SEED.openings, categories: SEED.categories, ai: [], aiPlaceholder: false, stats: [] };
        return api.loadCore();
      })());
      S.user = await api.session();
      if (S.user) {
        if (!api.demo) setCore(await api.loadCore());
        await afterLogin();
      }
      if (!api.demo && api.sb) {
        api.sb.auth.onAuthStateChange(async (evt) => {
          if (evt === 'SIGNED_OUT') { S.user = null; render(); }
        });
      }
    } catch (e) {
      $('#app').innerHTML = `<main><div class="card">서버에 연결하지 못했어요: ${esc(e.message)}<br><span class="small muted">config.js의 SUPABASE_URL·키, 그리고 SQL 실행 여부를 확인하세요.</span></div></main>`;
      return;
    }
    S.loading = false;
    onRoute();
  })();
})();
