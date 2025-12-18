// src/IdeaMap.tsx
import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { layoutIdeas, type Idea, type Node } from "./layout";

type IdeaWithLikes = Idea & { likeCount?: number };
type Spawn = { id: string; clientX: number; clientY: number } | null;

type Props = {
  ideas: IdeaWithLikes[];
  likedIds?: string[];
  height?: number | string;
  onToggleLike?: (id: string) => Promise<{ liked: boolean; likeCount: number }>;
  centerOverlay?: ReactNode;
  centerSize?: number;
  centerWorld?: { x: number; y: number };
  spawn?: Spawn;
};

type Camera = { cx: number; cy: number; scale: number };
type PointerState = { id: number; x: number; y: number };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export default function IdeaMap({
  ideas,
  likedIds = [],
  height = "100%",
  onToggleLike,
  centerOverlay,
  centerSize = 160,
  centerWorld = { x: 0, y: 0 },
  spawn = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const logoWrapRef = useRef<HTMLDivElement | null>(null);

  // ===== 変わるものは全部refへ（Canvas初期化を作り直さない） =====
  const onToggleLikeRef = useRef(onToggleLike);
  useEffect(() => {
    onToggleLikeRef.current = onToggleLike;
  }, [onToggleLike]);

  const centerWorldRef = useRef(centerWorld);
  useEffect(() => {
    centerWorldRef.current = centerWorld;
  }, [centerWorld.x, centerWorld.y]);

  const obstacleR = centerSize * 0.40 + 6;
  const obstacleRRef = useRef(obstacleR);
  useEffect(() => {
    obstacleRRef.current = obstacleR;
  }, [obstacleR]);

  // likeCount参照
  const likeMapRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    likeMapRef.current = new Map(ideas.map((i) => [i.id, Number(i.likeCount ?? 0)]));
  }, [ideas]);

  // 自分のいいね（復元）
  const likedSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    likedSetRef.current = new Set(likedIds);
  }, [likedIds]);

  // camera / interaction
  const camRef = useRef<Camera>({ cx: 0, cy: 0, scale: 1 });
  const draggingRef = useRef(false);
  const pointersRef = useRef<Map<number, PointerState>>(new Map());
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    lastMidX: 0,
    lastMidY: 0,
  });

  const lastMoveRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const velRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });

  // ロゴタップの「一回寄せて終わる」
  const focusRef = useRef<{ active: boolean; tx: number; ty: number }>({ active: false, tx: 0, ty: 0 });
  const zoomRef = useRef<{ active: boolean; target: number }>({ active: false, target: 1 });
  const clampSoftUntilRef = useRef<number>(0);

  /**
   * ✅ layout再計算は「id+message」だけ
   * likeCountでレイアウト組み直し→位置が動く＝チラつく、を避ける
   */
  const layoutKey = useMemo(() => ideas.map((i) => `${i.id}:${i.message}`).join("|"), [ideas]);

  const nodes: Node[] = useMemo(() => {
    return layoutIdeas(
      ideas.map((i) => ({ ...i, likeCount: i.likeCount ?? 0 })),
      {
        gap: 8,
        density: 0.86,
        iterations: 32,
        centerObstacle: { x: centerWorld.x, y: centerWorld.y, r: obstacleR },
      }
    );
  }, [layoutKey, centerWorld.x, centerWorld.y, obstacleR]);

  const nodesRef = useRef<Node[]>(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // spawn anim
  const handledSpawnIdRef = useRef<string | null>(null);
  const pendingSpawnRef = useRef<{ id: string; clientX: number; clientY: number } | null>(null);
  const spawnAnimRef = useRef<Map<string, { x0: number; y0: number; t0: number; dur: number }>>(new Map());

  useEffect(() => {
    if (!spawn?.id) return;
    if (handledSpawnIdRef.current === spawn.id) return;
    handledSpawnIdRef.current = spawn.id;
    pendingSpawnRef.current = { id: spawn.id, clientX: spawn.clientX, clientY: spawn.clientY };
  }, [spawn?.id, spawn?.clientX, spawn?.clientY]);

  // flip
  const flipRef = useRef<Map<string, { p: number; target: number }>>(new Map());
  const setFlipTarget = (id: string, target: 0 | 1) => {
    const m = flipRef.current;
    const cur = m.get(id) ?? { p: target, target };
    cur.target = target;
    m.set(id, cur);
  };

  /**
   * ✅ いいね済みなら裏で復元
   */
  const prevLikedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const m = flipRef.current;
    const prev = prevLikedRef.current;
    const next = new Set(likedIds);

    for (const id of next) {
      if (!prev.has(id)) m.set(id, { p: 1, target: 1 });
    }
    for (const id of prev) {
      if (!next.has(id)) m.set(id, { p: 0, target: 0 });
    }

    prevLikedRef.current = next;
  }, [likedIds]);

  // like多重送信防止
  const likeBusyRef = useRef<Set<string>>(new Set());

  /**
   * ✅ 見た目半径アニメ（急変でチラつくのを抑える）
   */
  const radiusAnimRef = useRef<Map<string, { cur: number; target: number }>>(new Map());
  const MAX_VISUAL_MUL = 1.22;

  const computeTargetMul = (id: string) => {
    const likes = likeMapRef.current.get(id) ?? 0;
    const liked = likedSetRef.current.has(id);
    const byLikes = clamp(Math.log2(likes + 1) * 0.05, 0, 0.16);
    const byMe = liked ? 0.06 : 0;
    return clamp(1 + byLikes + byMe, 1, MAX_VISUAL_MUL);
  };

  useEffect(() => {
    const m = radiusAnimRef.current;
    for (const it of ideas) {
      const t = computeTargetMul(it.id);
      const cur = m.get(it.id);
      if (!cur) m.set(it.id, { cur: t, target: t });
      else cur.target = t;
    }
  }, [ideas, likedIds]);

  // ✅ タップ判定（clickを使わない）
  const tapRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startT: number;
    active: boolean;
  } | null>(null);

  /**
   * ✅ 「いいねしました！」の一時表示（裏面のまま文字だけ切り替える）
   *  - until までだけ toast 表示
   *  - 期限切れ後は裏面に「アイデア本文だけ」を表示（いいね数は表示しない）
   */
  const toastRef = useRef<Map<string, { until: number; likes: number; kind: "like" | "unlike" }>>(new Map());
  const TOAST_MS = 2200;

  /**
   * ================================
   * ✅ Canvas 初期化は「1回だけ」
   * ================================
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // ✅ Canvas側フォント（CSS var(--app-font) を実際の文字列に解決して使う）
    const getAppFontFamily = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--app-font").trim();
      return v || 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
    };
    const APP_FONT = getAppFontFamily();

    // 行間：詰め気味
    const LINE = 1.10;

    let raf = 0;
    let lastT = performance.now();

    // ✅ ResizeObserverが連打されるとチラつくことがあるのでrAFで間引き
    let resizeQueued = false;

    const resizeNow = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    };

    const scheduleResize = () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resizeNow();
      });
    };

    const worldToScreen = (x: number, y: number) => {
      const { cx, cy, scale } = camRef.current;
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      return { sx: (x - cx) * scale + w / 2, sy: (y - cy) * scale + h / 2 };
    };

    const screenToWorld = (sx: number, sy: number) => {
      const { cx, cy, scale } = camRef.current;
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      return { x: (sx - w / 2) / scale + cx, y: (sy - h / 2) / scale + cy };
    };

    const zoomAt = (sx: number, sy: number, factor: number) => {
      const cam = camRef.current;
      const before = screenToWorld(sx, sy);
      cam.scale = clamp(cam.scale * factor, 0.25, 3.0);
      const after = screenToWorld(sx, sy);
      cam.cx += before.x - after.x;
      cam.cy += before.y - after.y;
      clampSoftUntilRef.current = performance.now() + 320;
    };

    const getWorldBounds = () => {
      const list = nodesRef.current;
      if (list.length === 0) return { minX: -300, maxX: 300, minY: -300, maxY: 300 };
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

      for (const n of list) {
        minX = Math.min(minX, n.x - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y - n.r);
        maxY = Math.max(maxY, n.y + n.r);
      }

      const cw = centerWorldRef.current;
      const obs = obstacleRRef.current;
      minX = Math.min(minX, cw.x - obs);
      maxX = Math.max(maxX, cw.x + obs);
      minY = Math.min(minY, cw.y - obs);
      maxY = Math.max(maxY, cw.y + obs);

      return { minX, maxX, minY, maxY };
    };

    const softClampCamera = (dt: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cam = camRef.current;

      const halfW = w / 2 / cam.scale;
      const halfH = h / 2 / cam.scale;

      const worldMargin = 1100;
      const b = getWorldBounds();

      const minCx = b.minX - worldMargin + halfW;
      const maxCx = b.maxX + worldMargin - halfW;
      const minCy = b.minY - worldMargin + halfH;
      const maxCy = b.maxY + worldMargin - halfH;

      const loX = Math.min(minCx, maxCx);
      const hiX = Math.max(minCx, maxCx);
      const loY = Math.min(minCy, maxCy);
      const hiY = Math.max(minCy, maxCy);

      const targetCx = clamp(cam.cx, loX, hiX);
      const targetCy = clamp(cam.cy, loY, hiY);

      const now = performance.now();
      const k = now < clampSoftUntilRef.current ? 5 : 12;
      const a = 1 - Math.exp(-k * dt);
      cam.cx += (targetCx - cam.cx) * a;
      cam.cy += (targetCy - cam.cy) * a;
    };

    const gradStroke = (sx: number, sy: number, sr: number) => {
      const g = ctx.createLinearGradient(sx, sy - sr, sx, sy + sr);
      g.addColorStop(0, "#FFC300");
      g.addColorStop(1, "#FF4E00");
      return g;
    };

    const wrapByChars = (text: string, maxWidth: number) => {
      const lines: string[] = [];
      let line = "";
      for (const ch of text) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line.length > 0) {
          lines.push(line);
          line = ch;
        } else line = test;
      }
      if (line) lines.push(line);
      return lines;
    };

    const drawTextFront = (sx: number, sy: number, sr: number, msg: string, alpha: number) => {
      const padding = Math.max(12, sr * 0.30);
      const usableR = Math.max(8, sr - padding);
      if (usableR < 12) return;

      const maxWidth = usableR * 1.62;
      const maxHeight = usableR * 1.42;

      const maxFont = clamp(sr * 0.34, 14, 28);
      const minFont = 10;

      let chosenFont = minFont;
      let chosenLines = [msg];

      for (let font = Math.floor(maxFont); font >= minFont; font -= 1) {
        ctx.font = `700 ${font}px ${APP_FONT}`;
        const lines = wrapByChars(msg, maxWidth);
        const lineHeight = font * LINE;
        if (lines.length * lineHeight <= maxHeight) {
          chosenFont = font;
          chosenLines = lines;
          break;
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, usableR, 0, Math.PI * 2);
      ctx.clip();

      ctx.font = `700 ${chosenFont}px ${APP_FONT}`;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lh = chosenFont * LINE;
      const totalH = chosenLines.length * lh;
      let y = sy - totalH / 2 + lh / 2;
      for (const line of chosenLines) {
        ctx.fillText(line, sx, y);
        y += lh;
      }

      ctx.restore();
    };

    // ✅ 裏面：トースト（数秒だけ）
    const drawBackToast = (sx: number, sy: number, sr: number, likes: number, alpha: number, kind: "like" | "unlike") => {
      const padding = Math.max(12, sr * 0.22);
      const usableR = Math.max(8, sr - padding);
      if (usableR < 14) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, usableR, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const titleFont = clamp(sr * 0.18, 11, 16);
      const countFont = clamp(sr * 0.20, 12, 18);
      const gap = clamp(sr * 0.08, 6, 10);

      const line1 = kind === "like" ? "それな！👍" : "いいねを解除しました";
      const line2 = `合計: ${likes}`;

      const totalH = titleFont * 1.1 + gap + countFont * 1.1;
      let y = sy - totalH / 2 + (titleFont * 1.1) / 2;

      ctx.font = `700 ${titleFont}px ${APP_FONT}`;
      ctx.fillText(line1, sx, y);

      y += titleFont * 1.1 + gap;

      ctx.font = `600 ${countFont}px ${APP_FONT}`;
      ctx.fillText(line2, sx, y);

      ctx.restore();
    };

    // ✅ 裏面：通常表示（アイデア本文だけ。いいね数は出さない）
    const drawBackOnlyMessage = (sx: number, sy: number, sr: number, msg: string, alpha: number) => {
      const padding = Math.max(12, sr * 0.22);
      const usableR = Math.max(8, sr - padding);
      if (usableR < 14) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, usableR, 0, Math.PI * 2);
      ctx.clip();

      const maxWidth = usableR * 1.62;
      const maxHeight = usableR * 1.55;

      const maxFont = clamp(sr * 0.28, 12, 22);
      const minFont = 10;

      let chosenFont = minFont;
      let lines = [msg];

      for (let font = Math.floor(maxFont); font >= minFont; font -= 1) {
        ctx.font = `700 ${font}px ${APP_FONT}`;
        const ls = wrapByChars(msg, maxWidth);
        const lh = font * LINE;
        if (ls.length * lh <= maxHeight) {
          chosenFont = font;
          lines = ls;
          break;
        }
      }

      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lh = chosenFont * LINE;
      const totalH = lines.length * lh;

      let y = sy - totalH / 2 + lh / 2;
      ctx.font = `700 ${chosenFont}px ${APP_FONT}`;
      for (const line of lines) {
        ctx.fillText(line, sx, y);
        y += lh;
      }

      ctx.restore();
    };

    const visualMulNow = (id: string) => radiusAnimRef.current.get(id)?.cur ?? 1;

    const hitTest = (sx: number, sy: number) => {
      const { x, y } = screenToWorld(sx, sy);
      for (const n of nodesRef.current) {
        const rr = n.r * visualMulNow(n.id);
        if (Math.hypot(n.x - x, n.y - y) <= rr) return n;
      }
      return null;
    };

    const hitTestLogo = (sx: number, sy: number) => {
      const { x, y } = screenToWorld(sx, sy);
      const cw = centerWorldRef.current;
      return Math.hypot(x - cw.x, y - cw.y) <= obstacleRRef.current;
    };

    const draw = (dt: number) => {
      // 半径アニメ更新
      {
        const k = 12;
        const a = 1 - Math.exp(-k * dt);
        for (const [, st] of radiusAnimRef.current.entries()) {
          st.cur += (st.target - st.cur) * a;
          if (Math.abs(st.cur - st.target) < 0.001) st.cur = st.target;
        }
      }

      // spawn start
      if (pendingSpawnRef.current) {
        const p = pendingSpawnRef.current;
        pendingSpawnRef.current = null;

        const rect = canvas.getBoundingClientRect();
        const sx = p.clientX - rect.left;
        const sy = p.clientY - rect.top;
        const w0 = screenToWorld(sx, sy);

        spawnAnimRef.current.set(p.id, { x0: w0.x, y0: w0.y, t0: performance.now(), dur: 520 });
      }

      // inertia pan
      if (!draggingRef.current) {
        const v = velRef.current;
        const friction = 8;
        const decay = Math.exp(-friction * dt);
        v.vx *= decay;
        v.vy *= decay;
        camRef.current.cx += v.vx * dt;
        camRef.current.cy += v.vy * dt;
      }

      // focus
      if (focusRef.current.active && !draggingRef.current) {
        const cam = camRef.current;
        const k = 10;
        const a = 1 - Math.exp(-k * dt);

        const dx = focusRef.current.tx - cam.cx;
        const dy = focusRef.current.ty - cam.cy;
        cam.cx += dx * a;
        cam.cy += dy * a;

        if (Math.hypot(dx, dy) < 4) focusRef.current.active = false;
      }

      // zoom reset
      if (zoomRef.current.active && !draggingRef.current) {
        const cam = camRef.current;
        const target = zoomRef.current.target;
        const k = 10;
        const a = 1 - Math.exp(-k * dt);
        cam.scale += (target - cam.scale) * a;
        if (Math.abs(cam.scale - target) < 0.002) {
          cam.scale = target;
          zoomRef.current.active = false;
        }
      }

      softClampCamera(dt);

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, w, h);

      const { scale } = camRef.current;
      const panSpeedPx = Math.hypot(velRef.current.vx, velRef.current.vy) * scale;

      const alphaBySpeed = 1 - smoothstep(900, 1400, panSpeedPx);
      const frontAlpha = clamp(smoothstep(0.72, 0.95, scale) * alphaBySpeed, 0, 1);
      const backAlpha = clamp(smoothstep(0.82, 1.02, scale) * alphaBySpeed, 0, 1);

      // flip update
      {
        const k = 18;
        const a = 1 - Math.exp(-k * dt);
        for (const [, st] of flipRef.current.entries()) {
          st.p += (st.target - st.p) * a;
          if (Math.abs(st.p - st.target) < 0.001) st.p = st.target;
        }
      }

      const margin = 220;
      const left = -margin,
        top = -margin,
        right = w + margin,
        bottom = h + margin;

      const now = performance.now();

      for (const n of nodesRef.current) {
        const anim = spawnAnimRef.current.get(n.id);
        let wx = n.x,
          wy = n.y;
        let sizeMul = 1;
        let extraAlpha = 1;

        if (anim) {
          const t = clamp((now - anim.t0) / anim.dur, 0, 1);
          const e = easeOutCubic(t);
          wx = anim.x0 + (n.x - anim.x0) * e;
          wy = anim.y0 + (n.y - anim.y0) * e;
          sizeMul = 0.35 + 0.65 * e;
          extraAlpha = 0.2 + 0.8 * e;
          if (t >= 1) spawnAnimRef.current.delete(n.id);
        }

        const { sx, sy } = worldToScreen(wx, wy);

        const flip = flipRef.current.get(n.id);
        const p = flip?.p ?? 0;
        const cosv = Math.cos(Math.PI * p);
        const squish = Math.max(0.08, Math.abs(cosv));

        const vr = visualMulNow(n.id);
        const sr = n.r * vr * scale * sizeMul;

        if (sx + sr < left || sx - sr > right || sy + sr < top || sy - sr > bottom) continue;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(squish, 1);
        ctx.translate(-sx, -sy);

        const isFront = p < 0.5;

        ctx.fillStyle = isFront
          ? `rgba(0,0,0,${1 * extraAlpha})`
          : `rgba(255,255,255,${clamp(0.98 * extraAlpha, 0, 1)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();

        ctx.lineWidth = 4;
        ctx.strokeStyle = gradStroke(sx, sy, sr);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.stroke();

        if (isFront) {
          if (frontAlpha > 0.10 && sr >= 34) {
            drawTextFront(sx, sy, sr, n.message ?? "", frontAlpha * extraAlpha);
          }
        } else {
          if (backAlpha > 0.10) {
            const toast = toastRef.current.get(n.id);
            if (toast && now < toast.until) {
              // トースト中だけ いいね数を出す
              drawBackToast(sx, sy, sr, toast.likes, backAlpha * extraAlpha, toast.kind);
            } else {
              // トースト終了後：いいね数は表示しない（本文だけ）
              if (toast) toastRef.current.delete(n.id);
              drawBackOnlyMessage(sx, sy, sr, n.message ?? "", backAlpha * extraAlpha);
            }
          }
        }

        ctx.restore();
      }

      // ロゴ追従
      const logoEl = logoWrapRef.current;
      if (logoEl) {
        const cw = centerWorldRef.current;
        const p = worldToScreen(cw.x, cw.y);
        logoEl.style.transform = `translate(${p.sx}px, ${p.sy}px) translate(-50%, -50%) scale(${scale})`;
      }
    };

    // ===== events =====
    const onPointerDown = (e: PointerEvent) => {
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

      draggingRef.current = true;
      lastMoveRef.current = { t: performance.now(), x: e.clientX, y: e.clientY };
      velRef.current.vx = 0;
      velRef.current.vy = 0;

      tapRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startT: performance.now(),
        active: true,
      };

      focusRef.current.active = false;

      if (pointersRef.current.size === 2) {
        const pts = Array.from(pointersRef.current.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        pinchRef.current = {
          active: true,
          startDist: dist,
          startScale: camRef.current.scale,
          lastMidX: midX,
          lastMidY: midY,
        };
        clampSoftUntilRef.current = performance.now() + 360;

        if (tapRef.current) tapRef.current.active = false;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

      const now = performance.now();

      if (tapRef.current?.active && tapRef.current.pointerId === e.pointerId) {
        const dx = e.clientX - tapRef.current.startX;
        const dy = e.clientY - tapRef.current.startY;
        if (Math.hypypot?.(dx, dy) ? Math.hypypot(dx, dy) > 8 : Math.hypot(dx, dy) > 8) {
          tapRef.current.active = false;
        }
      }

      if (pinchRef.current.active && pointersRef.current.size === 2) {
        const pts = Array.from(pointersRef.current.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        const p = pinchRef.current;
        const factor = dist / Math.max(1, p.startDist);

        camRef.current.scale = clamp(p.startScale * factor, 0.25, 3.0);

        const dmx = midX - p.lastMidX;
        const dmy = midY - p.lastMidY;
        camRef.current.cx -= dmx / camRef.current.scale;
        camRef.current.cy -= dmy / camRef.current.scale;

        p.lastMidX = midX;
        p.lastMidY = midY;

        clampSoftUntilRef.current = performance.now() + 260;
        return;
      }

      const last = lastMoveRef.current;
      if (!last) return;

      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      const dtt = Math.max(0.001, (now - last.t) / 1000);

      camRef.current.cx -= dx / camRef.current.scale;
      camRef.current.cy -= dy / camRef.current.scale;

      velRef.current.vx = (-dx / camRef.current.scale) / dtt;
      velRef.current.vy = (-dy / camRef.current.scale) / dtt;

      lastMoveRef.current = { t: now, x: e.clientX, y: e.clientY };
    };

    const onPointerUp = async (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current.active = false;

      if (pointersRef.current.size === 0) {
        draggingRef.current = false;
        lastMoveRef.current = null;
      }

      const tap = tapRef.current;
      if (tap?.active && tap.pointerId === e.pointerId) {
        const elapsed = performance.now() - tap.startT;
        tapRef.current = null;

        if (elapsed > 450) return;

        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (hitTestLogo(sx, sy)) {
          focusRef.current = { active: true, tx: 0, ty: 0 };
          velRef.current.vx = 0;
          velRef.current.vy = 0;
          clampSoftUntilRef.current = performance.now() + 260;
          return;
        }

        const n = hitTest(sx, sy);
        if (!n) return;

        const alreadyLiked = likedSetRef.current.has(n.id);

        // 先に見た目だけ反映（裏面にする/戻す）
        setFlipTarget(n.id, alreadyLiked ? 0 : 1);

        const fn = onToggleLikeRef.current;
        if (!fn) return;
        if (likeBusyRef.current.has(n.id)) return;

        likeBusyRef.current.add(n.id);
        try {
          const r = await fn(n.id);

          // サーバ結果で最終確定
          setFlipTarget(n.id, r.liked ? 1 : 0);

          // ✅ 裏面のまま：トーストを数秒だけ出す
          const now = performance.now();
          toastRef.current.set(n.id, {
            until: now + TOAST_MS,
            likes: r.likeCount,
            kind: r.liked ? "like" : "unlike",
          });
        } finally {
          likeBusyRef.current.delete(n.id);
        }
      } else {
        if (tapRef.current?.pointerId === e.pointerId) tapRef.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      zoomAt(sx, sy, factor);
    };

    // init
    resizeNow();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      draw(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(scheduleResize);
    ro.observe(canvas);
    window.addEventListener("resize", scheduleResize);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // ✅ clickは殺す（iOS二重発火の根）
    const preventClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    canvas.addEventListener("click", preventClick, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", scheduleResize);

      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", preventClick);
    };
  }, []); // ★Canvasは作り直さない（チラつき根絶）

  return (
    <div style={{ width: "100%", height, position: "relative", overflow: "hidden" }}>
      <div
        ref={logoWrapRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          pointerEvents: "none",
          willChange: "transform",
          userSelect: "none",
        }}
      >
        <div
          style={{
            width: centerSize,
            height: centerSize,
            animation: "floaty 4.8s ease-in-out infinite",
            filter: "drop-shadow(0 12px 22px rgba(0,0,0,0.18))",
          }}
        >
          {centerOverlay}
        </div>
      </div>

      <style>
        {`
          @keyframes floaty {
            0% { transform: translateY(0px); }
            50% { transform: translateY(-8px); }
            100% { transform: translateY(0px); }
          }
        `}
      </style>

      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          touchAction: "none",
          background: "#1a1a1a",
        }}
      />
    </div>
  );
}