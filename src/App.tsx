// src/App.tsx
import "./App.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import IdeaMap from "./IdeaMap";
import {
  auth,
  fetchVoteCount,
  fetchVotes,
  submitVote,
  likeVote,
  fetchMyLikes,
  fetchStats,
} from "./firebase";

type Vote = {
  id: string;
  message?: string;
  createdAt?: any;
  pending?: boolean;
  likeCount?: number;
};

type Spawn = { id: string; clientX: number; clientY: number };
type Status = { kind: "idle" | "info" | "ok" | "error"; text: string };

const RULES = [
  "あなたの鳩祭への思いやアイデアをおしえてください！",
  "アイデアは被るものです。既出でも大丈夫なのであなたのアイデアをおしえてください！",
  "どんなアイデアも、声を上げないと始まらないです！とにかく送ってみてください！",
  "文字数制限があるので、短く簡潔に。論点が複数あるなら分けて送ってね！",
  "誰かが嫌な気持ちになることは送らないで！",
  "同じ内容の連投はやめてね！",
  "手作りのサービスです。バグも多いので、バグったらリロードしてね！",
];

function App() {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [votes, setVotes] = useState<Vote[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [stats, setStats] = useState<{ voteCount: number; totalLikes: number; score: number } | null>(null);

  const [rulesOpen, setRulesOpen] = useState(false);

  // ✅ ロゴサイズ：スマホ(<=640)は画面幅70% / iPadはほどよく大きめ
  const [centerSize, setCenterSize] = useState<number>(() => {
    const w = window.innerWidth;
    if (w <= 640) return Math.round(w * 0.70);
    if (w <= 1024) return Math.round(w * 0.42);
    return 180;
  });

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      if (w <= 640) setCenterSize(Math.round(w * 0.70));
      else if (w <= 1024) setCenterSize(Math.round(w * 0.42));
      else setCenterSize(180);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 送信スポーン
  const [spawn, setSpawn] = useState<Spawn | null>(null);
  const sendBtnRef = useRef<HTMLButtonElement | null>(null);

  // ★ refでliked状態を保持（useCallbackを安定させる）
  const likedIdsRef = useRef<string[]>([]);
  useEffect(() => {
    likedIdsRef.current = likedIds;
  }, [likedIds]);

  const loadAll = useCallback(async () => {
    const [list, count, myLikes, st] = await Promise.all([
      fetchVotes(),
      fetchVoteCount().catch(() => null),
      fetchMyLikes().catch(() => []),
      fetchStats().catch(() => null),
    ]);

    setVotes(list);
    setTotalCount(count ?? list.length);
    setLikedIds(myLikes);
    likedIdsRef.current = myLikes; // ★即時同期
    setStats(st);
  }, []);

  useEffect(() => {
    if (!auth.currentUser) signInAnonymously(auth).catch(console.error);

    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) return;
      loadAll().catch((e) => {
        console.error(e);
        setStatus({ kind: "error", text: "読み込みエラー" });
      });
    });

    return () => unsub();
  }, [loadAll]);

  const scoreView = useMemo(() => {
    if (stats) {
      return { voteCount: stats.voteCount, totalLikes: stats.totalLikes, score: stats.score };
    }
    const voteCount = totalCount ?? votes.length;
    const totalLikes = votes.reduce((s, v) => s + Number(v.likeCount ?? 0), 0);
    const score = voteCount * 10 + totalLikes;
    return { voteCount, totalLikes, score };
  }, [stats, totalCount, votes]);

  // ✅ 重要：この関数を安定化 → IdeaMapのCanvasループが毎回作り直されなくなる（チカチカ激減）
  const handleToggleLike = useCallback(async (id: string) => {
    if (id.startsWith("temp-")) return { liked: false, likeCount: 0 };

    const currentlyLiked = likedIdsRef.current.includes(id);
    const delta = currentlyLiked ? -1 : 1;

    // optimistic（即UI反映）
    setLikedIds((prev) => {
      const has = prev.includes(id);
      const next = has ? prev.filter((x) => x !== id) : [...prev, id];
      likedIdsRef.current = next; // ★即時同期
      return next;
    });

    setVotes((prev) =>
      prev.map((v) =>
        v.id === id ? { ...v, likeCount: Math.max(0, Number(v.likeCount ?? 0) + delta) } : v
      )
    );

    setStats((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        totalLikes: Math.max(0, prev.totalLikes + delta),
        score: prev.score + delta,
      };
    });

    try {
      const r = await likeVote(id); // server is truth

      setVotes((prev) => prev.map((v) => (v.id === id ? { ...v, likeCount: r.likeCount } : v)));

      setLikedIds((prev) => {
        const has = prev.includes(id);
        let next = prev;
        if (r.liked && !has) next = [...prev, id];
        if (!r.liked && has) next = prev.filter((x) => x !== id);
        likedIdsRef.current = next; // ★即時同期
        return next;
      });

      // statsは取り直し（確実）
      fetchStats().then(setStats).catch(() => {});
      return { liked: r.liked, likeCount: r.likeCount };
    } catch (e) {
      setStatus({ kind: "error", text: "いいね失敗（通信/サーバー）" });
      loadAll().catch(() => {});
      return { liked: currentlyLiked, likeCount: 0 };
    }
  }, [loadAll]);

  const handleSubmit = async () => {
    const trimmed = message.trim();

    if (trimmed.length === 0) {
      setStatus({ kind: "error", text: "空文字では送れません！" });
      return;
    }
    if (trimmed.length > 20) {
      setStatus({ kind: "error", text: "20文字以内で入力してください" });
      return;
    }

    const tempId = `temp-${Date.now()}`;

    const r = sendBtnRef.current?.getBoundingClientRect();
    const clientX = r ? r.left + r.width / 2 : window.innerWidth / 2;
    const clientY = r ? r.top + r.height / 2 : window.innerHeight - 40;
    setSpawn({ id: tempId, clientX, clientY });

    setVotes((prev) => [{ id: tempId, message: trimmed, pending: true, likeCount: 0 }, ...prev]);
    setTotalCount((c) => (c === null ? c : c + 1));

    setStatus({ kind: "info", text: "送信中..." });

    try {
      await submitVote(trimmed);
      setMessage("");
      setStatus({ kind: "ok", text: "送信完了！" });
      await loadAll();
    } catch (e: any) {
      console.error(e);
      setVotes((prev) => prev.filter((v) => v.id !== tempId));
      setTotalCount((c) => (c === null ? c : c - 1));
      setStatus({ kind: "error", text: e?.message ? String(e.message) : "送信エラー" });
    }
  };

  return (
    <div className="app">
      <div className="stage">
        {/* HUD（カウンター＆ルール） */}
        <div className="hud">
          <div className="hudBox hudScore">
            <div className="hudTitle">SCORE</div>

            <div className="hudBig">
              <span className="hudBigNum">{scoreView.score}</span>
              <span className="hudBigSlash">/</span>
              <span className="hudBigGoal">10000</span>
            </div>

            <div className="hudSub">
              <span>投稿数 {scoreView.voteCount}（×10）</span>
              <span className="hudDot">•</span>
              <span>いいね数 {scoreView.totalLikes}（×1）</span>
            </div>
          </div>

          <div className="hudBox hudRules">
            <button className="rulesToggle" onClick={() => setRulesOpen((v) => !v)}>
              <span className="hudTitle">RULES</span>
              <span className="rulesToggleMark">{rulesOpen ? "▲" : "▼"}</span>
            </button>

            {rulesOpen && (
              <ol className="rulesList">
                {RULES.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <IdeaMap
          height="100%"
          ideas={votes
            .filter((v) => (v.message ?? "").length > 0)
            .map((v) => ({
              id: v.id,
              message: v.message ?? "",
              createdAt: v.createdAt,
              likeCount: v.likeCount ?? 0,
            }))}
          likedIds={likedIds}
          centerSize={centerSize}
          onToggleLike={handleToggleLike}
          spawn={spawn}
          centerOverlay={
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="logo"
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
          }
        />

        {/* 送信フォーム */}
        <div className="floatingForm">
          <div className="row">
            <input
              className="input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="20文字以内で入力"
              maxLength={20}
            />
            <button className="button" onClick={handleSubmit} ref={sendBtnRef}>
              送信
            </button>
          </div>

          {status.text && <div className={`statusLine ${status.kind}`}>{status.text}</div>}
        </div>
      </div>
    </div>
  );
}

export default App;