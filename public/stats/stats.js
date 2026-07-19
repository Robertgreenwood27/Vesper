const TOKEN_KEY = "vesper.stats.token";
const EVENT_LABELS = {
  engaged: "Meaningfully engaged",
  stayed_30_seconds: "Stayed 30 seconds",
  stayed_2_minutes: "Stayed 2 minutes",
  stayed_5_minutes: "Stayed 5 minutes",
  return_visit: "Returned on this browser",
  info_panel_used: "Used Info panel",
  care_panel_used: "Used Care panel",
  strand_destination_chosen: "Chose a strand destination",
  web_touched: "Touched the web",
  moth_offered: "Offered a moth",
  moth_meal_completed: "Stayed through a moth meal",
  retreat_used: "Sent Vesper to retreat",
  camera_follow_used: "Used camera follow",
  observation_light_used: "Used observation light",
  vesper_renamed: "Renamed Vesper",
  vestige_listened: "Listened to Vestige",
  load_failed: "Experienced a loading failure",
};

const form = document.querySelector("#auth-form");
const tokenInput = document.querySelector("#token");
const daysInput = document.querySelector("#days");
const message = document.querySelector("#message");
const report = document.querySelector("#report");
const summary = document.querySelector("#summary");
const eventList = document.querySelector("#event-list");
const dailyChart = document.querySelector("#daily-chart");
const rangeLabel = document.querySelector("#report-range");
const generatedAt = document.querySelector("#generated-at");
const forgetToken = document.querySelector("#forget-token");

function metric(label, value, note) {
  const card = document.createElement("article");
  card.className = "metric";
  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = label;
  const count = document.createElement("strong");
  count.textContent = String(value);
  const detail = document.createElement("small");
  detail.textContent = note;
  card.append(heading, count, detail);
  return card;
}

function percentage(value, denominator) {
  return denominator > 0 ? `${Math.round((value / denominator) * 100)}% of engaged` : "No engaged visits yet";
}

function renderSummary(data) {
  const totals = data.totals;
  const engaged = totals.engaged || 0;
  summary.replaceChildren(
    metric("ENGAGED VISITS", engaged, "At least one meaningful action"),
    metric("TWO MINUTES", totals.stayed_2_minutes || 0, percentage(totals.stayed_2_minutes || 0, engaged)),
    metric("WEB TOUCHED", totals.web_touched || 0, percentage(totals.web_touched || 0, engaged)),
    metric("MOTHS OFFERED", totals.moth_offered || 0, percentage(totals.moth_offered || 0, engaged)),
    metric("MEALS COMPLETED", totals.moth_meal_completed || 0, percentage(totals.moth_meal_completed || 0, engaged)),
    metric(
      "VESTIGE LISTENS",
      totals.vestige_listened || 0,
      `10+ seconds of playback · ${percentage(totals.vestige_listened || 0, engaged)}`,
    ),
    metric("RETURN VISITS", totals.return_visit || 0, "Anonymous browser return signal"),
  );
}

function renderEvents(data) {
  const entries = Object.entries(data.totals);
  const maximum = Math.max(1, ...entries.map(([, count]) => count));
  eventList.replaceChildren(...entries.map(([event, count]) => {
    const row = document.createElement("div");
    row.className = "event-row";
    const label = document.createElement("span");
    label.textContent = EVENT_LABELS[event] || event;
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("i");
    fill.style.width = `${(count / maximum) * 100}%`;
    track.append(fill);
    const output = document.createElement("output");
    output.textContent = String(count);
    row.append(label, track, output);
    return row;
  }));
}

function renderDaily(data) {
  const maximum = Math.max(1, ...data.daily.map((day) => day.counts.engaged || 0));
  dailyChart.replaceChildren(...data.daily.map((day) => {
    const column = document.createElement("div");
    column.className = "day";
    column.title = `${day.date}: ${day.counts.engaged || 0} engaged`;
    const count = document.createElement("output");
    count.textContent = String(day.counts.engaged || 0);
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(2, ((day.counts.engaged || 0) / maximum) * 145)}px`;
    const label = document.createElement("span");
    label.textContent = day.date.slice(5);
    column.append(count, bar, label);
    return column;
  }));
}

function render(data) {
  renderSummary(data);
  renderEvents(data);
  renderDaily(data);
  rangeLabel.textContent = `${data.range.from} · ${data.range.days} days · ${data.batches} anonymous batches`;
  generatedAt.textContent = `Generated ${new Date(data.generatedAt).toLocaleString()}`;
  report.hidden = false;
}

async function loadReport(token) {
  message.className = "";
  message.textContent = "Reading the private observation log…";
  const response = await fetch(`/api/engagement-summary?days=${daysInput.value}`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  if (!data || typeof data !== "object" || !data.totals || !Array.isArray(data.daily)) {
    throw new Error("Analytics API unavailable on this deployment.");
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  message.textContent = "Private report loaded.";
  render(data);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadReport(tokenInput.value).catch((error) => {
    report.hidden = true;
    message.className = "error";
    message.textContent = error instanceof Error ? error.message : String(error);
  });
});

daysInput.addEventListener("change", () => {
  if (!tokenInput.value) return;
  void loadReport(tokenInput.value).catch((error) => {
    message.className = "error";
    message.textContent = error instanceof Error ? error.message : String(error);
  });
});

forgetToken.addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  tokenInput.value = "";
  report.hidden = true;
  message.textContent = "Dashboard token forgotten for this tab.";
  tokenInput.focus();
});

const savedToken = sessionStorage.getItem(TOKEN_KEY);
if (savedToken) {
  tokenInput.value = savedToken;
  void loadReport(savedToken).catch(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    tokenInput.value = "";
  });
}
