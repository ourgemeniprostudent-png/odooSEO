"use strict";

const $ = (s) => document.querySelector(s);
// Opened inside the Mac app's notch panel (narrow layout).
if (/[?&]shell=notch\b/.test(location.search)) document.documentElement.classList.add("in-notch");
const state = {
  day: isoDay(new Date()),
  followToday: true,        // on today's page → move to the new day after midnight
  tab: loadJSON("karnama.tab", "done"),
  tags: [],
  data: { done: [], todo: [], carried: [], summary: null },
  filter: "all",            // "all" | "none" | tag id
  composeTags: new Set(loadJSON("karnama.composeTags", [])),
  voiceUsed: false,
  settings: {},
};

// ---------- helpers ----------
function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseDay(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); }
const todayIso = () => isoDay(new Date());
const faParts = new Intl.DateTimeFormat("en-US-u-ca-persian", { day: "numeric", month: "numeric", year: "numeric" });
const MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const WEEKDAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
function jalali(s) {
  const p = Object.fromEntries(faParts.formatToParts(parseDay(s)).map((x) => [x.type, x.value]));
  return { y: +p.year.replace(/\D/g, ""), m: +p.month, d: +p.day };
}
// Built by hand so the output is identical in every browser (e.g. «جمعه ۳ مهر ۱۴۰۵»).
function faDay(s, withYear = true) {
  const j = jalali(s);
  return toFa(`${WEEKDAYS[parseDay(s).getDay()]} ${j.d} ${MONTHS[j.m - 1]}${withYear ? " " + j.y : ""}`);
}
const FA = "۰۱۲۳۴۵۶۷۸۹";
const toFa = (s) => String(s).replace(/\d/g, (d) => FA[d]);
const hhmm = (iso) => iso.slice(11, 16);
// Persian (۰-۹) and Arabic (٠-٩) digits → Latin, so either keyboard works in number fields.
const toEn = (s) => String(s).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
// Minutes field: "45", "۴۵", or hours:minutes like "1:30" / "۱:۳۰". Returns null (empty) or NaN (invalid).
function parseMinutes(raw) {
  const v = toEn(raw).trim().replace(/[٫،,]/g, ".").replace(/\s+/g, "");
  if (!v) return null;
  let m = v.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = v.match(/^\d+$/);
  const n = m ? +v : NaN;
  return n >= 0 && n <= 1440 ? n : NaN;
}
function minutesField(input) {
  const n = parseMinutes(input.value);
  if (Number.isNaN(n)) {
    input.focus(); input.select();
    throw new ApiError("مدت را به دقیقه بنویسید (مثلاً ۴۵) یا ساعت:دقیقه (مثلاً ۱:۳۰).");
  }
  return n;
}
function duration(min) {
  if (!min) return "";
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} دقیقه`;
  return m ? `${h} ساعت و ${m} دقیقه` : `${h} ساعت`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
}
class ApiError extends Error { constructor(msg, extra) { super(msg); this.extra = extra || {}; } }
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    if (typeof d === "string") throw new ApiError(d);
    if (d && typeof d.message === "string") throw new ApiError(d.message, d);
    throw new ApiError("درخواست ناموفق بود");
  }
  return data;
}
const tagById = (id) => state.tags.find((t) => t.id === id);
const activeTags = () => state.tags.filter((t) => !t.archived);
const PALETTE = ["#1d6d5a", "#2f5fb3", "#b5621b", "#8a3fa8", "#b3261e", "#2c8a9e", "#6b7d1f", "#c2417a"];
const nextColor = () => PALETTE[state.tags.length % PALETTE.length];
async function newTagPrompt() {
  const name = prompt("نام تگ جدید:");
  if (!name || !name.trim()) return null;
  try {
    const t = await api("POST", "/api/tags", { name: name.trim(), color: nextColor() });
    state.tags.push(t);
    return t;
  } catch (e) { toast(e.message, true); return null; }
}

// ---------- loading ----------
async function loadTags() {
  state.tags = await api("GET", "/api/tags");
  for (const id of [...state.composeTags]) if (!tagById(id)) state.composeTags.delete(id);
}
async function loadDay() {
  state.data = await api("GET", `/api/day/${state.day}`);
}
async function refresh() {
  await Promise.all([loadTags(), loadDay()]);
  render();
}

// ---------- rendering ----------
function chip(tag, on, extra = "") {
  return `<button type="button" class="chip${on ? " on" : ""}" style="--c:${tag.color}" data-tag="${tag.id}" ${extra}>${esc(tag.name)}</button>`;
}
function currentList() {
  return state.tab === "done" ? state.data.done : state.data.todo;
}
function render() {
  const today = todayIso();
  const isToday = state.day === today;
  $("#dayTitle").textContent = (isToday ? "امروز، " : "") + faDay(state.day);
  $("#todayBtn").hidden = isToday;
  document.body.classList.toggle("todo", state.tab === "todo");

  // tabs
  const openTodo = state.data.todo.length + state.data.carried.length;
  $("#doneCount").textContent = toFa(state.data.done.length);
  $("#todoCount").textContent = toFa(openTodo);
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));

  // composer
  $("#text").placeholder = state.tab === "done"
    ? "چه کاری انجام دادی؟ بنویس یا دکمهٔ میکروفون را بزن و بگو…"
    : "چه کاری باید انجام بدی؟ بنویس یا با صدا بگو…";
  $("#saveLabel").textContent = state.tab === "done" ? "ثبت کار" : "افزودن تسک";
  $("#composeTags").innerHTML =
    activeTags().map((t) => chip(t, state.composeTags.has(t.id))).join("") +
    `<button type="button" class="chip add" id="quickTag">+ تگ جدید</button>`;

  renderSummary();

  // filter chips (for the visible tab)
  const all = currentList();
  const counts = {};
  let untagged = 0;
  for (const e of all) {
    if (!e.tag_ids.length) untagged++;
    for (const id of e.tag_ids) counts[id] = (counts[id] || 0) + 1;
  }
  if (typeof state.filter === "number" && !counts[state.filter]) state.filter = "all";
  if (state.filter === "none" && !untagged) state.filter = "all";
  const used = state.tags.filter((t) => counts[t.id]);
  $("#filterTags").innerHTML = all.length
    ? `<button class="chip${state.filter === "all" ? " on" : ""}" data-filter="all">همه<span class="n">${toFa(all.length)}</span></button>` +
      used.map((t) => `<button class="chip${state.filter === t.id ? " on" : ""}" style="--c:${t.color}" data-filter="${t.id}">${esc(t.name)}<span class="n">${toFa(counts[t.id])}</span></button>`).join("") +
      (untagged ? `<button class="chip${state.filter === "none" ? " on" : ""}" style="--c:#b3261e" data-filter="none">بدون تگ<span class="n">${toFa(untagged)}</span></button>` : "")
    : "";

  const match = (e) => state.filter === "all" ? true : state.filter === "none" ? !e.tag_ids.length : e.tag_ids.includes(state.filter);
  const list = all.filter(match);
  const total = all.reduce((s, e) => s + (e.minutes || 0), 0);
  $("#dayStats").textContent = state.tab === "done" && all.length
    ? `${toFa(all.length)} کار${total ? "، " + toFa(duration(total)) : ""}` : "";
  $("#entries").innerHTML = list.map(entryHTML).join("");

  const carried = state.tab === "todo" ? state.data.carried.filter(match) : [];
  $("#carriedWrap").hidden = !carried.length;
  $("#carried").innerHTML = carried.map(entryHTML).join("");

  $("#empty").hidden = list.length > 0 || carried.length > 0;
  $("#empty").textContent = state.tab === "done"
    ? "هنوز کاری برای این روز ثبت نشده."
    : "تسکی برای این روز نیست.";
}

function renderSummary() {
  const { done, todo, carried, summary } = state.data;
  const openTodo = todo.length + carried.length;
  const total = done.reduce((s, e) => s + (e.minutes || 0), 0);
  const byTag = new Map();
  for (const e of done) {
    const ids = e.tag_ids.length ? e.tag_ids : [0];
    for (const id of ids) {
      const x = byTag.get(id) || { n: 0, min: 0 };
      x.n++; x.min += e.minutes || 0; byTag.set(id, x);
    }
  }
  const tagsum = [...byTag.entries()].map(([id, x]) => {
    const t = tagById(id);
    const name = t ? t.name : "بدون تگ";
    const color = t ? t.color : "#b3261e";
    return `<span style="--c:${color}">${esc(name)}: ${toFa(x.n)} کار${x.min ? "، " + toFa(duration(x.min)) : ""}</span>`;
  }).join("");
  const fromTodo = done.filter((e) => e.planned_day).length;

  let ai = "";
  if (summary) {
    ai = `<div class="ai${summary.stale ? " stale" : ""}">${esc(summary.text)}</div>
      <div class="ai-bar">
        <span>${summary.stale ? "⚠ کارهای این روز بعد از نوشتن خلاصه تغییر کرده." : "خلاصه با گپ‌جی‌پی‌تی، ساعت " + toFa(hhmm(summary.created_at))}</span>
        <button class="ghost sm" id="aiBtn">${summary.stale ? "به‌روزرسانی خلاصه" : "نوشتن دوباره"}</button>
        <button class="ghost sm" id="aiCopy">کپی</button>
      </div>`;
  } else if (done.length || openTodo) {
    ai = `<div class="ai-bar"><button class="ghost sm" id="aiBtn">✨ نوشتن خلاصهٔ روز</button></div>`;
  }

  $("#summary").innerHTML = `
    <h2>خلاصهٔ ${state.day === todayIso() ? "امروز" : "روز"}</h2>
    <div class="stats">
      <span>انجام‌شده: <b>${toFa(done.length)}</b></span>
      ${total ? `<span>زمان ثبت‌شده: <b>${toFa(duration(total))}</b></span>` : ""}
      ${fromTodo ? `<span>از تسک‌ها تیک خورده: <b>${toFa(fromTodo)}</b></span>` : ""}
      <span>تسک باز: <b>${toFa(openTodo)}</b></span>
    </div>
    ${tagsum ? `<div class="tagsum">${tagsum}</div>` : ""}
    ${ai}`;
}

function entryHTML(e) {
  const tags = e.tag_ids.map(tagById).filter(Boolean);
  const isTodo = e.kind === "todo";
  const lead = isTodo
    ? `<button class="check-btn" data-act="check" title="انجام شد"></button>`
    : `<span class="time">${toFa(hhmm(e.created_at))}${e.source === "voice" ? " 🎙" : ""}</span>`;
  const extra = [];
  if (isTodo && e.day !== state.day) extra.push(`<span class="from">از ${faDay(e.day, false)}</span>`);
  if (!isTodo && e.planned_day) extra.push(`<span class="dur" title="از فهرست تسک‌ها">✓ تسک${e.planned_day !== e.day ? " " + faDay(e.planned_day, false) : ""}</span>`);
  return `<li class="entry card${isTodo ? " todo" : ""}" data-id="${e.id}">
    ${lead}
    <div class="body">${esc(e.text)}</div>
    <div class="ops">
      ${!isTodo && e.planned_day ? `<button data-act="reopen" title="برگرداندن به تسک‌ها">↩</button>` : ""}
      <button data-act="edit" title="ویرایش">✎</button>
      <button data-act="del" title="حذف">🗑</button>
    </div>
    <div class="meta">
      ${tags.map((t) => chip(t, true, 'data-act="tags"')).join("")}
      ${tags.length ? `<button class="chip add" data-act="tags">± تگ</button>` : `<button class="untagged" data-act="tags">+ تگ بزن</button>`}
      ${e.minutes ? `<span class="dur">⏱ ${toFa(duration(e.minutes))}</span>` : ""}
      ${extra.join("")}
    </div>
  </li>`;
}
function findEntry(id) {
  const { done, todo, carried } = state.data;
  return [...done, ...todo, ...carried].find((x) => x.id === id);
}

// ---------- tabs ----------
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  state.tab = b.dataset.tab; state.filter = "all";
  saveJSON("karnama.tab", state.tab);
  render(); $("#text").focus();
}));

// ---------- summary ----------
$("#summary").addEventListener("click", async (e) => {
  if (e.target.id === "aiCopy") {
    await copyText(state.data.summary.text); return toast("خلاصه کپی شد");
  }
  if (e.target.id !== "aiBtn") return;
  if (!state.settings.has_gapgpt_key) {
    toast("اول کلید گپ‌جی‌پی‌تی را در تنظیمات وارد کنید.", true);
    return openSettings();
  }
  const b = e.target;
  b.disabled = true; b.textContent = "در حال نوشتن…";
  const day = state.day;
  try {
    await api("POST", `/api/day/${day}/summary`);
    if (state.day === day) { await loadDay(); render(); }
  } catch (err) {
    toast(err.message, true); b.disabled = false; b.textContent = "تلاش دوباره";
  }
});

// ---------- composer ----------
$("#composeTags").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.id === "quickTag") {
    const t = await newTagPrompt();
    if (!t) return;
    state.composeTags.add(t.id);
  } else {
    const id = +b.dataset.tag;
    state.composeTags.has(id) ? state.composeTags.delete(id) : state.composeTags.add(id);
  }
  saveJSON("karnama.composeTags", [...state.composeTags]);
  render();
});

async function saveEntry() {
  const text = $("#text").value.trim();
  if (!text) return $("#text").focus();
  let minutes;
  try { minutes = minutesField($("#minutes")); } catch (e) { return toast(e.message, true); }
  $("#save").disabled = true;
  try {
    await api("POST", "/api/entries", {
      text, kind: state.tab, day: state.day, minutes, tag_ids: [...state.composeTags],
      source: state.voiceUsed ? "voice" : "text",
    });
    $("#text").value = ""; $("#minutes").value = ""; state.voiceUsed = false;
    setVoiceStatus("");
    await loadDay(); render(); toast(state.tab === "done" ? "ثبت شد" : "به تسک‌ها اضافه شد");
  } catch (e) { toast(e.message, true); }
  finally { $("#save").disabled = false; $("#text").focus(); }
}
$("#save").addEventListener("click", saveEntry);
$("#text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEntry(); }
});

// ---------- voice (Avanegar) ----------
const voice = { rec: null, chunks: [], started: 0, timer: 0, stream: null };
function setVoiceStatus(msg, err = false, retry = "") {
  const el = $("#voiceStatus");
  el.hidden = !msg; el.classList.toggle("err", err);
  el.innerHTML = msg ? esc(msg) + (retry ? ` <button class="ghost sm" data-retry="${retry}">تلاش دوباره</button>` : "") : "";
}
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
async function startRec() {
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return setVoiceStatus("دسترسی به میکروفون داده نشد.", true);
  }
  const mime = pickMime();
  voice.rec = new MediaRecorder(voice.stream, mime ? { mimeType: mime } : {});
  voice.chunks = [];
  voice.rec.ondataavailable = (e) => e.data.size && voice.chunks.push(e.data);
  voice.rec.onstop = sendRec;
  voice.rec.start();
  voice.started = Date.now();
  $("#mic").classList.add("rec");
  setVoiceStatus("در حال ضبط… برای پایان دوباره بزنید (یا Esc برای لغو).");
  voice.timer = setInterval(() => {
    const s = Math.floor((Date.now() - voice.started) / 1000);
    $("#micTime").textContent = toFa(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  }, 250);
}
function stopRec(cancel = false) {
  clearInterval(voice.timer);
  $("#micTime").textContent = "";
  $("#mic").classList.remove("rec");
  voice.cancel = cancel;
  voice.rec.stop();
  voice.stream.getTracks().forEach((t) => t.stop());
}
function insertTranscript(text) {
  if (!text) throw new ApiError("متنی از صدا تشخیص داده نشد.");
  const ta = $("#text");
  ta.value = ta.value.trim() ? ta.value.trimEnd() + " " + text : text;
  state.voiceUsed = true;
  setVoiceStatus("");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
// The recording lives only in memory: kept for a retry if Avanegar fails, dropped after success.
async function transcribeForm(fd) {
  $("#mic").classList.add("busy"); $("#mic").disabled = true;
  setVoiceStatus("آوانگار در حال تبدیل صدا به متن…");
  try {
    const { text } = await api("POST", "/api/transcribe", fd);
    insertTranscript(text);
    voice.failed = null;
  } catch (e) {
    voice.failed = fd;
    setVoiceStatus(e.message, true, "1");
  } finally {
    $("#mic").classList.remove("busy"); $("#mic").disabled = false;
  }
}
async function sendRec() {
  const rec = voice.rec; voice.rec = null;
  if (voice.cancel) return setVoiceStatus("");
  const type = (rec.mimeType || "audio/webm").split(";")[0];
  const blob = new Blob(voice.chunks, { type });
  voice.chunks = [];
  if (blob.size < 1000) return setVoiceStatus("صدایی ضبط نشد.", true);
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `voice.${ext}`);
  await transcribeForm(fd);
}
$("#voiceStatus").addEventListener("click", (e) => {
  if (e.target.dataset.retry && voice.failed) transcribeForm(voice.failed);
});
$("#mic").addEventListener("click", () => (voice.rec ? stopRec() : startRec()));

// ---------- list interactions ----------
$("#filterTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  const f = b.dataset.filter;
  state.filter = f === "all" || f === "none" ? f : +f;
  render();
});
async function onEntryClick(ev) {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const li = b.closest(".entry");
  const entry = findEntry(+li.dataset.id);
  const act = b.dataset.act;
  try {
    if (act === "del") {
      if (!confirm(entry.kind === "todo" ? "این تسک حذف شود؟" : "این کار حذف شود؟")) return;
      await api("DELETE", `/api/entries/${entry.id}`);
    } else if (act === "check") {
      await api("PATCH", `/api/entries/${entry.id}`, { kind: "done", day: state.day });
      toast("انجام شد؛ به «انجام دادم» رفت");
    } else if (act === "reopen") {
      await api("PATCH", `/api/entries/${entry.id}`, { kind: "todo" });
      toast("به «باید انجام بدم» برگشت");
    } else if (act === "edit") {
      return editEntry(li, entry);
    } else if (act === "tags") {
      return openTagPicker(b, entry);
    }
    await loadDay(); render();
  } catch (e) { toast(e.message, true); }
}
$("#entries").addEventListener("click", onEntryClick);
$("#carried").addEventListener("click", onEntryClick);

function editEntry(li, entry) {
  const body = li.querySelector(".body");
  body.innerHTML = `<textarea rows="3">${esc(entry.text)}</textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
      <label class="minutes">مدت <input type="text" inputmode="numeric" autocomplete="off" value="${entry.minutes ?? ""}" placeholder="دقیقه"></label>
      <label class="minutes">روز <input type="date" value="${entry.day}"></label>
      <button class="primary sm" data-save>ذخیره</button><button class="ghost sm" data-cancel>انصراف</button>
    </div>`;
  const ta = body.querySelector("textarea");
  ta.focus();
  const save = async () => {
    const [min, day] = body.querySelectorAll("input");
    try {
      const minutes = minutesField(min);
      await api("PATCH", `/api/entries/${entry.id}`, {
        text: ta.value, day: day.value || entry.day,
        ...(minutes === null ? { clear_minutes: true } : { minutes }),
      });
      await loadDay(); render();
    } catch (e) { toast(e.message, true); }
  };
  body.querySelector("[data-save]").onclick = save;
  body.querySelector("[data-cancel]").onclick = render;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === "Escape") render();
  });
}
let pickerDirty = false;
function openTagPicker(anchor, entry) {
  closePicker();
  const sel = new Set(entry.tag_ids);
  const box = document.createElement("div");
  box.className = "picker card";
  const draw = () => {
    box.innerHTML = `<div class="chips">${activeTags().map((t) => chip(t, sel.has(t.id))).join("")}
      <button type="button" class="chip add" data-new>+ تگ جدید</button></div>`;
  };
  draw();
  box.addEventListener("click", async (e) => {
    e.stopPropagation();
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.new !== undefined) {
      const t = await newTagPrompt();
      if (!t) return;
      sel.add(t.id);
    } else {
      const id = +b.dataset.tag;
      sel.has(id) ? sel.delete(id) : sel.add(id);
    }
    draw();
    await api("PATCH", `/api/entries/${entry.id}`, { tag_ids: [...sel] });
    entry.tag_ids = [...sel];
    pickerDirty = true;
  });
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.top = `${window.scrollY + r.bottom + 6}px`;
  box.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  setTimeout(() => document.addEventListener("click", outside), 0);
  function outside(e) { if (!box.contains(e.target)) { document.removeEventListener("click", outside); closePicker(); } }
}
function closePicker() {
  document.querySelectorAll(".picker").forEach((p) => p.remove());
  if (pickerDirty) { pickerDirty = false; refresh(); }
}

// ---------- day navigation ----------
async function goDay(d) {
  state.day = d; state.filter = "all";
  state.followToday = d === todayIso();
  closePicker(); closeCal();
  await loadDay(); render();
}
$("#prevDay").onclick = () => goDay(addDays(state.day, -1));
$("#nextDay").onclick = () => goDay(addDays(state.day, 1));
$("#todayBtn").onclick = () => goDay(todayIso());
// Keep in step with the system calendar: a page left open on "today" turns over at midnight.
function checkRollover() {
  if (state.followToday && state.day !== todayIso() && !voice.rec) goDay(todayIso());
}
setInterval(checkRollover, 30000);
document.addEventListener("visibilitychange", () => !document.hidden && checkRollover());
window.addEventListener("focus", checkRollover);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && voice.rec) stopRec(true);
  if (e.key === "Escape") closeCal();
  if (e.altKey && e.code === "KeyV") { e.preventDefault(); $("#mic").click(); }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); $("#prevDay").click(); }
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); $("#nextDay").click(); }
});

// ---------- Jalali calendar ----------
const cal = { anchor: null };
function monthStart(iso) { return addDays(iso, -(jalali(iso).d - 1)); }
async function drawCal() {
  const first = cal.anchor;
  const j = jalali(first);
  const days = [];
  for (let d = first; jalali(d).m === j.m; d = addDays(d, 1)) days.push(d);
  const counts = await api("GET", `/api/calendar?start=${days[0]}&end=${days[days.length - 1]}`).catch(() => ({}));
  const offset = (parseDay(first).getDay() + 1) % 7;   // week starts on Saturday
  const today = todayIso();
  const cells = Array(offset).fill("<span></span>").concat(days.map((d) => {
    const c = counts[d] || {};
    const dots = (c.done ? "<i></i>" : "") + (c.todo ? '<i class="t"></i>' : "");
    const cls = [d === state.day ? "sel" : "", d === today ? "today" : ""].join(" ");
    return `<button class="${cls}" data-day="${d}" title="${faDay(d)}${c.done ? " — " + toFa(c.done) + " کار" : ""}${c.todo ? " — " + toFa(c.todo) + " تسک" : ""}">${toFa(jalali(d).d)}<span class="dots">${dots}</span></button>`;
  }));
  $("#cal").innerHTML = `
    <div class="cal-head">
      <button data-mon="-1" title="ماه قبل">›</button>
      <span>${MONTHS[j.m - 1]} ${toFa(j.y)}</span>
      <button data-mon="1" title="ماه بعد">‹</button>
    </div>
    <div class="cal-grid">${["ش", "ی", "د", "س", "چ", "پ", "ج"].map((w) => `<span class="wd">${w}</span>`).join("")}${cells.join("")}</div>
    <div class="cal-foot"><span><i style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--brand)"></i> کار انجام‌شده &nbsp; <i style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#b5621b"></i> تسک باز</span><button class="ghost sm" data-day="${today}">امروز</button></div>`;
}
async function openCal() {
  cal.anchor = monthStart(state.day);
  await drawCal();
  $("#cal").hidden = false;
}
function closeCal() { $("#cal").hidden = true; }
$("#dayTitle").onclick = (e) => { e.stopPropagation(); $("#cal").hidden ? openCal() : closeCal(); };
$("#cal").addEventListener("click", (e) => {
  e.stopPropagation();
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.day) return goDay(b.dataset.day);
  if (b.dataset.mon === "-1") cal.anchor = monthStart(addDays(cal.anchor, -1));
  else cal.anchor = monthStart(addDays(cal.anchor, 32));
  drawCal();
});
document.addEventListener("click", () => !$("#cal").hidden && closeCal());

// ---------- report ----------
const report = { tags: new Set(loadJSON("karnama.reportTags", [])), kind: "done" };
async function openReport() {
  await loadTags();
  for (const id of [...report.tags]) if (!tagById(id)) report.tags.delete(id);
  report.kind = state.tab;
  $("#rFrom").value = state.day; $("#rTo").value = state.day;
  drawReportTags();
  await buildReport();
  $("#reportDlg").showModal();
}
function drawReportTags() {
  document.querySelectorAll("#rKind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === report.kind));
  $("#rCarryWrap").hidden = report.kind !== "todo";
  $("#rTags").innerHTML =
    `<button type="button" class="chip${report.tags.size ? "" : " on"}" data-all>همهٔ تگ‌ها</button>` +
    state.tags.map((t) => chip(t, report.tags.has(t.id))).join("");
}
$("#rKind").addEventListener("click", (e) => {
  const b = e.target.closest("[data-kind]");
  if (!b) return;
  report.kind = b.dataset.kind; drawReportTags(); buildReport();
});
$("#rTags").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.all !== undefined) report.tags.clear();
  else { const id = +b.dataset.tag; report.tags.has(id) ? report.tags.delete(id) : report.tags.add(id); }
  saveJSON("karnama.reportTags", [...report.tags]);
  drawReportTags(); buildReport();
});
document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
  let from = todayIso(), to = from;
  if (b.dataset.range === "week") from = addDays(to, -((new Date().getDay() + 1) % 7));
  else if (b.dataset.range === "month") from = monthStart(to);
  $("#rFrom").value = from; $("#rTo").value = to; buildReport();
}));
["#rFrom", "#rTo", "#rTime", "#rMinutes", "#rFaDigits", "#rUntagged", "#rCarry"].forEach((s) => $(s).addEventListener("change", buildReport));

async function buildReport() {
  let from = $("#rFrom").value, to = $("#rTo").value || from;
  if (!from) return;
  if (to < from) [from, to] = [to, from];
  const todo = report.kind === "todo";
  const start = todo && $("#rCarry").checked ? "2000-01-01" : from;
  const entries = await api("GET", `/api/entries?start=${start}&end=${to}&kind=${report.kind}`);
  const opts = {
    todo, from, time: $("#rTime").checked && !todo, minutes: $("#rMinutes").checked,
    fa: $("#rFaDigits").checked, untagged: $("#rUntagged").checked,
  };
  $("#rOut").value = formatReport(entries, from, to, opts);
  const n = entries.length;
  $("#rInfo").textContent = n ? `${toFa(n)} ${todo ? "تسک" : "کار"} در این بازه` : "در این بازه چیزی ثبت نشده";
}

function formatReport(entries, from, to, opts) {
  const noun = opts.todo ? "تسک" : "کار";
  const chosen = report.tags.size ? state.tags.filter((t) => report.tags.has(t.id)) : state.tags.filter((t) => entries.some((e) => e.tag_ids.includes(t.id)));
  const sections = chosen.map((t) => ({ title: t.name, tag: t, items: entries.filter((e) => e.tag_ids.includes(t.id)) }))
    .filter((s) => s.items.length);
  if (opts.untagged || !report.tags.size) {
    const none = entries.filter((e) => !e.tag_ids.length);
    if (none.length) sections.push({ title: "بدون تگ", items: none });
  }
  const multiDay = from !== to;
  const range = multiDay ? `از ${faDay(from, false)} تا ${faDay(to)}` : faDay(from);
  const out = [];
  const name = (state.settings.report_name || "").trim();
  const single = sections.length === 1;
  const title = opts.todo ? "کارهایی که باید انجام شود" : "گزارش کارهای انجام‌شده";

  out.push(single ? `${title} — ${sections[0].title}` : title);
  if (name) out.push(`${opts.todo ? "مسئول" : "انجام‌دهنده"}: ${name}`);
  out.push(`تاریخ: ${range}`);
  if (!sections.length) { out.push("", `${noun}ی در این بازه ثبت نشده است.`); return finish(out, opts); }

  for (const s of sections) {
    out.push("");
    if (!single) out.push(`■ ${s.title}`);
    const indent = single ? "" : "  ";
    let n = 0, minutes = 0, lastDay = "";
    for (const e of s.items) {
      const shownDay = opts.todo && e.day < from ? from : e.day;
      if (multiDay && !opts.todo && shownDay !== lastDay) {
        out.push(`${indent}— ${faDay(e.day, false)}`);
        lastDay = shownDay;
      }
      n++; minutes += e.minutes || 0;
      const extras = [];
      if (opts.time) extras.push(`ساعت ${hhmm(e.created_at)}`);
      if (opts.minutes && e.minutes) extras.push(opts.todo ? `حدود ${duration(e.minutes)}` : duration(e.minutes));
      if (opts.todo && e.day < from) extras.push(`مانده از ${faDay(e.day, false)}`);
      const others = e.tag_ids.filter((id) => !s.tag || id !== s.tag.id).map(tagById).filter(Boolean).map((t) => t.name);
      if (others.length && s.tag) extras.push(`مرتبط با: ${others.join("، ")}`);
      const lines = e.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      out.push(`${indent}${n}. ${lines[0]}${extras.length ? ` (${extras.join("، ")})` : ""}`,
        ...lines.slice(1).map((l) => `${indent}   ${l}`));
    }
    out.push(`${indent}جمع: ${n} ${noun}${opts.minutes && minutes ? `، ${opts.todo ? "زمان تخمینی" : "مجموع زمان"}: ${duration(minutes)}` : ""}`);
  }
  if (!single) {
    const uniq = new Map(sections.flatMap((s) => s.items.map((e) => [e.id, e])));
    const uniqMin = [...uniq.values()].reduce((a, e) => a + (e.minutes || 0), 0);
    out.push("", `جمع کل: ${uniq.size} ${noun}${opts.minutes && uniqMin ? `، ${duration(uniqMin)}` : ""}`);
  }
  return finish(out, opts);
}
function finish(lines, opts) {
  const text = lines.join("\n");
  return opts.fa ? toFa(text) : text;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
}
$("#reportBtn").onclick = () => openReport().catch((e) => toast(e.message, true));
$("#rCopy").onclick = async () => { await copyText($("#rOut").value); toast("متن گزارش کپی شد"); };

// ---------- tags dialog ----------
function drawTagList() {
  $("#tagList").innerHTML = state.tags.map((t) => `
    <li data-id="${t.id}" class="${t.archived ? "archived" : ""}">
      <input type="color" value="${t.color}">
      <input type="text" value="${esc(t.name)}" maxlength="60">
      <span class="muted">${toFa(t.uses)} مورد</span>
      <button class="ghost sm" data-arch>${t.archived ? "فعال" : "بایگانی"}</button>
      <button class="ghost sm" data-del title="حذف">🗑</button>
    </li>`).join("") || `<li class="muted">هنوز تگی نساخته‌اید.</li>`;
}
$("#tagsBtn").onclick = async () => { await loadTags(); drawTagList(); $("#tagsDlg").showModal(); };
$("#newTag").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/tags", { name: $("#newTagName").value.trim(), color: $("#newTagColor").value });
    $("#newTagName").value = ""; $("#newTagColor").value = PALETTE[(state.tags.length + 1) % PALETTE.length];
    await loadTags(); drawTagList(); render();
  } catch (err) { toast(err.message, true); }
});
$("#tagList").addEventListener("change", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const body = e.target.type === "color" ? { color: e.target.value } : { name: e.target.value };
  try { await api("PATCH", `/api/tags/${li.dataset.id}`, body); } catch (err) { toast(err.message, true); }
  await loadTags(); drawTagList(); render();
});
$("#tagList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const t = tagById(+li.dataset.id);
  if (e.target.matches("[data-arch]")) await api("PATCH", `/api/tags/${t.id}`, { archived: !t.archived });
  else if (e.target.matches("[data-del]")) {
    if (!confirm(`تگ «${t.name}» حذف شود؟ کارها باقی می‌مانند ولی این تگ از آنها برداشته می‌شود.`)) return;
    await api("DELETE", `/api/tags/${t.id}`);
  } else return;
  await refresh(); drawTagList();
});

// ---------- settings ----------
async function loadSettings() { state.settings = await api("GET", "/api/settings").catch(() => ({})); }
async function openSettings() {
  await loadSettings();
  const s = state.settings;
  $("#sToken").value = ""; $("#sGap").value = "";
  $("#sTokenState").textContent = s.has_avanegar_token ? "✓ توکن ذخیره شده است" : "توکن تنظیم نشده؛ تایپ صوتی کار نمی‌کند";
  $("#sGapState").textContent = s.has_gapgpt_key ? "✓ کلید ذخیره شده است" : "کلید تنظیم نشده؛ خلاصهٔ هوش مصنوعی کار نمی‌کند";
  $("#sModel").value = s.text_model || "";
  $("#sName").value = s.report_name || "";
  $("#sIface").value = s.provider_interface || "";
  $("#settingsDlg").showModal();
}
$("#settingsBtn").onclick = openSettings;
// Notch panel: ask the Mac app to slide the panel back up.
$("#collapseBtn").onclick = () => {
  try { window.webkit.messageHandlers.karnama.postMessage("collapse"); } catch {}
};
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    state.settings = await api("PUT", "/api/settings", {
      avanegar_token: $("#sToken").value, gapgpt_key: $("#sGap").value, text_model: $("#sModel").value,
      report_name: $("#sName").value, provider_interface: $("#sIface").value,
    });
    $("#settingsDlg").close(); toast("تنظیمات ذخیره شد"); render();
  } catch (err) { toast(err.message, true); }
});

// ---------- in-app update ----------
const update = { info: null, dismissed: loadJSON("karnama.dismissedUpdate", "") };
async function checkUpdate(manual = false) {
  try {
    update.info = await api("GET", "/api/update");
  } catch (e) {
    if (manual) toast(e.message, true);
    return;
  }
  const u = update.info;
  $("#versionInfo").textContent = u.supported
    ? `نسخهٔ نصب‌شده: ${u.current || "نامشخص"}` : "به‌روزرسانی خودکار فقط در برنامهٔ مک";
  if (manual) toast(u.available ? "نسخهٔ جدید آماده است" : "برنامه به‌روز است");
  const show = u.supported && u.available && (manual || update.dismissed !== u.latest);
  $("#updateBar").hidden = !show;
  if (show) {
    $("#updateBar").innerHTML = `<span>✨ نسخهٔ جدید کارنامه آماده است.</span>
      <button id="doUpdate">به‌روزرسانی</button><button class="x" id="skipUpdate" title="بعداً">×</button>`;
  }
}
$("#updateBar").addEventListener("click", async (e) => {
  if (e.target.id === "skipUpdate") {
    update.dismissed = update.info.latest; saveJSON("karnama.dismissedUpdate", update.dismissed);
    $("#updateBar").hidden = true;
  } else if (e.target.id === "doUpdate") {
    if (voice.rec) return toast("اول ضبط صدا را تمام کنید.", true);
    if ($("#text").value.trim() && !confirm("متنی در کادر هست که ثبت نشده. بدون ثبت به‌روزرسانی شود؟")) return;
    e.target.disabled = true;
    $("#updateBar").querySelector("span").textContent = "در حال دانلود نسخهٔ جدید…";
    try {
      await api("POST", "/api/update");
      $("#updateBar").innerHTML = "<span>در حال نصب… برنامه تا یکی دو دقیقه بسته و دوباره باز می‌شود. داده‌ها محفوظ است.</span>";
    } catch (err) {
      toast(err.message, true); e.target.disabled = false;
      $("#updateBar").querySelector("span").textContent = "به‌روزرسانی انجام نشد؛ دوباره تلاش کنید.";
    }
  }
});
$("#checkUpdate").onclick = () => checkUpdate(true);
setTimeout(checkUpdate, 3000);
setInterval(checkUpdate, 6 * 3600 * 1000);

Promise.all([refresh(), loadSettings()]).catch((e) => toast(e.message, true));
$("#text").focus();
