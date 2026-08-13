/* Milady Daily v2 — independent Wordle-style mechanics, MLP presentation. */
(() => {
  "use strict";

  const ANSWERS = window.MILADY_DAILY_ANSWERS || [];
  const VALID = window.MILADY_DAILY_GUESSES || new Set();
  const MAX_ROWS = 6;
  const WORD_LEN = 5;
  const EPOCH = new Date(2026, 7, 13);

  function scoreGuess(guess, answer) {
    const score = Array(WORD_LEN).fill("absent");
    const remaining = {};

    // First pass: exact matches.
    for (let i = 0; i < WORD_LEN; i++) {
      if (guess[i] === answer[i]) score[i] = "correct";
      else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
    }

    // Second pass: misplaced matches, consuming remaining letters.
    for (let i = 0; i < WORD_LEN; i++) {
      if (score[i] === "correct") continue;
      const ch = guess[i];
      if ((remaining[ch] || 0) > 0) {
        score[i] = "present";
        remaining[ch]--;
      }
    }
    return score;
  }

  function boot() {
    const board = document.getElementById("dailyBoard");
    const keyboard = document.getElementById("dailyKeyboard");
    if (!board || !keyboard || !ANSWERS.length) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const puzzleNo = Math.max(1, Math.floor((today - EPOCH) / 86400000) + 1);
    const answerObj = ANSWERS[(puzzleNo - 1) % ANSWERS.length];
    const answer = answerObj.word.toUpperCase();
    VALID.add(answer);

    const dateKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const saveKey = `mlp-daily-v2-${dateKey}`;
    const statsKey = "mlp-daily-v2-stats";

    let state = { guesses: [], current: "", finished: false, won: false };
    try {
      const saved = JSON.parse(localStorage.getItem(saveKey) || "null");
      if (saved && Array.isArray(saved.guesses)) state = {...state, ...saved, current:""};
    } catch {}

    const puzzleLabel = document.getElementById("dailyPuzzleNo");
    if (puzzleLabel) puzzleLabel.textContent = `PUZZLE NO. ${String(puzzleNo).padStart(3,"0")}`;

    board.innerHTML = "";
    for (let r=0; r<MAX_ROWS; r++) {
      const row = document.createElement("div");
      row.className = "daily-row";
      row.setAttribute("aria-label", `Guess ${r+1}`);
      for (let c=0; c<WORD_LEN; c++) {
        const tile = document.createElement("div");
        tile.className = "daily-cell";
        tile.setAttribute("aria-label", `Row ${r+1}, column ${c+1}`);
        row.appendChild(tile);
      }
      board.appendChild(row);
    }

    keyboard.innerHTML = "";
    [
      ["Q","W","E","R","T","Y","U","I","O","P"],
      ["A","S","D","F","G","H","J","K","L"],
      ["ENTER","Z","X","C","V","B","N","M","BACKSPACE"]
    ].forEach(keys => {
      const row = document.createElement("div");
      row.className = "daily-keyrow";
      keys.forEach(key => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "daily-key" + (key.length > 1 ? " wide" : "");
        b.dataset.key = key;
        b.textContent = key === "BACKSPACE" ? "DEL" : key;
        row.appendChild(b);
      });
      keyboard.appendChild(row);
    });

    const setMessage = msg => {
      const el = document.getElementById("dailyMessage");
      if (el) el.textContent = msg;
    };
    const save = () => localStorage.setItem(saveKey, JSON.stringify(state));
    const rank = s => s==="correct" ? 3 : s==="present" ? 2 : s==="absent" ? 1 : 0;

    function paint() {
      const rows = [...board.querySelectorAll(".daily-row")];
      const keyState = {};

      rows.forEach((row, ri) => {
        row.classList.toggle("active", !state.finished && ri === state.guesses.length);
        [...row.children].forEach(tile => {
          tile.textContent = "";
          tile.className = "daily-cell";
        });
      });

      keyboard.querySelectorAll(".daily-key").forEach(k => k.classList.remove("correct","present","absent"));

      state.guesses.forEach((guess, ri) => {
        const scored = scoreGuess(guess, answer);
        [...guess].forEach((ch, ci) => {
          const tile = rows[ri]?.children[ci];
          if (!tile) return;
          tile.textContent = ch;
          tile.classList.add(scored[ci]);
          if (rank(scored[ci]) > rank(keyState[ch])) keyState[ch] = scored[ci];
        });
      });

      if (!state.finished && state.guesses.length < MAX_ROWS) {
        const row = rows[state.guesses.length];
        [...state.current].forEach((ch, ci) => {
          const tile = row?.children[ci];
          if (tile) {
            tile.textContent = ch;
            tile.classList.add("filled");
          }
        });
      }

      Object.entries(keyState).forEach(([ch,status]) => {
        keyboard.querySelector(`[data-key="${ch}"]`)?.classList.add(status);
      });

      if (state.finished) {
        const share = document.getElementById("dailyShareBtn");
        if (share) share.disabled = false;
        showFileNote();
        setMessage(state.won ? `FILED ${state.guesses.length}/6.` : `CLOSED. ANSWER: ${answer}.`);
      }
    }

    function stats() {
      let s = {played:0,wins:0,streak:0,best:0,lastDate:""};
      try { s = {...s, ...JSON.parse(localStorage.getItem(statsKey)||"{}")}; } catch {}
      return s;
    }

    function recordResult() {
      const s = stats();
      if (s.lastDate === dateKey) return;
      s.played++;
      if (state.won) {
        s.wins++;
        s.streak++;
        s.best = Math.max(s.best, s.streak);
      } else s.streak = 0;
      s.lastDate = dateKey;
      localStorage.setItem(statsKey, JSON.stringify(s));
    }

    function showFileNote() {
      const el = document.getElementById("dailyFileNote");
      if (!el) return;
      el.innerHTML = `<div class="eyebrow">File note / ${answerObj.tier}</div>
        <h3>${answer}</h3>
        <p>${answerObj.note}</p>
        <div class="mono" style="font-size:9px">FILED BY MLP NEWS DESK 95 / MILADY DAILY</div>`;
      el.hidden = false;
    }

    function finish(won) {
      state.finished = true;
      state.won = won;
      state.current = "";
      save();
      recordResult();
      paint();
    }

    function submit() {
      if (state.finished) return;
      if (state.current.length !== WORD_LEN) return setMessage("NOT ENOUGH LETTERS.");

      const guess = state.current.toUpperCase();
      if (!VALID.has(guess)) return setMessage("NOT IN WORD LIST.");

      state.guesses.push(guess);
      state.current = "";
      save();

      if (guess === answer) return finish(true);
      if (state.guesses.length >= MAX_ROWS) return finish(false);

      setMessage(`${MAX_ROWS-state.guesses.length} TRIES REMAIN.`);
      paint();
    }

    function input(key) {
      if (state.finished) return;
      if (key === "ENTER") return submit();
      if (key === "BACKSPACE") {
        state.current = state.current.slice(0,-1);
        return paint();
      }
      if (/^[A-Z]$/.test(key) && state.current.length < WORD_LEN) {
        state.current += key;
        paint();
      }
    }

    keyboard.addEventListener("click", e => {
      const key = e.target.closest("[data-key]")?.dataset.key;
      if (key) input(key);
    });

    document.addEventListener("keydown", e => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (["input","textarea","select"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter") { e.preventDefault(); input("ENTER"); }
      else if (e.key === "Backspace") { e.preventDefault(); input("BACKSPACE"); }
      else if (/^[a-zA-Z]$/.test(e.key)) input(e.key.toUpperCase());
    });

    document.getElementById("dailyStatsBtn")?.addEventListener("click", () => {
      const s = stats();
      const rate = s.played ? Math.round(100*s.wins/s.played) : 0;
      const el = document.getElementById("dailyStats");
      el.innerHTML = `<div class="eyebrow">Local circulation report</div><h3>Desk Statistics</h3>
        <div class="daily-stat-grid">
          <div class="daily-stat"><b>${s.played}</b><span>Played</span></div>
          <div class="daily-stat"><b>${rate}%</b><span>Win</span></div>
          <div class="daily-stat"><b>${s.streak}</b><span>Streak</span></div>
          <div class="daily-stat"><b>${s.best}</b><span>Best</span></div>
        </div>`;
      el.hidden = !el.hidden;
    });

    document.getElementById("dailyShareBtn")?.addEventListener("click", async () => {
      const symbols = {correct:"🟩",present:"🟨",absent:"⬛"};
      const grid = state.guesses.map(g => scoreGuess(g,answer).map(s=>symbols[s]).join("")).join("\n");
      const result = `MILADY DAILY #${String(puzzleNo).padStart(3,"0")} ${state.won?state.guesses.length:"X"}/6\n\n${grid}\n\nMLP NEWS DESK 95\nhttps://www.miladylineprinter.xyz/daily.html`;
      try {
        await navigator.clipboard.writeText(result);
        setMessage("RESULT COPIED TO CLIPBOARD.");
      } catch { setMessage("CLIPBOARD UNAVAILABLE."); }
    });

    paint();
  }

  // Export scoring for browser-console regression checks.
  window.MiladyDailyEngine = { scoreGuess };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
