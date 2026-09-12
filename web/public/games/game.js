const kind = document.querySelector("main").dataset.game,
  board = document.getElementById("board"),
  status = document.getElementById("status"),
  instructions = document.getElementById("instructions");
if (kind === "tic") {
  let cells, player;
  instructions.textContent = "Two players. Three in a row. A classic.";
  function reset() {
    cells = Array(9).fill("");
    player = "X";
    board.className = "tic-board";
    render();
  }
  function render() {
    const won = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ].find((a) => cells[a[0]] && a.every((i) => cells[i] === cells[a[0]]));
    status.textContent = won
      ? cells[won[0]] + " wins!"
      : cells.every(Boolean)
        ? "A well-matched draw."
        : player + " to play";
    board.replaceChildren(
      ...cells.map((value, i) => {
        const b = document.createElement("button");
        b.textContent = value || "·";
        b.setAttribute("aria-label", "Cell " + (i + 1));
        b.disabled = !!value || !!won;
        b.onclick = () => {
          cells[i] = player;
          player = player === "X" ? "O" : "X";
          render();
        };
        return b;
      }),
    );
  }
  document.getElementById("reset").onclick = reset;
  reset();
} else if (kind === "2048") {
  let cells, score;
  instructions.textContent =
    "Use arrow keys or swipe to combine matching tiles.";
  board.className = "board";
  function add() {
    const empty = cells.map((v, i) => (v ? null : i)).filter((v) => v !== null);
    if (empty.length)
      cells[empty[Math.floor(Math.random() * empty.length)]] =
        Math.random() < 0.9 ? 2 : 4;
  }
  function render() {
    board.replaceChildren(
      ...cells.map((v) => {
        const div = document.createElement("div");
        div.className = "cell" + (v ? " filled" : "");
        div.textContent = v || "";
        if (v)
          div.style.background = `hsl(${85 - Math.log2(v) * 3} 35% ${83 - Math.log2(v) * 3}%)`;
        return div;
      }),
    );
    status.textContent =
      "Score · " + score + (cells.includes(2048) ? " · You made it!" : "");
  }
  function move(direction) {
    const before = JSON.stringify(cells);
    for (let lane = 0; lane < 4; lane++) {
      const indices = Array.from({ length: 4 }, (_, j) =>
        direction === "left"
          ? lane * 4 + j
          : direction === "right"
            ? lane * 4 + 3 - j
            : direction === "up"
              ? j * 4 + lane
              : (3 - j) * 4 + lane,
      );
      const values = indices.map((i) => cells[i]).filter(Boolean),
        merged = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] === values[i + 1]) {
          merged.push(values[i] * 2);
          score += values[i] * 2;
          i++;
        } else merged.push(values[i]);
      }
      indices.forEach((index, j) => (cells[index] = merged[j] || 0));
    }
    if (JSON.stringify(cells) !== before) add();
    render();
    if (
      cells.every(Boolean) &&
      !cells.some(
        (v, i) =>
          (i % 4 < 3 && v === cells[i + 1]) || (i < 12 && v === cells[i + 4]),
      )
    )
      status.textContent = "No more moves. Final score · " + score;
  }
  window.addEventListener("keydown", (e) => {
    const d = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    }[e.key];
    if (d) {
      e.preventDefault();
      move(d);
    }
  });
  let touch;
  board.onpointerdown = (e) => {
    touch = [e.clientX, e.clientY];
    board.setPointerCapture(e.pointerId);
  };
  board.onpointerup = (e) => {
    if (!touch) return;
    const x = e.clientX - touch[0],
      y = e.clientY - touch[1];
    if (Math.max(Math.abs(x), Math.abs(y)) > 20)
      move(
        Math.abs(x) > Math.abs(y)
          ? x > 0
            ? "right"
            : "left"
          : y > 0
            ? "down"
            : "up",
      );
    touch = null;
  };
  function reset() {
    cells = Array(16).fill(0);
    score = 0;
    add();
    add();
    render();
  }
  document.getElementById("reset").onclick = reset;
  reset();
} else {
  instructions.textContent =
    "Arrow keys to steer. Space to pause. Eat. Grow. Repeat.";
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 400;
  canvas.setAttribute("aria-label", "Snake game board");
  board.append(canvas);
  const ctx = canvas.getContext("2d");
  let snake, food, dir, next, timer, paused, over;
  const size = 20;
  function spawn() {
    do {
      food = [
        Math.floor(Math.random() * size),
        Math.floor(Math.random() * size),
      ];
    } while (snake.some((p) => p[0] === food[0] && p[1] === food[1]));
  }
  function draw() {
    ctx.fillStyle = "#1d2b22";
    ctx.fillRect(0, 0, 400, 400);
    ctx.fillStyle = "#d6ae81";
    ctx.beginPath();
    ctx.arc(food[0] * 20 + 10, food[1] * 20 + 10, 6, 0, Math.PI * 2);
    ctx.fill();
    snake.forEach((p, i) => {
      ctx.fillStyle = i ? "#8dab73" : "#d2ecb7";
      ctx.fillRect(p[0] * 20 + 2, p[1] * 20 + 2, 16, 16);
    });
    status.textContent =
      (over ? "Nice run! " : paused ? "Paused · " : "") +
      "Score · " +
      (snake.length - 3);
  }
  function tick() {
    if (paused || over) return;
    dir = next;
    const head = [snake[0][0] + dir[0], snake[0][1] + dir[1]],
      eating = head[0] === food[0] && head[1] === food[1];
    if (
      head.some((v) => v < 0 || v >= size) ||
      snake
        .slice(0, eating ? snake.length : -1)
        .some((p) => p[0] === head[0] && p[1] === head[1])
    ) {
      over = true;
      draw();
      return;
    }
    snake.unshift(head);
    if (eating) spawn();
    else snake.pop();
    draw();
  }
  function steer(x, y) {
    if (x !== -dir[0] || y !== -dir[1]) next = [x, y];
  }
  window.addEventListener("keydown", (e) => {
    const d = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    }[e.key];
    if (d) {
      e.preventDefault();
      steer(...d);
    }
    if (e.code === "Space") {
      e.preventDefault();
      paused = !paused;
      draw();
    }
  });
  for (const [label, x, y] of [
    ["←", -1, 0],
    ["↑", 0, -1],
    ["↓", 0, 1],
    ["→", 1, 0],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => steer(x, y);
    document.querySelector(".controls").append(b);
  }
  function reset() {
    clearInterval(timer);
    snake = [
      [6, 10],
      [5, 10],
      [4, 10],
    ];
    dir = [1, 0];
    next = dir;
    over = false;
    paused = false;
    spawn();
    draw();
    timer = setInterval(tick, 150);
  }
  document.getElementById("reset").onclick = reset;
  reset();
}
