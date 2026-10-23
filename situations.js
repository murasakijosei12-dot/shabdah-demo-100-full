/* Situations page: category grid + illustrated scenario viewer. */
(function () {
  "use strict";

  const LANGS = [
    { code: "en", label: "English" },
    { code: "ja", label: "日本語" },
    { code: "hi", label: "हिंदी" },
    { code: "fr", label: "Français" },
  ];

  const state = {
    categories: [],
    scenarios: {},
    currentScenarioId: null,
    panelIndex: 0,
    lang: "en",
    audio: null,
  };

  const el = {
    page: document.getElementById("sit-page"),
    grid: document.getElementById("sit-grid"),
    viewer: document.getElementById("sit-viewer"),
    backBtn: document.getElementById("sit-back-btn"),
    title: document.getElementById("sit-viewer-title"),
    sub: document.getElementById("sit-viewer-sub"),
    langPicker: document.getElementById("sit-lang-picker"),
    stageImg: document.getElementById("sit-stage-img"),
    bubbleA: document.getElementById("sit-bubble-a"),
    bubbleB: document.getElementById("sit-bubble-b"),
    prevBtn: document.getElementById("sit-prev-btn"),
    nextBtn: document.getElementById("sit-next-btn"),
    dots: document.getElementById("sit-dots"),
    scriptBody: document.getElementById("sit-script-body"),
  };

  function loadJSON(path) {
    return fetch(path).then((r) => r.json());
  }

  function renderGrid() {
    el.grid.innerHTML = "";
    state.categories
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((cat) => {
        const card = document.createElement(cat.available ? "button" : "div");
        card.className = "sit-card" + (cat.available ? "" : " is-locked");
        card.type = cat.available ? "button" : undefined;
        if (cat.available) {
          card.style.background = cat.color;
        }
        card.innerHTML =
          '<div class="sit-card-swatch" style="background:' + cat.color + '"></div>' +
          '<span class="sit-card-badge">' + (cat.available ? "Try it" : "Coming soon") + "</span>" +
          '<span class="sit-card-label">' + cat.label + "</span>";
        if (cat.available) {
          card.addEventListener("click", () => openScenario(cat.scenario_id, cat.id));
        } else {
          card.setAttribute("aria-disabled", "true");
        }
        el.grid.appendChild(card);
      });
  }

  function renderLangPicker() {
    el.langPicker.innerHTML = "";
    LANGS.forEach((l) => {
      const btn = document.createElement("button");
      btn.className = "sit-lang-btn" + (state.lang === l.code ? " is-active" : "");
      btn.type = "button";
      btn.textContent = l.label;
      btn.addEventListener("click", () => {
        state.lang = l.code;
        renderLangPicker();
        renderPanel();
      });
      el.langPicker.appendChild(btn);
    });
  }

  function audioPath(scenarioId, node, speaker, lang) {
    return "assets/situations/audio/" + scenarioId + "_" + node + "_" + speaker + "_" + lang + ".mp3";
  }

  function playAudio(src) {
    if (state.audio) {
      state.audio.pause();
    }
    state.audio = new Audio(src);
    state.audio.play().catch(() => {});
  }

  function renderPanel() {
    const scenario = state.scenarios[state.currentScenarioId];
    const panel = scenario.panels[state.panelIndex];
    el.stageImg.src = panel.image;
    el.stageImg.alt = scenario.title + " — scene " + (state.panelIndex + 1);

    const lineA = panel.lines[0];
    const lineB = panel.lines[1];
    el.bubbleA.textContent = lineA.text[state.lang];
    el.bubbleB.textContent = lineB.text[state.lang];

    el.prevBtn.disabled = state.panelIndex === 0;
    el.nextBtn.disabled = state.panelIndex === scenario.panels.length - 1;

    el.dots.innerHTML = "";
    scenario.panels.forEach((_, i) => {
      const dot = document.createElement("span");
      dot.className = "sit-dot" + (i === state.panelIndex ? " is-active" : "");
      el.dots.appendChild(dot);
    });

    renderScript(scenario, panel);
  }

  function speakerName(scenario, speaker) {
    return speaker === "staff" ? scenario.staff_label : "You";
  }

  function renderScript(scenario, panel) {
    el.scriptBody.innerHTML = "";
    panel.lines.forEach((line) => {
      const wrap = document.createElement("div");
      wrap.className = "sit-script-line";

      const speakerLabel = document.createElement("div");
      speakerLabel.className = "sit-script-speaker";
      speakerLabel.textContent = speakerName(scenario, line.speaker);
      wrap.appendChild(speakerLabel);

      const grid = document.createElement("div");
      grid.className = "sit-script-grid";
      LANGS.forEach((l) => {
        const cell = document.createElement("div");
        cell.className = "sit-script-cell";
        const playBtn = document.createElement("button");
        playBtn.className = "sit-play-btn";
        playBtn.type = "button";
        playBtn.setAttribute("aria-label", "Play " + l.label + " audio");
        playBtn.textContent = "▶";
        playBtn.addEventListener("click", () =>
          playAudio(audioPath(state.currentScenarioId, panel.node, line.speaker, l.code))
        );
        const tag = document.createElement("span");
        tag.className = "sit-lang-tag";
        tag.textContent = l.code.toUpperCase();
        const text = document.createElement("span");
        text.className = "sit-cell-text";
        text.textContent = line.text[l.code];
        cell.appendChild(playBtn);
        cell.appendChild(tag);
        cell.appendChild(text);
        grid.appendChild(cell);
      });
      wrap.appendChild(grid);
      el.scriptBody.appendChild(wrap);
    });
  }

  function openScenario(scenarioId, categoryId) {
    state.currentScenarioId = scenarioId;
    state.panelIndex = 0;
    const scenario = state.scenarios[scenarioId];
    el.title.textContent = scenario.title;
    el.sub.textContent = "3 scenes · English, Japanese, Hindi & French";
    el.page.classList.add("viewer-mode");
    renderLangPicker();
    renderPanel();
    if (categoryId) {
      history.replaceState(null, "", "#" + categoryId);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeScenario() {
    if (state.audio) {
      state.audio.pause();
    }
    el.page.classList.remove("viewer-mode");
    history.replaceState(null, "", "situations.html");
  }

  el.backBtn.addEventListener("click", closeScenario);
  el.prevBtn.addEventListener("click", () => {
    if (state.panelIndex > 0) {
      state.panelIndex -= 1;
      renderPanel();
    }
  });
  el.nextBtn.addEventListener("click", () => {
    const scenario = state.scenarios[state.currentScenarioId];
    if (state.panelIndex < scenario.panels.length - 1) {
      state.panelIndex += 1;
      renderPanel();
    }
  });

  Promise.all([
    loadJSON("data/situations_categories.json"),
    loadJSON("data/situations_scenarios.json"),
  ]).then(([categories, scenarios]) => {
    state.categories = categories;
    state.scenarios = scenarios;
    renderGrid();

    const hash = location.hash.replace("#", "");
    if (hash) {
      const cat = categories.find((c) => c.id === hash && c.available);
      if (cat) {
        openScenario(cat.scenario_id, cat.id);
      }
    }
  });
})();
