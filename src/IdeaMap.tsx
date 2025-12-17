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

  const likeMapRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    likeMapRef.current = new Map(ideas.map((i) => [i.id, Number(i.likeCount ?? 0)]));
  }, [ideas]);

  const likedSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    likedSetRef.current = new Set(likedIds);
  }, [likedIds]);

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

  const focusRef = useRef<{ active: boolean; tx: number; ty: number }>({ active: false, tx: 0, ty: 0 });
  const clampSoftUntilRef = useRef<number>(0);

  // layout（likeCountでは変えない）
  const layoutKey = useMemo(() => ideas.map((i) => `${i.id}:${i.message}`).join("|"), [ideas]);

  const obstacleR = centerSize * 0.40 + 6;

  const nodes: Node[] = useMemo(() => {
    return layoutIdeas(
      ideas.map((i) => ({ id: i.id, message: i.message, createdAt: i.createdAt, likeCount: i.likeCount })),
      {
        gap: 5,
        density: 0.93,
        iterations: 18,
        centerObstacle: { x: centerWorld.x, y: centerWorld.y, r: obstacleR },
      }
    );
  }, [layoutKey, centerWorld.x, centerWorld.y, obstacleR]);

  const nodesRef = useRef<Node[]>(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // spawn
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
    const cur = m.get(id) ?? { p: 0, target: 0 };
    m.set(id, { p: cur.p, target });
  };

  const likeBusyRef = useRef<Set<string>>(new Set());

  // 描画だけサイズ変化（レイアウトは固定）
  const sizeMulRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastT = performance.now();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const n of list) {
        minX = Math.min(minX, n.x - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y - n.r);
        maxY = Math.max(maxY, n.y + n.r);
      }
      minX = Math.min(minX, centerWorld.x - obstacleR);
      maxX = Math.max(maxX, centerWorld.x + obstacleR);
      minY = Math.min(minY, centerWorld.y - obstacleR);
      maxY = Math.max(maxY, centerWorld.y + obstacleR);
      return { minX, maxX, minY, maxY };
    };

    const softClampCamera = (dt: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cam = camRef.current;

      const halfW = (w / 2) / cam.scale;
      const halfH = (h / 2) / cam.scale;

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

    const hitTest = (sx: number, sy: number) => {
      const { x, y } = screenToWorld(sx, sy);
      const cur = nodesRef.current;
      for (const n of cur) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d <= n.r) return n;
      }
      return null;
    };

    const hitTestLogo = (sx: number, sy: number) => {
      const { x, y } = screenToWorld(sx, sy);
      return Math.hypot(x - centerWorld.x, y - centerWorld.y) <= obstacleR;
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

    // ★ ここが「もっと文字デカく」の本体：padding減 + maxFont増
    const drawTextFront = (sx: number, sy: number, sr: number, msg: string, alpha: number) => {
      const padding = Math.max(8, sr * 0.22);          // ←減らして領域を増やす
      const usableR = Math.max(6, sr - padding);
      if (usableR < 12) return;

      const maxWidth = usableR * 1.78;                 // ←広げる
      const maxHeight = usableR * 1.55;                // ←縦も増やす

      const maxFont = clamp(sr * 0.52, 14, 40);        // ←上限UP（実際は収まる範囲まで）
      const minFont = 11;

      let chosenFont = minFont;
      let chosenLines = [msg];

      for (let font = maxFont; font >= minFont; font -= 1) {
        ctx.font = `${font}px var(--app-font), system-ui, -apple-system, sans-serif`;
        const lines = wrapByChars(msg, maxWidth);
        const lineHeight = font * 1.16;
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

      ctx.font = `${chosenFont}px var(--app-font), system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lh = chosenFont * 1.16;
      const totalH = chosenLines.length * lh;
      let y = sy - totalH / 2 + lh / 2;
      for (const line of chosenLines) {
        ctx.fillText(line, sx, y);
        y += lh;
      }

      ctx.restore();
    };

    const drawBackText = (sx: number, sy: number, sr: number, msg: string, likes: number, liked: boolean, alpha: number) => {
      const padding = Math.max(8, sr * 0.20);
      const usableR = Math.max(6, sr - padding);
      if (usableR < 14) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, usableR, 0, Math.PI * 2);
      ctx.clip();

      const maxWidth = usableR * 1.78;
      const textAreaH = usableR * 1.10;
      const likesAreaH = usableR * 0.55;

      const maxFont = clamp(sr * 0.44, 13, 34);
      const minFont = 11;

      let chosenFont = minFont;
      let lines = [msg];

      for (let font = maxFont; font >= minFont; font -= 1) {
        ctx.font = `${font}px var(--app-font), system-ui, -apple-system, sans-serif`;
        const ls = wrapByChars(msg, maxWidth);
        const lh = font * 1.16;
        if (ls.length * lh <= textAreaH) {
          chosenFont = font;
          lines = ls;
          break;
        }
      }

      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lh = chosenFont * 1.16;
      const totalH = lines.length * lh;
      let y = sy - likesAreaH * 0.62 - totalH / 2 + lh / 2;

      ctx.font = `${chosenFont}px var(--app-font), system-ui, -apple-system, sans-serif`;
      for (const line of lines) {
        ctx.fillText(line, sx, y);
        y += lh;
      }

      const likesFont = clamp(sr * 0.40, 13, 34);
      ctx.font = `${likesFont}px var(--app-font), system-ui, -apple-system, sans-serif`;
      const mark = liked ? "♥" : "♡";
      ctx.fillText(`${mark} ${likes}`, sx, sy + usableR * 0.43);

      ctx.restore();
    };

    const likeSizeTarget = (likes: number, likedByMe: boolean) => {
      const b = clamp(Math.floor(clamp(likes, 0, 1000) / 50), 0, 20);
      const byLikes = 1 + b * 0.022;     // ←少し強め
      const byMe = likedByMe ? 0.05 : 0;
      return clamp(byLikes + byMe, 1, 1.55);
    };

    const draw = (dt: number) => {
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

      // inertia
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

      softClampCamera(dt);

      // clear
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      // bg
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, w, h);

      const { scale } = camRef.current;
      const panSpeedPx = Math.hypot(velRef.current.vx, velRef.current.vy) * scale;

      // ★文字が出る条件をゆるめる（小さめズームでも見えるように）
      const alphaBySpeed = 1 - smoothstep(900, 1400, panSpeedPx);
      const frontAlpha = clamp(smoothstep(0.45, 0.72, scale) * alphaBySpeed, 0, 1);
      const backAlpha  = clamp(smoothstep(0.52, 0.80, scale) * alphaBySpeed, 0, 1);

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
      const left = -margin, top = -margin, right = w + margin, bottom = h + margin;

      const now = performance.now();
      const curNodes = nodesRef.current;

      for (const n of curNodes) {
        const anim = spawnAnimRef.current.get(n.id);
        let wx = n.x, wy = n.y;
        let spawnMul = 1;
        let extraAlpha = 1;

        if (anim) {
          const t = clamp((now - anim.t0) / anim.dur, 0, 1);
          const e = easeOutCubic(t);
          wx = anim.x0 + (n.x - anim.x0) * e;
          wy = anim.y0 + (n.y - anim.y0) * e;
          spawnMul = 0.35 + 0.65 * e;
          extraAlpha = 0.2 + 0.8 * e;
          if (t >= 1) spawnAnimRef.current.delete(n.id);
        }

        const { sx, sy } = worldToScreen(wx, wy);

        const flip = flipRef.current.get(n.id);
        const p = flip?.p ?? 0;
        const cosv = Math.cos(Math.PI * p);
        const squish = Math.max(0.08, Math.abs(cosv));

        const likes = likeMapRef.current.get(n.id) ?? 0;
        const likedByMe = likedSetRef.current.has(n.id);
        const targetMul = likeSizeTarget(likes, likedByMe);

        const curMul = sizeMulRef.current.get(n.id) ?? 1;
        const k = 9;
        const a = 1 - Math.exp(-k * dt);
        const nextMul = curMul + (targetMul - curMul) * a;
        sizeMulRef.current.set(n.id, nextMul);

        const sr = n.r * scale * spawnMul * nextMul;

        if (sx + sr < left || sx - sr > right || sy + sr < top || sy - sr > bottom) continue;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(squish, 1);
        ctx.translate(-sx, -sy);

        const isFront = p < 0.5;

        if (isFront) ctx.fillStyle = `rgba(0,0,0,${1 * extraAlpha})`;
        else ctx.fillStyle = `rgba(255,255,255,${clamp(0.98 * extraAlpha, 0, 1)})`;

        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();

        ctx.lineWidth = 4;
        ctx.strokeStyle = gradStroke(sx, sy, sr);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.stroke();

        if (isFront) {
          if (frontAlpha > 0.08 && sr >= 28) {
            drawTextFront(sx, sy, sr, n.message ?? "", frontAlpha * extraAlpha);
          }
        } else {
          if (backAlpha > 0.08) {
            drawBackText(sx, sy, sr, n.message ?? "", likes, likedByMe, backAlpha * extraAlpha);
          }
        }

        ctx.restore();
      }

      // logo follow
      const logoEl = logoWrapRef.current;
      if (logoEl) {
        const p = worldToScreen(centerWorld.x, centerWorld.y);
        logoEl.style.transform = `translate(${p.sx}px, ${p.sy}px) translate(-50%, -50%) scale(${scale})`;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

      draggingRef.current = true;
      lastMoveRef.current = { t: performance.now(), x: e.clientX, y: e.clientY };
      velRef.current.vx = 0;
      velRef.current.vy = 0;

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
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

      const now = performance.now();

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

    const onPointerUp = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current.active = false;
      if (pointersRef.current.size === 0) {
        draggingRef.current = false;
        lastMoveRef.current = null;
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

    // クリック：未いいね→裏&ON / いいね済→表&OFF
    const onClick = async (e: MouseEvent) => {
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

      const likedNow = likedSetRef.current.has(n.id);
      setFlipTarget(n.id, likedNow ? 0 : 1);

      if (!onToggleLike) return;
      if (likeBusyRef.current.has(n.id)) return;

      likeBusyRef.current.add(n.id);
      try {
        const r = await onToggleLike(n.id);
        setFlipTarget(n.id, r.liked ? 1 : 0);
      } finally {
        likeBusyRef.current.delete(n.id);
      }
    };

    resize();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      draw(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", onClick);
    };
  }, [centerWorld.x, centerWorld.y, obstacleR, onToggleLike, layoutKey]);

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

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}