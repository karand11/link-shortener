const $ = (s) => document.querySelector(s);
// All server-supplied text (URLs, referrers) goes in via textContent, never innerHTML.

// Manage tokens are the only proof of ownership (there are no accounts), so they live in this browser only.
const tokens = () => {
  try {
    return JSON.parse(localStorage.getItem("snip-tokens")) || {};
  } catch {
    return {};
  }
};
function setTokens(t) {
  try {
    localStorage.setItem("snip-tokens", JSON.stringify(t));
  } catch {} // storage can be blocked; the link just can't be deleted from here
}

async function deleteLink(slug) {
  const res = await fetch(`/api/links/${slug}`, { method: "DELETE", headers: { Authorization: `Bearer ${tokens()[slug]}` } });
  if (res.ok) {
    const t = tokens();
    delete t[slug];
    setTokens(t);
  }
  return res.ok;
}

// Two-step delete (click, then click again within 4s) instead of a blocking confirm() dialog.
function armedDelete(btn, run) {
  const label = btn.textContent;
  let armed = false, timer;
  const reset = () => {
    armed = false;
    btn.textContent = label;
    btn.disabled = false;
  };
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Click again to confirm";
      timer = setTimeout(reset, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    if (!(await run())) {
      reset();
      btn.textContent = "Delete failed, retry";
    }
  });
}

const dateFmt = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const expiryText = (at) => (at === null ? "Never expires" : at <= Date.now() ? `Expired on ${dateFmt(at)}` : `Expires ${dateFmt(at)}`);

function showCreate() {
  $("#create").hidden = false;
  const error = $("#error");
  let current = null;

  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = $("#note").textContent = "";
    $("#result").hidden = true;
    const body = { url: $("#url").value.trim() };
    if ($("#slug").value.trim()) body.slug = $("#slug").value.trim();
    if ($("#days").value) body.days = Number($("#days").value);
    try {
      const res = await fetch("/api/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      current = data.slug;
      setTokens({ ...tokens(), [data.slug]: data.token });
      const short = `${location.origin}/${data.slug}`;
      $("#short").textContent = short;
      $("#short").href = short;
      $("#statsLink").href = `/stats/${data.slug}`;
      $("#expiry").textContent = expiryText(data.expiresAt);
      $("#result").hidden = false;
    } catch (err) {
      error.textContent = err.message;
    }
  });

  armedDelete($("#del"), async () => {
    if (!(await deleteLink(current))) return false;
    $("#result").hidden = true;
    $("#note").textContent = "Link deleted. The short URL no longer works.";
    return true;
  });

  $("#copy").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText($("#short").textContent);
      e.target.textContent = "Copied!";
    } catch {
      e.target.textContent = "Copy failed";
    }
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  });
}

const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n) => `${n} click${n === 1 ? "" : "s"}`;

async function showStats(slug) {
  $("#stats").hidden = false;
  document.title = `Stats for ${slug} | Snip`;
  $("#statsShort").textContent = `${location.host}/${slug}`;

  $("#toggle").addEventListener("click", (e) => {
    const open = $("#table").hidden;
    $("#table").hidden = !open;
    e.target.setAttribute("aria-expanded", open);
    e.target.textContent = open ? "Hide table" : "Show as table";
  });
  $("#range").addEventListener("change", load);

  // Only the browser that created the link holds its token, so only it sees Delete.
  if (tokens()[slug]) {
    $("#delStats").hidden = false;
    armedDelete($("#delStats"), async () => {
      if (!(await deleteLink(slug))) return false;
      for (const el of document.querySelectorAll("#stats > :not(h1):not(#deleted)")) el.hidden = true;
      $("#deleted").textContent = "Link deleted. The short URL no longer works.";
      return true;
    });
  }

  await load();

  async function load() {
    const res = await fetch(`/api/links/${slug}/stats?days=${$("#range").value}`);
    if (!res.ok) {
      $("#statsUrl").textContent = "(link not found)";
      return;
    }
    render(await res.json());
  }
}

function render(s) {
  $("#statsUrl").textContent = s.url;
  $("#expires").textContent = expiryText(s.expiresAt);
  $("#total").textContent = s.total;

  const max = Math.max(1, ...s.days.map((d) => d.clicks));
  $("#ymax").textContent = max;
  $("#xfirst").textContent = fmt(s.days[0].date);
  $("#xlast").textContent = fmt(s.days.at(-1).date);

  const tip = $("#tip");
  const plot = $("#plot");
  plot.replaceChildren();
  for (const d of s.days) {
    const col = document.createElement("div");
    col.className = "col";
    col.tabIndex = 0; // keyboard users get the tooltip too
    col.setAttribute("role", "img");
    col.setAttribute("aria-label", `${fmt(d.date)}: ${plural(d.clicks)}`);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${(d.clicks / max) * 100}%`;
    col.append(bar);
    const show = () => {
      tip.textContent = `${fmt(d.date)} · ${plural(d.clicks)}`;
      tip.hidden = false;
      // Column centre, clamped so the tooltip stays inside the chart.
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(col.offsetLeft + col.offsetWidth / 2, half), plot.offsetWidth - half)}px`;
    };
    const hide = () => (tip.hidden = true);
    col.addEventListener("pointerenter", show);
    col.addEventListener("pointerleave", hide);
    col.addEventListener("focus", show);
    col.addEventListener("blur", hide);
    plot.append(col);
  }

  // Table view: the same numbers for screen readers and anyone who prefers rows.
  const tbody = $("#table tbody");
  tbody.replaceChildren();
  for (const d of s.days) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = fmt(d.date);
    tr.insertCell().textContent = d.clicks;
  }

  const refs = $("#refs");
  refs.replaceChildren();
  if (!s.referrers.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No clicks yet";
    refs.append(li);
  }
  for (const r of s.referrers) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = r.name;
    const n = document.createElement("span");
    n.textContent = r.clicks;
    li.append(name, n);
    refs.append(li);
  }
}

// Dispatch last: the helpers above are `const`s and must be initialised before either page function runs.
const m = location.pathname.match(/^\/stats\/([A-Za-z0-9_-]{3,32})$/);
m ? showStats(m[1]) : showCreate();
