"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  day: isoDay(new Date()),
  tags: [],
  entries: [],
  filter: "all",          // "all" | "none" | tag id
  composeTags: new Set(loadJSON("karnama.composeTags", [])),
  voiceUsed: false,
};

// ---------- helpers ----------
function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseDay(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); }
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
const faDate = { format: (d) => faDay(isoDay(d)) };
const faDateShort = { format: (d) => faDay(isoDay(d), false) };
const FA = "۰۱۲۳۴۵۶۷۸۹";
const toFa = (s) => String(s).replace(/\d/g, (d) => FA[d]);
const hhmm = (iso) => iso.slice(11, 16);
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
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : "درخواست ناموفق بود");
  }
  return data;
}
const tagById = (id) => state.tags.find((t) => t.id === id);
const activeTags = () => state.tags.filter((t) => !t.archived);

// ---------- loading ----------
async function loadTags() {
  state.tags = await api("GET", "/api/tags");
  for (const id of [...state.composeTags]) if (!tagById(id)) state.composeTags.delete(id);
}
async function loadEntries() {
  state.entries = await api("GET", `/api/entries?start=${state.day}`);
}
async function refresh() {
  await Promise.all([loadTags(), loadEntries()]);
  render();
}

// ---------- rendering ----------
function chip(tag, on, extra = "") {
  return `<button type="button" class="chip${on ? " on" : ""}" style="--c:${tag.color}" data-tag="${tag.id}" ${extra}>${esc(tag.name)}</button>`;
}
function render() {
  const today = isoDay(new Date());
  $("#dayTitle").textContent = (state.day === today ? "امروز، " : "") + faDate.format(parseDay(state.day));
  $("#dayPicker").value = state.day;

  $("#composeTags").innerHTML =
    activeTags().map((t) => chip(t, state.composeTags.has(t.id))).join("") +
    `<button type="button" class="chip add" id="quickTag">+ تگ جدید</button>`;

  const counts = {};
  let untagged = 0;
  for (const e of state.entries) {
    if (!e.tag_ids.length) untagged++;
    for (const id of e.tag_ids) counts[id] = (counts[id] || 0) + 1;
  }
  const used = state.tags.filter((t) => counts[t.id]);
  $("#filterTags").innerHTML =
    `<button class="chip${state.filter === "all" ? " on" : ""}" data-filter="all">همه<span class="n">${toFa(state.entries.length)}</span></button>` +
    used.map((t) => `<button class="chip${state.filter === t.id ? " on" : ""}" style="--c:${t.color}" data-filter="${t.id}">${esc(t.name)}<span class="n">${toFa(counts[t.id])}</span></button>`).join("") +
    (untagged ? `<button class="chip${state.filter === "none" ? " on" : ""}" style="--c:#b3261e" data-filter="none">بدون تگ<span class="n">${toFa(untagged)}</span></button>` : "");

  const list = state.entries.filter((e) =>
    state.filter === "all" ? true : state.filter === "none" ? !e.tag_ids.length : e.tag_ids.includes(state.filter));
  const total = state.entries.reduce((s, e) => s + (e.minutes || 0), 0);
  $("#dayStats").textContent = state.entries.length
    ? `${toFa(state.entries.length)} کار${total ? "، " + toFa(duration(total)) : ""}` : "";
  $("#empty").hidden = list.length > 0;
  $("#entries").innerHTML = list.map(entryHTML).join("");
}
function entryHTML(e) {
  const tags = e.tag_ids.map(tagById).filter(Boolean);
  return `<li class="entry card" data-id="${e.id}">
    <span class="time">${toFa(hhmm(e.created_at))}${e.source === "voice" ? " 🎙" : ""}</span>
    <div class="body">${esc(e.text)}</div>
    <div class="ops">
      <button data-act="edit" title="ویرایش">✎</button>
      <button data-act="del" title="حذف">🗑</button>
    </div>
    <div class="meta">
      ${tags.map((t) => chip(t, true, 'data-act="tags"')).join("")}
      ${tags.length ? `<button class="chip add" data-act="tags">± تگ</button>` : `<button class="untagged" data-act="tags">+ تگ بزن</button>`}
      ${e.minutes ? `<span class="dur">⏱ ${toFa(duration(e.minutes))}</span>` : ""}
    </div>
  </li>`;
}

// ---------- composer ----------
$("#composeTags").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.id === "quickTag") {
    const name = prompt("نام تگ جدید:");
    if (!name || !name.trim()) return;
    try {
      const t = await api("POST", "/api/tags", { name: name.trim(), color: nextColor() });
      state.tags.push(t); state.composeTags.add(t.id);
    } catch (e) { return toast(e.message, true); }
  } else {
    const id = +b.dataset.tag;
    state.composeTags.has(id) ? state.composeTags.delete(id) : state.composeTags.add(id);
  }
  saveJSON("karnama.composeTags", [...state.composeTags]);
  render();
});
const PALETTE = ["#1d6d5a", "#2f5fb3", "#b5621b", "#8a3fa8", "#b3261e", "#2c8a9e", "#6b7d1f", "#c2417a"];
function nextColor() { return PALETTE[state.tags.length % PALETTE.length]; }

async function saveEntry() {
  const text = $("#text").value.trim();
  if (!text) return $("#text").focus();
  const minutes = $("#minutes").value ? +$("#minutes").value : null;
  $("#save").disabled = true;
  try {
    await api("POST", "/api/entries", {
      text, day: state.day, minutes, tag_ids: [...state.composeTags], source: state.voiceUsed ? "voice" : "text",
    });
    $("#text").value = ""; $("#minutes").value = ""; state.voiceUsed = false;
    await loadEntries(); render(); toast("ثبت شد");
  } catch (e) { toast(e.message, true); }
  finally { $("#save").disabled = false; $("#text").focus(); }
}
$("#save").addEventListener("click", saveEntry);
$("#text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEntry(); }
});

// ---------- voice (Avanegar) ----------
const voice = { rec: null, chunks: [], started: 0, timer: 0, stream: null };
function setVoiceStatus(msg, err = false) {
  const el = $("#voiceStatus");
  el.hidden = !msg; el.textContent = msg || ""; el.classList.toggle("err", err);
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
async function sendRec() {
  const rec = voice.rec; voice.rec = null;
  if (voice.cancel) return setVoiceStatus("");
  const type = (rec.mimeType || "audio/webm").split(";")[0];
  const blob = new Blob(voice.chunks, { type });
  if (blob.size < 1000) return setVoiceStatus("صدایی ضبط نشد.", true);
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `voice.${ext}`);
  $("#mic").classList.add("busy"); $("#mic").disabled = true;
  setVoiceStatus("آوانگار در حال تبدیل صدا به متن…");
  try {
    const { text } = await api("POST", "/api/transcribe", fd);
    if (!text) throw new Error("متنی از صدا تشخیص داده نشد.");
    const ta = $("#text");
    ta.value = ta.value.trim() ? ta.value.trimEnd() + " " + text : text;
    state.voiceUsed = true;
    setVoiceStatus("");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } catch (e) {
    setVoiceStatus(e.message, true);
  } finally {
    $("#mic").classList.remove("busy"); $("#mic").disabled = false;
  }
}
$("#mic").addEventListener("click", () => (voice.rec ? stopRec() : startRec()));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && voice.rec) stopRec(true);
  if (e.altKey && (e.key === "v" || e.code === "KeyV")) { e.preventDefault(); $("#mic").click(); }
});

// ---------- list interactions ----------
$("#filterTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  const f = b.dataset.filter;
  state.filter = f === "all" || f === "none" ? f : +f;
  render();
});
$("#entries").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const li = b.closest(".entry");
  const entry = state.entries.find((x) => x.id === +li.dataset.id);
  if (b.dataset.act === "del") {
    if (!confirm("این کار حذف شود؟")) return;
    await api("DELETE", `/api/entries/${entry.id}`);
    await loadEntries(); render();
  } else if (b.dataset.act === "edit") {
    editEntry(li, entry);
  } else if (b.dataset.act === "tags") {
    openTagPicker(b, entry);
  }
});
function editEntry(li, entry) {
  const body = li.querySelector(".body");
  body.innerHTML = `<textarea rows="3">${esc(entry.text)}</textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <label class="minutes">مدت <input type="number" min="0" max="1440" value="${entry.minutes ?? ""}" placeholder="دقیقه"></label>
      <label class="minutes">تاریخ <input type="date" value="${entry.day}"></label>
      <button class="primary sm" data-save>ذخیره</button><button class="ghost sm" data-cancel>انصراف</button>
    </div>`;
  const ta = body.querySelector("textarea");
  ta.focus();
  const save = async () => {
    const [min, day] = body.querySelectorAll("input");
    try {
      await api("PATCH", `/api/entries/${entry.id}`, {
        text: ta.value, day: day.value || entry.day,
        ...(min.value === "" ? { clear_minutes: true } : { minutes: +min.value }),
      });
      await loadEntries(); render();
    } catch (e) { toast(e.message, true); }
  };
  body.querySelector("[data-save]").onclick = save;
  body.querySelector("[data-cancel]").onclick = render;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === "Escape") render();
  });
}
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
      const name = prompt("نام تگ جدید:");
      if (!name || !name.trim()) return;
      try {
        const t = await api("POST", "/api/tags", { name: name.trim(), color: nextColor() });
        state.tags.push(t); sel.add(t.id);
      } catch (err) { return toast(err.message, true); }
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
let pickerDirty = false;
function closePicker() {
  document.querySelectorAll(".picker").forEach((p) => p.remove());
  if (pickerDirty) { pickerDirty = false; refresh(); }
}

// ---------- day navigation ----------
function goDay(d) { state.day = d; state.filter = "all"; closePicker(); loadEntries().then(render); }
$("#prevDay").onclick = () => goDay(addDays(state.day, -1));
$("#nextDay").onclick = () => goDay(addDays(state.day, 1));
$("#todayBtn").onclick = () => goDay(isoDay(new Date()));
$("#dayPicker").addEventListener("change", (e) => e.target.value && goDay(e.target.value));

// ---------- report ----------
const report = { tags: new Set(loadJSON("karnama.reportTags", [])), settings: {} };
async function openReport() {
  report.settings = await api("GET", "/api/settings").catch(() => ({}));
  await loadTags();
  for (const id of [...report.tags]) if (!tagById(id)) report.tags.delete(id);
  $("#rFrom").value = state.day; $("#rTo").value = state.day;
  drawReportTags();
  await buildReport();
  $("#reportDlg").showModal();
}
function drawReportTags() {
  $("#rTags").innerHTML =
    `<button type="button" class="chip${report.tags.size ? "" : " on"}" data-all>همهٔ تگ‌ها</button>` +
    state.tags.map((t) => chip(t, report.tags.has(t.id))).join("");
}
$("#rTags").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.all !== undefined) report.tags.clear();
  else { const id = +b.dataset.tag; report.tags.has(id) ? report.tags.delete(id) : report.tags.add(id); }
  saveJSON("karnama.reportTags", [...report.tags]);
  drawReportTags(); buildReport();
});
document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
  const today = new Date();
  let from = isoDay(today), to = from;
  if (b.dataset.range === "week") {           // Persian week starts on Saturday
    const back = (today.getDay() + 1) % 7;
    from = addDays(to, -back);
  } else if (b.dataset.range === "month") {
    const j = jalali(to);
    from = addDays(to, -(j.d - 1));
  }
  $("#rFrom").value = from; $("#rTo").value = to; buildReport();
}));
["#rFrom", "#rTo", "#rTime", "#rMinutes", "#rFaDigits", "#rUntagged"].forEach((s) => $(s).addEventListener("change", buildReport));

async function buildReport() {
  let from = $("#rFrom").value, to = $("#rTo").value || from;
  if (!from) return;
  if (to < from) [from, to] = [to, from];
  const entries = await api("GET", `/api/entries?start=${from}&end=${to}`);
  const opts = {
    time: $("#rTime").checked, minutes: $("#rMinutes").checked,
    fa: $("#rFaDigits").checked, untagged: $("#rUntagged").checked,
  };
  const text = formatReport(entries, from, to, opts);
  $("#rOut").value = text;
  const n = entries.length;
  $("#rInfo").textContent = n ? `${toFa(n)} کار در این بازه` : "در این بازه کاری ثبت نشده";
}

function formatReport(entries, from, to, opts) {
  const chosen = report.tags.size ? state.tags.filter((t) => report.tags.has(t.id)) : state.tags.filter((t) => entries.some((e) => e.tag_ids.includes(t.id)));
  const sections = chosen.map((t) => ({ title: t.name, tag: t, items: entries.filter((e) => e.tag_ids.includes(t.id)) }))
    .filter((s) => s.items.length);
  if (opts.untagged || (!report.tags.size && !sections.length)) {
    const none = entries.filter((e) => !e.tag_ids.length);
    if (none.length) sections.push({ title: "بدون تگ", items: none });
  }
  const multiDay = from !== to;
  const range = multiDay
    ? `از ${faDateShort.format(parseDay(from))} تا ${faDate.format(parseDay(to))}`
    : faDate.format(parseDay(from));
  const out = [];
  const name = (report.settings.report_name || "").trim();
  const single = sections.length === 1;

  out.push(single ? `گزارش کارهای انجام‌شده — ${sections[0].title}` : "گزارش کارهای انجام‌شده");
  if (name) out.push(`انجام‌دهنده: ${name}`);
  out.push(`تاریخ: ${range}`);
  if (!sections.length) { out.push("", "کاری در این بازه ثبت نشده است."); return finish(out, opts); }

  for (const s of sections) {
    out.push("");
    if (!single) out.push(`■ ${s.title}`);
    let n = 0, minutes = 0, lastDay = "";
    for (const e of s.items) {
      if (multiDay && e.day !== lastDay) {
        out.push(`${single ? "" : "  "}— ${faDateShort.format(parseDay(e.day))}`);
        lastDay = e.day;
      }
      n++; minutes += e.minutes || 0;
      const extras = [];
      if (opts.time) extras.push(`ساعت ${hhmm(e.created_at)}`);
      if (opts.minutes && e.minutes) extras.push(duration(e.minutes));
      const others = e.tag_ids.filter((id) => !s.tag || id !== s.tag.id).map(tagById).filter(Boolean).map((t) => t.name);
      if (others.length && s.tag) extras.push(`مرتبط با: ${others.join("، ")}`);
      const indent = single ? "" : "  ";
      const lines = e.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const head = `${indent}${n}. ${lines[0]}${extras.length ? ` (${extras.join("، ")})` : ""}`;
      out.push(head, ...lines.slice(1).map((l) => `${indent}   ${l}`));
    }
    const sum = `${n} کار${opts.minutes && minutes ? `، مجموع زمان: ${duration(minutes)}` : ""}`;
    out.push(`${single ? "" : "  "}جمع: ${sum}`);
  }
  if (!single) {
    const uniq = new Map(sections.flatMap((s) => s.items.map((e) => [e.id, e])));
    const uniqMin = [...uniq.values()].reduce((a, e) => a + (e.minutes || 0), 0);
    out.push("", `جمع کل: ${uniq.size} کار${opts.minutes && uniqMin ? `، ${duration(uniqMin)}` : ""}`);
  }
  return finish(out, opts);
}
function finish(lines, opts) {
  const text = lines.join("\n");
  return opts.fa ? toFa(text) : text;
}
$("#reportBtn").onclick = () => openReport().catch((e) => toast(e.message, true));
$("#rCopy").onclick = async () => {
  const t = $("#rOut").value;
  try { await navigator.clipboard.writeText(t); }
  catch { $("#rOut").select(); document.execCommand("copy"); }
  toast("متن گزارش کپی شد");
};

// ---------- tags dialog ----------
function drawTagList() {
  $("#tagList").innerHTML = state.tags.map((t) => `
    <li data-id="${t.id}" class="${t.archived ? "archived" : ""}">
      <input type="color" value="${t.color}">
      <input type="text" value="${esc(t.name)}" maxlength="60">
      <span class="muted">${toFa(t.uses)} کار</span>
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
$("#settingsBtn").onclick = async () => {
  const s = await api("GET", "/api/settings");
  $("#sToken").value = "";
  $("#sTokenState").textContent = s.has_avanegar_token ? "✓ توکن ذخیره شده است" : "توکن تنظیم نشده؛ تایپ صوتی کار نمی‌کند";
  $("#sName").value = s.report_name || "";
  $("#sIface").value = s.provider_interface || "";
  $("#settingsDlg").showModal();
};
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("PUT", "/api/settings", {
      avanegar_token: $("#sToken").value, report_name: $("#sName").value, provider_interface: $("#sIface").value,
    });
    $("#settingsDlg").close(); toast("تنظیمات ذخیره شد");
  } catch (err) { toast(err.message, true); }
});

refresh().catch((e) => toast(e.message, true));
$("#text").focus();
