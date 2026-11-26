/**
 * 读书台同步引擎（宿主侧版本）。
 *
 * 这段逻辑与 assets/index.html 里的同名函数逐字一致，只把网络出口换成可注入的
 * fetchImpl，所以宿主跑出来的数据和页面跑出来的一致；页面以后不再自己跑同步。
 */
export const SYNC_GAP_MS = 120
export const GATEWAY = "https://i.weread.qq.com/api/agent/gateway"

const VER = "1.0.5"
const ERR_HINT = {
  "-2013": "API Key 无效或已过期",
  "-202": "微信读书暂时限制访问，已自动重试",
  "-2012": "请求参数不被接受",
  "-2014": "接口暂时不可用",
}
const isSyncRecord = v => !!v && typeof v === "object" && !Array.isArray(v)

export function createSyncEngine({ fetchImpl = globalThis.fetch, gateway = GATEWAY } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("缺少 fetch 实现")

  /* 以下与页面里同名声明逐字一致（节流排队状态 + 日期/作者helpers） */
  let nextRequestAt = 0, cooldownUntil = 0
  const pad = n => String(n).padStart(2, "0")
  const ymOf = t => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }
  const ymdOf = t => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
  const ts = (y, m, d = 15) => Math.floor(new Date(y, m - 1, d, 12).getTime() / 1000)
  const shortAuthor = a => (a || "").split(" ")[0]
  const SYNC_NOTE_RECHECK_INTERVAL = 24 * 60 * 60 * 1000
  const SYNC_NOTE_RECHECK_LIMIT = 5

  async function run(key, step, syncCache = null) {
    const controller = new AbortController();
    const { signal } = controller;
    const sleep = ms => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, Math.min(Math.ceil(ms), 2147483647));
      signal.addEventListener("abort", abort, { once: true });
    });

    async function pmap(arr, n, fn) {
      const out = new Array(arr.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
        try {
          while (!signal.aborted && i < arr.length) {
            const k = i++;
            out[k] = await fn(arr[k], k);
          }
        } catch (error) {
          controller.abort(error);
        }
      }));
      signal.throwIfAborted();
      return out;
    }
    const previous = syncCache?.previous;
    const next = syncCache?.next;
    const startedAt = Date.now();
    function matchingCache(type, id, signature) {
      const records = previous?.[type];
      const old = records && Object.hasOwn(records, id) ? records[id] : null;
      const value = old?.value;
      const valid = type === "progress"
        ? Number.isFinite(value?.progress) && Number.isFinite(value.readSecs) && Number.isFinite(value.finishTime)
        : Array.isArray(value?.reviews) && Array.isArray(value.marks?.chapters) && Array.isArray(value.marks?.updated);
      return valid && old.signature === signature && Number.isFinite(old.at) && old.at <= startedAt ? old : null;
    }
    async function cached(type, id, signature, fetchValue, recheck = false) {
      if (!next) return fetchValue();
      const old = recheck ? null : matchingCache(type, id, signature);
      if (old) {
        next[type][id] = old;
        return old.value;
      }
      const fresh = await fetchValue();
      updatedBooks++;                 // 真正发生网络请求（缓存未命中或轮换补查）
      report();
      next[type][id] = { signature, value: fresh, at: Date.now() };
      return fresh;
    }
    let calls = 0, requestQueue = Promise.resolve();
    let doneBooks = 0, totalBooks = 0, updatedBooks = 0;
    const report = () => { if (step) step(calls, doneBooks, totalBooks, updatedBooks); };
    function dispatch(body) {
      let response;
      const turn = requestQueue.then(async () => {
        for (;;) {
          signal.throwIfAborted();
          const now = performance.now();
          const delay = Math.max(nextRequestAt, cooldownUntil) - now;
          if (delay <= 0) {
            const headers = { "Content-Type": "application/json" };
            if (key) headers.Authorization = "Bearer " + key;
            nextRequestAt = performance.now() + SYNC_GAP_MS;
            response = fetchImpl(gateway, { method: "POST", headers, body, signal });
            return;   // 只串行安排发出时间，响应仍可并行等待
          }
          await sleep(delay);
        }
      });
      requestQueue = turn.catch(() => {});
      return turn.then(() => response);
    }

    function pauseGateway(response, attempt) {
      const retryAfter = response.headers.get("retry-after");
      const wait = retryAfter == null ? 0 : /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      const delay = Math.max(3000 * (attempt + 1), Number.isFinite(wait) ? wait : 0);
      cooldownUntil = Math.max(cooldownUntil, performance.now() + delay);
    }

    async function api(name, params = {}) {
      const body = JSON.stringify({ api_name: name, skill_version: VER, ...params });
      for (let a = 0; ; a++) {
        let r;
        try {
          r = await dispatch(body);
        } catch (e) {
          signal.throwIfAborted();
          throw new Error("网络连接失败，请稍后再试");
        }
        const rateLimited = r.status === 429;
        if (rateLimited) pauseGateway(r, a);
        let d = null; try { d = await r.json(); } catch (e) {}
        signal.throwIfAborted();
        calls++; report();
        if (r.status === 401 || r.status === 403) throw new Error("API Key 无效或已过期");
        const code = d?.errcode ? String(d.errcode) : "";
        if (rateLimited || code === "-202") {
          if (!rateLimited) pauseGateway(r, a);
          if (a < 2) continue;
          throw new Error("微信读书暂时限制访问，已自动重试（" + (code ? "errcode " + code : "HTTP 429") + " · " + name + "）");
        }
        if (code) {
          const hint = ERR_HINT[code] || d.errmsg || "接口返回错误";
          throw new Error(hint + "（errcode " + code + " · " + name + "）");
        }
        if (r.ok && d) {
          if (next && !isSyncRecord(d)) throw new Error("微信读书返回的数据格式有误，请重试");
          return d;
        }
        if (a >= 2) throw new Error("接口暂时不可用（" + r.status + " · " + name + "）");
        await sleep(1500 * (a + 1));
      }
    }
    const now = new Date(), Y = now.getFullYear(), M = now.getMonth() + 1, MONTH = `${Y}-${pad(M)}`;
    const TODAY = `${MONTH}-${pad(now.getDate())}`;

    /* 1. 书架 */
    const shelf = await api("/shelf/sync");
    if (next && !Array.isArray(shelf.books) && !(shelf.books == null && shelf.bookCount === 0)) {
      throw new Error("微信读书返回的书架数据不完整，请重试");
    }
    const books = (shelf.books || []).filter(b => (b.title || "").trim());
    const byid = Object.fromEntries(books.map(b => [String(b.bookId), b]));
    const shelfTotal = books.length + (shelf.albums || []).length + (shelf.mp ? 1 : 0);
    const cardOf = (b, extra = {}) => {
      const cat = (b.category || "").trim();
      return { bookId: String(b.bookId), title: b.title, author: shortAuthor(b.author), cover: (b.cover || "").replace("/s_", "/t7_"),
        category: cat, theme: cat ? cat.split("-").pop().trim() : "", ...extra };
    };

    /* 2. 阅读统计：今年每个月 + 历年 */
    const monthly = [], yearHeat = {}, heat = {}, longest = {};
    let cats = [], monthSecs = {};
    async function getStats(mode, baseTime) {
      const data = await api("/readdata/detail", { mode, baseTime });
      if (next && !["baseTime", "totalReadTime", "readDays", "readTimes", "readLongest"].some(field => Object.hasOwn(data, field))) {
        throw new Error("微信读书返回的阅读统计不完整，请重试");
      }
      return data;
    }
    for (let m = 1; m <= M; m++) {
      const d = await getStats("monthly", ts(Y, m));
      const key = `${Y}-${pad(m)}`;
      monthly.push({ month: key, hours: Math.round((d.totalReadTime || 0) / 360) / 10, days: d.readDays || 0 });
      for (const [k, v] of Object.entries(d.readTimes || {})) {
        const t = new Date(Number(k) * 1000);
        if (t.getFullYear() === Y && t.getMonth() + 1 === m) {
          yearHeat[ymdOf(Number(k))] = Math.round((v || 0) / 60);
          if (m === M) heat[String(t.getDate())] = Math.round((v || 0) / 60);
        }
      }
      longest[key] = (d.readLongest || []).map(x => x.book).filter(Boolean);
      if (m === M) {
        monthSecs = Object.fromEntries((d.readLongest || []).filter(x => x.book).map(x => [String(x.book.bookId), x.readTime || 0]));
        cats = (d.preferCategory || []).filter(c => (c.readingTime || 0) > 0).slice(0, 6)
          .map(c => ({ name: c.categoryTitle || "未分类", hours: Math.round((c.readingTime || 0) / 360) / 10, count: c.readingCount || 0 }));
      }
    }
    const readYears = [...new Set(books.filter(b => b.readUpdateTime).map(b => new Date(b.readUpdateTime * 1000).getFullYear()))].sort((a, b) => b - a);
    const yearHours = {};
    for (const y of readYears) {
      const d = await getStats("annually", ts(y, 6));
      yearHours[y] = Math.round((d.totalReadTime || 0) / 360) / 10;
    }

    /* 3. 读完时间：今年读过的书逐本查进度 */
    const thisYear = books.filter(b => b.readUpdateTime && new Date(b.readUpdateTime * 1000).getFullYear() === Y);
    const finishMonth = {}, progress = {}, readSecs = {};
    const getProg = async b => {
      const id = String(b.bookId);
      const signature = JSON.stringify([b.readUpdateTime, b.finishReading]);
      const p = await cached("progress", id, signature, async () => {
        const data = await api("/book/getprogress", { bookId: id });
        if (next && !isSyncRecord(data.book) && !(data.book == null && String(data.bookId) === id)) {
          throw new Error("微信读书返回的阅读进度不完整，请重试");
        }
        const book = data.book || {};
        return { progress: book.progress || 0, readSecs: book.readingTime || book.recordReadingTime || 0, finishTime: book.finishTime || 0 };
      });
      progress[b.bookId] = p.progress || 0;
      readSecs[b.bookId] = p.readSecs;
      return p;
    };
    totalBooks += thisYear.length;
    const yearProgress = await pmap(thisYear, 2, async b => { const r = await getProg(b); doneBooks++; report(); return r; });
    thisYear.forEach((b, i) => {
      const p = yearProgress[i], id = String(b.bookId);
      if (p.progress === 100 && p.finishTime) finishMonth[id] = ymOf(p.finishTime);
      else if (b.finishReading) finishMonth[id] = ymOf(b.readUpdateTime);
    });

    const walls = [];
    for (let m = M; m >= 1; m--) {
      const key = `${Y}-${pad(m)}`;
      const ids = new Set(Object.keys(finishMonth).filter(id => finishMonth[id] === key));
      thisYear.forEach(b => { if (ymOf(b.readUpdateTime) === key) ids.add(String(b.bookId)); });
      (longest[key] || []).forEach(x => x.bookId && ids.add(String(x.bookId)));
      const items = [...ids].map(id => byid[id]).filter(b => b && b.cover).map(b => cardOf(b, { done: finishMonth[String(b.bookId)] === key }))
        .sort((a, b) => (a.done === b.done ? a.title.localeCompare(b.title) : a.done ? -1 : 1));
      const mo = monthly.find(x => x.month === key);
      walls.push({ month: key, items: items.slice(0, 36), total: items.length, done: items.filter(x => x.done).length, hours: mo.hours, days: mo.days });
    }
    const years = readYears.map(y => {
      const items = books.filter(b => b.readUpdateTime && b.cover && new Date(b.readUpdateTime * 1000).getFullYear() === y)
        .map(b => cardOf(b, { done: y === Y ? (finishMonth[String(b.bookId)] || "").startsWith(String(y)) : !!b.finishReading }))
        .sort((a, b) => (a.done === b.done ? a.title.localeCompare(b.title) : a.done ? -1 : 1));
      return { year: y, total: items.length, done: items.filter(x => x.done).length, hours: yearHours[y] || 0, items: items.slice(0, 120) };
    });
    const yearDone = Object.keys(finishMonth).filter(id => finishMonth[id].startsWith(String(Y)) && byid[id] && byid[id].cover).map(id => cardOf(byid[id], { done: true }));

    /* 4. 本月书单：最近在读、还没读完的书 */
    const reading = books.filter(b => !b.finishReading && b.cover && b.readUpdateTime).sort((a, b) => b.readUpdateTime - a.readUpdateTime);
    const dim = new Date(Y, M, 0).getDate();
    const plan = [];
    for (const [i, b] of reading.slice(0, 8).entries()) {
      if (!(b.bookId in progress)) await getProg(b);
      const s = 1 + i * 3, id = String(b.bookId);
      plan.push(cardOf(b, { target: progress[b.bookId] >= 50 ? "读完" : "继续读", progress: Math.round(progress[b.bookId]) / 100,
        hours: Math.round(readSecs[b.bookId] / 360) / 10, monthMin: Math.round((monthSecs[id] || 0) / 60),
        dayStart: Math.min(s, dim), dayEnd: Math.min(s + 8, dim), band: i % 4 }));
    }
    const candidates = reading.slice(8, 40).map(b => cardOf(b));

    /* 5. 笔记：概览 + 每本书最多 8 条划线（有想法的排前面） */
    let lastSort = null, noteTotal = 0;
    const cursors = new Set(), notebooks = new Map();
    for (;;) {
      const page = await api("/user/notebooks", { count: 100, ...(lastSort ? { lastSort } : {}) });
      if (next && (!Array.isArray(page.books) && !(page.books == null && page.totalBookCount === 0) ||
          ![true, false, 0, 1].includes(page.hasMore))) {
        throw new Error("微信读书返回的笔记列表不完整，请重试");
      }
      const pageBooks = page.books || [];
      noteTotal = page.totalNoteCount ?? noteTotal;
      for (const item of pageBooks) {
        const id = String(item?.bookId ?? "");
        if (next && (!id || notebooks.has(id))) {
          throw new Error("微信读书返回的笔记列表不完整，请重试");
        }
        if (!notebooks.has(id)) notebooks.set(id, item);
      }
      if (!page.hasMore) break;
      if (!next && !pageBooks.length) break;
      lastSort = pageBooks.at(-1)?.sort;
      if (next && (!lastSort || cursors.has(String(lastSort)))) {
        throw new Error("微信读书的笔记列表翻页失败，请重试");
      }
      cursors.add(String(lastSort));
    }

    const targets = [...new Set([...walls.flatMap(w => w.items.map(x => x.bookId)).filter(id => notebooks.has(id)),
      ...[...notebooks.keys()].slice(0, 12)])];
    const noteTargets = targets.map(id => {
      const notebook = notebooks.get(id);
      const signature = JSON.stringify([notebook.sort, notebook.reviewCount, notebook.noteCount]);
      return { id, signature, old: matchingCache("notes", id, signature) };
    });
    // 时间只决定补查顺序，缺缓存或签名变化的书照常更新。
    const recheckNotes = new Set(noteTargets
      .filter(({ old }) => old && startedAt - old.at >= SYNC_NOTE_RECHECK_INTERVAL)
      .sort((a, b) => a.old.at - b.old.at)
      .slice(0, SYNC_NOTE_RECHECK_LIMIT)
      .map(({ id }) => id));
    const highlights = {};
    totalBooks += noteTargets.length;
    await pmap(noteTargets, 2, async ({ id: bid, signature }) => {
      const { reviews, marks } = await cached("notes", bid, signature, async () => {
        const response = await api("/review/list/mine", { bookid: bid, count: 50 });
        if (next && !Array.isArray(response.reviews) && !(response.reviews == null && response.totalCount === 0)) {
          throw new Error("微信读书返回的想法数据不完整，请重试");
        }
        const marks = await api("/book/bookmarklist", { bookId: bid });
        if (next && !Array.isArray(marks.updated) &&
            !(marks.updated == null && (Array.isArray(marks.chapters) || isSyncRecord(marks.book)))) {
          throw new Error("微信读书返回的划线数据不完整，请重试");
        }
        return { reviews: response.reviews || [], marks: { chapters: marks.chapters || [], updated: marks.updated || [] } };
      }, recheckNotes.has(bid));
      const thoughts = reviews.map(r => r.review || {}).filter(r => (r.abstract || "").trim() && (r.content || "").trim());
      const chaps = Object.fromEntries((marks.chapters || []).map(c => [c.chapterUid, c.title || ""]));
      const near60 = t => Math.abs(t.length - 60);
      const lines = [
        ...thoughts.sort((a, b) => near60(a.abstract) - near60(b.abstract)).map(r => ({ text: r.abstract.trim(), note: r.content.trim(),
          date: ymdOf(r.createTime || 0), chapter: r.chapterName || chaps[r.chapterUid] || "" })),
        ...(marks.updated || []).filter(x => { const n = (x.markText || "").trim().length; return n >= 16 && n <= 140; })
          .sort((a, b) => near60(a.markText.trim()) - near60(b.markText.trim()))
          .map(x => ({ text: x.markText.trim(), note: "", date: ymdOf(x.createTime || 0), chapter: chaps[x.chapterUid] || "" })),
      ];
      const seen = new Set(), uniq = lines.filter(l => !seen.has(l.text) && seen.add(l.text)).slice(0, 8);
      if (!uniq.length) { doneBooks++; report(); return; }
      highlights[bid] = { ...uniq[0], more: uniq.slice(1) };
      doneBooks++; report();
    });
    const cards = [];
    // 回顾卡：有想法的划线优先，不够 12 张再用普通划线补
    const order = [...targets.filter(id => highlights[id] && highlights[id].note), ...targets.filter(id => highlights[id] && !highlights[id].note)];
    for (const bid of order) {
      const h = highlights[bid]; if (cards.length >= 12) break;
      const b = byid[bid] || notebooks.get(bid)?.book || {};
      if (!b.title) continue;
      const n = cards.length + 1;
      cards.push({ id: n, fileNo: `${h.date}-${String(n).padStart(4, "0")}`, kind: h.date.slice(5) === TODAY.slice(5) ? "那年今日" : "随机调阅",
        date: h.date, book: b.title, author: shortAuthor(b.author), chapter: h.chapter, text: h.text, note: h.note, ts: 0, cover: (b.cover || "").replace("/s_", "/t7_"), bookId: bid });
    }
    const at = `${TODAY} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return {
      month: MONTH, monthLabel: `${Y} 年 ${M} 月`, today: TODAY,
      totals: { shelf: shelfTotal, finished: books.filter(b => b.finishReading).length, notes: noteTotal },
      plan, candidates, monthly, cats, heat, yearHeat, walls, years, yearDone,
      cards, highlights,
      source: `微信读书 API · ${at} 拉取`, syncedAt: at, calls,
    };
  }
  return { run }
}
