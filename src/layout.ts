// src/layout.ts

export type Idea = {
  id: string;
  message: string;
  createdAt?: any;
  likeCount?: number;
};

export type Node = {
  id: string;
  message: string;
  x: number;
  y: number;
  r: number; // レイアウト用の基準半径（ここに “最大見た目倍率” 分の余白を含める）
};

type LayoutOptions = {
  gap?: number;
  density?: number;
  iterations?: number;
  centerObstacle?: { x: number; y: number; r: number };
};

function hexToPixel(q: number, r: number, spacing: number) {
  const x = spacing * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = spacing * ((3 / 2) * r);
  return { x, y };
}

function axialSpiral(n: number): Array<{ q: number; r: number }> {
  const coords: Array<{ q: number; r: number }> = [{ q: 0, r: 0 }];
  if (n <= 1) return coords;

  const dirs = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];

  let k = 1;
  while (coords.length < n) {
    let q = -k;
    let r = k;

    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        if (coords.length >= n) return coords;
        coords.push({ q, r });
        q += dirs[side].q;
        r += dirs[side].r;
      }
    }
    k++;
  }
  return coords;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function cellKey(ix: number, iy: number) {
  return `${ix},${iy}`;
}

export function layoutIdeas(ideas: Idea[], opts: LayoutOptions = {}): Node[] {
  // ✅ “元の円” は大きめにして、見やすさも維持
  const baseR = 32;

  // ✅ IdeaMapの見た目倍率が最大 1.22 まで行くので、レイアウト側はそれを確保する
  const MAX_VISUAL_MUL = 1.22;

  const gap = opts.gap ?? 8;
  const density = opts.density ?? 0.86;
  const iterations = opts.iterations ?? 32;

  const maxR = baseR * 1.35 * MAX_VISUAL_MUL;

  const spacing = ((2 * maxR + gap) / Math.sqrt(3)) * density;
  const coords = axialSpiral(ideas.length);

  const nodes: Node[] = ideas.map((idea, i) => {
    const c = coords[i] ?? { q: 0, r: 0 };
    const p = hexToPixel(c.q, c.r, spacing);

    // テキスト長で少し増やす
    const msgLen = idea.message?.length ?? 0;
    const textScale = clamp(1 + Math.floor(msgLen / 7) * 0.06, 1, 1.28);

    // ✅ レイアウト半径には MAX_VISUAL_MUL を掛けておく（見た目で膨らんでも重ならない）
    const r = clamp(baseR * textScale * MAX_VISUAL_MUL, 24, maxR);

    return { id: idea.id, message: idea.message ?? "", x: p.x, y: p.y, r };
  });

  const obstacle = opts.centerObstacle;
  const cellSize = (2 * maxR + gap) * 1.12;

  for (let it = 0; it < iterations; it++) {
    const grid = new Map<string, number[]>();

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const ix = Math.floor(n.x / cellSize);
      const iy = Math.floor(n.y / cellSize);
      const key = cellKey(ix, iy);
      const arr = grid.get(key);
      if (arr) arr.push(i);
      else grid.set(key, [i]);
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];

      // obstacle push
      if (obstacle) {
        let dxObs = a.x - obstacle.x;
        let dyObs = a.y - obstacle.y;
        let dObs = Math.hypot(dxObs, dyObs);
        if (dObs < 1e-6) {
          dxObs = 1;
          dyObs = 0;
          dObs = 1;
        }
        const minDistObs = a.r + obstacle.r + gap;
        if (dObs < minDistObs) {
          const push = minDistObs - dObs;
          a.x += (dxObs / dObs) * push;
          a.y += (dyObs / dObs) * push;
        }
      }

      const ix = Math.floor(a.x / cellSize);
      const iy = Math.floor(a.y / cellSize);

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const arr = grid.get(cellKey(ix + ox, iy + oy));
          if (!arr) continue;

          for (const j of arr) {
            if (j <= i) continue;
            const b = nodes[j];

            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            if (d < 1e-6) {
              dx = 1;
              dy = 0;
              d = 1;
            }

            const minDist = a.r + b.r + gap;
            if (d < minDist) {
              const overlap = minDist - d;
              const nx = dx / d;
              const ny = dy / d;

              a.x -= nx * (overlap * 0.5);
              a.y -= ny * (overlap * 0.5);
              b.x += nx * (overlap * 0.5);
              b.y += ny * (overlap * 0.5);
            }
          }
        }
      }
    }
  }

  return nodes;
}