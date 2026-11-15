"use strict";

/* =========================================================
   Mental health Predictor
   ========================================================= */

/* ---------- Configuration ---------- */
const API_BASE_URL = "http://127.0.0.1:2200";
const PREDICT_URL = `${API_BASE_URL}/predict`;
const REQUEST_TIMEOUT_MS = 20000;
const MIN_LOADING_MS = 600; // keeps the loading animation from flashing on fast responses

// Assumed scale of the predicted score (higher = better mental health).
// Change SCORE_MAX and the band thresholds below if your model uses another scale.
const SCORE_MAX = 10;
const SCORE_BANDS = [
  {
    upTo: 0.5,
    tone: "low",
    label: "Low score",
    message: "The model predicts weaker mental health for this combination of habits.",
  },
  {
    upTo: 0.7,
    tone: "mid",
    label: "Moderate score",
    message: "The model predicts mid-range mental health for this combination of habits.",
  },
  {
    upTo: Infinity,
    tone: "high",
    label: "High score",
    message: "The model predicts stronger mental health for this combination of habits.",
  },
];

const ARC_LENGTH = Math.PI * 80; // length of the gauge arc (radius 80)

/* Mirrors the StudentData Pydantic model. */
const FIELDS = {
  age:                     { label: "Age",                     type: "int",    min: 10, max: 100 },
  gender:                  { label: "Gender",                  type: "choice" },
  country:                 { label: "Country",                 type: "text" },
  academic_level:          { label: "Academic level",          type: "choice" },
  most_used_platform:      { label: "Most used platform",      type: "choice" },
  purpose_of_use:          { label: "Main purpose of use",     type: "choice" },
  avg_daily_usage_hours:   { label: "Daily social media use",  type: "float",  min: 0, max: 24 },
  daily_unlocks:           { label: "Phone unlocks per day",   type: "int",    min: 0 },
  study_hours:             { label: "Study time",              type: "float",  min: 0, max: 24 },
  physical_activity_hours: { label: "Physical activity",       type: "float",  min: 0, max: 24 },
  sleep_hours_per_night:   { label: "Sleep per night",         type: "float",  min: 0, max: 24 },
  stress_level:            { label: "Stress level",            type: "choice" },
};

/* ---------- DOM references ---------- */
const form = document.getElementById("predict-form");
const submitBtn = document.getElementById("submit-btn");
const panel = document.getElementById("result-panel");
const gaugeFill = document.getElementById("gauge-fill");
const scoreValue = document.getElementById("score-value");
const bandLabel = document.getElementById("band-label");
const bandMessage = document.getElementById("band-message");
const errorTitle = document.getElementById("error-title");
const errorMessage = document.getElementById("error-message");
const errorList = document.getElementById("error-list");

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let countFrame = null;

document.getElementById("score-max").textContent = SCORE_MAX;
document.getElementById("scale-max").textContent = SCORE_MAX;

/* ---------- Helpers ---------- */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApiError extends Error {
  constructor(status, data, kind = "http") {
    super(kind);
    this.status = status;
    this.data = data;
    this.kind = kind;
  }
}

/* =========================================================
   Sliders (range input stays in sync with the number input)
   ========================================================= */
const sliderPainters = [];

function setupSliders() {
  form.querySelectorAll('input[type="range"][data-sync]').forEach((range) => {
    const number = form.elements[range.dataset.sync];

    const paint = () => {
      const min = Number(range.min);
      const max = Number(range.max);
      const pct = ((Number(range.value) - min) / (max - min)) * 100;
      range.style.setProperty("--pct", `${pct}%`);
    };

    range.addEventListener("input", () => {
      number.value = range.value;
      paint();
    });

    number.addEventListener("input", () => {
      const n = parseFloat(number.value);
      if (Number.isFinite(n)) {
        range.value = Math.min(Math.max(n, Number(range.min)), Number(range.max));
      }
      paint();
    });

    sliderPainters.push(paint);
    paint();
  });
}

/* =========================================================
   Validation (same rules as the backend)
   ========================================================= */
function collectAndValidate() {
  const payload = {};
  const errors = {};

  for (const [name, rule] of Object.entries(FIELDS)) {
    const raw = String(form.elements[name].value ?? "").trim();

    if (raw === "") {
      errors[name] = rule.type === "choice" ? "Select an option." : "This field is required.";
      continue;
    }

    if (rule.type === "int" || rule.type === "float") {
      const n = Number(raw);

      if (!Number.isFinite(n)) {
        errors[name] = "Enter a number.";
        continue;
      }
      if (rule.type === "int" && !Number.isInteger(n)) {
        errors[name] = "Use a whole number.";
        continue;
      }
      if (rule.max !== undefined && (n < rule.min || n > rule.max)) {
        errors[name] = `Enter a value between ${rule.min} and ${rule.max}.`;
        continue;
      }
      if (rule.max === undefined && n < rule.min) {
        errors[name] = `Enter ${rule.min} or more.`;
        continue;
      }
      payload[name] = n;
    } else {
      payload[name] = raw;
    }
  }

  return { payload, errors };
}

/* ---------- Inline error display ---------- */
function getInvalidTarget(name) {
  const control = form.elements[name];
  return control instanceof RadioNodeList ? control[0].closest(".segmented") : control;
}

function showFieldError(name, message) {
  const target = getInvalidTarget(name);
  const errorEl = document.getElementById(`err-${name}`);
  if (!target || !errorEl) return;

  errorEl.textContent = message;
  target.classList.add("is-invalid");
  if (target.tagName !== "DIV") target.setAttribute("aria-invalid", "true");
}

function clearFieldError(name) {
  const target = getInvalidTarget(name);
  const errorEl = document.getElementById(`err-${name}`);
  if (!target || !errorEl) return;

  errorEl.textContent = "";
  target.classList.remove("is-invalid");
  target.removeAttribute("aria-invalid");
}

function clearAllErrors() {
  Object.keys(FIELDS).forEach(clearFieldError);
}

function focusFirstInvalid(names) {
  const first = Object.keys(FIELDS).find((name) => names.includes(name));
  if (!first) return;
  const control = form.elements[first];
  (control instanceof RadioNodeList ? control[0] : control).focus();
}

/* =========================================================
   Result panel
   ========================================================= */
function resetGauge() {
  cancelAnimationFrame(countFrame);
  gaugeFill.style.transition = "none";
  gaugeFill.style.strokeDashoffset = ARC_LENGTH;
  scoreValue.textContent = "–";
  delete panel.dataset.tone;
}

function setState(state) {
  if (state !== "result") resetGauge();
  panel.dataset.state = state;
}

function animateGauge(fraction) {
  gaugeFill.style.transition = "none";
  gaugeFill.style.strokeDashoffset = ARC_LENGTH;
  void gaugeFill.getBoundingClientRect(); // force reflow so the transition restarts
  gaugeFill.style.transition = "";
  requestAnimationFrame(() => {
    gaugeFill.style.strokeDashoffset = ARC_LENGTH * (1 - fraction);
  });
}

function countUp(target) {
  cancelAnimationFrame(countFrame);

  if (prefersReducedMotion.matches) {
    scoreValue.textContent = target.toFixed(2);
    return;
  }

  const duration = 900;
  const start = performance.now();

  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    scoreValue.textContent = (target * eased).toFixed(2);
    if (t < 1) countFrame = requestAnimationFrame(tick);
  };
  countFrame = requestAnimationFrame(tick);
}

function showResult(score) {
  const fraction = Math.min(Math.max(score / SCORE_MAX, 0), 1);
  const band = SCORE_BANDS.find((b) => fraction < b.upTo) ?? SCORE_BANDS[SCORE_BANDS.length - 1];

  panel.dataset.tone = band.tone;
  bandLabel.textContent = band.label;
  bandMessage.textContent = band.message;

  setState("result");
  animateGauge(fraction);
  countUp(score);
}

function showError({ title, message, items = [] }) {
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorList.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );
  setState("error");
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? "Predicting…" : "Predict score";
  panel.setAttribute("aria-busy", String(isLoading));

  if (isLoading) {
    setState("loading");
    if (window.matchMedia("(max-width: 900px)").matches) {
      panel.scrollIntoView({
        behavior: prefersReducedMotion.matches ? "auto" : "smooth",
        block: "start",
      });
    }
  }
}

/* =========================================================
   API
   ========================================================= */
async function requestPrediction(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const [response] = await Promise.all([
      fetch(PREDICT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }),
      wait(MIN_LOADING_MS),
    ]);

    const data = await response.json().catch(() => null);

    if (!response.ok) throw new ApiError(response.status, data);

    const score = data?.predicted_mental_health_score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new ApiError(response.status, data, "unexpected-response");
    }
    return score;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Error handling ---------- */
function handleValidationError(data) {
  const details = Array.isArray(data?.detail) ? data.detail : [];
  const general = [];
  const fieldNames = [];

  details.forEach((item) => {
    const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : null;
    const message = item.msg ?? "Invalid value.";

    if (field in FIELDS) {
      showFieldError(field, message);
      fieldNames.push(field);
      general.push(`${FIELDS[field].label}: ${message}`);
    } else {
      general.push(message);
    }
  });

  showError({
    title: "The API rejected some inputs",
    message: "Fix the highlighted fields and try again.",
    items: general,
  });
  focusFirstInvalid(fieldNames);
}

function handleRequestError(error) {
  if (error instanceof ApiError) {
    if (error.status === 422) {
      handleValidationError(error.data);
      return;
    }

    if (error.kind === "unexpected-response") {
      showError({
        title: "Unexpected response",
        message: "The API replied, but the response did not contain a predicted score.",
      });
      return;
    }

    if (error.status >= 500) {
      showError({
        title: "The server hit an error",
        message: "The model could not produce a prediction. Check the uvicorn terminal for the traceback.",
      });
      return;
    }

    const detail = typeof error.data?.detail === "string" ? error.data.detail : "";
    showError({
      title: `Request failed (${error.status})`,
      message: detail || "The API could not process this request.",
    });
    return;
  }

  if (error?.name === "AbortError") {
    showError({
      title: "The request timed out",
      message: `The API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Check that it is running and try again.`,
    });
    return;
  }

  showError({
    title: "Can't reach the API",
    message: `No response from ${API_BASE_URL}. Make sure uvicorn is running on port 2200 and that the backend allows requests from this page (CORS).`,
  });
}

/* =========================================================
   Events
   ========================================================= */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAllErrors();

  const { payload, errors } = collectAndValidate();
  const invalidNames = Object.keys(errors);

  if (invalidNames.length > 0) {
    invalidNames.forEach((name) => showFieldError(name, errors[name]));
    focusFirstInvalid(invalidNames);
    return;
  }

  setLoading(true);
  try {
    const score = await requestPrediction(payload);
    showResult(score);
  } catch (error) {
    handleRequestError(error);
  } finally {
    setLoading(false);
  }
});

// Clear a field's error as soon as the person edits it.
["input", "change"].forEach((type) => {
  form.addEventListener(type, (event) => {
    const name = event.target.name || event.target.dataset.sync;
    if (name in FIELDS) clearFieldError(name);
  });
});

form.addEventListener("reset", () => {
  clearAllErrors();
  setState("idle");
  // Wait for the browser to restore default values, then repaint the sliders.
  setTimeout(() => sliderPainters.forEach((paint) => paint()), 0);
});

setupSliders();
setState("idle");
