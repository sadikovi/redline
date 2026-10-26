// local-review UI. Plain ES2020, no dependencies.
// Every user-, file- and Claude-supplied string goes through text nodes, never innerHTML.
"use strict";

(() => {
  const LARGE_FILE_LINES = 1500;

  // ---------- helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  // Plain text with preserved line breaks and inline `code` spans.
  function richText(text) {
    const el = h("div", { class: "body" });
    text.split(/(`[^`\n]+`)/).forEach((part, i) => {
      if (i % 2 === 1) el.append(h("code", {}, part.slice(1, -1)));
      else if (part) el.append(part);
    });
    return el;
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- token and API ----------

  let token = null;
  const hashMatch = location.hash.match(/(?:^#|&)t=([^&]+)/);
  if (hashMatch) {
    token = decodeURIComponent(hashMatch[1]);
    try { sessionStorage.setItem("lr-token", token); } catch { /* ignore */ }
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    try { token = sessionStorage.getItem("lr-token"); } catch { /* ignore */ }
  }

  async function api(method, path, body) {
    const opts = { method, cache: "no-store", headers: { Authorization: "Bearer " + token } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch("/api" + path, opts);
    } catch (e) {
      const err = new Error("Cannot reach the review server");
      err.network = true;
      throw err;
    }
    const ct = res.headers.get("Content-Type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- state ----------

  const S = {
    review: null,
    version: 0,
    latest: 0,
    knownRounds: 0,   // rounds seen when the page last acknowledged them
    viewRound: 0,
    since: 0,         // 0 = all changes
    files: [],
    cards: new Map(), // path -> {card, file, rows: Map, loaded}
    sel: null,        // {path, side, hunk, start, end, anchor}
    form: null,       // {row, textarea, key}
    ended: false,
    lastResult: null,
    conn: "ok",       // ok | lost | unauthorized
    newRound: false,
    ui: { reply: {}, edit: {}, expanded: {}, outdatedOpen: {}, summary: "" },
  };

  const canComment = () =>
    !!S.review && S.review.status === "pending_review" && S.viewRound === S.latest && S.since === 0;

  const viewedKey = (path) => `lr:viewed:${S.review.id}:${S.viewRound}:${path}`;
  const isViewed = (path) => store.get(viewedKey(path)) === "1";

  function draftCount() {
    if (!S.review) return 0;
    let n = 0;
    for (const c of S.review.comments) {
      if (c.state === "draft") n++;
      n += c.thread.filter((e) => e.draft).length;
    }
    return n;
  }

  // ---------- top bar ----------

  function renderTop() {
    const r = S.review;
    $("#title").textContent = r ? r.title || r.branch || "Local review" : "Local review";
    document.title = (r && (r.title || r.branch)) ? `Review · ${r.title || r.branch}` : "Local review";
    $("#base").textContent = r ? `base ${r.base.slice(0, 7)}` : "";
    $("#commit-branch").textContent = r && r.branch ? r.branch : "the original branch";

    const rs = $("#round-select");
    rs.replaceChildren();
    for (let n = 1; n <= S.latest; n++) {
      rs.append(h("option", { value: n, selected: n === S.viewRound }, `Round ${n} of ${S.latest}`));
    }
    rs.hidden = !r;

    const vs = $("#view-select");
    vs.replaceChildren(h("option", { value: 0, selected: S.since === 0 }, "All changes"));
    for (let k = S.viewRound - 1; k >= 1; k--) {
      vs.append(h("option", { value: k, selected: S.since === k }, `Changes since round ${k}`));
    }
    vs.hidden = !r || S.viewRound < 2;

    const adds = S.files.reduce((a, f) => a + f.additions, 0);
    const dels = S.files.reduce((a, f) => a + f.deletions, 0);
    const counts = $("#counts");
    counts.replaceChildren();
    if (r) {
      counts.append(`${S.files.length} file${S.files.length === 1 ? "" : "s"}, `,
        h("span", { class: "add" }, `+${adds}`), " ", h("span", { class: "del" }, `−${dels}`));
    }

    const drafts = draftCount();
    const badge = $("#draft-count");
    badge.textContent = String(drafts);
    badge.hidden = drafts === 0;
    const finish = $("#finish-btn");
    finish.disabled = !r || r.status !== "pending_review";
    if (finish.disabled) $("#finish-pop").hidden = true;
  }

  // ---------- banners ----------

  function renderBanners() {
    const box = $("#banners");
    box.replaceChildren();
    const r = S.review;
    if (S.conn === "lost") {
      box.append(h("div", { class: "banner danger" },
        h("strong", {}, "Server restarted"), " · Reopen: run ", h("code", {}, "review start --no-open"),
        " and open the new URL."));
    } else if (S.conn === "unauthorized") {
      box.append(h("div", { class: "banner danger" },
        "This page has no valid token. Open the URL printed by ", h("code", {}, "review start"), "."));
    }
    if (S.ended) {
      box.append(S.lastResult
        ? h("div", { class: "banner success" }, h("strong", {}, "Approved"), " · " + S.lastResult)
        : h("div", { class: "banner info" }, "This review has ended."));
      return;
    }
    if (!r) return;
    if (S.newRound && S.viewRound < S.latest) {
      box.append(h("div", { class: "banner info" },
        h("strong", {}, `Claude pushed round ${S.latest}`), " · ",
        h("button", { class: "btn-link", type: "button", onclick: () => switchRound(S.latest, 0) }, "View")));
    }
    if (r.status === "changes_requested") {
      box.append(h("div", { class: "banner warn" }, h("span", { class: "spinner" }), "Waiting for Claude…"));
    } else if (r.status === "approved" && r.commitError) {
      box.append(h("div", { class: "banner danger" }, h("strong", {}, "Commit failed"), " · " + r.commitError));
    } else if (r.status === "approved" && r.commitRequested) {
      box.append(h("div", { class: "banner success" }, h("span", { class: "spinner" }),
        h("strong", {}, "Approved"), ` · waiting for Claude to commit on ${r.branch}…`));
    } else if (r.status === "approved") {
      box.append(h("div", { class: "banner success" }, h("strong", {}, "Approved"), " · ready to commit"));
    }
    if (S.viewRound < S.latest) {
      box.append(h("div", { class: "banner info" },
        `Viewing round ${S.viewRound} of ${S.latest} · comments are shown on the latest round. `,
        h("button", { class: "btn-link", type: "button", onclick: () => switchRound(S.latest, 0) }, "Go to latest")));
    } else if (S.since) {
      box.append(h("div", { class: "banner info" },
        `Showing changes since round ${S.since} · comments are read-only in this view.`));
    }
  }

  // ---------- file tree ----------

  function buildTree(files) {
    const root = { name: "", dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      for (const p of parts.slice(0, -1)) {
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      }
      node.files.push(f);
    }
    return root;
  }

  // Depth-first: directories first, then files, both alphabetical.
  function treeOrder(node, out = []) {
    for (const k of [...node.dirs.keys()].sort()) treeOrder(node.dirs.get(k), out);
    out.push(...node.files.sort((a, b) => (a.path < b.path ? -1 : 1)));
    return out;
  }

  function openCount(path) {
    if (!S.review) return 0;
    return S.review.comments.filter((c) => c.path === path && c.state === "open").length;
  }

  function renderSidebar() {
    const filter = $("#filter").value.trim().toLowerCase();
    const visible = S.files.filter((f) => !filter || f.path.toLowerCase().includes(filter));
    const tree = $("#tree");
    tree.replaceChildren();
    if (!visible.length) {
      tree.append(h("div", { class: "muted" }, S.files.length ? "No matching files" : ""));
      return;
    }
    const closed = new Set(JSON.parse(store.get("lr:closed-dirs") || "[]"));

    function renderNode(node, prefix) {
      const ul = h("ul", { class: prefix ? "" : "tree" });
      for (const k of [...node.dirs.keys()].sort()) {
        let dir = node.dirs.get(k);
        let label = dir.name;
        // Compress single-child directory chains, like GitHub.
        while (dir.files.length === 0 && dir.dirs.size === 1) {
          const [only] = dir.dirs.values();
          label += "/" + only.name;
          dir = only;
        }
        const full = prefix + label;
        const li = h("li", { class: "tree-dir" + (closed.has(full) ? " closed" : "") },
          h("div", { class: "tree-label", title: full, onclick: () => {
            li.classList.toggle("closed");
            if (li.classList.contains("closed")) closed.add(full); else closed.delete(full);
            store.set("lr:closed-dirs", JSON.stringify([...closed]));
          } }, h("span", { class: "tree-name" }, label)),
          renderNode(dir, full + "/"));
        ul.append(li);
      }
      for (const f of node.files.sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const name = f.path.split("/").pop();
        const count = openCount(f.path);
        const viewed = isViewed(f.path);
        ul.append(h("li", { class: "tree-file" + (viewed ? " viewed" : ""), dataset: { path: f.path } },
          h("div", { class: "tree-label", title: f.path, onclick: () => scrollToFile(f.path) },
            h("span", { class: `st st-${f.status}`, title: statusName(f.status) }, f.status),
            h("span", { class: "tree-name" }, name),
            count ? h("span", { class: "tree-count", title: `${count} open comment${count === 1 ? "" : "s"}` }, count) : null,
            h("span", { class: "tree-stat" },
              h("span", { class: "add" }, `+${f.additions}`), " ", h("span", { class: "del" }, `−${f.deletions}`)),
            viewed ? h("span", { class: "tree-tick", title: "Viewed" }, "✓") : null)));
      }
      return ul;
    }
    tree.append(renderNode(buildTree(visible), ""));
  }

  const statusName = (s) => ({ A: "Added", M: "Modified", D: "Deleted", R: "Renamed" }[s] || s);

  // ---------- main area ----------

  function stickyHeight() {
    return $("#sticky").getBoundingClientRect().height;
  }

  function scrollToFile(path) {
    const entry = S.cards.get(path);
    if (!entry) return;
    entry.card.scrollIntoView({ block: "start" });
  }

  function renderMain() {
    const main = $("#main");
    main.replaceChildren();
    S.cards.clear();
    S.form = null;
    S.sel = null;
    if (!S.files.length) {
      main.append(h("div", { class: "empty-state" }, h("h2", {}, "No changes"),
        h("p", {}, S.since ? `Nothing changed since round ${S.since}.` : "This round has no changes.")));
      return;
    }
    for (const f of S.files) main.append(renderCard(f));
  }

  function diffBlocks(f) {
    const total = f.additions + f.deletions;
    const blocks = h("span", { class: "blocks" });
    let a = total ? Math.round((f.additions / total) * 5) : 0;
    let d = total ? Math.min(5 - a, Math.round((f.deletions / total) * 5)) : 0;
    if (total && a + d === 0) { if (f.additions) a = 1; else d = 1; }
    for (let i = 0; i < 5; i++) blocks.append(h("i", { class: i < a ? "a" : i < a + d ? "d" : "" }));
    return blocks;
  }

  function renderCard(f) {
    const viewed = isViewed(f.path);
    const card = h("section", { class: "file" + (viewed ? " collapsed" : ""), dataset: { path: f.path } });
    const entry = { card, file: f, rows: new Map(), loaded: false, body: null, tbody: null };
    S.cards.set(f.path, entry);

    const chevron = h("button", { class: "chevron", type: "button", "aria-label": "Toggle file",
      onclick: () => { card.classList.toggle("collapsed"); chevron.textContent = card.classList.contains("collapsed") ? "▸" : "▾"; } },
      viewed ? "▸" : "▾");
    const pathEl = h("span", { class: "file-path" });
    if (f.status === "R" && f.oldPath !== f.path) pathEl.append(h("span", { class: "old" }, f.oldPath), " → ");
    pathEl.append(f.path);

    const checkbox = h("input", { type: "checkbox", checked: viewed });
    const viewedLabel = h("label", { class: "viewed-toggle" + (viewed ? " on" : "") }, checkbox, "Viewed");
    checkbox.addEventListener("change", () => setViewed(f.path, checkbox.checked));

    card.append(h("header", { class: "file-header" },
      chevron,
      h("span", { class: `st st-${f.status}`, title: statusName(f.status) }, f.status),
      pathEl,
      h("span", { class: "diffstat" }, h("span", { class: "add" }, `+${f.additions}`),
        h("span", { class: "del" }, `−${f.deletions}`), diffBlocks(f)),
      viewedLabel));

    const body = h("div", { class: "file-body" });
    entry.body = body;
    card.append(body);

    if (f.binary) {
      body.append(h("div", { class: "file-note" }, "Binary file changed"));
    } else if (!f.hunks.length) {
      body.append(h("div", { class: "file-note" }, emptyNote(f)));
    } else if (f.additions + f.deletions > LARGE_FILE_LINES) {
      const note = h("div", { class: "file-note" },
        `Large diff (${f.additions + f.deletions} changed lines) is collapsed. `,
        h("button", { class: "btn btn-sm", type: "button", onclick: () => {
          note.remove();
          renderTable(entry);
          renderThreads();
        } }, "Load diff"));
      body.append(note);
    } else {
      renderTable(entry);
    }
    return card;
  }

  function emptyNote(f) {
    if (f.oldMode && f.newMode && f.oldMode !== f.newMode) return `File mode changed from ${f.oldMode} to ${f.newMode}`;
    if (f.status === "R") return "File renamed without changes";
    if (f.status === "A") return "Empty file added";
    if (f.status === "D") return "Empty file deleted";
    return "No content changes";
  }

  function renderTable(entry) {
    const table = h("table", { class: "diff" },
      h("colgroup", {}, h("col", { class: "num" }), h("col", { class: "num" }), h("col", {})));
    const tbody = h("tbody");
    entry.file.hunks.forEach((hunk, hi) => {
      tbody.append(h("tr", { class: "hunk" }, h("td", { class: "num" }), h("td", { class: "num" }),
        h("td", { class: "code" }, hunk.header)));
      for (const line of hunk.lines) {
        const side = line.type === "del" ? "old" : "new";
        const num = side === "old" ? line.old : line.new;
        const tr = h("tr", { class: "line " + line.type, dataset: { side, num, hunk: hi } },
          h("td", { class: "num" }, line.old ?? ""),
          h("td", { class: "num" }, line.new ?? ""),
          h("td", { class: "code" },
            h("button", { class: "add-comment", type: "button", "aria-label": "Add a comment", tabindex: -1 }, "+"),
            h("span", { class: "marker" }, line.type === "add" ? "+" : line.type === "del" ? "-" : " "),
            line.text,
            line.noeol ? h("span", { class: "noeol", title: "No newline at end of file" }, "⊘") : null));
        entry.rows.set(`${side}:${num}`, tr);
        tbody.append(tr);
      }
    });
    table.append(tbody);
    entry.body.append(table);
    entry.tbody = tbody;
    entry.loaded = true;
  }

  function setViewed(path, on) {
    store.set(viewedKey(path), on ? "1" : null);
    const entry = S.cards.get(path);
    if (entry) {
      entry.card.classList.toggle("collapsed", on);
      $(".chevron", entry.card).textContent = on ? "▸" : "▾";
      $(".viewed-toggle", entry.card).classList.toggle("on", on);
      $(".viewed-toggle input", entry.card).checked = on;
      if (on) {
        const top = entry.card.getBoundingClientRect().top;
        if (top < stickyHeight()) entry.card.scrollIntoView({ block: "start" });
      }
    }
    renderSidebar();
  }

  // ---------- line selection and the comment form ----------

  function rowInfo(tr) {
    const card = tr.closest(".file");
    return { path: card.dataset.path, side: tr.dataset.side, num: Number(tr.dataset.num), hunk: tr.dataset.hunk };
  }

  // A valid range is one side of one hunk; every line in it must exist on that side.
  function rangeValid(a, b) {
    if (a.path !== b.path || a.side !== b.side || a.hunk !== b.hunk) return false;
    const rows = S.cards.get(a.path).rows;
    const lo = Math.min(a.num, b.num), hi = Math.max(a.num, b.num);
    for (let n = lo; n <= hi; n++) {
      const tr = rows.get(`${a.side}:${n}`);
      if (!tr || tr.dataset.hunk !== a.hunk) return false;
    }
    return true;
  }

  function clearSelection() {
    $$("tr.selected").forEach((tr) => tr.classList.remove("selected"));
    S.sel = null;
  }

  function setSelection(a, b) {
    clearSelection();
    const start = Math.min(a.num, b.num), end = Math.max(a.num, b.num);
    S.sel = { path: a.path, side: a.side, hunk: a.hunk, start, end, anchor: a };
    const rows = S.cards.get(a.path).rows;
    for (let n = start; n <= end; n++) rows.get(`${a.side}:${n}`).classList.add("selected");
  }

  const sign = (side) => (side === "new" ? "+" : "-");
  const rangeLabel = (side, start, end) =>
    start === end ? `line ${sign(side)}${start}` : `lines ${sign(side)}${start} to ${sign(side)}${end}`;

  function closeForm() {
    if (S.form) S.form.row.remove();
    S.form = null;
    clearSelection();
  }

  function openForm() {
    const sel = S.sel;
    if (!sel) return;
    const key = `${sel.path}|${sel.side}|${sel.start}|${sel.end}`;
    if (S.form) {
      if (S.form.key === key) { S.form.textarea.focus(); return; }
      if (S.form.textarea.value.trim()) {
        // Keep unsent text; the reviewer must send or cancel it first.
        const keep = S.form;
        const r = keep.sel;
        setSelection({ path: r.path, side: r.side, hunk: r.hunk, num: r.start }, { path: r.path, side: r.side, hunk: r.hunk, num: r.end });
        keep.textarea.focus();
        return;
      }
      S.form.row.remove();
      S.form = null;
    }
    const entry = S.cards.get(sel.path);
    const endRow = entry.rows.get(`${sel.side}:${sel.end}`);
    const textarea = h("textarea", { placeholder: "Leave a comment", rows: 4 });
    const error = h("div", { class: "form-error", hidden: true });
    const submitBtn = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Add review comment");
    const formSel = { ...sel };
    const submit = async () => {
      const body = textarea.value;
      if (!body.trim()) { textarea.focus(); return; }
      submitBtn.disabled = true;
      try {
        await api("POST", "/comments", { path: formSel.path, side: formSel.side, start: formSel.start, end: formSel.end, body });
        if (S.form && S.form.key === key) closeForm();
        await refreshReview();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        submitBtn.disabled = false;
      }
    };
    submitBtn.addEventListener("click", submit);
    bindSubmitKey(textarea, submit);
    const row = h("tr", { class: "form-row" }, h("td", { colspan: 3 },
      h("div", { class: "comment-form" },
        h("div", { class: "form-label" }, `Comment on ${rangeLabel(sel.side, sel.start, sel.end)}`),
        textarea, error,
        h("div", { class: "form-buttons" },
          h("button", { class: "btn btn-sm", type: "button", onclick: closeForm }, "Cancel"),
          submitBtn))));
    let after = endRow;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains("thread-row") &&
           after.nextElementSibling.dataset.key === `${sel.side}:${sel.end}`) {
      after = after.nextElementSibling;
    }
    after.after(row);
    S.form = { row, textarea, key, sel: formSel };
    textarea.focus();
  }

  function bindSubmitKey(textarea, fn) {
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fn(); }
    });
  }

  let drag = null;

  function onMouseDown(e) {
    const btn = e.target.closest(".add-comment");
    if (!btn || !canComment()) return;
    e.preventDefault();
    const info = rowInfo(btn.closest("tr"));
    if (e.shiftKey && S.sel && rangeValid(S.sel.anchor, info)) {
      setSelection(S.sel.anchor, info);
      openForm();
      return;
    }
    drag = { anchor: info };
    setSelection(info, info);
  }

  function onMouseOver(e) {
    if (!drag) return;
    const tr = e.target.closest("tr.line");
    if (!tr) return;
    const info = rowInfo(tr);
    if (rangeValid(drag.anchor, info)) setSelection(drag.anchor, info);
  }

  function onMouseUp() {
    if (!drag) return;
    drag = null;
    openForm();
  }

  // ---------- threads ----------

  function entryEl(c, e, idx, interactive) {
    const isDraft = (idx === 0 && c.state === "draft") || e.draft;
    const key = idx === 0 ? `c${c.id}` : `c${c.id}r${idx}`;
    const who = e.author === "claude" ? "Claude" : "You";
    const tools = h("span", { class: "tools" });
    if (interactive && isDraft) {
      tools.append(
        h("button", { class: "btn-link", type: "button", onclick: () => { S.ui.edit[key] = e.body; renderThreads(); focusKey(key); } }, "Edit"),
        h("button", { class: "btn-link danger", type: "button", onclick: () => run(
          idx === 0 ? api("DELETE", `/comments/${c.id}`) : api("DELETE", `/comments/${c.id}/replies/${idx}`)) }, "Delete"));
    }
    const main = h("div", { class: "entry-main" },
      h("div", { class: "entry-head" },
        h("span", { class: "who" }, who),
        h("span", { class: "when" }, `round ${e.round}`),
        isDraft ? h("span", { class: "badge" }, "Pending") : null,
        tools));
    if (interactive && isDraft && S.ui.edit[key] != null) {
      const ta = h("textarea", { rows: 3, dataset: { key }, value: S.ui.edit[key] });
      ta.addEventListener("input", () => { S.ui.edit[key] = ta.value; });
      const save = () => {
        const body = ta.value;
        const p = idx === 0 ? api("PATCH", `/comments/${c.id}`, { body }) : api("PATCH", `/comments/${c.id}/replies/${idx}`, { body });
        run(p.then(() => { delete S.ui.edit[key]; }));
      };
      bindSubmitKey(ta, save);
      main.append(ta, h("div", { class: "form-buttons" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => { delete S.ui.edit[key]; renderThreads(); } }, "Cancel"),
        h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: save }, "Update comment")));
    } else {
      main.append(richText(e.body));
    }
    return h("div", { class: "entry" },
      h("div", { class: "avatar" + (e.author === "claude" ? " claude" : "") }, who[0]), main);
  }

  function threadEl(c, interactive) {
    const first = c.thread[0] ? c.thread[0].body : "";
    if (c.state === "resolved" && !S.ui.expanded[c.id]) {
      return h("button", { class: "thread-collapsed", type: "button",
        onclick: () => { S.ui.expanded[c.id] = true; renderThreads(); } },
        h("span", { class: "badge resolved" }, "Resolved"),
        h("span", { class: "text" }, truncate(first.split("\n")[0], 100)));
    }
    const box = h("div", { class: "thread", dataset: { id: c.id, state: c.state } });
    const head = [];
    if (c.start !== c.end) head.push(`Comment on ${rangeLabel(c.side, c.start, c.end)}`);
    if (c.state === "resolved") {
      box.append(h("div", { class: "thread-range" }, h("span", { class: "badge resolved" }, "Resolved"), " ",
        head.join(""), " ",
        h("button", { class: "btn-link", type: "button", onclick: () => { delete S.ui.expanded[c.id]; renderThreads(); } }, "Collapse")));
    } else if (head.length) {
      box.append(h("div", { class: "thread-range" }, head.join("")));
    }
    c.thread.forEach((e, i) => box.append(entryEl(c, e, i, interactive)));

    if (interactive && c.state !== "draft") {
      const foot = h("div", { class: "thread-foot" });
      if (S.ui.reply[c.id] != null) {
        const key = `reply${c.id}`;
        const ta = h("textarea", { rows: 3, placeholder: "Reply…", dataset: { key }, value: S.ui.reply[c.id] });
        ta.addEventListener("input", () => { S.ui.reply[c.id] = ta.value; });
        const send = () => {
          if (!ta.value.trim()) return;
          run(api("POST", `/comments/${c.id}/replies`, { body: ta.value }).then(() => { delete S.ui.reply[c.id]; }));
        };
        bindSubmitKey(ta, send);
        foot.append(h("div", { class: "reply-box" }, ta, h("div", { class: "form-buttons" },
          h("button", { class: "btn btn-sm", type: "button", onclick: () => { delete S.ui.reply[c.id]; renderThreads(); } }, "Cancel"),
          h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: send }, "Add reply"))));
      } else {
        foot.append(h("button", { class: "reply-fake", type: "button",
          onclick: () => { S.ui.reply[c.id] = ""; renderThreads(); focusKey(`reply${c.id}`); } }, "Reply…"));
      }
      if (c.state === "open") {
        foot.append(h("button", { class: "btn btn-sm", type: "button",
          onclick: () => run(api("PATCH", `/comments/${c.id}`, { state: "resolved" })) }, "Resolve conversation"));
      } else if (c.state === "resolved") {
        foot.append(h("button", { class: "btn btn-sm", type: "button",
          onclick: () => run(api("PATCH", `/comments/${c.id}`, { state: "open" })) }, "Unresolve conversation"));
      }
      box.append(foot);
    }
    return box;
  }

  function locLabel(c) {
    return `${c.path}:${sign(c.side)}${c.start}${c.end !== c.start ? "-" + c.end : ""}`;
  }

  function outdatedBlock(id, comments, interactive, title) {
    const details = h("details", { class: "outdated-block", open: !!S.ui.outdatedOpen[id] },
      h("summary", {}, `${title} (${comments.length})`));
    details.addEventListener("toggle", () => { S.ui.outdatedOpen[id] = details.open; });
    for (const c of comments) {
      details.append(h("div", { class: "outdated-item" },
        h("div", { class: "outdated-loc" }, h("span", { class: "badge outdated" }, "Outdated"), " ", locLabel(c)),
        h("pre", { class: "anchor" }, c.anchor.join("\n")),
        threadEl(c, interactive)));
    }
    return details;
  }

  function focusKey(key) {
    const el = $(`textarea[data-key="${CSS.escape(key)}"]`);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  function renderThreads() {
    const active = document.activeElement;
    const activeKey = active && active.tagName === "TEXTAREA" ? active.dataset.key : null;
    const selStart = activeKey ? active.selectionStart : 0;
    const selEnd = activeKey ? active.selectionEnd : 0;

    $$(".thread-row, .outdated-block, .orphans").forEach((el) => el.remove());
    if (!S.review || S.viewRound !== S.latest) return;

    const interactive = canComment();
    const byPath = new Map();
    for (const c of S.review.comments) {
      if (!byPath.has(c.path)) byPath.set(c.path, []);
      byPath.get(c.path).push(c);
    }
    const orphans = [];
    for (const [path, list] of byPath) {
      list.sort((a, b) => a.id - b.id);
      const entry = S.cards.get(path);
      const outdated = list.filter((c) => c.state === "outdated");
      const inline = list.filter((c) => c.state !== "outdated");
      if (!entry) {
        if (!S.since) orphans.push(...list);
        continue;
      }
      if (outdated.length) entry.body.prepend(outdatedBlock(path, outdated, interactive, "Outdated comments"));
      if (!entry.loaded) continue;
      for (const c of inline) {
        if (S.since && c.side === "old") continue; // old-side numbers refer to the base
        const key = `${c.side}:${c.end}`;
        const row = entry.rows.get(key);
        if (!row) continue;
        let after = row;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains("thread-row") &&
               after.nextElementSibling.dataset.key === key) {
          after = after.nextElementSibling;
        }
        after.after(h("tr", { class: "thread-row", dataset: { key } },
          h("td", { colspan: 3 }, threadEl(c, interactive))));
      }
    }
    if (orphans.length) {
      $("#main").prepend(h("div", { class: "orphans" },
        outdatedBlock("__orphans", orphans, interactive, "Outdated comments on files without changes")));
    }
    if (activeKey) {
      const el = $(`textarea[data-key="${CSS.escape(activeKey)}"]`);
      if (el) { el.focus(); el.setSelectionRange(selStart, selEnd); }
    }
  }

  // Run a mutation, then refresh; errors surface as an alert-free banner line.
  async function run(promise) {
    try {
      await promise;
    } catch (e) {
      flash(e.message);
    }
    await refreshReview();
  }

  function flash(msg) {
    const el = h("div", { class: "banner danger" }, msg);
    $("#banners").append(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ---------- finish review ----------

  function setupFinish() {
    const btn = $("#finish-btn"), pop = $("#finish-pop"), summary = $("#summary"), err = $("#finish-error");
    btn.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      err.hidden = true;
      if (!pop.hidden) summary.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (!pop.hidden && !e.target.closest(".finish-wrap")) pop.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) pop.hidden = true;
    });
    const submit = async () => {
      const verdict = $('input[name="verdict"]:checked').value;
      const sub = $("#submit-review");
      sub.disabled = true;
      try {
        await api("POST", "/submit", { verdict, summary: summary.value });
        summary.value = "";
        pop.hidden = true;
        S.ui.reply = {};
        S.ui.edit = {};
        await refreshReview();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      } finally {
        sub.disabled = false;
      }
    };
    $("#submit-review").addEventListener("click", submit);
    bindSubmitKey(summary, submit);
  }

  // ---------- data loading and live updates ----------

  async function refreshReview() {
    let data;
    try {
      data = await api("GET", "/review");
    } catch (e) {
      if (e.status === 401) { S.conn = "unauthorized"; renderBanners(); }
      throw e;
    }
    if (!data.review) {
      S.review = null;
      S.ended = true;
      S.version = data.version;
      S.lastResult = data.lastResult;
      document.body.classList.remove("can-comment");
      renderTop();
      renderBanners();
      renderThreads();
      return;
    }
    const replaced = S.review == null ? S.ended : S.review.id !== data.review.id;
    S.review = data.review;
    S.version = data.version;
    S.ended = false;
    S.latest = S.review.rounds.length;
    if (replaced) {
      // A new review started on this server: show it from scratch.
      S.knownRounds = S.latest;
      S.newRound = false;
      S.viewRound = S.latest;
      S.since = 0;
      S.ui = { reply: {}, edit: {}, expanded: {}, outdatedOpen: {}, summary: "" };
      await loadDiff();
      return;
    }
    if (!S.knownRounds) S.knownRounds = S.latest;
    if (S.latest > S.knownRounds) {
      S.newRound = true;
      S.knownRounds = S.latest;
    }
    document.body.classList.toggle("can-comment", canComment());
    renderTop();
    renderBanners();
    renderSidebar();
    renderThreads();
  }

  async function loadDiff() {
    let q = `?round=${S.viewRound}`;
    if (S.since) q += `&since=${S.since}`;
    const data = await api("GET", "/diff" + q);
    S.files = treeOrder(buildTree(data.files));
    document.body.classList.toggle("can-comment", canComment());
    renderTop();
    renderBanners();
    renderMain();
    renderSidebar();
    renderThreads();
  }

  // Switch round/view, keeping the topmost visible file at the same offset where possible.
  async function switchRound(round, since) {
    const anchor = currentFile();
    const offset = anchor ? S.cards.get(anchor).card.getBoundingClientRect().top : 0;
    S.viewRound = round;
    S.since = since;
    if (round === S.latest) S.newRound = false;
    await loadDiff();
    const entry = anchor && S.cards.get(anchor);
    if (entry) window.scrollBy(0, entry.card.getBoundingClientRect().top - offset);
  }

  async function poll() {
    let failures = 0;
    for (;;) {
      try {
        const d = await api("GET", `/events?version=${S.version}`);
        if (S.conn !== "ok") { S.conn = "ok"; renderBanners(); }
        failures = 0;
        if (d.version !== S.version) await refreshReview();
      } catch (e) {
        if (e.status === 401) { S.conn = "unauthorized"; renderBanners(); return; }
        if (e.status === 404) { await sleep(2000); continue; }
        failures++;
        if (failures >= 2 && S.conn !== "lost") { S.conn = "lost"; renderBanners(); }
        await sleep(Math.min(10000, 1000 * failures));
      }
    }
  }

  // ---------- keyboard ----------

  function currentFile() {
    const top = stickyHeight() + 4;
    let current = null;
    for (const [path, entry] of S.cards) {
      const r = entry.card.getBoundingClientRect();
      if (r.top <= top + 1) current = path;
      if (r.bottom > top && r.top <= top + 1) return path;
      if (r.top > top) return current || path;
    }
    return current;
  }

  function moveFile(delta) {
    const paths = [...S.cards.keys()];
    if (!paths.length) return;
    const cur = currentFile();
    let i = paths.indexOf(cur);
    const r = cur ? S.cards.get(cur).card.getBoundingClientRect() : null;
    // If the current card is not aligned at the top yet, `j` goes to it first.
    if (delta > 0 && r && r.top > stickyHeight() + 8) i -= 1;
    i = Math.max(0, Math.min(paths.length - 1, i + delta));
    scrollToFile(paths[i]);
  }

  function nextThread() {
    const threads = $$('.thread[data-state="open"]');
    if (!threads.length) return;
    const top = stickyHeight() + 40;
    const next = threads.find((t) => t.getBoundingClientRect().top > top) || threads[0];
    const card = next.closest(".file");
    if (card && card.classList.contains("collapsed")) setViewed(card.dataset.path, false);
    window.scrollBy(0, next.getBoundingClientRect().top - top);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "j") moveFile(1);
    else if (e.key === "k") moveFile(-1);
    else if (e.key === "n") nextThread();
    else if (e.key === "v") {
      const path = currentFile();
      if (path) setViewed(path, !isViewed(path));
    } else return;
    e.preventDefault();
  }

  // ---------- layout: sticky height, sidebar ----------

  function setupLayout() {
    const sticky = $("#sticky");
    const update = () => document.documentElement.style.setProperty("--sticky-h", sticky.getBoundingClientRect().height + "px");
    new ResizeObserver(update).observe(sticky);
    update();

    const saved = Number(store.get("lr:sidebar-w"));
    if (saved >= 160) document.documentElement.style.setProperty("--sidebar-w", saved + "px");
    if (store.get("lr:sidebar-hidden") === "1") document.body.classList.add("sidebar-hidden");

    $("#toggle-sidebar").addEventListener("click", () => {
      if (window.matchMedia("(max-width: 768px)").matches) {
        document.body.classList.toggle("sidebar-shown");
      } else {
        const hidden = document.body.classList.toggle("sidebar-hidden");
        store.set("lr:sidebar-hidden", hidden ? "1" : null);
      }
    });

    const resizer = $("#resizer");
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const move = (ev) => {
        const w = Math.max(160, Math.min(window.innerWidth * 0.6, ev.clientX - 4));
        document.documentElement.style.setProperty("--sidebar-w", w + "px");
        store.set("lr:sidebar-w", String(Math.round(w)));
      };
      const up = () => {
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    $("#filter").addEventListener("input", renderSidebar);
    $("#round-select").addEventListener("change", (e) => {
      const round = Number(e.target.value);
      switchRound(round, S.since && S.since < round ? S.since : 0);
    });
    $("#view-select").addEventListener("change", (e) => switchRound(S.viewRound, Number(e.target.value)));

    const main = $("#main");
    main.addEventListener("mousedown", onMouseDown);
    main.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKey);
  }

  async function init() {
    setupLayout();
    setupFinish();
    if (!token) {
      S.conn = "unauthorized";
      renderBanners();
      return;
    }
    try {
      await refreshReview();
      if (S.review) {
        S.viewRound = S.latest;
        await loadDiff();
      }
    } catch (e) {
      if (e.network) { S.conn = "lost"; renderBanners(); }
      else if (e.status !== 401) flash(e.message);
    }
    poll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
